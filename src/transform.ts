// Feature 5: Message Transformation

import type {
  AssistantMessage,
  ImageContent,
  Message,
  TextContent,
  ThinkingContent,
  Tool,
  ToolCall,
  ToolResultMessage,
} from "@earendil-works/pi-ai";

export interface KiroImage {
  format: string;
  source: { bytes: string };
}
export interface KiroToolUse {
  name: string;
  toolUseId: string;
  input: Record<string, unknown>;
}
export interface KiroToolResult {
  content: Array<{ text: string }>;
  status: "success" | "error";
  toolUseId: string;
}
export interface KiroToolSpec {
  toolSpecification: { name: string; description: string; inputSchema: { json: Record<string, unknown> } };
}
export interface KiroUserInputMessage {
  content: string;
  modelId: string;
  origin: "KIRO_CLI";
  images?: KiroImage[];
  userInputMessageContext?: { toolResults?: KiroToolResult[]; tools?: KiroToolSpec[] };
}
export interface KiroAssistantResponseMessage {
  content: string;
  toolUses?: KiroToolUse[];
}
export interface KiroHistoryEntry {
  userInputMessage?: KiroUserInputMessage;
  assistantResponseMessage?: KiroAssistantResponseMessage;
}

export const TOOL_RESULT_LIMIT = 250000;

/** Kiro's own requirement is content **or** tool results, not content
 *  unconditionally. First-party Kiro Agent states it as an explicit invariant
 *  — `NON_EMPTY_USER_MESSAGE`: "User messages must have either content or tool
 *  results" — and its validator implements `hasContent || hasToolResults`
 *  (`packages/kiro-agent/src/utils/message-history-sanitizer/validator.ts`).
 *  It ships `content: ''` on synthesized and consolidated tool turns.
 *
 *  A tool turn therefore needs no text: its payload is
 *  `userInputMessageContext.toolResults`. Wire-probed 2026-08-11 against
 *  `runtime.us-east-1.kiro.dev/generateAssistantResponse` with
 *  `origin: "KIRO_CLI"`, `content: ""` and a populated `toolResults` — HTTP
 *  200, request id c5e6832d-f6da-4e33-a5e9-2e6107dbcf83.
 *
 *  This placeholder remains for the case it was added for (#106): a turn that
 *  reaches the request builder with neither text nor tool results — an
 *  image-only user message, an empty-text user message, or a host-appended
 *  message whose role falls outside pi-ai's `Message` union. Send a neutral
 *  prompt there so the attachments still reach the model. Do not apply it to
 *  tool turns; that fabricates a user utterance the model reads as human. */
export const EMPTY_CONTENT_PLACEHOLDER = "Please proceed with the task.";

export function sanitizeSurrogates(text: string): string {
  // Replace unpaired high surrogates (0xD800-0xDBFF not followed by low surrogate)
  // Replace unpaired low surrogates (0xDC00-0xDFFF not preceded by high surrogate)
  // Properly paired surrogates (e.g. emoji like 🙈) are preserved.
  return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
}

export function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const half = Math.floor(limit / 2);
  return `${text.substring(0, half)}\n... [TRUNCATED] ...\n${text.substring(text.length - half)}`;
}

export function normalizeMessages(messages: Message[]): Message[] {
  return messages.filter((msg) => {
    if (msg.role !== "assistant") return true;
    const am = msg as AssistantMessage;
    return am.stopReason !== "error" && am.stopReason !== "aborted";
  });
}

export function extractImages(msg: Message): ImageContent[] {
  if (msg.role === "toolResult" || typeof msg.content === "string") return [];
  if (!Array.isArray(msg.content)) return [];
  return msg.content.filter((c): c is ImageContent => c.type === "image");
}

export function getContentText(msg: Message): string {
  if (msg.role === "toolResult") return msg.content.map((c) => (c.type === "text" ? c.text : "")).join("");
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .map((c) => {
        if (c.type === "text") return (c as TextContent).text;
        if (c.type === "thinking") return (c as ThinkingContent).thinking;
        return "";
      })
      .join("");
  }
  return "";
}

export function convertToolsToKiro(tools: Tool[]): KiroToolSpec[] {
  return tools.map((tool) => ({
    toolSpecification: {
      name: tool.name,
      description: tool.description,
      inputSchema: { json: tool.parameters as Record<string, unknown> },
    },
  }));
}

export function convertImagesToKiro(images: Array<{ mimeType: string; data: string }>): KiroImage[] {
  return images.map((img) => ({ format: img.mimeType.split("/")[1] || "png", source: { bytes: img.data } }));
}

