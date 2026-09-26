// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6651 lane GEN1 — the ES2015 × `generators` feature-tag bucket on
// `--target standalone`.
//
// The bucket turned out to be 123 not-pass rows with no cause worth more than
// three (see the lane receipt in
// `plan/issues/6651-es2015-standalone-100pct-execution-plan.md`). ONE cause
// landed, and it is not generator-specific at all:
//
// `destructureParamArray`'s externref lane emits SEVERAL MUTUALLY EXCLUSIVE
// arms for one pattern — a native-generator arm, one arm per candidate tuple
// struct (#862), then the generic `__vec_externref` arm — and each arm
// recursively re-emits the SAME pattern with its OWN element type. A rest
// binding is the one binding whose slot is re-allocated when those types
// disagree (the #971 re-type in the rest-vec build), and `allocLocal` remaps the
// NAME, so the arm emitted LAST owns the binding while every earlier arm keeps
// writing an orphaned slot. When an earlier arm wins at run time, the body then
// reads a local that nothing ever wrote.
//
// WAT-verified on the base tree: `function f([[...x] = values]) {}` emitted TWO
// `(local $x …)` slots of different vec types (`(ref null 4)` written by the
// tuple arm, `(ref null 2)` read by the body), and the tuple arm also set the
// `__dparam_done` sentinel — so the generic arm never ran and `x` read back
// `undefined`. The fix makes the tuple arm hand a REST-BEARING sub-pattern to
// the recursion as `externref`, the representation the generic arm also
// produces, so exactly one slot is minted.
//
// Two details are load-bearing and are pinned below:
//   - the DEFAULT check stays on the tuple FIELD's own type. A missing tuple
//     element rides the field as a wasm null, which §13.3.3.6 step 5 says fires
//     the default, while `__extern_is_undefined` (the externref check)
//     deliberately answers false for a null externref because there that
//     encodes JS `null`. A first cut re-typed the default check too and turned
//     the whole family into `TypeError: Cannot destructure 'null' or
//     'undefined'`.
//   - the gate is NOT `ctx.standalone`. The arm it sits in runs on both
//     targets, so the host lane is measured, not assumed (see the receipt).
//
// Measured, authoritative lane (`tests/test262-shared.ts::runTest262Chunk`,
// `TEST262_PATH_FILTER_FILE`, `TEST262_IT_TIMEOUT_MS=420000`, pool 2,
// shard-completion manifest checked on every sweep quoted).
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

/**
 * Compile a test262-shaped module (loose, untyped, top-level statements) the way
 * the runner does and answer the accumulated `__r` bitmask.
 *
 * `target` is a parameter because this change is NOT standalone-gated: the host
 * arm of every case below is the measurement that host behaviour did not move.
 */
async function runTest262Shaped(body: string, target: "standalone" | "gc" = "standalone"): Promise<number> {
  const source = `var __r = 0;\n${body}\nexport function run() { return __r; }\n`;
  const r = await compile(source, {
    fileName: "test.ts",
    skipSemanticDiagnostics: true,
    ...(target === "standalone" ? { target: "standalone", deferTopLevelInit: true } : {}),
  });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(r.binary), "module must be valid Wasm").toBe(true);
  if (target === "standalone") {
    const leaked = r.imports.filter((i) => i.module === "env").map((i) => i.name);
    expect(leaked, `--target standalone leaked env imports: ${leaked.join(", ")}`).toEqual([]);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    const ex = instance.exports as Record<string, () => number>;
    ex.__module_init?.();
    return ex.run!();
  }
  const { instance } = await WebAssembly.instantiate(r.binary, r.importObject!);
  const ex = instance.exports as Record<string, () => number>;
  ex.__module_init?.();
  return ex.run!();
}

// The verbatim body of the `dstr/ary-ptrn-elem-ary-rest-init.js` family, minus
// the harness: a nested array pattern with a REST element, under a default,
// whose slot the outer source does not supply.
const REST_UNDER_DEFAULT_BODY = `
var values = [2, 1, 3];
var b = 0;
function f([[...x] = values]) {
  if (Array.isArray(x)) b |= 1;
  if (x[0] === 2) b |= 2;
  if (x[1] === 1) b |= 4;
  if (x[2] === 3) b |= 8;
  if (x !== values) b |= 16;
}
f([]);
__r = b;
`;

