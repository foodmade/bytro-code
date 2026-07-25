#!/usr/bin/env node

const { execFileSync } = require("child_process");

const blockedFiles = [
  /(^|\/)\.env(?!\.example$)(?:\.[^/]+)?$/,
  /(^|\/)\.dev\.vars(?!\.example$)(?:\.[^/]+)?$/,
  /(^|\/)\.wrangler(?:\/|$)/,
  /(^|\/)\.(?:claude|codex|gemini|mcp)(?:\/|\.json$)/,
  /\.(?:db|sqlite|sqlite3|pem|p12|pfx|key)$/i,
  /(^|\/)(?:id_rsa|id_ed25519)(?:\.pub)?$/i,
];

const blockedPatterns = [
  /R2_SECRET_ACCESS_KEY\s*=\s*\S+/,
  /R2_ACCESS_KEY_ID\s*=\s*\S+/,
  /BYTRO_DEPLOY_API_KEY\s*=\s*\S+/,
  /CF_API_TOKEN\s*=\s*\S+/,
  /SUPABASE_(?:SERVICE_ROLE|ANON)_KEY\s*=\s*\S+/,
  /(?:sk|rk)_(?:live|test)_[A-Za-z0-9]+/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bAIza[0-9A-Za-z_-]{30,}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}\b/,
];

const secretAssignment =
  /(?:api[_-]?key|access[_-]?key|secret|token|password)[^=:\n]{0,40}[=:]\s*(?:&str\s*=\s*)?["'`]([A-Za-z0-9_./+=-]{20,})["'`]/i;
const placeholderValue =
  /(example|placeholder|dummy|sample|sentinel|redacted|do-not|your[-_]|test[-_]|local[-_]?secret|imported|replacement|mutationcheck|current-provider|other-provider)/i;
const placeholderAssignment =
  /=\s*(?:$|["'`]?(?:<[^>\r\n]+>|(?:replace|example|placeholder|dummy|sample|sentinel|redacted|your)[-_./A-Za-z0-9]*))["'`]?\s*$/i;

function looksLikeSecret(line) {
  if (placeholderAssignment.test(line)) {
    return false;
  }

  if (blockedPatterns.some((pattern) => pattern.test(line))) {
    return !placeholderValue.test(line);
  }

  const assignment = line.match(secretAssignment);
  return Boolean(
    assignment &&
    assignment[1] &&
    !/^[A-Z][A-Z0-9_]+$/.test(assignment[1]) &&
    !/^[A-Za-z]+(?:\.[A-Za-z]+){2,}$/.test(assignment[1]) &&
    !placeholderValue.test(assignment[1]),
  );
}

function getStagedFiles() {
  const output = execFileSync("git", ["diff", "--cached", "--name-only", "--diff-filter=ACM"], {
    encoding: "utf8",
  }).trim();

  return output ? output.split(/\r?\n/).filter(Boolean) : [];
}

function getStagedPatch(filePath) {
  return execFileSync("git", ["diff", "--cached", "--unified=0", "--", filePath], {
    encoding: "utf8",
  });
}

function main() {
  const stagedFiles = getStagedFiles();
  const violations = [];

  for (const filePath of stagedFiles) {
    if (blockedFiles.some((pattern) => pattern.test(filePath))) {
      violations.push(`禁止提交敏感环境文件: ${filePath}`);
      continue;
    }

    const patch = getStagedPatch(filePath);
    const addedLines = patch
      .split(/\r?\n/)
      .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
      .map((line) => line.slice(1));

    for (const line of addedLines) {
      if (looksLikeSecret(line)) {
        violations.push(`检测到疑似密钥内容: ${filePath}`);
        break;
      }
    }
  }

  if (violations.length > 0) {
    console.error("[pre-commit] 已拦截可能泄露密钥的提交:");
    for (const violation of violations) {
      console.error(`  - ${violation}`);
    }
    console.error("请改用本地未跟踪文件，例如 .env.local。\n");
    process.exit(1);
  }

  console.log("[pre-commit] 未发现已暂存的敏感环境文件或明显密钥。");
}

main();
