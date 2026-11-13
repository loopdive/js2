// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7339 — `R.hasOwnProperty(k)` / `R.propertyIsEnumerable(k)` as two rows of the
// #7338 `Object` statics table: the receiver is the first value, the answer a
// boolean through `dyn.own_property`, and the row stands only where no object
// in the program can carry an own method of that name (`ownPropertyTestIsPristine`).
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

const DEFINE = "var o = {}; Object.defineProperty(o, 'p', { value: 1 });";

/** Each runs as node does with no legacy unit. */
const CLAIMED: Record<string, string> = {
  "own key, after a getOwnPropertyDescriptor on the receiver": `${DEFINE} var d = Object.getOwnPropertyDescriptor(o, 'p'); if (!o.hasOwnProperty('p') || d.value !== 1) { throw "x"; }`,
  "a descriptor result's own fields": `${DEFINE} var d = Object.getOwnPropertyDescriptor(o, 'p'); if (!d.hasOwnProperty('value') || d.hasOwnProperty('get')) { throw "x"; }`,
  "an Object.create result": `var n = Object.create({}, { p: { value: 1 } }); if (!n.hasOwnProperty('p')) { throw "x"; }`,
  "propertyIsEnumerable, non-enumerable": `${DEFINE} if (o.propertyIsEnumerable('p')) { throw "x"; }`,
  "propertyIsEnumerable, enumerable": `var o = {}; Object.defineProperty(o, 'p', { value: 1, enumerable: true }); if (!o.propertyIsEnumerable('p')) { throw "x"; }`,
  "propertyIsEnumerable on a descriptor result": `${DEFINE} var d = Object.getOwnPropertyDescriptor(o, 'p'); if (!d.propertyIsEnumerable('value')) { throw "x"; }`,
  "an inherited key": `var o = {}; if (o.hasOwnProperty('toString')) { throw "x"; }`,
  "a number key": `var o = {}; Object.defineProperty(o, '0', { value: 1 }); if (!o.hasOwnProperty(0)) { throw "x"; }`,
  "inside a function": `${DEFINE} function f() { return o.hasOwnProperty('p'); } if (!f()) { throw "x"; }`,
  "a nullish receiver throws before the key runs": `var u; var ran = false; function k() { ran = true; return 'p'; } try { u.hasOwnProperty(k()); throw "no"; } catch (e) { if (!(e instanceof TypeError) || ran) { throw "x"; } }`,
};

/** Each keeps the unit legacy with the stated code, and answers as legacy does. */
/** The test, in its own unit `t` so its refusal is the first that unit records. */
const T = "function t() { return o.hasOwnProperty('p'); } var r = t();";

/** Each keeps a unit legacy, refused at select with the stated code, and answers as legacy does. */
const REFUSED: Record<string, { readonly source: string; readonly detail: string }> = {
  "the method stored on the object": {
    source: `${DEFINE} o.hasOwnProperty = function () { return true; }; ${T}`,
    detail: "expr-object-static-untrusted",
  },
  "a store under a key the source does not spell": {
    source: `${DEFINE} var k = 'has' + 'OwnProperty'; var q = {}; q[k] = 1; ${T}`,
    detail: "expr-object-static-untrusted",
  },
  "the name as a string": {
    source: `${DEFINE} var name = 'hasOwnProperty'; var n = name.length; ${T}`,
    detail: "expr-object-static-untrusted",
  },
  "an Object.create(null) somewhere": {
    source: `${DEFINE} var n = Object.create(null); ${T}`,
    detail: "expr-object-static-untrusted",
  },
  "JSON.parse somewhere": {
    source: `${DEFINE} var j = JSON.parse('{}'); ${T}`,
    detail: "expr-object-static-untrusted",
  },
  "an array receiver": {
    source: "function t() { var a = [1]; return a.hasOwnProperty(0); } var r = t();",
    detail: "expr-object-static-operand",
  },
  "two arguments": {
    source: `${DEFINE} function t() { return o.hasOwnProperty('p', 1); } var r = t();`,
    detail: "expr-object-static-arity",
  },
  // A read of an inherited member on the receiver: the dynamic read does not answer the realm's (#7304).
  "an inherited member read beside the test": {
    source: `${DEFINE} function t() { return o.hasOwnProperty('p') && o.toString !== undefined; } var r = t();`,
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
