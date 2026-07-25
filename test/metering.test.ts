import { beforeEach, describe, expect, it } from "vitest";
import {
  beginKiroMeteringCollection,
  claimRootMeteringSession,
  finishKiroMeteringCollection,
  formatTurnMetering,
  recordKiroMetering,
  releaseRootMeteringSession,
  resetKiroMeteringState,
} from "../src/metering.js";

describe("Kiro credit metering", () => {
  beforeEach(() => resetKiroMeteringState());

  it("sums fractional events from root and nested requests", () => {
    expect(claimRootMeteringSession("root")).toBe(true);
    expect(claimRootMeteringSession("subagent")).toBe(false);
    expect(beginKiroMeteringCollection("root")).toBe(true);

    recordKiroMetering({ usage: 0.125, unit: "credit", unitPlural: "credits" });
    recordKiroMetering({ usage: 0.375, unit: "credit", unitPlural: "credits" });

    expect(finishKiroMeteringCollection("root")).toEqual({
      usage: 0.5,
      requestCount: 2,
      unit: "credit",
      unitPlural: "credits",
    });
  });

  it("keeps one collection through low-level retries", () => {
    claimRootMeteringSession("root");
    beginKiroMeteringCollection("root");
    recordKiroMetering({ usage: 0.2 });
    beginKiroMeteringCollection("root");
    recordKiroMetering({ usage: 0.3 });

    expect(finishKiroMeteringCollection("root")?.usage).toBeCloseTo(0.5);
  });

  it("does not let a nested session finish the root collection", () => {
    claimRootMeteringSession("root");
    beginKiroMeteringCollection("root");
    recordKiroMetering({ usage: 1 });

    expect(finishKiroMeteringCollection("subagent")).toBeUndefined();
    expect(finishKiroMeteringCollection("root")?.usage).toBe(1);
  });

  it("ignores invalid usage values and formats the summary", () => {
    claimRootMeteringSession("root");
    beginKiroMeteringCollection("root");
    recordKiroMetering({ usage: Number.NaN });
    recordKiroMetering({ usage: -1 });
    recordKiroMetering({ usage: 0.123456, unit: "credit", unitPlural: "credits" });

    const summary = finishKiroMeteringCollection("root");
    expect(summary).toBeDefined();
    if (!summary) throw new Error("Expected a metering summary");
    expect(summary.requestCount).toBe(1);
    expect(formatTurnMetering(summary)).toBe("Kiro turn usage: 0.1235 credits");
  });

  it("releases ownership at root session shutdown", () => {
    claimRootMeteringSession("root");
    releaseRootMeteringSession("root");
    expect(claimRootMeteringSession("next-root")).toBe(true);
  });
});
