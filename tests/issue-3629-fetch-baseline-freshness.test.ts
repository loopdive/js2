// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3629 — `fetch-baseline-jsonl.mjs` served a stale cache silently.
//
// The defect was not "it caches". It is that a cache hit produced NO OUTPUT and
// exit 0 — byte-for-byte indistinguishable from a successful fresh fetch. On
// 2026-07-25 that served a SEVEN-DAY-OLD file reading `pass 25,545` while main
// was at `30,931`; multiple lanes were told to "fetch fresh" with that exact
// command and silently got it. The error scales with cache age and looks
// healthy the whole way.
//
// The controls that matter here are the STALE ones — a test that only checks
// "fresh cache is served" would have passed against the broken version.
import { describe, it, expect } from "vitest";
import {
  classifyCache,
  formatAge,
  CACHE_ABSENT,
  CACHE_TOO_SMALL,
  CACHE_STALE,
  CACHE_FRESH,
  DEFAULT_MAX_AGE_HOURS,
} from "../scripts/fetch-baseline-jsonl.mjs";

const NOW = Date.parse("2026-08-02T18:00:00Z");
const H = 3_600_000;
const BIG = 66_854_653; // the real baseline JSONL size

describe("#3629 baseline cache freshness", () => {
  describe("positive control — the 2026-07-25 seven-day-stale cache", () => {
    it("classifies the real incident's cache as STALE", () => {
      const r = classifyCache({ exists: true, sizeBytes: BIG, mtimeMs: NOW - 7 * 24 * H }, { now: NOW });
      expect(r.state).toBe(CACHE_STALE);
    });

    it("reports its age rather than hiding it", () => {
      const r = classifyCache({ exists: true, sizeBytes: BIG, mtimeMs: NOW - 7 * 24 * H }, { now: NOW });
      expect(r.ageHours).toBeCloseTo(168, 0);
      expect(formatAge(r.ageHours)).toBe("7.0d old");
    });

    it("a size check ALONE would have passed it — which is why age is the fix", () => {
      // The pre-fix guard only asked "is it big enough?". The stale file was a
      // perfectly well-formed 66 MB baseline. Size cannot see this defect.
      const r = classifyCache({ exists: true, sizeBytes: BIG, mtimeMs: NOW - 7 * 24 * H }, { now: NOW });
      expect(r.sizeBytes).toBeGreaterThan(1_000_000);
      expect(r.state).not.toBe(CACHE_FRESH);
    });
  });

  describe("negative control — a genuinely fresh cache is served quietly-but-audibly", () => {
    it("is FRESH inside the window", () => {
      const r = classifyCache({ exists: true, sizeBytes: BIG, mtimeMs: NOW - 1 * H }, { now: NOW });
      expect(r.state).toBe(CACHE_FRESH);
    });

    it("flips to STALE just past the window", () => {
      const inside = classifyCache(
        { exists: true, sizeBytes: BIG, mtimeMs: NOW - (DEFAULT_MAX_AGE_HOURS - 0.5) * H },
        { now: NOW },
      );
      const outside = classifyCache(
        { exists: true, sizeBytes: BIG, mtimeMs: NOW - (DEFAULT_MAX_AGE_HOURS + 0.5) * H },
        { now: NOW },
      );
      expect(inside.state).toBe(CACHE_FRESH);
      expect(outside.state).toBe(CACHE_STALE);
    });

    it("honours an explicit window override", () => {
      const stat = { exists: true, sizeBytes: BIG, mtimeMs: NOW - 24 * H };
      expect(classifyCache(stat, { now: NOW, maxAgeHours: 6 }).state).toBe(CACHE_STALE);
      expect(classifyCache(stat, { now: NOW, maxAgeHours: 48 }).state).toBe(CACHE_FRESH);
    });
  });

  describe("third state — 'cannot establish freshness' must not read as FRESH", () => {
    it("an unreadable mtime classifies STALE, never FRESH", () => {
      // This is the subtle one. Under a naive `now - mtime` with a missing
      // mtime, NaN comparisons are false, so `age > max` is false and the cache
      // would be served as CURRENT — the exact false-empty this issue is about.
      const r = classifyCache({ exists: true, sizeBytes: BIG }, { now: NOW });
      expect(r.state).toBe(CACHE_STALE);
      expect(r.state).not.toBe(CACHE_FRESH);
      expect(r.ageHours).toBeNull();
    });

    it("formatAge says UNKNOWN rather than rendering a blank or a zero", () => {
      expect(formatAge(null)).toBe("age UNKNOWN");
      expect(formatAge(undefined)).toBe("age UNKNOWN");
      expect(formatAge(Number.NaN)).toBe("age UNKNOWN");
      // A blank/0 would read as "brand new" — the same silent-success shape.
      expect(formatAge(null)).not.toContain("0");
    });

    it("a truncated cache is TOO_SMALL, not FRESH, however recent", () => {
      const r = classifyCache({ exists: true, sizeBytes: 1024, mtimeMs: NOW }, { now: NOW });
      expect(r.state).toBe(CACHE_TOO_SMALL);
    });

    it("an absent cache is ABSENT", () => {
      expect(classifyCache({ exists: false }, { now: NOW }).state).toBe(CACHE_ABSENT);
      expect(classifyCache(null as never, { now: NOW }).state).toBe(CACHE_ABSENT);
    });
  });

  describe("age formatting is legible at every scale", () => {
    it("renders minutes, hours and days", () => {
      expect(formatAge(0.5)).toBe("30m old");
      expect(formatAge(4.25)).toBe("4.3h old");
      expect(formatAge(168)).toBe("7.0d old");
    });
  });
});
