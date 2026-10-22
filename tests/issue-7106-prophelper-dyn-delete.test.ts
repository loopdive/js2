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

const DELETERS = ["removeKey", "removeA", "removeLiteralKeys"];

function irBodies(result: CompileResult): string[] {
  return (result.irOutcomes ?? []).filter((o) => o.kind === "emitted" && o.irBodyEmitted).map((o) => o.displayName);
}

function nodeProbe(source: string): unknown {
  const js = ts.transpile(source, { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 });
  const exports: Record<string, () => unknown> = {};
  new Function("exports", js)(exports);
  return exports.probe!();
}

async function compileModule(target?: "standalone" | "wasi"): Promise<CompileResult> {
  const result = await compile(STRICT_MODULE, {
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

async function compileScript(target?: "standalone"): Promise<CompileResult> {
  const result = await compile(SLOPPY_SCRIPT, {
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
      expect(got).toBe(63);
    });

    it(`${lane}: a sloppy script's delete reports false for a frozen key, like node`, async () => {
      const result = await compileScript(target);
      expect(irBodies(result)).toContain("removeKey");
      expect(result.irPostClaimErrors ?? []).toEqual([]);
      expect(() => new Function(SLOPPY_SCRIPT)()).not.toThrow();
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
