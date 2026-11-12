// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7335 (lever D) on top of #7280 S1: a script `var o = {}` on the dynamic
// module slot that legacy keeps as an open `$Object` is #7280's carrier, whose
// initializer #7280 admits. When the binding is declared once, never written,
// and every reference is a consumer the dynamic operations serve, D adds two
// arms on standalone: a literal-data `Object.defineProperty` on it from any
// unit, and `hasOwnProperty` / `propertyIsEnumerable` through
// `dyn.own_property`. Any other use leaves the binding a plain #7280 carrier,
// so those arms are refused at select, never claimed and then demoted. gc keeps
// declining.
import { afterAll, describe, expect, it, vi } from "vitest";

import { compile, type CompileResult } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

// The refusal rows assert the selector's detail, which it records only under the
// shape diagnostic; the flag is read when the selector loads, so set it first.
const previousShapeDiag = vi.hoisted(() => {
  const previous = process.env.JS2WASM_IR_SHAPE_DIAG;
  process.env.JS2WASM_IR_SHAPE_DIAG = "1";
  return previous;
});
afterAll(() => {
  if (previousShapeDiag === undefined) Reflect.deleteProperty(process.env, "JS2WASM_IR_SHAPE_DIAG");
  else process.env.JS2WASM_IR_SHAPE_DIAG = previousShapeDiag;
});

type Lane = "standalone" | "gc";
type Verdict = "ok" | "threw" | "trap";

async function build(source: string, lane: Lane, experimentalIR = true, scriptGoal = true): Promise<CompileResult> {
  const result = await compile(source, {
    fileName: "issue-7335.js",
    allowJs: true,
    skipSemanticDiagnostics: true,
    inferModuleStrictArguments: false,
    scriptGoal,
    deferTopLevelInit: true,
    trackIrOutcomes: true,
    experimentalIR,
    ...(lane === "standalone" ? { target: "standalone" } : {}),
  } as Parameters<typeof compile>[1]);
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  return result;
}

