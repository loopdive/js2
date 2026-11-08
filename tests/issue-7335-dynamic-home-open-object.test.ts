// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7335 slice 1 (lever D): a script's top-level `var o = {}`, declared once and
// never written, whose slot legacy keeps as an open `$Object` in externref, is
// the IR's `dynamic` script-var home. On standalone the IR claims a
// `<module-init>` that initializes it (`__new_plain_object`), defines on it
// with a literal data descriptor from any unit, and tests it with
// `hasOwnProperty` / `propertyIsEnumerable`. Uses the dynamic operations do not
// serve (an inherited-key read, loose equality) and a module-init `var` head
// the unit cannot model stay on legacy, refused at select, never claimed and
// then demoted. The gc lane declines (its byte-identity to main is checked by
// the A/B in the issue file).
import { describe, expect, it } from "vitest";

import { compile, type CompileResult } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

type Lane = "standalone" | "gc";

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

async function run(result: CompileResult, lane: Lane): Promise<"ok" | "threw"> {
  try {
    const imports = lane === "standalone" ? {} : buildImports(result.imports, {}, result.stringPool);
    const { instance } = await WebAssembly.instantiate(result.binary, imports as WebAssembly.Imports);
    (instance.exports.__module_init as () => void)();
    return "ok";
  } catch {
    return "threw";
  }
}

function node(source: string): "ok" | "threw" {
  try {
    new Function(source)();
    return "ok";
  } catch {
    return "threw";
  }
}

function moduleInitIsIr(result: CompileResult): boolean | undefined {
  return (result.irOutcomes ?? []).find((row) => row.displayName === "<module-init>")?.irBodyEmitted;
}

const DEFINE = "Object.defineProperty(o, 'p', { value: 1 });";

const CLAIMED: Record<string, string> = {
  "define, then an own read": `var o = {}; ${DEFINE} if (o.p !== 1) { throw "p"; }`,
  "define from a function": `var o = {}; function f() { Object.defineProperty(o, 'q', { value: 2 }); } f(); if (o.q !== 2) { throw "q"; }`,
  "non-writable write is ignored": `var o = {}; ${DEFINE} o.p = 2; if (o.p !== 1) { throw "p"; }`,
  "non-configurable redefine throws TypeError": `var o = {}; ${DEFINE} try { Object.defineProperty(o, 'p', { value: 2 }); throw "no"; } catch (e) { if (!(e instanceof TypeError)) { throw "type"; } }`,
  hasOwnProperty: `var o = {}; ${DEFINE} if (!o.hasOwnProperty('p') || o.hasOwnProperty('toString')) { throw "own"; }`,
  propertyIsEnumerable: `var o = {}; ${DEFINE} Object.defineProperty(o, 'e', { value: 1, enumerable: true }); if (o.propertyIsEnumerable('p') || !o.propertyIsEnumerable('e')) { throw "enum"; }`,
  "numeric key, canonicalised": `var o = {}; Object.defineProperty(o, 1000000000000000000000, {}); if (!o.hasOwnProperty("1e+21")) { throw "key"; }`,
  "own-property result stored": `var o = {}; ${DEFINE} var b = o.hasOwnProperty('p'); if (b !== true) { throw "b"; }`,
  typeof: `var o = {}; if (typeof o !== 'object') { throw "typeof"; }`,
  "read before the declaration runs": `if (o !== undefined) { throw "hoist"; } var o = {};`,
};

const REFUSED: Record<string, string> = {
  "inherited method read": `var o = {}; if (o.hasOwnProperty !== Object.prototype.hasOwnProperty) { throw "inherited"; }`,
  "inherited read compared": `var o = {}; if (o.toString === undefined) { throw "inherited"; }`,
  "loose equality with null": `var o = {}; if (o == null) { throw "null"; }`,
  reassigned: `var o = {}; o = 5; if (o !== 5) { throw "reassigned"; }`,
  "replaced hasOwnProperty": `Object.prototype.hasOwnProperty = function () { return true; }; var o = {}; if (!o.hasOwnProperty('zz')) { throw "override"; }`,
  "element read": `var o = {}; ${DEFINE} var k = 'p'; if (o[k] !== 1) { throw "elem"; }`,
  "for-in var head over a dynamic binding": `/** @type {any} */ var a = {}; for (var k in a) { }`,
  "member write in a nested closure": `"use strict"; var o = {}; Object.defineProperty(o, 'b', { writable: false }); var threw = false; (function () { try { o.b = 11; } catch (e) { threw = e instanceof TypeError; } })(); if (!threw) { throw "strict"; }`,
};

describe("#7335 — standalone dynamic-home open object", () => {
  for (const [name, source] of Object.entries(CLAIMED)) {
    it(`claims <module-init> and matches node and legacy: ${name}`, async () => {
      const ir = await build(source, "standalone");
      expect(ir.irPostClaimErrors ?? []).toEqual([]);
      expect(moduleInitIsIr(ir), JSON.stringify(ir.irOutcomes, null, 2)).toBe(true);
      const expected = node(source);
      expect(await run(await build(source, "standalone", false), "standalone")).toBe(expected);
      expect(await run(ir, "standalone")).toBe(expected);
    });
  }

  for (const [name, source] of Object.entries(REFUSED)) {
    it(`refuses at select and matches legacy: ${name}`, async () => {
      const ir = await build(source, "standalone");
      expect(ir.irPostClaimErrors ?? []).toEqual([]);
      expect(moduleInitIsIr(ir)).not.toBe(true);
      const legacy = await build(source, "standalone", false);
      expect(await run(ir, "standalone")).toBe(await run(legacy, "standalone"));
    });
  }

  it("keeps a module source on legacy", async () => {
    const source = `var o = {}; ${DEFINE} var c = o.p === 1; export function f() { return c ? 1 : 0; }`;
    const ir = await build(source, "standalone", true, false);
    expect(moduleInitIsIr(ir)).not.toBe(true);
  });

  for (const source of [CLAIMED["define, then an own read"]!, CLAIMED.hasOwnProperty!]) {
    it(`the gc lane declines <module-init> and matches node: ${source.slice(0, 40)}`, async () => {
      const ir = await build(source, "gc");
      expect(ir.irPostClaimErrors ?? []).toEqual([]);
      expect(moduleInitIsIr(ir)).not.toBe(true);
      expect(await run(ir, "gc")).toBe(node(source));
    });
  }
});
