// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #6760 — the per-edition conformance ratchet must STILL BLOCK the merge queue
 * after being deferred to the end of `merge shard reports`, and the #1897
 * standalone regression guard must run in between.
 *
 * Why this file exists. On 2026-09-29 the ratchet failed first in every merge
 * group (ES5 lost `harness/compare-array-arguments.js`), so every later step
 * was skipped, the #1897 guard among them. The parks said "ES5 -1, host-free
 * -54" and never named the other moved rows. The ratchet now defers exactly the
 * way the #2097 floor does (#6461, pinned by its own test):
 *
 *   (a) the ratchet step is non-fatal AT THAT POINT   (`continue-on-error`, `id:`)
 *   (b) a LATER step in the SAME job re-raises it     (`outcome == 'failure'` → exit 1)
 *   (c) the #1897 standalone regression guard sits BETWEEN them
 *
 * Parsed as text, not YAML, like the #6461 test.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOW = resolve(ROOT, ".github/workflows/test262-sharded.yml");

const lines = readFileSync(WORKFLOW, "utf-8").split("\n");

function lineOf(needle: string): number {
  return lines.findIndex((l) => l.includes(needle));
}

/** The step block (name line through the line before the next `- name:`). */
function stepBlock(nameLine: string): string {
  const start = lineOf(nameLine);
  expect(start, `step not found: ${nameLine}`).toBeGreaterThanOrEqual(0);
  let end = start + 1;
  while (end < lines.length && !/^ {6}- name: /.test(lines[end] ?? "")) end++;
  return lines.slice(start, end).join("\n");
}

const RATCHET = "- name: Per-edition conformance ratchet (no completed edition may regress)";
const DEFERRED = "- name: Fail on per-edition ratchet breach (deferred, #6760)";
const GUARD_1897 = "- name: Standalone regression guard (#1897)";

describe("#6760 — deferred per-edition ratchet keeps blocking the merge queue", () => {
  it("the ratchet step is identified and non-fatal at its own position", () => {
    const block = stepBlock(RATCHET);
    expect(block).toContain("id: edition_ratchet");
    expect(block).toContain("continue-on-error: true");
    expect(block).toContain("scripts/test262-edition-ratchet.ts");
  });

  it("a later step re-raises the failure, so the required check still fails", () => {
    const block = stepBlock(DEFERRED);
    // The OUTCOME is the step's real result; `continue-on-error` rewrites its
    // CONCLUSION to success.
    expect(block).toContain("steps.edition_ratchet.outcome == 'failure'");
    expect(block).toContain("always()");
    expect(block).toMatch(/exit 1/);
    expect(block).not.toContain("continue-on-error");
  });

  it("the #1897 per-test standalone guard runs BETWEEN the two", () => {
    const ratchet = lineOf(RATCHET);
    const guard = lineOf(GUARD_1897);
    const deferred = lineOf(DEFERRED);
    expect(ratchet).toBeGreaterThanOrEqual(0);
    expect(guard).toBeGreaterThan(ratchet);
    expect(deferred).toBeGreaterThan(guard);
  });

  it("both halves live in the `merge shard reports` job", () => {
    const job = lineOf("  merge-report:");
    const nextJob = lines.findIndex((l, i) => i > job && /^ {2}[a-z0-9-]+:$/.test(l));
    expect(lineOf(RATCHET)).toBeGreaterThan(job);
    expect(lineOf(DEFERRED)).toBeGreaterThan(job);
    expect(lineOf(DEFERRED)).toBeLessThan(nextJob);
  });
});
