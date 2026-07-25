import { memo, useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import CodeMirror, { type ReactCodeMirrorRef } from "@uiw/react-codemirror";
import { Decoration, keymap, EditorView, type ViewUpdate } from "@codemirror/view";
import { EditorSelection, EditorState, type Extension, type Text } from "@codemirror/state";
import { getChunks, unifiedMergeView, type Chunk } from "@codemirror/merge";
import { HighlightStyle, StreamLanguage, syntaxHighlighting, type StreamParser, type StringStream } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import type { Plugin as PrettierPlugin } from "prettier";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { rust } from "@codemirror/lang-rust";
import { xml } from "@codemirror/lang-xml";
import { yaml } from "@codemirror/lang-yaml";
import { c as cMode, cpp as cppMode, csharp as csharpMode, dart as dartMode, java as javaMode, kotlin as kotlinMode, objectiveC as objectiveCMode, objectiveCpp as objectiveCppMode, scala as scalaMode } from "@codemirror/legacy-modes/mode/clike";
import { clojure as clojureMode } from "@codemirror/legacy-modes/mode/clojure";
import { cmake as cmakeMode } from "@codemirror/legacy-modes/mode/cmake";
import { coffeeScript as coffeeScriptMode } from "@codemirror/legacy-modes/mode/coffeescript";
import { less as lessMode } from "@codemirror/legacy-modes/mode/css";
import { crystal as crystalMode } from "@codemirror/legacy-modes/mode/crystal";
import { d as dMode } from "@codemirror/legacy-modes/mode/d";
import { diff as diffParser } from "@codemirror/legacy-modes/mode/diff";
import { dockerFile as dockerFileMode } from "@codemirror/legacy-modes/mode/dockerfile";
import { elm as elmMode } from "@codemirror/legacy-modes/mode/elm";
import { erlang as erlangMode } from "@codemirror/legacy-modes/mode/erlang";
import { fSharp as fSharpMode, oCaml as ocamlMode, sml as smlMode } from "@codemirror/legacy-modes/mode/mllike";
import { fortran as fortranMode } from "@codemirror/legacy-modes/mode/fortran";
import { go as goMode } from "@codemirror/legacy-modes/mode/go";
import { groovy as groovyMode } from "@codemirror/legacy-modes/mode/groovy";
import { haskell as haskellMode } from "@codemirror/legacy-modes/mode/haskell";
import { haxe as haxeMode, hxml as hxmlMode } from "@codemirror/legacy-modes/mode/haxe";
import { jinja2 as jinja2Mode } from "@codemirror/legacy-modes/mode/jinja2";
import { julia as juliaMode } from "@codemirror/legacy-modes/mode/julia";
import { lua as luaMode } from "@codemirror/legacy-modes/mode/lua";
import { nginx as nginxMode } from "@codemirror/legacy-modes/mode/nginx";
import { pascal as pascalMode } from "@codemirror/legacy-modes/mode/pascal";
import { perl as perlMode } from "@codemirror/legacy-modes/mode/perl";
import { powerShell as powerShellMode } from "@codemirror/legacy-modes/mode/powershell";
import { properties as propertiesMode } from "@codemirror/legacy-modes/mode/properties";
import { protobuf as protobufMode } from "@codemirror/legacy-modes/mode/protobuf";
import { pug as pugMode } from "@codemirror/legacy-modes/mode/pug";
import { r as rMode } from "@codemirror/legacy-modes/mode/r";
import { ruby as rubyMode } from "@codemirror/legacy-modes/mode/ruby";
import { sass as sassMode } from "@codemirror/legacy-modes/mode/sass";
import { shell as shellMode } from "@codemirror/legacy-modes/mode/shell";
import { standardSQL as standardSqlMode, pgSQL as pgSqlMode, mySQL as mySqlMode, sqlite as sqliteMode } from "@codemirror/legacy-modes/mode/sql";
import { stex as stexMode } from "@codemirror/legacy-modes/mode/stex";
import { stylus as stylusMode } from "@codemirror/legacy-modes/mode/stylus";
import { swift as swiftMode } from "@codemirror/legacy-modes/mode/swift";
import { tcl as tclMode } from "@codemirror/legacy-modes/mode/tcl";
import { toml as tomlMode } from "@codemirror/legacy-modes/mode/toml";
import { vb as vbMode } from "@codemirror/legacy-modes/mode/vb";
import { verilog as verilogMode } from "@codemirror/legacy-modes/mode/verilog";
import { vhdl as vhdlMode } from "@codemirror/legacy-modes/mode/vhdl";
import { wast as wastMode } from "@codemirror/legacy-modes/mode/wast";
import { webIDL as webIDLMode } from "@codemirror/legacy-modes/mode/webidl";
import { xQuery as xQueryMode } from "@codemirror/legacy-modes/mode/xquery";
import { invoke } from "@tauri-apps/api/core";
import { Check, ChevronDown, ChevronUp, X, BookOpen, Code, RotateCcw, ZoomIn, ZoomOut, RotateCw } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  createNativeContextMenuItem,
  nativeMenuSeparator,
  popupNativeContextMenu,
  type NativeContextMenuItem,
} from "@/lib/native-context-menu";
import { useIsLightTheme } from "@/hooks/use-is-light-theme";
import { useAppStore, useChatStore, useConversationStore, useSettingsStore, useSplitViewStore, useWorkspaceStore, type EditorDiffMode } from "@/stores";
import { useToastStore } from "@/stores/toast-store";
import { formatError } from "@/lib/format-error";
import { MarkdownRenderer } from "@/components/ui";
import { CodeBlock } from "@/components/chat/code-block";
import { isLoadedFileStateForPath, type FileState } from "./code-editor-state";
import "highlight.js/styles/github-dark-dimmed.min.css";

const EDITOR_ADD_TO_CHAT_EVENT = "bytro:editor-add-to-chat";
const EDITOR_CONTEXT_MENU_ID = "bytro-editor-context-menu";

interface SelectionSnippet {
  readonly id: string;
  readonly filePath: string;
  readonly fileName: string;
  readonly language: string;
  readonly text: string;
  readonly label: string;
  readonly range: {
    readonly startLineNumber: number;
    readonly startColumn: number;
    readonly endLineNumber: number;
    readonly endColumn: number;
  };
}

interface EditorAddToChatDetail {
  readonly snippet: SelectionSnippet;
  readonly conversationId?: string;
}

interface EditorContextMenuContext {
  readonly importLink: ImportLinkMatch | null;
  readonly hasSelection: boolean;
  readonly hasChatSnippet: boolean;
  readonly canFormat: boolean;
}

type PrettierParserName =
  | "babel"
  | "typescript"
  | "json"
  | "css"
  | "scss"
  | "less"
  | "html"
  | "vue"
  | "markdown"
  | "mdx"
  | "yaml";

interface ImportLinkMatch {
  readonly specifier: string;
  readonly from: number;
  readonly to: number;
}

const codeMirrorHighlightStyle = HighlightStyle.define([
  { tag: tags.comment, color: "var(--bytro-editor-token-comment)", fontStyle: "italic" },
  { tag: [tags.keyword, tags.controlKeyword, tags.definitionKeyword, tags.operatorKeyword, tags.modifier], color: "var(--bytro-editor-token-keyword)" },
  { tag: [tags.string, tags.special(tags.string), tags.regexp], color: "var(--bytro-editor-token-string)" },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], color: "var(--bytro-editor-token-number)" },
  { tag: [tags.typeName, tags.className, tags.namespace], color: "var(--bytro-editor-token-type)" },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName), tags.labelName], color: "var(--bytro-editor-token-function)" },
  { tag: [tags.propertyName, tags.attributeName], color: "var(--bytro-editor-token-property)" },
  { tag: tags.tagName, color: "var(--bytro-editor-token-keyword)" },
  { tag: [tags.punctuation, tags.separator, tags.bracket], color: "var(--bytro-editor-token-delimiter)" },
  { tag: tags.operator, color: "var(--bytro-editor-token-operator)" },
]);

const codeMirrorSyntaxHighlighting = syntaxHighlighting(codeMirrorHighlightStyle);