describe("#6651 GEN1 — a rest binding inside a nested pattern gets ONE local slot", () => {
  // THE FIX, function-declaration lane. RED on reverted sources (measured: 1 —
  // `Array.isArray(x)` answered true for a never-written slot, then `x[0]`
  // threw `Cannot access property on null or undefined`), GREEN with it (31).
  it("[[...x] = values] binds the rest element — language/**/dstr/ary-ptrn-elem-ary-rest-init.js", async () => {
    expect(await runTest262Shaped(REST_UNDER_DEFAULT_BODY)).toBe(31);
  });

  // Same shape on the HOST lane. Green on BOTH sides — the measurement that the
  // (un-gated) change leaves host behaviour alone for the shape it targets.
  it("the same shape on the host lane [green on base too]", async () => {
    expect(await runTest262Shaped(REST_UNDER_DEFAULT_BODY, "gc")).toBe(31);
  });

  // THE FIX, generator lane — the reason this row is in the `generators`
  // bucket at all. RED on reverted sources.
  it("a generator parameter binds it too — language/statements/generators/dstr/…", async () => {
    expect(
      await runTest262Shaped(`
var values = [2, 1, 3];
var b = 0;
var callCount = 0;
function* g([[...x] = values]) {
  if (Array.isArray(x) && x.length === 3 && x[0] === 2 && x[2] === 3) b |= 1;
  callCount = callCount + 1;
}
g([]).next();
if (callCount === 1) b |= 2;
__r = b;
`),
    ).toBe(3);
  });

  // THE FIX, object-literal generator-method lane (a third emit site, and the
  // third of the three ES2015 × `generators` rows this cause owns).
  it("an object-literal generator method binds it too — language/expressions/object/dstr/…", async () => {
    expect(
      await runTest262Shaped(`
var values = [2, 1, 3];
var b = 0;
var obj = {
  *m([[...x] = values]) {
    if (Array.isArray(x) && x.length === 3 && x[0] === 2) b |= 1;
  },
};
obj.m([]).next();
__r = b;
`),
    ).toBe(1);
  });

  // The default must NOT fire when the outer source DOES supply the element —
  // and this shape was ALSO broken on the base tree (measured: 0), because the
  // duplicate slot does not depend on the default actually running, only on its
  // presence changing which type the tuple arm recurses with.
  it("a supplied element still wins over the default", async () => {
    expect(
      await runTest262Shaped(`
var values = [2, 1, 3];
var b = 0;
function f([[...x] = values]) {
  if (x && x.length === 2 && x[0] === 7 && x[1] === 8) b |= 1;
}
f([[7, 8]]);
__r = b;
`),
    ).toBe(1);
  });

  // NEGATIVE CONTROL — a nested rest with NO default already worked (one slot
  // was minted because both arms agreed on externref). Green on both sides; it
  // fails if the new branch perturbs the arm it does not own.
  it("a nested rest with no default is unchanged [green on base too]", async () => {
    expect(
      await runTest262Shaped(`
var b = 0;
function f([[...z]]) {
  if (z && z.length === 2 && z[0] === 7 && z[1] === 8) b |= 1;
}
f([[7, 8]]);
__r = b;
`),
    ).toBe(1);
  });

  // NEGATIVE CONTROL — a nested pattern under a default with NO rest inside is
  // outside the new branch (`patternBindsRestAtAnyDepth` is false), so it keeps
  // the tuple FIELD's type. Green on both sides.
  it("a nested non-rest pattern under a default is unchanged [green on base too]", async () => {
    expect(
      await runTest262Shaped(`
var values = [2, 1, 3];
var b = 0;
function f([[p, q] = values]) {
  if (p === 2 && q === 1) b |= 1;
}
f([]);
__r = b;
`),
    ).toBe(1);
  });

  // NEGATIVE CONTROL, recorded residual. A rest over a STRING default is the
  // one member of this family the fix does NOT reach: `[...x] = "ab"` must bind
  // `["a","b"]` (§7.4.2 GetIterator on a String), and standalone still answers a
  // non-2 length. Asserted in its CURRENT (spec-wrong) state deliberately, so a
  // later lane closing it gets a failing assertion here instead of silently
  // moving a boundary nobody recorded. Host answers 1.
  it("residual: a rest over a STRING default is still wrong on standalone", async () => {
    const body = `
var b = 0;
function f([[...x] = "ab"]) {
  if (x && x.length === 2) b |= 1;
}
f([]);
__r = b;
`;
    expect(await runTest262Shaped(body)).toBe(0);
    expect(await runTest262Shaped(body, "gc")).toBe(1);
  });
});
