// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3953 — the #2097 high-water staleness detector.
//
// The load-bearing tests here are the CONTROLS, not the shape assertions:
//   • POSITIVE control — replay the exact frozen state measured on 2026-08-02
//     (mark 26546 @ 12:14:07Z vs merge_group current 27021) and show it FIRES.
//     A detector that has never been shown to fire on a real defect is not
//     evidence of anything.
//   • NEGATIVE control — a mark that tracks reality stays QUIET, so the alarm
//     is specific rather than merely sensitive.
//   • THIRD-STATE controls — every "cannot see" input resolves to UNKNOWN, not
//     FRESH. This is the whole point: the original bug was invisible precisely
//     because absence rendered as OK.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { classify, FRESH, STALE, UNKNOWN, DEFAULT_MAX_AGE_HOURS } from "../scripts/check-highwater-staleness.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HIGHWATER_FILE = "benchmarks/results/test262-standalone-highwater.json";
const readWorkflow = (name: string) => readFileSync(resolve(REPO_ROOT, ".github/workflows", name), "utf-8");

// The literal committed mark on main at the time #3953 was diagnosed.
const FROZEN_MARK = {
  pass: 26546,
  host_free_pass: 26546,
  official_pass: 26247,
  official_total: 43505,
  sha: "93b8f068bd9ddf43c6f97c9e082fc043cf1f78f5",
  generated_at: "2026-08-02T12:14:07Z",
  tolerance: 50,
};
// What merge_group run 30756313038 actually read at 16:29:07Z.
const OBSERVED_CURRENT = 27021;
const OBSERVED_NOW = new Date("2026-08-02T16:33:32Z");

