// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#4604 S3) The staleness guard's verdict logic. The workflow that runs it is
// only as good as this boundary: everything short of a parseable RECENT
// `generatedAt` must be STALE — the 2026-08-20/21 episode's whole failure mode
// was an alarm condition that nothing classified as one.
import { describe, expect, it } from "vitest";

import { DEFAULT_MAX_AGE_HOURS, judgeNpmCompatFreshness } from "../scripts/lib/npm-compat-freshness.mjs";

const NOW = Date.parse("2026-08-22T12:00:00.000Z");
const artifact = (generatedAt: unknown) => JSON.stringify({ generatedAt, packages: [] });
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

describe("npm-compat staleness guard (#4604 S3)", () => {
  it("accepts an artifact younger than the threshold", () => {
    const v = judgeNpmCompatFreshness(artifact(hoursAgo(3)), { nowMs: NOW });
    expect(v.fresh).toBe(true);
    expect(v.ageHours).toBeCloseTo(3, 5);
  });

  it("rejects an artifact older than the threshold, reporting its age", () => {
    const v = judgeNpmCompatFreshness(artifact(hoursAgo(30)), { nowMs: NOW });
    expect(v.fresh).toBe(false);
    expect(v.reason).toContain("30.0h old");
    expect(v.reason).toContain(`${DEFAULT_MAX_AGE_HOURS}h`);
  });

  it("honors a custom threshold in both directions", () => {
    expect(judgeNpmCompatFreshness(artifact(hoursAgo(3)), { nowMs: NOW, maxAgeHours: 2 }).fresh).toBe(false);
    expect(judgeNpmCompatFreshness(artifact(hoursAgo(20)), { nowMs: NOW, maxAgeHours: 24 }).fresh).toBe(true);
  });

  // The guard's one job is "provably recent" — every unprovable state is the
  // alarm condition, never an error path that skips the alarm.
  it("treats a missing or unreadable artifact as stale", () => {
    expect(judgeNpmCompatFreshness(undefined, { nowMs: NOW }).fresh).toBe(false);
    expect(judgeNpmCompatFreshness("", { nowMs: NOW }).fresh).toBe(false);
  });

  it("treats malformed JSON as stale", () => {
    expect(judgeNpmCompatFreshness("{not json", { nowMs: NOW }).fresh).toBe(false);
  });

  it("treats a missing or unparseable generatedAt as stale", () => {
    expect(judgeNpmCompatFreshness(JSON.stringify({ packages: [] }), { nowMs: NOW }).fresh).toBe(false);
    expect(judgeNpmCompatFreshness(artifact("yesterday-ish"), { nowMs: NOW }).fresh).toBe(false);
  });

  it("flags a generatedAt in the future as a bug, not freshness", () => {
    const v = judgeNpmCompatFreshness(artifact(hoursAgo(-8)), { nowMs: NOW });
    expect(v.fresh).toBe(false);
    expect(v.reason).toContain("future");
  });
});
