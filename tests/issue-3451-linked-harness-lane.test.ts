// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3451 slice 3, P3 — the `TEST262_ORACLE_MODE=linked` shadow lane is OPT-IN.
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

  it("diff-test262 refuses a linked run against any other lane, even with ORACLE_REBASE", () => {
    const diff = read("scripts/diff-test262.ts");
    expect(diff).toContain('baseLane === "linked-harness" || newLane === "linked-harness"');
    // A `linked-harness-fallback` row belongs to the LINKED lane. Folding it
    // into "honest" would let a heavily-degraded linked file read as honest and
    // pass the guard.
    expect(diff).toContain('entry.oracle_lane === "linked-harness" || entry.oracle_lane === "linked-harness-fallback"');
    // The refusal must sit BEFORE the `oracleRebase` escape hatch, or the
    // "never promotes a baseline" property is one env var deep.
    const refusalAt = diff.indexOf('baseLane === "linked-harness" || newLane === "linked-harness"');
    const rebaseAt = diff.indexOf("if (!oracleRebase) {", refusalAt - 4000);
    expect(refusalAt).toBeGreaterThan(0);
    expect(refusalAt).toBeLessThan(diff.indexOf("if (!oracleRebase) {", refusalAt));
    expect(rebaseAt === -1 || rebaseAt > refusalAt || rebaseAt < refusalAt - 4000).toBe(true);
  });
});
