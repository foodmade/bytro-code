function collapseWhitespace(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

export function stripConversationMarkdown(input: string): string {
  if (!input) {
    return "";
  }

  let output = input;

  output = output.replace(/```[\s\S]*?```/g, " ");
  output = output.replace(/`([^`]+)`/g, "$1");

  output = output.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
  output = output.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");

  output = output.replace(/<[^>]+>/g, " ");

  output = output.replace(/^\s{0,3}#{1,6}\s+/gm, "");
  output = output.replace(/^\s{0,3}>\s?/gm, "");
  output = output.replace(/^\s*[-*+]\s+/gm, "");
  output = output.replace(/^\s*\d+[.)]\s+/gm, "");

  output = output.replace(/[*_~]+/g, "");

  return collapseWhitespace(output);
}

function limitChars(input: string, maxLength: number): string {
  if (input.length <= maxLength) {
    return input;
  }
  return `${input.slice(0, maxLength).trimEnd()}...`;
}

export function formatConversationTitle(title: string): string {
  const cleaned = stripConversationMarkdown(title);
  return cleaned || "Untitled conversation";
}

export function formatConversationPreview(preview: string, maxLength = 120): string {
  const cleaned = stripConversationMarkdown(preview);
  if (!cleaned) {
    return "";
  }
  return limitChars(cleaned, maxLength);
}
