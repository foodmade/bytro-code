# Provider CLI 自动安装设计

日期：2026-07-25

## 背景

Bytro Community Edition 当前只从用户显式配置的路径或进程 `PATH`
检测 Claude 和 Codex CLI。应用不会安装缺失的 CLI，因此在没有预装
Claude Code 或 Codex 的机器上，会话启动会失败并显示：

`Required provider CLI is unavailable`

正式版通过 COS 分发托管二进制。社区版不能依赖 Bytro 的 COS，但仍需
在启动时自动准备与正式版兼容的固定版本。

## 目标

- 在应用启动后自动检查 Claude 和 Codex CLI。
- 缺失时读取 `sidecar/package.json` 中与正式版相同的两个版本定义，
  再使用本机 Node.js/npm 安装当前系统对应的 SDK 平台包。
- 安装到 Bytro Community Edition 私有目录，不写全局 npm 目录。
- 会话入口在后台安装尚未完成或失败时执行即时兜底。
- Claude/Codex 会话、预热及认证流程始终获得已验证的绝对可执行路径。
- 不访问 Bytro COS，不恢复正式版 BinaryManager、WSL 托管工具链或商业功能。

## 非目标

- 不自动安装 Node.js。系统仍要求 Node.js 20 或更高版本，或通过
  `BYTRO_NODE_PATH` 指定本机 Node.js。
- 不管理 Gemini CLI。
- 不覆盖用户通过 `CLAUDE_CLI_PATH` 或 `CODEX_CLI_PATH` 指定的有效 CLI。
- 不执行 `npm install -g`，不请求管理员权限。
- 不实现 CLI 自动升级到未固定的新版本。

## 版本来源

`sidecar/package.json` 与正式版保持相同的两个唯一版本来源：

```json
{
  "dependencies": {
    "@anthropic-ai/claude-agent-sdk": "0.3.198"
  },
  "binaryVersions": {
    "codex": "0.144.4"
  }
}
```

- Claude SDK 版本读取
  `dependencies["@anthropic-ai/claude-agent-sdk"]`。
- Codex SDK 版本读取 `binaryVersions.codex`。

不得增加新的 Claude 版本字段，也不得在 Rust 或 TypeScript 源码中重复硬编码
版本号。正式版的二进制发布和社区版的本地 SDK 安装由同一组版本定义驱动。

`src-tauri/build.rs` 沿用正式版逻辑，在编译时读取这两个值并生成：

- `CLAUDE_BINARY_VERSION`
- `CODEX_BINARY_VERSION`

缺少 Claude 依赖项或 Codex 版本字段时构建直接失败，避免运行时静默选择其他版本。

## 安装布局

安装根目录：

```text
~/.bytro-community/cli/
├── claude/
│   └── 0.3.198/
└── codex/
    └── 0.144.4/
```

每次安装先写入同级临时目录。完成以下校验后，再原子切换到最终版本目录：

1. npm 命令成功退出。
2. 安装包的 `package.json` 版本与固定版本一致。
3. 目标可执行文件存在、是普通文件，并位于安装根目录内。
4. Unix 平台上文件具有可执行权限。
5. 执行 `--version` 能在超时内成功退出。

安装失败或进程中断时，最终版本目录不应指向半安装内容。清理操作只能作用于
经过路径边界校验的 Bytro 私有临时目录。

## 平台包映射

Claude 使用 `dependencies["@anthropic-ai/claude-agent-sdk"]` 的版本值
推导显式平台包：

| 系统 | 架构 | npm 包 |
| --- | --- | --- |
| macOS | arm64 | `@anthropic-ai/claude-agent-sdk-darwin-arm64@0.3.198` |
| macOS | x64 | `@anthropic-ai/claude-agent-sdk-darwin-x64@0.3.198` |
| Windows | arm64 | `@anthropic-ai/claude-agent-sdk-win32-arm64@0.3.198` |
| Windows | x64 | `@anthropic-ai/claude-agent-sdk-win32-x64@0.3.198` |
| Linux glibc | arm64 | `@anthropic-ai/claude-agent-sdk-linux-arm64@0.3.198` |
| Linux glibc | x64 | `@anthropic-ai/claude-agent-sdk-linux-x64@0.3.198` |
| Linux musl | arm64 | `@anthropic-ai/claude-agent-sdk-linux-arm64-musl@0.3.198` |
| Linux musl | x64 | `@anthropic-ai/claude-agent-sdk-linux-x64-musl@0.3.198` |

Claude 可执行文件位于平台包根目录中的 `claude` 或 `claude.exe`。

Codex 使用 `binaryVersions.codex` 的版本值推导上游平台版本：

| 系统 | 架构 | npm 包 |
| --- | --- | --- |
| macOS | arm64 | `@openai/codex@0.144.4-darwin-arm64` |
| macOS | x64 | `@openai/codex@0.144.4-darwin-x64` |
| Windows | arm64 | `@openai/codex@0.144.4-win32-arm64` |
| Windows | x64 | `@openai/codex@0.144.4-win32-x64` |
| Linux | arm64 | `@openai/codex@0.144.4-linux-arm64` |
| Linux | x64 | `@openai/codex@0.144.4-linux-x64` |

Codex 可执行文件从平台包的 `vendor/<target-triple>/codex/` 或
`vendor/<target-triple>/bin/` 布局中解析，并复用现有 Codex 路径解析规则。
不支持的平台返回明确错误，不回退到其他架构。

