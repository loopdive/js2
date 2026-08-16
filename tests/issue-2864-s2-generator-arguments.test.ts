// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2864 wave-2 S2 — a generator whose body reads the implicit `arguments`
 * object must not route through the Wasm-native generator frame.
 *
 * The native state struct has slots for `this`, own params and spilled locals.
 * The RESUME function compiles the body with a FRESH `FunctionContext`, and the
 * §10.2.11 `arguments`-vec setup in `function-body.ts` runs against the FACTORY's
 * context only — so `arguments` resolves to nothing inside the resume body.
 *
 * The bail already existed for generator EXPRESSIONS
 * (`isNativeGeneratorExpressionShape`) and generator METHODS, and was simply
 * never applied to free function DECLARATIONS — which #3032 W6 later routed
 * natively on the JS-HOST lane too. Measured before the fix:
 *
 *   - JS-HOST (gc): the compiler reported SUCCESS and emitted a module the
 *     ENGINE REJECTS — `global.set[0] expected type externref, found i32.const
 *     of type i32`. A non-generator reading `arguments` is valid, and a
 *     generator not reading it is valid; it is specifically generator ×
 *     `arguments`. This is the worst failure mode available: green compile,
 *     unloadable binary.
 *   - standalone/wasi: a raw wasm trap at the FIRST `arguments` read, before
 *     any suspend — so it was never a suspend-crossing problem.
 *
 * Making `arguments` genuinely work in the frame is a separate slice (factory
 * builds the vec at call time, spills it; resume reloads it; mapped aliasing
 * needs `fctx.mappedArgsInfo` rebuilt against the frame) — see #2864.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { compileToWasm } from "./equivalence/helpers.js";

describe("#2864 S2 generator × arguments", () => {
  it("JS-HOST: a generator reading arguments emits a VALID module and the right value", async () => {
    // Regression pin for the invalid-module bug. `compileToWasm` itself runs
    // `WebAssembly.validate`, so an invalid binary fails here rather than at
    // instantiate — the property that actually broke.
    const exports = await compileToWasm(`
      function* g(a: number, b: number) { const n = arguments.length; yield n; }
      export function test(): number { return g(7, 8).next().value as number; }
    `);
    expect(exports.test()).toBe(2);
  });

  it("JS-HOST: arguments read AFTER a yield also works", async () => {
    const exports = await compileToWasm(`
      function* g(a: number, b: number) { yield 0; yield arguments.length; }
      export function test(): number {
        const it = g(7, 8);
        it.next();
        return it.next().value as number;
      }
    `);
    expect(exports.test()).toBe(2);
  });

  it("JS-HOST: a generator NOT reading arguments still routes natively", async () => {
    // Guards the blast radius: the bail must not pull ordinary generators off
    // the native path. A native host-lane generator has no `__gen_*` imports.
    const r = await compile(`function* g(a: number, b: number) { yield a + b; }
export function test(): number { return g(7, 8).next().value as number; }`);
    expect(r.success).toBe(true);
    const names = (r.imports ?? []).map((i) => (i as { name: string }).name);
    expect(names.filter((n) => n.startsWith("__gen_") || n === "__create_generator")).toEqual([]);
  });

  it("standalone: refuses cleanly (#680) instead of trapping", async () => {
    const r = await compile(
      `function* g(a: number, b: number) { const n = arguments.length; yield n; }
export function test(): number { return g(7, 8).next().value as number; }`,
      { fileName: "test.ts", target: "standalone" },
    );
    // A refusal is the correct standalone answer until the frame carries
    // `arguments`; the pre-fix behaviour was a raw trap at runtime.
    expect(r.success).toBe(false);
    expect(r.errors?.[0]?.message ?? "").toContain("#680");
  });

  it("standalone: a generator NOT reading arguments is still host-free", async () => {
    const r = await compile(
      `function* g(a: number, b: number) { yield a + b; }
export function test(): number { return g(7, 8).next().value as number; }`,
      {
        fileName: "test.ts",
        target: "standalone",
      },
    );
    expect(r.success, r.errors?.[0]?.message).toBe(true);
    const mod = await WebAssembly.compile(r.binary);
    expect(WebAssembly.Module.imports(mod)).toEqual([]);
  });
});
