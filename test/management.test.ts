import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchKiroModelCatalog,
  isKiroManagementHttpError,
  KiroManagementHttpError,
  listAvailableModels,
  resetKiroProfileArnCache,
  resolveKiroProfileArn,
} from "../src/management.js";

const auth = { accessToken: "test-access-token", region: "us-east-1" };
const profileArn = "arn:aws:codewhisperer:us-east-1:123456789012:profile/test";

afterEach(() => {
  resetKiroProfileArnCache();
  vi.unstubAllGlobals();
});

describe("Kiro management control plane", () => {
  it("resolves a profile through the management host", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ profiles: [{ arn: profileArn }] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(resolveKiroProfileArn(auth)).resolves.toBe(profileArn);
    await expect(resolveKiroProfileArn(auth)).resolves.toBe(profileArn);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, request] = fetchMock.mock.calls[0];
    expect(url).toBe("https://management.us-east-1.kiro.dev/List-Available-Profiles");
    expect(request.method).toBe("POST");
    expect(request.headers["Content-Type"]).toBe("application/json");
    expect(request.headers["X-Amz-Target"]).toBeUndefined();
    expect(JSON.parse(request.body)).toEqual({});
  });

  it("returns the current catalog shape, including Fable metadata", async () => {
    const fable = {
      modelId: "claude-fable-5",
      tokenLimits: { maxInputTokens: 1_000_000, maxOutputTokens: 128_000 },
      additionalModelRequestFieldsSchema: {
        type: "object",
        properties: {
          output_config: {
            type: "object",
            properties: { effort: { enum: ["low", "medium", "high", "xhigh", "max"] } },
          },
        },
      },
    };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ models: [fable], defaultModelId: "claude-fable-5" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const catalog = await fetchKiroModelCatalog(auth, profileArn);

    expect(catalog.models).toEqual([fable]);
    expect(catalog.defaultModelId).toBe("claude-fable-5");
    const [rawUrl, request] = fetchMock.mock.calls[0];
    const url = new URL(rawUrl);
    expect(`${url.origin}${url.pathname}`).toBe("https://management.us-east-1.kiro.dev/List-Available-Models");
    expect(request.method).toBe("GET");
    expect(request.headers["X-Amz-Target"]).toBeUndefined();
    expect(Object.fromEntries(url.searchParams)).toEqual({ origin: "KIRO_CLI", profileArn });
  });

  it("surfaces a management failure without trying a fallback host", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      statusText: "Service Unavailable",
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(listAvailableModels(auth, profileArn)).rejects.toThrow(
      "Kiro management ListAvailableModels failed in us-east-1: 503 Service Unavailable",
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toContain("https://management.us-east-1.kiro.dev/List-Available-Models?");
  });
});

