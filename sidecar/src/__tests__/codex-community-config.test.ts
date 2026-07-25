import { describe, expect, it } from "vitest";
import { basename, relative } from "node:path";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BYTRO_COMMUNITY_HOME_DIR,
  CODEX_COMMUNITY_CONFIG_OVERRIDES,
  applyCodexCommunitySpawnEnv,
  buildCodexAppServerEnvironment,
  buildCodexBaseUrlToml,
  buildBytroCommunityDataPath,
  buildCodexCommunityConfigArgs,
  buildCodexProviderSpawnArgs,
  buildBuiltinMcpProcessConfig,
  buildMcpTomlSection,
  buildPersistentCodexHome,
  cleanupBytroCodexRuntimeProjection,
  getCodexProfileHome,
  probeCodexVersion,
  projectMcpServersForRuntime,
  selectCodexBinaryCandidate,
  stripCodexMcpSectionsForRuntime,
  validateCodexBaseUrl,
} from "../openai-handler.js";

describe("community Codex startup configuration", () => {
  it("keeps hostile Windows MCP paths in direct executable and argv fields", () => {
    const executable =
      'C:\\Program Files\\Node %PATH% !PROMPT! ^ & | "sentinel"\\node.exe';
    const entry =
      'C:\\Users\\demo\\Bytro %TEMP% ! ^ & | "sentinel"\\openai-images.mjs';

    const launch = buildBuiltinMcpProcessConfig(executable, entry);

    expect(launch).toEqual({
      command: executable,
      args: [entry],
    });
    expect(launch.command.toLowerCase()).not.toBe("cmd.exe");
    expect(launch.args).not.toContain("/c");
  });

  it("forces nonessential network and auto-install features off", () => {
    const args = buildCodexCommunityConfigArgs();

    expect(args).toEqual(
      CODEX_COMMUNITY_CONFIG_OVERRIDES.flatMap((value) => ["-c", value]),
    );
    expect(CODEX_COMMUNITY_CONFIG_OVERRIDES).toContain(
      "check_for_update_on_startup=false",
    );
    expect(CODEX_COMMUNITY_CONFIG_OVERRIDES).toContain(
      "analytics.enabled=false",
    );
    expect(CODEX_COMMUNITY_CONFIG_OVERRIDES).toContain(
      "feedback.enabled=false",
    );
    expect(CODEX_COMMUNITY_CONFIG_OVERRIDES).toContain(
      'otel.exporter="none"',
    );
    expect(CODEX_COMMUNITY_CONFIG_OVERRIDES).toContain(
      'otel.trace_exporter="none"',
    );
    expect(CODEX_COMMUNITY_CONFIG_OVERRIDES).toContain(
      'otel.metrics_exporter="none"',
    );
    expect(CODEX_COMMUNITY_CONFIG_OVERRIDES).toContain(
      "features.remote_plugin=false",
    );
    expect(CODEX_COMMUNITY_CONFIG_OVERRIDES).toContain(
      "features.plugins=false",
    );
    expect(CODEX_COMMUNITY_CONFIG_OVERRIDES).toContain(
      "features.plugin_sharing=false",
    );
    expect(CODEX_COMMUNITY_CONFIG_OVERRIDES).toContain(
      "features.skill_mcp_dependency_install=false",
    );
    expect(CODEX_COMMUNITY_CONFIG_OVERRIDES).toContain(
      "features.apps=false",
    );
    expect(CODEX_COMMUNITY_CONFIG_OVERRIDES).toContain(
      "shell_environment_policy.ignore_default_excludes=false",
    );
    const shellExclude = CODEX_COMMUNITY_CONFIG_OVERRIDES.find((value) =>
      value.startsWith("shell_environment_policy.exclude="),
    );
    expect(shellExclude).toContain("^OPENAI_API_KEY$");
    expect(shellExclude).toContain("^CODEX_HOME$");
    expect(shellExclude).toContain("^BYTRO_MCP_SECRET_");
    expect(shellExclude).toContain("HTTP_PROXY");
    expect(shellExclude).toContain("http_proxy");
  });

  it("overrides an unsafe user shell inheritance policy at CLI precedence", () => {
    const userConfig =
      "[shell_environment_policy]\n" +
      "ignore_default_excludes = true\n" +
      'exclude = []\n';
    const args = buildCodexCommunityConfigArgs();

    expect(userConfig).toContain("ignore_default_excludes = true");
    expect(args).toContain(
      "shell_environment_policy.ignore_default_excludes=false",
    );
    expect(args.at(-1)).toContain("shell_environment_policy.exclude=");
  });

  it("disables remote control and identifies the community launcher", () => {
    const env: Record<string, string> = {
      CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED: "0",
      CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "openai-codex",
    };

    applyCodexCommunitySpawnEnv(env);

    expect(env.CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED).toBe("1");
    expect(env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE).toBe("bytro-community");
  });

  it("builds the App Server environment from a strict allowlist", () => {
    const env = buildCodexAppServerEnvironment(
      {
        apiKey: "request-openai-key",
        baseUrl: "https://api.example.test/v1",
        proxyUrl: "http://127.0.0.1:8080",
      },
      {
        PATH: "/safe/bin",
        HOME: "/home/example",
        GH_TOKEN: "SECRET_SENTINEL_GITHUB",
        AWS_SECRET_ACCESS_KEY: "SECRET_SENTINEL_AWS",
        ANTHROPIC_API_KEY: "SECRET_SENTINEL_ANTHROPIC",
        DATABASE_URL: "SECRET_SENTINEL_DATABASE",
        OPENAI_API_KEY: "SECRET_SENTINEL_AMBIENT_OPENAI",
        BYTRO_MCP_SECRET_0: "SECRET_SENTINEL_AMBIENT_MCP",
        HTTPS_PROXY: "http://ambient-proxy.invalid",
      },
    );

    expect(env.PATH).toBe("/safe/bin");
    expect(env.HOME).toBe("/home/example");
    expect(env.OPENAI_API_KEY).toBe("request-openai-key");
    expect(env.OPENAI_BASE_URL).toBe("https://api.example.test/v1");
    expect(env.HTTPS_PROXY).toBe("http://127.0.0.1:8080");
    expect(env.CODEX_DISABLE_AUTO_UPDATE).toBe("1");
    expect(env.CODEX_DISABLE_TELEMETRY).toBe("1");
    expect(env.CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED).toBe("1");
    expect(env.OTEL_SDK_DISABLED).toBe("true");
    expect(env.DO_NOT_TRACK).toBe("1");
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.BYTRO_MCP_SECRET_0).toBeUndefined();
    expect(Object.values(env).join("\n")).not.toContain("SECRET_SENTINEL");
  });

  it("isolates persistent Codex data under the community home", () => {
    const result = buildBytroCommunityDataPath(
      "/home/example",
      "codex-sessions",
      "conversation-id",
    );

    expect(BYTRO_COMMUNITY_HOME_DIR).toBe(".bytro-community");
    expect(result).toContain(".bytro-community");
    expect(result).toContain("codex-sessions");
    expect(result).toContain("conversation-id");
  });

  it("never places a provider base URL or its credentials in argv", () => {
    const sensitiveBaseUrl =
      "https://user:password@example.test/v1?token=sentinel";
    const args = buildCodexProviderSpawnArgs(false);
    const argv = args.join("\u0000");

    expect(argv).not.toContain(sensitiveBaseUrl);
    expect(argv).not.toContain("user:password");
    expect(argv).not.toContain("token=sentinel");
    expect(argv).toContain("model_providers.OpenAI.env_key");
  });

  it("validates and safely serializes provider base URLs", () => {
    const valid = validateCodexBaseUrl("https://example.test/v1");
    const toml = buildCodexBaseUrlToml(valid);

    expect(valid).toBe("https://example.test/v1");
    expect(toml).toContain("openai_base_url = ");
    expect(toml.match(/openai_base_url/g)).toHaveLength(1);

    expect(() =>
      validateCodexBaseUrl("https://user:password@example.test/v1"),
    ).toThrow("must not include credentials");
    expect(() => validateCodexBaseUrl("file:///tmp/api")).toThrow(
      "must use HTTP(S)",
    );
    expect(() =>
      validateCodexBaseUrl("https://example.test/v1?token=query-value"),
    ).toThrow("must not include credentials");
    expect(() =>
      validateCodexBaseUrl("https://example.test/v1?api-version=2026-07-01"),
    ).toThrow("must not include credentials");
    expect(() =>
      validateCodexBaseUrl("https://example.test/v1#fragment"),
    ).toThrow("must not include credentials");
    expect(() =>
      buildCodexBaseUrlToml(
        'https://example.test/"\nfeatures.plugins=true\n#',
      ),
    ).toThrow("invalid characters");

    expect(() =>
      buildCodexBaseUrlToml('https://example.test/path?label="quoted"'),
    ).toThrow("must not include credentials");
  });

  it("hashes hostile conversation IDs into the sessions root", () => {
    const home = "/home/example";
    const sessionsRoot = buildBytroCommunityDataPath(
      home,
      "codex-sessions",
    );

    for (const conversationId of [
      "../../escape",
      "/tmp/absolute-escape",
      "会话/../../越界",
    ]) {
      const result = buildPersistentCodexHome(home, conversationId);
      const fromRoot = relative(sessionsRoot, result);

      expect(fromRoot.startsWith("..")).toBe(false);
      expect(fromRoot.startsWith("/")).toBe(false);
      expect(basename(result)).toMatch(/^[a-f0-9]{64}$/);
      expect(result).not.toContain(conversationId);
    }
  });

  it("derives collision-resistant OAuth profile homes", () => {
    const home = "/home/example";
    const slash = getCodexProfileHome("a/b", home);
    const question = getCodexProfileHome("a?b", home);

    expect(slash).not.toBe(question);
    expect(slash).toContain(".bytro-community");
    expect(slash).toMatch(/a_b-[a-f0-9]{64}[\\/]\.codex$/);
    expect(question).toMatch(/a_b-[a-f0-9]{64}[\\/]\.codex$/);
    expect(() => getCodexProfileHome("   ", home)).toThrow(
      "profile ID is required",
    );
  });

  it("prefers a native Windows Codex executable and falls back to npm shims", () => {
    expect(
      selectCodexBinaryCandidate(
        [
          "C:\\Users\\demo\\bin\\codex.cmd",
          "C:\\Program Files\\Codex\\codex.exe",
          "C:\\Users\\demo\\bin\\codex.bat",
        ],
        "win32",
      ),
    ).toBe("C:\\Program Files\\Codex\\codex.exe");
    expect(
      selectCodexBinaryCandidate(
        ["C:\\Users\\demo\\bin\\codex.cmd"],
      "win32",
      ),
    ).toBe("C:\\Users\\demo\\bin\\codex.cmd");
  });

  it("probes a Windows npm shim without interpolating its path", () => {
    const binaryPath =
      'C:\\Program Files\\Bytro & Tools\\codex %PATH% !PROMPT! "quoted".cmd';
    let captured:
      | {
          executable: string;
          args: readonly string[];
          timeout: number;
          windowsVerbatimArguments: boolean;
          env: NodeJS.ProcessEnv;
        }
      | undefined;
    const version = probeCodexVersion(
      binaryPath,
      (executable, args, options) => {
        captured = {
          executable,
          args,
          timeout: options.timeout,
          windowsVerbatimArguments: options.windowsVerbatimArguments,
          env: options.env,
        };
        return "codex-cli 0.137.0";
      },
      "win32",
      {
        PATH: "C:\\safe",
        SystemRoot: "C:\\Windows",
        OPENAI_API_KEY: "other-secret",
        BYTRO_MCP_SECRET_0: "mcp-secret",
        CODEX_DISABLE_TELEMETRY: "0",
      },
    );

    expect(version).toBe("0.137.0");
    expect(captured).toBeDefined();
    expect(captured?.executable).toBe("cmd.exe");
    expect(captured?.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    expect(captured?.args.join("\u0000")).not.toContain(binaryPath);
    expect(captured?.args[3]).toContain("^%");
    expect(captured?.args[3]).toContain("^!");
    expect(captured?.windowsVerbatimArguments).toBe(true);
    expect(captured?.timeout).toBe(5_000);
    expect(captured?.env.PATH).toBe("C:\\safe");
    expect(captured?.env.OPENAI_API_KEY).toBeUndefined();
    expect(captured?.env.BYTRO_MCP_SECRET_0).toBeUndefined();
    expect(captured?.env.CODEX_DISABLE_AUTO_UPDATE).toBe("1");
    expect(captured?.env.CODEX_DISABLE_TELEMETRY).toBe("1");
  });

  it("falls back cleanly when Codex version probing fails or times out", () => {
    expect(
      probeCodexVersion(
        "/usr/local/bin/codex",
        () => {
          throw new Error("spawn failed");
        },
        "darwin",
      ),
    ).toBeUndefined();

    expect(
      probeCodexVersion(
        "/usr/local/bin/codex",
        (_executable, _args, options) => {
          expect(options.timeout).toBe(5_000);
          throw Object.assign(new Error("timed out"), { code: "ETIMEDOUT" });
        },
        "darwin",
      ),
    ).toBeUndefined();
  });

  it("rebuilds credential-free MCP runtime TOML from unchanged persisted settings", () => {
    const authoritative = {
      stdio_private: {
        command: "private-server",
        args: ["--token", "sentinel-argv-token"],
        env: {
          API_KEY: "sentinel-stdio-key",
        },
      },
      http_private: {
        url: "https://mcp.example.test",
        headers: {
          Authorization: "Bearer sentinel-http-token",
        },
      },
    };
    const original = JSON.stringify(authoritative);
    const firstEnv: Record<string, string> = {};
    const firstProjection = projectMcpServersForRuntime(
      authoritative,
      firstEnv,
      "/runtime/mcp-launcher.mjs",
    );
    const firstToml = buildMcpTomlSection(firstProjection);

    for (const secret of [
      "sentinel-argv-token",
      "sentinel-stdio-key",
      "sentinel-http-token",
    ]) {
      expect(firstToml).not.toContain(secret);
      expect(JSON.stringify(firstEnv)).toContain(secret);
    }
    expect(firstToml).toContain("env_vars");
    expect(firstToml).toContain("env_http_headers");
    expect(JSON.stringify(authoritative)).toBe(original);

    expect(() =>
      projectMcpServersForRuntime(
        {
          private: {
            url: "https://mcp.example.test?access_token=sentinel",
          },
        },
        {},
        "/runtime/mcp-launcher.mjs",
      ),
    ).toThrow(/^Invalid remote MCP URL \(diagnosticId: [a-f0-9]{12}\)$/);

    expect(() =>
      buildMcpTomlSection({
        private: {
          url: "https://user:secret@mcp.example.test/#fragment-sentinel",
        },
      }),
    ).toThrow(/^Invalid remote MCP URL \(diagnosticId: [a-f0-9]{12}\)$/);

    const restartedEnv: Record<string, string> = {};
    const restartedProjection = projectMcpServersForRuntime(
      authoritative,
      restartedEnv,
      "/runtime/mcp-launcher.mjs",
    );
    expect(restartedProjection).toEqual(firstProjection);
    expect(restartedEnv).toEqual(firstEnv);
    expect(buildMcpTomlSection(restartedProjection)).toBe(firstToml);
    expect(JSON.stringify(authoritative)).toBe(original);
  });

  it("allocates unique non-empty TOML names for colliding MCP server keys", () => {
    const toml = buildMcpTomlSection({
      "a.b": { command: "first" },
      "a/b": { command: "second" },
      "": { command: "third" },
      server: { command: "fourth" },
    });
    const sectionNames = [
      ...toml.matchAll(/^\[mcp_servers\.([^\]]+)\]$/gm),
    ].map((match) => match[1]);

    expect(sectionNames).toHaveLength(4);
    expect(new Set(sectionNames).size).toBe(4);
    expect(sectionNames.every((name) => name.length > 0)).toBe(true);
  });

  it("does not copy global MCP credentials into the Bytro runtime projection", () => {
    const globalConfig =
      'model = "gpt-5"\n' +
      "[mcp_servers.private]\n" +
      'command = "server"\n' +
      'env = { API_KEY = "sentinel-global-key" }\n' +
      "[features]\n" +
      "goals = true\n";

    const stripped = stripCodexMcpSectionsForRuntime(globalConfig);

    expect(stripped).toContain("[features]");
    expect(stripped).toContain("goals = true");
    expect(stripped).not.toContain("sentinel-global-key");
    expect(globalConfig).toContain("sentinel-global-key");
  });

  it("cleans only reconstructable files in an owned runtime home", () => {
    const runtimeRoot = mkdtempSync(
      join(tmpdir(), "bytro-codex-projection-root-"),
    );
    const tempHome = mkdtempSync(
      join(runtimeRoot, "bytro-community-codex-2147483647-"),
    );
    const codexDir = join(tempHome, ".codex");
    const threadState = join(codexDir, "sessions", "thread.jsonl");
    mkdirSync(join(codexDir, "sessions"), { recursive: true });
    for (const name of [
      "config.toml",
      "auth.json",
      "AGENTS.md",
      "mcp-runtime-launcher.mjs",
    ]) {
      writeFileSync(join(codexDir, name), "sentinel-runtime-projection");
    }
    writeFileSync(threadState, "persistent-thread-state");

    const authorityFile = join(runtimeRoot, "mcp-servers.json");
    writeFileSync(authorityFile, "sentinel-authoritative-settings");

    try {
      expect(
        cleanupBytroCodexRuntimeProjection(
          tempHome,
          codexDir,
          true,
          join(runtimeRoot, "unrelated-community-root"),
          runtimeRoot,
        ),
      ).toBe(4);
      expect(existsSync(join(codexDir, "config.toml"))).toBe(false);
      expect(existsSync(join(codexDir, "auth.json"))).toBe(false);
      expect(readFileSync(threadState, "utf8")).toBe(
        "persistent-thread-state",
      );
      expect(readFileSync(authorityFile, "utf8")).toBe(
        "sentinel-authoritative-settings",
      );

      expect(
        cleanupBytroCodexRuntimeProjection(
          runtimeRoot,
          runtimeRoot,
          true,
          join(runtimeRoot, "unrelated-community-root"),
          runtimeRoot,
        ),
      ).toBe(0);
      expect(existsSync(authorityFile)).toBe(true);
    } finally {
      rmSync(runtimeRoot, { recursive: true, force: true });
    }
  });
});
