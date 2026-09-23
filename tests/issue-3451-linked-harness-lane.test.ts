// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3451 slice 3, P3 — the `TEST262_ORACLE_MODE=linked` lane is OPT-IN *by flag*.
//
// (slice 6, 2026-09-17) The lane is no longer a shadow: CI's host matrix sets
// the flag and the linked oracle produces the published verdicts. The property
// below is unchanged and still worth guarding, because the flag is still what
// selects the lane — every LOCAL run, the scheduled audit lane, and every
// standalone cell leave it unset, and for all of those the honest path must be
// byte-identical. The second describe block asserts the CI side of the flip.
//
// The property under test is the one a shadow lane most easily breaks and least
// visibly: that with the flag UNSET, the authoritative lane is byte-identical.
// Everything the linked lane adds is reachable from a runner that never sets the
// flag — a new branch in `doCompile`, new fields on the compile message, a new
// arm in the row stamp — so "we only added an if" is an assumption, not a fact,
// until the produced BINARY is compared.
//
// Source-level assertions back that up for the parts a binary cannot show: the
// gating expressions themselves, and `diff-test262`'s refusal to compare a
// linked run against an honest baseline (the guard that keeps a non-
// authoritative lane from ever becoming the published number).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { assembleLinkedHarness, assembleOriginalHarness } from "./test262-original-harness.js";
import { parseMeta } from "./test262-runner.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative: string) => readFileSync(join(ROOT, relative), "utf8");

const OPTIONS = {
  allowJs: true,
  fileName: "test.js",
  sourceMap: true,
  sourceMapUrl: "test.wasm.map",
  emitWat: false,
  skipSemanticDiagnostics: true,
  deferTopLevelInit: true,
} as const;

describe("#3451 P3 — linked-harness shadow lane is opt-in", () => {
  // The binary a flag-unset run produces for one row must be exactly what the
  // honest lane produced before this change: same assembly, same options, same
  // bytes. This compiles the honest assembly the way the worker's
  // `originalHarness` branch does and asserts it is deterministic and identical
  // across two compiles — the observable stand-in for "nothing in the honest
  // path moved", since the linked branch is unreachable without the flag.
  it("the honest lane's binary for a row is unchanged and reproducible", async () => {
    const source = `/*---\ndescription: opt-in probe\n---*/\nassert.sameValue(1, 1);\n`;
    const honest = assembleOriginalHarness(source, parseMeta(source));
    const first = await compile(honest.primary.source, OPTIONS);
    const second = await compile(honest.primary.source, OPTIONS);
    expect(first.success).toBe(true);
    expect(Buffer.from(second.binary).equals(Buffer.from(first.binary))).toBe(true);

    // And the linked split feeds the SAME honest text back for the fallback
    // path — `harnessPrefix + bodySource` is the byte-identical assembly, which
    // is what makes a per-row fallback a true honest row rather than an
    // approximation of one.
    const linked = assembleLinkedHarness(source, parseMeta(source));
    expect(linked.harnessPrefix + linked.primary.bodySource).toBe(honest.primary.source);
  }, 180_000);

  it("every linked-lane branch is gated on the opt-in flag", () => {
    const shared = read("tests/test262-shared.ts");
    // The lane is only ever "linked-harness" under the explicit mode AND the
    // host lane — standalone cannot host the provider's value crossing.
    expect(shared).toContain('TEST262_ORACLE_MODE === "linked" && IS_HOST_LANE');
    expect(shared).toContain('const LINKED_HARNESS_ORACLE = ORACLE_LANE === "linked-harness"');
    // The split is computed ONLY when the lane is on; otherwise the message is
    // byte-identical to the pre-#3451 one.
    expect(shared).toContain("LINKED_HARNESS_ORACLE ? assembleLinkedHarness(source, meta) : null");

    const worker = read("scripts/test262-worker.mjs");
    // The worker double-checks rather than trusting the parent, and never takes
    // the linked path for a fixture graph (no provider seam there).
    expect(worker).toContain("linkedHarness && originalHarness && !hasFixtureGraph(fixtureFiles)");
    expect(worker).toContain("msg.linkedHarness === true");
  });

  it("a fallback row is stamped separately and never counted as linked", () => {
    const shared = read("tests/test262-shared.ts");
    expect(shared).toContain('? "linked-harness-fallback"');
    const worker = read("scripts/test262-worker.mjs");
    // Stamped in the ONE result funnel, so a row exiting through any of the
    // dozen `sendResult` paths still reports its fallback.
    expect(worker).toContain("if (currentLinkedFallback && payload");
    expect(worker).toContain("function noteLinkedFallback(reason)");
  });

  // (slice 6) This assertion used to read "diff-test262 refuses a linked run
  // against any other lane, EVEN with ORACLE_REBASE". That unconditional
  // refusal existed because the linked lane was a shadow with no baseline of
  // its own; the authority flip is the reviewed change that gives it one, so
  // the rule is now the ordinary cross-lane one. The property still under test
  // is the one that matters: a cross-lane diff never happens BY DEFAULT, and a
  // degraded linked file can never masquerade as honest.
  it("diff-test262 refuses a cross-lane diff unless a reviewed rebase signal is present", () => {
    const diff = read("scripts/diff-test262.ts");
    // A `linked-harness-fallback` row belongs to the LINKED lane. Folding it
    // into "honest" would let a heavily-degraded linked file read as honest and
    // pass the guard. This normalisation is UNCHANGED by the flip.
    expect(diff).toContain('entry.oracle_lane === "linked-harness" || entry.oracle_lane === "linked-harness-fallback"');
    // The unconditional special case is gone — and stays gone.
    expect(diff).not.toContain("the linked-harness shadow lane is not comparable to any other lane");
    // What replaces it: the lane mismatch routes into a shared refusal whose
    // linked arm accepts EITHER rebase signal — the forward oracle bump
    // (`rebaseMode`) or ORACLE_REBASE=1. The first merge_group run of the flip
    // (35197014849) refused the v13→v14 re-seed because the arm read only the
    // env flag, which CI never sets; the bump is the reviewed signal.
    const mismatchAt = diff.indexOf("baseLane !== undefined && newLane !== undefined && baseLane !== newLane");
    expect(mismatchAt).toBeGreaterThan(0);
    const refusalAt = diff.indexOf("if (!laneRebaseSignal) {", mismatchAt);
    expect(refusalAt).toBeGreaterThan(mismatchAt);
    expect(diff.slice(mismatchAt, refusalAt)).not.toContain("process.exit(2)");
    expect(diff).toContain('const linkedInvolved = baseLane === "linked-harness" || newLane === "linked-harness"');
    expect(diff).toContain("const laneRebaseSignal = linkedInvolved ? rebaseMode : oracleRebase;");
    // A MIXED-lane file is still refused outright, rebase or not — that guard
    // sits before the mismatch branch and is not part of the relaxation.
    expect(diff.indexOf("one side carries MIXED oracle lanes")).toBeLessThan(mismatchAt);
  });

  it("the oracle version is bumped so the first main run is a forward re-baseline", () => {
    const oracle = read("tests/test262-oracle-version.ts");
    expect(oracle).toContain("export const ORACLE_VERSION = 14;");
    // The bump is what makes `rebaseMode` true and therefore the ONLY thing
    // that makes the #3303 ceiling in the issue file readable at all.
    expect(oracle).toContain("#3451 slice 6");
    const issue = read("plan/issues/3451-linked-harness-wasm-separate-compilation.md");
    expect(issue).toContain("regressions-allow:");
    expect(issue).toContain("count: 422");
  });
});

