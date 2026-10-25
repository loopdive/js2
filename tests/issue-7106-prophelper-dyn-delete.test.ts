// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7106 propertyHelper arm 3 — a statement-position `delete` through a
// dynamic parameter (`delete obj[name];`, propertyHelper's `isConfigurable`
// and `isWritable`). #6842 keeps every `delete` off the IR because the old
// lowering answered a constant `true`. This arm re-admits exactly the dynamic
// statement form and lowers it through `__ir_dyn_delete_{strict,sloppy}`,
// legacy's generic externref delete arm:
// - RequireObjectCoercible (a TypeError for null/undefined);
// - `__delete_property`;
// - in strict code, a TypeError for a refused delete.
// Every result is compared with node.

import { describe, expect, it } from "vitest";
import ts from "typescript";

import { compile, type CompileResult } from "../src/index.js";

const ALIAS = "var __hasOwnProperty = Function.prototype.call.bind(Object.prototype.hasOwnProperty);";

// A module is strict code: deleting a frozen key throws a TypeError.
const STRICT_MODULE = `${ALIAS}
  /** @param {object} obj @param {string|number|symbol} name */
  function removeKey(obj, name) {
    delete obj[name];
    return !__hasOwnProperty(obj, name);
  }
  /** @param {object} obj */
  function removeA(obj) {
    delete obj.a;
    return !__hasOwnProperty(obj, "a");
  }
  /** @param {object} obj */
  function removeLiteralKeys(obj) {
    delete obj["b"];
    delete obj[0];
    return !__hasOwnProperty(obj, "b") && !__hasOwnProperty(obj, 0);
  }
  // Deletes nested in a try body and in if/else arms (propertyHelper's
  // isConfigurable / isWritable shapes). The nested statement lowering must
  // take the same delete arm as the top-level one, or the claim demotes.
  /** @param {object} obj @param {string|number|symbol} name */
  function removeNested(obj, name) {
    var ok = true;
    try {
      delete obj[name];
    } catch (e) {
      ok = false;
    }
    if (ok) {
      delete obj.a;
    } else {
      delete obj["c"];
    }
    return ok && !__hasOwnProperty(obj, name);
  }
  export function probe(): number {
    var n = 0;
    var o: any = { a: 1, b: 2 };
    if (removeKey(o, "b") === true) n += 1;
    if (removeA(o) === true) n += 2;
    var arr: any = [1, 2, 3];
    if (removeKey(arr, 1) === true) n += 4;
    var frozen: any = Object.freeze({ k: 1 });
    try { removeKey(frozen, "k"); } catch (e) { if (e instanceof TypeError) n += 8; }
    try { removeKey(null, "x"); } catch (e) { if (e instanceof TypeError) n += 16; }
    var both: any = { b: 1, 0: 2, c: 3 };
    if (removeLiteralKeys(both) === true && __hasOwnProperty(both, "c")) n += 32;
    var nested: any = { a: 1, b: 2, c: 3 };
    if (removeNested(nested, "b") === true && !__hasOwnProperty(nested, "a") && __hasOwnProperty(nested, "c")) n += 64;
    var pinned: any = Object.defineProperty({ a: 1, c: 1 }, "k", { value: 1, configurable: false });
    if (removeNested(pinned, "k") === false && __hasOwnProperty(pinned, "a") && !__hasOwnProperty(pinned, "c")) n += 128;
    return n;
  }
`;

// A script is sloppy code: the same frozen delete reports `false`. Checks
// throw from the initializer; node runs the same script without throwing.
const SLOPPY_SCRIPT = `${ALIAS}
  function removeKey(obj, name) {
    delete obj[name];
    return !__hasOwnProperty(obj, name);
  }
  var arr = [1, 2, 3];
  if (removeKey(arr, 1) !== true) { throw "#1 array element"; }
  var o = { a: 1, b: 2 };
  if (removeKey(o, "b") !== true) { throw "#2 own key"; }
  var frozen = Object.freeze({ k: 1 });
  if (removeKey(frozen, "k") !== false) { throw "#3 sloppy delete of a frozen key reports false"; }
  var nullThrew = false;
  try { removeKey(null, "x"); } catch (e) { nullThrew = e instanceof TypeError; }
  if (!nullThrew) { throw "#4 delete on null throws a TypeError"; }
`;

