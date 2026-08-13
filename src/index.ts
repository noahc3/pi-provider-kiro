// Feature 1: Extension Registration
//
// Entry point that wires all features together via pi.registerProvider().

import type { Api, Model, OAuthCredentials, RefreshModelsContext } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { formatSafeError } from "./debug.js";
import { getKiroEndpoints, resolveApiRegion } from "./endpoints.js";
import { getKiroCliCredentials } from "./kiro-cli.js";
import { setExtensionContext } from "./login-ui.js";
import {
  beginKiroMeteringCollection,
  claimRootMeteringSession,
  finishKiroMeteringCollection,
  formatMeteringAmount,
  formatTurnMetering,
  releaseRootMeteringSession,
} from "./metering.js";
import { getCachedModels, isCacheStale, type KiroModel, kiroModels, updateKiroModelsCache } from "./models.js";
import type { KiroCredentials } from "./oauth.js";
import { loginKiro, refreshKiroToken } from "./oauth.js";
import { streamKiro } from "./stream.js";
import { fetchKiroUsage } from "./usage.js";

export type {
  KiroStopReasonRecord,
  KiroStopReasonSource,
  KiroTurnProvenanceInput,
} from "./diagnostics.js";
export {
  createKiroTurnProvenanceDiagnostic,
  isModeledContextOverflowStopReason,
  KIRO_MODELED_STOP_REASONS,
  KIRO_TURN_PROVENANCE_DIAGNOSTIC,
} from "./diagnostics.js";
export { resolveApiRegion } from "./endpoints.js";
export type { KiroProviderAttempts } from "./errors.js";
export { KiroApiError } from "./errors.js";
export type { KiroStreamEvent } from "./event-parser.js";
export type { KiroErrorPlane, KiroManagementErrorInfo } from "./management.js";
export {
  isKiroManagementHttpError,
  KIRO_AUTH_PLANE_DIAGNOSTIC,
  KiroManagementHttpError,
} from "./management.js";
export { KIRO_MODEL_IDS, kiroModels, resolveKiroModel } from "./models.js";
// Kiro's own error vocabulary and the predicates this provider classifies it
// with. Published so consumers can interpret a reason code without an error
// instance in hand (e.g. a persisted log line) instead of hardcoding copies of
// the literals, which drift when the service adds a code.
export type { KiroReasonCode } from "./retry.js";
export {
  CAPACITY_PATTERN,
  isCapacityError,
  isNonRetryableBodyError,
  isTooBigError,
  KIRO_REASON_CODES,
  NON_RETRYABLE_BODY_PATTERNS,
  TOO_BIG_PATTERNS,
} from "./retry.js";
export { streamKiro } from "./stream.js";
// The value vocabulary for the provenance diagnostic's `details.usage`. Exported
// alongside the stop-reason record types so a consumer can name BOTH halves of
// the payload rather than re-declaring the union it has to switch on.
export type { KiroUsage, KiroUsageProvenance, KiroUsageSource } from "./token-usage.js";

const KIRO_PROVIDER = "kiro";
const KIRO_USAGE_ENTRY = "pi-provider-kiro:session-usage";
const KIRO_USAGE_STATUS = "kiro-usage";

interface KiroSessionUsageState {
  version: 1;
  usage: number;
  requestCount: number;
  unit?: string;
  unitPlural?: string;
}

function emptySessionUsage(): KiroSessionUsageState {
  return { version: 1, usage: 0, requestCount: 0 };
}

function isSessionUsageState(value: unknown): value is KiroSessionUsageState {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<KiroSessionUsageState>;
  return (
    state.version === 1 &&
    typeof state.usage === "number" &&
    Number.isFinite(state.usage) &&
    state.usage >= 0 &&
    typeof state.requestCount === "number" &&
    Number.isInteger(state.requestCount) &&
    state.requestCount >= 0 &&
    (state.unit === undefined || typeof state.unit === "string") &&
    (state.unitPlural === undefined || typeof state.unitPlural === "string")
  );
}

function restoreSessionUsage(ctx: ExtensionContext): KiroSessionUsageState {
  let state = emptySessionUsage();
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type === "custom" && entry.customType === KIRO_USAGE_ENTRY && isSessionUsageState(entry.data)) {
      state = { ...entry.data };
    }
  }
  return state;
}

function asOAuthCredentials(credential: unknown): OAuthCredentials | undefined {
  return credential && typeof credential === "object" && (credential as OAuthCredentials).type === "oauth"
    ? (credential as OAuthCredentials)
    : undefined;
}

