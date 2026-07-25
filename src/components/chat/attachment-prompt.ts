export interface PromptAttachedFile {
  readonly name: string;
  readonly content?: string;
  readonly path?: string;
  readonly source?: "file" | "pasted-text";
}

export interface AttachedFilesPromptParts {
  readonly promptPrefix: string;
  readonly displayPrefix: string;
}

const MAX_ATTACH_CHARS = 30_000;

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function formatSourceAttr(source: PromptAttachedFile["source"]): string {
  return source === "pasted-text" ? ' source="pasted-text"' : "";
}

export function buildAttachedFilesPromptParts(
  files: ReadonlyArray<PromptAttachedFile>,
): AttachedFilesPromptParts {
  const promptPrefix = files
    .map((file) => {
      const path = file.path ?? file.name;
      const escapedPath = escapeAttr(path);
      const sourceAttr = formatSourceAttr(file.source);
      if (file.path) {
        return `<file-ref path="${escapedPath}" kind="file"${sourceAttr}/>`;
      }

      const content = file.content ?? "";
      const truncated = content.length > MAX_ATTACH_CHARS
        ? content.slice(0, MAX_ATTACH_CHARS) + `\n...(truncated, ${content.length} chars total)`
        : content;
      return `<file path="${escapedPath}"${sourceAttr}>\n${truncated}\n</file>`;
    })
    .join("\n\n");

  const displayPrefix = files
    .map((file) => {
      const path = file.path ?? file.name;
      return `<file-ref path="${escapeAttr(path)}" kind="file"${formatSourceAttr(file.source)}/>`;
    })
    .join(" ");

  return { promptPrefix, displayPrefix };
}