const DELETERS = ["removeKey", "removeA", "removeLiteralKeys", "removeNested"];

function irBodies(result: CompileResult): string[] {
  return (result.irOutcomes ?? []).filter((o) => o.kind === "emitted" && o.irBodyEmitted).map((o) => o.displayName);
}

function nodeProbe(source: string): unknown {
  const js = ts.transpile(source, { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 });
  const exports: Record<string, () => unknown> = {};
  new Function("exports", js)(exports);
  return exports.probe!();
}

async function compileModule(target?: "standalone" | "wasi", source: string = STRICT_MODULE): Promise<CompileResult> {
  const result = await compile(source, {
    ...(target ? { target } : {}),
    experimentalIR: true,
    skipSemanticDiagnostics: true,
    allowJs: true,
    fileName: "issue-7106-dyn-delete.ts",
    trackIrOutcomes: true,
  } as never);
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  return result;
}

// Unannotated sloppy-script predicates over the Object aliases. These are NOT
// IR-claimed: the selector's single boolean certification
// (`declaredExpressionHasExactFamily(…, "boolean")`) does not cover them, and a
// wider pre-claim certification was measured to claim-then-demote both bodies
// ("function typeIdx parity mismatch"). Node runs the same script without
// throwing; so must the Wasm module's initializer, from the legacy bodies.
const SLOPPY_ALIAS_SCRIPT = `${ALIAS}
  var __gopd = Object.getOwnPropertyDescriptor;
  function hasK(obj, k) { if (__hasOwnProperty(obj, k)) { return 1; } return 0; }
  function notEnum(obj, k) { return !__gopd(obj, k).enumerable; }
  var o = { a: 1 };
  Object.defineProperty(o, "h", { value: 1, enumerable: false });
  if (hasK(o, "a") !== 1) { throw "#1 own key"; }
  if (hasK(o, "zz") !== 0) { throw "#2 missing key"; }
  if (notEnum(o, "h") !== true) { throw "#3 non-enumerable"; }
  if (notEnum(o, "a") !== false) { throw "#4 enumerable"; }
`;

// The four strict delete shapes (dynamic key, named key, missing key, array
// index) beside the expression-position delete that stays off the IR.
const DELETE_SHAPES_MODULE = `${ALIAS}
  /** @param {object} obj @param {string|number|symbol} name */
  function delKey(obj, name) { delete obj[name]; return !__hasOwnProperty(obj, name); }
  /** @param {object} obj */
  function delNamed(obj) { delete obj.x; return !__hasOwnProperty(obj, "x"); }
  /** @param {object} obj */
  function delMissing(obj) { delete obj.nope; return !__hasOwnProperty(obj, "nope"); }
  /** @param {object} obj */
  function delUsed(obj) { if (delete obj.x) return 1; return 0; }
  /** @param {object} obj */
  function delArrIdx(obj) { delete obj[1]; return obj.length; }
  export function probe(): number {
    var n = 0;
    var lit: any = { x: 1, y: 2 };
    if (delNamed(lit) && lit.y === 2) n += 1;
    var arr: any = [1, 2, 3];
    if (delKey(arr, 1) && arr.length === 3 && arr[1] === undefined) n += 2;
    var nc: any = Object.defineProperty({ a: 1 }, "k", { value: 1, configurable: false });
    try { delKey(nc, "k"); } catch (e) { if (e instanceof TypeError && nc.k === 1) n += 4; }
    if (delMissing({ a: 1 })) n += 8;
    if (delUsed({ x: 1 }) === 1) n += 16;
    if (delArrIdx([1, 2, 3]) === 3) n += 32;
    try { delKey(undefined, "x"); } catch (e) { if (e instanceof TypeError) n += 64; }
    return n;
  }
`;

const DELETE_SHAPES = ["delKey", "delNamed", "delMissing", "delArrIdx"];

async function compileScript(target?: "standalone", source: string = SLOPPY_SCRIPT): Promise<CompileResult> {
  const result = await compile(source, {
    ...(target ? { target } : {}),
    fileName: "test.js",
    allowJs: true,
    skipSemanticDiagnostics: true,
    scriptGoal: true,
    inferModuleStrictArguments: false,
    deferTopLevelInit: true,
    hostBridge: "always",
    trackIrOutcomes: true,
  } as never);
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  return result;
}

