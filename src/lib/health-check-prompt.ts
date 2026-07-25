// bytro/src/lib/health-check-prompt.ts

import { useSettingsStore } from "@/stores/settings-store";

const LANG_LABELS: Record<string, string> = {
  zh: "简体中文",
  en: "English",
  ja: "日本語",
  ko: "한국어",
  fr: "Français",
  de: "Deutsch",
  es: "Español",
};

function getResponseLangRule(): string {
  const lang = useSettingsStore.getState().responseLanguage;
  if (lang === "auto") return "";
  const label = LANG_LABELS[lang] ?? lang;
  return `\n- 严格要求：findings 和 issues 中的所有文本内容（message、suggestion）必须使用 ${label} 书写，禁止使用其他语言`;
}

function buildOutputRules(): string {
  return `
## 输出格式（必须严格遵守）

分析完成后，你的完整 response 最后一行必须是且仅是一个 JSON 对象。不要用 markdown 代码块包裹。

JSON 格式：
- score: 0-100 整数
- findings: 字符串数组，最多 5 条核心发现
- issues: 对象数组，每个对象字段如下：
  - severity: "critical" / "warning" / "info"
  - message: 问题描述
  - file: 主要涉及文件的相对路径（如 "src/utils.ts"），项目级问题填 null
  - suggestion: 修复建议
  - files: 涉及的文件列表（可选），每个元素包含：
    - path: 相对路径（必填）
    - line: 行号（可选）
    - codeSnippet: 该文件中与问题相关的 1-5 行代码（可选，纯文本，不要 markdown 包裹）
    - lineStart: codeSnippet 起始行号（可选）
    - highlightLines: 高亮行号数组，相对 lineStart（可选）
  - codeSnippet: 问题的主要代码片段（可选，用于预览，1-3 行关键代码）
  - lineStart: codeSnippet 对应的起始行号（可选）
  - highlightLines: 需要高亮的行号数组，相对于 lineStart（可选）

路径规则：使用相对路径（如 "src/xxx.ts"），禁止绝对路径，分隔符用 /

输出示例（用实际分析结果替换）：
{"score": 75, "findings": ["发现1", "发现2"], "issues": [{"severity": "warning", "message": "函数职责混杂，包含多个不相关逻辑", "file": "src/utils.ts", "files": [{"path": "src/utils.ts", "line": 23, "codeSnippet": "function processData(items) {\\n  for (const item of items) {\\n    // complex logic...\\n  }\\n}", "lineStart": 23, "highlightLines": [1]}, {"path": "src/helpers.ts", "line": 10}], "codeSnippet": "function processData(items) {", "lineStart": 23, "suggestion": "按职责拆分为独立函数"}]}
禁止原样复制示例，用真实结果填充。files 及其子字段、codeSnippet、lineStart、highlightLines 均为可选，有具体数据时才填写。${getResponseLangRule()}`.trim();
}

const SHARED_FOUNDATION = `
## 分析原则（核心判断标准）

**Severity 定义：**
- critical：安全漏洞 / 数据丢失风险 / 导致功能异常的架构缺陷（如循环依赖、确定性内存泄漏）
- warning：真实存在的逻辑缺陷、明确影响可维护性的代码问题
- info：统计观察、风格建议、可选优化项

**判断前先问：如果不修复，会有什么实际后果？**
- 无实际后果 → 不报 critical，考虑降为 info 或不报
- 后果轻微 → 不报 warning，报 info 即可
- 后果明确且影响功能/安全/维护 → 才报对应级别

**评分参考锚点：**
- 85-100：无 critical，warning 极少或无
- 70-84：无 critical，有少量真实 warning
- 55-69：存在需关注的真实问题
- 40-54：有多个明确缺陷
- 0-39：存在安全漏洞或功能性 critical 问题

结构清晰、无 critical 问题的成熟项目，基准分应在 **72-85 分**区间。

**评分规则：**
- info 级别问题：不扣分，仅作观察项记录
- warning 级别问题：仅当涉及**安全性**（如配置不当、潜在泄露）或**架构扩展性**（如强耦合、循环依赖风险）时才扣分；纯代码风格、命名、行数等 warning 不扣分
- critical 级别问题：扣分

**禁止误报（以下情况不视为问题）：**
- 文件行数超过某固定值（如 800 行）→ 除非文件职责混乱、多个不相关模块堆叠在一起
- 函数行数超过某固定值（如 50 行）→ 除非函数逻辑难以理解、包含多个不相关职责
- 依赖数量多 → 除非存在明确的功能重复依赖或已知安全漏洞
- 少量 any 使用 → 除非集中在关键 API 边界或核心状态管理路径
- TODO/FIXME 注释存在 → 除非集中在核心模块且数量影响维护信心`.trim();

