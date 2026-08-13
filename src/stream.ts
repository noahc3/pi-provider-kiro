// ABOUTME: Core streaming integration for Kiro API requests and responses.
// ABOUTME: Handles request building, retry logic, event parsing, and token counting.

import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
  ImageContent,
  Model,
  SimpleStreamOptions,
  TextContent,
  ThinkingContent,
  ToolCall,
  ToolResultMessage,
} from "@earendil-works/pi-ai";
import * as PiAi from "@earendil-works/pi-ai";
import { UniversalEventStreamMarshaller } from "@smithy/core/event-streams";
import type { Message } from "@smithy/types";
import { parseBracketToolCalls } from "./bracket-tool-parser.js";
import { debugEnabled, debugLog, formatSafeError, redactSensitiveText } from "./debug.js";
import {
  buildKiroAdditionalModelRequestFields,
  getKiroEffortConfig,
  type KiroAdditionalModelRequestFields,
} from "./effort.js";
import { getKiroEndpoints, getKiroRegionFromEndpoint } from "./endpoints.js";
import { extractKiroReasonCode, KiroApiError, parseRetryAfterMs } from "./errors.js";
import { parseKiroEvent } from "./event-parser.js";
import {
  addPlaceholderTools,
  assertHistoryWithinLimit,
  HISTORY_LIMIT,
  HISTORY_LIMIT_CONTEXT_WINDOW,
  prepareHistory,
} from "./history.js";
import { getKiroCliCredentials, getKiroCliCredentialsAllowExpired, refreshViaKiroCli } from "./kiro-cli.js";
import {
  invalidateKiroProfileArn,
  KIRO_AUTH_PLANE_DIAGNOSTIC,
  type KiroManagementAuth,
  KiroManagementHttpError,
  resetKiroProfileArnCache,
  resolveKiroProfileArn,
} from "./management.js";
import { recordKiroMetering } from "./metering.js";
import { resolveKiroModel } from "./models.js";
import {
  capacityRetryConfig,
  exponentialBackoff,
  firstTokenTimeoutForModel,
  isCapacityError,
  isNonRetryableBodyError,
  isTooBigError,
  MAX_RETRY_DELAY,
} from "./retry.js";
import { ThinkingTagParser } from "./thinking-parser.js";
import { countTokens } from "./tokenizer.js";
import {
  buildHistory,
  convertImagesToKiro,
  convertToolsToKiro,
  EMPTY_CONTENT_PLACEHOLDER,
  extractImages,
  getContentText,
  type KiroHistoryEntry,
  type KiroImage,
  type KiroToolResult,
  type KiroToolSpec,
  type KiroUserInputMessage,
  normalizeMessages,
  sanitizeSurrogates,
  TOOL_RESULT_LIMIT,
  truncate,
} from "./transform.js";
import { TRUNCATION_NOTICE, wasPreviousResponseTruncated } from "./truncation.js";

const CAPACITY_LOG_DIR = join(homedir(), ".pi", "logs");
const CAPACITY_LOG_FILE = join(CAPACITY_LOG_DIR, "capacity-retries.log");

const eventStreamMarshaller = new UniversalEventStreamMarshaller({
  utf8Encoder: (input: Uint8Array) => new TextDecoder().decode(input),
  utf8Decoder: (input: string) => new TextEncoder().encode(input),
});

let capacityLogDirCreated = false;

function logCapacityEvent(message: string): void {
  // Fire-and-forget async logging to avoid blocking the event loop
  (async () => {
    try {
      if (!capacityLogDirCreated) {
        await mkdir(CAPACITY_LOG_DIR, { recursive: true });
        capacityLogDirCreated = true;
      }
      await appendFile(CAPACITY_LOG_FILE, `${new Date().toISOString()} ${message}\n`);
    } catch {
      // best-effort logging, don't break the provider
    }
  })();
}

/** Delay that rejects early if the abort signal fires. */
function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

interface KiroRequest {
  conversationState: {
    chatTriggerType: "MANUAL";
    agentTaskType: "vibe";
    conversationId: string;
    currentMessage: { userInputMessage: KiroUserInputMessage };
    history?: KiroHistoryEntry[];
  };
  additionalModelRequestFields?: KiroAdditionalModelRequestFields;
  profileArn: string;
  agentMode?: string;
}
interface KiroToolCallState {
  toolUseId: string;
  name: string;
  input: string;
}

let skipProfileResolutionForTests = false;
const TEST_PROFILE_ARN = "arn:aws:codewhisperer:us-east-1:000000000000:profile/test";

/** Reset profile resolution state — exported for stream tests. */
export function resetProfileArnCache(resolved = false): void {
  resetKiroProfileArnCache();
  skipProfileResolutionForTests = resolved;
}

/**
 * Resolve the profile ARN on a management call made *after* a credential
 * refresh, flagging any management failure as refresh-already-attempted.
 *
 * A 401/403 here means the freshly-refreshed credential was itself rejected, so
 * a consumer must not read it as a first-contact auth error it can recover from
 * by refreshing again.
 */
async function resolveProfileArnAfterRefresh(auth: KiroManagementAuth): Promise<string> {
  try {
    return await resolveKiroProfileArn(auth);
  } catch (error) {
    // instanceof, not the structural guard: this error can only come from the
    // module-local management.ts, so it is always the local class.
    if (error instanceof KiroManagementHttpError) throw error.markRefreshAttempted();
    throw error;
  }
}

/**
 * Pluralise an observed-attempt count for a diagnostic. The count is what was
 * actually seen, not the configured retry budget: the two diverge whenever a
 * 403 refresh, a timeout or a mid-stream error already spent part of the shared
 * budget, and a diagnostic that exists to explain a silent failure must not
 * itself assert something that did not happen.
 *
 * Deliberately not worded as "consecutive": the degenerate attempts need not be
 * adjacent. A 403 credential refresh or a mid-stream error can land between two
 * of them and spend the same shared budget, so an unqualified count is the only
 * claim the counter can actually support.
 */
function describeAttempts(count: number): string {
  return count === 1 ? "1 attempt" : `${count} attempts`;
}

/**
 * Cap for wire-derived text quoted into a persisted `errorMessage`. The echoed
 * response and the tool names both come from the model, and this string is
 * written into the assistant record, so neither may be quoted unbounded: the
 * echo pattern `/^\s*(continue|\.+)\s*$/i` admits an arbitrarily long run of
 * dots. Matches the 200-char cap already used for raw tool input in
 * `emitToolCall`'s parse warning below.
 */
const DIAGNOSTIC_QUOTE_LIMIT = 200;

