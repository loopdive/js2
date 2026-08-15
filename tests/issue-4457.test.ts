// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4457 — the standalone lane's host-surface rejections carry their own typed
// reason instead of the generic, *unintended* `body-shape-rejected` bucket.
//
// What these tests protect, and why it is easy to regress:
//   - `host-surface-unavailable` must fire ONLY where the target's capability
//     policy actually defers the host surface. A regression that armed it in
//     the JS-host lane would silently stop 37/37 units from claiming while the
//     lane summary still looked plausible.
//   - The reclassification must be a pure RE-BUCKETING: the standalone lane's
//     total unsupported count and its emitted count must not move. If a future
//     change makes it hide a real rejection, that invariant breaks first.
import { describe, expect, it } from "vitest";

import { observeSingleHostLane, observeStandaloneLane } from "../scripts/check-ir-only.js";
import type { IrObservedOutcome } from "../src/index.js";

function unsupportedByCode(outcomes: readonly IrObservedOutcome[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const outcome of outcomes) {
    if (outcome.kind !== "unsupported") continue;
    const key = `${outcome.stage}/${outcome.code}`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

describe("#4457 standalone host-surface rejections are typed, not body-shape-rejected", () => {
  it("buckets the standalone lane's ambient-host-global units under host-surface-unavailable", async () => {
    const lane = await observeStandaloneLane();
    const outcomes = lane.entries.flatMap((entry) => entry.outcomes);
    const counts = unsupportedByCode(outcomes);

    // The six measured members: calendar el/main, builtins el/main (`document`)
    // and algorithms/classes main (`console`). See plan/issues/4457-*.md for the
    // per-unit arm table.
    expect(counts["select/host-surface-unavailable"]).toBe(6);

    const named = outcomes
      .filter((outcome) => outcome.kind === "unsupported" && outcome.code === "host-surface-unavailable")
      .map((outcome) => `${outcome.file.replace(/^.*examples\//, "")}::${outcome.displayName}`)
      .sort();
    expect(named).toEqual([
      "dom/calendar.ts::el",
      "dom/calendar.ts::main",
      "js/algorithms.ts::main",
      "js/builtins.ts::el",
      "js/builtins.ts::main",
      "js/classes.ts::main",
    ]);
  });

  it("leaves the residual body-shape-rejected bucket at the genuinely shape-owned units", async () => {
    const lane = await observeStandaloneLane();
    const counts = unsupportedByCode(lane.entries.flatMap((entry) => entry.outcomes));
    // calendar renderCal/updFoot (HTMLElement module storage) and async delay
    // (host async). The algorithms pair (`fibMemo` + `<module-init>`) was the
    // other two until #4461 gave the native `$Map` its own IR storage kind;
    // this count is a residual, so it moves DOWN as those chains land.
    expect(counts["select/body-shape-rejected"]).toBe(3);
  });

  it("is a pure re-bucketing: standalone emitted + unsupported still covers every terminal", async () => {
    const lane = await observeStandaloneLane();
    const outcomes = lane.entries.flatMap((entry) => entry.outcomes);
    // #4457 itself moved NOTHING between these two counts (17/20). #4461 then
    // claimed the two native-`$Map` units, so the split is 19/18 — the SUM is
    // what this test protects: a reclassification must never make a unit
    // disappear from the lane's accounting.
    expect(outcomes.filter((outcome) => outcome.kind === "emitted")).toHaveLength(19);
    expect(outcomes.filter((outcome) => outcome.kind === "unsupported")).toHaveLength(18);
    expect(outcomes).toHaveLength(37);
    // The typed reason must never be minted as an `invariant` outcome.
    expect(outcomes.filter((outcome) => outcome.kind === "invariant")).toHaveLength(0);
  });

  it("never fires in the JS-host lane, which stays fully IR-claimed", async () => {
    const lane = await observeSingleHostLane();
    const outcomes = lane.entries.flatMap((entry) => entry.outcomes);
    expect(unsupportedByCode(outcomes)["select/host-surface-unavailable"]).toBeUndefined();
    expect(outcomes.filter((outcome) => outcome.kind === "emitted")).toHaveLength(37);
    expect(outcomes.filter((outcome) => outcome.kind !== "emitted")).toHaveLength(0);
  });
});
