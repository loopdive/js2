// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7128 S1 — on standalone the IR claims a function-local `var o = {}` whose
// every reference is a data-descriptor `Object.defineProperty(o, <static key>,
// {…})` statement (U1) or a named read `o.k` (U2). The literal lowers to
// legacy's open `$Object` (`__new_plain_object`), the define to the native
// `__obj_define_from_desc` applier over a `$Object` descriptor, and the read to
// `__dyn_member_get`. Every other use keeps the function on legacy, and the gc
// lane keeps declining.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";

type Target = "standalone" | "gc";

async function build(source: string, target: Target, experimentalIR: boolean, fileName = "issue-7128.js") {
  const result = await compile(source, {
    experimentalIR,
    skipSemanticDiagnostics: true,
    allowJs: true,
    target,
    trackIrOutcomes: true,
    fileName,
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  return result;
}

function irBodies(result: Awaited<ReturnType<typeof compile>>): string[] {
  return (result.irOutcomes ?? []).filter((o) => o.kind === "emitted" && o.irBodyEmitted).map((o) => o.displayName);
}

async function run(binary: Uint8Array): Promise<unknown> {
  const { instance } = await WebAssembly.instantiate(binary, {});
  try {
    return (instance.exports.f as () => unknown)();
  } catch {
    return "threw";
  }
}

/** The same source evaluated by the host engine. */
function runInNode(source: string): unknown {
  try {
    return new Function(`${source.replace(/\bexport /g, "")}; return f();`)();
  } catch {
    return "threw";
  }
}

const DEFINE = 'Object.defineProperty(o, "x", { value: 2010, writable: true, enumerable: true, configurable: true });';

const CLAIMED: Record<string, string> = {
  "number value read by ===": `export function f() { var o = {}; ${DEFINE} return o.x === 2010 ? 1 : 0; }`,
  "string value, let binding": `export function f() { let o = {}; Object.defineProperty(o, "s", { value: "hi" }); return o.s === "hi" ? 1 : 0; }`,
  "boolean value, const binding": `export function f() { const o = {}; Object.defineProperty(o, "b", { value: true, enumerable: false }); return o.b === true ? 1 : 0; }`,
  "numeric key canonicalised": `export function f() { var o = {}; Object.defineProperty(o, 1.5, { value: 7 }); return 1; }`,
  "generic descriptor reads undefined": `export function f() { var o = {}; Object.defineProperty(o, "x", { enumerable: true }); return o.x === undefined ? 1 : 0; }`,
  "absent key reads undefined": `export function f() { var o = {}; ${DEFINE} return o.y === undefined ? 1 : 0; }`,
  "configurable redefine and a second key": `export function f() { var o = {}; Object.defineProperty(o, "a", { value: 1, configurable: true }); Object.defineProperty(o, "a", { value: 3 }); Object.defineProperty(o, "b", { value: 2 }); return (o.a === 3 ? 1 : 0) + (o.b === 2 ? 2 : 0); }`,
  "non-configurable redefine throws TypeError": `export function f() { var o = {}; Object.defineProperty(o, "x", { value: 1 }); try { Object.defineProperty(o, "x", { value: 2 }); return 0; } catch (e) { return e instanceof TypeError ? 1 : 2; } }`,
  "same-value redefine is allowed": `export function f() { var o = {}; Object.defineProperty(o, "x", { value: 1 }); Object.defineProperty(o, "x", { value: 1 }); return o.x === 1 ? 1 : 0; }`,
  "relational and arithmetic consumers": `export function f() { var o = {}; Object.defineProperty(o, "x", { value: 3 }); return (o.x > 2 ? 1 : 0) + (o.x - 1 === 2 ? 2 : 0) + (o.x * 2 === 6 ? 4 : 0); }`,
  "loose equality and division": `export function f() { var o = {}; Object.defineProperty(o, "x", { value: 3 }); return (o.x == 3 ? 1 : 0) + (o.x / 3 === 1 ? 2 : 0) + (o.x % 2 === 1 ? 4 : 0); }`,
  "read flows into a local": `export function f() { var o = {}; ${DEFINE} var y = o.x; return y === 2010 ? 1 : 0; }`,
  "a local initialized by a read, then tested": `export function f() { var o = {}; Object.defineProperty(o, "x", { value: 3 }); var y = o.x; if (y) return 1; return 0; }`,
  "thrown read": `export function f() { var o = {}; Object.defineProperty(o, "x", { value: 3 }); try { throw o.x; } catch (e) { return e === 3 ? 1 : 0; } }`,
  "no define, every reference a read": `export function f() { var o = {}; var y = o.x; return o.y === undefined && y === undefined ? 1 : 0; }`,
};

const REFUSED: Record<string, string> = {
  "member write": `export function f() { var o = {}; Object.defineProperty(o, "x", { value: 1, writable: true }); o.x = 2; return o.x === 2 ? 1 : 0; }`,
  "method call": `export function f() { var o = {}; Object.defineProperty(o, "x", { value: 1, enumerable: true }); return o.propertyIsEnumerable("x") ? 1 : 0; }`,
  "pass to a call": `function g(p) { return p; } export function f() { var o = {}; Object.defineProperty(o, "x", { value: 1 }); g(o); return o.x === 1 ? 1 : 0; }`,
  alias: `export function f() { var o = {}; var p = o; Object.defineProperty(o, "x", { value: 1 }); return p.x === 1 ? 1 : 0; }`,
  capture: `export function f() { var o = {}; Object.defineProperty(o, "x", { value: 1 }); var g = function () { return o.x; }; return g() === 1 ? 1 : 0; }`,
  "descriptor variable": `export function f() { var o = {}; var d = { value: 1 }; Object.defineProperty(o, "x", d); return o.x === 1 ? 1 : 0; }`,
  "computed key": `export function f() { var o = {}; var k = "x"; Object.defineProperty(o, k, { value: 1 }); return o.x === 1 ? 1 : 0; }`,
  "define result used as a value": `export function f() { var o = {}; var r = Object.defineProperty(o, "x", { value: 1 }); return r.x === 1 ? 1 : 0; }`,
  "accessor descriptor": `export function f() { var o = {}; Object.defineProperty(o, "x", { get: function () { return 1; } }); return o.x === 1 ? 1 : 0; }`,
  "element read": `export function f() { var o = {}; Object.defineProperty(o, 0, { value: 7 }); return o[0] === 7 ? 1 : 0; }`,
  "typeof of a read": `export function f() { var o = {}; Object.defineProperty(o, "x", { value: 1 }); return typeof o.x === "number" ? 1 : 0; }`,
  "+ operand": `export function f() { var o = {}; Object.defineProperty(o, "x", { value: 3 }); return o.x + 1 === 4 ? 1 : 0; }`,
  // Review repros (PR #6957): each read shape the allow-list refuses.
  "inherited method read tested by if": `export function f() { var o = {}; if (o.toString) return 1; return 0; }`,
  "inherited method read tested by ?:": `export function f() { var o = {}; Object.defineProperty(o, "x", { value: 1 }); return o.hasOwnProperty ? 1 : 0; }`,
  "inherited method read into a local": `export function f() { var o = {}; var t = o.valueOf; return t ? 1 : 0; }`,
  "inherited method read compared": `export function f() { var o = {}; return o.toString !== undefined ? 1 : 0; }`,
  "inherited constructor read": `export function f() { var o = {}; return o.constructor === Object ? 1 : 0; }`,
  "own read tested by if": `export function f() { var o = {}; Object.defineProperty(o, "x", { value: 3 }); if (o.x) return o.x == 3 ? 1 : 0; return 0; }`,
  "own read negated": `export function f() { var o = {}; Object.defineProperty(o, "x", { value: 0 }); return !o.x ? 1 : 0; }`,
  "own read in &&": `export function f() { var o = {}; Object.defineProperty(o, "x", { value: 3 }); return o.x && 1; }`,
  "chained read throws TypeError": `export function f() { var o = {}; try { var t = o.x.y; return 1; } catch (e) { return e instanceof TypeError ? 2 : 3; } }`,
  "optional chain on a read": `export function f() { var o = {}; return o.x?.y === undefined ? 1 : 0; }`,
  "element read of a read": `export function f() { var o = {}; Object.defineProperty(o, "x", { value: "ab" }); return o.x[0] === "a" ? 1 : 0; }`,
  // Round 2, through a dynamic parameter (an exported call passes no argument,
  // so legacy is the reference here, not node).
  "dynamic parameter == null": `export function f(p) { return p == null ? 1 : 0; }`,
  "switch on a dynamic parameter": `export function f(p) { switch (p) { case 3: return 1; } return 0; }`,
  "shadowed Object": `export function f() { var Object = { defineProperty: function (a, b, c) { return a; } }; var o = {}; Object.defineProperty(o, "x", { value: 1 }); return o.x === undefined ? 1 : 0; }`,
};

// Round-2 review repros (PR #6957): shapes the dynamic-value scan used to claim
// and from-ast then demoted after the claim. Each is now refused at select time
// and must match node with no post-claim error. REFUSED's last two entries reach
// the same gap through a dynamic parameter.
const REFUSED_AT_SELECT: Record<string, string> = {
  "read == null": `export function f() { var o = {}; return o.y == null ? 1 : 0; }`,
  "read != null after a define": `export function f() { var o = {}; Object.defineProperty(o, "y", { value: 1 }); return o.y != null ? 1 : 0; }`,
  "null == read": `export function f() { var o = {}; return null == o.y ? 1 : 0; }`,
  "local from a read, then == null": `export function f() { var o = {}; Object.defineProperty(o, "y", { value: 1 }); var v = o.y; return v == null ? 1 : 0; }`,
  "switch on a local from a read": `export function f() { var o = {}; var v = o.y; switch (v) { case 3: return 1; } return 0; }`,
};

describe("#7128 S1 — standalone open-carrier Object.defineProperty", () => {
  for (const [name, source] of Object.entries(REFUSED_AT_SELECT)) {
    it(`refuses before the claim and matches legacy and node: ${name}`, async () => {
      const ir = await build(source, "standalone", true);
      expect(ir.irPostClaimErrors ?? []).toEqual([]);
      expect(irBodies(ir)).not.toContain("f");
      const legacy = await build(source, "standalone", false);
      const expected = runInNode(source);
      expect(await run(legacy.binary)).toBe(expected);
      expect(await run(ir.binary)).toBe(expected);
    });
  }

  for (const [name, source] of Object.entries(CLAIMED)) {
    it(`claims and matches legacy and node: ${name}`, async () => {
      const ir = await build(source, "standalone", true);
      expect(ir.irPostClaimErrors ?? []).toEqual([]);
      expect(irBodies(ir), JSON.stringify(ir.irOutcomes, null, 2)).toContain("f");
      const legacy = await build(source, "standalone", false);
      const expected = runInNode(source);
      expect(await run(legacy.binary)).toBe(expected);
      expect(await run(ir.binary)).toBe(expected);
    });
  }

  for (const [name, source] of Object.entries(REFUSED)) {
    it(`keeps the function on legacy: ${name}`, async () => {
      const ir = await build(source, "standalone", true);
      expect(ir.irPostClaimErrors ?? []).toEqual([]);
      expect(irBodies(ir)).not.toContain("f");
      const legacy = await build(source, "standalone", false);
      expect(await run(ir.binary)).toBe(await run(legacy.binary));
    });
  }

  it("keeps an annotated binding on legacy", async () => {
    const source = `export function f() { var o: any = {}; ${DEFINE} return o.x === 2010 ? 1 : 0; }`;
    const ir = await build(source, "standalone", true, "issue-7128.ts");
    expect(ir.irPostClaimErrors ?? []).toEqual([]);
    expect(irBodies(ir)).not.toContain("f");
    expect(await run(ir.binary)).toBe(1);
  });

  it("claims a returned read (TS source: the .js return type does not resolve)", async () => {
    const source = `export function f() { var o = {}; Object.defineProperty(o, "x", { value: 3 }); return o.x; }`;
    const ir = await build(source, "standalone", true, "issue-7128.ts");
    expect(ir.irPostClaimErrors ?? []).toEqual([]);
    expect(irBodies(ir)).toContain("f");
    expect(await run(ir.binary)).toBe(3);
  });

  it("keeps a non-null read on legacy", async () => {
    const source = `export function f() { var o = {}; Object.defineProperty(o, "x", { value: 1 }); return o.x! === 1 ? 1 : 0; }`;
    const ir = await build(source, "standalone", true, "issue-7128.ts");
    expect(ir.irPostClaimErrors ?? []).toEqual([]);
    expect(irBodies(ir)).not.toContain("f");
    expect(await run(ir.binary)).toBe(1);
  });

  it("leaves a module-init binding on legacy (S1 remainder)", async () => {
    const source = `var obj = {}; Object.defineProperty(obj, "p", { value: 2010 }); var c = (obj.p === 2010); export function f() { return c ? 1 : 0; }`;
    const ir = await build(source, "standalone", true);
    expect(ir.irPostClaimErrors ?? []).toEqual([]);
    expect(irBodies(ir)).not.toContain("<module-init>");
    expect(await run(ir.binary)).toBe(1);
  });

  it("the gc lane still declines, and its IR overlay adds nothing", async () => {
    for (const source of Object.values(CLAIMED)) {
      const ir = await build(source, "gc", true);
      expect(irBodies(ir)).not.toContain("f");
      const legacy = await build(source, "gc", false);
      expect(ir.binary).toEqual(legacy.binary);
    }
  });
});