/**
 * INVARIANT: no unbounded integer may be interpolated into a persisted
 * `errorMessage`. Consumers classify that string by pattern-matching its text,
 * and the predicate in the wild (Kermes `isRetryableStreamError`) matches bare
 * `429|500|502|503|504` with NO word boundary. So a `(5000 chars total)`
 * annotation makes a diagnostic that says "terminal, do not retry" read as a
 * transient HTTP 500 and get suppressed — precisely the silent failure these
 * diagnostics exist to defeat, reintroduced by the diagnostic itself.
 *
 * Hence the truncation marker carries no length: the exact length goes to
 * `console.warn`, which no classifier reads. The only integer these diagnostics
 * interpolate is the observed-attempt count, bounded by `maxRetries + 1` = 4.
 *
 * Residual: a tool NAME is model-chosen and quoted verbatim, so the invariant
 * holds only for the integers this code composes — not for wire text. A tool
 * called `set_timeout` matches that predicate's `timeout` alternative, and one
 * called `http500_probe` matches the bare `500` alternative just as the removed
 * `(5000 chars total)` annotation did. Mangling the name would defeat the point
 * of reporting which call was lost, so it is quoted as received and the
 * collision is accepted.
 */
function clampForDiagnostic(text: string): string {
  return text.length <= DIAGNOSTIC_QUOTE_LIMIT ? text : `${text.slice(0, DIAGNOSTIC_QUOTE_LIMIT)}… (truncated)`;
}

/**
 * What the MESSAGE carries, for the exhausted-empty-response diagnostic. "No
 * text and no tool calls" does NOT imply empty content: a reasoning turn that
 * emits only `thinkingText` and then ends is degenerate by that test while
 * `output.content` still holds its thinking block, and a `ThinkingTagParser`
 * turn can leave a zero-length text block behind. Claiming `empty content`
 * there would assert something not observed.
 *
 * `residue` distinguishes blocks this attempt produced from blocks a DISCARDED
 * attempt left behind. `output.content` is reset on the degenerate retry but not
 * on the mid-stream-error retry, while `textBlockIndex` is per-attempt — so a
 * turn that streamed text and then failed, retried, and came back empty ends up
 * with `hasText === false` over a content array that still holds the earlier
 * attempt's text. Wording that as "returning only text content" flatly
 * contradicts the "no text" clause in the same sentence, so the two cases must
 * read differently.
 *
 * Block TYPES only, never a count: a count is an unbounded integer, which the
 * invariant above forbids. The type vocabulary is pi's own fixed set of content
 * discriminants, so it carries no digits and no wire-controlled text.
 */
function describeReturnedContent(content: AssistantMessage["content"], residue: boolean): string {
  const kinds = [...new Set(content.map((block) => block.type))].sort();
  if (kinds.length === 0) return "returning empty content";
  const joined = kinds.join(" and ");
  return residue
    ? `returning only ${joined} content left by earlier discarded attempts`
    : `returning only ${joined} content`;
}

function emitToolCall(
  state: KiroToolCallState,
  output: AssistantMessage,
  stream: AssistantMessageEventStream,
): boolean {
  if (!state.input.trim()) {
    // Kiro API omits the input payload when the model calls a tool with no
    // arguments (e.g. mcp({})). Treat empty input as an empty object rather
    // than skipping — these are valid zero-arg tool calls, not truncations.
    state.input = "{}";
  }

  let args: Record<string, unknown>;
  try {
    args = JSON.parse(state.input) as Record<string, unknown>;
  } catch (e) {
    // Returning false drops the call: nothing is pushed into `output.content`,
    // so the call the model made never reaches the agent. Callers record the
    // name in `droppedToolCalls` so the turn can carry an `errorMessage` about
    // it — a console warning is invisible to whoever reads the transcript.
    console.warn(
      `[pi-provider-kiro] Failed to parse tool input for "${state.name}" (toolUseId: ${state.toolUseId}): ${formatSafeError(e)}. Raw input (${state.input.length} chars): ${redactSensitiveText(state.input.substring(0, 200))}`,
    );
    return false;
  }

  const contentIndex = output.content.length;
  const toolCall: ToolCall = { type: "toolCall", id: state.toolUseId, name: state.name, arguments: args };
  output.content.push(toolCall);
  stream.push({ type: "toolcall_start", contentIndex, partial: output });
  stream.push({ type: "toolcall_delta", contentIndex, delta: state.input, partial: output });
  stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: output });
  return true;
}