export function buildHistory(
  messages: Message[],
  modelId: string,
  systemPrompt?: string,
): { history: KiroHistoryEntry[]; systemPrepended: boolean; currentMsgStartIdx: number } {
  const history: KiroHistoryEntry[] = [];
  let systemPrepended = false;
  const toolResultLimit = TOOL_RESULT_LIMIT;

  let currentMsgStartIdx = messages.length - 1;
  while (currentMsgStartIdx > 0 && messages[currentMsgStartIdx].role === "toolResult") currentMsgStartIdx--;
  if (currentMsgStartIdx >= 0 && messages[currentMsgStartIdx].role === "assistant") {
    const am = messages[currentMsgStartIdx] as AssistantMessage;
    if (!Array.isArray(am.content) || !am.content.some((b) => b.type === "toolCall")) currentMsgStartIdx++;
  }

  const historyMessages = messages.slice(0, currentMsgStartIdx);

  for (let i = 0; i < historyMessages.length; i++) {
    const msg = historyMessages[i];
    if (msg.role === "user") {
      let content = typeof msg.content === "string" ? msg.content : getContentText(msg);
      if (systemPrompt && !systemPrepended) {
        content = `${systemPrompt}\n\n${content}`;
        systemPrepended = true;
      }
      const images = extractImages(msg);
      const uim: KiroUserInputMessage = {
        content: sanitizeSurrogates(content),
        modelId,
        origin: "KIRO_CLI",
        ...(images.length > 0 ? { images: convertImagesToKiro(images) } : {}),
      };
      const lastEntryForUim = history[history.length - 1];
      const prevUim = lastEntryForUim?.userInputMessage;
      if (prevUim) {
        // Merge into previous user message to maintain alternation without synthetic padding
        prevUim.content += `\n\n${uim.content}`;
        if (uim.images) prevUim.images = [...(prevUim.images || []), ...uim.images];
      } else {
        history.push({ userInputMessage: uim });
      }
    } else if (msg.role === "assistant") {
      let armContent = "";
      const armToolUses: KiroToolUse[] = [];
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === "text") armContent += (block as TextContent).text;
          else if (block.type === "thinking")
            armContent = `<thinking>${(block as ThinkingContent).thinking}</thinking>\n\n${armContent}`;
          else if (block.type === "toolCall") {
            const tc = block as ToolCall;
            armToolUses.push({
              name: tc.name,
              toolUseId: tc.id,
              input: typeof tc.arguments === "string" ? JSON.parse(tc.arguments) : tc.arguments,
            });
          }
        }
      }
      if (!armContent && armToolUses.length === 0) continue;
      history.push({
        assistantResponseMessage: { content: armContent, ...(armToolUses.length > 0 ? { toolUses: armToolUses } : {}) },
      });
    } else if (msg.role === "toolResult") {
      const trMsg = msg as ToolResultMessage;
      const toolResults: KiroToolResult[] = [
        {
          content: [{ text: truncate(getContentText(msg), toolResultLimit) }],
          status: trMsg.isError ? "error" : "success",
          toolUseId: trMsg.toolCallId,
        },
      ];
      const trImages: ImageContent[] = [];
      if (Array.isArray(trMsg.content))
        for (const c of trMsg.content) if (c.type === "image") trImages.push(c as ImageContent);
      let j = i + 1;
      while (j < historyMessages.length && historyMessages[j].role === "toolResult") {
        const next = historyMessages[j] as ToolResultMessage;
        toolResults.push({
          content: [{ text: truncate(getContentText(next), toolResultLimit) }],
          status: next.isError ? "error" : "success",
          toolUseId: next.toolCallId,
        });
        if (Array.isArray(next.content))
          for (const c of next.content) if (c.type === "image") trImages.push(c as ImageContent);
        j++;
      }
      i = j - 1;
      const lastEntryForTr = history[history.length - 1];
      const prevTr = lastEntryForTr?.userInputMessage;
      if (prevTr) {
        // Merge tool results into the previous user message to maintain
        // alternation without synthetic padding. Its `content` is the text a
        // user actually wrote (or a prior turn's tool carrier) — leave it
        // byte-identical. `toolResults` is the payload; text is not needed to
        // carry it, and appending narration here rewrites a human utterance.
        if (trImages.length > 0) prevTr.images = [...(prevTr.images || []), ...convertImagesToKiro(trImages)];
        if (!prevTr.userInputMessageContext) prevTr.userInputMessageContext = {};
        prevTr.userInputMessageContext.toolResults = [
          ...(prevTr.userInputMessageContext.toolResults || []),
          ...toolResults,
        ];
      } else {
        history.push({
          userInputMessage: {
            // Empty by design: `toolResults` is this turn's payload. See
            // EMPTY_CONTENT_PLACEHOLDER for the content-or-toolResults rule.
            content: "",
            modelId,
            origin: "KIRO_CLI",
            ...(trImages.length > 0 ? { images: convertImagesToKiro(trImages) } : {}),
            userInputMessageContext: { toolResults },
          },
        });
      }
    }
  }
  return { history, systemPrepended, currentMsgStartIdx };
}