async function resolveUsageCredentials(
  ctx: Pick<ExtensionContext, "modelRegistry">,
): Promise<OAuthCredentials | undefined> {
  // kiro-cli credentials carry the full shape (access + region + profileArn)
  // that fetchKiroUsage needs, so prefer them. Fall back to the provider's
  // resolved access token (region/profileArn default) when kiro-cli is absent.
  const cliCredentials = getKiroCliCredentials();
  if (cliCredentials) return cliCredentials;

  const accessToken = await ctx.modelRegistry.getApiKeyForProvider(KIRO_PROVIDER);
  if (accessToken) {
    return asOAuthCredentials({ type: "oauth", access: accessToken });
  }
  return undefined;
}

function formatReset(resetAt: string | undefined): string | undefined {
  if (!resetAt) return undefined;
  const reset = new Date(resetAt);
  if (Number.isNaN(reset.getTime())) return undefined;

  const days = Math.max(0, Math.ceil((reset.getTime() - Date.now()) / 86_400_000));
  const date = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(reset);
  return days === 0 ? `resets ${date}` : `resets in ${days} days (${date})`;
}

function getCreditBucket(usage: Awaited<ReturnType<typeof fetchKiroUsage>>) {
  return usage.usageBuckets?.find((bucket) => bucket.resourceType === "CREDIT") ?? usage.usageBuckets?.[0];
}

function formatMonthlyStatus(usage: Awaited<ReturnType<typeof fetchKiroUsage>>): string {
  const credits = getCreditBucket(usage);
  if (!credits) throw new Error("Kiro returned no credit usage information");
  return credits.limitDisplay ? `${credits.usedDisplay}/${credits.limitDisplay}` : credits.usedDisplay;
}

function formatMonthlyUsage(usage: Awaited<ReturnType<typeof fetchKiroUsage>>): string {
  const credits = getCreditBucket(usage);
  if (!credits) throw new Error("Kiro returned no credit usage information");

  const total = credits.limitDisplay ? ` / ${credits.limitDisplay}` : "";
  // The service currently returns daysUntilReset=0 even when nextDateReset is
  // weeks away. Derive the countdown from the authoritative timestamp instead.
  const reset = formatReset(credits.resetAt ?? usage.resetAt);
  const details = [usage.subscriptionTitle, reset].filter(Boolean).join(" · ");
  return `Kiro credits: ${credits.usedDisplay}${total}${details ? ` (${details})` : ""}`;
}

/**
 * Host-driven catalog refresh. `oauth.modifyModels` only projects whatever the
 * cache already holds, so this is the path that actually fetches when the host
 * asks for a refresh or the cache has gone stale. The composer re-applies
 * `modifyModels` on top of the returned list, so region/profileArn projection
 * still happens here.
 *
 * Persistence uses the existing Kiro management file cache
 * (`updateKiroModelsCache` / `~/.kiro-management-models-cache.json`) rather than
 * `context.store`, so oauth/stream and host refresh share one catalog source.
 */
async function refreshKiroModels(context: RefreshModelsContext): Promise<KiroModel[]> {
  const credential = context.credential;
  const oauthCredential = credential?.type === "oauth" ? (credential as unknown as KiroCredentials) : undefined;
  const accessToken = oauthCredential?.access ?? (credential?.type === "api_key" ? credential.key : undefined);
  const region = resolveApiRegion(oauthCredential?.region);

  if (accessToken && context.allowNetwork && (context.force || isCacheStale(region))) {
    try {
      await updateKiroModelsCache(accessToken, region, oauthCredential?.profileArn);
    } catch (error) {
      // Serve the cached catalog when discovery fails.
      console.warn(`[pi-provider-kiro] Failed to refresh Kiro model catalog in ${region}: ${formatSafeError(error)}`);
    }
  }

  return getCachedModels(region);
}