// (#3451 slice 6) The flip lives in workflow ENV, which no test asserted while
// the linked lane was a shadow. Now that these two lines decide which oracle
// produces the PUBLISHED conformance number, they get the same source-level
// protection the gating expressions above have.
describe("#3451 slice 6 — the authoritative host lane runs the linked oracle", () => {
  const workflow = read(".github/workflows/test262-sharded.yml");

  it("both authoritative shard matrices set TEST262_ORACLE_MODE=linked", () => {
    // Once per job env (`test262-shard`, `test262-shard-mg`) — and nowhere else,
    // so the audit lane cannot drift back into linked mode.
    expect(workflow.match(/^ {6}TEST262_ORACLE_MODE: linked$/gm)).toHaveLength(2);
    // The result prefix is deliberately untouched, which is what keeps
    // merge-report / regression gate / promote-baseline / Pages wired as-is.
    expect(workflow).toContain("TEST262_RESULT_PREFIX: ${{ matrix.target.result_prefix }}");
    expect(workflow).toContain("TEST262_RESULT_PREFIX: ${{ matrix.result_prefix }}");
  });

  it("the honest lane is the renamed, never-required AUDIT job", () => {
    expect(workflow).toContain("  test262-honest-audit:");
    expect(workflow).toContain("  merge-honest-audit-report:");
    expect(workflow).toContain("TEST262_RESULT_PREFIX: test262-honest");
    expect(workflow).toContain("RUN_TIMESTAMP: ${{ github.run_id }}-honest-chunk${{ matrix.chunk }}");
    // Schedule + opt-in dispatch only: never pull_request / merge_group / push.
    expect(workflow).toContain(
      "if: github.event_name == 'schedule' || " + "(github.event_name == 'workflow_dispatch' && inputs.honest_audit)",
    );
    expect(workflow).toContain("      honest_audit:");
    expect(workflow).not.toContain("inputs.linked_lane");
  });

  it("the parity report is called with the roles the flip assigns", () => {
    expect(workflow).toContain("--authoritative-label linked");
    expect(workflow).toContain("--audit-label honest");
  });
});
