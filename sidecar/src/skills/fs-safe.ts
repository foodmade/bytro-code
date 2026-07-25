import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

export const MAX_PRIVATE_TEXT_BYTES = 1024 * 1024;

function isSameFile(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function isBoundedSingleLinkFile(metadata: fs.BigIntStats, maxBytes: number): boolean {
  return (
    !metadata.isSymbolicLink() &&
    metadata.isFile() &&
    metadata.nlink === 1n &&
    metadata.size <= BigInt(maxBytes)
  );
}

function lstatIfPresent(target: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function requireRealDirectory(target: string, label: string): void {
  const metadata = lstatIfPresent(target);
  if (!metadata || metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`${label} must be a real directory: ${target}`);
  }
}

/** Create or secure a Bytro-owned directory without traversing a final symlink. */
export function ensurePrivateDirectory(target: string): void {
  const metadata = lstatIfPresent(target);
  if (metadata) {
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error(`Refusing non-directory Bytro path: ${target}`);
    }
  } else {
    fs.mkdirSync(target, { recursive: false, mode: 0o700 });
  }
  if (process.platform !== "win32") {
    fs.chmodSync(target, 0o700);
  }
}

/**
 * Require every existing component from `root` through `target` to be a real
 * directory. This prevents a nested source path from escaping through a
 * symlink or Windows junction.
 */
