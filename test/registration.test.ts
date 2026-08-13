import { rmSync } from "node:fs";
import type { ProviderModelsStore } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getKiroCliCredentials } from "../src/kiro-cli.js";
import { resetKiroMeteringState } from "../src/metering.js";
import { KIRO_MANAGEMENT_CACHE_PATH, kiroModels } from "../src/models.js";

type ExtensionHandler = (...args: unknown[]) => unknown;

const mockPi = () => {
  const registerProvider = vi.fn();
  const registerCommand = vi.fn();
  const appendEntry = vi.fn();
  const handlers = new Map<string, ExtensionHandler>();
  const on = vi.fn((event: string, handler: ExtensionHandler) => handlers.set(event, handler));
  return {
    pi: { registerProvider, registerCommand, appendEntry, on } as unknown as ExtensionAPI,
    registerProvider,
    registerCommand,
    appendEntry,
    handlers,
  };
};

beforeEach(() => resetKiroMeteringState());

/** Minimal host store fixture — refreshKiroModels intentionally uses the Kiro file cache instead. */
const mockProviderModelsStore = (): ProviderModelsStore => ({
  read: vi.fn(async () => undefined),
  write: vi.fn(async () => {}),
  delete: vi.fn(async () => {}),
});

describe("Feature 1: Extension Registration", () => {
  it("exports a default function", async () => {
    const mod = await import("../src/index.js");
    expect(typeof mod.default).toBe("function");
  });

  // Consumers that classify a reason code without an error instance in hand
  // (a persisted log line, say) need the vocabulary through the package entry
  // point, not a deep import into src/retry.js.
  it("exposes Kiro's reason codes and classification predicates from the entry point", async () => {
    const mod = await import("../src/index.js");
    const retry = await import("../src/retry.js");

    expect(mod.KIRO_REASON_CODES).toBe(retry.KIRO_REASON_CODES);
    expect(mod.TOO_BIG_PATTERNS).toBe(retry.TOO_BIG_PATTERNS);
    expect(mod.NON_RETRYABLE_BODY_PATTERNS).toBe(retry.NON_RETRYABLE_BODY_PATTERNS);
    expect(mod.CAPACITY_PATTERN).toBe(retry.CAPACITY_PATTERN);
    expect(mod.isTooBigError).toBe(retry.isTooBigError);
    expect(mod.isNonRetryableBodyError).toBe(retry.isNonRetryableBodyError);
    expect(mod.isCapacityError).toBe(retry.isCapacityError);
  });

  it("keeps predicate behaviour unchanged through the entry point", async () => {
    const { KIRO_REASON_CODES, isCapacityError, isNonRetryableBodyError, isTooBigError } = await import(
      "../src/index.js"
    );

    expect(isTooBigError(413, "")).toBe(true);
    expect(isTooBigError(400, KIRO_REASON_CODES.CONTENT_LENGTH_EXCEEDS_THRESHOLD)).toBe(true);
    expect(isTooBigError(400, KIRO_REASON_CODES.REQUEST_BODY_INVALID)).toBe(false);
    expect(isNonRetryableBodyError(KIRO_REASON_CODES.MONTHLY_REQUEST_COUNT)).toBe(true);
    expect(isNonRetryableBodyError(KIRO_REASON_CODES.INSUFFICIENT_MODEL_CAPACITY)).toBe(false);
    expect(isCapacityError(KIRO_REASON_CODES.INSUFFICIENT_MODEL_CAPACITY)).toBe(true);
    expect(isCapacityError(KIRO_REASON_CODES.MONTHLY_REQUEST_COUNT)).toBe(false);
  });

  it("calls registerProvider with 'kiro'", async () => {
    const mod = await import("../src/index.js");
    const { pi, registerProvider } = mockPi();

    mod.default(pi);

    expect(registerProvider).toHaveBeenCalledOnce();
    expect(registerProvider.mock.calls[0][0]).toBe("kiro");
  });

  it("registers 15 models", async () => {
    const mod = await import("../src/index.js");
    const { pi, registerProvider } = mockPi();
    mod.default(pi);

    const config = registerProvider.mock.calls[0][1];
    expect(config.models).toHaveLength(15);
  });

  it("preserves the existing OAuth and kiro-cli credential contract", async () => {
    const mod = await import("../src/index.js");
    const { pi, registerProvider } = mockPi();
    mod.default(pi);

    const config = registerProvider.mock.calls[0][1];
    expect(config.oauth.name).toBe("Kiro (Builder ID / Google / GitHub)");
    expect(typeof config.oauth.login).toBe("function");
    expect(typeof config.oauth.refreshToken).toBe("function");
    expect(config.oauth.getCliCredentials).toBe(getKiroCliCredentials);
    expect(config.oauth.getApiKey({ access: "existing-access-token" })).toBe("existing-access-token");
    expect(typeof config.oauth.fetchUsage).toBe("function");
  });

  it("registers a streamSimple handler", async () => {
    const mod = await import("../src/index.js");
    const { pi, registerProvider } = mockPi();
    mod.default(pi);

    const config = registerProvider.mock.calls[0][1];
    expect(typeof config.streamSimple).toBe("function");
  });

  it("registers /kiro-usage and displays precise monthly credits", async () => {
    const mod = await import("../src/index.js");
    const { pi, registerCommand } = mockPi();
    mod.default(pi);

    const command = registerCommand.mock.calls.find(([name]) => name === "kiro-usage")?.[1];
    expect(command?.description).toContain("session and monthly credit usage");

    const notify = vi.fn();
    // Relative so the countdown assertion below cannot rot once a fixed date passes.
    const nextDateReset = Math.floor(Date.now() / 1000) + 30 * 86_400;
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        // Usage now resolves the profile ARN first via ListAvailableProfiles.
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              profiles: [{ arn: "arn:aws:codewhisperer:us-east-1:123456789012:profile/test" }],
            }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              nextDateReset,
              daysUntilReset: 0,
              subscriptionInfo: { subscriptionTitle: "KIRO PRO" },
              usageBreakdown: {
                resourceType: "CREDIT",
                displayName: "Credits",
                currentUsage: 12,
                currentUsageWithPrecision: 12.375,
                currentOverages: 0,
                usageLimit: 1000,
                usageLimitWithPrecision: 1000,
                nextDateReset,
                overageCharges: 0,
              },
            }),
        }),
    );

    await command.handler("", {
      modelRegistry: {
        getApiKeyForProvider: vi.fn().mockResolvedValue("token"),
      },
      ui: { notify, setStatus: vi.fn() },
    });

    const message = notify.mock.calls[0]?.[0] as string;
    expect(message).toMatch(
      /^Kiro credits: 12\.38 \/ 1000 \(KIRO PRO · resets in \d+ days \(.+\)\)\nKiro session: 0 credits$/,
    );
    expect(message).not.toContain("resets in 0 days");
    vi.unstubAllGlobals();
  });

  it("shows persisted session usage when monthly usage cannot be fetched", async () => {
    const mod = await import("../src/index.js");
    const { pi, registerCommand, handlers } = mockPi();
    mod.default(pi);

    const notify = vi.fn();
    const setStatus = vi.fn();
    const ctx = {
      model: { provider: "kiro" },
      modelRegistry: {
        getApiKeyForProvider: vi.fn().mockResolvedValue(undefined),
      },
      sessionManager: {
        getSessionId: () => "root-session",
        getBranch: () => [
          {
            type: "custom",
            customType: "pi-provider-kiro:session-usage",
            data: { version: 1, usage: 2.5, requestCount: 4, unit: "credit", unitPlural: "credits" },
          },
        ],
      },
      ui: { notify, setStatus },
    };
    await handlers.get("session_start")?.({}, ctx);

    const command = registerCommand.mock.calls.find(([name]) => name === "kiro-usage")?.[1];
    await command.handler("", ctx);

    expect(notify).toHaveBeenCalledWith(
      expect.stringMatching(/^Kiro session: 2\.5 credits\n(Unable to fetch monthly usage:|Kiro credentials not found)/),
      "error",
    );
  });

  it("persists session credits and updates the Kiro-only footer after the root agent settles", async () => {
    const mod = await import("../src/index.js");
    const { pi, handlers, appendEntry } = mockPi();
    mod.default(pi);

    const notify = vi.fn();
    const setStatus = vi.fn();
    const ctx = {
      model: { provider: "kiro" },
      modelRegistry: {
        getApiKeyForProvider: vi.fn().mockResolvedValue(undefined),
      },
      sessionManager: { getSessionId: () => "root-session", getBranch: () => [] },
      ui: { notify, setStatus },
    };
    await handlers.get("session_start")?.({}, ctx);
    expect(setStatus).toHaveBeenLastCalledWith("kiro-usage", "[Kiro: session 0 credits]");
    await handlers.get("before_agent_start")?.({}, ctx);

    const { recordKiroMetering } = await import("../src/metering.js");
    recordKiroMetering({ credits: 0.25, unit: "credit", unitPlural: "credits" });
    recordKiroMetering({ credits: 0.5, unit: "credit", unitPlural: "credits" });
    await handlers.get("agent_settled")?.({}, ctx);

    expect(appendEntry).toHaveBeenCalledWith(
      "pi-provider-kiro:session-usage",
      expect.objectContaining({ version: 1, usage: 0.75, requestCount: 2 }),
    );
    expect(setStatus).toHaveBeenLastCalledWith("kiro-usage", "[Kiro: session 0.75 credits]");
    expect(notify).toHaveBeenCalledWith("Kiro turn usage: 0.75 credits", "info");
  });

  it("restores branch usage and only shows the footer for Kiro models", async () => {
    const mod = await import("../src/index.js");
    const { pi, handlers } = mockPi();
    mod.default(pi);

    const setStatus = vi.fn();
    const ctx = {
      model: { provider: "kiro" },
      sessionManager: {
        getSessionId: () => "root-session",
        getBranch: () => [
          {
            type: "custom",
            customType: "pi-provider-kiro:session-usage",
            data: { version: 1, usage: 1.25, requestCount: 3, unit: "credit", unitPlural: "credits" },
          },
        ],
      },
      ui: { setStatus },
    };
    await handlers.get("session_start")?.({}, ctx);
    expect(setStatus).toHaveBeenLastCalledWith("kiro-usage", "[Kiro: session 1.25 credits]");

    await handlers.get("model_select")?.({ model: { provider: "openai" } }, ctx);
    expect(setStatus).toHaveBeenLastCalledWith("kiro-usage", undefined);
    await handlers.get("model_select")?.({ model: { provider: "kiro" } }, ctx);
    expect(setStatus).toHaveBeenLastCalledWith("kiro-usage", "[Kiro: session 1.25 credits]");
  });

  it("uses kiro-api as the api type", async () => {
    const mod = await import("../src/index.js");
    const { pi, registerProvider } = mockPi();
    mod.default(pi);

    expect(registerProvider.mock.calls[0][1].api).toBe("kiro-api");
  });

  describe("refreshModels", () => {
    beforeEach(() => {
      rmSync(KIRO_MANAGEMENT_CACHE_PATH, { force: true });
    });

    afterEach(() => {
      vi.unstubAllGlobals();
      rmSync(KIRO_MANAGEMENT_CACHE_PATH, { force: true });
    });

    const refreshModels = async () => {
      const mod = await import("../src/index.js");
      const { pi, registerProvider } = mockPi();
      mod.default(pi);
      return registerProvider.mock.calls[0][1].refreshModels;
    };

    it("serves the bootstrap catalog without a credential and never hits the network", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      const models = await (await refreshModels())({
        allowNetwork: true,
        force: true,
        store: mockProviderModelsStore(),
      });

      expect(fetchMock).not.toHaveBeenCalled();
      expect(models).toEqual(kiroModels);
    });

    it("fetches the regional catalog when forced with an OAuth credential", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ models: [{ modelId: "claude-opus-4.8" }, { modelId: "openai-gpt-5.6" }] }),
      });
      vi.stubGlobal("fetch", fetchMock);

      const models = await (await refreshModels())({
        allowNetwork: true,
        force: true,
        store: mockProviderModelsStore(),
        credential: {
          type: "oauth",
          access: "refresh-access",
          refresh: "r",
          expires: 0,
          region: "eu-west-1",
          profileArn: "arn:aws:codewhisperer:eu-central-1:123456789012:profile/test",
        },
      });

      expect(fetchMock).toHaveBeenCalledOnce();
      expect(String(fetchMock.mock.calls[0][0])).toContain("https://management.eu-central-1.kiro.dev/");
      expect(models.map((model: { id: string }) => model.id)).toEqual(["claude-opus-4-8", "openai-gpt-5-6"]);
    });

    it("falls back to the cached catalog when discovery fails", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));

      const models = await (await refreshModels())({
        allowNetwork: true,
        force: true,
        store: mockProviderModelsStore(),
        credential: { type: "oauth", access: "a", refresh: "r", expires: 0, region: "us-east-1", profileArn: "arn:p" },
      });

      expect(models).toEqual(kiroModels);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("Failed to refresh Kiro model catalog"));
      warn.mockRestore();
    });
  });

  it.each([
    { ssoRegion: "eu-west-1", expectedApiRegion: "eu-central-1" },
    { ssoRegion: "eu-west-2", expectedApiRegion: "eu-central-1" },
    { ssoRegion: "eu-north-1", expectedApiRegion: "eu-central-1" },
    { ssoRegion: "us-east-1", expectedApiRegion: "us-east-1" },
    { ssoRegion: undefined, expectedApiRegion: "us-east-1" },
  ])("modifyModels maps SSO region $ssoRegion to API region $expectedApiRegion", async ({
    ssoRegion,
    expectedApiRegion,
  }) => {
    const mod = await import("../src/index.js");
    const { pi, registerProvider } = mockPi();
    mod.default(pi);

    const config = registerProvider.mock.calls[0][1];
    const models = kiroModels.map((m) => ({ ...m, provider: "kiro", api: "kiro-api", baseUrl: "old" }));
    const creds = { access: "x", refresh: "x", expires: 0, clientId: "", clientSecret: "", region: ssoRegion };
    const modified = config.oauth.modifyModels(models, creds);
    expect(modified[0].baseUrl).toBe(`https://runtime.${expectedApiRegion}.kiro.dev/`);
  });

  it("modifyModels carries the OAuth profile ARN on Kiro models only", async () => {
    const mod = await import("../src/index.js");
    const { pi, registerProvider } = mockPi();
    mod.default(pi);

    const config = registerProvider.mock.calls[0][1];
    const profileArn = "arn:aws:codewhisperer:us-east-1:123456789012:profile/social";
    const models = kiroModels.map((model) => ({ ...model, baseUrl: "old" }));
    const creds = {
      access: "social-access",
      refresh: "social-refresh|desktop",
      expires: Date.now() + 60_000,
      clientId: "",
      clientSecret: "",
      region: "us-east-1",
      authMethod: "desktop",
      profileArn,
    };

    const modified = config.oauth.modifyModels(models, creds);

    expect(modified).toHaveLength(models.length);
    expect(modified.every((model: { kiroProfileArn?: string }) => model.kiroProfileArn === profileArn)).toBe(true);
  });

  it("modifyModels does not apply a hardcoded regional allowlist", async () => {
    const mod = await import("../src/index.js");
    const { pi, registerProvider } = mockPi();
    mod.default(pi);

    const config = registerProvider.mock.calls[0][1];
    const models = kiroModels.map((m) => ({ ...m, provider: "kiro", api: "kiro-api", baseUrl: "old" }));
    const creds = { access: "x", refresh: "x", expires: 0, clientId: "", clientSecret: "", region: "eu-west-1" };
    const modified = config.oauth.modifyModels(models, creds);
    const ids = modified.map((m: { id: string }) => m.id);
    expect(modified).toHaveLength(models.length);
    expect(ids).toContain("deepseek-3-2");
    expect(ids).toContain("claude-sonnet-4-6");
  });

  it("modifyModels preserves non-kiro provider models", async () => {
    const mod = await import("../src/index.js");
    const { pi, registerProvider } = mockPi();
    mod.default(pi);

    const config = registerProvider.mock.calls[0][1];
    const kiro = kiroModels.map((m) => ({ ...m, provider: "kiro", api: "kiro-api", baseUrl: "old" }));
    const codex = [
      {
        id: "gpt-5.4",
        name: "GPT-5.4",
        provider: "openai-codex",
        api: "openai",
        baseUrl: "https://example.com",
      },
    ];
    const creds = { access: "x", refresh: "x", expires: 0, clientId: "", clientSecret: "", region: "eu-west-1" };
    const modified = config.oauth.modifyModels([...kiro, ...codex], creds);

    expect(modified).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "gpt-5.4",
          provider: "openai-codex",
          baseUrl: "https://example.com",
        }),
      ]),
    );
  });

  // Extension **entry module** surface — not an npm package entry point.
  //
  // `pi.extensions: ["./dist/index.js"]` tells the pi host which module to load.
  // It is not a bare-specifier entry: `package.json` declares no `main`,
  // `exports`, or `types`, and the build emits no declarations, so
  // `import { validateKiroConversation } from "pi-provider-kiro"` does not
  // resolve from the published tarball (verified 2026-08-11 by packing and
  // importing in an isolated consumer: `ERR_MODULE_NOT_FOUND`). This pins that
  // the symbols leave this module; giving them a resolvable package entry is a
  // packaging change owned separately.
  it("re-exports the history validator surface from the entry module", async () => {
    const mod = await import("../src/index.js");
    for (const name of [
      "validateKiroConversation",
      "validateKiroToolStructure",
      "repairKiroConversation",
      "kiroConversationEntries",
      "isKiroToolStructureRule",
    ] as const) {
      expect(typeof mod[name], name).toBe("function");
    }
    expect(mod.KiroValidationRule.NON_EMPTY_USER_MESSAGE).toBe("NON_EMPTY_USER_MESSAGE");
    expect(mod.KIRO_TOOL_STRUCTURE_RULES).toHaveLength(3);
    expect(mod.KIRO_VALIDATION_MESSAGES.NON_EMPTY_USER_MESSAGE).toBe(
      "User messages must have either content or tool results",
    );
    expect(mod.SYNTHETIC_FAILED_TOOL_RESULT_TEXT).toBe("Tool use was interrupted and did not produce a result.");
    expect(mod.EMPTY_CONTENT_PLACEHOLDER).toBe("Please proceed with the task.");
  });
});
