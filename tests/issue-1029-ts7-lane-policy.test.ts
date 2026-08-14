// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1029 — TS7 lane policy (project decision, 2026-08-14).
//
// TypeScript 7 may back the parser/checker frontend ONLY in the Node lane.
// The browser and runtime-eval lanes stay pinned to typescript@5 permanently
// — TS7's programmatic API is a Go subprocess over IPC, and neither lane can
// spawn one (the browser has no process model; runtime-eval re-enters the
// pipeline SYNCHRONOUSLY and must work in the browser too).
//
// These tests pin the policy itself and the dynamic scope that enforces the
// eval carve-out, so a future slice that routes parsing through TS7 cannot
// silently lose the carve-out.
import { describe, expect, it } from "vitest";
import { currentTsFrontendLane, isTs7, isTs7Active, runWithTs5Pinned, ts7EligibleForLane } from "../src/ts-api.ts";

describe("#1029 TS7 lane policy", () => {
  it("permits TS7 only in the node lane", () => {
    expect(ts7EligibleForLane("node")).toBe(true);
    expect(ts7EligibleForLane("browser")).toBe(false);
    expect(ts7EligibleForLane("runtime-eval")).toBe(false);
  });

  it("reports the node lane in this (Node, non-eval) context", () => {
    expect(currentTsFrontendLane()).toBe("node");
  });

  it("reports the runtime-eval lane inside a TS5 pin, and restores after", () => {
    const inside = runWithTs5Pinned(() => currentTsFrontendLane());
    expect(inside).toBe("runtime-eval");
    expect(currentTsFrontendLane()).toBe("node");
  });

  it("nests (an eval'd module may itself eval) and unwinds on throw", () => {
    runWithTs5Pinned(() => {
      expect(currentTsFrontendLane()).toBe("runtime-eval");
      runWithTs5Pinned(() => {
        expect(currentTsFrontendLane()).toBe("runtime-eval");
      });
      // Still pinned after the inner scope exits — depth, not a boolean.
      expect(currentTsFrontendLane()).toBe("runtime-eval");
    });
    expect(currentTsFrontendLane()).toBe("node");

    expect(() =>
      runWithTs5Pinned(() => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    // The finally-block must unwind the depth even on a throw, or every
    // later compile in the process would be wrongly pinned to TS5.
    expect(currentTsFrontendLane()).toBe("node");
  });

  it("isTs7Active is never true inside the eval pin, whatever the flag says", () => {
    // The suite runs without JS2WASM_TS7, so the flag is off and both are
    // false; the load-bearing assertion is the implication, which holds in
    // either configuration.
    expect(isTs7Active()).toBe(isTs7 && ts7EligibleForLane(currentTsFrontendLane()));
    expect(runWithTs5Pinned(() => isTs7Active())).toBe(false);
  });
});
