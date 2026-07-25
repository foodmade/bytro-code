import * as fs from "node:fs";
import * as path from "node:path";
import { requireRealDirectoryTree } from "./skills/fs-safe.js";

export const MAX_PROVIDER_IMPORT_BYTES = 1024 * 1024;
export const MAX_PROVIDER_DIRECTORY_ENTRIES = 4096;

interface OpenedProviderFile {
  readonly fd: number;
  readonly metadata: fs.Stats;
  readonly validate: () => boolean;
  readonly close: () => void;
}

interface FileIdentity {
  readonly device: bigint;
  readonly inode: bigint;
}

function identityOf(metadata: fs.BigIntStats): FileIdentity {
  return { device: metadata.dev, inode: metadata.ino };
}

function isSameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.device === right.device && left.inode === right.inode;
}

function isRealDirectory(metadata: fs.BigIntStats): boolean {
  return !metadata.isSymbolicLink() && metadata.isDirectory();
}

function isBoundedSingleLinkFile(metadata: fs.BigIntStats, maxBytes: number): boolean {
  return (
    !metadata.isSymbolicLink() &&
    metadata.isFile() &&
    metadata.nlink === 1n &&
    metadata.size <= BigInt(maxBytes)
  );
}

class ProviderDirectoryGuard {
  private constructor(
    private readonly directories: ReadonlyArray<{
      readonly path: string;
      readonly identity: FileIdentity;
      readonly fd?: number;
    }>,
  ) {}

  static open(providerRoot: string, directory: string): ProviderDirectoryGuard {
    requireRealDirectoryTree(providerRoot, directory);
    const relative = path.relative(providerRoot, directory);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error("Provider directory is outside its root");
    }

    const componentPaths = [providerRoot];
    let current = providerRoot;
    if (relative) {
      for (const segment of relative.split(path.sep)) {
        if (!segment || segment === "." || segment === "..") {
          throw new Error("Provider directory contains an unsafe component");
        }
        current = path.join(current, segment);
        componentPaths.push(current);
      }
    }

    const held: Array<{ path: string; identity: FileIdentity; fd?: number }> = [];
    try {
      for (const componentPath of componentPaths) {
        const before = fs.lstatSync(componentPath, { bigint: true });
        if (!isRealDirectory(before)) throw new Error("Provider path is not a real directory");

        if (process.platform === "win32") {
          held.push({ path: componentPath, identity: identityOf(before) });
          continue;
        }

        const directoryOnly = fs.constants.O_DIRECTORY ?? 0;
        const noFollow = fs.constants.O_NOFOLLOW ?? 0;
        const nonBlock = fs.constants.O_NONBLOCK ?? 0;
        const fd = fs.openSync(
          componentPath,
          fs.constants.O_RDONLY | directoryOnly | noFollow | nonBlock,
        );
        const opened = fs.fstatSync(fd, { bigint: true });
        const after = fs.lstatSync(componentPath, { bigint: true });
        if (
          !isRealDirectory(opened) ||
          !isRealDirectory(after) ||
          !isSameIdentity(identityOf(before), identityOf(opened)) ||
          !isSameIdentity(identityOf(opened), identityOf(after))
        ) {
          fs.closeSync(fd);
          throw new Error("Provider directory changed while opening");
        }
        held.push({ path: componentPath, identity: identityOf(opened), fd });
      }
      const guard = new ProviderDirectoryGuard(held);
      guard.revalidate();
      return guard;
    } catch (error) {
      for (const entry of held) {
        if (entry.fd !== undefined) fs.closeSync(entry.fd);
      }
      throw error;
    }
  }

  revalidate(): void {
    for (const directory of this.directories) {
      const current = fs.lstatSync(directory.path, { bigint: true });
      if (
        !isRealDirectory(current) ||
        !isSameIdentity(identityOf(current), directory.identity)
      ) {
        throw new Error("Provider directory identity changed during read");
      }
      if (directory.fd !== undefined) {
        const held = fs.fstatSync(directory.fd, { bigint: true });
        if (
          !isRealDirectory(held) ||
          !isSameIdentity(identityOf(held), directory.identity)
        ) {
          throw new Error("Held provider directory changed during read");
        }
      }
    }
  }

  close(): void {
    for (const directory of this.directories) {
      if (directory.fd !== undefined) fs.closeSync(directory.fd);
    }
  }
}

