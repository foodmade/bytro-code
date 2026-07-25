import { File, FileCode, FileJson, FileText, Image } from "lucide-react";

export function getFileIcon(extension: string | null, name?: string) {
  const isRootConfig =
    name === "package.json" ||
    name === "tsconfig.json" ||
    name === "vite.config.ts" ||
    name === ".env.local" ||
    name === ".env";
  if (isRootConfig) {
    return <File size={14} className="shrink-0" style={{ color: "#777777" }} />;
  }

  if (name === "index.html") {
    return <File size={14} className="shrink-0" style={{ color: "#F97316" }} />;
  }

  switch (extension) {
    case "ts":
    case "tsx":
    case "js":
    case "jsx":
    case "rs":
    case "py":
    case "go":
    case "rb":
    case "java":
    case "c":
    case "cpp":
    case "h":
      return <FileCode size={14} className="text-accent-blue shrink-0" />;
    case "json":
    case "toml":
    case "yaml":
    case "yml":
      return <FileJson size={14} className="shrink-0" style={{ color: "#777777" }} />;
    case "md":
    case "txt":
    case "csv":
      return <FileText size={14} className="text-muted-foreground shrink-0" />;
    case "png":
    case "jpg":
    case "jpeg":
    case "gif":
    case "svg":
    case "ico":
      return <Image size={14} className="text-accent-green shrink-0" />;
    case "html":
      return <File size={14} className="shrink-0" style={{ color: "#F97316" }} />;
    default:
      return <File size={14} className="shrink-0" style={{ color: "#777777" }} />;
  }
}
