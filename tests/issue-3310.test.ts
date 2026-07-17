// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #3310 — G2: args flow on the standalone generic method-call path + the
 * `__apply_closure` arity ceiling lift (E5 `CallBuiltin` prerequisite).
 *
 * A dynamic method call on an open-`$Object` receiver in standalone routes
 * through the #799 WI3 generic bridge (`call-receiver-method.ts`), which builds
 * the arg vector with the native `$ObjVec` builders and calls
 * `__extern_method_call(recv, name, argsVec)` → the `$Object` arm →
 * `__apply_closure(fn, recv, argsVec)`. `__apply_closure` dispatched the dynamic
 * arg count (`__extern_length(args)`) only to `__call_fn_method_0..4`; a call
 * with 5+ args fell off the bridge and returned the undefined sentinel (→ `0`
 * in numeric context). The higher `__call_fn_method_5..8` exports already exist
 * (index.ts #2687 cap), so the fix (fillApplyClosure, object-runtime.ts) extends
 * the arity switch to the highest emitted dispatcher (standalone/wasi only, so
 * host modules stay byte-identical).
 *
 * Regression guard: on main the 5- and 6-arg cases returned `0`; here they must
 * return the correct sum. Every case compiles standalone and must instantiate
 * with ZERO host imports.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(src: string): Promise<number> {
  const r = await compile(src, { fileName: "test.ts", target: "standalone", nativeStrings: true });
  expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
  const mod = await WebAssembly.compile(r.binary!);
  const imports = WebAssembly.Module.imports(mod).map((i) => `${i.module}::${i.name}`);
  expect(imports, "standalone module must have zero host imports").toEqual([]);
  const { instance } = await WebAssembly.instantiate(r.binary!, {});
  return (instance.exports as { test(): number }).test();
}

/**
 * Build a source that stores an N-ary arrow on an open `$Object` and invokes it
 * with args `1..N`; the callee returns the sum, so the return value proves every
 * argument reached the callee positionally (`1 + 2 + ... + N`).
 */
function openObjectClosureCall(nargs: number): string {
  const params = Array.from({ length: nargs }, (_, i) => `a${i}: number`).join(", ");
  const sum = Array.from({ length: nargs }, (_, i) => `a${i}`).join(" + ");
  const callArgs = Array.from({ length: nargs }, (_, i) => String(i + 1)).join(", ");
  return `export function test(): number {
    const o: any = {};
    o.m = (${params}) => ${sum};
    return o.m(${callArgs});
  }`;
}

const expectedSum = (n: number): number => (n * (n + 1)) / 2;

describe("#3310 — standalone generic method-call args + apply_closure arity lift", () => {
  // Arities 1..4 were already correct (the bridge dispatched __call_fn_method_0..4);
  // they guard against a regression of the pre-existing behaviour.
  for (const n of [1, 2, 3, 4]) {
    it(`open-$Object stored closure receives ${n} arg(s)`, async () => {
      expect(await runStandalone(openObjectClosureCall(n))).toBe(expectedSum(n));
    });
  }

  // Arities 5..6 are the #3310 fix: on main these fell off the arity-4 ceiling
  // and returned the undefined sentinel (0). They must now dispatch correctly.
  for (const n of [5, 6]) {
    it(`open-$Object stored closure receives ${n} arg(s) (arity > 4 — #3310 lift)`, async () => {
      expect(await runStandalone(openObjectClosureCall(n))).toBe(expectedSum(n));
    });
  }

  // Distinct (non-arithmetic-symmetric) args so a dropped/mis-ordered arg cannot
  // coincidentally still sum correctly — proves positional fidelity at arity 5.
  it("arity-5 call passes each argument to the correct position", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const o: any = {};
        o.m = (a: number, b: number, c: number, d: number, e: number) =>
          a * 10000 + b * 1000 + c * 100 + d * 10 + e;
        return o.m(1, 2, 3, 4, 5);
      }`),
    ).toBe(12345);
  });
});