function openProviderRegularFile(
  providerRoot: string,
  filePath: string,
  maxBytes: number,
): OpenedProviderFile | null {
  let guard: ProviderDirectoryGuard | undefined;
  let fd: number | undefined;
  try {
    guard = ProviderDirectoryGuard.open(providerRoot, path.dirname(filePath));
    const beforeOpen = fs.lstatSync(filePath, { bigint: true });
    if (!isBoundedSingleLinkFile(beforeOpen, maxBytes)) {
      return null;
    }

    const noFollow = fs.constants.O_NOFOLLOW ?? 0;
    const nonBlock = fs.constants.O_NONBLOCK ?? 0;
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow | nonBlock);
    const opened = fs.fstatSync(fd, { bigint: true });
    const afterOpen = fs.lstatSync(filePath, { bigint: true });
    const openedIdentity = identityOf(opened);
    if (
      !isBoundedSingleLinkFile(opened, maxBytes) ||
      !isBoundedSingleLinkFile(afterOpen, maxBytes) ||
      !isSameIdentity(identityOf(beforeOpen), openedIdentity) ||
      !isSameIdentity(openedIdentity, identityOf(afterOpen))
    ) {
      return null;
    }

    guard.revalidate();
    const metadata = fs.fstatSync(fd);
    const validate = (): boolean => {
      try {
        guard?.revalidate();
        const current = fs.lstatSync(filePath, { bigint: true });
        if (
          !isBoundedSingleLinkFile(current, maxBytes) ||
          !isSameIdentity(identityOf(current), openedIdentity)
        ) {
          return false;
        }

        const probeFd = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow | nonBlock);
        try {
          const probe = fs.fstatSync(probeFd, { bigint: true });
          return (
            isBoundedSingleLinkFile(probe, maxBytes) &&
            isSameIdentity(identityOf(probe), openedIdentity)
          );
        } finally {
          fs.closeSync(probeFd);
        }
      } catch {
        return false;
      }
    };
    const openedFd = fd;
    const openedGuard = guard;
    fd = undefined;
    guard = undefined;
    return {
      fd: openedFd,
      metadata,
      validate,
      close: () => {
        fs.closeSync(openedFd);
        openedGuard.close();
      },
    };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    guard?.close();
  }
}

export interface ProviderTextSnapshot {
  readonly content: string;
  readonly mtimeMs: number;
}

/** Securely import one bounded, regular text file from a provider-owned root. */
export function readProviderTextFile(
  providerRoot: string,
  filePath: string,
  maxBytes = MAX_PROVIDER_IMPORT_BYTES,
): ProviderTextSnapshot | null {
  const opened = openProviderRegularFile(providerRoot, filePath, maxBytes);
  if (!opened) return null;

  try {
    const chunks: Buffer[] = [];
    let total = 0;
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1));
    for (;;) {
      const read = fs.readSync(opened.fd, buffer, 0, buffer.length, null);
      if (read === 0) break;
      total += read;
      if (total > maxBytes) return null;
      chunks.push(Buffer.from(buffer.subarray(0, read)));
    }
    if (!opened.validate()) return null;
    return {
      content: Buffer.concat(chunks, total).toString("utf8"),
      mtimeMs: opened.metadata.mtimeMs,
    };
  } catch {
    return null;
  } finally {
    opened.close();
  }
}

/** Return a safe mtime only for bounded regular provider files. */
export function getProviderRegularFileMtime(
  providerRoot: string,
  filePath: string,
  maxBytes = MAX_PROVIDER_IMPORT_BYTES,
): number {
  const opened = openProviderRegularFile(providerRoot, filePath, maxBytes);
  if (!opened) return 0;
  try {
    return opened.validate() ? opened.metadata.mtimeMs : 0;
  } finally {
    opened.close();
  }
}

/** List a provider directory only when every path component is a real directory. */
export function listProviderDirectory(
  providerRoot: string,
  directory: string,
): ReadonlyArray<fs.Dirent> | null {
  let guard: ProviderDirectoryGuard | undefined;
  let handle: fs.Dir | undefined;
  try {
    guard = ProviderDirectoryGuard.open(providerRoot, directory);
    handle = fs.opendirSync(directory);
    const entries: fs.Dirent[] = [];
    for (;;) {
      const entry = handle.readSync();
      if (!entry) break;
      if (entries.length >= MAX_PROVIDER_DIRECTORY_ENTRIES) return null;
      entries.push(entry);
    }
    guard.revalidate();
    return entries;
  } catch {
    return null;
  } finally {
    handle?.closeSync();
    guard?.close();
  }
}

export function getProviderDirectoryMtime(providerRoot: string, directory: string): number {
  let guard: ProviderDirectoryGuard | undefined;
  try {
    guard = ProviderDirectoryGuard.open(providerRoot, directory);
    const mtime = fs.lstatSync(directory).mtimeMs;
    guard.revalidate();
    return mtime;
  } catch {
    return 0;
  } finally {
    guard?.close();
  }
}