describe("#7106 propertyHelper — statement-position dynamic delete", () => {
  for (const lane of ["standalone", "gc"] as const) {
    const target = lane === "standalone" ? "standalone" : undefined;

    it(`${lane}: strict deletes ship IR bodies and answer like node`, async () => {
      const result = await compileModule(target);
      expect(irBodies(result)).toEqual(expect.arrayContaining(DELETERS));
      expect(result.irPostClaimErrors ?? []).toEqual([]);
      const { instance } = await WebAssembly.instantiate(result.binary, result.importObject ?? {});
      const got = (instance.exports.probe as () => number)();
      expect(got).toBe(nodeProbe(STRICT_MODULE));
      expect(got).toBe(255);
    });

    it(`${lane}: a sloppy script's delete reports false for a frozen key, like node`, async () => {
      const result = await compileScript(target);
      expect(irBodies(result)).toContain("removeKey");
      expect(result.irPostClaimErrors ?? []).toEqual([]);
      expect(() => new Function(SLOPPY_SCRIPT)()).not.toThrow();
      const { instance } = await WebAssembly.instantiate(result.binary, result.importObject ?? {});
      expect(() => (instance.exports.__module_init as () => void)()).not.toThrow();
    });

    it(`${lane}: the four delete shapes claim without post-claim errors and answer like node`, async () => {
      const result = await compileModule(target, DELETE_SHAPES_MODULE);
      expect(irBodies(result)).toEqual(expect.arrayContaining(DELETE_SHAPES));
      expect(irBodies(result)).not.toContain("delUsed");
      expect(result.irPostClaimErrors ?? []).toEqual([]);
      const { instance } = await WebAssembly.instantiate(result.binary, result.importObject ?? {});
      const got = (instance.exports.probe as () => number)();
      expect(got).toBe(nodeProbe(DELETE_SHAPES_MODULE));
      expect(got).toBe(127);
    });

    it(`${lane}: unannotated sloppy alias predicates stay legacy, with no claim-then-demote`, async () => {
      const result = await compileScript(target, SLOPPY_ALIAS_SCRIPT);
      expect(irBodies(result)).not.toContain("hasK");
      expect(irBodies(result)).not.toContain("notEnum");
      expect(result.irPostClaimErrors ?? []).toEqual([]);
      expect(() => new Function(SLOPPY_ALIAS_SCRIPT)()).not.toThrow();
      const { instance } = await WebAssembly.instantiate(result.binary, result.importObject ?? {});
      expect(() => (instance.exports.__module_init as () => void)()).not.toThrow();
    });
  }

  it("wasi: the strict deletes ship IR bodies and validate", async () => {
    const result = await compileModule("wasi");
    expect(irBodies(result)).toEqual(expect.arrayContaining(DELETERS));
    expect(WebAssembly.validate(result.binary)).toBe(true);
  });

  it("keeps a delete on a concrete receiver and an expression-position delete off the IR (#6842)", async () => {
    const source = `
      function deleteArrayLength(): number { const a = [1, 2]; return delete (a as any).length ? 1 : 0; }
      /** @param {object} obj */
      function deleteAsValue(obj) { return delete obj.a; }
      export function probe(): number {
        let n = 0;
        try { deleteArrayLength(); } catch (e) { if (e instanceof TypeError) n += 1; }
        if (deleteAsValue({ a: 1 }) === true) n += 2;
        return n;
      }
    `;
    const result = await compile(source, {
      target: "standalone",
      experimentalIR: true,
      skipSemanticDiagnostics: true,
      allowJs: true,
      fileName: "issue-7106-dyn-delete-refused.ts",
      trackIrOutcomes: true,
    } as never);
    expect(result.success).toBe(true);
    expect(irBodies(result)).not.toContain("deleteArrayLength");
    expect(irBodies(result)).not.toContain("deleteAsValue");
    expect(result.irPostClaimErrors ?? []).toEqual([]);
    const { instance } = await WebAssembly.instantiate(result.binary, {});
    expect((instance.exports.probe as () => number)()).toBe(nodeProbe(source));
  });
});
