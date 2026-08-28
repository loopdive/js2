// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4782 — spread-sourced `arguments` elements arrived as `null`.
//
// `emitSetExtrasArgv` (src/codegen/statements/nested-declarations.ts) caches
// `__box_number`'s funcidx ONCE, before it emits the extras array, and falls
// back to `drop` + `ref.null.extern` when the helper is absent. For a call
// whose extras contain a spread, that cache could legitimately be filled with
// `undefined`: the extras loop itself is often the first site in the module
// that needs the boxer, and the plain numeric argument that registers it is
// compiled AFTER the cache is taken. Every spread-sourced numeric element then
// reached `arguments` as `null` while `arguments.length` stayed correct, so
// `C.prototype.method(42, ...[1], ...tail)` read `4 + 42 + 0 + 0 + 0 = 46`.
//
// Whether a given fixture reproduced depended on what ELSE the module compiled
// first: a callee whose own body boxes a number (`s += arguments[i]`, a string
// concat) registers the helper before the caller is compiled, so the cache was
// valid and the same source shape answered correctly. Within one module the
// split is clean — a spread call and a non-spread call to the same callee, and
// only the spread one was `null`.
import { describe, expect, it } from "vitest";
import { compile, compileMulti } from "../src/index.js";
import { buildImports, wrapExports } from "../src/runtime.js";

async function runModule(src: string): Promise<unknown> {
  const result = await compileMulti({ "./main.js": src }, "./main.js", {
    allowJs: true,
    skipSemanticDiagnostics: true,
    deferTopLevelInit: true,
  });
  expect(result.success, result.errors?.map((e) => e.message).join("; ")).toBe(true);
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setInstance?.(instance);
  (instance.exports as Record<string, Function>).__module_init?.();
  const wrapped = wrapExports(instance.exports as Record<string, Function>) as Record<string, () => unknown>;
  return wrapped.t!();
}

async function runSingle(src: string, opts: Record<string, unknown> = {}): Promise<unknown> {
  const result = await compile(src, { fileName: "test.ts", skipSemanticDiagnostics: true, ...opts });
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(result.binary), "binary should validate").toBe(true);
  const importObject = (result.importObject ?? {}) as Record<string, unknown> & {
    __setExports?: (e: unknown) => void;
  };
  const { instance } = await WebAssembly.instantiate(result.binary, importObject as WebAssembly.Imports);
  importObject.__setExports?.(instance.exports);
  return (instance.exports as { test(): unknown }).test();
}

describe("#4782 — spread-sourced arguments elements keep their values", () => {
  it("sums a mixed spread through a zero-formal class method", async () => {
    // 4 + 42 + 1 + 2 + 3. Was 46 (`4 + 42 + 0 + 0 + 0`).
    expect(
      await runModule(`
        class C {
          method() {
            return arguments.length + arguments[0] + arguments[1] + arguments[2] + arguments[3];
          }
        }
        export function t() {
          const tail = [2, 3];
          return C.prototype.method(42, ...[1], ...tail,);
        }
      `),
    ).toBe(52);
  });

  it("reads each spread-sourced element at a CONSTANT index", async () => {
    // The failing read shape: a constant index answered `null` while the same
    // vector summed correctly through a dynamic index.
    expect(
      await runModule(`
        class C {
          method() {
            return "" + arguments[0] + "|" + arguments[1] + "|" + arguments[2] + "|" + arguments[3];
          }
        }
        export function t() {
          const tail = [2, 3];
          return C.prototype.method(42, ...[1], ...tail,);
        }
      `),
    ).toBe("42|1|2|3");
  });

  it("agrees with the dynamic-index read of the same call", async () => {
    // Passes on the broken build too (the loop in the callee registers the
    // boxer first). Kept as the invariant guard: the constant-index and
    // dynamic-index views of one call must never disagree.
    expect(
      await runModule(`
        class C {
          method() {
            let viaConst = arguments[0] + arguments[1] + arguments[2] + arguments[3];
            let viaLoop = 0;
            for (let i = 0; i < arguments.length; i++) viaLoop += arguments[i];
            return viaConst === viaLoop ? viaLoop : -1;
          }
        }
        export function t() {
          const tail = [2, 3];
          return C.prototype.method(42, ...[1], ...tail,);
        }
      `),
    ).toBe(48);
  });

  it("expands a spread of a local array with no other numeric argument", async () => {
    // 3 + 42 + 2 + 3. Was 45.
    expect(
      await runModule(`
        class C {
          method() {
            return arguments.length + arguments[0] + arguments[1] + arguments[2];
          }
        }
        export function t() {
          const tail = [2, 3];
          return C.prototype.method(42, ...tail);
        }
      `),
    ).toBe(50);
  });

  it("holds for a plain function callee", async () => {
    expect(
      await runModule(`
        function f() {
          return arguments.length + arguments[0] + arguments[1] + arguments[2] + arguments[3];
        }
        export function t() {
          const tail = [2, 3];
          return f(42, ...[1], ...tail,);
        }
      `),
    ).toBe(52);
  });

  it("holds for an object-literal method and an instance receiver", async () => {
    expect(
      await runModule(`
        const o = {
          method() {
            return arguments.length + arguments[0] + arguments[1] + arguments[2] + arguments[3];
          },
        };
        export function t() {
          const tail = [2, 3];
          return o.method(42, ...[1], ...tail,);
        }
      `),
    ).toBe(52);
    expect(
      await runModule(`
        class C {
          method() {
            return arguments.length + arguments[0] + arguments[1] + arguments[2] + arguments[3];
          }
        }
        export function t() {
          const tail = [2, 3];
          const c = new C();
          return c.method(42, ...[1], ...tail,);
        }
      `),
    ).toBe(52);
  });

  it("expands an all-spread call whose module boxes no other number", async () => {
    // Nothing else in this module registers `__box_number`, which is exactly
    // the condition the stale cache needed. Was 0 in host mode.
    const src = `
      function f(): any { return (arguments as any)[0] + (arguments as any)[1]; }
      export function test(): any { const tail = [2, 3]; return (f as any)(...(tail as any)); }
    `;
    expect(await runSingle(src)).toBe(5);
    expect(await runSingle(src, { target: "standalone" })).toBe(5);
  });

  it("keeps the standalone lane on the same answer", async () => {
    const src = `
      class C {
        method(): any {
          return (
            (arguments as any).length +
            (arguments as any)[0] +
            (arguments as any)[1] +
            (arguments as any)[2] +
            (arguments as any)[3]
          );
        }
      }
      export function test(): any {
        const tail = [2, 3];
        return (C.prototype.method as any)(42, ...(([1]) as any), ...(tail as any),);
      }
    `;
    expect(await runSingle(src)).toBe(52);
    expect(await runSingle(src, { target: "standalone" })).toBe(52);
  });
});
