// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #3115 — refresh-workflow stale-checkout guard.
 *
 * Root cause (2026-07-09 wedge): the post-merge baseline-refresh jobs check out
 * main@T (github.sha), recompute the coercion-site drift baseline
 * (`scripts/coercion-sites-baseline.json`) from that checkout's source, then
 * RE-ANCHOR onto main's *current* tip (T+k) before committing — because a PR may
 * have merged in between. `scripts/check-coercion-sites.mjs` is a PURE
 * src/codegen/** grep, so its correct value depends on the tree it lands on. When
 * a PR that changed the coercion-site count merged between T and T+k (#2812 bumped
 * codegen/property-access.ts 16 -> 17), banking the T-snapshot value (16) over the
 * T+k source (17) committed an internally inconsistent pair and turned the REQUIRED
 * `check:coercion-sites` gate RED on main, wedging the whole merge queue.
 *
 * The fix: recompute the coercion baseline INSIDE the re-anchor push loop, AFTER
 * the `git checkout -f -B <tmp> deploykey/main` re-anchor, so the committed
 * baseline is correct-by-construction for the exact tree being pushed. This pins
 * that ordering invariant in both refresh jobs so a future refactor can't quietly
 * move the recompute back before the re-anchor and reintroduce the wedge.
 *
 * Intentionally dependency-free (text-order assertions only) — no YAML parser or
 * network — so it runs in any lane.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..");

/** Every refresh job that recomputes the source-derived coercion baseline and
 *  re-anchors onto main's fresh tip before committing. Each entry pins the loop's
 *  re-anchor checkout marker; the recompute MUST come after it. */
const REFRESH_JOBS = [
  {
    file: ".github/workflows/test262-sharded.yml",
    reAnchorMarker: "git checkout -f -B _promote_tmp deploykey/main",
    // The `git commit` that lands the [skip ci] baseline refresh on main.
    commitMarker: 'git commit -m "chore(test262): refresh sharded baseline',
  },
  {
    file: ".github/workflows/baseline-summary-sync.yml",
    reAnchorMarker: "git checkout -f -B _summary_sync_tmp deploykey/main",
    commitMarker: 'git commit -m "chore(test262): scheduled baseline summary sync',
  },
] as const;

const RECOMPUTE = "node scripts/check-coercion-sites.mjs --update";
const RESTAGE = "git add -f scripts/coercion-sites-baseline.json";

describe("#3115 — coercion baseline is recomputed after the re-anchor, not banked stale", () => {
  for (const job of REFRESH_JOBS) {
    describe(job.file, () => {
      const text = readFileSync(resolve(ROOT, job.file), "utf8");

      it("re-anchors the working tree onto main's fresh tip inside a push loop", () => {
        expect(text).toContain(job.reAnchorMarker);
        expect(text).toContain(job.commitMarker);
      });

      it("recomputes the source-derived coercion baseline AFTER the re-anchor checkout", () => {
        // The invariant: at least one coercion `--update` recompute must run on
        // the re-anchored tree — i.e. between the re-anchor checkout and the
        // commit that pushes to main. A recompute that only runs BEFORE the
        // re-anchor (against the stale github.sha checkout) is the bug.
        const anchorIdx = text.lastIndexOf(job.reAnchorMarker);
        const commitIdx = text.indexOf(job.commitMarker, anchorIdx);
        expect(anchorIdx).toBeGreaterThanOrEqual(0);
        expect(commitIdx).toBeGreaterThan(anchorIdx);

        const inLoop = text.slice(anchorIdx, commitIdx);
        expect(inLoop).toContain(RECOMPUTE);
        // ...and the freshly recomputed baseline must be re-staged so it lands in
        // the commit (otherwise the recompute is a no-op on the committed tree).
        expect(inLoop).toContain(RESTAGE);
      });

      it("documents the guard so the ordering isn't silently undone", () => {
        expect(text).toContain("#3115");
        expect(text).toMatch(/STALE-CHECKOUT GUARD/);
      });
    });
  }
});
