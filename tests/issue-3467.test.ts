// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3467 — the test262 regression gate diffs each PR against its REAL merge-base
// commit's cached results (runs/<base_sha>.jsonl), not a drifting promoted
// snapshot. These tests cover the ordered-candidate ancestor-walk resolver that
// backs the "Load cached baseline for merge-base" workflow step: base_sha first,
// then nearest-first ancestors, with the commit DISTANCE surfaced so a cold base
// is never silent.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolveFromCandidates } from "../scripts/resolve-merge-base-baseline.mjs";

const ROOT = resolve(import.meta.dirname ?? ".", "..");

describe("#3467 resolveFromCandidates ancestor-walk", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rc3467-"));
    mkdirSync(join(dir, "runs"), { recursive: true });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function writeEntry(sha: string, test262Version?: string) {
    writeFileSync(join(dir, "runs", `${sha}.jsonl`), '{"test":"a","result":"pass"}\n');
    writeFileSync(
      join(dir, "runs", `${sha}.json`),
      JSON.stringify({ sha, pass: 30000, total: 43000, test262_version: test262Version ?? null }),
    );
  }

  it("HIT at distance 0 when the exact base_sha is cached", () => {
    writeEntry("basecommit", "v262");
    const r = resolveFromCandidates(dir, ["basecommit", "anc1", "anc2"], "v262");
    expect(r.hit).toBe(true);
    expect(r.sha).toBe("basecommit");
    expect(r.distance).toBe(0);
  });

  it("walks to the NEAREST cached ancestor when the exact base is a cold miss", () => {
    // base + first ancestor uncached; second ancestor cached.
    writeEntry("anc2", "v262");
    const r = resolveFromCandidates(dir, ["basecommit", "anc1", "anc2", "anc3"], "v262");
    expect(r.hit).toBe(true);
    expect(r.sha).toBe("anc2");
    expect(r.distance).toBe(2);
    expect(r.reason).toContain("2 commit(s) back");
  });

  it("prefers the closer ancestor when multiple are cached", () => {
    writeEntry("anc1", "v262");
    writeEntry("anc3", "v262");
    const r = resolveFromCandidates(dir, ["basecommit", "anc1", "anc2", "anc3"], "v262");
    expect(r.sha).toBe("anc1");
    expect(r.distance).toBe(1);
  });

  it("MISS when no candidate is cached (falls back to promoted snapshot)", () => {
    const r = resolveFromCandidates(dir, ["basecommit", "anc1", "anc2"], "v262");
    expect(r.hit).toBe(false);
    expect(r.distance).toBe(-1);
    expect(r.reason).toContain("no cached entry");
  });

  it("MISS on an empty candidate list", () => {
    const r = resolveFromCandidates(dir, [], "v262");
    expect(r.hit).toBe(false);
    expect(r.reason).toContain("no candidate");
  });

  it("skips version-mismatched entries and continues walking", () => {
    // base cached but for a DIFFERENT test262 corpus → must skip, not shadow.
    writeEntry("basecommit", "v261");
    writeEntry("anc1", "v262");
    const r = resolveFromCandidates(dir, ["basecommit", "anc1"], "v262");
    expect(r.hit).toBe(true);
    expect(r.sha).toBe("anc1");
    expect(r.distance).toBe(1);
  });

  it("honors a version-matched exact base over a version-compatible ancestor", () => {
    writeEntry("basecommit", "v262");
    writeEntry("anc1", "v262");
    const r = resolveFromCandidates(dir, ["basecommit", "anc1"], "v262");
    expect(r.sha).toBe("basecommit");
    expect(r.distance).toBe(0);
  });

  it("ignores empty/blank candidate slots without throwing", () => {
    writeEntry("anc1", "v262");
    const r = resolveFromCandidates(dir, ["", "anc1"], "v262");
    expect(r.hit).toBe(true);
    // the blank slot is filtered out, so anc1 is index 0 of the filtered list.
    expect(r.sha).toBe("anc1");
    expect(r.distance).toBe(0);
  });
});

describe("#3467 merge-base cache workflow contract", () => {
  const workflow = readFileSync(resolve(ROOT, ".github/workflows/test262-sharded.yml"), "utf8");
  const stepStart = workflow.indexOf("- name: Load cached baseline for merge-base (#1081, base_sha #3467)");
  const stepEnd = workflow.indexOf("- name: Resolve predecessor-group baseline (#1956)", stepStart);
  const step = workflow.slice(stepStart, stepEnd);

  it("probes the exact base once without blocking the regression gate", () => {
    expect(stepStart).toBeGreaterThanOrEqual(0);
    expect(stepEnd).toBeGreaterThan(stepStart);
    expect(step).toContain("one-shot exact-base probe");
    expect(step).toContain("continuing immediately to the ancestor-walk");
    expect(step).not.toContain("WAITED=");
    expect(step).not.toContain("for attempt in");
    expect(step).not.toContain("sleep 30");
  });

  it("retains both safe fallbacks after an exact-cache miss", () => {
    expect(step).toContain("--max-count=25");
    expect(step).toContain("resolve-merge-base-baseline.mjs");
    expect(workflow.indexOf("- name: Resolve predecessor-group baseline (#1956)")).toBeGreaterThan(stepStart);
  });
});
