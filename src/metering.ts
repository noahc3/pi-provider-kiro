// ABOUTME: Aggregates streamed Kiro credit metering for one root pi interaction.
// ABOUTME: Uses globalThis so in-process subagent extension instances share the same collector.

/**
 * One `MeteringEvent` frame as parsed by event-parser.
 *
 * `credits` mirrors the wire field name chosen upstream (`MeteringEvent.usage`
 * is a COUNT OF CREDITS, not tokens). The accumulated total in
 * {@link KiroMeteringSummary} stays `usage` — that is this module's own running
 * sum, not a wire field.
 */
export interface KiroMeteringData {
  credits?: number;
  unit?: string;
  unitPlural?: string;
}

export interface KiroMeteringSummary {
  usage: number;
  requestCount: number;
  unit?: string;
  unitPlural?: string;
}

interface MeteringCollection extends KiroMeteringSummary {
  ownerSessionId: string;
}

interface MeteringState {
  rootSessionId?: string;
  collection?: MeteringCollection;
}

const STATE_KEY = Symbol.for("pi-provider-kiro:credit-metering");

function getState(): MeteringState {
  const globals = globalThis as typeof globalThis & { [STATE_KEY]?: MeteringState };
  globals[STATE_KEY] ??= {};
  return globals[STATE_KEY];
}

/** The first bound session is the root pi session; nested subagent sessions bind later. */
export function claimRootMeteringSession(sessionId: string): boolean {
  const state = getState();
  state.rootSessionId ??= sessionId;
  return state.rootSessionId === sessionId;
}

export function releaseRootMeteringSession(sessionId: string): void {
  const state = getState();
  if (state.rootSessionId !== sessionId) return;
  state.rootSessionId = undefined;
  state.collection = undefined;
}

/** Begin once and retain the collection through low-level retries and continuations. */
export function beginKiroMeteringCollection(sessionId: string): boolean {
  const state = getState();
  if (state.rootSessionId !== sessionId) return false;
  state.collection ??= { ownerSessionId: sessionId, usage: 0, requestCount: 0 };
  return true;
}

/** Record immediately so metering received before an abort or retry is not lost. */
export function recordKiroMetering(data: KiroMeteringData): void {
  const collection = getState().collection;
  if (!collection || data.credits === undefined || !Number.isFinite(data.credits) || data.credits < 0) return;

  collection.usage += data.credits;
  collection.requestCount++;
  collection.unit ??= data.unit;
  collection.unitPlural ??= data.unitPlural;
}

export function finishKiroMeteringCollection(sessionId: string): KiroMeteringSummary | undefined {
  const state = getState();
  if (state.collection?.ownerSessionId !== sessionId) return undefined;

  const { usage, requestCount, unit, unitPlural } = state.collection;
  state.collection = undefined;
  return { usage, requestCount, unit, unitPlural };
}

export function formatCreditAmount(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 }).format(value);
}

export function formatMeteringAmount(summary: Pick<KiroMeteringSummary, "usage" | "unit" | "unitPlural">): string {
  const singular = summary.unit || "credit";
  const plural = summary.unitPlural || (singular.toLowerCase() === "credit" ? "credits" : singular);
  const unit = summary.usage === 1 ? singular : plural;
  return `${formatCreditAmount(summary.usage)} ${unit.toLowerCase()}`;
}

export function formatTurnMetering(summary: KiroMeteringSummary): string {
  return `Kiro turn usage: ${formatMeteringAmount(summary)}`;
}

/** Reset shared state between unit tests. */
export function resetKiroMeteringState(): void {
  const state = getState();
  state.rootSessionId = undefined;
  state.collection = undefined;
}
