// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7341 S1 — `var o = new Object()` in a script, on the dynamic home, is the
// open `$Object` carrier #7280 admits for `var o = {}`: the same admission
// (`isDynamicHomeOpenCarrier`), the same object (`__new_plain_object`) and the
// same dynamic arms for every use. Any other `new Object(…)` is refused at
// select with its own detail, never claimed and then demoted. The JS
// environment keeps legacy.
import { afterAll, describe, expect, it, vi } from "vitest";

import { compile, type CompileResult } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

// The refusal rows assert the selector's detail, which it records only under
// these diagnostics; both are read when the selector loads, so set them first.
const previousEnv = vi.hoisted(() => {
  const names = ["JS2WASM_IR_SHAPE_DIAG", "JS2WASM_IR_MODULE_INIT_ALL_REJECTS"] as const;
  const previous = names.map((name) => [name, process.env[name]] as const);
  for (const name of names) process.env[name] = "1";
  return previous;
});
afterAll(() => {
  for (const [name, value] of previousEnv) {
    if (value === undefined) Reflect.deleteProperty(process.env, name);
    else process.env[name] = value;
  }
});

type Lane = "standalone" | "gc";
type Verdict = "ok" | "threw" | "trap";

async function build(source: string, lane: Lane, experimentalIR = true): Promise<CompileResult> {
  const result = await compile(source, {
    fileName: "issue-7341.js",
    allowJs: true,
    skipSemanticDiagnostics: true,
    inferModuleStrictArguments: false,
    scriptGoal: true,
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

/** Each script passes exactly when the object behaves as the spec says; every unit is IR. */
const CLAIMED: Record<string, string> = {
  "a member store and reads": `var o = new Object(); o.p = 1; if (o.p !== 1) { throw "p"; } if (o.q !== undefined) { throw "q"; }`,
  "typeof and truthiness": `var o = new Object(); if (typeof o !== "object") { throw "typeof"; } if (!o) { throw "falsy"; } if (o) {} else { throw "else"; }`,
  "without an argument list": `var o = new Object; o.p = 2; if (o.p !== 2) { throw "p"; }`,
  "two constructions are two objects": `var o = new Object(), q = new Object(); if (o === q) { throw "id"; } if (o !== o) { throw "self"; } o.p = 1; if (q.p !== undefined) { throw "shared"; }`,
  "an element store and a named read": `var o = new Object(); o["a b"] = "s"; if (o["a b"] !== "s") { throw "e"; }`,
  "a unary minus of a member": `var o = new Object(); o.prop = -1; if (-o.prop !== 1) { throw "neg"; }`,
  "a member plus one": `var o = new Object(); o.p = 1; if (o.p + 1 !== 2) { throw "plus"; }`,
  "strict comparisons with null and undefined": `var o = new Object(); if (o === null || o === undefined) { throw "nullish"; } o.p = null; if (o.p !== null) { throw "p"; }`,
  "stored into a script var of another kind": `var o = new Object(); var n = 1; n = o; if (typeof n !== "object") { throw "n"; }`,
  "written by a top-level function": `var o = new Object(); function g() { o.p = 5; } g(); if (o.p !== 5) { throw "g"; }`,
  "passed to a function that reads it": `var o = new Object(); function f(a) { return a.k; } o.k = 3; if (f(o) !== 3) { throw "f"; }`,
  "strict script code": `"use strict"; var o = new Object(); o.x = 1; if (o.x !== 1) { throw "x"; }`,
  // #7335's arms recognise the `new Object()` spelling too.
  "a define, then an own read": `var o = new Object(); Object.defineProperty(o, "p", { value: 3 }); if (o.p !== 3) { throw "p"; }`,
  "an own-property test": `var o = new Object(); o.p = 1; if (!o.hasOwnProperty("p") || o.hasOwnProperty("toString")) { throw "own"; }`,
  // Loose equality with a primitive takes ToPrimitive of the object (#7194, on main).
  "== 1": `var o = new Object(); if (o == 1) { throw "n"; }`,
  "== true": `var o = new Object(); if (o == true) { throw "b"; }`,
  '== "[object Object]"': `var o = new Object(); if (o == "[object Object]") {} else { throw "s"; }`,
};

/** A construction the plan declines: the unit is refused at select, with the arm named. */
const REFUSED: Record<string, { readonly source: string; readonly unit: string; readonly detail: string }> = {
  "an argument from a dynamic var": {
    source: `var x = 1; var o = new Object(x); if (typeof o !== "object") { throw "t"; }`,
    unit: "<module-init>",
    detail: "expr-new-object-argument",
  },
  "a spread argument": {
    source: `var o = new Object(...[1]); if (typeof o !== "object") { throw "t"; }`,
    unit: "<module-init>",
    detail: "expr-new-object-argument",
  },
  "an `in` that may reach an inherited key": {
    source: `var o = new Object(); var k = "toString"; if (!(k in o)) { throw "in"; }`,
    unit: "<module-init>",
    detail: "expr-new-object-home",
  },
  "a function-local `let`": {
    source: `function f() { let o = new Object(); o.p = 1; return o.p; } if (f() !== 1) { throw "f"; }`,
    unit: "f",
    detail: "expr-new-object-home",
  },
  "a function-local `var`": {
    source: `function f() { var o = new Object(); o.p = 1; return o.p; } if (f() !== 1) { throw "f"; }`,
    unit: "f",
    detail: "expr-new-object-home",
  },
  "an assignment after the declaration": {
    source: `var o; o = new Object(); o.p = 1; if (o.p !== 1) { throw "p"; }`,
    unit: "<module-init>",
    detail: "expr-new-object-home",
  },
  "an equality operand": {
    source: `if (null === new Object()) { throw "n"; }`,
    unit: "<module-init>",
    detail: "expr-new-object-home",
  },
  "a call argument": {
    source: `function f(a) { return typeof a; } if (f(new Object()) !== "object") { throw "f"; }`,
    unit: "<module-init>",
    detail: "expr-new-object-home",
  },
};

/**
 * The var used as a value in a consumer whose builder arm does not take the
 * carrier: each is refused at select, never claimed and then demoted, and
 * answers as node does, or, where a unit stays legacy, as legacy does.
 */
const VALUE_USES: Record<string, string> = {
  "the var plus a string": `var o = new Object(); var s = o + ""; if (s !== "[object Object]") { throw s; }`,
  "loose equality with null": `var o = new Object(); if (o == null) { throw "n"; }`,
  "loose inequality, null on the left": `var o = new Object(); if (null != o) {} else { throw "n"; }`,
  "a member loosely compared with null": `var o = new Object(); o.p = null; if (o.p != null) { throw "p"; }`,
  "loose equality with null in a function": `var o = new Object(); function g() { return o == null; } if (g()) { throw "g"; }`,
  "a member incremented": `var o = new Object(); o.p = 1; o.p++; if (o.p !== 2) { throw "i"; }`,
  "a member decremented as a value": `var o = new Object(); o.p = 1; var r = --o.p; if (r !== 0) { throw "d"; }`,
  "a member compound-assigned": `var o = new Object(); o.p = 1; o.p += 1; if (o.p !== 2) { throw "c"; }`,
  "an element incremented": `var o = new Object(); o["p"] = 1; o["p"]++; if (o.p !== 2) { throw "e"; }`,
  "a second construction assigned": `var o = new Object(); o.p = 1; o = new Object(); if (o.p !== undefined) { throw "fresh"; }`,
  "the var as a switch discriminant": `var o = new Object(); switch (o) { case 1: throw "x"; default: }`,
  "a member as a switch discriminant": `var o = new Object(); o.k = 2; switch (o.k) { case 2: break; default: throw "k"; }`,
  "a void member strictly compared with undefined": `var o = new Object(); o.p = 1; if (void o.p !== undefined) { throw "v"; }`,
  "a void member loosely compared with undefined": `var o = new Object(); o.p = 1; if (void o.p != undefined) { throw "v"; }`,
  // An object literal assigned to the dynamic home (PR #7214 step-B review B1); `{}` and a bare
  // `var` withdrew after the claim on main too.
  "an object literal assigned to the var": `var o = new Object(); o.p = 1; o = { p: 2 }; if (o.p !== 2) throw "x";`,
  "an object literal assigned, bare `new Object`": `var o = new Object; o.p = 1; o = { p: 2 }; if (o.p !== 2) throw "x";`,
  "an object literal assigned in a function": `var o = new Object(); function g() { o = { p: 2 }; } g(); if (o.p !== 2) throw "x";`,
  "an object literal assigned to a `{}` var": `var o = {}; o = { p: 2 }; if (o.p !== 2) throw "x";`,
  "an object literal assigned to a bare var": `var o; o = { p: 2 }; if (o.p !== 2) throw "x";`,
  // Mixed carrier expressions (PR #7214 review R2-S1): the carrier flows through `+`, a comma, or a `void`.
  "a member plus one as a switch discriminant": `var o = new Object(); o.k = 1; switch (o.k + 1) { case 2: break; default: throw "k"; }`,
  "a comma expression as a switch discriminant": `var o = new Object(); o.k = 2; switch ((0, o.k)) { case 2: break; default: throw "k"; }`,
  "a void member loosely compared with null": `var o = new Object(); o.p = 1; if (void o.p == null) {} else { throw "v"; }`,
  "a void member strictly compared with a member": `var o = new Object(); o.p = 1; if (void o.p === o.q) {} else { throw "v"; }`,
  "a void member compared with void 0": `var o = new Object(); o.p = 1; if (void o.p !== void 0) { throw "v"; }`,
  "a member loosely compared with void 0": `var o = new Object(); if (o.p == void 0) {} else { throw "v"; }`,
};

/**
 * A program-declared or program-written `Object` is not the realm's: the
 * construction keeps main's route (legacy), and the selector never takes it as
 * an empty object.
 */
const USER_OBJECT: Record<string, string> = {
  "a script function declaration": `function Object() { G = 1; } var G = 0; var o = new Object(); if (G !== 1) { throw "builtin"; }`,
  "an assignment to the global": `var G = 0; Object = function () { G = 1; }; var o = new Object(); if (G !== 1) { throw "builtin"; }`,
  "an assignment after the construction": `var o = new Object(); o.p = 1; if (o.p !== 1) { throw "p"; } Object = function () {};`,
};

/**
 * A `void` of a non-carrier operand compared with `undefined` keeps main's route: the
 * function is claimed and withdrawn by from-ast as on main, its callers stay IR, and the
 * JS environment's bytes are main's (PR #7214 review round 2). Only a carrier operand is
 * refused at select.
 */
const NON_CARRIER_VOID: Record<string, { readonly source: string; readonly unit: string }> = {
  "a local in a function": {
    source: `function f() { var a = 1; return void a === undefined; } if (!f()) { throw "x"; }`,
    unit: "f",
  },
  "a parameter": {
    source: `function g(a) { if (void a !== undefined) return 1; return 0; } if (g(3) !== 0) { throw "x"; }`,
    unit: "g",
  },
  "a computed local": {
    source: `function h(a) { var b = a + 1; return void b === undefined ? 1 : 0; } if (h(1) !== 1) { throw "x"; }`,
    unit: "h",
  },
};

describe("#7341 S1 — `new Object()` as the open-object carrier", () => {
  for (const [name, source] of Object.entries(CLAIMED)) {
    it(`claims every unit and runs as JS: ${name}`, async () => {
      expect(node(source)).toBe("ok");
      const ir = await build(source, "standalone");
      expect(ir.irPostClaimErrors ?? []).toEqual([]);
      for (const row of ir.irOutcomes ?? []) {
        if (row.kind !== "non-executable") expect(row.irBodyEmitted, JSON.stringify(row)).toBe(true);
      }
      expect(await run(ir, "standalone")).toBe("ok");
    });
  }

  for (const [name, { source, unit, detail }] of Object.entries(REFUSED)) {
    it(`refuses at select and matches legacy: ${name}`, async () => {
      const ir = await build(source, "standalone");
      expect(ir.irPostClaimErrors ?? []).toEqual([]);
      const row = outcome(ir, unit);
      expect(row).toMatchObject({ stage: "select", irBodyEmitted: false });
      expect(row?.detail).toContain(detail);
      expect(await run(ir, "standalone")).toBe(await run(await build(source, "standalone", false), "standalone"));
    });
  }

  for (const [name, source] of Object.entries(VALUE_USES)) {
    it(`claims whole or refuses at select, and answers as node does: ${name}`, async () => {
      const ir = await build(source, "standalone");
      expect(ir.irPostClaimErrors ?? []).toEqual([]);
      for (const row of ir.irOutcomes ?? []) {
        if (!row.irBodyEmitted && row.kind !== "non-executable") expect(row.stage, JSON.stringify(row)).toBe("select");
      }
      const legacy = await run(await build(source, "standalone", false), "standalone");
      expect([node(source), legacy]).toContain(await run(ir, "standalone"));
    });
  }

  for (const [name, source] of Object.entries(USER_OBJECT)) {
    it(`leaves a program's own Object on legacy: ${name}`, async () => {
      const ir = await build(source, "standalone");
      expect(ir.irPostClaimErrors ?? []).toEqual([]);
      const row = outcome(ir, "<module-init>");
      expect(row).toMatchObject({ stage: "select", irBodyEmitted: false });
      expect(row?.detail ?? "").not.toContain("expr-new-object");
      expect(await run(ir, "standalone")).toBe(await run(await build(source, "standalone", false), "standalone"));
    });
  }

  for (const [name, { source, unit }] of Object.entries(NON_CARRIER_VOID)) {
    it(`keeps main's route for a non-carrier void: ${name}`, async () => {
      expect(node(source)).toBe("ok");
      const ir = await build(source, "standalone");
      expect(outcome(ir, "<module-init>")?.irBodyEmitted).toBe(true);
      expect(outcome(ir, unit)?.detail ?? "").not.toContain("expr-void-carrier-compare");
      expect(await run(ir, "standalone")).toBe("ok");
    });
  }

  it("an IR function shares the object a legacy <module-init> built", async () => {
    const source = `var o = new Object(); function g() { o.p = 5; } with ({}) { g(); } if (o.p !== 5) { throw "g"; }`;
    const ir = await build(source, "standalone");
    expect(ir.irPostClaimErrors ?? []).toEqual([]);
    expect(outcome(ir, "<module-init>")?.irBodyEmitted).toBe(false);
    expect(outcome(ir, "g")?.irBodyEmitted).toBe(true);
    expect(await run(ir, "standalone")).toBe("ok");
  });

  it("keeps the JS environment on legacy", async () => {
    const source = CLAIMED["a member store and reads"]!;
    const gc = await build(source, "gc");
    expect(gc.irPostClaimErrors ?? []).toEqual([]);
    expect(outcome(gc, "<module-init>")?.irBodyEmitted).toBe(false);
    expect(await run(gc, "gc")).toBe("ok");
  });
});
