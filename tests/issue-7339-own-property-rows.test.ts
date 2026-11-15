// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7339 — `R.hasOwnProperty(k)` / `R.propertyIsEnumerable(k)` as a FALLBACK row of
// the #7338 `Object` statics table: it answers only where every arm main has refuses
// the call (a script var on the dynamic slot that #7335's arm does not serve), with
// the checker's type of the call as its representation, and only where no object in
// the program can carry an own method of that name (`ownPropertyTestIsPristine`).
import { afterAll, describe, expect, it, vi } from "vitest";

import { compile, type CompileResult } from "../src/index.js";

// The refusal rows assert the selector's detail, recorded only under the shape diagnostic.
const previousShapeDiag = vi.hoisted(() => {
  const previous = process.env.JS2WASM_IR_SHAPE_DIAG;
  process.env.JS2WASM_IR_SHAPE_DIAG = "1";
  return previous;
});
afterAll(() => {
  if (previousShapeDiag === undefined) Reflect.deleteProperty(process.env, "JS2WASM_IR_SHAPE_DIAG");
  else process.env.JS2WASM_IR_SHAPE_DIAG = previousShapeDiag;
});

type Verdict = "ok" | "threw" | "trap";

async function build(source: string, experimentalIR = true): Promise<CompileResult> {
  const result = await compile(source, {
    fileName: "issue-7339.js",
    allowJs: true,
    skipSemanticDiagnostics: true,
    inferModuleStrictArguments: false,
    scriptGoal: true,
    deferTopLevelInit: true,
    trackIrOutcomes: true,
    experimentalIR,
    target: "standalone",
  } as Parameters<typeof compile>[1]);
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  return result;
}

async function run(result: CompileResult): Promise<Verdict> {
  try {
    const { instance } = await WebAssembly.instantiate(result.binary, {});
    (instance.exports.__module_init as () => void)();
    return "ok";
  } catch (error) {
    return error instanceof WebAssembly.RuntimeError ? "trap" : "threw";
  }
}

function node(source: string): Verdict {
  try {
    new Function(source)();
    return "ok";
  } catch {
    return "threw";
  }
}

function legacyUnits(result: CompileResult) {
  return (result.irOutcomes ?? []).filter((row) => !row.irBodyEmitted && row.kind !== "non-executable");
}

/** A script var holding a table result: no existing arm answers its test, so the row does. */
const ROW = "var o = Object.defineProperty({}, 'p', { value: 1 });";

/** Each runs as node does with no legacy unit, through the row. */
const CLAIMED: Record<string, string> = {
  "own key": `${ROW} if (!o.hasOwnProperty('p')) { throw "x"; }`,
  "propertyIsEnumerable, non-enumerable": `${ROW} if (o.propertyIsEnumerable('p')) { throw "x"; }`,
  "propertyIsEnumerable, enumerable": `var o = Object.defineProperty({}, 'p', { value: 1, enumerable: true }); if (!o.propertyIsEnumerable('p')) { throw "x"; }`,
  "a descriptor result's own fields": `${ROW} var d = Object.getOwnPropertyDescriptor(o, 'p'); if (!d.hasOwnProperty('value') || d.hasOwnProperty('get')) { throw "x"; }`,
  "an inherited key": `${ROW} if (o.hasOwnProperty('toString')) { throw "x"; }`,
  "a number key": `var o = Object.defineProperty({}, '0', { value: 1 }); if (!o.hasOwnProperty(0)) { throw "x"; }`,
  "inside a function": `${ROW} function f() { return o.hasOwnProperty('p'); } if (!f()) { throw "x"; }`,
  // Typed `boolean` by the checker, the test answers the i32, which an array element or object field holds.
  "an array element": `${ROW} var R = [o.hasOwnProperty('p')][0]; if (R !== true) { throw "x"; }`,
  "an object field": `${ROW} var R = ({ f: o.hasOwnProperty('p') }).f; if (R !== true) { throw "x"; }`,
  "a nullish receiver throws before the key runs": `var u; var ran = false; function k() { ran = true; return 'p'; } try { u.hasOwnProperty(k()); throw "no"; } catch (e) { if (!(e instanceof TypeError) || ran) { throw "x"; } }`,
};

/** Typed `any` by the checker, the test answers its boolean boxed onto the carrier; `g` is claimed. */
const BOXED: Record<string, string> = {
  "a script var assigned later, concatenated": `var o; o = { a: 1 }; function g() { return o.hasOwnProperty('a') + ','; } var r = g(); if (String(r) !== "true,") { throw "x"; }`,
  "a script var assigned later, compared": `var o; o = { a: 1 }; function g() { return o.hasOwnProperty('a') === true; } var r = g(); if (r !== true) { throw "x"; }`,
};