describe("management-plane error typing", () => {
  const managementFailure = (status: number, statusText?: string) => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status, statusText });
    vi.stubGlobal("fetch", fetchMock);
    return resolveKiroProfileArn(auth);
  };

  // Scope note: this asserts the symbols leave `src/index.ts`, the module
  // esbuild bundles into `dist/index.js` — the file `package.json`'s
  // `pi.extensions` tells the pi host to load. It is NOT proof that
  // `import { KiroManagementHttpError } from "pi-provider-kiro"` resolves for an
  // npm consumer: `package.json` declares no `main`, `types`, or `exports`, so a
  // bare specifier cannot resolve and no `.d.ts` ships. Establishing that
  // contract needs packed-tarball coverage and belongs to the packaging change,
  // not here.
  it("is re-exported from the extension entry module", async () => {
    const entry = await import("../src/index.js");

    expect(entry.KiroManagementHttpError).toBe(KiroManagementHttpError);
    expect(typeof entry.isKiroManagementHttpError).toBe("function");

    const error = await managementFailure(403, "Forbidden").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(entry.KiroManagementHttpError);
    expect(entry.isKiroManagementHttpError(error)).toBe(true);
  });

  it("carries status and the plane discriminator on 401 and 403", async () => {
    for (const status of [401, 403]) {
      const error = await managementFailure(status, "Forbidden").catch((e: unknown) => e);

      expect(error).toBeInstanceOf(KiroManagementHttpError);
      const typed = error as KiroManagementHttpError;
      expect(typed.status).toBe(status);
      expect(typed.plane).toBe("management");
      expect(typed.name).toBe("KiroManagementHttpError");
      expect(typed).toBeInstanceOf(Error);
      resetKiroProfileArnCache();
      vi.unstubAllGlobals();
    }
  });

  it("distinguishes a runtime 403 from a management 403 without reading .message", async () => {
    const managementError = (await managementFailure(403, "Forbidden").catch((e: unknown) => e)) as Error;
    // Exactly what src/stream.ts throws on the runtime plane today.
    const runtimeError = new Error(
      'Kiro API error: 403 Forbidden {"message":"The bearer token included in the request is invalid.","reason":null}',
    );

    expect(isKiroManagementHttpError(managementError)).toBe(true);
    expect(isKiroManagementHttpError(runtimeError)).toBe(false);
    expect((managementError as KiroManagementHttpError).plane).toBe("management");
    expect((runtimeError as Partial<KiroManagementHttpError>).plane).toBeUndefined();
  });

  it("recognises a management error from a duplicate copy of this package", () => {
    // A bundled consumer plus a node_modules copy yield two distinct classes;
    // instanceof alone would reject a genuine management error from the other.
    class ForeignKiroManagementHttpError extends Error {
      readonly plane = "management" as const;
      constructor(
        message: string,
        readonly status: number,
      ) {
        super(message);
      }
    }
    const foreign = new ForeignKiroManagementHttpError(
      "Kiro management ListAvailableProfiles failed in us-east-1: 403",
      403,
    );

    expect(foreign).not.toBeInstanceOf(KiroManagementHttpError);
    expect(isKiroManagementHttpError(foreign)).toBe(true);
  });

  it("narrows to the data fields only, not to the class methods", async () => {
    const error: unknown = await managementFailure(403, "Forbidden").catch((e: unknown) => e);

    if (!isKiroManagementHttpError(error)) throw new Error("expected a management error");
    expect(error.status).toBe(403);
    expect(error.plane).toBe("management");
    expect(error.refreshAttempted).toBe(false);
    // A foreign copy's error passes the guard but carries no methods, so the
    // narrowed type must not offer one — this would throw at runtime.
    // @ts-expect-error markRefreshAttempted is absent from KiroManagementErrorInfo
    expect(error.markRefreshAttempted).toBeTypeOf("function");
  });

  it("rejects non-errors and unrelated errors", () => {
    expect(isKiroManagementHttpError(undefined)).toBe(false);
    expect(isKiroManagementHttpError({ plane: "management", status: 403 })).toBe(false);
    expect(isKiroManagementHttpError(new Error("boom"))).toBe(false);
  });

  it("keeps the existing message text byte-identical", async () => {
    const withStatusText = (await managementFailure(403, "Forbidden").catch((e: unknown) => e)) as Error;
    expect(withStatusText.message).toBe("Kiro management ListAvailableProfiles failed in us-east-1: 403 Forbidden");
    resetKiroProfileArnCache();
    vi.unstubAllGlobals();

    // Empty statusText contributes no trailing space — preserve that quirk.
    const withoutStatusText = (await managementFailure(401, "").catch((e: unknown) => e)) as Error;
    expect(withoutStatusText.message).toBe("Kiro management ListAvailableProfiles failed in us-east-1: 401");
  });

  it("reports refreshAttempted only after a refresh was tried", async () => {
    const error = (await managementFailure(403, "Forbidden").catch((e: unknown) => e)) as KiroManagementHttpError;

    expect(error.refreshAttempted).toBe(false);
    expect(error.markRefreshAttempted()).toBe(error);
    expect(error.refreshAttempted).toBe(true);
    // Flagging must not disturb the message contract or the discriminator.
    expect(error.message).toBe("Kiro management ListAvailableProfiles failed in us-east-1: 403 Forbidden");
    expect(error.plane).toBe("management");
  });
});
