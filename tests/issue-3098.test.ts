// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3098 — standalone native callback dispatch for DYNAMIC (`any`/externref)
// array receivers: retire `env.__make_callback` on the dynamic-receiver HOF lane.
//
// Root cause: a callback passed to an array HOF on an `any` receiver was
// materialized through the `env.__make_callback` host bridge (the #2 leaked
// host import by file count in the 2026-06-26 standalone JSONL). Standalone has
// no JS host, so the import leaked and the module failed to instantiate. The
// typed-receiver HOF arms were already native.
//
// Fix (three coupled pieces, all standalone-gated):
//  1. calls.ts closed-dispatch site: inline arrow/function-expression callbacks
//     to the native-HOF-served methods compile as raw GC CLOSURE structs
//     (crossing as externref), not `__make_callback` externrefs.
//  2. object-runtime.ts `ensureNativeArrayHof`: native `__hof_<name>` loops
//     (forEach/map/filter/find/findIndex/findLast/findLastIndex/every/some/
//     reduce/reduceRight) over `__extern_length`/`__extern_get_idx`, invoking
//     the callback through the proven `__apply_closure` bridge (arity-tolerant
//     per #2939 — a 1-param callback ignores the extra index/array args).
//  3. closed-method-dispatch.ts: a `$__vec_base`/`$ObjVec` brand arm routing
//     those method names to `__hof_<name>` (so chained HOFs — whose results are
//     `$ObjVec`s — dispatch too). Sits UNDER the closed-struct arms so a user
//     object-literal `{ map(cb){…} }` still wins.
//
// The standalone assertions instantiate with an EMPTY import object and first
// assert the module declares ZERO imports — the behaviour is truly HOST-FREE.

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/** Compile host-free (`target: standalone`), assert 0 imports, run test(). */
async function runStandaloneHostFree(source: string): Promise<unknown> {
  const result: any = await compile(source, {
    fileName: "test.ts",
    target: "standalone",
    skipSemanticDiagnostics: true,
  });
  if (!result.success) {
    throw new Error("compile: " + result.errors.map((e: any) => e.message).join("; "));
  }
  const mod = await WebAssembly.compile(result.binary);
  const imports = WebAssembly.Module.imports(mod);
  // The whole point of the fix: this dispatch is host-free. If the
  // `__make_callback` bridge (or any host import) sneaks back in, the
  // "standalone" result is a lie — fail loudly.
  expect(imports.map((i) => `${i.module}.${i.name}`)).toEqual([]);
  const instance: any = await WebAssembly.instantiate(mod, {});
  return instance.exports.test();
}

const t = (body: string) => `export function test(): number { ${body} }`;