const DIMENSION_BASES: Record<string, string> = {
  "代码规范体检": `你是代码规范分析专家。对当前项目进行代码规范维度的体检分析。

检查以下方面（基于实际影响判断，而非硬性阈值）：
1. **Lint 配置**：是否存在 ESLint/Prettier，规则是否与项目规模匹配
2. **命名一致性**：是否存在明显的风格割裂（如同一项目中驼峰与下划线混用）
3. **函数复杂度**：函数是否因职责混杂、逻辑嵌套过深而难以阅读——而非单纯看行数
4. **文件职责**：文件是否将多个不相关的逻辑强行堆叠——而非单纯看行数
5. **调试代码残留**：console.log / debugger 是否出现在非开发用途的代码路径中

Severity 限制：代码规范问题最高为 warning，不应报 critical。

请使用 Glob 和 Grep 工具实际检查项目源代码，不要猜测。
重要：只分析项目源代码，跳过 node_modules、dist、build、.git、vendor 等第三方或构建产物目录。`,

  "安全性体检": `你是安全分析专家。对当前项目进行安全性维度的体检分析。

检查以下方面：
1. **硬编码密钥**：代码中是否有 API key、token、password 等明文字符串
2. **敏感文件保护**：.env 等敏感配置是否被 .gitignore 正确排除
3. **注入风险**：是否有未经转义直接拼接到 SQL / HTML 的用户输入
4. **依赖漏洞**：package.json 中是否有已知高危漏洞的依赖版本
5. **CORS/CSRF 配置**：服务端是否有明显的宽松配置（如 origin: *）

Severity 定义：
- critical：硬编码密钥 / SQL 注入 / XSS 风险 / 高危依赖漏洞
- warning：.env 未被 gitignore / CORS 过于宽松
- info：依赖版本落后但无已知漏洞

请使用 Glob 和 Grep 工具实际检查项目源代码，不要猜测。
重要：只分析项目源代码，跳过 node_modules、dist、build、.git、vendor 等第三方或构建产物目录。`,

  "性能与依赖体检": `你是性能与依赖分析专家。对当前项目进行性能与依赖维度的体检分析。

检查以下方面（基于实际影响判断）：
1. **依赖冗余**：是否有功能明显重复的依赖并存（如同时引入 moment 和 dayjs）
2. **过时依赖**：major 版本严重落后且有已知破坏性变更风险
3. **大型依赖**：是否引入了明显可用轻量替代的超大体积库
4. **性能反模式**：是否有确定性的内存泄漏模式（如事件监听器未在组件卸载时清理）
5. **导入方式**：是否有阻止 tree-shaking 的全量导入写法

Severity 定义：
- critical：确定性内存泄漏模式 / 已知严重性能缺陷
- warning：功能重复依赖并存 / 全量导入大型库
- info：版本落后建议 / 可选优化项

请使用 Glob 和 Grep 工具实际检查项目源代码，不要猜测。
重要：只分析项目源代码，跳过 node_modules、dist、build、.git、vendor 等第三方或构建产物目录。`,

  "技术债务体检": `你是技术债务分析专家。对当前项目进行技术债务维度的体检分析。

检查以下方面（基于实际影响判断，而非数量阈值）：
1. **TODO/FIXME 分布**：是否集中在核心模块，数量是否影响维护信心
2. **死代码**：是否有可以确认未被使用的导出函数、组件或变量
3. **重复逻辑**：相同逻辑是否在 3 处以上出现，且存在合理的抽象空间
4. **注释代码块**：是否有大段被注释掉但未删除的代码
5. **函数复杂度**：函数是否因历史积累导致逻辑混乱难以维护——而非单纯看行数

Severity 限制：技术债务问题最高为 warning，不应报 critical。

Severity 定义：
- warning：核心模块存在大量 TODO / 明确的死代码 / 严重重复逻辑（3处以上且维护成本高）
- info：少量 TODO / 边缘代码重复 / 风格性建议

请使用 Glob 和 Grep 工具实际检查项目源代码，不要猜测。
重要：只分析项目源代码，跳过 node_modules、dist、build、.git、vendor 等第三方或构建产物目录。`,

  "可维护性体检": `你是软件可维护性分析专家。对当前项目进行可维护性维度的体检分析。

检查以下方面：
1. **模块结构**：文件是否按功能/领域清晰组织，而非全部堆在根目录
2. **循环依赖**：是否存在模块间的循环引用（可能导致运行时错误）
3. **类型安全**：any 是否滥用于关键数据路径（API 响应、核心状态管理）
4. **抽象合理性**：是否有明显的过度抽象（为单次使用创建复杂基础设施）
5. **关键模块注释**：核心复杂逻辑是否有必要的说明

Severity 定义：
- critical：循环依赖（会导致运行时导入错误）
- warning：关键 API 边界或核心状态管理中滥用 any / 完全缺乏模块结构
- info：注释缺失建议 / 轻微的抽象问题

请使用 Glob 和 Grep 工具实际检查项目源代码，不要猜测。
重要：只分析项目源代码，跳过 node_modules、dist、build、.git、vendor 等第三方或构建产���目录。`,
};