const dotenvLanguage = StreamLanguage.define({
  token(stream: StringStream): string | null {
    if (stream.sol()) {
      if (stream.match(/\s*#.*$/)) return "comment";
      if (stream.match(/\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*(?=\s*=)/)) return "variableName";
    }
    if (stream.match(/\s+/)) return null;
    if (stream.match(/#.*/)) return "comment";
    if (stream.match("=")) return "operator";
    if (stream.match(/"(?:[^"\\]|\\.)*"/) || stream.match(/'(?:[^'\\]|\\.)*'/)) return "string";
    stream.next();
    return "string";
  },
});

function matchedText(match: boolean | RegExpMatchArray | null): string {
  return Array.isArray(match) ? match[0] : "";
}

const BATCH_KEYWORDS = new Set([
  "assoc", "break", "call", "cd", "chcp", "cls", "cmd", "copy", "del", "dir", "do", "echo", "else", "endlocal", "erase",
  "exit", "for", "goto", "if", "in", "md", "mkdir", "move", "not", "pause", "popd", "pushd", "rd", "rem", "ren", "rename",
  "rmdir", "robocopy", "set", "setlocal", "shift", "start", "then", "type", "xcopy",
]);

const batchLanguage = StreamLanguage.define({
  token(stream: StringStream): string | null {
    if (stream.sol() && stream.match(/\s*(?:::|rem\b).*$/i)) return "comment";
    if (stream.match(/\s+/)) return null;
    if (stream.match(/"(?:[^"^]|\\.)*"/) || stream.match(/'(?:[^'^]|\\.)*'/)) return "string";
    if (stream.match(/%[^%\s]+%/) || stream.match(/%%?[A-Za-z]/)) return "variableName";
    if (stream.match(/:[A-Za-z0-9_.-]+/)) return "labelName";
    if (stream.match(/\d+(?:\.\d+)?/)) return "number";
    if (stream.match(/[()<>|&=]+/)) return "operator";
    const word = stream.match(/[A-Za-z_][A-Za-z0-9_.-]*/);
    if (word) return BATCH_KEYWORDS.has(matchedText(word).toLowerCase()) ? "keyword" : "variableName";
    stream.next();
    return null;
  },
});

const HCL_KEYWORDS = new Set([
  "check", "data", "dynamic", "import", "locals", "module", "moved", "output", "provider", "removed", "resource", "terraform",
  "variable",
]);

const hclLanguage = StreamLanguage.define({
  token(stream: StringStream): string | null {
    if (stream.match(/\s+/)) return null;
    if (stream.match(/#.*/) || stream.match(/\/\/.*/)) return "comment";
    if (stream.match(/"(?:[^"\\]|\\.)*"/) || stream.match(/<<-?\w+/)) return "string";
    if (stream.match(/\b(?:true|false|null)\b/)) return "atom";
    if (stream.match(/\d+(?:\.\d+)?/)) return "number";
    if (stream.match(/[{}[\]().,=:+\-*/%<>!&|?]+/)) return "operator";
    const word = stream.match(/[A-Za-z_][\w-]*/);
    if (word) {
      const value = matchedText(word);
      if (HCL_KEYWORDS.has(value)) return "keyword";
      return stream.match(/\s*=/, false) ? "propertyName" : "variableName";
    }
    stream.next();
    return null;
  },
});

const GRAPHQL_KEYWORDS = new Set([
  "directive", "enum", "extend", "fragment", "implements", "input", "interface", "mutation", "on", "query", "repeatable",
  "scalar", "schema", "subscription", "type", "union",
]);

const graphQLLanguage = StreamLanguage.define({
  token(stream: StringStream): string | null {
    if (stream.match(/\s+/)) return null;
    if (stream.match(/#.*/)) return "comment";
    if (stream.match(/"""[\s\S]*?"""/) || stream.match(/"(?:[^"\\]|\\.)*"/)) return "string";
    if (stream.match(/\$[A-Za-z_][\w]*/)) return "variableName";
    if (stream.match(/@[A-Za-z_][\w]*/)) return "attributeName";
    if (stream.match(/\d+(?:\.\d+)?/)) return "number";
    if (stream.match(/[{}[\]():=!|&.,]+/)) return "operator";
    const word = stream.match(/[A-Za-z_][\w]*/);
    if (word) {
      const value = matchedText(word);
      if (GRAPHQL_KEYWORDS.has(value)) return "keyword";
      if (value === "true" || value === "false" || value === "null") return "atom";
      return /^[A-Z]/.test(value) ? "typeName" : "propertyName";
    }
    stream.next();
    return null;
  },
});

const PHP_KEYWORDS = new Set([
  "abstract", "and", "array", "as", "break", "callable", "case", "catch", "class", "clone", "const", "continue", "declare",
  "default", "die", "do", "echo", "else", "elseif", "empty", "enddeclare", "endfor", "endforeach", "endif", "endswitch",
  "endwhile", "enum", "eval", "exit", "extends", "final", "finally", "fn", "for", "foreach", "function", "global", "goto", "if",
  "implements", "include", "include_once", "instanceof", "insteadof", "interface", "isset", "list", "match", "namespace", "new",
  "or", "print", "private", "protected", "public", "readonly", "require", "require_once", "return", "static", "switch", "throw",
  "trait", "try", "use", "var", "while", "xor", "yield",
]);

const phpLanguage = StreamLanguage.define({
  token(stream: StringStream): string | null {
    if (stream.match(/\s+/)) return null;
    if (stream.match(/\/\/.*/) || stream.match(/#.*/)) return "comment";
    if (stream.match(/\/\*.*?\*\//)) return "comment";
    if (stream.match(/"(?:[^"\\]|\\.)*"/) || stream.match(/'(?:[^'\\]|\\.)*'/)) return "string";
    if (stream.match(/\$[A-Za-z_][\w]*/)) return "variableName";
    if (stream.match(/\b(?:true|false|null)\b/i)) return "atom";
    if (stream.match(/\d+(?:\.\d+)?/)) return "number";
    if (stream.match(/[{}[\]().,;:=+\-*/%<>!&|?]+/)) return "operator";
    const word = stream.match(/[A-Za-z_][\w]*/);
    if (word) return PHP_KEYWORDS.has(matchedText(word).toLowerCase()) ? "keyword" : "variableName";
    stream.next();
    return null;
  },
});

function legacyMode(parser: StreamParser<unknown>): Extension {
  return StreamLanguage.define(parser);
}

const LEGACY_LANGUAGE_EXTENSIONS: Record<string, Extension> = {
  bat: batchLanguage,
  c: legacyMode(cMode),
  clojure: legacyMode(clojureMode),
  cmake: legacyMode(cmakeMode),
  coffeescript: legacyMode(coffeeScriptMode),
  cpp: legacyMode(cppMode),
  crystal: legacyMode(crystalMode),
  csharp: legacyMode(csharpMode),
  d: legacyMode(dMode),
  dart: legacyMode(dartMode),
  diff: legacyMode(diffParser),
  dockerfile: legacyMode(dockerFileMode),
  elm: legacyMode(elmMode),
  erlang: legacyMode(erlangMode),
  fortran: legacyMode(fortranMode),
  fsharp: legacyMode(fSharpMode),
  go: legacyMode(goMode),
  graphql: graphQLLanguage,
  groovy: legacyMode(groovyMode),
  haskell: legacyMode(haskellMode),
  haxe: legacyMode(haxeMode),
  hcl: hclLanguage,
  hxml: legacyMode(hxmlMode),
  ini: legacyMode(propertiesMode),
  java: legacyMode(javaMode),
  jinja2: legacyMode(jinja2Mode),
  julia: legacyMode(juliaMode),
  kotlin: legacyMode(kotlinMode),
  latex: legacyMode(stexMode),
  less: legacyMode(lessMode),
  lua: legacyMode(luaMode),
  mysql: legacyMode(mySqlMode),
  nginx: legacyMode(nginxMode),
  "objective-c": legacyMode(objectiveCMode),
  "objective-cpp": legacyMode(objectiveCppMode),
  ocaml: legacyMode(ocamlMode),
  pascal: legacyMode(pascalMode),
  perl: legacyMode(perlMode),
  pgsql: legacyMode(pgSqlMode),
  php: phpLanguage,
  powershell: legacyMode(powerShellMode),
  proto: legacyMode(protobufMode),
  pug: legacyMode(pugMode),
  r: legacyMode(rMode),
  ruby: legacyMode(rubyMode),
  sass: legacyMode(sassMode),
  scala: legacyMode(scalaMode),
  scss: legacyMode(sassMode),
  shell: legacyMode(shellMode),
  sml: legacyMode(smlMode),
  sql: legacyMode(standardSqlMode),
  sqlite: legacyMode(sqliteMode),
  stylus: legacyMode(stylusMode),
  swift: legacyMode(swiftMode),
  tcl: legacyMode(tclMode),
  toml: legacyMode(tomlMode),
  vb: legacyMode(vbMode),
  verilog: legacyMode(verilogMode),
  vhdl: legacyMode(vhdlMode),
  wast: legacyMode(wastMode),
  webidl: legacyMode(webIDLMode),
  xquery: legacyMode(xQueryMode),
};

// ---------------------------------------------------------------------------
// Large file thresholds (bytes / characters)
// ---------------------------------------------------------------------------
/** Files above this size get reduced editor features for performance */
const LARGE_FILE_THRESHOLD = 512 * 1024; // 512 KB

const LANGUAGE_MAP: Record<string, string> = {
  // JavaScript / TypeScript
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  // Systems languages
  rs: "rust",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  hh: "cpp",
  hxx: "cpp",
  d: "d",
  cr: "crystal",
  go: "go",
  swift: "swift",
  hx: "haxe",
  hxml: "hxml",
  // JVM languages
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  scala: "scala",
  sc: "scala",
  groovy: "groovy",
  gvy: "groovy",
  gradle: "groovy",
  // .NET languages
  cs: "csharp",
  csx: "csharp",
  fs: "fsharp",
  fsx: "fsharp",
  fsi: "fsharp",
  vb: "vb",
  // Scripting languages
  py: "python",
  pyw: "python",
  rb: "ruby",
  php: "php",
  phtml: "php",
  pl: "perl",
  pm: "perl",
  t: "perl",
  lua: "lua",
  r: "r",
  R: "r",
  dart: "dart",
  ex: "elixir",
  exs: "elixir",
  clj: "clojure",
  cljs: "clojure",
  cljc: "clojure",
  coffee: "coffeescript",
  litcoffee: "coffeescript",
  erl: "erlang",
  hrl: "erlang",
  hs: "haskell",
  lhs: "haskell",
  jl: "julia",
  ml: "ocaml",
  mli: "ocaml",
  mll: "ocaml",
  mly: "ocaml",
  sml: "sml",
  sig: "sml",
  pas: "pascal",
  pp: "pascal",
  tcl: "tcl",
  elm: "elm",
  // Apple languages
  m: "objective-c",
  mm: "objective-cpp",
  // Shell / CLI
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  fish: "shell",
  ksh: "shell",
  csh: "shell",
  envrc: "shell",
  command: "shell",
  ps1: "powershell",
  psm1: "powershell",
  psd1: "powershell",
  bat: "bat",
  cmd: "bat",
  // Styles
  css: "css",
  scss: "scss",
  less: "less",
  sass: "sass",
  styl: "stylus",
  // Markup / Template
  html: "html",
  htm: "html",
  vue: "html",
  svelte: "html",
  hbs: "handlebars",
  pug: "pug",
  jade: "pug",
  jinja: "jinja2",
  jinja2: "jinja2",
  j2: "jinja2",
  mdx: "mdx",
  md: "markdown",
  // Data / Config
  json: "json",
  jsonc: "json",
  json5: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  ini: "ini",
  cfg: "ini",
  conf: "ini",
  properties: "ini",
  xml: "xml",
  svg: "xml",
  plist: "xml",
  xq: "xquery",
  xql: "xquery",
  xqm: "xquery",
  xqy: "xquery",
  // Database
  sql: "sql",
  pgsql: "pgsql",
  mysql: "mysql",
  sqlite: "sqlite",
  // DevOps / IaC
  tf: "hcl",
  tfvars: "hcl",
  hcl: "hcl",
  nomad: "hcl",
  proto: "proto",
  cmake: "cmake",
  patch: "diff",
  diff: "diff",
  // GraphQL
  graphql: "graphql",
  gql: "graphql",
  // Hardware / lower-level formats
  v: "verilog",
  vh: "verilog",
  sv: "verilog",
  svh: "verilog",
  vhd: "vhdl",
  vhdl: "vhdl",
  wat: "wast",
  wast: "wast",
  webidl: "webidl",
  // Documents
  tex: "latex",
  sty: "latex",
  cls: "latex",
};

const FILENAME_MAP: Record<string, string> = {
  Dockerfile: "dockerfile",
  dockerfile: "dockerfile",
  Containerfile: "dockerfile",
  containerfile: "dockerfile",
  Makefile: "shell",
  makefile: "shell",
  GNUmakefile: "shell",
  "CMakeLists.txt": "cmake",
  Gemfile: "ruby",
  Rakefile: "ruby",
  Vagrantfile: "ruby",
  Brewfile: "ruby",
  Fastfile: "ruby",
  Podfile: "ruby",
  Procfile: "shell",
  Jenkinsfile: "groovy",
  ".bashrc": "shell",
  ".bash_profile": "shell",
  ".zshrc": "shell",
  ".profile": "shell",
  ".npmrc": "ini",
  ".yarnrc": "ini",
  ".editorconfig": "ini",
  ".gitconfig": "ini",
  ".gitignore": "ini",
  ".dockerignore": "ini",
  "nginx.conf": "nginx",
};

function getLanguage(filePath: string): string {
  const fileName = filePath.split(/[/\\]/).pop() ?? "";
  if (fileName === ".env" || fileName.startsWith(".env.")) return "dotenv";
  if (/^(?:Dockerfile|Containerfile)(?:\.|$)/i.test(fileName)) return "dockerfile";
  if (/^Makefile(?:\.|$)/i.test(fileName)) return "shell";
  const fileNameLang = FILENAME_MAP[fileName];
  if (fileNameLang) return fileNameLang;
  const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
  return LANGUAGE_MAP[ext] ?? "plaintext";
}

function getPrettierParser(filePath: string): PrettierParserName | null {
  const fileName = filePath.split(/[/\\]/).pop() ?? "";
  const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
  switch (getLanguage(filePath)) {
    case "javascript":
      return "babel";
    case "typescript":
      return "typescript";
    case "json":
      return "json";
    case "css":
      return "css";
    case "scss":
      return "scss";
    case "less":
      return "less";
    case "html":
      return ext === "vue" ? "vue" : "html";
    case "markdown":
      return "markdown";
    case "mdx":
      return "mdx";
    case "yaml":
      return "yaml";
    default:
      return null;
  }
}

async function getPrettierPlugins(parser: PrettierParserName): Promise<PrettierPlugin[]> {
  switch (parser) {
    case "babel":
    case "json": {
      const [babel, estree] = await Promise.all([
        import("prettier/plugins/babel"),
        import("prettier/plugins/estree"),
      ]);
      return [babel as PrettierPlugin, estree as PrettierPlugin];
    }
    case "typescript": {
      const [typescript, estree] = await Promise.all([
        import("prettier/plugins/typescript"),
        import("prettier/plugins/estree"),
      ]);
      return [typescript as PrettierPlugin, estree as PrettierPlugin];
    }
    case "css":
    case "scss":
    case "less": {
      const postcss = await import("prettier/plugins/postcss");
      return [postcss as PrettierPlugin];
    }
    case "html":
    case "vue": {
      const htmlPlugin = await import("prettier/plugins/html");
      return [htmlPlugin as PrettierPlugin];
    }
    case "markdown":
    case "mdx": {
      const markdownPlugin = await import("prettier/plugins/markdown");
      return [markdownPlugin as PrettierPlugin];
    }
    case "yaml": {
      const yamlPlugin = await import("prettier/plugins/yaml");
      return [yamlPlugin as PrettierPlugin];
    }
  }
}

async function formatWithPrettier(filePath: string, content: string): Promise<string | null> {
  const parser = getPrettierParser(filePath);
  if (!parser) return null;
  const [prettier, plugins] = await Promise.all([
    import("prettier/standalone"),
    getPrettierPlugins(parser),
  ]);
  return await prettier.format(content, {
    parser,
    plugins,
    printWidth: 100,
    tabWidth: 2,
    useTabs: false,
  });
}

function getCodeMirrorLanguageExtensions(filePath: string, isLargeFile: boolean): Extension[] {
  if (isLargeFile) return [];

  const fileName = filePath.split(/[/\\]/).pop() ?? "";
  const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
  const language = getLanguage(filePath);
  switch (language) {
    case "javascript":
      return [javascript({ jsx: ext === "jsx" })];
    case "typescript":
      return [javascript({ jsx: ext === "tsx", typescript: true })];
    case "json":
      return [json()];
    case "html":
      return [html()];
    case "css":
      return [css()];
    case "scss":
    case "sass":
    case "less":
    case "stylus":
      return [LEGACY_LANGUAGE_EXTENSIONS[language]];
    case "markdown":
    case "mdx":
      return [markdown()];
    case "python":
      return [python()];
    case "rust":
      return [rust()];
    case "xml":
      return [xml()];
    case "yaml":
      return [yaml()];
    case "dotenv":
      return [dotenvLanguage];
    default:
      return LEGACY_LANGUAGE_EXTENSIONS[language] ? [LEGACY_LANGUAGE_EXTENSIONS[language]] : [];
  }
}

function getFileName(filePath: string): string {
  const sep = filePath.includes("\\") ? "\\" : "/";
  return filePath.split(sep).pop() ?? filePath;
}

function getEditorDisplayPath(filePath: string, workspacePath: string | null | undefined): string {
  const normalizedFile = filePath.replace(/\\/g, "/");
  const normalizedWorkspace = workspacePath?.replace(/\\/g, "/").replace(/\/$/, "");
  if (normalizedWorkspace && normalizedFile.startsWith(`${normalizedWorkspace}/`)) {
    return `${getFileName(normalizedWorkspace)}/${normalizedFile.slice(normalizedWorkspace.length + 1)}`;
  }
  return normalizedFile.replace(/^\/+/, "");
}

function getEditorBreadcrumbParts(filePath: string, workspacePath: string | null | undefined): string[] {
  const parts = getEditorDisplayPath(filePath, workspacePath).split("/").filter(Boolean);
  return parts.length > 0 ? parts : [getFileName(filePath)];
}

function isMarkdownFile(filePath: string): boolean {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  return ext === "md" || ext === "mdx";
}

const IMAGE_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "bmp", "webp", "svg", "ico", "avif", "tiff", "tif",
]);

function isImageFile(filePath: string): boolean {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  return IMAGE_EXTENSIONS.has(ext);
}

// ---------------------------------------------------------------------------
// Image Preview
// ---------------------------------------------------------------------------

const MIME_MAP: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  bmp: "image/bmp",
  webp: "image/webp",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  avif: "image/avif",
  tiff: "image/tiff",
  tif: "image/tiff",
};

const IMPORT_PATH_RE = /\b(?:import|export)\b[\s\S]*?\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)|\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/;
const IMPORT_EXTENSIONS = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".css", ".scss", "/index.ts", "/index.tsx", "/index.js", "/index.jsx"];

function dirname(path: string): string {
  const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return index >= 0 ? path.slice(0, index) : "";
}

function joinPath(base: string, child: string): string {
  if (!base) return child;
  const sep = base.includes("\\") ? "\\" : "/";
  return `${base.replace(/[\\/]$/, "")}${sep}${child}`;
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path);
}

function getWorkspaceFilePathCandidates(filePath: string, workspacePath: string | null | undefined): string[] {
  if (!workspacePath || isAbsolutePath(filePath)) return [filePath];
  const primary = joinPath(workspacePath, filePath);
  const workspaceName = getFileName(workspacePath);
  const firstSegment = filePath.split(/[\\/]/)[0] ?? "";
  const parentWorkspace = dirname(workspacePath);
  const candidates = firstSegment === workspaceName && parentWorkspace
    ? [joinPath(parentWorkspace, filePath), primary]
    : [primary];
  return Array.from(new Set(candidates));
}

function logEditorPath(action: string, data: Record<string, unknown>): void {
  if (!import.meta.env.DEV) return;
  console.warn(`[CodeEditor:path] ${action}`, data);
}

function normalizePath(path: string): string {
  const isWindows = /^[A-Za-z]:/.test(path);
  const sep = path.includes("\\") && !path.includes("/") ? "\\" : "/";
  const normalized = path.replace(/\\/g, "/");
  const prefix = isWindows ? normalized.slice(0, 2) : normalized.startsWith("/") ? "/" : "";
  const rest = normalized.slice(prefix.length);
  const parts: string[] = [];
  for (const part of rest.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  const value = `${prefix}${parts.join("/")}`;
  return sep === "\\" ? value.replace(/\//g, "\\") : value;
}

function getImportLinkAtPosition(view: EditorView, position: number): ImportLinkMatch | null {
  const line = view.state.doc.lineAt(position);
  const match = IMPORT_PATH_RE.exec(line.text);
  const specifier = match?.[1] ?? match?.[2] ?? match?.[3];
  if (!match || !specifier) return null;
  const specifierIndex = line.text.indexOf(specifier, match.index);
  if (specifierIndex < 0) return null;
  const from = line.from + specifierIndex;
  const to = from + specifier.length;
  if (position < from || position > to) return null;
  return { specifier, from, to };
}

function getImportCandidates(currentFilePath: string, specifier: string): string[] {
  const workspacePath = useWorkspaceStore.getState().activeWorkspace?.path;
  let basePath: string | null = null;
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    basePath = normalizePath(joinPath(dirname(currentFilePath), specifier));
  } else if (specifier.startsWith("@/")) {
    basePath = workspacePath ? normalizePath(joinPath(workspacePath, `src/${specifier.slice(2)}`)) : null;
  } else if (specifier.startsWith("@ui/")) {
    basePath = workspacePath ? normalizePath(joinPath(workspacePath, `src/components/ui/${specifier.slice(4)}`)) : null;
  } else if (specifier.startsWith("@store/")) {
    basePath = workspacePath ? normalizePath(joinPath(workspacePath, `src/store/${specifier.slice(7)}`)) : null;
  }
  if (!basePath) return [];
  return IMPORT_EXTENSIONS.map((ext) => normalizePath(`${basePath}${ext}`));
}

async function resolveImportPath(currentFilePath: string, specifier: string): Promise<string | null> {
  for (const candidate of getImportCandidates(currentFilePath, specifier)) {
    try {
      if (await invoke<boolean>("path_exists", { path: candidate })) return candidate;
    } catch {
      return null;
    }
  }
  return null;
}

function getSnippetLabel(filePath: string, text: string): string {
  const ext = getFileName(filePath).split(".").pop()?.toUpperCase() || getLanguage(filePath).toUpperCase();
  return `${ext} ${getFileName(filePath)} (${text.length})`;
}

function getSelectedCodeMirrorText(view: EditorView): string {
  const selection = view.state.selection.main;
  return selection.empty ? "" : view.state.sliceDoc(selection.from, selection.to);
}

function buildSelectionSnippet(view: EditorView, filePath: string): SelectionSnippet | null {
  const selection = view.state.selection.main;
  if (selection.empty) return null;
  const text = getSelectedCodeMirrorText(view);
  if (!text.trim()) return null;
  const startLine = view.state.doc.lineAt(selection.from);
  const endLine = view.state.doc.lineAt(selection.to);
  return {
    id: `${filePath}:${startLine.number}:${selection.from - startLine.from + 1}:${endLine.number}:${selection.to - endLine.from + 1}:${Date.now()}`,
    filePath,
    fileName: getFileName(filePath),
    language: getLanguage(filePath),
    text,
    label: getSnippetLabel(filePath, text),
    range: {
      startLineNumber: startLine.number,
      startColumn: selection.from - startLine.from + 1,
      endLineNumber: endLine.number,
      endColumn: selection.to - endLine.from + 1,
    },
  };
}

function replaceEditorRange(view: EditorView, from: number, to: number, insert: string): void {
  view.dispatch({
    changes: { from, to, insert },
    selection: { anchor: from + insert.length },
    userEvent: "input",
  });
  view.focus();
}

async function writeClipboardText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const { writeText } = await import("@tauri-apps/plugin-clipboard-manager");
    await writeText(text);
  }
}

async function readClipboardText(): Promise<string> {
  try {
    return await navigator.clipboard.readText();
  } catch {
    const { readText } = await import("@tauri-apps/plugin-clipboard-manager");
    return readText();
  }
}

function createImportLinkHoverExtension(importLink: ImportLinkMatch | null): Extension {
  return EditorView.decorations.of((view) => {
    if (!importLink || importLink.from > view.state.doc.length || importLink.to > view.state.doc.length) {
      return Decoration.none;
    }
    return Decoration.set([
      Decoration.mark({ class: "codemirror-import-link-hover" }).range(importLink.from, importLink.to),
    ]);
  });
}

function areImportLinksEqual(a: ImportLinkMatch | null, b: ImportLinkMatch | null): boolean {
  return a?.from === b?.from && a?.to === b?.to && a?.specifier === b?.specifier;
}

function isFormattingSupported(filePath: string): boolean {
  return getPrettierParser(filePath) !== null;
}

function dispatchAddToCurrentChat(snippet: SelectionSnippet, conversationId?: string): void {
  useAppStore.getState().setActiveView("chat");
  window.setTimeout(() => {
    window.dispatchEvent(new CustomEvent<EditorAddToChatDetail>(EDITOR_ADD_TO_CHAT_EVENT, { detail: { snippet, conversationId } }));
  }, 0);
}

async function addToNewChat(snippet: SelectionSnippet): Promise<void> {
  const settingsState = useSettingsStore.getState();
  const platformConfig = settingsState.platforms[settingsState.activePlatformId];
  const model = platformConfig.activeModelId;
  const workspaceId = useWorkspaceStore.getState().activeWorkspace?.id;
  useConversationStore.getState().setActiveConversationId(null);
  useChatStore.getState().clearMessages();
  const conversation = await useConversationStore.getState().createConversation(model, workspaceId);
  useSplitViewStore.getState().resetToSingle(conversation.id);
  dispatchAddToCurrentChat(snippet, conversation.id);
}

function getImageMime(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  return MIME_MAP[ext] ?? "image/png";
}

function ImagePreview({ filePath, resolvedFilePath }: { readonly filePath: string; readonly resolvedFilePath: string }) {
  const [zoom, setZoom] = useState(1);
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState(false);

  const zoomIn = useCallback(() => setZoom((z) => Math.min(z * 1.25, 5)), []);
  const zoomOut = useCallback(() => setZoom((z) => Math.max(z / 1.25, 0.1)), []);
  const resetZoom = useCallback(() => setZoom(1), []);

  useEffect(() => {
    setSrc(null);
    setError(false);
    setZoom(1);
    let cancelled = false;
    logEditorPath("image read_file_base64", { filePath, resolvedFilePath });
    invoke<string>("read_file_base64", { path: resolvedFilePath })
      .then((b64) => {
        if (cancelled) return;
        const mime = getImageMime(filePath);
        setSrc(`data:${mime};base64,${b64}`);
      })
      .catch(() => {
        if (cancelled) return;
        setError(true);
      });
    return () => { cancelled = true; };
  }, [filePath, resolvedFilePath]);

  if (error) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
        Failed to load image
      </div>
    );
  }

  if (!src) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
        Loading...
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-center gap-2 py-1.5 border-b border-border shrink-0">
        <button
          onClick={zoomOut}
          className="p-1 rounded hover:bg-hover-overlay/10 transition-colors text-muted-foreground hover:text-foreground"
          title="Zoom out"
        >
          <ZoomOut size={14} />
        </button>
        <span className="text-[11px] text-muted-foreground min-w-[48px] text-center">
          {Math.round(zoom * 100)}%
        </span>
        <button
          onClick={zoomIn}
          className="p-1 rounded hover:bg-hover-overlay/10 transition-colors text-muted-foreground hover:text-foreground"
          title="Zoom in"
        >
          <ZoomIn size={14} />
        </button>
        <button
          onClick={resetZoom}
          className="p-1 rounded hover:bg-hover-overlay/10 transition-colors text-muted-foreground hover:text-foreground"
          title="Reset zoom"
        >
          <RotateCw size={12} />
        </button>
      </div>
      <div
        className="flex-1 overflow-auto flex items-center justify-center"
        style={{ background: "repeating-conic-gradient(var(--color-border) 0% 25%, var(--color-surface) 0% 50%) 0 0 / 16px 16px" }}
      >
        <img
          src={src}
          alt={getFileName(filePath)}
          onError={() => setError(true)}
          style={{
            transform: `scale(${zoom})`,
            transformOrigin: "center",
            maxWidth: zoom <= 1 ? "100%" : "none",
            maxHeight: zoom <= 1 ? "100%" : "none",
            objectFit: "contain",
            imageRendering: zoom > 2 ? "pixelated" : "auto",
          }}
          draggable={false}
        />
      </div>
    </div>
  );
}

interface DiffViewProps {
  readonly filePath: string;
  readonly original: string;
  readonly modified: string;
  readonly fontFamily: string;
  readonly fontSize: number;
  readonly canWriteBack?: boolean;
  readonly onKeep: () => void;
}

interface DiffHunk {
  readonly originalLine: number;
  readonly modifiedLine: number;
  readonly modifiedEndLine: number;
}

interface EditorOverlayHunk extends DiffHunk {
  readonly addedLines: number;
  readonly removedLines: number;
}

interface CodeMirrorHunk extends DiffHunk {
  readonly from: number;
  readonly to: number;
}

function clampDocPosition(doc: Text, position: number): number {
  return Math.min(Math.max(position, 0), doc.length);
}

function getLineNumberAtDocPosition(doc: Text, position: number): number {
  return doc.lineAt(clampDocPosition(doc, position)).number;
}

function getCodeMirrorHunksFromChunks(doc: Text, chunks: readonly Chunk[]): CodeMirrorHunk[] {
  return chunks.map((chunk) => {
    const from = clampDocPosition(doc, chunk.fromB);
    const to = clampDocPosition(doc, chunk.endB);
    const modifiedLine = getLineNumberAtDocPosition(doc, from);
    const modifiedEndLine = Math.max(modifiedLine, getLineNumberAtDocPosition(doc, Math.max(from, to)));
    const originalLine = getLineNumberAtDocPosition(doc, clampDocPosition(doc, chunk.fromA));
    return {
      originalLine,
      modifiedLine,
      modifiedEndLine,
      from,
      to: Math.max(from, to),
    };
  });
}

function getCodeMirrorHunks(view: EditorView): CodeMirrorHunk[] {
  const chunkInfo = getChunks(view.state);
  return chunkInfo ? getCodeMirrorHunksFromChunks(view.state.doc, chunkInfo.chunks) : [];
}

function createActiveCodeMirrorHunkExtension(hunks: ReadonlyArray<DiffHunk>, activeIndex: number): Extension {
  return EditorView.decorations.of((view) => {
    const hunk = hunks[activeIndex];
    if (!hunk) return Decoration.none;
    const ranges = [];
    for (let lineNumber = hunk.modifiedLine; lineNumber <= hunk.modifiedEndLine; lineNumber += 1) {
      if (lineNumber < 1 || lineNumber > view.state.doc.lines) continue;
      ranges.push(Decoration.line({ class: "diff-active-hunk-line" }).range(view.state.doc.line(lineNumber).from));
    }
    return Decoration.set(ranges, true);
  });
}

function getVisibleCodeMirrorHunkActionsTop(
  view: EditorView,
  hunk: DiffHunk,
  overlayContainer: HTMLElement,
): number | null {
  if (hunk.modifiedLine < 1 || hunk.modifiedLine > view.state.doc.lines) return null;

  const startLine = view.state.doc.line(hunk.modifiedLine);
  const endLine = view.state.doc.line(Math.min(Math.max(hunk.modifiedEndLine, hunk.modifiedLine), view.state.doc.lines));
  const startCoords = view.coordsAtPos(startLine.from);
  const endCoords = view.coordsAtPos(endLine.to);
  if (!startCoords || !endCoords) return null;

  const scrollRect = view.scrollDOM.getBoundingClientRect();
  if (endCoords.bottom < scrollRect.top || startCoords.top > scrollRect.bottom) return null;

  const containerRect = overlayContainer.getBoundingClientRect();
  const editorOffsetTop = scrollRect.top - containerRect.top;
  const viewportHeight = view.scrollDOM.clientHeight;
  const lineTop = startCoords.top - scrollRect.top;
  const maxTop = Math.max(
    DIFF_HUNK_ACTIONS_MARGIN,
    viewportHeight - DIFF_HUNK_ACTIONS_ESTIMATED_HEIGHT - DIFF_HUNK_ACTIONS_MARGIN,
  );
  const clampedLineTop = Math.min(Math.max(lineTop - 2, DIFF_HUNK_ACTIONS_MARGIN), maxTop);
  return editorOffsetTop + clampedLineTop;
}

function findOverlayHunkIndexAtLine(hunks: ReadonlyArray<DiffHunk>, lineNumber: number | undefined): number {
  if (lineNumber === undefined) return -1;
  return hunks.findIndex((hunk) => lineNumber >= hunk.modifiedLine && lineNumber <= hunk.modifiedEndLine);
}

const DIFF_HUNK_ACTIONS_MARGIN = 8;
const DIFF_HUNK_ACTIONS_ESTIMATED_HEIGHT = 38;

function splitEditorLines(content: string): string[] {
  if (content.length === 0) return [];
  return content.split(/\r?\n/);
}

function createFallbackOverlayHunk(originalLines: readonly string[], modifiedLines: readonly string[]): EditorOverlayHunk[] {
  if (originalLines.join("\n") === modifiedLines.join("\n")) return [];
  return [{
    originalLine: 1,
    modifiedLine: 1,
    modifiedEndLine: Math.max(1, modifiedLines.length),
    addedLines: modifiedLines.length,
    removedLines: originalLines.length,
  }];
}

function buildEditorOverlayHunks(original: string, modified: string): EditorOverlayHunk[] {
  if (original === modified) return [];
  const originalLines = splitEditorLines(original);
  const modifiedLines = splitEditorLines(modified);
  const originalCount = originalLines.length;
  const modifiedCount = modifiedLines.length;
  if (originalCount === 0 || modifiedCount === 0 || originalCount * modifiedCount > 800_000) {
    return createFallbackOverlayHunk(originalLines, modifiedLines);
  }

  const dp = Array.from({ length: originalCount + 1 }, () => new Uint16Array(modifiedCount + 1));
  for (let i = originalCount - 1; i >= 0; i -= 1) {
    for (let j = modifiedCount - 1; j >= 0; j -= 1) {
      dp[i][j] = originalLines[i] === modifiedLines[j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const hunks: EditorOverlayHunk[] = [];
  let i = 0;
  let j = 0;
  while (i < originalCount || j < modifiedCount) {
    if (i < originalCount && j < modifiedCount && originalLines[i] === modifiedLines[j]) {
      i += 1;
      j += 1;
      continue;
    }

    const originalStart = i + 1;
    const modifiedStart = j + 1;
    let addedLines = 0;
    let removedLines = 0;

    while (i < originalCount || j < modifiedCount) {
      if (i < originalCount && j < modifiedCount && originalLines[i] === modifiedLines[j]) break;
      if (i < originalCount && (j >= modifiedCount || dp[i + 1][j] >= dp[i][j + 1])) {
        i += 1;
        removedLines += 1;
      } else if (j < modifiedCount) {
        j += 1;
        addedLines += 1;
      }
    }

    const modifiedLine = Math.max(1, Math.min(modifiedStart, Math.max(1, modifiedCount)));
    const modifiedEndLine = addedLines > 0
      ? Math.max(modifiedLine, Math.min(Math.max(1, modifiedCount), j))
      : modifiedLine;
    hunks.push({
      originalLine: originalStart,
      modifiedLine,
      modifiedEndLine,
      addedLines,
      removedLines,
    });
  }

  return hunks;
}

function DiffView({ filePath, original, modified, fontFamily, fontSize, canWriteBack, onKeep }: DiffViewProps) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const diffViewRef = useRef<EditorView | null>(null);
  const workspacePath = useWorkspaceStore((s) => s.activeWorkspace?.path ?? null);
  const pathCandidates = useMemo(
    () => getWorkspaceFilePathCandidates(filePath, workspacePath),
    [filePath, workspacePath],
  );
  const resolvedFilePath = pathCandidates[0] ?? filePath;
  const [activeHunkIndex, setActiveHunkIndex] = useState(0);
  const [hoveredHunkIndex, setHoveredHunkIndexState] = useState<number | null>(null);
  const [hoverActionsTop, setHoverActionsTop] = useState<number | null>(null);
  const hunksRef = useRef<ReadonlyArray<CodeMirrorHunk>>([]);
  const hunksKeyRef = useRef("");
  const hoveredHunkIndexRef = useRef<number | null>(null);
  const hideHoverTimerRef = useRef<number | null>(null);
  const hoverPositionFrameRef = useRef<number | null>(null);
  const [isUndoing, setIsUndoing] = useState(false);
  const [hunks, setHunks] = useState<ReadonlyArray<CodeMirrorHunk>>([]);
  const isLightTheme = useIsLightTheme();
  const codeMirrorFontSize = Math.max(12, fontSize - 1);
  const codeMirrorDiffTheme = useMemo<Extension>(() => EditorView.theme({
    "&": {
      height: "100%",
      color: "var(--bytro-editor-fg)",
      backgroundColor: "var(--bytro-editor-bg)",
    },
    "&.cm-focused": {
      outline: "none",
    },
    ".cm-scroller": {
      overflow: "auto",
      fontFamily: `'${fontFamily}', Menlo, Monaco, 'Courier New', ui-monospace, monospace`,
      fontSize: `${codeMirrorFontSize}px`,
      lineHeight: `${Math.round(codeMirrorFontSize * 1.6)}px`,
      backgroundColor: "var(--bytro-editor-bg)",
    },
    ".cm-content": {
      padding: "10px 0 14px",
      caretColor: "var(--bytro-editor-cursor)",
    },
    ".cm-line": {
      padding: "0 24px 0 18px",
    },
    ".cm-gutters": {
      backgroundColor: "var(--bytro-editor-gutter-bg)",
      color: "var(--bytro-editor-line-number)",
      borderRight: "0",
    },
    ".cm-lineNumbers .cm-gutterElement": {
      minWidth: "54px",
      padding: "0 16px 0 12px",
      textAlign: "right",
    },
    ".cm-activeLineGutter": {
      color: "var(--bytro-editor-line-number-active)",
      backgroundColor: "var(--bytro-editor-line-highlight-bg)",
    },
    ".cm-activeLine": {
      backgroundColor: "var(--bytro-editor-line-highlight-bg)",
    },
    ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
      backgroundColor: "var(--bytro-editor-selection-bg)",
    },
  }, { dark: !isLightTheme }), [codeMirrorFontSize, fontFamily, isLightTheme]);

  const setHoveredHunkIndex = useCallback((index: number | null) => {
    hoveredHunkIndexRef.current = index;
    setHoveredHunkIndexState(index);
    if (index === null) setHoverActionsTop(null);
  }, []);

  const syncHunksFromView = useCallback((view: EditorView) => {
    const nextHunks = getCodeMirrorHunks(view);
    const nextKey = nextHunks.map((hunk) => `${hunk.from}:${hunk.to}:${hunk.modifiedLine}:${hunk.modifiedEndLine}`).join("|");
    hunksRef.current = nextHunks;
    if (nextKey !== hunksKeyRef.current) {
      hunksKeyRef.current = nextKey;
      setHunks(nextHunks);
      setActiveHunkIndex((index) => Math.min(index, Math.max(nextHunks.length - 1, 0)));
      const hoveredIndex = hoveredHunkIndexRef.current;
      if (hoveredIndex !== null) {
        setHoveredHunkIndex(Math.min(hoveredIndex, Math.max(nextHunks.length - 1, 0)));
      }
    }
    return nextHunks;
  }, [setHoveredHunkIndex]);

  const updateHoverActionsPosition = useCallback((index = hoveredHunkIndexRef.current) => {
    const view = diffViewRef.current;
    const overlayContainer = containerRef.current;
    const currentHunks = hunksRef.current;
    const hunk = index === null ? undefined : currentHunks[index];
    if (!view || !overlayContainer || !hunk) {
      setHoverActionsTop(null);
      return;
    }

    let nextIndex = index ?? -1;
    let nextTop = getVisibleCodeMirrorHunkActionsTop(view, hunk, overlayContainer);
    if (nextTop === null) {
      nextIndex = currentHunks.findIndex((visibleHunk) => (
        getVisibleCodeMirrorHunkActionsTop(view, visibleHunk, overlayContainer) !== null
      ));
      nextTop = nextIndex >= 0
        ? getVisibleCodeMirrorHunkActionsTop(view, currentHunks[nextIndex], overlayContainer)
        : null;
    }

    if (nextIndex >= 0 && nextIndex !== index) setHoveredHunkIndex(nextIndex);
    setHoverActionsTop(nextTop);
  }, [setHoveredHunkIndex]);

  const scheduleHoverActionsPositionUpdate = useCallback((index = hoveredHunkIndexRef.current) => {
    if (hoverPositionFrameRef.current !== null) window.cancelAnimationFrame(hoverPositionFrameRef.current);
    hoverPositionFrameRef.current = window.requestAnimationFrame(() => {
      hoverPositionFrameRef.current = null;
      updateHoverActionsPosition(index);
    });
  }, [updateHoverActionsPosition]);

  const scheduleHideHoverActions = useCallback(() => {
    if (hideHoverTimerRef.current !== null) window.clearTimeout(hideHoverTimerRef.current);
    hideHoverTimerRef.current = window.setTimeout(() => setHoveredHunkIndex(null), 120);
  }, [setHoveredHunkIndex]);

  const keepHoverActionsVisible = useCallback(() => {
    if (hideHoverTimerRef.current !== null) {
      window.clearTimeout(hideHoverTimerRef.current);
      hideHoverTimerRef.current = null;
    }
  }, []);

  const goToHunk = useCallback((index: number) => {
    const currentHunks = hunksRef.current.length > 0 ? hunksRef.current : hunks;
    if (currentHunks.length === 0) return;
    const normalizedIndex = (index + currentHunks.length) % currentHunks.length;
    const hunk = currentHunks[normalizedIndex];
    const view = diffViewRef.current;
    if (!view) return;

    setActiveHunkIndex(normalizedIndex);
    setHoveredHunkIndex(normalizedIndex);
    view.dispatch({
      selection: { anchor: hunk.from },
      effects: EditorView.scrollIntoView(hunk.from, { y: "center" }),
    });
    scheduleHoverActionsPositionUpdate(normalizedIndex);
  }, [hunks, scheduleHoverActionsPositionUpdate, setHoveredHunkIndex]);

  const handleUndo = useCallback(async () => {
    if (!canWriteBack || isUndoing) return;
    setIsUndoing(true);
    try {
      logEditorPath("undo write_file_content", {
        filePath,
        workspacePath,
        resolvedFilePath,
        pathCandidates,
      });
      await invoke("write_file_content", {
        path: resolvedFilePath,
        content: original,
      });
      useToastStore.getState().addToast("info", t("diff.undoFileSuccess"));
      onKeep();
    } catch (err) {
      useToastStore.getState().addToast("error", t("diff.undoFileError", { message: formatError(err) }));
    } finally {
      setIsUndoing(false);
    }
  }, [canWriteBack, filePath, isUndoing, onKeep, original, pathCandidates, resolvedFilePath, t, workspacePath]);

  useEffect(() => {
    setActiveHunkIndex(0);
    setHoveredHunkIndex(null);
    setHunks([]);
    hunksKeyRef.current = "";
    hunksRef.current = [];
  }, [original, modified, setHoveredHunkIndex]);

  useEffect(() => () => {
    if (hideHoverTimerRef.current !== null) window.clearTimeout(hideHoverTimerRef.current);
    if (hoverPositionFrameRef.current !== null) window.cancelAnimationFrame(hoverPositionFrameRef.current);
    hunksRef.current = [];
    hoveredHunkIndexRef.current = null;
    diffViewRef.current = null;
  }, []);

  const handleCodeMirrorCreate = useCallback((view: EditorView) => {
    diffViewRef.current = view;
    requestAnimationFrame(() => {
      const nextHunks = syncHunksFromView(view);
      if (nextHunks.length > 0) goToHunk(0);
    });
  }, [goToHunk, syncHunksFromView]);

  const handleCodeMirrorUpdate = useCallback((update: ViewUpdate) => {
    if (update.docChanged || update.viewportChanged || update.geometryChanged) {
      syncHunksFromView(update.view);
      scheduleHoverActionsPositionUpdate();
    }
  }, [scheduleHoverActionsPositionUpdate, syncHunksFromView]);

  const handleMouseMove = useCallback((event: MouseEvent<HTMLDivElement>) => {
    const view = diffViewRef.current;
    const container = containerRef.current;
    if (!view || !container) return;
    const position = view.posAtCoords({ x: event.clientX, y: event.clientY });
    if (position === null) return;
    const lineNumber = view.state.doc.lineAt(position).number;
    const currentHunks = hunksRef.current;
    const hunkIndex = findOverlayHunkIndexAtLine(currentHunks, lineNumber);
    if (hunkIndex < 0) return;
    keepHoverActionsVisible();
    setHoveredHunkIndex(hunkIndex);
    setHoverActionsTop(getVisibleCodeMirrorHunkActionsTop(view, currentHunks[hunkIndex], container));
  }, [keepHoverActionsVisible, setHoveredHunkIndex]);

  useEffect(() => {
    if (hunks.length > 0) requestAnimationFrame(() => goToHunk(activeHunkIndex));
  }, [activeHunkIndex, goToHunk, hunks.length]);

  const diffLanguageExtensions = useMemo(
    () => getCodeMirrorLanguageExtensions(filePath, modified.length > LARGE_FILE_THRESHOLD),
    [filePath, modified.length],
  );
  const activeHunkExtension = useMemo(
    () => createActiveCodeMirrorHunkExtension(hunks, activeHunkIndex),
    [activeHunkIndex, hunks],
  );
  const diffExtensions = useMemo(() => [
    ...diffLanguageExtensions,
    codeMirrorSyntaxHighlighting,
    codeMirrorDiffTheme,
    EditorState.readOnly.of(true),
    EditorView.editable.of(false),
    unifiedMergeView({
      original,
      mergeControls: false,
      gutter: true,
      allowInlineDiffs: true,
      diffConfig: { scanLimit: 1200, timeout: 500 },
      collapseUnchanged: { margin: 3, minSize: 10 },
    }),
    activeHunkExtension,
  ], [activeHunkExtension, codeMirrorDiffTheme, diffLanguageExtensions, original]);
  const diffBasicSetup = useMemo(() => ({
    lineNumbers: true,
    foldGutter: false,
    highlightActiveLine: false,
    highlightActiveLineGutter: true,
    highlightSelectionMatches: false,
    bracketMatching: false,
    closeBrackets: false,
    autocompletion: false,
    completionKeymap: false,
    searchKeymap: true,
  }), []);

  return (
    <div
      ref={containerRef}
      className="bytro-codemirror bytro-codemirror-diff relative h-full w-full"
      onMouseMove={handleMouseMove}
      onMouseLeave={scheduleHideHoverActions}
      onMouseEnter={keepHoverActionsVisible}
    >
      <CodeMirror
        key={filePath}
        value={modified}
        height="100%"
        className="bytro-codemirror-view"
        extensions={diffExtensions}
        basicSetup={diffBasicSetup}
        onCreateEditor={handleCodeMirrorCreate}
        onUpdate={handleCodeMirrorUpdate}
      />
      {hunks.length > 0 && hoveredHunkIndex !== null && hoverActionsTop !== null && (
        <div
          className="diff-quick-actions diff-hunk-actions"
          style={{ top: hoverActionsTop }}
          onMouseEnter={keepHoverActionsVisible}
          onMouseLeave={scheduleHideHoverActions}
        >
          <button className="diff-quick-action-btn" onClick={() => goToHunk(hoveredHunkIndex - 1)} title={t("diff.previousChange")}>
            <ChevronUp size={14} />
          </button>
          <span className="diff-quick-count">{t("diff.hunkCount", { current: hoveredHunkIndex + 1, total: hunks.length })}</span>
          <button className="diff-quick-action-btn" onClick={() => goToHunk(hoveredHunkIndex + 1)} title={t("diff.nextChange")}>
            <ChevronDown size={14} />
          </button>
          <button className="diff-quick-action-btn diff-quick-action-undo" onClick={handleUndo} disabled={!canWriteBack || isUndoing} title={canWriteBack ? t("diff.undoFile") : t("diff.undoUnavailable")}>
            <RotateCcw size={13} />
            <span>{isUndoing ? t("diff.undoing") : t("diff.undoFile")}</span>
          </button>
          <button className="diff-quick-action-btn diff-quick-action-keep" onClick={onKeep} title={t("diff.keepFile")}>
            <Check size={14} />
            <span>{t("diff.keepFile")}</span>
          </button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Markdown Preview
// ---------------------------------------------------------------------------

function PreviewCodeBlock({ language, children }: { language: string; children: ReactNode }) {
  return <CodeBlock language={language}>{children}</CodeBlock>;
}

function MarkdownPreview({ content }: { readonly content: string }) {
  return (
    <div
      className="flex-1 overflow-y-auto p-6"
      style={{ backgroundColor: "var(--color-surface-alt)" }}
    >
      <div className="max-w-[720px] mx-auto">
        <MarkdownRenderer content={content} variant="chat" codeBlock={PreviewCodeBlock} />
      </div>
    </div>
  );
}

function EditorBreadcrumb({
  filePath,
  workspacePath,
  isDirty = false,
}: {
  readonly filePath: string;
  readonly workspacePath: string | null | undefined;
  readonly isDirty?: boolean;
}) {
  const parts = getEditorBreadcrumbParts(filePath, workspacePath);
  const displayPath = getEditorDisplayPath(filePath, workspacePath);

  return (
    <div className="bytro-editor-breadcrumb" title={displayPath}>
      {parts.map((part, index) => {
        const isLast = index === parts.length - 1;
        return (
          <span className="bytro-editor-breadcrumb-group" key={`${part}-${index}`}>
            {index > 0 && <span className="bytro-editor-breadcrumb-separator">&gt;</span>}
            <span className={cn("bytro-editor-breadcrumb-part", isLast && "active")}>
              {isLast && isDirty && <span className="bytro-editor-dirty-dot">*</span>}
              {part}
            </span>
          </span>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// CodeEditor
// ---------------------------------------------------------------------------

interface CodeEditorProps {
  readonly filePath?: string | null;
  readonly diffMode?: EditorDiffMode | null;
}

export const CodeEditor = memo(function CodeEditor({ filePath, diffMode }: CodeEditorProps) {
  const { t } = useTranslation();
  const editorHostRef = useRef<HTMLDivElement>(null);
  const editorDiffMode = useAppStore((s) => s.editorDiffMode);
  const closeDiff = useAppStore((s) => s.closeDiff);
  const closeFileTab = useAppStore((s) => s.closeFileTab);
  const openedDiffTabs = useAppStore((s) => s.openedDiffTabs);
  const storeActiveDiff = filePath ? openedDiffTabs.get(filePath) : undefined;
  const activeDiff = diffMode ?? storeActiveDiff;
  // Single-file state keyed by filePath (tabs are managed by SessionTabBar)
  const [fileState, setFileState] = useState<FileState | null>(null);
  const savedContentRef = useRef("");
  const editorContentRef = useRef("");

  const [mdView, setMdView] = useState<"preview" | "source">("preview");
  const codeMirrorRef = useRef<ReactCodeMirrorRef | null>(null);
  const codeMirrorViewRef = useRef<EditorView | null>(null);
  const workspacePath = useWorkspaceStore((s) => s.activeWorkspace?.path ?? null);
  const fileDiffOverlays = useAppStore((s) => s.fileDiffOverlays);
  const clearFileDiffOverlay = useAppStore((s) => s.clearFileDiffOverlay);

  const themeCustomization = useSettingsStore((s) => s.themeCustomization);
  const isLightTheme = useIsLightTheme();
  const resolvedThemeSettings = themeCustomization[isLightTheme ? "light" : "dark"];
  const editorFontFamily = resolvedThemeSettings.codeFontFamily;
  const editorFontSize = themeCustomization.codeFontSize;
  const pathCandidates = useMemo(
    () => (filePath ? getWorkspaceFilePathCandidates(filePath, workspacePath) : []),
    [filePath, workspacePath],
  );
  const resolvedFilePath = pathCandidates[0] ?? null;
  const activeIsMd = filePath ? isMarkdownFile(filePath) : false;
  const activeIsImage = filePath ? isImageFile(filePath) : false;
  const fileDiffOverlay = filePath ? fileDiffOverlays.get(filePath) : undefined;
  const editorOverlayHunks = useMemo(
    () => (fileDiffOverlay ? buildEditorOverlayHunks(fileDiffOverlay.original, fileDiffOverlay.modified) : []),
    [fileDiffOverlay],
  );
  const showMdPreview = activeIsMd && mdView === "preview";
  const [activeOverlayHunkIndex, setActiveOverlayHunkIndex] = useState(0);
  const [isOverlayUndoing, setIsOverlayUndoing] = useState(false);
  const editorContextMenuRef = useRef<EditorContextMenuContext | null>(null);
  const [importLinkHover, setImportLinkHover] = useState<ImportLinkMatch | null>(null);
  const editorOverlayHunksRef = useRef<ReadonlyArray<EditorOverlayHunk>>([]);
  const hoveredOverlayHunkIndexRef = useRef<number | null>(null);
  const overlayHideHoverTimerRef = useRef<number | null>(null);
  const overlayHoverPositionFrameRef = useRef<number | null>(null);
  const [hoveredOverlayHunkIndex, setHoveredOverlayHunkIndexState] = useState<number | null>(null);
  const [overlayHoverActionsTop, setOverlayHoverActionsTop] = useState<number | null>(null);

  // Reset to preview mode when switching to a markdown file
  useEffect(() => {
    if (activeIsMd) {
      setMdView("preview");
    }
  }, [filePath, activeIsMd]);

  // Load file content when filePath changes (skip for diff tabs and image files)
  useEffect(() => {
    if (!filePath || activeDiff) {
      if (!filePath) {
        savedContentRef.current = "";
        editorContentRef.current = "";
        setFileState(null);
      }
      return;
    }
    if (!resolvedFilePath) return;
    if (isLoadedFileStateForPath(fileState, filePath)) return;
    // Image files are rendered directly via asset protocol, no text loading needed
    if (isImageFile(filePath)) {
      savedContentRef.current = "";
      editorContentRef.current = "";
      setFileState({ path: filePath, content: "", isDirty: false, isLargeFile: false });
      return;
    }

    // Clear stale content immediately so the Editor won't mount with the
    // previous file's content while the new file is loading.
    setFileState(null);

    let cancelled = false;
    logEditorPath("open read_file_content", {
      filePath,
      workspacePath,
      resolvedFilePath,
      pathCandidates,
    });
    invoke<string>("read_file_content", { path: resolvedFilePath })
      .then((content) => {
        if (cancelled) return;
        const isLargeFile = content.length > LARGE_FILE_THRESHOLD;
        savedContentRef.current = content;
        editorContentRef.current = content;
        setFileState({ path: filePath, content, isDirty: false, isLargeFile });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const msg = formatError(err);
        useToastStore.getState().addToast("error", `Failed to open file: ${msg}`);
      });
    return () => { cancelled = true; };
  }, [activeDiff, filePath, fileState, pathCandidates, resolvedFilePath, workspacePath]);

  const handleSave = useCallback(async () => {
    if (!filePath || !resolvedFilePath) return;
    const content = editorContentRef.current;
    try {
      logEditorPath("save write_file_content", {
        filePath,
        workspacePath,
        resolvedFilePath,
        pathCandidates,
      });
      await invoke("write_file_content", { path: resolvedFilePath, content });
      savedContentRef.current = content;
      editorContentRef.current = content;
      setFileState((prev) => ({
        path: filePath,
        content,
        isDirty: false,
        isLargeFile: prev?.path === filePath ? prev.isLargeFile : content.length > LARGE_FILE_THRESHOLD,
      }));
    } catch {
      // Save failed
    }
  }, [filePath, pathCandidates, resolvedFilePath, workspacePath]);
  const handleSaveRef = useRef(handleSave);
  handleSaveRef.current = handleSave;

  const setHoveredOverlayHunkIndex = useCallback((index: number | null) => {
    hoveredOverlayHunkIndexRef.current = index;
    setHoveredOverlayHunkIndexState(index);
    if (index === null) setOverlayHoverActionsTop(null);
  }, []);

  const updateOverlayHoverActionsPosition = useCallback((index = hoveredOverlayHunkIndexRef.current) => {
    const view = codeMirrorViewRef.current;
    const overlayContainer = editorHostRef.current;
    const currentHunks = editorOverlayHunksRef.current;
    const hunk = index === null ? undefined : currentHunks[index];
    if (!view || !overlayContainer || !hunk) {
      setOverlayHoverActionsTop(null);
      return;
    }

    let nextIndex = index ?? -1;
    let nextTop = getVisibleCodeMirrorHunkActionsTop(view, hunk, overlayContainer);
    if (nextTop === null) {
      nextIndex = currentHunks.findIndex((visibleHunk) => (
        getVisibleCodeMirrorHunkActionsTop(view, visibleHunk, overlayContainer) !== null
      ));
      nextTop = nextIndex >= 0
        ? getVisibleCodeMirrorHunkActionsTop(view, currentHunks[nextIndex], overlayContainer)
        : null;
    }

    if (nextIndex >= 0 && nextIndex !== index) setHoveredOverlayHunkIndex(nextIndex);
    setOverlayHoverActionsTop(nextTop);
  }, [setHoveredOverlayHunkIndex]);

  const scheduleOverlayHoverActionsPositionUpdate = useCallback((index = hoveredOverlayHunkIndexRef.current) => {
    if (overlayHoverPositionFrameRef.current !== null) window.cancelAnimationFrame(overlayHoverPositionFrameRef.current);
    overlayHoverPositionFrameRef.current = window.requestAnimationFrame(() => {
      overlayHoverPositionFrameRef.current = null;
      updateOverlayHoverActionsPosition(index);
    });
  }, [updateOverlayHoverActionsPosition]);

  const scheduleHideOverlayHoverActions = useCallback(() => {
    if (overlayHideHoverTimerRef.current !== null) window.clearTimeout(overlayHideHoverTimerRef.current);
    overlayHideHoverTimerRef.current = window.setTimeout(() => setHoveredOverlayHunkIndex(null), 120);
  }, [setHoveredOverlayHunkIndex]);

  const keepOverlayHoverActionsVisible = useCallback(() => {
    if (overlayHideHoverTimerRef.current !== null) {
      window.clearTimeout(overlayHideHoverTimerRef.current);
      overlayHideHoverTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    editorOverlayHunksRef.current = editorOverlayHunks;
    setActiveOverlayHunkIndex(0);
    setHoveredOverlayHunkIndex(null);
  }, [editorOverlayHunks, fileDiffOverlay, setHoveredOverlayHunkIndex]);

  const revealOverlayHunk = useCallback((index: number) => {
    if (editorOverlayHunks.length === 0) return;
    const normalizedIndex = (index + editorOverlayHunks.length) % editorOverlayHunks.length;
    const hunk = editorOverlayHunks[normalizedIndex];
    const view = codeMirrorViewRef.current;
    setActiveOverlayHunkIndex(normalizedIndex);
    setHoveredOverlayHunkIndex(normalizedIndex);
    if (view && hunk.modifiedLine >= 1 && hunk.modifiedLine <= view.state.doc.lines) {
      const position = view.state.doc.line(hunk.modifiedLine).from;
      view.dispatch({
        selection: { anchor: position },
        effects: EditorView.scrollIntoView(position, { y: "center" }),
      });
    }
    scheduleOverlayHoverActionsPositionUpdate(normalizedIndex);
  }, [editorOverlayHunks, scheduleOverlayHoverActionsPositionUpdate, setHoveredOverlayHunkIndex]);

  const handleKeepFileDiffOverlay = useCallback(() => {
    if (!filePath) return;
    logEditorPath("keep file overlay", {
      filePath,
      workspacePath,
      resolvedFilePath,
      hunks: editorOverlayHunks.length,
    });
    setHoveredOverlayHunkIndex(null);
    clearFileDiffOverlay(filePath);
  }, [clearFileDiffOverlay, editorOverlayHunks.length, filePath, resolvedFilePath, setHoveredOverlayHunkIndex, workspacePath]);

  const handleUndoFileDiffOverlay = useCallback(async () => {
    if (!fileDiffOverlay || !filePath || !resolvedFilePath || isOverlayUndoing) return;
    setIsOverlayUndoing(true);
    try {
      logEditorPath("undo file overlay", {
        filePath,
        workspacePath,
        resolvedFilePath,
        relativePath: fileDiffOverlay.relativePath,
      });
      await invoke("write_file_content", {
        path: resolvedFilePath,
        content: fileDiffOverlay.original,
      });
      savedContentRef.current = fileDiffOverlay.original;
      editorContentRef.current = fileDiffOverlay.original;
      setFileState({
        path: filePath,
        content: fileDiffOverlay.original,
        isDirty: false,
        isLargeFile: fileDiffOverlay.original.length > LARGE_FILE_THRESHOLD,
      });
      setHoveredOverlayHunkIndex(null);
      clearFileDiffOverlay(filePath);
      useToastStore.getState().addToast("info", t("diff.undoFileSuccess"));
    } catch (err) {
      useToastStore.getState().addToast("error", t("diff.undoFileError", { message: formatError(err) }));
    } finally {
      setIsOverlayUndoing(false);
    }
  }, [
    clearFileDiffOverlay,
    fileDiffOverlay,
    filePath,
    isOverlayUndoing,
    resolvedFilePath,
    setHoveredOverlayHunkIndex,
    t,
    workspacePath,
  ]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        handleSave();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleSave]);

  const handleCodeMirrorChange = useCallback((value: string) => {
    editorContentRef.current = value;
    setFileState((prev) =>
      prev && prev.path === filePath
        ? {
            ...prev,
            content: value,
            isDirty: savedContentRef.current !== value,
            isLargeFile: prev.isLargeFile || value.length > LARGE_FILE_THRESHOLD,
          }
        : prev,
    );
  }, [filePath]);

  const handleFileCodeMirrorCreate = useCallback((view: EditorView) => {
    codeMirrorViewRef.current = view;
    requestAnimationFrame(() => {
      if (editorOverlayHunksRef.current.length > 0) {
        scheduleOverlayHoverActionsPositionUpdate(0);
      }
    });
  }, [scheduleOverlayHoverActionsPositionUpdate]);

  const handleFileCodeMirrorUpdate = useCallback((update: ViewUpdate) => {
    if (update.docChanged) {
      setImportLinkHover(null);
      editorContextMenuRef.current = null;
    }
    if (update.viewportChanged || update.geometryChanged) {
      scheduleOverlayHoverActionsPositionUpdate();
    }
  }, [scheduleOverlayHoverActionsPositionUpdate]);

  const setNextImportLinkHover = useCallback((nextImportLink: ImportLinkMatch | null) => {
    setImportLinkHover((prevImportLink) => (
      areImportLinksEqual(prevImportLink, nextImportLink) ? prevImportLink : nextImportLink
    ));
  }, []);

  const getImportLinkFromMouseEvent = useCallback((event: MouseEvent<HTMLDivElement>): ImportLinkMatch | null => {
    const view = codeMirrorViewRef.current;
    if (!filePath || !view || !view.dom.contains(event.target as Node)) return null;
    const position = view.posAtCoords({ x: event.clientX, y: event.clientY });
    return position === null ? null : getImportLinkAtPosition(view, position);
  }, [filePath]);

  const handleFileEditorMouseDown = useCallback((event: MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0 || (!event.metaKey && !event.ctrlKey) || !filePath) return;
    const importLink = getImportLinkFromMouseEvent(event);
    if (!importLink) return;
    event.preventDefault();
    event.stopPropagation();
    resolveImportPath(filePath, importLink.specifier).then((targetPath) => {
      if (targetPath) useAppStore.getState().openFile(targetPath);
    }).catch(() => {});
  }, [filePath, getImportLinkFromMouseEvent]);

  const handleGoToDefinition = useCallback((context = editorContextMenuRef.current) => {
    if (!filePath || !context?.importLink) return;
    const { specifier } = context.importLink;
    editorContextMenuRef.current = null;
    resolveImportPath(filePath, specifier).then((targetPath) => {
      if (targetPath) {
        useAppStore.getState().openFile(targetPath);
      } else {
        useToastStore.getState().addToast("info", `Unable to resolve ${specifier}`);
      }
    }).catch(() => {});
  }, [filePath]);

  const handleAddSelectionToCurrentChat = useCallback(() => {
    const view = codeMirrorViewRef.current;
    if (!filePath || !view) return;
    const snippet = buildSelectionSnippet(view, filePath);
    if (!snippet) return;
    dispatchAddToCurrentChat(snippet);
    editorContextMenuRef.current = null;
    useToastStore.getState().addToast("info", t("editor.contextMenu.addedToCurrentChat"));
  }, [filePath, t]);

  const handleAddSelectionToNewChat = useCallback(async () => {
    const view = codeMirrorViewRef.current;
    if (!filePath || !view) return;
    const snippet = buildSelectionSnippet(view, filePath);
    if (!snippet) return;
    editorContextMenuRef.current = null;
    await addToNewChat(snippet);
  }, [filePath]);

  const handleCopySelection = useCallback(async () => {
    const view = codeMirrorViewRef.current;
    if (!view) return;
    const text = getSelectedCodeMirrorText(view);
    if (!text) return;
    try {
      editorContextMenuRef.current = null;
      await writeClipboardText(text);
    } catch {
      useToastStore.getState().addToast("error", "Unable to copy selection");
    }
  }, []);

  const handleCutSelection = useCallback(async () => {
    const view = codeMirrorViewRef.current;
    if (!view) return;
    const selection = view.state.selection.main;
    const text = getSelectedCodeMirrorText(view);
    if (selection.empty || !text) return;
    try {
      editorContextMenuRef.current = null;
      await writeClipboardText(text);
      replaceEditorRange(view, selection.from, selection.to, "");
    } catch {
      useToastStore.getState().addToast("error", "Unable to cut selection");
    }
  }, []);

  const handlePasteText = useCallback(async () => {
    const view = codeMirrorViewRef.current;
    if (!view) return;
    try {
      const text = await readClipboardText();
      if (!text) return;
      const selection = view.state.selection.main;
      editorContextMenuRef.current = null;
      replaceEditorRange(view, selection.from, selection.to, text);
    } catch {
      useToastStore.getState().addToast("error", "Unable to paste from clipboard");
    }
  }, []);

  const handleSelectAll = useCallback(() => {
    const view = codeMirrorViewRef.current;
    if (!view) return;
    editorContextMenuRef.current = null;
    view.dispatch({
      selection: { anchor: 0, head: view.state.doc.length },
      scrollIntoView: true,
    });
    view.focus();
  }, []);

  const handleChangeAllOccurrences = useCallback(() => {
    const view = codeMirrorViewRef.current;
    if (!view) return;
    const selectedText = getSelectedCodeMirrorText(view);
    if (!selectedText) return;
    const docText = view.state.doc.toString();
    const ranges = [];
    let index = docText.indexOf(selectedText);
    while (index >= 0 && ranges.length < 1000) {
      ranges.push(EditorSelection.range(index, index + selectedText.length));
      index = docText.indexOf(selectedText, index + selectedText.length);
    }
    if (ranges.length === 0) return;
    editorContextMenuRef.current = null;
    view.dispatch({
      selection: EditorSelection.create(ranges, 0),
      scrollIntoView: true,
    });
    view.focus();
  }, []);

  const handleFormatDocument = useCallback(async () => {
    const view = codeMirrorViewRef.current;
    if (!filePath || !view || !isFormattingSupported(filePath)) return;
    try {
      const formatted = await formatWithPrettier(filePath, view.state.doc.toString());
      if (formatted === null) return;
      editorContextMenuRef.current = null;
      replaceEditorRange(view, 0, view.state.doc.length, formatted);
    } catch (err) {
      useToastStore.getState().addToast("error", `Unable to format document: ${formatError(err)}`);
    }
  }, [filePath]);

  const handleFormatSelection = useCallback(async () => {
    const view = codeMirrorViewRef.current;
    if (!filePath || !view || !isFormattingSupported(filePath)) return;
    const selection = view.state.selection.main;
    const selectedText = getSelectedCodeMirrorText(view);
    if (selection.empty || !selectedText) return;
    try {
      const formatted = await formatWithPrettier(filePath, selectedText);
      if (formatted === null) return;
      editorContextMenuRef.current = null;
      replaceEditorRange(view, selection.from, selection.to, formatted);
    } catch (err) {
      useToastStore.getState().addToast("error", `Unable to format selection: ${formatError(err)}`);
    }
  }, [filePath]);

  const handleOpenCommandPalette = useCallback(() => {
    editorContextMenuRef.current = null;
    useAppStore.getState().setGlobalSearchOpen(true);
  }, []);

  const handleFileEditorContextMenu = useCallback(async (event: MouseEvent<HTMLDivElement>) => {
    const view = codeMirrorViewRef.current;
    if (!filePath || !view || !view.dom.contains(event.target as Node)) return;

    event.preventDefault();
    const position = view.posAtCoords({ x: event.clientX, y: event.clientY });
    const context: EditorContextMenuContext = {
      importLink: position === null ? null : getImportLinkAtPosition(view, position),
      hasSelection: getSelectedCodeMirrorText(view).length > 0,
      hasChatSnippet: Boolean(buildSelectionSnippet(view, filePath)),
      canFormat: isFormattingSupported(filePath),
    };
    editorContextMenuRef.current = context;

    const separator = nativeMenuSeparator();
    const disabled = (text: string, accelerator?: string): NativeContextMenuItem => ({
      text,
      accelerator,
      enabled: false,
    });
    const items: NativeContextMenuItem[] = [
      createNativeContextMenuItem("bytro-editor-go-to-definition", "Go to Definition", () => handleGoToDefinition(context), { accelerator: "F12", enabled: Boolean(context.importLink) }),
      disabled("Go to Type Definition"),
      disabled("Go to Source Definition"),
      disabled("Go to Implementations", "CmdOrCtrl+F12"),
      disabled("Go to References", "Shift+F12"),
      separator,
      createNativeContextMenuItem("bytro-editor-add-symbol-current-chat", t("editor.contextMenu.addSymbolToCurrentChat"), () => handleAddSelectionToCurrentChat(), { enabled: context.hasChatSnippet }),
      createNativeContextMenuItem("bytro-editor-add-symbol-new-chat", t("editor.contextMenu.addSymbolToNewChat"), () => handleAddSelectionToNewChat(), { enabled: context.hasChatSnippet }),
      disabled("Create Rule"),
      disabled("Peek"),
      separator,
      disabled("Find All References", "Alt+Shift+F12"),
      disabled("Find All Implementations"),
      disabled("Show Call Hierarchy", "Alt+Shift+H"),
      separator,
      disabled("Rename Symbol", "F2"),
      createNativeContextMenuItem("bytro-editor-change-all-occurrences", "Change All Occurrences", () => handleChangeAllOccurrences(), { accelerator: "CmdOrCtrl+F2", enabled: context.hasSelection }),
      createNativeContextMenuItem("bytro-editor-format-document", "Format Document", () => handleFormatDocument(), { accelerator: "Alt+Shift+F", enabled: context.canFormat }),
      createNativeContextMenuItem("bytro-editor-format-selection", "Format Selection [⌘K ⌘F]", () => handleFormatSelection(), { enabled: context.hasSelection && context.canFormat }),
      disabled("Refactor...", "Ctrl+Shift+R"),
      disabled("Source Action..."),
      separator,
      createNativeContextMenuItem("bytro-editor-cut", "Cut", () => handleCutSelection(), { accelerator: "CmdOrCtrl+X", enabled: context.hasSelection }),
      createNativeContextMenuItem("bytro-editor-copy", "Copy", () => handleCopySelection(), { accelerator: "CmdOrCtrl+C", enabled: context.hasSelection }),
      createNativeContextMenuItem("bytro-editor-paste", "Paste", () => handlePasteText(), { accelerator: "CmdOrCtrl+V" }),
      createNativeContextMenuItem("bytro-editor-select-all", "Select All", () => handleSelectAll(), { accelerator: "CmdOrCtrl+A" }),
      separator,
      createNativeContextMenuItem("bytro-editor-command-palette", "Command Palette...", () => handleOpenCommandPalette(), { accelerator: "Shift+CmdOrCtrl+P" }),
    ];

    try {
      await popupNativeContextMenu(EDITOR_CONTEXT_MENU_ID, items, event.clientX, event.clientY);
    } catch (err) {
      useToastStore.getState().addToast("error", `Unable to open editor menu: ${formatError(err)}`);
    }
  }, [
    filePath,
    handleAddSelectionToCurrentChat,
    handleAddSelectionToNewChat,
    handleChangeAllOccurrences,
    handleCopySelection,
    handleCutSelection,
    handleFormatDocument,
    handleFormatSelection,
    handleGoToDefinition,
    handleOpenCommandPalette,
    handlePasteText,
    handleSelectAll,
    t,
  ]);

  const handleFileEditorMouseMove = useCallback((event: MouseEvent<HTMLDivElement>) => {
    const view = codeMirrorViewRef.current;
    const container = editorHostRef.current;
    if (!view || !container || !view.dom.contains(event.target as Node)) {
      setNextImportLinkHover(null);
      return;
    }
    const position = view.posAtCoords({ x: event.clientX, y: event.clientY });
    const nextImportLink = position !== null && (event.metaKey || event.ctrlKey)
      ? getImportLinkAtPosition(view, position)
      : null;
    setNextImportLinkHover(nextImportLink);

    if (!fileDiffOverlay || activeDiff || activeIsImage || showMdPreview || editorOverlayHunksRef.current.length === 0) {
      return;
    }
    if (position === null) return;
    const lineNumber = view.state.doc.lineAt(position).number;
    const currentHunks = editorOverlayHunksRef.current;
    const hunkIndex = findOverlayHunkIndexAtLine(currentHunks, lineNumber);
    if (hunkIndex < 0) {
      scheduleHideOverlayHoverActions();
      return;
    }

    keepOverlayHoverActionsVisible();
    setHoveredOverlayHunkIndex(hunkIndex);
    setOverlayHoverActionsTop(getVisibleCodeMirrorHunkActionsTop(view, currentHunks[hunkIndex], container));
  }, [
    activeDiff,
    activeIsImage,
    fileDiffOverlay,
    keepOverlayHoverActionsVisible,
    scheduleHideOverlayHoverActions,
    setNextImportLinkHover,
    setHoveredOverlayHunkIndex,
    showMdPreview,
  ]);

  const handleFileEditorMouseLeave = useCallback(() => {
    setNextImportLinkHover(null);
    scheduleHideOverlayHoverActions();
  }, [scheduleHideOverlayHoverActions, setNextImportLinkHover]);

  useEffect(() => {
    return () => {
      if (overlayHideHoverTimerRef.current !== null) window.clearTimeout(overlayHideHoverTimerRef.current);
      if (overlayHoverPositionFrameRef.current !== null) window.cancelAnimationFrame(overlayHoverPositionFrameRef.current);
    };
  }, []);

  useEffect(() => {
    editorContextMenuRef.current = null;
    setImportLinkHover(null);
  }, [filePath, showMdPreview]);

  const loadedFileState = isLoadedFileStateForPath(fileState, filePath) ? fileState : null;
  const loadedIsLargeFile = loadedFileState?.isLargeFile ?? false;
  const editorCodeFontFamily = useMemo(() => {
    const preferred = editorFontFamily.trim();
    const fallback = "Menlo, Monaco, 'Courier New', ui-monospace, monospace";
    return preferred ? `'${preferred}', ${fallback}` : fallback;
  }, [editorFontFamily]);
  const codeMirrorFontSize = Math.max(12, editorFontSize - 1);
  const codeMirrorTheme = useMemo<Extension>(() => EditorView.theme({
    "&": {
      height: "100%",
      color: "var(--bytro-editor-fg)",
      backgroundColor: "var(--bytro-editor-bg)",
    },
    "&.cm-focused": {
      outline: "none",
    },
    ".cm-scroller": {
      overflow: "auto",
      fontFamily: editorCodeFontFamily,
      fontSize: `${codeMirrorFontSize}px`,
      lineHeight: `${Math.round(codeMirrorFontSize * 1.6)}px`,
      backgroundColor: "var(--bytro-editor-bg)",
    },
    ".cm-content": {
      padding: "10px 0 14px",
      caretColor: "var(--bytro-editor-cursor)",
    },
    ".cm-line": {
      padding: "0 24px 0 18px",
    },
    ".cm-gutters": {
      backgroundColor: "var(--bytro-editor-gutter-bg)",
      color: "var(--bytro-editor-line-number)",
      borderRight: "0",
    },
    ".cm-lineNumbers .cm-gutterElement": {
      minWidth: "54px",
      padding: "0 16px 0 12px",
      textAlign: "right",
    },
    ".cm-activeLineGutter": {
      color: "var(--bytro-editor-line-number-active)",
      backgroundColor: "var(--bytro-editor-line-highlight-bg)",
    },
    ".cm-activeLine": {
      backgroundColor: "var(--bytro-editor-line-highlight-bg)",
    },
    ".cm-cursor": {
      borderLeftColor: "var(--bytro-editor-cursor)",
    },
    ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
      backgroundColor: "var(--bytro-editor-selection-bg)",
    },
    ".cm-tooltip, .cm-tooltip-autocomplete": {
      color: "var(--bytro-editor-widget-fg)",
      backgroundColor: "var(--bytro-editor-widget-bg)",
      border: "1px solid var(--bytro-editor-widget-border)",
      boxShadow: "none",
    },
    ".cm-tooltip-autocomplete ul li[aria-selected]": {
      backgroundColor: "var(--bytro-editor-widget-row-active-bg)",
      color: "var(--bytro-editor-widget-fg)",
    },
  }, { dark: !isLightTheme }), [codeMirrorFontSize, editorCodeFontFamily, isLightTheme]);

  const codeMirrorLanguageExtensions = useMemo(
    () => (filePath ? getCodeMirrorLanguageExtensions(filePath, loadedIsLargeFile) : []),
    [filePath, loadedIsLargeFile],
  );
  const codeMirrorSaveKeymap = useMemo(() => keymap.of([{
    key: "Mod-s",
    run: () => {
      handleSaveRef.current();
      return true;
    },
  }, {
    key: "Alt-Shift-f",
    run: () => {
      handleFormatDocument();
      return true;
    },
  }]), [handleFormatDocument]);
  const codeMirrorImportLinkHoverExtension = useMemo(
    () => createImportLinkHoverExtension(importLinkHover),
    [importLinkHover],
  );
  const codeMirrorDiffOverlayExtensions = useMemo<Extension[]>(() => {
    if (!fileDiffOverlay || activeDiff || activeIsImage || showMdPreview) return [];
    return [
      unifiedMergeView({
        original: fileDiffOverlay.original,
        mergeControls: false,
        gutter: true,
        allowInlineDiffs: true,
        syntaxHighlightDeletions: !loadedIsLargeFile,
        diffConfig: { scanLimit: 1200, timeout: 500 },
      }),
      createActiveCodeMirrorHunkExtension(editorOverlayHunks, activeOverlayHunkIndex),
    ];
  }, [
    activeDiff,
    activeIsImage,
    activeOverlayHunkIndex,
    editorOverlayHunks,
    fileDiffOverlay,
    loadedIsLargeFile,
    showMdPreview,
  ]);
  const codeMirrorExtensions = useMemo(
    () => [...codeMirrorLanguageExtensions, codeMirrorSyntaxHighlighting, codeMirrorImportLinkHoverExtension, ...codeMirrorDiffOverlayExtensions, codeMirrorTheme, codeMirrorSaveKeymap],
    [codeMirrorDiffOverlayExtensions, codeMirrorImportLinkHoverExtension, codeMirrorLanguageExtensions, codeMirrorSaveKeymap, codeMirrorTheme],
  );
  const codeMirrorBasicSetup = useMemo(() => ({
    lineNumbers: true,
    foldGutter: false,
    highlightActiveLine: false,
    highlightActiveLineGutter: true,
    highlightSelectionMatches: false,
    bracketMatching: !loadedIsLargeFile,
    closeBrackets: !loadedIsLargeFile,
    autocompletion: !loadedIsLargeFile,
    completionKeymap: !loadedIsLargeFile,
    searchKeymap: true,
  }), [loadedIsLargeFile]);

  // Diff rendering — tab-mode (activeDiff) takes priority over full-screen (editorDiffMode)
  const diffToRender = activeDiff ?? editorDiffMode ?? null;
  if (diffToRender) {
    const isFullScreenDiff = !activeDiff && !!editorDiffMode;
    const handleKeepDiff = () => {
      logEditorPath("keep diff", {
        filePath: diffToRender.filePath,
        isFullScreenDiff,
        hasStoreActiveDiff: !!storeActiveDiff,
        hasPropDiffMode: !!diffMode,
      });
      if (isFullScreenDiff) {
        closeDiff();
      } else if (storeActiveDiff) {
        closeFileTab(diffToRender.filePath);
      } else {
        useSplitViewStore.getState().closeContent(
          { type: "diff", path: diffToRender.filePath, diff: diffToRender },
          useConversationStore.getState().activeConversationId,
        );
      }
    };
    return (
      <div className="bytro-editor-shell">
        <div className="bytro-editor-toolbar">
          <span className="bytro-editor-mode-badge">DIFF</span>
          <EditorBreadcrumb filePath={diffToRender.filePath} workspacePath={workspacePath} />
          <span className="flex-1" />
          {isFullScreenDiff && (
            <button
              onClick={closeDiff}
              className="bytro-editor-toolbar-button"
              title="Close diff"
            >
              <X size={14} />
            </button>
          )}
        </div>
        <DiffView
          filePath={diffToRender.filePath}
          original={diffToRender.original}
          modified={diffToRender.modified}
          fontFamily={editorFontFamily}
          fontSize={editorFontSize}
          canWriteBack={diffToRender.canWriteBack}
          onKeep={handleKeepDiff}
        />
      </div>
    );
  }

  if (!filePath || !loadedFileState) {
    return (
      <div className="bytro-editor-empty">
        {filePath ? t("chat.loading") : "Open a file from the explorer to start editing"}
      </div>
    );
  }

  // Image files get a dedicated preview
  if (activeIsImage) {
    return (
      <div className="bytro-editor-shell">
        <div className="bytro-editor-toolbar">
          <EditorBreadcrumb filePath={filePath} workspacePath={workspacePath} />
        </div>
        <ImagePreview filePath={filePath} resolvedFilePath={resolvedFilePath ?? filePath} />
      </div>
    );
  }

  return (
    <div className="bytro-editor-shell">
      <div className="bytro-editor-toolbar">
        <EditorBreadcrumb filePath={filePath} workspacePath={workspacePath} isDirty={loadedFileState.isDirty} />
        <div className="bytro-editor-toolbar-actions">
          {activeIsMd && (
            <button
              onClick={() => setMdView(mdView === "preview" ? "source" : "preview")}
              className={cn(
                "bytro-editor-toolbar-button",
                mdView === "preview"
                  ? "active"
                  : "",
              )}
              title={mdView === "preview" ? "Show source" : "Show preview"}
            >
              {mdView === "preview" ? <Code size={12} /> : <BookOpen size={12} />}
            </button>
          )}
        </div>
      </div>

      {fileDiffOverlay && editorOverlayHunks.length > 0 && (
        <div className="git-diff-file-toolbar">
          <span className="git-diff-file-badge">GIT DIFF</span>
          <span className="git-diff-file-title">
            {fileDiffOverlay.relativePath ?? getFileName(fileDiffOverlay.filePath)}
          </span>
          <span className="git-diff-file-stats">
            {editorOverlayHunks.length} 块
          </span>
          <span className="git-diff-file-spacer" />
          <button
            className="diff-quick-action-btn"
            onClick={() => revealOverlayHunk(activeOverlayHunkIndex - 1)}
            title={t("diff.previousChange")}
          >
            <ChevronUp size={14} />
          </button>
          <span className="diff-quick-count">
            {t("diff.hunkCount", { current: activeOverlayHunkIndex + 1, total: editorOverlayHunks.length })}
          </span>
          <button
            className="diff-quick-action-btn"
            onClick={() => revealOverlayHunk(activeOverlayHunkIndex + 1)}
            title={t("diff.nextChange")}
          >
            <ChevronDown size={14} />
          </button>
          <button
            className="diff-quick-action-btn diff-quick-action-undo"
            onClick={handleUndoFileDiffOverlay}
            disabled={!fileDiffOverlay.canWriteBack || isOverlayUndoing}
            title={fileDiffOverlay.canWriteBack ? t("diff.undoFile") : t("diff.undoUnavailable")}
          >
            <RotateCcw size={13} />
            <span>{isOverlayUndoing ? t("diff.undoing") : t("diff.undoFile")}</span>
          </button>
          <button
            className="diff-quick-action-btn diff-quick-action-keep"
            onClick={handleKeepFileDiffOverlay}
            title={t("diff.keepFile")}
          >
            <Check size={14} />
            <span>{t("diff.keepFile")}</span>
          </button>
        </div>
      )}

      {showMdPreview && (
        <MarkdownPreview content={loadedFileState.content} />
      )}

      {!showMdPreview && (
        <div
          ref={editorHostRef}
          className={cn(
            "relative flex-1 min-h-0",
            "bytro-codemirror",
            importLinkHover && "codemirror-import-link-active",
          )}
          onMouseEnter={keepOverlayHoverActionsVisible}
          onMouseLeave={handleFileEditorMouseLeave}
          onMouseMove={handleFileEditorMouseMove}
          onMouseDown={handleFileEditorMouseDown}
          onContextMenu={handleFileEditorContextMenu}
        >
          <CodeMirror
            key={filePath}
            ref={codeMirrorRef}
            value={loadedFileState.content}
            height="100%"
            className="bytro-codemirror-view"
            extensions={codeMirrorExtensions}
            onChange={handleCodeMirrorChange}
            basicSetup={codeMirrorBasicSetup}
            onCreateEditor={handleFileCodeMirrorCreate}
            onUpdate={handleFileCodeMirrorUpdate}
          />
          {fileDiffOverlay && editorOverlayHunks.length > 0 && hoveredOverlayHunkIndex !== null && overlayHoverActionsTop !== null && (
            <div
              className="diff-quick-actions diff-hunk-actions"
              style={{ top: overlayHoverActionsTop }}
              onMouseEnter={keepOverlayHoverActionsVisible}
              onMouseLeave={scheduleHideOverlayHoverActions}
            >
              <button
                className="diff-quick-action-btn"
                onClick={() => revealOverlayHunk(hoveredOverlayHunkIndex - 1)}
                title={t("diff.previousChange")}
              >
                <ChevronUp size={14} />
              </button>
              <span className="diff-quick-count">
                {t("diff.hunkCount", { current: hoveredOverlayHunkIndex + 1, total: editorOverlayHunks.length })}
              </span>
              <button
                className="diff-quick-action-btn"
                onClick={() => revealOverlayHunk(hoveredOverlayHunkIndex + 1)}
                title={t("diff.nextChange")}
              >
                <ChevronDown size={14} />
              </button>
              <button
                className="diff-quick-action-btn diff-quick-action-undo"
                onClick={handleUndoFileDiffOverlay}
                disabled={!fileDiffOverlay.canWriteBack || isOverlayUndoing}
                title={fileDiffOverlay.canWriteBack ? t("diff.undoFile") : t("diff.undoUnavailable")}
              >
                <RotateCcw size={13} />
                <span>{isOverlayUndoing ? t("diff.undoing") : t("diff.undoFile")}</span>
              </button>
              <button
                className="diff-quick-action-btn diff-quick-action-keep"
                onClick={handleKeepFileDiffOverlay}
                title={t("diff.keepFile")}
              >
                <Check size={14} />
                <span>{t("diff.keepFile")}</span>
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
});