describe("#3098 — standalone any-receiver HOF callbacks dispatch natively (host-free)", () => {
  it("map on an any receiver (was: __make_callback leak + trap)", async () => {
    expect(await runStandaloneHostFree(t(`const a: any = [1, 2, 3]; return a.map((x: any) => x * 2)[2];`))).toBe(6);
  });

  it("filter on an any receiver (was: wrong length 0 + leak)", async () => {
    expect(await runStandaloneHostFree(t(`const a: any = [1, 2, 3]; return a.filter((x: any) => x > 1).length;`))).toBe(
      2,
    );
  });

  it("forEach mutating an outer capture", async () => {
    expect(
      await runStandaloneHostFree(
        t(`let s = 0; const a: any = [1, 2, 3]; a.forEach((x: any) => { s += x; }); return s;`),
      ),
    ).toBe(6);
  });

  it("reduce with an initial value", async () => {
    expect(
      await runStandaloneHostFree(t(`const a: any = [1, 2, 3]; return a.reduce((s: any, x: any) => s + x, 10);`)),
    ).toBe(16);
  });

  it("reduce without an initial value seeds from the first element", async () => {
    expect(
      await runStandaloneHostFree(t(`const a: any = [1, 2, 3]; return a.reduce((s: any, x: any) => s + x);`)),
    ).toBe(6);
  });

  it("reduceRight folds right-to-left", async () => {
    // 8 - 2 - 1 = 5 proves the iteration order (reduce would give 1-2-8 = -9).
    expect(
      await runStandaloneHostFree(t(`const a: any = [1, 2, 8]; return a.reduceRight((s: any, x: any) => s - x);`)),
    ).toBe(5);
  });

  it("find / findIndex / findLast / findLastIndex", async () => {
    expect(await runStandaloneHostFree(t(`const a: any = [1, 2, 3, 4]; return a.find((x: any) => x > 2);`))).toBe(3);
    expect(await runStandaloneHostFree(t(`const a: any = [1, 2, 3, 4]; return a.findIndex((x: any) => x > 2);`))).toBe(
      2,
    );
    expect(await runStandaloneHostFree(t(`const a: any = [1, 2, 3, 4]; return a.findLast((x: any) => x < 3);`))).toBe(
      2,
    );
    expect(
      await runStandaloneHostFree(t(`const a: any = [1, 2, 3, 4]; return a.findLastIndex((x: any) => x < 3);`)),
    ).toBe(1);
    // Misses: find → undefined, findIndex → -1.
    expect(
      await runStandaloneHostFree(t(`const a: any = [1, 2]; return a.find((x: any) => x > 9) === undefined ? 1 : 0;`)),
    ).toBe(1);
    expect(await runStandaloneHostFree(t(`const a: any = [1, 2]; return a.findIndex((x: any) => x > 9);`))).toBe(-1);
  });

  it("every / some (incl. vacuous-truth on empty)", async () => {
    expect(await runStandaloneHostFree(t(`const a: any = [1, 2, 3]; return a.every((x: any) => x > 0) ? 1 : 0;`))).toBe(
      1,
    );
    expect(await runStandaloneHostFree(t(`const a: any = [1, 2, 3]; return a.every((x: any) => x > 1) ? 1 : 0;`))).toBe(
      0,
    );
    expect(await runStandaloneHostFree(t(`const a: any = [1, 2, 3]; return a.some((x: any) => x > 2) ? 1 : 0;`))).toBe(
      1,
    );
    expect(await runStandaloneHostFree(t(`const a: any = []; return a.every((x: any) => false) ? 1 : 0;`))).toBe(1);
    expect(await runStandaloneHostFree(t(`const a: any = []; return a.some((x: any) => true) ? 1 : 0;`))).toBe(0);
  });

  it("callback receives (value, index, array) — arity-tolerant (#2939)", async () => {
    // 2-param callback reads the index.
    expect(
      await runStandaloneHostFree(t(`const a: any = [10, 20, 30]; return a.map((x: any, i: any) => x + i)[2];`)),
    ).toBe(32);
    // 3-param callback reads the array argument.
    expect(
      await runStandaloneHostFree(
        t(
          `const a: any = [10, 20]; let n = 0; a.forEach((x: any, i: any, arr: any) => { n += arr.length; }); return n;`,
        ),
      ),
    ).toBe(4);
  });

  it("chained HOFs dispatch on the $ObjVec result carrier", async () => {
    expect(
      await runStandaloneHostFree(
        t(`const a: any = [1, 2, 3, 4]; return a.map((x: any) => x * 2).filter((x: any) => x > 4).length;`),
      ),
    ).toBe(2);
    expect(
      await runStandaloneHostFree(
        t(`const a: any = [1, 2, 3]; return a.filter((x: any) => x > 1).map((x: any) => x + 1)[1];`),
      ),
    ).toBe(4);
  });

  it("identifier-held callback (closure value, not inline arrow)", async () => {
    expect(
      await runStandaloneHostFree(t(`const f = (x: any) => x * 3; const a: any = [1, 2, 3]; return a.map(f)[1];`)),
    ).toBe(6);
  });

  it("closure capture inside the callback", async () => {
    expect(
      await runStandaloneHostFree(t(`const k: number = 5; const a: any = [1, 2]; return a.map((x: any) => x + k)[0];`)),
    ).toBe(6);
  });

  it("string elements flow through the predicate", async () => {
    expect(
      await runStandaloneHostFree(
        t(`const a: any = ["aa", "b", "ccc"]; return a.filter((s: any) => s.length > 1).length;`),
      ),
    ).toBe(2);
  });

  it("typed-receiver HOF stays native (control — unchanged path)", async () => {
    expect(
      await runStandaloneHostFree(t(`const a: number[] = [1, 2, 3]; return a.map((x: number) => x * 2)[2];`)),
    ).toBe(6);
  });

  it("user object-literal method named map still wins over the HOF arm", async () => {
    expect(
      await runStandaloneHostFree(t(`const o: any = { map(x: any) { return 42; } }; return o.map((v: any) => v);`)),
    ).toBe(42);
  });
});