export function requireRealDirectoryTree(root: string, target: string): void {
  const relative = path.relative(root, target);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Directory is outside the allowed root: ${target}`);
  }

  requireRealDirectory(root, "Source root");
  let current = root;
  if (!relative) return;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    requireRealDirectory(current, "Source directory");
  }
}

/** Read one bounded regular file from a Bytro-owned tree without following links. */
export function readPrivateTextFile(
  root: string,
  target: string,
  maxBytes = MAX_PRIVATE_TEXT_BYTES,
): string | null {
  let fd: number | undefined;
  try {
    requireRealDirectoryTree(root, path.dirname(target));
    const before = fs.lstatSync(target, { bigint: true });
    if (!isBoundedSingleLinkFile(before, maxBytes)) {
      return null;
    }

    const noFollow = fs.constants.O_NOFOLLOW ?? 0;
    const nonBlock = fs.constants.O_NONBLOCK ?? 0;
    fd = fs.openSync(target, fs.constants.O_RDONLY | noFollow | nonBlock);
    const opened = fs.fstatSync(fd, { bigint: true });
    if (!isBoundedSingleLinkFile(opened, maxBytes) || !isSameFile(before, opened)) return null;

    requireRealDirectoryTree(root, path.dirname(target));
    const after = fs.lstatSync(target, { bigint: true });
    if (!isBoundedSingleLinkFile(after, maxBytes) || !isSameFile(opened, after)) return null;

    const chunks: Buffer[] = [];
    let total = 0;
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1));
    for (;;) {
      const read = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (read === 0) break;
      total += read;
      if (total > maxBytes) return null;
      chunks.push(Buffer.from(buffer.subarray(0, read)));
    }
    requireRealDirectoryTree(root, path.dirname(target));
    const finalPath = fs.lstatSync(target, { bigint: true });
    const finalHandle = fs.fstatSync(fd, { bigint: true });
    if (
      !isBoundedSingleLinkFile(finalPath, maxBytes) ||
      !isBoundedSingleLinkFile(finalHandle, maxBytes) ||
      !isSameFile(opened, finalPath) ||
      !isSameFile(opened, finalHandle)
    ) {
      return null;
    }
    return Buffer.concat(chunks, total).toString("utf8");
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** Atomically replace one private regular file without using a predictable temp path. */
export function writePrivateTextFileAtomic(root: string, target: string, content: string): void {
  const parent = path.dirname(target);
  requireRealDirectoryTree(root, parent);

  const existing = lstatIfPresent(target);
  if (existing && (existing.isSymbolicLink() || !existing.isFile())) {
    throw new Error(`Refusing non-regular Bytro file: ${target}`);
  }

  const temp = path.join(parent, `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`);
  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  let fd: number | undefined;
  try {
    fd = fs.openSync(
      temp,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow,
      0o600,
    );
    const bytes = Buffer.from(content, "utf8");
    let written = 0;
    while (written < bytes.length) {
      written += fs.writeSync(fd, bytes, written, bytes.length - written);
    }
    fs.fsyncSync(fd);
    if (process.platform !== "win32") {
      fs.fchmodSync(fd, 0o600);
    }
    fs.closeSync(fd);
    fd = undefined;

    requireRealDirectoryTree(root, parent);
    const destination = lstatIfPresent(target);
    if (destination && (destination.isSymbolicLink() || !destination.isFile())) {
      throw new Error(`Refusing non-regular Bytro file: ${target}`);
    }

    try {
      fs.renameSync(temp, target);
    } catch (error) {
      // Windows cannot atomically replace an existing file. Unlinking a
      // verified regular destination never follows it, then the exclusive
      // temp file is renamed into place.
      if (process.platform !== "win32" || !destination) throw error;
      const current = fs.lstatSync(target);
      if (current.isSymbolicLink() || !current.isFile()) {
        throw new Error(`Refusing changed Bytro file: ${target}`);
      }
      fs.unlinkSync(target);
      fs.renameSync(temp, target);
    }
    if (process.platform !== "win32") {
      fs.chmodSync(target, 0o600);
    }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try {
      fs.unlinkSync(temp);
    } catch {
      // Renamed successfully or nothing was created.
    }
  }
}

function createPrivateDirectory(target: string): void {
  const metadata = lstatIfPresent(target);
  if (metadata) {
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error(`Refusing non-directory copy target: ${target}`);
    }
  } else {
    fs.mkdirSync(target, { mode: 0o700 });
  }
  if (process.platform !== "win32") {
    fs.chmodSync(target, 0o700);
  }
}

function copyRegularFileWithoutLinks(source: string, destination: string): void {
  const sourceMetadata = fs.lstatSync(source, { bigint: true });
  if (!isBoundedSingleLinkFile(sourceMetadata, Number.MAX_SAFE_INTEGER)) return;

  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  const nonBlock = fs.constants.O_NONBLOCK ?? 0;
  let sourceFd: number | undefined;
  let destinationFd: number | undefined;
  try {
    sourceFd = fs.openSync(source, fs.constants.O_RDONLY | noFollow | nonBlock);
    const openedSource = fs.fstatSync(sourceFd, { bigint: true });
    const currentSource = fs.lstatSync(source, { bigint: true });
    if (
      !isBoundedSingleLinkFile(openedSource, Number.MAX_SAFE_INTEGER) ||
      !isBoundedSingleLinkFile(currentSource, Number.MAX_SAFE_INTEGER) ||
      !isSameFile(sourceMetadata, openedSource) ||
      !isSameFile(openedSource, currentSource)
    ) {
      return;
    }

    destinationFd = fs.openSync(
      destination,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow,
      0o600,
    );

    const buffer = Buffer.allocUnsafe(64 * 1024);
    for (;;) {
      const read = fs.readSync(sourceFd, buffer, 0, buffer.length, null);
      if (read === 0) break;
      let written = 0;
      while (written < read) {
        written += fs.writeSync(destinationFd, buffer, written, read - written);
      }
    }
    if (process.platform !== "win32") {
      fs.fchmodSync(destinationFd, 0o600);
    }
  } catch (error) {
    try {
      fs.unlinkSync(destination);
    } catch {
      // Nothing to clean up.
    }
    throw error;
  } finally {
    if (destinationFd !== undefined) fs.closeSync(destinationFd);
    if (sourceFd !== undefined) fs.closeSync(sourceFd);
  }
}

/**
 * Copy only real directories and regular files. Symlinks, junctions, sockets,
 * FIFOs, and devices are skipped instead of being followed or recreated.
 */
export function copyDirectoryWithoutLinks(source: string, destination: string): void {
  requireRealDirectory(source, "Copy source");
  createPrivateDirectory(destination);

  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const sourceEntry = path.join(source, entry.name);
    const destinationEntry = path.join(destination, entry.name);
    const metadata = fs.lstatSync(sourceEntry);

    if (metadata.isSymbolicLink()) continue;
    if (metadata.isDirectory()) {
      copyDirectoryWithoutLinks(sourceEntry, destinationEntry);
    } else if (metadata.isFile()) {
      copyRegularFileWithoutLinks(sourceEntry, destinationEntry);
    }
  }
}