export default function (pi: ExtensionAPI) {
  let rootSessionId: string | undefined;
  let sessionUsage = emptySessionUsage();
  let monthlyStatus: string | undefined;

  function updateUsageStatus(ctx: ExtensionContext, model = ctx.model): void {
    if (model?.provider !== KIRO_PROVIDER) {
      ctx.ui.setStatus(KIRO_USAGE_STATUS, undefined);
      return;
    }

    const session = formatMeteringAmount(sessionUsage);
    const month = monthlyStatus ? ` · month ${monthlyStatus}` : "";
    ctx.ui.setStatus(KIRO_USAGE_STATUS, `[Kiro: session ${session}${month}]`);
  }

  async function refreshMonthlyStatus(ctx: ExtensionContext): Promise<void> {
    try {
      const credentials = await resolveUsageCredentials(ctx);
      if (!credentials) return;
      monthlyStatus = formatMonthlyStatus(await fetchKiroUsage(credentials));
    } catch {
      // The footer is best-effort; /kiro-usage reports fetch failures explicitly.
    }
  }

  // Capture ctx for the custom TUI login component, identify the root session,
  // and restore branch-aware credit totals from the persisted session entry.
  pi.on("session_start", async (_event, ctx) => {
    setExtensionContext(ctx);
    const sessionId = ctx.sessionManager.getSessionId();
    if (claimRootMeteringSession(sessionId)) {
      rootSessionId = sessionId;
      sessionUsage = restoreSessionUsage(ctx);
      monthlyStatus = undefined;
      updateUsageStatus(ctx);
    }
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    if (rootSessionId) beginKiroMeteringCollection(ctx.sessionManager.getSessionId());
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (!rootSessionId) return;
    const summary = finishKiroMeteringCollection(ctx.sessionManager.getSessionId());
    if (!summary?.requestCount) return;

    sessionUsage = {
      version: 1,
      usage: sessionUsage.usage + summary.usage,
      requestCount: sessionUsage.requestCount + summary.requestCount,
      unit: sessionUsage.unit ?? summary.unit,
      unitPlural: sessionUsage.unitPlural ?? summary.unitPlural,
    };
    pi.appendEntry(KIRO_USAGE_ENTRY, sessionUsage);
    await refreshMonthlyStatus(ctx);
    updateUsageStatus(ctx);
    ctx.ui.notify(formatTurnMetering(summary), "info");
  });

  pi.on("model_select", (event, ctx) => {
    updateUsageStatus(ctx, event.model);
  });

  pi.on("session_tree", (_event, ctx) => {
    if (!rootSessionId) return;
    sessionUsage = restoreSessionUsage(ctx);
    updateUsageStatus(ctx);
  });

  pi.on("session_shutdown", async () => {
    if (rootSessionId) releaseRootMeteringSession(rootSessionId);
    rootSessionId = undefined;
  });

  pi.registerCommand("kiro-usage", {
    description: "Show current Kiro session and monthly credit usage",
    handler: async (_args, ctx) => {
      const session = formatMeteringAmount(sessionUsage);
      try {
        const credentials = await resolveUsageCredentials(ctx);
        if (!credentials) throw new Error("Kiro credentials not found. Run /login kiro or log in with kiro-cli.");
        const monthly = await fetchKiroUsage(credentials);
        monthlyStatus = formatMonthlyStatus(monthly);
        updateUsageStatus(ctx);
        ctx.ui.notify(`${formatMonthlyUsage(monthly)}\nKiro session: ${session}`, "info");
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Kiro session: ${session}\nUnable to fetch monthly usage: ${reason}`, "error");
      }
    },
  });

  pi.registerProvider("kiro", {
    baseUrl: getKiroEndpoints("us-east-1").runtime,
    api: "kiro-api",
    models: kiroModels,
    refreshModels: refreshKiroModels,
    oauth: {
      // Name reflects all supported auth methods: AWS Builder ID, Google, GitHub
      name: "Kiro (Builder ID / Google / GitHub)",
      login: loginKiro,
      refreshToken: refreshKiroToken,
      getApiKey: (cred: OAuthCredentials) => cred.access,
      getCliCredentials: getKiroCliCredentials,
      modifyModels: (models: Model<Api>[], cred: OAuthCredentials) => {
        const apiRegion = resolveApiRegion((cred as KiroCredentials).region);
        const cachedKiro = getCachedModels(apiRegion);
        const nonKiro = models.filter((m: Model<Api>) => m.provider !== "kiro");
        const credentialProfileArn = (cred as KiroCredentials).profileArn;
        const modifiedKiro = cachedKiro.map((m: Model<Api>) => ({
          ...m,
          baseUrl: getKiroEndpoints(apiRegion).runtime,
          kiroRegion: apiRegion,
          ...(credentialProfileArn ? { kiroProfileArn: credentialProfileArn } : {}),
        }));

        return [...nonKiro, ...modifiedKiro];
      },
      fetchUsage: fetchKiroUsage,
      // biome-ignore lint/suspicious/noExplicitAny: ProviderConfig.oauth doesn't include getCliCredentials but OAuthProviderInterface does
    } as any,
    streamSimple: streamKiro,
  });
}
