import type { PlatformId } from "@/lib/platform-config";

import bigmodelIcon from "./bigmodel.png";
import claudeIcon from "./claude.png";
import codexIcon from "./openai.png";
import deepseekIcon from "./deepseek.png";
import geminiIcon from "./gemini.svg";
import grokIcon from "./grok.png";
import kimiIcon from "./kimi.png";
import mimoIcon from "./mimo.jpg";
import minimaxIcon from "./minimax.png";
import ollamaIcon from "./ollama.png";
import qwenIcon from "./qwen.png";

export const PLATFORM_ICONS: Partial<Record<PlatformId, string>> = {
  bigmodel: bigmodelIcon,
  claude: claudeIcon,
  codex: codexIcon,
  deepseek: deepseekIcon,
  gemini: geminiIcon,
  grok: grokIcon,
  kimi: kimiIcon,
  mimo: mimoIcon,
  minimax: minimaxIcon,
  ollama: ollamaIcon,
  qwen: qwenIcon,
};