export function streamKiro(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  // pi-ai's barrel re-exports the class as type-only before the runtime class re-export, so
  // a named import of AssistantMessageEventStream resolves to a type. Read it from the
  // namespace import to get the actual constructor. Replaces the removed
  // createAssistantMessageEventStream() factory (gone in @oh-my-pi/pi-ai).
  const StreamCtor = (PiAi as unknown as { AssistantMessageEventStream: new () => AssistantMessageEventStream })
    .AssistantMessageEventStream;
  const stream = new StreamCtor();
  (async () => {
    const output: AssistantMessage = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };
    try {
      const initialAccessToken = options?.apiKey;
      if (!initialAccessToken) throw new Error("Kiro credentials not set. Run /login kiro or install kiro-cli.");
      let accessToken: string = initialAccessToken;
      const modelMetadata = model as Model<Api> & {
        kiroModelId?: string;
        kiroRegion?: string;
        kiroProfileArn?: string;
        additionalModelRequestFieldsSchema?: Record<string, unknown>;
      };
      const region = modelMetadata.kiroRegion ?? getKiroRegionFromEndpoint(model.baseUrl) ?? "us-east-1";
      const endpoint = new URL("generateAssistantResponse", getKiroEndpoints(region).runtime).toString();
      let managementAuth: KiroManagementAuth = { accessToken, region };

      const optionProfileArn =
        (options as unknown as { credentials?: { profileArn?: string }; profileArn?: string })?.credentials
          ?.profileArn || (options as unknown as { profileArn?: string })?.profileArn;
      const cliCreds = getKiroCliCredentials() ?? getKiroCliCredentialsAllowExpired();
      const cliProfileArn = cliCreds?.access === accessToken ? cliCreds.profileArn : undefined;
      const initialProfileArn = modelMetadata.kiroProfileArn || optionProfileArn || cliProfileArn;
      let profileArn: string;
      try {
        profileArn =
          initialProfileArn ||
          (skipProfileResolutionForTests ? TEST_PROFILE_ARN : await resolveKiroProfileArn(managementAuth));
      } catch (error) {
        if (!(error instanceof KiroManagementHttpError) || error.status !== 403) throw error;

        // The host may have captured an access token before kiro-cli rotated it.
        // Re-read the shared store first, then force a refresh only when it still
        // contains the rejected token. Profile discovery must succeed before the
        // runtime request can be constructed.
        const storedCreds = getKiroCliCredentials();
        const freshCreds =
          storedCreds?.access && storedCreds.access !== accessToken ? storedCreds : refreshViaKiroCli();
        // Rethrow the ORIGINAL error, flagged so the consumer knows in-process
        // re-auth was already tried and lost.
        if (!freshCreds?.access) throw error.markRefreshAttempted();

        accessToken = freshCreds.access;
        managementAuth = { accessToken, region };
        profileArn =
          freshCreds.profileArn ||
          (skipProfileResolutionForTests ? TEST_PROFILE_ARN : await resolveProfileArnAfterRefresh(managementAuth));
      }

      // Trigger dynamic models cache update in the background if empty or stale
      const { isCacheStale, updateKiroModelsCache } = await import("./models.js");
      if (!process.env.VITEST && isCacheStale(region)) {
        updateKiroModelsCache(accessToken, region, profileArn).catch((error) => {
          console.warn(
            `[pi-provider-kiro] Failed to refresh Kiro model catalog in ${region}: ${formatSafeError(error)}`,
          );
        });
      }

      const kiroModelId = resolveKiroModel(model.id, modelMetadata.kiroModelId);
      const effortConfig = getKiroEffortConfig(modelMetadata.additionalModelRequestFieldsSchema, kiroModelId);
      const additionalModelRequestFields = buildKiroAdditionalModelRequestFields(
        modelMetadata,
        kiroModelId,
        options?.reasoning,
      );
      const thinkingEnabled = !!options?.reasoning || model.reasoning;
      debugLog("request.init", {
        endpoint,
        model: model.id,
        kiroModelId,
        contextWindow: model.contextWindow,
        thinkingEnabled,
        reasoning: options?.reasoning,
        messageCount: context.messages.length,
        toolCount: context.tools?.length ?? 0,
        hasSystemPrompt: !!context.systemPrompt,
        profileArn,
        sessionId: options?.sessionId,
      });
      let systemPrompt = context.systemPrompt ?? "";
      // Kiro's runtime endpoint honors structured effort but only exposes Claude's
      // user-visible thinking stream when the legacy thinking markers are also
      // present. Keep both controls: structured fields select effort, while these
      // markers preserve the <thinking> content consumed by ThinkingTagParser.
      if (thinkingEnabled && effortConfig?.field !== "reasoning") {
        const budget =
          options?.reasoning === "xhigh"
            ? 50000
            : options?.reasoning === "high"
              ? 30000
              : options?.reasoning === "medium"
                ? 20000
                : 10000;
        systemPrompt = `<thinking_mode>enabled</thinking_mode><max_thinking_length>${budget}</max_thinking_length>${systemPrompt ? `\n${systemPrompt}` : ""}`;
      }
      let retryCount = 0;
      const maxRetries = 3;
      // Cumulative provider-internal retry tallies reported on KiroApiError.
      // `retryCount` cannot stand in for either: it is also consumed by stream
      // errors, idle/first-token timeouts, and empty-response retries, and
      // `capacityRetryCount` resets on every outer iteration.
      let credentialRefreshTotal = 0;
      let capacityRetryTotal = 0;
      /** Degenerate attempts, counted BY SHAPE. Both are counted separately from
       *  `retryCount`, which is the shared retry budget also spent by 403 credential
       *  refreshes, idle/first-token timeouts and mid-stream errors — so
       *  `maxRetries + 1` is NOT the number of empty attempts, and reporting it as
       *  such overstates what was observed.
       *
       *  Split rather than pooled because the two shapes are not interchangeable and
       *  the exhaustion diagnostic is worded from the LAST attempt's shape only. The
       *  model can echo on one attempt and return nothing on the next; a single
       *  pooled counter would then make "returned no text ... on 4 attempts" out of
       *  three empty attempts and one that did carry text, or claim four echoes from
       *  one. Each diagnostic reports its own shape's count and, when the other shape
       *  also occurred, names it separately. */
      let emptyAttempts = 0;
      let echoAttempts = 0;
      const conversationId = options?.sessionId ?? crypto.randomUUID();
      while (retryCount <= maxRetries) {
        if (options?.signal?.aborted) throw options.signal.reason;
        const effectiveSystemPrompt = systemPrompt;
        const normalized = normalizeMessages(context.messages);
        const {
          history: rawHistory,
          systemPrepended,
          currentMsgStartIdx,
        } = buildHistory(normalized, kiroModelId, effectiveSystemPrompt);
        // Preserve semantic context locally; Pi owns lossy compaction.
        const history = prepareHistory(rawHistory);
        const dynamicHistoryLimit = Math.floor((model.contextWindow / HISTORY_LIMIT_CONTEXT_WINDOW) * HISTORY_LIMIT);
        const toolResultLimit = TOOL_RESULT_LIMIT;
        const currentMessages = normalized.slice(currentMsgStartIdx);
        const firstMsg = currentMessages[0];
        let currentContent = "";
        const currentToolResults: KiroToolResult[] = [];
        let currentImages: KiroImage[] | undefined;
        if (firstMsg?.role === "assistant") {
          const am = firstMsg as AssistantMessage;
          let armContent = "";
          const armToolUses: Array<{ name: string; toolUseId: string; input: Record<string, unknown> }> = [];
          if (Array.isArray(am.content))
            for (const b of am.content) {
              if (b.type === "text") armContent += (b as TextContent).text;
              else if (b.type === "thinking")
                armContent = `<thinking>${(b as unknown as { thinking: string }).thinking}</thinking>\n\n${armContent}`;
              else if (b.type === "toolCall") {
                const tc = b as ToolCall;
                armToolUses.push({
                  name: tc.name,
                  toolUseId: tc.id,
                  input:
                    typeof tc.arguments === "string"
                      ? JSON.parse(tc.arguments)
                      : (tc.arguments as Record<string, unknown>),
                });
              }
            }
          if (armContent || armToolUses.length > 0) {
            const lastEntryForArm = history[history.length - 1];
            const prevArm = lastEntryForArm?.assistantResponseMessage;
            if (history.length > 0 && !lastEntryForArm?.userInputMessage && prevArm) {
              // Merge into previous assistant message to maintain alternation without synthetic padding
              prevArm.content += `\n\n${armContent}`;
              if (armToolUses.length > 0) prevArm.toolUses = [...(prevArm.toolUses || []), ...armToolUses];
            } else {
              history.push({
                assistantResponseMessage: {
                  content: armContent,
                  ...(armToolUses.length > 0 ? { toolUses: armToolUses } : {}),
                },
              });
            }
          }
          const toolResultImages: ImageContent[] = [];
          for (let i = 1; i < currentMessages.length; i++) {
            const m = currentMessages[i];
            if (m.role === "toolResult") {
              const trm = m as ToolResultMessage;
              currentToolResults.push({
                content: [{ text: truncate(getContentText(m), toolResultLimit) }],
                status: trm.isError ? "error" : "success",
                toolUseId: trm.toolCallId,
              });
              if (Array.isArray(trm.content))
                for (const c of trm.content) if (c.type === "image") toolResultImages.push(c as ImageContent);
            }
          }
          if (toolResultImages.length > 0) {
            const converted = convertImagesToKiro(toolResultImages);
            currentImages = currentImages ? [...currentImages, ...converted] : converted;
          }
          currentContent = currentToolResults.length > 0 ? "Tool results provided." : "Please proceed with the task.";
        } else if (firstMsg?.role === "toolResult") {
          const toolResultImages2: ImageContent[] = [];
          for (const m of currentMessages)
            if (m.role === "toolResult") {
              const trm = m as ToolResultMessage;
              currentToolResults.push({
                content: [{ text: truncate(getContentText(m), toolResultLimit) }],
                status: trm.isError ? "error" : "success",
                toolUseId: trm.toolCallId,
              });
              if (Array.isArray(trm.content))
                for (const c of trm.content) if (c.type === "image") toolResultImages2.push(c as ImageContent);
            }
          if (toolResultImages2.length > 0) {
            const converted = convertImagesToKiro(toolResultImages2);
            currentImages = currentImages ? [...currentImages, ...converted] : converted;
          }
          currentContent = "Tool results provided.";
        } else if (firstMsg?.role === "user") {
          currentContent = typeof firstMsg.content === "string" ? firstMsg.content : getContentText(firstMsg);
          if (effectiveSystemPrompt && !systemPrepended)
            currentContent = `${effectiveSystemPrompt}\n\n${currentContent}`;
        }
        // Current assistant tool calls are outbound history too, so enforce the
        // budget only after they have been appended.
        assertHistoryWithinLimit(history, dynamicHistoryLimit);
        // Prepend truncation notice if the previous assistant response was cut off
        if (wasPreviousResponseTruncated(context.messages)) {
          currentContent = `${TRUNCATION_NOTICE}\n\n${currentContent}`;
        }
        // Always synthesize placeholder specs for tool names referenced in
        // history, even when context.tools is empty/undefined. Without this,
        // an "advisor-style" call that inherits a tool-rich conversation but
        // declares no current tools is rejected by Kiro as "Improperly formed
        // request" because history references toolUses with no tool catalog.
        let uimc: { toolResults?: KiroToolResult[]; tools?: KiroToolSpec[] } | undefined;
        const baseTools = context.tools?.length ? convertToolsToKiro(context.tools) : [];
        const finalTools = history.length > 0 ? addPlaceholderTools(baseTools, history) : baseTools;
        if (currentToolResults.length > 0 || finalTools.length > 0) {
          uimc = {};
          if (currentToolResults.length > 0) uimc.toolResults = currentToolResults;
          if (finalTools.length > 0) uimc.tools = finalTools;
        }
        if (firstMsg?.role === "user") {
          const imgs = extractImages(firstMsg);
          if (imgs.length > 0) currentImages = convertImagesToKiro(imgs as ImageContent[]);
        }
        // `content` is required: Kiro answers an empty one with a 400
        // "Improperly formed request." Fall back to a neutral prompt so a turn
        // that carries only images (or an empty-text user message) still sends.
        if (currentContent === "") currentContent = EMPTY_CONTENT_PLACEHOLDER;
        // kiro-cli does not enforce alternation — the API accepts
        // non-alternating history. No synthetic padding needed.
        const request: KiroRequest = {
          conversationState: {
            chatTriggerType: "MANUAL",
            agentTaskType: "vibe",
            conversationId,
            currentMessage: {
              userInputMessage: {
                content: sanitizeSurrogates(currentContent),
                modelId: kiroModelId,
                origin: "KIRO_CLI",
                ...(currentImages ? { images: currentImages } : {}),
                ...(uimc ? { userInputMessageContext: uimc } : {}),
              },
            },
            ...(history.length > 0 ? { history } : {}),
          },
          ...(additionalModelRequestFields ? { additionalModelRequestFields } : {}),
          profileArn,
          agentMode: "vibe",
        };
        let response!: Response;
        // Reset per outer iteration — each 403 retry gets a fresh capacity budget
        let capacityRetryCount = 0;
        // Inner loop: retry capacity errors without consuming outer retry budget
        while (true) {
          const mid = crypto.randomUUID().replace(/-/g, "");
          const ua = `aws-sdk-rust/1.0.0 ua/2.1 os/other lang/rust api/codewhispererstreaming#1.28.3 m/E app/AmazonQ-For-CLI md/appVersion-1.28.3-${mid}`;
          debugLog("request.send", {
            attempt: retryCount,
            capacityAttempt: capacityRetryCount,
            historyLen: history.length,
            currentContentLen: currentContent.length,
            hasImages: !!currentImages,
            toolResultCount: currentToolResults.length,
            request,
          });
          response = await fetch(endpoint, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/vnd.amazon.eventstream",
              Authorization: `Bearer ${accessToken}`,
              "x-amzn-codewhisperer-optout": "true",
              "amz-sdk-invocation-id": crypto.randomUUID(),
              "amz-sdk-request": "attempt=1; max=1",
              "x-amzn-kiro-agent-mode": "vibe",
              "x-amz-user-agent": ua,
              "user-agent": ua,
            },
            body: JSON.stringify(request),
            signal: options?.signal,
          });
          if (!response.ok) {
            let errText = "";
            try {
              errText = redactSensitiveText(await response.text());
            } catch {
              errText = "";
            }
            const safeStatusText = redactSensitiveText(response.statusText);
            debugLog("response.error", { status: response.status, statusText: safeStatusText, body: errText });
            // Retry transient capacity errors with longer backoff
            if (isCapacityError(errText) && capacityRetryCount < capacityRetryConfig.maxRetries) {
              capacityRetryCount++;
              capacityRetryTotal++;
              const delayMs = exponentialBackoff(capacityRetryCount - 1, capacityRetryConfig.baseDelayMs, 30_000);
              const msg = `INSUFFICIENT_MODEL_CAPACITY — retrying in ${delayMs}ms (${capacityRetryCount}/${capacityRetryConfig.maxRetries})`;
              logCapacityEvent(msg);
              await abortableDelay(delayMs, options?.signal);
              continue;
            }
            if (isCapacityError(errText)) {
              logCapacityEvent(
                `INSUFFICIENT_MODEL_CAPACITY — exhausted ${capacityRetryConfig.maxRetries} retries, giving up`,
              );
            }
            if (response.status === 403 && !isCapacityError(errText) && retryCount < maxRetries) {
              retryCount++;
              credentialRefreshTotal++;
              // Re-read the shared store first in case another process already
              // rotated the token. If it still contains the rejected token,
              // force kiro-cli to refresh before retrying runtime.
              invalidateKiroProfileArn(managementAuth);
              const rejectedAccessToken = accessToken;
              const rejectedProfileArn = profileArn;
              const storedCreds = getKiroCliCredentials();
              const rejectedCliCreds =
                storedCreds?.access === rejectedAccessToken
                  ? storedCreds
                  : cliCreds?.access === rejectedAccessToken
                    ? cliCreds
                    : undefined;
              const freshCreds: ReturnType<typeof getKiroCliCredentials> =
                storedCreds?.access && storedCreds.access !== rejectedAccessToken ? storedCreds : refreshViaKiroCli();
              if (freshCreds?.access) accessToken = freshCreds.access;
              managementAuth = { accessToken, region };

              // Social profiles may not be discoverable through management.
              // Carry the profile used by the rejected request only across a
              // confirmed desktop-to-desktop credential replacement.
              const inheritedDesktopProfileArn =
                rejectedCliCreds?.authMethod === "desktop" && freshCreds?.authMethod === "desktop"
                  ? rejectedProfileArn
                  : undefined;
              profileArn =
                freshCreds?.profileArn ||
                inheritedDesktopProfileArn ||
                (skipProfileResolutionForTests
                  ? TEST_PROFILE_ARN
                  : await resolveProfileArnAfterRefresh(managementAuth));
              const delayMs = exponentialBackoff(retryCount - 1, 500, MAX_RETRY_DELAY);
              await abortableDelay(delayMs, options?.signal);
              break; // break inner loop, continue outer loop
            }
            // Avoid pi-coding-agent's outer auto-retry from treating known
            // Kiro quota/capacity body markers as generic retryable 429s.
            // This covers both hard quota (MONTHLY_REQUEST_COUNT) and
            // exhausted capacity retries (INSUFFICIENT_MODEL_CAPACITY).
            //
            // The three throws below carry identical `message` text to what this
            // provider has always emitted — pi-ai, pi-coding-agent, and
            // downstream consumers all string-match it. KiroApiError adds the
            // classification as typed fields alongside that text; it never
            // changes it.
            const errorMeta = {
              reasonCode: extractKiroReasonCode(errText),
              retryAfterMs: parseRetryAfterMs(response.headers),
              providerAttempts: { credentialRefresh: credentialRefreshTotal, capacity: capacityRetryTotal },
            };
            if (isNonRetryableBodyError(errText) || isCapacityError(errText)) {
              throw new KiroApiError(
                `Kiro API error: ${errText || safeStatusText}`,
                response.status,
                errorMeta.reasonCode,
                errorMeta.retryAfterMs,
                errorMeta.providerAttempts,
              );
            }
            // Format error so pi-ai's isContextOverflow() recognizes it
            if (isTooBigError(response.status, errText)) {
              throw new KiroApiError(
                `Kiro API error: context_length_exceeded (${response.status} ${errText})`,
                response.status,
                errorMeta.reasonCode,
                errorMeta.retryAfterMs,
                errorMeta.providerAttempts,
              );
            }
            throw new KiroApiError(
              `Kiro API error: ${response.status} ${safeStatusText} ${errText}`,
              response.status,
              errorMeta.reasonCode,
              errorMeta.retryAfterMs,
              errorMeta.providerAttempts,
            );
          }
          break; // success, break inner loop
        }
        if (capacityRetryCount > 0 && response.ok) {
          logCapacityEvent(`INSUFFICIENT_MODEL_CAPACITY — succeeded after ${capacityRetryCount} retries`);
        }
        // 403 retry: continue outer loop
        if (!response.ok) continue;
        stream.push({ type: "start", partial: output });
        if (!response.body) throw new Error("No response body");
        const bodyReader = (response.body as unknown as ReadableStream<Uint8Array>).getReader();
        let totalContent = "";
        let lastContentData = "";
        let usageEvent: { inputTokens?: number; outputTokens?: number } | null = null;
        let receivedContextUsage = false;
        const thinkingParser = thinkingEnabled ? new ThinkingTagParser(output, stream) : null;
        let nativeThinkingBlockIndex: number | null = null;
        let nativeThinkingEnded = false;
        const ensureNativeThinkingBlock = (): { block: ThinkingContent; contentIndex: number } => {
          if (nativeThinkingBlockIndex === null) {
            nativeThinkingBlockIndex = output.content.length;
            output.content.push({ type: "thinking", thinking: "" });
            stream.push({ type: "thinking_start", contentIndex: nativeThinkingBlockIndex, partial: output });
          }
          return {
            block: output.content[nativeThinkingBlockIndex] as ThinkingContent,
            contentIndex: nativeThinkingBlockIndex,
          };
        };
        const endNativeThinking = () => {
          if (nativeThinkingBlockIndex === null || nativeThinkingEnded) return;
          nativeThinkingEnded = true;
          const block = output.content[nativeThinkingBlockIndex] as ThinkingContent;
          stream.push({
            type: "thinking_end",
            contentIndex: nativeThinkingBlockIndex,
            content: block.thinking,
            partial: output,
          });
        };
        let textBlockIndex: number | null = null;
        let emittedToolCalls = 0;
        let sawAnyToolCalls = false;
        /** Names of tool calls `emitToolCall` refused because their arguments would
         *  not parse. Per-attempt, like `emittedToolCalls`: a retry must not inherit
         *  a discarded attempt's drops. */
        const droppedToolCalls: string[] = [];
        let currentToolCall: KiroToolCallState | null = null;
        const flushToolCall = () => {
          if (!currentToolCall) return;
          if (emitToolCall(currentToolCall, output, stream)) emittedToolCalls++;
          else droppedToolCalls.push(currentToolCall.name);
          currentToolCall = null;
        };
        const IDLE_TIMEOUT = 300_000;
        let idleTimer: ReturnType<typeof setTimeout> | null = null;
        let idleCancelled = false;
        const resetIdle = () => {
          if (idleTimer) clearTimeout(idleTimer);
          idleTimer = setTimeout(() => {
            idleCancelled = true;
            void bodyReader.cancel().catch(() => {});
          }, IDLE_TIMEOUT);
        };
        let gotFirstToken = false;
        let firstTokenTimedOut = false;
        let streamError: string | null = null;
        const FIRST_TOKEN_SENTINEL = Symbol("firstTokenTimeout");

        // Smithy EventStreamMarshaller handles: chunk reassembly, CRC validation,
        // protocol error/exception detection, and payload deserialization.
        const bodyIterable: AsyncIterable<Uint8Array> = {
          async *[Symbol.asyncIterator]() {
            try {
              while (true) {
                const { done, value } = await bodyReader.read();
                if (done) return;
                yield value;
              }
            } finally {
              bodyReader.releaseLock();
            }
          },
        };
        const utf8Decoder = new TextDecoder();
        const eventStream = eventStreamMarshaller.deserialize(bodyIterable, async (event: Record<string, Message>) => {
          const entry = Object.entries(event)[0];
          if (!entry) throw new Error("Received an empty event stream message");
          const [key, msg] = entry;
          const parsed = JSON.parse(utf8Decoder.decode(msg.body)) as Record<string, unknown>;
          return { [key]: parsed } as Record<string, unknown>;
        });
        const iterator = eventStream[Symbol.asyncIterator]() as AsyncIterator<Record<string, unknown>>;

        while (true) {
          let iterResult: IteratorResult<Record<string, unknown>>;
          try {
            if (!gotFirstToken) {
              const readPromise = iterator.next();
              const result = await Promise.race([
                readPromise,
                new Promise<typeof FIRST_TOKEN_SENTINEL>((resolve) =>
                  setTimeout(() => resolve(FIRST_TOKEN_SENTINEL), firstTokenTimeoutForModel(model.id)),
                ),
              ]);
              if (result === FIRST_TOKEN_SENTINEL) {
                readPromise.catch(() => {}); // suppress dangling rejection
                void bodyReader.cancel().catch(() => {});
                firstTokenTimedOut = true;
                break;
              }
              iterResult = result as IteratorResult<Record<string, unknown>>;
              gotFirstToken = true;
              resetIdle();
            } else {
              iterResult = await iterator.next();
            }
          } catch (e) {
            // Smithy throws on :message-type error/exception headers
            streamError =
              e instanceof Error
                ? e.message
                : (typeof e === "object" && e !== null ? JSON.stringify(e) : String(e)) || "Unknown stream error";
            break;
          }
          const { done, value } = iterResult;
          if (done) break;
          resetIdle();
          const eventEntry = Object.entries(value as Record<string, unknown>)[0];
          if (!eventEntry) continue;
          const [eventType, eventPayload] = eventEntry as [string, Record<string, unknown>];
          const event = parseKiroEvent(eventPayload, eventType);
          if (!event) continue;
          if (debugEnabled()) debugLog("stream.events", [event]);
          switch (event.type) {
            case "contextUsage": {
              const pct = event.data.contextUsagePercentage;
              output.usage.input = Math.round((pct / 100) * model.contextWindow);
              (output.usage as unknown as Record<string, unknown>).contextPercent = pct;
              receivedContextUsage = true;
              break;
            }
            case "thinkingText": {
              if (!thinkingEnabled) break;
              const { block, contentIndex } = ensureNativeThinkingBlock();
              block.thinking += event.data;
              totalContent += event.data;
              stream.push({
                type: "thinking_delta",
                contentIndex,
                delta: event.data,
                partial: output,
              });
              break;
            }
            case "thinkingSignature": {
              if (!thinkingEnabled) break;
              const { block } = ensureNativeThinkingBlock();
              block.thinkingSignature = event.data;
              endNativeThinking();
              break;
            }
            case "content": {
              endNativeThinking();
              if (event.data === lastContentData) continue;
              lastContentData = event.data;
              totalContent += event.data;
              if (thinkingParser) {
                thinkingParser.processChunk(event.data);
              } else {
                if (textBlockIndex === null) {
                  textBlockIndex = output.content.length;
                  output.content.push({ type: "text", text: "" });
                  stream.push({ type: "text_start", contentIndex: textBlockIndex, partial: output });
                }
                (output.content[textBlockIndex] as TextContent).text += event.data;
                stream.push({ type: "text_delta", contentIndex: textBlockIndex, delta: event.data, partial: output });
              }
              break;
            }
            case "toolUse": {
              const tc = event.data;
              sawAnyToolCalls = true;
              if (!currentToolCall || currentToolCall.toolUseId !== tc.toolUseId) {
                flushToolCall();
                currentToolCall = { toolUseId: tc.toolUseId, name: tc.name, input: "" };
              }
              currentToolCall.input += tc.input || "";
              if (tc.input) totalContent += tc.input;
              if (tc.stop) flushToolCall();
              break;
            }
            case "toolUseInput": {
              if (currentToolCall) currentToolCall.input += event.data.input || "";
              if (event.data.input) totalContent += event.data.input;
              break;
            }
            case "toolUseStop": {
              if (event.data.stop) flushToolCall();
              break;
            }
            case "usage": {
              usageEvent = event.data;
              break;
            }
            case "metering": {
              recordKiroMetering(event.data);
              break;
            }
            case "error": {
              const errMsg = event.data.message ? `${event.data.error}: ${event.data.message}` : event.data.error;
              streamError = errMsg;
              void bodyReader.cancel().catch(() => {});
              break;
            }
            // followupPrompt events are intentionally ignored
          }
          if (streamError) break;
        }
        if (idleTimer) clearTimeout(idleTimer);
        if (firstTokenTimedOut || idleCancelled || streamError) {
          // Timed out or received error mid-stream: retry with backoff
          if (retryCount < maxRetries) {
            retryCount++;
            const delayMs = exponentialBackoff(retryCount - 1, 1000, MAX_RETRY_DELAY);
            await abortableDelay(delayMs, options?.signal);
            continue;
          }
          if (streamError) {
            throw new Error(`Kiro API stream error after max retries: ${streamError}`);
          }
          throw new Error(`Kiro API error: ${firstTokenTimedOut ? "first token" : "idle"} timeout after max retries`);
        }
        if (currentToolCall) {
          if (emitToolCall(currentToolCall, output, stream)) emittedToolCalls++;
          else droppedToolCalls.push(currentToolCall.name);
        }
        endNativeThinking();
        if (thinkingParser) {
          thinkingParser.finalize();
          textBlockIndex = thinkingParser.getTextBlockIndex();
        }
        // Fallback: extract bracket-style tool calls from content if no native tool calls
        //
        // Deliberately still gated on `sawAnyToolCalls`, so it does NOT run when a
        // native call arrived and was dropped for unparseable arguments. Widening it
        // to `emittedToolCalls === 0` would enable text recovery on exactly the path
        // where `KiroModel.recoverTextToolCalls === false` says not to (Claude), and
        // that flag is not consumed here yet — so the widening cannot be made
        // model-aware without first wiring it. The drop is reported instead.
        if (!sawAnyToolCalls && textBlockIndex !== null) {
          const textBlock = output.content[textBlockIndex] as TextContent;
          const bracketResult = parseBracketToolCalls(textBlock.text);
          if (bracketResult.toolCalls.length > 0) {
            sawAnyToolCalls = true;
            textBlock.text = bracketResult.cleanedText;
            for (const btc of bracketResult.toolCalls) {
              if (
                emitToolCall(
                  {
                    toolUseId: btc.toolUseId,
                    name: btc.name,
                    input: JSON.stringify(btc.arguments),
                  },
                  output,
                  stream,
                )
              ) {
                emittedToolCalls++;
              } else {
                // Unreachable as written, and kept deliberately. `btc.arguments` is
                // itself a successful `JSON.parse` result (see bracket-tool-parser),
                // so `JSON.stringify` of it always round-trips and `emitToolCall`'s
                // only `false` return — a `JSON.parse` throw — cannot fire here. No
                // test pins this branch, because no wire input can reach it. It stays
                // so that a future parser change passing raw text through cannot
                // silently reintroduce the very dropped-call blindness this change
                // exists to remove.
                droppedToolCalls.push(btc.name);
              }
            }
          }
        }
        // Strip echo noise: when tool calls are present and the text content
        // is just "." or similar short echo from history padding, remove it.
        // This prevents the echo from accumulating in conversation history
        // and reinforcing the pattern in future turns.
        if (emittedToolCalls > 0 && textBlockIndex !== null) {
          const textBlock = output.content[textBlockIndex] as TextContent;
          if (/^\s*(\.+|continue)\s*$/i.test(textBlock.text)) {
            textBlock.text = "";
          }
        }
        if (textBlockIndex !== null)
          stream.push({
            type: "text_end",
            contentIndex: textBlockIndex,
            content: (output.content[textBlockIndex] as TextContent).text,
            partial: output,
          });
        // The Kiro streaming API does not reliably emit per-response output
        // token counts (unlike Anthropic's `output_tokens` or Bedrock's
        // `usage.outputTokens`). When the `usage` event is missing or only
        // reports `inputTokens`, fall back to a tiktoken estimate over
        // everything the assistant emitted — text plus tool-call input JSON
        // (accumulated into `totalContent` above). Otherwise tool-call-only
        // turns report 0 output tokens and break consumers like the TPS
        // extension that watch `usage.output`.
        if (usageEvent?.inputTokens !== undefined) output.usage.input = usageEvent.inputTokens;
        output.usage.output = usageEvent?.outputTokens ?? countTokens(totalContent);
        output.usage.totalTokens = output.usage.input + output.usage.output;
        try {
          PiAi.calculateCost(model, output.usage);
        } catch {
          // Model might not have cost info, use zeros
          output.usage.cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
        }
        // Detect degenerate responses: the API returned 200 but produced no
        // usable content at all — no text and no tool calls (not even broken
        // ones). This happens when the stream is truncated early or the API
        // returns only a contextUsage event. Retry with backoff.
        //
        // Also detect "Continue" echo loops: the model's entire response is
        // just "continue" (case-insensitive) with no tool calls. This happens
        // when synthetic history padding teaches the model to echo "Continue"
        // as a valid response, causing an infinite loop where pi sends
        // "continue" back and the model echoes it again.
        //
        // When tool calls *were* present but all got dropped (empty/unparseable
        // input), don't retry — the API did respond, it just sent malformed
        // tool calls. Retrying would likely produce the same result. The
        // stopReason fix below prevents the agent loop stall.
        const hasText = textBlockIndex !== null && (output.content[textBlockIndex] as TextContent).text.length > 0;
        const responseText = hasText ? (output.content[textBlockIndex as number] as TextContent).text : "";
        const isEchoLoop = hasText && !sawAnyToolCalls && /^\s*(continue|\.+)\s*$/i.test(responseText);
        const degenerate = (!hasText && !sawAnyToolCalls) || isEchoLoop;
        if (isEchoLoop) echoAttempts++;
        else if (degenerate) emptyAttempts++;
        const exhausted = degenerate && retryCount >= maxRetries;
        // Use emittedToolCalls (not toolCalls.length) to avoid stopReason:"toolUse"
        // when all tool calls were skipped due to empty/unparseable input — that
        // combination (empty content + toolUse stop) causes pi's agent loop to
        // stall waiting for tool results that will never arrive.
        //
        // Resolved BEFORE the retry-exhaustion warnings below so those warnings can
        // report the value actually assigned. It reads only `receivedContextUsage`
        // and `emittedToolCalls`, neither of which the exhaustion branch touches.
        if (!receivedContextUsage && emittedToolCalls === 0) {
          output.stopReason = "length";
        } else {
          output.stopReason = emittedToolCalls > 0 ? "toolUse" : "stop";
        }
        if (degenerate) {
          if (!exhausted) {
            retryCount++;
            const delayMs = exponentialBackoff(retryCount - 1, 1000, MAX_RETRY_DELAY);
            console.warn(
              `[pi-provider-kiro] ${isEchoLoop ? 'Echo loop detected (model responded with just "Continue")' : "Empty response (no text, no tool calls)"} — retrying (${retryCount}/${maxRetries})`,
            );
            // Reset output content for the retry
            output.content = [];
            textBlockIndex = null;
            await abortableDelay(delayMs, options?.signal);
            continue;
          }
          // Retries are spent and the turn still carries nothing usable. The
          // stopReason has to stay in pi's existing union (a new member would
          // break every peer), so the only channel that can say a turn failed
          // while it still looks successful is `errorMessage`. Without it these
          // turns are indistinguishable from an ordinary completion.
          //
          // Deliberately NOT worded as a transient/transport failure: this is
          // terminal, so consumer retry classifiers must not match it and hand
          // it another doomed attempt. Consumers split three ways on the exact
          // strings below, measured rather than assumed:
          //
          //  - Read the field with NO stopReason gate, and fail the run on any
          //    non-retryable value: Kermes `headless.ts` (`exit = 1`) and
          //    `acp_server/agent.ts` (`hadError`). These are the paths the
          //    diagnostic actually reaches, and because it is worded terminal it
          //    is NOT suppressed — a silent turn that used to exit 0 now fails
          //    loudly. That is the intended consequence, not a side effect.
          //  - Cannot be reached by this field at all, so they stay correctly
          //    inert: pi-ai's `isRetryableAssistantError` requires
          //    `stopReason === "error"`, and of `isContextOverflow`'s three
          //    branches only the first reads `errorMessage` (also behind that
          //    same gate) — its silent-overflow and length-stop branches judge
          //    `usage` alone and never read this field. Writing it therefore
          //    changes neither verdict.
          //  - Read the field unconditionally but only ACT on it behind a
          //    `stopReason === "error"` classifier, so they persist nothing:
          //    Kermes `session_reaper.ts` discards this on a non-error tail
          //    (`stop_detail` is written only when a blocked verdict is
          //    reached). Surfacing these in reap verdicts needs a consumer-side
          //    change; it does not follow from writing the field here.
          if (isEchoLoop) {
            // After max retries, strip the echo text to prevent the agent
            // loop from interpreting "Continue" as a continuation signal.
            (output.content[textBlockIndex as number] as TextContent).text = "";
            const alsoEmpty = emptyAttempts > 0 ? ` (plus ${describeAttempts(emptyAttempts)} with no text at all)` : "";
            console.warn(
              `[pi-provider-kiro] Echo loop persisted across ${describeAttempts(echoAttempts)}${alsoEmpty} — stripping "Continue" response (${responseText.length} chars)`,
            );
            output.errorMessage = `Kiro model echoed its own continuation prompt (${JSON.stringify(
              clampForDiagnostic(responseText),
            )}) on ${describeAttempts(
              echoAttempts,
            )}${alsoEmpty} and emitted no tool calls; retry budget exhausted, text stripped, stopReason:"${
              output.stopReason
            }"`;
          } else {
            const alsoEchoed =
              echoAttempts > 0 ? ` (plus ${describeAttempts(echoAttempts)} that echoed the continuation prompt)` : "";
            console.warn(
              `[pi-provider-kiro] Empty response on ${describeAttempts(emptyAttempts)}${alsoEchoed}, retry budget exhausted — returning stopReason:"${output.stopReason}" to avoid agent loop stall`,
            );
            // This attempt produced no text block, so any text still in
            // `output.content` was left by an attempt that was discarded — see
            // `describeReturnedContent`.
            //
            // The `textBlockIndex === null` conjunct is redundant as written and
            // kept deliberately. No wire shape reaches this branch with a non-null
            // `textBlockIndex`: every path that creates a text block also puts
            // non-empty text in it (`ThinkingTagParser.emitText` returns early on
            // empty input, and the non-reasoning handler's dedup guard swallows a
            // leading `content: ""` because `lastContentData` also starts empty),
            // which would make `hasText` true and the turn non-degenerate. No test
            // pins the conjunct for that reason. It stays so that a future path
            // which does leave a zero-length text block cannot silently blame this
            // attempt's own block on a discarded one.
            const textResidue = textBlockIndex === null && output.content.some((block) => block.type === "text");
            output.errorMessage = `Kiro returned no text and no tool calls on ${describeAttempts(
              emptyAttempts,
            )}${alsoEchoed}; retry budget exhausted, ${describeReturnedContent(
              output.content,
              textResidue,
            )} with stopReason:"${output.stopReason}"`;
          }
        }
        // A tool call the model DID make never reached pi: its arguments would not
        // parse, so `emitToolCall` dropped it (see that function). Nothing else
        // records this — `sawAnyToolCalls` is already true, which is exactly what
        // suppresses the empty-response retry above and the bracket fallback
        // earlier, and the content array simply lacks a block. Unlike the two
        // exhaustion cases, this one is unrecoverable downstream: the call is gone
        // before the message is persisted.
        if (droppedToolCalls.length > 0) {
          const names = clampForDiagnostic(droppedToolCalls.map((name) => JSON.stringify(name)).join(", "));
          // The names enumerate the drops, so the count is not printed: it is
          // unbounded (a turn may carry any number of malformed calls) and an
          // unbounded integer here can collide with a consumer's retryable-error
          // pattern — see `clampForDiagnostic`.
          const one = droppedToolCalls.length === 1;
          const dropDiagnostic = `Kiro sent ${one ? "a tool call" : "tool calls"} with unparseable arguments (${names}); ${
            one ? "it was" : "they were"
          } dropped and never reached the agent, stopReason:"${output.stopReason}"`;
          // Concatenation is defensive: today the two diagnostics are mutually
          // exclusive, because any drop sets `sawAnyToolCalls` and `degenerate`
          // requires `!sawAnyToolCalls`. Kept so that loosening either predicate
          // appends rather than silently overwriting an exhaustion diagnostic.
          output.errorMessage = output.errorMessage ? `${output.errorMessage}. ${dropDiagnostic}` : dropDiagnostic;
        }
        stream.push({ type: "done", reason: output.stopReason as "stop" | "toolUse", message: output });
        debugLog("response.done", {
          stopReason: output.stopReason,
          emittedToolCalls,
          sawAnyToolCalls,
          textLen: textBlockIndex !== null ? (output.content[textBlockIndex] as TextContent).text.length : 0,
          usage: output.usage,
          content: output.content,
        });
        stream.end();
        break;
      }
    } catch (error) {
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = formatSafeError(error);
      // Surface the typed classification the throw site already computed.
      // `errorMessage` is a flat string by contract, so without this a consumer
      // has to regex the class back out of prose. Diagnostics are the sanctioned
      // structured channel for exactly this ("provider/runtime diagnostics for
      // failures and recoveries").
      if (error instanceof KiroApiError) {
        PiAi.appendAssistantMessageDiagnostic(
          output,
          PiAi.createAssistantMessageDiagnostic("kiro_api_error", error, {
            status: error.status,
            ...(error.reasonCode !== undefined ? { reasonCode: error.reasonCode } : {}),
            ...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}),
            ...(error.providerAttempts !== undefined ? { providerAttempts: error.providerAttempts } : {}),
          }),
        );
      }
      // `errorMessage` is a string, so the typed error object never reaches the
      // consumer. Republish the management-plane discriminator through the
      // diagnostics channel, which does survive on the AssistantMessage, so a
      // consumer can classify the failure without matching error prose.
      if (error instanceof KiroManagementHttpError) {
        output.diagnostics = [
          ...(output.diagnostics ?? []),
          {
            type: KIRO_AUTH_PLANE_DIAGNOSTIC,
            timestamp: Date.now(),
            details: {
              plane: error.plane,
              status: error.status,
              refreshAttempted: error.refreshAttempted,
            },
          },
        ];
      }
      debugLog("response.caught", { stopReason: output.stopReason, error: output.errorMessage });
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  })().catch(() => {
    // Safety net: catch any rejection that escapes the inner try/catch
    // (e.g., AbortError during signal teardown). Without this, the
    // fire-and-forget IIFE produces an unhandled rejection that crashes pi.
    try {
      stream.end();
    } catch {}
  });
  return stream;
}