/** Main's arms keep these calls (a parameter, a local, a #7335 dynamic home): claimed and answered as on main. */
const MAINS: Record<string, string> = {
  "a dynamic parameter, added to a number": `function g(x) { return x.hasOwnProperty('a') + 1; } var r = g({ a: 1 }); if (String(r) !== "2") { throw "x"; }`,
  "a dynamic parameter, loosely compared": `function g(x) { return x.hasOwnProperty('a') == 1; } var r = g({ a: 1 }); if (String(r) !== "true") { throw "x"; }`,
  "a local static result, loosely compared": `function g() { var x = Object.defineProperty({}, 'a', { value: 1, enumerable: true }); return x.hasOwnProperty('a') == 1; } if (g() !== true) { throw "x"; }`,
  "a dynamic home": `var o = {}; Object.defineProperty(o, 'p', { value: 1 }); function g() { return o.hasOwnProperty('p'); } if (!g()) { throw "x"; }`,
};

/** The test, in its own unit `t` so its refusal is the first that unit records. */
const T = "function t() { var h = o.hasOwnProperty('p'); return h === true; } var r = t();";

/** Each is no row call (untrusted, or another arity): main's route refuses `t` at select, and it answers as legacy does. */
const NOT_ROW: Record<string, string> = {
  "the method stored on the object": `${ROW} o.hasOwnProperty = function () { return true; }; ${T}`,
  "a store under a key the source does not spell": `${ROW} var k = 'has' + 'OwnProperty'; var q = Object.create({}); q[k] = 1; ${T}`,
  "a computed literal key": `${ROW} var k = 'has' + 'OwnProperty'; var q = { [k]: 1 }; ${T}`,
  "a shadowed NaN as a key": `${ROW} function f(NaN) { var q = Object.create({}); q[NaN] = 1; } ${T}`,
  "defineProperty by a computed name": `${ROW} var k = 'has' + 'OwnProperty'; Object['defineProperty'](o, k, { value: 1 }); ${T}`,
  "defineProperty through an alias": `${ROW} var dp = Object.defineProperty; var k = 'has' + 'OwnProperty'; dp(o, k, { value: 1 }); ${T}`,
  "defineProperty through call": `${ROW} var k = 'has' + 'OwnProperty'; Object.defineProperty.call(null, o, k, { value: 1 }); ${T}`,
  "the name as a string": `${ROW} var name = 'hasOwnProperty'; var n = name.length; ${T}`,
  "an Object.create(null) somewhere": `${ROW} var n = Object.create(null); ${T}`,
  "JSON.parse somewhere": `${ROW} var j = JSON.parse('{}'); ${T}`,
  "two arguments": `${ROW} function t() { return o.hasOwnProperty('p', 1); } var r = t();`,
};

/** Each keeps a unit legacy, refused at select with the stated code, and answers as legacy does. */
const REFUSED: Record<string, { readonly source: string; readonly detail: string }> = {
  // A read of an inherited member other than `toString`: the open object's member read does not answer it (#7304).
  "an inherited member read beside the test": {
    source: `${ROW} function t() { return o.hasOwnProperty('p') && o.valueOf !== undefined; } var r = t();`,
    detail: "expr-carrier-inherited-member",
  },
};

describe("#7339 — own-property tests as rows of the Object statics table", () => {
  for (const [name, source] of Object.entries(CLAIMED)) {
    it(`claims whole and answers as node does: ${name}`, async () => {
      const ir = await build(source);
      expect(ir.irPostClaimErrors ?? []).toEqual([]);
      expect(legacyUnits(ir), JSON.stringify(legacyUnits(ir))).toEqual([]);
      expect(node(source)).toBe("ok");
      expect(await run(ir)).toBe("ok");
    });
  }

  for (const [name, source] of Object.entries(MAINS)) {
    it(`keeps main's route and answers as node does: ${name}`, async () => {
      const ir = await build(source);
      expect(ir.irPostClaimErrors ?? []).toEqual([]);
      expect(legacyUnits(ir).map((row) => row.displayName)).not.toContain("g");
      expect(node(source)).toBe("ok");
      expect(await run(ir)).toBe("ok");
    });
  }

  for (const [name, source] of Object.entries(BOXED)) {
    it(`claims the test's unit and answers as node does: ${name}`, async () => {
      const ir = await build(source);
      expect(ir.irPostClaimErrors ?? []).toEqual([]);
      expect(legacyUnits(ir).map((row) => row.displayName)).not.toContain("g");
      expect(node(source)).toBe("ok");
      expect(await run(ir)).toBe("ok");
    });
  }

  for (const [name, source] of Object.entries(NOT_ROW)) {
    it(`keeps main's refusal and answers as legacy does: ${name}`, async () => {
      const ir = await build(source);
      expect(ir.irPostClaimErrors ?? []).toEqual([]);
      const t = legacyUnits(ir).find((row) => row.displayName === "t");
      expect(t?.stage).toBe("select");
      expect(await run(ir)).toBe(await run(await build(source, false)));
    });
  }

  for (const [name, { source, detail }] of Object.entries(REFUSED)) {
    it(`refuses at select and answers as legacy does: ${name}`, async () => {
      const ir = await build(source);
      expect(ir.irPostClaimErrors ?? []).toEqual([]);
      const details = legacyUnits(ir).map((row) => `${row.stage}:${row.detail ?? ""}`);
      expect(
        details.some((d) => d.startsWith("select:") && d.includes(detail)),
        details.join("\n"),
      ).toBe(true);
      expect(await run(ir)).toBe(await run(await build(source, false)));
    });
  }
});