describe("#3953 high-water staleness detector", () => {
  describe("positive control — the real 2026-08-02 frozen state", () => {
    it("FIRES on the measured mark/current pair", () => {
      const r = classify(FROZEN_MARK, OBSERVED_CURRENT, { now: OBSERVED_NOW });
      expect(r.state).toBe(STALE);
    });

    it("reports the silent permissive headroom as 525 passes", () => {
      const r = classify(FROZEN_MARK, OBSERVED_CURRENT, { now: OBSERVED_NOW });
      // floor = 26546 − 50 = 26496; reality = 27021 → 525 passes could vanish
      // before #2097 fires. This number IS the defect's cost.
      expect(r.floor).toBe(26496);
      expect(r.headroom).toBe(525);
      expect(r.excess).toBe(475);
    });

    it("ages the mark from its own generated_at (~4.3h)", () => {
      const r = classify(FROZEN_MARK, OBSERVED_CURRENT, { now: OBSERVED_NOW });
      expect(r.ageHours).toBeGreaterThan(4);
      expect(r.ageHours).toBeLessThan(4.5);
    });
  });

  describe("negative control — a healthy mark stays quiet", () => {
    it("is FRESH when the mark tracks current within tolerance", () => {
      const r = classify({ ...FROZEN_MARK, host_free_pass: 27000 }, OBSERVED_CURRENT, { now: OBSERVED_NOW });
      // excess = 21 ≤ tolerance 50 → the floor still tracks reality.
      expect(r.state).toBe(FRESH);
    });

    it("is FRESH when a wide gap is younger than the grace window", () => {
      // Same 475-wide gap, but the mark was written 30 minutes ago — a promote
      // is plausibly in flight, so this must NOT alarm.
      const justNow = { ...FROZEN_MARK, generated_at: "2026-08-02T16:03:32Z" };
      const r = classify(justNow, OBSERVED_CURRENT, { now: OBSERVED_NOW });
      expect(r.state).toBe(FRESH);
      expect(r.excess).toBe(475);
    });

    it("still fires once that same gap outlives the grace window", () => {
      const aged = { ...FROZEN_MARK, generated_at: "2026-08-02T12:00:00Z" };
      const r = classify(aged, OBSERVED_CURRENT, {
        now: OBSERVED_NOW,
        maxAgeHours: DEFAULT_MAX_AGE_HOURS,
      });
      expect(r.state).toBe(STALE);
    });
  });

  describe("third state — 'cannot see' is LOUD, never FRESH", () => {
    it("UNKNOWN when the mark file is absent/unreadable", () => {
      expect(classify(null, OBSERVED_CURRENT).state).toBe(UNKNOWN);
      expect(classify(undefined, OBSERVED_CURRENT).state).toBe(UNKNOWN);
    });

    it("UNKNOWN when the mark is garbled (no numeric pass count)", () => {
      expect(classify({ sha: "abc", generated_at: "2026-08-02T12:14:07Z" }, OBSERVED_CURRENT).state).toBe(UNKNOWN);
      expect(classify({ host_free_pass: "lots" }, OBSERVED_CURRENT).state).toBe(UNKNOWN);
      expect(classify({ host_free_pass: Number.NaN }, OBSERVED_CURRENT).state).toBe(UNKNOWN);
    });

    it("UNKNOWN when the current measurement cannot be read", () => {
      expect(classify(FROZEN_MARK, null).state).toBe(UNKNOWN);
      expect(classify(FROZEN_MARK, undefined).state).toBe(UNKNOWN);
      expect(classify(FROZEN_MARK, Number.NaN).state).toBe(UNKNOWN);
    });

    it("UNKNOWN when the mark cannot be AGED — not FRESH by default", () => {
      // This is the subtle one. A mark with no parseable timestamp would, under
      // a naive `age < grace ⇒ fresh` reading, look BRAND NEW and silence the
      // alarm forever — the failure mode this whole issue is about.
      const undateable = { ...FROZEN_MARK, generated_at: undefined };
      const r = classify(undateable, OBSERVED_CURRENT, { now: OBSERVED_NOW });
      expect(r.state).toBe(UNKNOWN);
      expect(r.state).not.toBe(FRESH);

      expect(classify({ ...FROZEN_MARK, generated_at: "not-a-date" }, OBSERVED_CURRENT).state).toBe(UNKNOWN);
    });

    it("still surfaces the numbers it DID manage to read", () => {
      // "I don't know" should not throw away partial evidence.
      const r = classify({ ...FROZEN_MARK, generated_at: "garbage" }, OBSERVED_CURRENT, { now: OBSERVED_NOW });
      expect(r.state).toBe(UNKNOWN);
      expect(r.mark).toBe(26546);
      expect(r.current).toBe(27021);
      expect(r.headroom).toBe(525);
    });
  });

  // These are REGRESSION GUARDS, not evidence the pipeline works — the only
  // evidence for that is the mark actually advancing on main (see #3953's
  // observable-acceptance note). They exist because the defect was precisely an
  // absent line: the promote job's #1951 deferral names baseline-summary-sync as
  // the fallback carrier, and that workflow never staged the file, so the
  // deferral silently discarded every raise.
  describe("the named fallback carrier actually carries the mark", () => {
    it("baseline-summary-sync stages the high-water file", () => {
      const wf = readWorkflow("baseline-summary-sync.yml");
      expect(wf).toContain(`git add -f ${HIGHWATER_FILE}`);
    });

    it("baseline-summary-sync RAISES the mark before staging it", () => {
      // Staging alone would commit whatever stale copy the checkout had.
      const wf = readWorkflow("baseline-summary-sync.yml");
      expect(wf).toContain("check-standalone-highwater.mjs");
      expect(wf).toMatch(/--report "\$SA_REPORT" --update/);
    });

    it("re-anchor loop re-reads the mark from the fetched tip (raise-only race guard)", () => {
      // Without this the snapshot copy-back can LOWER a mark that
      // promote-baseline raised higher while this job was running.
      const wf = readWorkflow("baseline-summary-sync.yml");
      expect(wf).toContain(`git checkout deploykey/main -- ${HIGHWATER_FILE}`);
    });

    it("a stale mark forces a sync even when both reports look unchanged", () => {
      const wf = readWorkflow("baseline-summary-sync.yml");
      expect(wf).toContain("check-highwater-staleness.mjs");
      expect(wf).toContain('[ "$HIGHWATER_STALE" = "0" ]');
      // ...and earns the busy-queue bypass, or promote-defers and sync-skips
      // deadlock while the queue stays busy.
      expect(wf).toContain('[ "$HIGHWATER_STALE_6H" = "0" ]');
    });

    it("the merge_group gate annotates a stale mark", () => {
      const wf = readWorkflow("test262-sharded.yml");
      expect(wf).toContain("Report a STALE high-water mark (#3953)");
      expect(wf).toContain("check-highwater-staleness.mjs");
    });

    it("that annotation is NON-fatal — it must not wedge the required check", () => {
      // `merge shard reports` is required; a lagging mark is an infrastructure
      // fault, never the queued PR's fault.
      const wf = readWorkflow("test262-sharded.yml");
      const idx = wf.indexOf("Report a STALE high-water mark (#3953)");
      expect(idx).toBeGreaterThan(-1);
      expect(wf.slice(idx, idx + 800)).toContain("--annotate || true");
    });
  });

  describe("tolerance is read from the mark, not hardcoded", () => {
    it("honours a mark-supplied tolerance", () => {
      const wide = { ...FROZEN_MARK, tolerance: 1000 };
      const r = classify(wide, OBSERVED_CURRENT, { now: OBSERVED_NOW });
      // excess 475 ≤ tolerance 1000 → not a staleness breach at that tolerance.
      expect(r.state).toBe(FRESH);
      expect(r.tolerance).toBe(1000);
    });
  });
});
