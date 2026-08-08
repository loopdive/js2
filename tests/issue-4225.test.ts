// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4225) The FOLDED-0 twin of #3920's second half.
 *
 * The #3927 hot/cold split is DEFAULT-ON in standalone at K=20. It **removes**
 * cold-moved fields from the base struct's field list — values live in the
 * `$__fnctor_<Name>__cold` tail, presence bits in the tail's words. So
 * `structFieldNames.includes(key)` answers false for a name the instance really
 * carries, and because the receiver is a struct ref (not externref) the fold
 * emitted a constant **false** instead of routing to the runtime.
 *
 * | | before | after | correct |
 * | --- | ---: | ---: | ---: |
 * | cold field, written | 100 | **111** | 111 |
 * | cold field, never written | 0 | 0 | 0 |
 * | hot field, written | 111 | 111 | 111 |
 * | hot field, never written | 11 | 0 | 0 |
 *
 * (Digits: 1 = `in`, 10 = `hasOwnProperty`, 100 = the value read-back. The last
 * row is #3920's folded-1 side, kept here as the paired control.)
 *
 * ## Two properties this file exists to pin
 *
 * 1. **The never-written cold field still answers FALSE.** The fix is a
 *    presence READ through the `$cold` hop, not a blanket demotion of the
 *    fold to `true`. Without this row a fix that simply answered `1` whenever
 *    the name has any storage would pass.
 * 2. **Cold-eligibility is not assumed, it is asserted.** A cold field must be
 *    flow-grown AND `externref`; a numeric one stays on the base struct and the
 *    whole fixture then silently tests nothing. `splits the fixture` reads the
 *    emitted types and fails if the tail does not exist or does not hold the
 *    probed name — the difference between measuring the bug and measuring an
 *    empty room.
 */
import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

/** 25 flow-grown externref fields; at K=20 the split moves `f5`..`f9` to the tail. */
const N = 25;
const COLD_FIELD = "f5";
const HOT_FIELD = "f1";

const SRC = (field: string, write: boolean) => `
function launder(x) { return x ? x : null; }
function Node() { this.type = "Node"; }
function grow(n, k) {
${Array.from({ length: N }, (_, i) => `  if (k === ${i + 1}) n.f${i + 1} = "v${i + 1}";`).join("\n")}
}
export function main() {
  var n = new Node();
  grow(n, 0);
  var a = launder(n);
  ${write ? `a.${field} = "seven";` : "// (never written)"}
  var score = 0;
  if ("${field}" in n) score = score + 1;
  if (n.hasOwnProperty("${field}")) score = score + 10;
  if (a.${field} === "seven") score = score + 100;
  return score;
}
`;

async function runStandalone(source: string): Promise<unknown> {
  const r = await compile(source, { fileName: "t.mjs", skipSemanticDiagnostics: true, target: "standalone" });
  if (!r.success) throw new Error(`compile failed: ${r.errors.map((e) => e.message).join("; ")}`);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  (instance.exports as Record<string, () => void>).__module_init?.();
  return (instance.exports as Record<string, () => unknown>).main!();
}

async function runHost(source: string): Promise<unknown> {
  const r = await compile(source, { fileName: "t.mjs", skipSemanticDiagnostics: true });
  if (!r.success) throw new Error(`compile failed: ${r.errors.map((e) => e.message).join("; ")}`);
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  (imports as { setExports?: (e: Record<string, Function>) => void }).setExports?.(
    instance.exports as Record<string, Function>,
  );
  return (instance.exports as Record<string, () => unknown>).main!();
}

describe("#4225 — the static own-property fold is blind to the cold tail", () => {
  it("splits the fixture: the probed field really is off the base struct", async () => {
    // Instrument check, not a behaviour check. If the split stops happening —
    // K changes, cold-eligibility narrows, the ranking reorders — every other
    // test in this file would pass while measuring the un-split case.
    const r = await compile(SRC(COLD_FIELD, true), {
      fileName: "t.mjs",
      skipSemanticDiagnostics: true,
      target: "standalone",
      emitWat: true,
    });
    expect(r.success).toBe(true);
    const coldType = r.wat.split("\n").find((l) => l.includes("(type $__fnctor_Node__cold"));
    expect(coldType, "no cold tail emitted — the fixture is not exercising the split").toBeDefined();
    expect(coldType).toContain(`$${COLD_FIELD} `);
    const baseType = r.wat.split("\n").find((l) => l.includes("(type $__fnctor_Node ("));
    expect(baseType, "no base fnctor struct emitted").toBeDefined();
    // The defect exists precisely because the base list cannot see the name.
    expect(baseType).not.toContain(`$${COLD_FIELD} `);
    expect(baseType).toContain(`$${HOT_FIELD} `);
  });

  it("answers a WRITTEN cold-tail field present, in both lanes", async () => {
    expect(await runStandalone(SRC(COLD_FIELD, true))).toBe(111);
    expect(await runHost(SRC(COLD_FIELD, true))).toBe(111);
  });

  it("still answers a NEVER-WRITTEN cold-tail field absent", async () => {
    // The acceptance criterion that separates a presence READ from a blanket
    // fold-to-1. A fix that demoted the constant to `true` scores 11 here.
    expect(await runStandalone(SRC(COLD_FIELD, false))).toBe(0);
    expect(await runHost(SRC(COLD_FIELD, false))).toBe(0);
  });

  it("leaves the hot (base-resident) field correct in both directions", async () => {
    // #3920's folded-1 side, as the paired control: the cold fix must not
    // disturb it, and it must not silently become the thing under test.
    expect(await runStandalone(SRC(HOT_FIELD, true))).toBe(111);
    expect(await runStandalone(SRC(HOT_FIELD, false))).toBe(0);
    expect(await runHost(SRC(HOT_FIELD, true))).toBe(111);
    expect(await runHost(SRC(HOT_FIELD, false))).toBe(0);
  });

  it("keeps a folded FALSE for a name with no storage anywhere", async () => {
    // The other half of the soundness argument. `result === 0` is demoted ONLY
    // when the name has OFF-BASE storage; a genuinely absent name must keep its
    // constant, or the fix would answer `true` for anything.
    //
    // Deliberately probes ONLY the absent name — an earlier draft reused the
    // cold-field fixture and its baseline failure came from the cold digit, so
    // it would have passed for the wrong reason on any arm that fixed #4225.
    const src = `
function launder(x) { return x ? x : null; }
function Node() { this.type = "Node"; }
function grow(n, k) {
${Array.from({ length: N }, (_, i) => `  if (k === ${i + 1}) n.f${i + 1} = "v${i + 1}";`).join("\n")}
}
export function main() {
  var n = new Node();
  grow(n, 0);
  var a = launder(n);
  a.${COLD_FIELD} = "seven";
  var score = 0;
  if ("nosuchfield" in n) score = score + 1;
  if (n.hasOwnProperty("nosuchfield")) score = score + 10;
  return score;
}
`;
    expect(await runStandalone(src)).toBe(0);
    expect(await runHost(src)).toBe(0);
  });
});
