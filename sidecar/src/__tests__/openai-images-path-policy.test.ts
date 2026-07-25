import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  approvedImageOutputDirectory,
  parseApprovedImageRoots,
  readApprovedImageFile,
} from "../openai-images-path-policy.js";

const rootsToRemove: string[] = [];

function makeFixture() {
  const rawRoot = mkdtempSync(join(tmpdir(), "bytro-image-policy-"));
  rootsToRemove.push(rawRoot);
  const root = realpathSync.native(rawRoot);
  const uploads = join(root, "uploads");
  const outputs = join(root, "outputs");
  const outside = join(root, "outside");
  mkdirSync(uploads);
  mkdirSync(outputs);
  mkdirSync(outside);
  const approvedRoots = parseApprovedImageRoots(
    JSON.stringify([uploads, outputs]),
  );
  return { root, uploads, outputs, outside, approvedRoots };
}

afterEach(() => {
  for (const root of rootsToRemove.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("OpenAI images input path policy", () => {
  it("accepts attachment and generated-image files in explicit roots", () => {
    const { uploads, outputs, approvedRoots } = makeFixture();
    const attachment = join(uploads, "attachment.png");
    const generated = join(outputs, "generated.webp");
    writeFileSync(attachment, Buffer.from("attachment"));
    writeFileSync(generated, Buffer.from("generated"));

    expect(
      readApprovedImageFile(attachment, approvedRoots, 1024).buffer.toString(),
    ).toBe("attachment");
    expect(
      readApprovedImageFile(generated, approvedRoots, 1024).buffer.toString(),
    ).toBe("generated");
    expect(approvedImageOutputDirectory(outputs, approvedRoots)).toBe(outputs);
  });

  it("rejects unapproved, traversal, directory, and oversized inputs", () => {
    const { uploads, outside, approvedRoots } = makeFixture();
    const privateImage = join(outside, "private.png");
    const approvedImage = join(uploads, "image.png");
    const largeImage = join(uploads, "large.png");
    const largeMask = join(uploads, "mask.png");
    writeFileSync(privateImage, Buffer.from("private"));
    writeFileSync(approvedImage, Buffer.from("image"));
    writeFileSync(largeImage, Buffer.alloc(0));
    writeFileSync(largeMask, Buffer.alloc(0));
    truncateSync(largeImage, 50 * 1024 * 1024 + 1);
    truncateSync(largeMask, 4 * 1024 * 1024 + 1);

    expect(() =>
      readApprovedImageFile(privateImage, approvedRoots, 50 * 1024 * 1024),
    ).toThrow("outside approved");
    expect(() =>
      readApprovedImageFile(
        `${uploads}${sep}nested${sep}..${sep}image.png`,
        approvedRoots,
        50 * 1024 * 1024,
      ),
    ).toThrow("invalid");
    expect(() =>
      readApprovedImageFile(uploads, approvedRoots, 50 * 1024 * 1024),
    ).toThrow("regular file");
    expect(() =>
      readApprovedImageFile(largeImage, approvedRoots, 50 * 1024 * 1024),
    ).toThrow("allowed size");
    expect(() =>
      readApprovedImageFile(largeMask, approvedRoots, 4 * 1024 * 1024),
    ).toThrow("allowed size");
  });

  it.skipIf(process.platform === "win32")(
    "rejects linked root, intermediate, and leaf components",
    () => {
      const { root, uploads, outside, approvedRoots } = makeFixture();
      const realImage = join(outside, "real.png");
      writeFileSync(realImage, Buffer.from("private"));

      const linkedRoot = join(root, "linked-root");
      symlinkSync(uploads, linkedRoot, "dir");
      expect(() =>
        parseApprovedImageRoots(JSON.stringify([linkedRoot])),
      ).toThrow(/Linked|Reparse/);

      const linkedDirectory = join(uploads, "linked-directory");
      symlinkSync(outside, linkedDirectory, "dir");
      expect(() =>
        readApprovedImageFile(
          join(linkedDirectory, "real.png"),
          approvedRoots,
          1024,
        ),
      ).toThrow(/Linked|Reparse/);

      const linkedFile = join(uploads, "linked.png");
      symlinkSync(realImage, linkedFile, "file");
      expect(() =>
        readApprovedImageFile(linkedFile, approvedRoots, 1024),
      ).toThrow(/Linked|Reparse/);
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects FIFO inputs without opening them",
    () => {
      const { uploads, approvedRoots } = makeFixture();
      const fifo = join(uploads, "pipe.png");
      execFileSync("mkfifo", [fifo]);

      expect(() =>
        readApprovedImageFile(fifo, approvedRoots, 1024),
      ).toThrow("regular file");
    },
  );

  it("fails closed when roots are missing, malformed, or not directories", () => {
    const { root } = makeFixture();
    const file = join(root, "file");
    writeFileSync(file, Buffer.from("x"));

    expect(() => parseApprovedImageRoots(undefined)).toThrow("not configured");
    expect(() => parseApprovedImageRoots("{")).toThrow("invalid");
    expect(() => parseApprovedImageRoots(JSON.stringify([file]))).toThrow(
      "must be a directory",
    );
  });
});
