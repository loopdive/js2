import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports as buildRuntimeImports } from "../src/runtime.js";
import { buildImports } from "./equivalence/helpers.js";

// #3430 — Integrity-level operations do not throw expected TypeError.
//
// Root cause: `src/codegen/expressions/operator-assignment.ts` (compound
// assignment `+=`/`-=`/etc and logical assignment `??=`/`||=`/`&&=` on a
// dynamic/externref property or element receiver) hardcoded the sloppy
// `__extern_set` sidecar write-back for EVERY call site, never threading
// `isStrictContext()` through to select the strict `__extern_set_strict`
// terminal the way plain `=` assignment already does (assignment.ts,
// `compileExternSetFallback`, #3374). Per ES2024 §13.15.2 PutValue → strict
// Reference with a failed [[Set]] (a non-writable data property, or a new
// key on a non-extensible object) must throw a catchable TypeError; sloppy
// code keeps the silent no-op. This is the "compound-assignment" /
// "logical-assignment" sub-bucket of the #3430 triage (33 + ~8 test262
// records respectively) — see the `## Triage` section in the issue file for
// the full sub-bucket breakdown and the buckets deliberately left deferred
// (array `@@species`-create result-array writes, array integrity flags,
// reduceRight hole-representation).
//
// Module-level `var obj = {}` (no inline `: any` immediately followed by
// `Object.defineProperty` in the SAME function scope) is used deliberately —
// mirrors the real test262 fixtures (e.g. 11.13.2-25-s.js) and the passing
// probe shape. A `const obj: any = {}` local followed immediately by
// `Object.defineProperty` in the same function can hit the UNRELATED
// dynamic-struct-field-add fast path (Path A in
// `compilePropertyCompoundAssignmentExternref`), which never reaches
// `__extern_set`/`__extern_set_strict` at all — not a #3430 concern, but a
// footgun for constructing a repro. Strict cases rely on module-scope
// default strictness (`inferModuleStrictArguments: true`, the `compile()`
// default); the sloppy regression guard passes `inferModuleStrictArguments:
// false` (mirrors tests/issue-2667.test.ts) with a plain `any`-typed
// function PARAMETER receiving a fresh object per call.

async function compileToWasm(source: string, opts: Record<string, unknown> = {}) {
  const result = await compile(source, opts);
  if (!result.success) {
    throw new Error(`Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`);
  }
  const manualImports = buildImports(result);
  let setExportsFn: ((exports: Record<string, Function>) => void) | undefined;
  if (result.imports && result.imports.length > 0) {
    const runtimeResult = buildRuntimeImports(result.imports, undefined, result.stringPool);
    setExportsFn = runtimeResult.setExports;
    manualImports.env = { ...(manualImports.env as Record<string, Function>), ...runtimeResult.env };
    if (runtimeResult.string_constants) manualImports.string_constants = runtimeResult.string_constants;
  }
  const { instance } = await WebAssembly.instantiate(result.binary, manualImports);
  if (setExportsFn) setExportsFn(instance.exports as Record<string, Function>);
  return instance.exports as Record<string, Function>;
}

describe("#3430 strict compound/logical assignment [[Set]] failure throws", () => {
  it("strict `obj.prop %= v` on a non-writable data property throws TypeError (11.13.2-25-s.js)", async () => {
    const exports = await compileToWasm(`
      var obj = {};
      Object.defineProperty(obj, "prop", { value: 10, writable: false, enumerable: true, configurable: true });
      export function test(): string {
        try {
          obj.prop %= 20;
          return "no-throw";
        } catch (e) {
          return (e instanceof TypeError ? "TypeError" : "other") + ":" + obj.prop;
        }
      }
    `);
    expect(exports.test!()).toBe("TypeError:10");
  });

  it("strict `obj.prop ||= v` adding a new key to a non-extensible object throws TypeError", async () => {
    const exports = await compileToWasm(`
      var obj: any = {};
      Object.preventExtensions(obj);
      export function test(): string {
        try {
          obj.newProp ||= 20;
          return "no-throw";
        } catch (e) {
          return e instanceof TypeError ? "TypeError" : "other";
        }
      }
    `);
    expect(exports.test!()).toBe("TypeError");
  });

  it("strict `obj[key] += v` on a non-writable data property throws TypeError", async () => {
    const exports = await compileToWasm(`
      var obj = {};
      Object.defineProperty(obj, "k", { value: 10, writable: false, enumerable: true, configurable: true });
      export function test(): string {
        try {
          obj["k"] += 5;
          return "no-throw";
        } catch (e) {
          return (e instanceof TypeError ? "TypeError" : "other") + ":" + obj.k;
        }
      }
    `);
    expect(exports.test!()).toBe("TypeError:10");
  });

  it("strict `obj.prop += v` (string concat host_add arm) on a non-writable property throws TypeError", async () => {
    const exports = await compileToWasm(`
      var obj = {};
      Object.defineProperty(obj, "s", { value: "a", writable: false, enumerable: true, configurable: true });
      export function test(): string {
        try {
          obj.s += "b";
          return "no-throw";
        } catch (e) {
          return (e instanceof TypeError ? "TypeError" : "other") + ":" + obj.s;
        }
      }
    `);
    expect(exports.test!()).toBe("TypeError:a");
  });

  it("sloppy `obj.prop %= v` on a non-writable data property silently no-ops (regression guard)", async () => {
    const exports = await compileToWasm(
      `
      function fn(obj: any): number {
        Object.defineProperty(obj, "prop", { value: 7, writable: false, enumerable: true, configurable: true });
        obj.prop += 100;
        return obj.prop;
      }
      export function test(): number { return fn({}); }
    `,
      { inferModuleStrictArguments: false },
    );
    expect(exports.test!()).toBe(7);
  });

  it("sloppy `obj.prop ||= v` adding a new key to a non-extensible object does not throw (regression guard)", async () => {
    // (Deliberately does not assert `"newProp" in obj` afterward — that
    // specific query has its own pre-existing, unrelated gap for this
    // any-typed-parameter receiver shape. #3430's regression guard is
    // narrowly about NOT throwing in sloppy mode; the no-throw contract is
    // what this test protects.)
    const exports = await compileToWasm(
      `
      function fn(obj: any): number {
        Object.preventExtensions(obj);
        obj.newProp ||= 20;
        return 1;
      }
      export function test(): number { return fn({}); }
    `,
      { inferModuleStrictArguments: false },
    );
    expect(exports.test!()).toBe(1);
  });

  it("writable property compound-assign still works normally under strict mode (no over-throw)", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        const obj: any = { n: 10 };
        obj.n += 5;
        obj.n ||= 999;
        return obj.n;
      }
    `);
    expect(exports.test!()).toBe(15);
  });
});
