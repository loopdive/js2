// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7338 — `Object.<static>(…)` through the dynamic carrier, one table
// (`src/ir/object-statics.ts`). On standalone the selector and from-ast read
// one plan: an admitted call crosses every value it evaluates as a carrier and
// calls the object runtime's own helper; a call the plan declines is refused at
// select with its own detail, never claimed and then demoted. The JS
// environment keeps its own arms.
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

async function build(source: string, lane: Lane, experimentalIR = true): Promise<CompileResult> {
  const result = await compile(source, {
    fileName: "issue-7338.js",
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

/** `body` must throw a TypeError. */
const THROWS = (body: string) =>
  `try { ${body} throw "no"; } catch (e) { if (!(e instanceof TypeError)) { throw "type"; } }`;

/** Each script passes (returns normally) exactly when the static behaves as the spec says. */
const CLAIMED: Record<string, string> = {
  // S1 — getOwnPropertyDescriptor and defineProperty with a literal data descriptor.
  "descriptor of a defined property": `var o = {}; Object.defineProperty(o, "p", { value: 1001 }); var d = Object.getOwnPropertyDescriptor(o, "p"); if (o.p !== 1001 || d.value !== 1001 || d.writable !== false || d.enumerable !== false || d.configurable !== false) { throw "desc"; }`,
  "descriptor of a missing property": `var o = {}; var d = Object.getOwnPropertyDescriptor(o, "foo"); if (d !== undefined) { throw "missing"; }`,
  "undefined and null keys": `var o = {}; if (Object.getOwnPropertyDescriptor(o, undefined) !== undefined || Object.getOwnPropertyDescriptor(o, null) !== undefined) { throw "key"; }`,
  "the define answers its target": `var o = {}; var r = Object.defineProperty(o, "p", { value: 3 }); if (r !== o || r.p !== 3) { throw "result"; }`,
  "an empty descriptor defines undefined": `var o = {}; Object.defineProperty(o, "p", {}); var d = Object.getOwnPropertyDescriptor(o, "p"); if (d === undefined || d.value !== undefined) { throw "empty"; }`,
  "non-literal field values": `var o = {}; var v = 7; Object.defineProperty(o, "a", { value: NaN }); Object.defineProperty(o, "b", { value: -Infinity, writable: true }); Object.defineProperty(o, "c", { value: v }); Object.defineProperty(o, "d", { value: undefined }); if (o.a === o.a || o.b !== -Infinity || o.c !== 7 || o.d !== undefined) { throw "values"; }`,
  "truthy flags are coerced": `var o = {}; Object.defineProperty(o, "p", { value: 1, writable: "abc" }); o.p = 2; if (o.p !== 2) { throw "writable"; }`,
  "a non-literal key": `var o = {}; var k = "pq"; Object.defineProperty(o, k, { value: 5 }); if (o.pq !== 5) { throw "key"; }`,
  "a non-configurable redefine throws": `var o = {}; Object.defineProperty(o, "p", { value: 1 }); ${THROWS('Object.defineProperty(o, "p", { value: 2 });')}`,
  "a primitive target throws": `${THROWS('Object.defineProperty(true, "foo", {});')} ${THROWS('Object.defineProperty(undefined, "foo", {});')} ${THROWS('Object.defineProperty(5, "foo", {});')}`,
  "a primitive target throws inside a function": `function f() { Object.defineProperty("s", "foo", {}); } ${THROWS("f();")}`,
  "a parameter target": `function f(t) { Object.defineProperty(t, "q", { value: 5 }); return Object.getOwnPropertyDescriptor(t, "q"); } var o = {}; var d = f(o); if (o.q !== 5 || d.value !== 5) { throw "param"; }`,
  "descriptor of a nullish target throws": `${THROWS('Object.getOwnPropertyDescriptor(undefined, "foo");')} ${THROWS('Object.getOwnPropertyDescriptor(null, "foo");')}`,
  "descriptor of a primitive target": `if (Object.getOwnPropertyDescriptor(true, "foo") !== undefined) { throw "primitive"; }`,
  "names of a nullish target throw": `function f() { Object.getOwnPropertyNames(null); } ${THROWS("f();")} ${THROWS("Object.getOwnPropertyNames(undefined);")}`,
  // S2 — defineProperties and create with literal data maps.
  "a literal descriptor map": `var o = {}; Object.defineProperties(o, { a: { value: 1, enumerable: true }, "b c": { value: "x" } }); if (o.a !== 1 || Object.getOwnPropertyDescriptor(o, "b c").value !== "x") { throw "map"; }`,
  "constant map values": `var o = {}; Object.defineProperties(o, { a: { value: -123, writable: true }, b: { value: undefined }, c: { value: null, enumerable: true } }); if (o.a !== -123 || o.b !== undefined || o.c !== null) { throw "constants"; }`,
  "a map define that is rejected throws": `var o = {}; Object.defineProperty(o, "p", { value: 11 }); ${THROWS("Object.defineProperties(o, { p: { value: 12, configurable: true } });")}`,
  "defineProperties on a primitive throws": `${THROWS("Object.defineProperties(undefined, {});")} ${THROWS("Object.defineProperties(true, {});")}`,
  "create with a literal map": `var o = Object.create({}, { a: { value: 7 }, b: { value: "s", enumerable: true } }); if (o.a !== 7 || o.b !== "s" || typeof o !== "object") { throw "create"; }`,
  "create from an empty prototype": `var o = Object.create({}); Object.defineProperty(o, "p", { value: 1 }); if (o.p !== 1) { throw "create"; }`,
  "create from a primitive throws": `${THROWS("Object.create(true);")} ${THROWS("Object.create(undefined);")}`,
  "create on a fresh prototype answers an Object": `var o = Object.create({}, { a: { value: 1 } }); if (typeof o !== "object" || o.a !== 1) { throw "fresh"; }`,
  // The only object-runtime call in the module: the table registers its own helper.
  "create is the module's one runtime call": `try { Object.create(undefined); } catch (e) {}`,
};

/** A call of a table static the plan declines: `<module-init>` is refused at select, with the arm named. */
const REFUSED: Record<string, { readonly source: string; readonly detail: string }> = {
  "accessor descriptor": {
    source: `var o = {}; Object.defineProperty(o, "p", { get: function () { return 1; } }); if (o.p !== 1) { throw "acc"; }`,
    detail: "expr-object-static-descriptor",
  },
  "descriptor that is not a literal": {
    source: `var o = {}; var d = Object.getOwnPropertyDescriptor(o, "q"); ${THROWS('Object.defineProperty(o, "p", d);')}`,
    detail: "expr-object-static-descriptor",
  },
  "map with an array-index key": {
    source: `var o = {}; Object.defineProperties(o, { b: { value: 1 }, 0: { value: 2 } }); if (o[0] !== 2) { throw "index"; }`,
    detail: "expr-object-static-descriptor",
  },
  "map with an accessor": {
    source: `var o = Object.create({}, { p: { get: function () { return 1; } } }); if (o.p !== 1) { throw "acc"; }`,
    detail: "expr-object-static-descriptor",
  },
  "missing arguments": {
    source: `var o = {}; var d = Object.getOwnPropertyDescriptor(o); if (d !== undefined) { throw "arity"; }`,
    detail: "expr-object-static-arity",
  },
  "create from a dynamic prototype": {
    source: `var p = {}; var o = Object.create(p); if (typeof o !== "object") { throw "proto"; }`,
    detail: "expr-object-static-proto",
  },
  "create from null": {
    source: `var o = Object.create(null); if (typeof o !== "object") { throw "null"; }`,
    detail: "expr-object-static-proto",
  },
  "an inherited-key `in` beside a fresh object": {
    source: `var o = Object.create({}, { a: { value: 1 } }); if (!("toString" in o)) { throw "in"; }`,
    detail: "expr-object-static-in-key",
  },
  // Trust boundary: the call must provably reach the realm's own static.
  "patched Object.defineProperty": {
    source: `var o = {}; Object.defineProperty(o, "p", { value: 3 }); Object.defineProperty = function (t) { t.patched = true; return t; }; Object.defineProperty(o, "q", { value: 4 }); if (o.p !== 3 || o.patched !== true || o.q !== undefined) { throw "patched"; }`,
    detail: "expr-object-static-untrusted",
  },
  "Object taken as a value": {
    source: `var O = Object; var o = {}; Object.defineProperty(o, "p", { value: 3 }); if (o.p !== 3) { throw "alias"; }`,
    detail: "expr-object-static-untrusted",
  },
  "a reflective route": {
    source: `var o = {}; var c = o.constructor; Object.defineProperty(o, "p", { value: 3 }); if (o.p !== 3 || c === undefined) { throw "route"; }`,
    detail: "expr-object-static-untrusted",
  },
  "dynamic code": {
    source: `var o = {}; Object.defineProperty(o, "p", { value: 3 }); Function("return 1;")(); if (o.p !== 3) { throw "dynamic"; }`,
    detail: "expr-object-static-untrusted",
  },
};

/**
 * A static's result used as a value, or a value beside one (#7212 review B1): each is either
 * lowered whole or refused at select, never claimed and then demoted; it answers as node does,
 * or, where a unit stays legacy, as legacy does.
 */
const VALUE_USES: Record<string, string> = {
  "descriptor field plus one, script var": `var o = {}; Object.defineProperty(o, 'p', { value: 1 }); var r = Object.getOwnPropertyDescriptor(o, 'p').value + 1; if (r !== 2) { throw "x"; }`,
  "descriptor field plus one, returned": `function f(o) { return Object.getOwnPropertyDescriptor(o, 'p').value + 1; } var o = {}; Object.defineProperty(o, 'p', { value: 1 }); if (f(o) !== 2) { throw "x"; }`,
  "created field plus one": `function f() { return Object.create({}, { a: { value: 1 } }).a + 1; } if (f() !== 2) { throw "x"; }`,
  "defined target's field plus one": `function f(o) { return Object.defineProperty(o, 'p', { value: 1 }).p + 1; } if (f({}) !== 2) { throw "x"; }`,
  "descriptor compared loosely with null": `var o = {}; if (Object.getOwnPropertyDescriptor(o, 'p') != null) { throw "x"; }`,
  "stored descriptor compared loosely with null": `var o = {}; var d = Object.getOwnPropertyDescriptor(o, 'p'); if (d != null) { throw "x"; }`,
  "created object compared loosely with null": `function f() { return Object.create({}) == null; } if (f()) { throw "x"; }`,
  "defined target's field into a script var": `var o = {}; var r = Object.defineProperty(o, 'p', { value: 1 }).p; if (r !== 1) { throw "x"; }`,
  "reassigned parameter as the target": `function f(n) { n = n + 1; Object.defineProperty(n, 'x', { value: 1 }); } try { f(1); throw "no"; } catch (e) { if (!(e instanceof TypeError)) { throw "type"; } }`,
  "descriptor field plus one, compared": `var o = {}; Object.defineProperty(o, 'p', { value: 1 }); if (Object.getOwnPropertyDescriptor(o, 'p').value + 1 !== 2) { throw "x"; }`,
  // A carrier's member under `++` / `--` (#7212 review R1): no read-modify-write lowers on the carrier.
  "postfix ++ on a descriptor field": `function f(o) { var d = Object.getOwnPropertyDescriptor(o, 'p'); d.value++; return d.value; } var o = {}; Object.defineProperty(o, 'p', { value: 1 }); if (f(o) !== 2) { throw "x"; }`,
  "prefix ++ on a created field": `function f() { var o = Object.create({}, { a: { value: 1, writable: true } }); ++o.a; return o.a; } if (f() !== 2) { throw "x"; }`,
  "postfix -- on a created field": `function f() { var o = Object.create({}, { a: { value: 1, writable: true } }); o.a--; return o.a; } if (f() !== 0) { throw "x"; }`,
  "prefix -- on a descriptor field": `function f(o) { var d = Object.getOwnPropertyDescriptor(o, 'p'); --d.value; return d.value; } var o = {}; Object.defineProperty(o, 'p', { value: 1 }); if (f(o) !== 0) { throw "x"; }`,
  // A carrier into a numeric compound, and a carrier against `void` (#7212 review round 3).
  "numeric var -= a descriptor field": `var o = {}; Object.defineProperty(o, 'p', { value: 4 }); var y = 10; y -= Object.getOwnPropertyDescriptor(o, 'p').value; if (y !== 6) { throw "x"; }`,
  "numeric var *= a descriptor field": `var o = {}; Object.defineProperty(o, 'p', { value: 4 }); var y = 10; y *= Object.getOwnPropertyDescriptor(o, 'p').value; if (y !== 40) { throw "x"; }`,
  "numeric var <<= a descriptor field": `var o = {}; Object.defineProperty(o, 'p', { value: 4 }); var y = 1; y <<= Object.getOwnPropertyDescriptor(o, 'p').value; if (y !== 16) { throw "x"; }`,
  "numeric var += a descriptor field": `var o = {}; Object.defineProperty(o, 'p', { value: 4 }); var y = 10; y += Object.getOwnPropertyDescriptor(o, 'p').value; if (y !== 14) { throw "x"; }`,
  "descriptor field != void 0": `var o = {}; Object.defineProperty(o, 'a', { value: null }); if (Object.getOwnPropertyDescriptor(o, 'a').value != void 0) { throw "x"; }`,
  "void 0 == descriptor field": `var o = {}; Object.defineProperty(o, 'a', { value: 1 }); if (void 0 == Object.getOwnPropertyDescriptor(o, 'a').value) { throw "x"; }`,
  "descriptor field == void f()": `function f() { return 1; } var o = {}; Object.defineProperty(o, 'a', { value: 1 }); if (Object.getOwnPropertyDescriptor(o, 'a').value == void f()) { throw "x"; }`,
  "void f() != descriptor field": `function f() { return 1; } var o = {}; Object.defineProperty(o, 'a', { value: null }); if (void f() != Object.getOwnPropertyDescriptor(o, 'a').value) { throw "x"; }`,
  "descriptor field assigned to a numeric script var": `var o = {}; Object.defineProperty(o, 'p', { value: 1 }); var r = 0; r = Object.getOwnPropertyDescriptor(o, 'p').value; if (r !== 1) { throw "x"; }`,
  // Every way a carrier flows (`producesCarrier`), wrapping a table result (#7212 review round 4).
  "kind: parentheses": `var o = {}; Object.defineProperty(o, 'p', { value: 4 }); var y = 10; y -= ((Object.getOwnPropertyDescriptor(o, 'p').value)); if (y !== 6) { throw "x"; }`,
  "kind: member read": `var o = {}; Object.defineProperty(o, 'p', { value: 4 }); var y = 10; y -= Object.getOwnPropertyDescriptor(o, 'p').value; if (y !== 6) { throw "x"; }`,
  "kind: element read": `var o = {}; Object.defineProperty(o, 'p', { value: 4 }); var y = 10; y -= Object.getOwnPropertyDescriptor(o, 'p')['value']; if (y !== 6) { throw "x"; }`,
  "kind: method call on it": `var o = {}; Object.defineProperty(o, 'p', { value: 4 }); var y = 10; y -= Object.getOwnPropertyDescriptor(o, 'p').value.valueOf(); if (y !== 6) { throw "x"; }`,
  "kind: comma right side": `var o = {}; Object.defineProperty(o, 'p', { value: 4 }); var y = 10; y -= (0, Object.getOwnPropertyDescriptor(o, 'p').value); if (y !== 6) { throw "x"; }`,
  "kind: assignment right side": `var o = {}; Object.defineProperty(o, 'p', { value: 4 }); var y = 10; var t; y -= (t = Object.getOwnPropertyDescriptor(o, 'p').value); if (y !== 6) { throw "x"; }`,
  "kind: conditional arms": `var o = {}; Object.defineProperty(o, 'p', { value: 4 }); var y = 10; y -= (o ? Object.getOwnPropertyDescriptor(o, 'p').value : Object.getOwnPropertyDescriptor(o, 'p').value); if (y !== 6) { throw "x"; }`,
  "kind: addition": `var o = {}; Object.defineProperty(o, 'p', { value: 4 }); var y = 10; y -= Object.getOwnPropertyDescriptor(o, 'p').value + 0; if (y !== 6) { throw "x"; }`,
  "kind: local initialised from it": `function f(o) { var y = 10; var d = Object.getOwnPropertyDescriptor(o, 'p'); y -= d.value; return y; } var o = {}; Object.defineProperty(o, 'p', { value: 4 }); if (f(o) !== 6) { throw "x"; }`,
  "kind: script var initialised from it": `var o = {}; Object.defineProperty(o, 'p', { value: 4 }); var y = 10; var d = Object.getOwnPropertyDescriptor(o, 'p'); y -= d.value; if (y !== 6) { throw "x"; }`,
  "comma operand compared loosely with null": `var o = {}; if ((0, Object.getOwnPropertyDescriptor(o, 'p')) == null) {} else { throw "x"; }`,
  "update of a local initialised from a field": `function f(o) { var v = Object.getOwnPropertyDescriptor(o, 'p').value; v++; return v; } var o = {}; Object.defineProperty(o, 'p', { value: 4 }); if (f(o) !== 5) { throw "x"; }`,
};

describe("#7338 — Object statics through the dynamic carrier", () => {
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

  it("evaluates a map's values before its first define, as the spec does (legacy gc does not)", async () => {
    const source = `var o = {}; Object.defineProperty(o, "a", { value: 1, configurable: true }); Object.defineProperties(o, { a: { value: 2 }, b: { value: o.a } }); if (o.a !== 2 || o.b !== 1) { throw "order"; }`;
    expect(node(source)).toBe("ok");
    const ir = await build(source, "standalone");
    expect(ir.irPostClaimErrors ?? []).toEqual([]);
    expect(outcome(ir, "<module-init>")?.irBodyEmitted).toBe(true);
    expect(await run(ir, "standalone")).toBe("ok");
  });

  // A map value that throws: every argument is evaluated before the first define, so nothing is defined.
  for (const [name, source] of Object.entries({
    "defineProperties defines nothing": `var u; var o = {}; try { Object.defineProperties(o, { a: { value: 1 }, b: { value: u.x } }); } catch (e) {} if (Object.getOwnPropertyDescriptor(o, 'a') !== undefined) { throw "x"; }`,
    "create throws the value's TypeError": `var u; var ok = false; try { Object.create({}, { a: { value: u.x } }); } catch (e) { ok = e instanceof TypeError; } if (!ok) { throw "x"; }`,
  })) {
    it(`claims <module-init> and evaluates a throwing map value first: ${name}`, async () => {
      expect(node(source)).toBe("ok");
      const ir = await build(source, "standalone");
      expect(ir.irPostClaimErrors ?? []).toEqual([]);
      expect(outcome(ir, "<module-init>")?.irBodyEmitted).toBe(true);
      expect(await run(ir, "standalone")).toBe("ok");
    });
  }

  for (const [name, source] of Object.entries(CLAIMED)) {
    it(`claims <module-init> and runs as JS on both lanes: ${name}`, async () => {
      expect(node(source)).toBe("ok");
      const ir = await build(source, "standalone");
      expect(ir.irPostClaimErrors ?? []).toEqual([]);
      expect(outcome(ir, "<module-init>")?.irBodyEmitted, JSON.stringify(ir.irOutcomes, null, 2)).toBe(true);
      expect(await run(ir, "standalone")).toBe("ok");
      const gc = await build(source, "gc");
      expect(gc.irPostClaimErrors ?? []).toEqual([]);
      expect(await run(gc, "gc")).toBe("ok");
    });
  }

  for (const [name, { source, detail }] of Object.entries(REFUSED)) {
    it(`refuses at select and matches legacy: ${name}`, async () => {
      const ir = await build(source, "standalone");
      expect(ir.irPostClaimErrors ?? []).toEqual([]);
      const row = outcome(ir, "<module-init>");
      expect(row).toMatchObject({ kind: "unsupported", stage: "select", irBodyEmitted: false });
      expect(row?.detail).toContain(detail);
      expect(await run(ir, "standalone")).toBe(await run(await build(source, "standalone", false), "standalone"));
    });
  }

  // (#7212 review K1) A plain dynamic script var under a loose `null` compare is not this table's carrier:
  // its routing, and the JS environment's bytes, stay main's.
  for (const op of ["==", "!="]) {
    it(`routes a statics-free loose null compare as main does (${op})`, async () => {
      const source = `var n; function g() { n = 3; } function h() { return n ${op} null; } g(); if (h()${op === "==" ? "" : " !== true"}) { throw "x"; }`;
      for (const lane of ["standalone", "gc"] as const) {
        const ir = await build(source, lane);
        expect(outcome(ir, "h")?.stage, lane).not.toBe("select");
        expect(outcome(ir, "<module-init>")?.irBodyEmitted, lane).toBe(true);
      }
    });
  }

  it("leaves a shadowed Object to the program's own binding", async () => {
    const source = `var calls = 0; var Object = { defineProperty: function () { calls = calls + 1; } }; var o = {}; Object.defineProperty(o, "p", { value: 3 }); if (calls !== 1 || o.p !== undefined) { throw "shadow"; }`;
    const ir = await build(source, "standalone");
    expect(ir.irPostClaimErrors ?? []).toEqual([]);
    expect(outcome(ir, "<module-init>")?.detail ?? "").not.toContain("expr-object-static");
    expect(await run(ir, "standalone")).toBe(await run(await build(source, "standalone", false), "standalone"));
  });

  it("claims a function that defines, and the function that calls it", async () => {
    const source = `var o = {}; function f() { Object.defineProperties(o, { q: { value: 2 } }); } f(); if (o.q !== 2) { throw "q"; }`;
    const ir = await build(source, "standalone");
    expect(ir.irPostClaimErrors ?? []).toEqual([]);
    expect(outcome(ir, "<module-init>")?.irBodyEmitted).toBe(true);
    expect(outcome(ir, "f")?.irBodyEmitted).toBe(true);
    expect(await run(ir, "standalone")).toBe("ok");
  });

  it("keeps the JS environment on its own arms", async () => {
    const source = CLAIMED["a literal descriptor map"]!;
    const withTable = await build(source, "gc");
    expect((withTable.irOutcomes ?? []).some((row) => (row.detail ?? "").includes("expr-object-static"))).toBe(false);
  });
});
