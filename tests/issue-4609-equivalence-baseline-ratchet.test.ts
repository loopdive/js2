// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#4609) The equivalence baseline's known-failure list is a MASK: any test id
// listed in `scripts/equivalence-baseline.json` may fail without failing the
// gate. Twelve entries in it passed on `main` — fixed long ago by other work,
// never ratcheted off — so each was a live regression channel: break one and
// `equivalence-gate.mjs` reports it as "known" and stays green.
//
// Measured on `origin/main` @ 03bd58c04, 8 shards: 36 baseline entries, 24
// actually failing, 12 passing, 0 absent, 0 unlisted regressions. Those 12 were
// removed; this file is the ratchet that keeps them off.
//
// The second and third cases are the MUTATION PROOF, kept permanent rather than
// run once: a guard that does not fire is worse than none. They drive the real
// `equivalence-gate.mjs` — in `MERGE_PARTIALS_DIR` mode, so the gate scores a
// supplied failing/passing set instead of spawning vitest — against the real
// committed baseline. That is the same set comparison each `equivalence-shard`
// job in CI performs, and the verdict must FLIP on membership alone:
//
//   • a ratcheted-off id reported failing  → exit 1, "REGRESSION" (loud)
//   • a still-listed id reported failing   → exit 0, "No new equivalence
//     regressions" (the mask, still working as designed for the real backlog)
//
// The third case is what keeps the second honest: without it, a gate that
// exited 1 on *everything* would pass this file while proving nothing.
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE_PATH = join(REPO_ROOT, "scripts", "equivalence-baseline.json");
const GATE_PATH = join(REPO_ROOT, "scripts", "equivalence-gate.mjs");

/**
 * The 12 stale known-failures removed from the baseline by #4609, verbatim.
 * Each one PASSES on main; re-listing any of them would re-open its mask.
 */
const RATCHETED_OFF: readonly string[] = [
  "tests/equivalence/issue-1197.test.ts :: #1197 i32 element specialization for number[] peephole: redundant `| 0` after i32 read is folded `x | 0` collapses to nothing on an i32-shaped value",
  "tests/equivalence/math-pow-test262-pattern.test.ts :: Math.pow/min/max with array element args (test262 pattern) Math.pow(base[i], exponent) in loop with assert_sameValue",
  "tests/equivalence/spec/coercion-arithmetic-add.test.ts :: coercion/arithmetic-add host any string + any number concatenates (§13.15.3)",
  "tests/equivalence/spec/coercion-arithmetic-add.test.ts :: coercion/arithmetic-add host any string + any string concatenates",
  "tests/equivalence/spec/coercion-arithmetic-add.test.ts :: coercion/arithmetic-add host-O any string + any number concatenates (§13.15.3)",
  "tests/equivalence/spec/coercion-arithmetic-add.test.ts :: coercion/arithmetic-add host-O any string + any string concatenates",
  "tests/equivalence/spec/coercion-arithmetic-add.test.ts :: coercion/arithmetic-add standalone any string + any number concatenates (§13.15.3)",
  "tests/equivalence/spec/coercion-arithmetic-add.test.ts :: coercion/arithmetic-add standalone any string + any string concatenates",
  "tests/equivalence/spec/coercion-arithmetic-add.test.ts :: coercion/arithmetic-add standalone-O any string + any number concatenates (§13.15.3)",
  "tests/equivalence/spec/coercion-arithmetic-add.test.ts :: coercion/arithmetic-add standalone-O any string + any string concatenates",
  "tests/equivalence/symbol-basic.test.ts :: Symbol basic support (#471) Symbol.iterator is a constant",
  "tests/equivalence/symbol-basic.test.ts :: Symbol basic support (#471) well-known symbols are consistent",
];

function knownFailures(): string[] {
  return JSON.parse(readFileSync(BASELINE_PATH, "utf8")).knownFailures as string[];
}

/**
 * Run the real gate over a synthetic merged shard report in which exactly one
 * test id failed. No vitest, no compile — this is the same set comparison CI's
 * "merge shard reports" job performs, against the same committed baseline.
 */
function gateVerdictFor(failingId: string): { status: number; output: string } {
  const dir = mkdtempSync(join(tmpdir(), "equiv-4609-"));
  try {
    writeFileSync(join(dir, "partial.json"), JSON.stringify({ failing: [failingId], passing: [] }));
    const res = spawnSync(process.execPath, [GATE_PATH], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: { ...process.env, MERGE_PARTIALS_DIR: dir, SHARD: "", PARTIAL_OUT: "" },
    });
    return { status: res.status ?? -1, output: `${res.stdout ?? ""}${res.stderr ?? ""}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("#4609 — the equivalence baseline stays ratcheted", () => {
  it("lists none of the 12 entries that pass on main", () => {
    const listed = RATCHETED_OFF.filter((id) => knownFailures().includes(id));
    expect(listed, `re-masked known-failure(s):\n${listed.join("\n")}`).toEqual([]);
  });

  // Guards the ratchet's own premise: these ids must be spelled exactly as the
  // gate mints them ("<relative file> :: <full test name>"), or the entry above
  // would be trivially absent and this file would prove nothing.
  it("spells every ratcheted-off id as a real equivalence test id", () => {
    for (const id of RATCHETED_OFF) {
      expect(id).toMatch(/^tests\/equivalence\/[\w./-]+\.test\.ts :: \S/);
    }
    expect(new Set(RATCHETED_OFF).size).toBe(RATCHETED_OFF.length);
  });

  it("makes the gate FAIL LOUDLY when a ratcheted-off entry breaks again", () => {
    for (const id of RATCHETED_OFF) {
      const { status, output } = gateVerdictFor(id);
      expect(status, `gate did not fail for:\n${id}\n${output}`).toBe(1);
      expect(output).toContain(`REGRESSION: ${id}`);
    }
  });

  // The control. A gate that failed on every input would satisfy the case above
  // while proving nothing, so pin the other side too: an entry still on the
  // known-failure list is still masked, and the gate still exits 0.
  it("still masks an entry that remains on the known-failure list", () => {
    const stillKnown = knownFailures()[0];
    expect(stillKnown, "baseline unexpectedly empty").toBeTruthy();
    const { status, output } = gateVerdictFor(stillKnown!);
    expect(status, output).toBe(0);
    expect(output).toContain("No new equivalence regressions");
  });
});