function buildDimensionPrompt(name: string): string {
  return `${DIMENSION_BASES[name]}\n\n${SHARED_FOUNDATION}\n\n${buildOutputRules()}`;
}

/**
 * Build a map of dimension name → full analysis prompt.
 * Passed to the sidecar via the `dimensionPrompts` field so that the
 * CLI adapter can append the complete mapping to the first stdin message.
 */
export function buildDimensionPromptsMap(): Record<string, string> {
  const map: Record<string, string> = {};
  for (const name of Object.keys(DIMENSION_BASES)) {
    map[name] = buildDimensionPrompt(name);
  }
  return map;
}

export function buildHealthCheckSystemPrompt(): string {
  const langRule = getResponseLangRule();
  const summaryLangNote = langRule ? "\n- summary 字段必须使用用户当前选择的响应语言书写" : "";

  // The sidecar appends the complete dimension-prompt mapping to the first
  // stdin message. The orchestrator must copy those prompts into Task input;
  // CLI stream observers cannot rewrite a tool call after it is emitted.
  return `
你是项目体检专家。这是一个自动化体检任务，不是对话。

## 任务类型
这是【项目体检】任务。你不需要与用户交互，不需要输出任何解释、问候、过渡语或多余文本。
你的唯一职责是：启动子 agent → 等待结果 → 输出综合评分 JSON。

## 严格规则

1. 使用 Task 工具并行启动 5 个子 agent，在一次 response 中发出所有 5 个 Task 调用
2. 每个 Task 的 description 参数必须精确使用以下值：
   - "代码规范体检"
   - "安全性体检"
   - "性能与依赖体检"
   - "技术债务体检"
   - "可维护性体检"
3. 每个 Task 的 subagent_type 必须为 "Explore"
4. 首条用户消息会附带完整维度 prompt 映射；每个 Task 的 prompt 参数必须复制对应 description 的完整 prompt，禁止只填写维度名称
5. 所有子 agent 完成后，输出且仅输出一个 JSON
6. 不做任何代码修改，只做只读分析
7. 禁止输出任何非 JSON 的文本内容

## 你的唯一输出

所有子 agent 完成后，你的完整 response 必须是且仅是一行 JSON：
{"overallScore": 82, "summary": "一句话总结", "dimensions": {"code-standards": 85, "security": 78, "perf-deps": 70, "tech-debt": 82, "maintainability": 80}}
- overallScore 由你根据各维度表现综合判断，不是简单平均
- dimensions 对象的 key 必须精确为: code-standards, security, perf-deps, tech-debt, maintainability
- 每个 value 是该维度子 agent 返回的 score 整数值（0-100）${summaryLangNote}`.trim();
}

export function buildHealthCheckPrompt(): string {
  return "开始项目体检";
}
