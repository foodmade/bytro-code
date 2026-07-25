# Provider CLI 自动安装实施计划

关联规格：
`docs/superpowers/specs/2026-07-25-provider-cli-auto-install-design.md`

## 1. 恢复正式版版本来源

修改：

- `sidecar/package.json`
- `sidecar/package-lock.json`
- `src-tauri/build.rs`

步骤：

1. 在 `dependencies` 固定
   `@anthropic-ai/claude-agent-sdk: 0.3.198`。
2. 在 `binaryVersions.codex` 固定 `0.144.4`。
3. 将正式版的编译期版本提取逻辑移植到社区版：
   - Claude 从 `dependencies["@anthropic-ai/claude-agent-sdk"]` 读取。
   - Codex 从 `binaryVersions.codex` 读取。
4. 任一字段缺失时让构建以明确错误失败。

验证：

- package lock 与 package.json 一致。
- `cargo check --locked` 能读取两个编译期环境变量。
- 单元测试覆盖 JSON 版本提取器。

## 2. 实现社区版 Provider CLI 管理器

新增：

- `src-tauri/src/provider_cli.rs`

修改：

- `src-tauri/src/lib.rs`
- `src-tauri/src/sidecar/cli_tools.rs`

管理器接口：

- `ProviderCli::Claude` / `ProviderCli::Codex`
- `ProviderCliManager::ensure(app, provider, proxy_url)`
- `ProviderCliManager::resolve_installed(provider)`
- `ProviderCliManager::status(provider)`
- `ProviderCliManager::prepare_sidecar_environment(command)`

步骤：

1. 根据 `target_os`、`target_arch`、`target_env` 生成闭集平台映射。
2. 使用 `~/.bytro-community/cli/<provider>/<version>/` 作为最终目录。
3. 优先检查显式环境变量，再检查私有固定版本，最后检查原始 PATH。
4. 缺失时通过 NodeRuntimeManager 获取绝对 Node/npm 路径。
5. 在同级临时目录执行本地 npm 安装：
   - Claude：对应 `@anthropic-ai/claude-agent-sdk-<platform>@<version>`。
   - Codex：对应 `@openai/codex@<version>-<platform>`。
6. 校验 package.json、可执行文件边界、权限和 `--version`。
7. 通过同一 Provider 的异步锁合并并发安装。
8. 校验完成后原子提升到最终目录。
9. 只向私有诊断日志写入状态、长度和哈希。

验证：

- 平台映射表测试。
- 路径优先级测试。
- 假 npm 首次安装、复用和失败重试测试。
- 并发安装只执行一次。
- 临时目录和符号链接逃逸被拒绝。

## 3. 接入应用启动和 CLI 状态

修改：

- `src-tauri/src/lib.rs`
- `src-tauri/src/sidecar/cli_tools.rs`
- `src/stores/cli-tools-store.ts`（仅在返回结构需要扩展时）

步骤：

1. 注册 `ProviderCliManager` 状态。
2. Node.js 检测成功后后台并发 ensure Claude/Codex。
3. 启动失败只记录状态，不阻止窗口打开。
4. `check_cli_tools` 同时识别显式路径、私有固定版本和 PATH。
5. 返回私有安装的固定版本和绝对路径。

验证：

- 无 Node.js 时返回可执行建议。
- 已安装时不启动 npm。
- 启动后台失败后即时调用仍可重试。

## 4. 会话入口即时兜底

修改：

- `src-tauri/src/sidecar/chat.rs`
- `src-tauri/src/sidecar/session.rs`
- `src-tauri/src/sidecar/teams_chat.rs`
- `src-tauri/src/sidecar/codex_auth.rs`

步骤：

1. 普通 Claude/Codex Query 在 `ensure_running` 前等待对应 Provider。
2. `init_session` 根据 agent/provider 等待对应 Provider。
3. Teams 始终等待 Claude。
4. Codex OAuth 四个入口改为 async，并在启动 Sidecar 前等待 Codex。
5. 安装错误映射为包含 Provider 和阶段的用户错误。
6. 其他 Provider 不触发 Claude/Codex 安装。

验证：

- 每个入口的 Provider 选择测试。
- 安装失败不会注册活动请求。
- 一个 Provider 失败不阻止另一个 Provider。

## 5. 将绝对路径传给 Sidecar

修改：

- `src-tauri/src/sidecar/protocol.rs`
- `sidecar/src/protocol.ts`
- `src-tauri/src/sidecar/chat.rs`
- `src-tauri/src/sidecar/session.rs`
- `src-tauri/src/sidecar/teams_chat.rs`
- `src-tauri/src/sidecar/codex_auth.rs`
- `sidecar/src/shared.ts`
- `sidecar/src/claude-handler.ts`
- `sidecar/src/teams-handler.ts`
- `sidecar/src/openai-handler.ts`
- Codex OAuth Sidecar 路由

步骤：

1. 恢复最小路径字段：
   - `claudeBinaryPath`
   - `codexBinaryPath`
2. 不恢复 WSL、托管 PATH、COS 版本状态或 BinaryManager 字段。
3. Claude 路径解析优先校验命令中的绝对可执行文件。
4. Codex RPC 初始化优先使用命令中的绝对可执行文件。
5. Query、InitSession、Teams 和 Codex OAuth 全部传递对应路径。
6. 环境变量只保留为兼容回退。

验证：

- Rust 序列化字段名称测试。
- TypeScript 协议类型检查。
- Claude/Codex 路径优先级及非法路径测试。
- 已运行 Sidecar 能在后续命令中使用新安装路径。

## 6. 文档和社区边界

修改：

- `README.md`
- `PRIVACY.md`
- `docs/NETWORK_AND_DATA.md`
- `docs/PROVIDERS.md`
- `scripts/check-community-config.cjs`

步骤：

1. 将“不会下载 Provider CLI”更新为“从 npm registry 安装固定 SDK 平台包”。
2. 明确版本来源、私有目录和不使用 COS。
3. 社区检查禁止 COS manifest、正式版 BinaryManager 和品牌回流。
4. 允许官方 npm 包名和固定版本字段。

验证：

- `npm run check:community` 通过。
- 文档不存在与自动安装相冲突的描述。

## 7. 全量验证与提交

依次执行：

1. Provider CLI Rust 单元测试。
2. `npm --prefix sidecar test`
3. `npm --prefix sidecar run build:bundle`
4. 前端测试和类型检查。
5. `cargo fmt --manifest-path src-tauri/Cargo.toml --all --check`
6. `cargo test --manifest-path src-tauri/Cargo.toml --locked`
7. `cargo check --manifest-path src-tauri/Cargo.toml --locked`
8. `npm run check:community`
9. `git diff --check`
10. GitNexus `detect-changes --scope staged`

提交拆分：

1. `build: restore provider SDK version pins`
2. `feat: install provider SDKs locally`
3. `fix: inject managed provider CLI paths`
4. `docs: document provider SDK installation`
