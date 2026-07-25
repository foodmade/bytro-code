import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import {
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep,
} from "node:path";

const MAX_ALLOWED_ROOTS = 8;

function hasParentTraversal(path: string): boolean {
  return path.split(/[\\/]+/).includes("..");
}

function comparisonPath(path: string): string {
  const withoutExtendedPrefix = path.startsWith("\\\\?\\")
    ? path.slice(4)
    : path;
  const normalized = resolve(withoutExtendedPrefix);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function assertNoLinkedComponents(path: string): void {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  let current = root;
  const components = absolute
    .slice(root.length)
    .split(/[\\/]+/)
    .filter(Boolean);

  for (const component of components) {
    current = join(current, component);
    const metadata = lstatSync(current);
    if (metadata.isSymbolicLink()) {
      throw new Error("Linked image paths are not allowed");
    }
    const real = realpathSync.native(current);
    if (comparisonPath(real) !== comparisonPath(current)) {
      throw new Error("Reparse-point image paths are not allowed");
    }
  }
}

function canonicalApprovedRoot(candidate: string): string {
  if (!candidate || !isAbsolute(candidate) || hasParentTraversal(candidate)) {
    throw new Error("Image input root is invalid");
  }
  assertNoLinkedComponents(candidate);
  const metadata = lstatSync(candidate);
  if (!metadata.isDirectory()) {
    throw new Error("Image input root must be a directory");
  }
  const canonical = realpathSync.native(candidate);
  assertNoLinkedComponents(canonical);
  return canonical;
}

export function parseApprovedImageRoots(raw: string | undefined): readonly string[] {
  if (!raw) {
    throw new Error("Approved image input roots are not configured");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Approved image input roots are invalid");
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    parsed.length > MAX_ALLOWED_ROOTS ||
    parsed.some((entry) => typeof entry !== "string" || !entry.trim())
  ) {
    throw new Error("Approved image input roots are invalid");
  }
  return [
    ...new Set(
      parsed.map((entry) => canonicalApprovedRoot((entry as string).trim())),
    ),
  ];
}

export function approvedImageOutputDirectory(
  candidate: string,
  approvedRoots: readonly string[],
): string {
  const canonicalCandidate = canonicalApprovedRoot(candidate);
  const isApproved = approvedRoots
    .map(canonicalApprovedRoot)
    .some(
      (root) => comparisonPath(root) === comparisonPath(canonicalCandidate),
    );
  if (!isApproved) {
    throw new Error("Image output directory is not approved");
  }
  return canonicalCandidate;
}

function isWithinRoot(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot === "" ||
    (
      pathFromRoot !== ".." &&
      !pathFromRoot.startsWith(`..${sep}`) &&
      !isAbsolute(pathFromRoot)
    )
  );
}

function sameFileIdentity(
  left: { dev: number; ino: number },
  right: { dev: number; ino: number },
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

export interface ApprovedImageFile {
  readonly buffer: Buffer;
  readonly canonicalPath: string;
}

export function readApprovedImageFile(
  candidate: string,
  approvedRoots: readonly string[],
  maxBytes: number,
): ApprovedImageFile {
  if (
    !candidate ||
    !isAbsolute(candidate) ||
    hasParentTraversal(candidate) ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes <= 0
  ) {
    throw new Error("Image path is invalid");
  }

  const canonicalRoots = approvedRoots.map(canonicalApprovedRoot);
  assertNoLinkedComponents(candidate);
  const before = lstatSync(candidate);
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new Error("Image input must be a regular file");
  }

  const canonicalPath = realpathSync.native(candidate);
  assertNoLinkedComponents(canonicalPath);
  if (!canonicalRoots.some((root) => isWithinRoot(root, canonicalPath))) {
    throw new Error("Image path is outside approved directories");
  }

  const noFollow = constants.O_NOFOLLOW ?? 0;
  const fd = openSync(canonicalPath, constants.O_RDONLY | noFollow);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || !sameFileIdentity(before, opened)) {
      throw new Error("Image input changed during validation");
    }
    if (opened.size > maxBytes) {
      throw new Error("Image input exceeds the allowed size");
    }

    const buffer = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < buffer.length) {
      const bytesRead = readSync(
        fd,
        buffer,
        offset,
        buffer.length - offset,
        null,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset !== buffer.length) {
      throw new Error("Image input changed during validation");
    }
    const extra = Buffer.allocUnsafe(1);
    if (readSync(fd, extra, 0, 1, null) !== 0) {
      throw new Error("Image input changed during validation");
    }

    const afterFd = fstatSync(fd);
    const afterPath = lstatSync(canonicalPath);
    if (
      !afterFd.isFile() ||
      !afterPath.isFile() ||
      !sameFileIdentity(opened, afterFd) ||
      !sameFileIdentity(opened, afterPath) ||
      afterFd.size !== opened.size ||
      afterPath.size !== opened.size
    ) {
      throw new Error("Image input changed during validation");
    }
    assertNoLinkedComponents(canonicalPath);

    return { buffer, canonicalPath };
  } finally {
    closeSync(fd);
  }
}