/** A thrown JS value is the script's own verdict; a trap means the module itself is broken. */
async function run(result: CompileResult, lane: Lane): Promise<Verdict> {
  try {
    const imports = lane === "standalone" ? {} : buildImports(result.imports, {}, result.stringPool);
    const { instance } = await WebAssembly.instantiate(result.binary, imports as WebAssembly.Imports);
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

function outcome(result: CompileResult, name: string) {
  return (result.irOutcomes ?? []).find((row) => row.displayName === name);
}

const DEFINE = "Object.defineProperty(o, 'p', { value: 1 });";
const STRICT_THROW = (body: string) =>
  `try { ${body} throw "no"; } catch (e) { if (!(e instanceof TypeError)) { throw "type"; } }`;

const CLAIMED: Record<string, string> = {
  "define, then an own read": `var o = {}; ${DEFINE} if (o.p !== 1) { throw "p"; }`,
  "parenthesized own read": `var o = {}; ${DEFINE} if ((o).p !== 1) { throw "p"; }`,
  "non-writable write is ignored": `var o = {}; ${DEFINE} o.p = 2; if (o.p !== 1) { throw "p"; }`,
  "non-configurable redefine throws TypeError": `var o = {}; ${DEFINE} ${STRICT_THROW("Object.defineProperty(o, 'p', { value: 2 });")}`,
  hasOwnProperty: `var o = {}; ${DEFINE} if (!o.hasOwnProperty('p') || o.hasOwnProperty('toString')) { throw "own"; }`,
  propertyIsEnumerable: `var o = {}; ${DEFINE} Object.defineProperty(o, 'e', { value: 1, enumerable: true }); if (o.propertyIsEnumerable('p') || !o.propertyIsEnumerable('e')) { throw "enum"; }`,
  "numeric key, canonicalised": `var o = {}; Object.defineProperty(o, 1000000000000000000000, {}); if (!o.hasOwnProperty("1e+21")) { throw "key"; }`,
  "own-property result stored": `var o = {}; ${DEFINE} var b = o.hasOwnProperty('p'); if (b !== true) { throw "b"; }`,
  typeof: `var o = {}; if (typeof o !== 'object') { throw "typeof"; }`,
  "read before the declaration runs": `if (o !== undefined) { throw "hoist"; } var o = {};`,
};

/**
 * A use the dynamic-home proof does not serve: the binding stays #7280's plain
 * carrier, so the own-property probe each source ends with is not admitted and
 * `<module-init>` is refused at select, with the arm named.
 */
const REFUSED: Record<string, { readonly source: string; readonly detail: string }> = {
  "inherited method read": {
    source: `var o = {}; if (o.hasOwnProperty !== Object.prototype.hasOwnProperty) { throw "inherited"; }`,
    // (#7338) The home's member read is the carrier, judged against a method value first.
    detail: "operand-coercion-unsupported",
  },
  "parenthesized inherited read": {
    source: `var o = {}; if ((o).toString === undefined) { throw "inherited"; }`,
    detail: "expr-module-scalar-method",
  },
  "parenthesized loose equality": {
    source: `var o = {}; if ((o) == null) { throw "null"; }`,
    // (#7338) The carrier is judged first: from-ast folds only a strict `null` compare.
    detail: "operand-coercion-unsupported",
  },
  alias: {
    source: `var o = {}; var p = o; if (p.toString === undefined) { throw "alias"; }`,
    detail: "expr-module-scalar-method",
  },
  reassigned: { source: `var o = {}; o = 5; if (o !== 5) { throw "w"; }`, detail: "vardecl-module-value-flow" },
  "array destructuring write": {
    source: `var o = {}; [o] = [5]; if (o !== 5) { throw "w"; }`,
    detail: "body-exprstmt-other",
  },
  "object destructuring write": {
    source: `var o = {}; ({ a: o } = { a: 5 }); if (o !== 5) { throw "w"; }`,
    detail: "body-exprstmt-other",
  },
  "parenthesized write": { source: `var o = {}; (o) = 5; if (o !== 5) { throw "w"; }`, detail: "body-exprstmt-other" },
  "for-of destructuring head": {
    source: `var o = {}; var xs = [[5]]; for ([o] of xs) { } if (o !== 5) { throw "w"; }`,
    detail: "vardecl-module-storage-unrepresentable",
  },
  "this.o write": {
    source: `var o = {}; this.o = { p: 1 }; if (o.p !== 1) { throw "w"; }`,
    detail: "vardecl-module-storage-unrepresentable",
  },
  "eval in the file": {
    source: `var o = {}; eval(""); if (o.p !== undefined) { throw "eval"; }`,
    detail: "call-resolution-unsupported",
  },
  "Object.setPrototypeOf on the binding": {
    source: `var o = {}; Object.setPrototypeOf(o, { p: 1 }); if (o.p !== 1) { throw "proto"; }`,
    detail: "expr-ident-not-in-scope",
  },
  "element read": {
    source: `var o = {}; ${DEFINE} var k = 'p'; if (o[k] !== 1) { throw "elem"; }`,
    detail: "expr-module-extern-consumer",
  },
  "ToPropertyKey-running key": {
    source: `var o = {}; ${DEFINE} if (!o.hasOwnProperty({ toString: function () { return 'p'; } })) { throw "key"; }`,
    detail: "objectlit-ordinary-to-primitive-method",
  },
  "shadowing parameter": {
    source: `var o = {}; ${DEFINE} function f(o) { return o.p; } if (f({ p: 2 }) !== 2) { throw "shadow"; }`,
    detail: "expr-module-scalar-method",
  },
  "element destructuring target": {
    source: `"use strict"; var o = {}; Object.defineProperty(o, 'b', { value: 1 }); ${STRICT_THROW("[o.b] = [11];")}`,
    detail: "body-exprstmt-other",
  },
  "member write in a nested closure": {
    source: `"use strict"; var o = {}; Object.defineProperty(o, 'b', { writable: false }); var threw = false; (function () { try { o.b = 11; } catch (e) { threw = e instanceof TypeError; } })(); if (!threw) { throw "strict"; }`,
    detail: "expr-call-callee-nonident",
  },
  "replaced hasOwnProperty": {
    source: `var o = {}; Object.prototype.hasOwnProperty = function () { return true; }; if (!o.hasOwnProperty('zz')) { throw "override"; }`,
    detail: "expr-ident-not-in-scope",
  },
  // Round-2 review: a call argument lets other code install an own method under a computed key.
  "own hasOwnProperty under a computed key": {
    source: `var o = {}; Object.defineProperty(o, "has" + "OwnProperty", { value: function () { return true; } }); function f() { return o.hasOwnProperty("z"); } if (!f()) { throw "x"; }`,
    detail: "closure-return-type",
  },
  "Object.assign from parsed JSON": {
    source: `var o = {}; Object.assign(o, JSON.parse('{"hasOwnProperty": 1}')); if (typeof o.hasOwnProperty !== "number") { throw "x"; }`,
    detail: "expr-ident-not-in-scope",
  },
  "passed to a function that writes a computed key": {
    source: `var o = {}; function g(x, k) { x[k] = function () { return true; }; } g(o, "has" + "OwnProperty"); if (!o.hasOwnProperty("z")) { throw "x"; }`,
    detail: "expr-module-scalar-method",
  },
  // Round-3 review: a method call hands `o` to arbitrary code as `this`.
  "method call on the binding": {
    source: `var o = {}; Object.defineProperty(o, "p", { value: 1 }); o.m = function () { this["has" + "OwnProperty"] = function () { return true; }; }; o.m(); function f() { return o.hasOwnProperty("z"); } if (!f()) { throw "x"; }`,
    detail: "closure-return-type",
  },
};

describe("#7335 — standalone dynamic-home open object", () => {
  for (const [name, source] of Object.entries(CLAIMED)) {
    it(`claims <module-init> and matches node and legacy: ${name}`, async () => {
      const ir = await build(source, "standalone");
      expect(ir.irPostClaimErrors ?? []).toEqual([]);
      expect(outcome(ir, "<module-init>")?.irBodyEmitted, JSON.stringify(ir.irOutcomes, null, 2)).toBe(true);
      const expected = node(source);
      expect(await run(await build(source, "standalone", false), "standalone")).toBe(expected);
      expect(await run(ir, "standalone")).toBe(expected);
    });
  }

  it("claims a define from a top-level function, and that function too", async () => {
    const source = `var o = {}; function f() { Object.defineProperty(o, 'q', { value: 2 }); } f(); if (o.q !== 2) { throw "q"; }`;
    const ir = await build(source, "standalone");
    expect(ir.irPostClaimErrors ?? []).toEqual([]);
    expect(outcome(ir, "<module-init>")?.irBodyEmitted).toBe(true);
    expect(outcome(ir, "f")?.irBodyEmitted).toBe(true);
    expect(await run(ir, "standalone")).toBe(node(source));
  });

  it("a define before the declaration runs throws the spec's TypeError (legacy misses it)", async () => {
    // (#7338) The statics table tests the carrier, so the IR throws as node does from
    // `Object.defineProperty(undefined, …)`; legacy applies the define to the undefined slot.
    const source = `function f() { Object.defineProperty(o, 'q', { value: 2 }); } ${STRICT_THROW("f();")} var o = {};`;
    const ir = await build(source, "standalone");
    expect(ir.irPostClaimErrors ?? []).toEqual([]);
    expect(await run(await build(source, "standalone", false), "standalone")).toBe("threw");
    expect(await run(ir, "standalone")).toBe(node(source));
  });

  for (const [name, { source, detail }] of Object.entries(REFUSED)) {
    it(`refuses at select and matches legacy: ${name}`, async () => {
      const probed = `${source} var probe = o.hasOwnProperty("zz");`;
      const ir = await build(probed, "standalone");
      expect(ir.irPostClaimErrors ?? []).toEqual([]);
      const row = outcome(ir, "<module-init>");
      expect(row).toMatchObject({ kind: "unsupported", stage: "select", irBodyEmitted: false });
      expect(row?.detail).toContain(detail);
      const legacy = await build(probed, "standalone", false);
      expect(await run(ir, "standalone")).toBe(await run(legacy, "standalone"));
    });
  }

  it("refuses an accessor descriptor at select", async () => {
    const source = `var o = {}; Object.defineProperty(o, 'p', { get: function () { return 1; } }); if (o.p !== 1) { throw "acc"; }`;
    const ir = await build(source, "standalone");
    expect(ir.irPostClaimErrors ?? []).toEqual([]);
    expect(outcome(ir, "<module-init>")).toMatchObject({ kind: "unsupported", stage: "select", irBodyEmitted: false });
    expect(await run(ir, "standalone")).toBe(node(source));
  });

  it("keeps a module source on legacy", async () => {
    const source = `var o = {}; ${DEFINE} var c = o.p === 1; export function f() { return c ? 1 : 0; }`;
    const ir = await build(source, "standalone", true, false);
    expect(outcome(ir, "<module-init>")?.irBodyEmitted).not.toBe(true);
  });

  for (const source of [CLAIMED["define, then an own read"]!, CLAIMED.hasOwnProperty!]) {
    it(`the gc lane declines <module-init> and matches node: ${source.slice(0, 40)}`, async () => {
      const ir = await build(source, "gc");
      expect(ir.irPostClaimErrors ?? []).toEqual([]);
      expect(outcome(ir, "<module-init>")?.irBodyEmitted).not.toBe(true);
      expect(await run(ir, "gc")).toBe(node(source));
    });
  }
});