## 管理器职责

新增社区版 Provider CLI 管理器，Rust 侧统一负责：

- 读取由 `sidecar/package.json` 两个正式版本来源生成的编译期版本。
- 解析当前平台包和预期可执行文件。
- 优先验证用户显式配置的绝对路径。
- 其次验证应用私有目录中的固定版本。
- 缺失时取得应用级安装锁并执行 npm 安装。
- 多个并发会话等待同一次安装，不重复启动 npm。
- 安装成功后缓存并返回已验证的绝对路径。
- 将已验证的绝对路径写入每次 Provider 命令的
  `claudeBinaryPath` / `codexBinaryPath` 字段。
- 为 Sidecar 进程环境准备 `CLAUDE_CLI_PATH` 和 `CODEX_CLI_PATH`
  作为兼容回退。
- 向 `check_cli_tools` 暴露应用私有安装状态和固定版本。

npm 必须通过 NodeRuntimeManager 返回的本机绝对路径启动。命令参数作为独立
参数传递，不拼接 shell 字符串。包名来自平台映射闭集，版本只来自
`dependencies["@anthropic-ai/claude-agent-sdk"]` 和 `binaryVersions.codex`。

## 启动和即时兜底

应用启动后：

1. 检测本机 Node.js 20+。
2. Node.js 可用时，在后台并发前置检查 Claude 和 Codex。
3. 缺失的工具进入私有目录安装。
4. 安装结果写入管理器状态和私有诊断日志。

所有会启动 Provider Sidecar 的入口必须在启动 Sidecar 前等待所需 CLI：

- Claude/Codex 普通会话。
- `init_session` 会话预热。
- Claude Teams。
- Codex OAuth 登录、读取、取消和退出。

即时检查使用请求中的代理配置执行重试。应用启动时的后台失败不永久缓存为
失败；后续真实会话仍会重试。

为避免已启动 Sidecar 看不到安装后新增的环境变量，Rust 在每条 Query、
InitSession、Teams 和 Codex OAuth 命令中传递当前 Provider 已验证的绝对
路径。Sidecar 必须优先使用命令路径，并再次确认其是绝对普通可执行文件。
进程环境变量只作为兼容回退，不承担安装完成通知。

用户仅使用某一个 Provider 时，另一个 Provider 的安装失败不得阻止当前
Provider 的会话；失败的一侧在首次使用时重试。

## 路径优先级

每个 Provider 的路径选择顺序：

1. 有效的 `CLAUDE_CLI_PATH` / `CODEX_CLI_PATH`。
2. 应用私有目录中与固定版本对应的有效可执行文件。
3. 用户原始 `PATH` 中的有效 CLI。
4. 自动安装固定版本并使用安装结果。

用户显式配置和原始 `PATH` 中的 CLI 不会被删除或升级。应用私有安装始终按
固定版本隔离。

## 错误处理

对用户可见的错误包含 Provider、阶段和可执行建议，例如：

- `Claude CLI installation requires Node.js 20 or newer`
- `Claude CLI installation failed during npm install`
- `Codex CLI installation completed but the executable was not found`
- `Unsupported provider CLI platform: linux/riscv64`

底层 npm stdout/stderr 不直接回传到 WebView。诊断日志只记录：

- Provider。
- 固定版本。
- 平台标识。
- 安装阶段。
- 退出状态。
- stdout/stderr 长度和哈希。

日志不得记录 API Key、OAuth token、代理凭据或完整用户路径。

## 网络边界

- 只访问用户 npm 配置指定的 registry，默认是 npm 官方 registry。
- 不请求 Bytro COS manifest 或二进制地址。
- 不引入自动更新检查。
- npm 包完整性由 npm lock/integrity 校验流程负责。

## 测试

### Rust 单元测试

- 所有支持平台映射到正确包名和可执行路径。
- 不支持的系统或架构明确失败。
- 安装根目录和临时目录路径边界校验。
- 从 `dependencies["@anthropic-ai/claude-agent-sdk"]` 和
  `binaryVersions.codex` 解析版本；任一缺失时构建失败。
- 用户显式路径、应用私有路径、PATH、自动安装的优先级。
- 并发调用只执行一次安装。
- 半安装目录不会作为有效 CLI。

### 集成测试

- 使用假的 Node/npm 安装脚本创建预期平台布局。
- 首次检查触发安装并返回绝对路径。
- 第二次检查复用现有版本，不再次执行 npm。
- npm 失败后真实会话检查可以重试。
- 安装成功后 Claude/Codex 的每条 Sidecar 命令都收到正确路径。
- `check_cli_tools` 报告应用私有安装版本。

### 回归验证

- Sidecar 全量测试及 bundle 构建。
- 前端测试和 TypeScript 检查。
- `cargo fmt --check`。
- `cargo test` 和 `cargo check --locked`。
- `npm run check:community` 确认没有 COS、正式版品牌或已移除模块回流。

## 完成标准

- 全新环境在存在 Node.js 20+ 和网络的情况下自动安装两个固定版本。
- Claude 和 Codex 会话、预热、Teams 与 Codex OAuth 无需用户手动安装 CLI。
- 应用重启后复用已经安装的固定版本。
- 安装失败产生可诊断、可重试的错误。
- 社区版运行路径不包含 Bytro COS。
- 用户已有 CLI 和用户配置不被覆盖。
