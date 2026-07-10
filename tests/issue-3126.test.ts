// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3126 — typed ref-element array HOF dispatch (the #3098 typed-lane residual).
//
// Root cause: the typed HOF gates in compileArrayMethodCall admitted only
// f64/i32/externref element kinds for find/findIndex/findLast/findLastIndex/
// filter/every/some/forEach/reduce/reduceRight. Ref-element receivers —
// native-string `string[]` vecs, object-struct `T[]` arrays — fell through to
// the generic fallback, which on the HOST-FREE lanes (standalone/wasi)
// materialized the callback via `env.__make_callback`, an unsatisfiable host
// import (instantiation failure).
//
// Fix (standalone/wasi ONLY): the gates admit ref/ref_null elements when the
// callback provably compiles to a GC closure struct (inline arrow/function
// expression, or a probe-compiled expression with registered ClosureInfo) —
// the typed loops' closure path (`call_ref` + coercionInstrs) is element-kind
// agnostic. find/findLast additionally type their result as the element's
// nullable ref with a `ref.null` "not found" sentinel (the typed lane's
// `undefined` rep). Non-closure (opaque externref) callbacks keep the
// previous fallback (#3015).
//
// The gc HOST lane is deliberately NOT widened: its `__make_callback`
// fallback resolves HOST globals (`Temporal`, `TemporalHelpers`, …) inside
// callback bodies, which the closure-lifted path cannot — an earlier
// all-lanes widening flipped 212 Temporal merge_group tests pass→fail
// (PR #2838 first merge-group attempt). gc emission is byte-identical to
// main in this PR.

import { describe, expect, it } from "vitest";
import { compileAndInstantiate } from "../src/runtime-instantiate.js";
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
  // The point of the fix: if `__make_callback` (or any host import) sneaks
  // back in, the "standalone" result is a lie — fail loudly.
  expect(imports.map((i) => `${i.module}.${i.name}`)).toEqual([]);
  const instance: any = await WebAssembly.instantiate(mod, {});
  return instance.exports.test();
}

/** Compile for the gc host lane and run test(). */
async function runGc(source: string): Promise<unknown> {
  const exports: any = await compileAndInstantiate(source);
  return exports.test();
}

const t = (body: string) => `export function test(): number { ${body} }`;

const CASES: { name: string; body: string; want: number; skipGc?: string }[] = [
  {
    name: "string[].find returns the matched native string",
    body: `const a: string[] = ["alpha", "beta", "gamma"];
           const r = a.find((s: string) => s === "beta");
           return r === "beta" ? 1 : 0;`,
    want: 1,
  },
  {
    name: "string[].find miss returns undefined",
    body: `const a: string[] = ["alpha"];
           const r = a.find((s: string) => s === "zz");
           return r === undefined ? 1 : 0;`,
    want: 1,
    // PRE-EXISTING gc-lane bug, byte-identical to main (verified by binary
    // hash): gc strings are externref elements, whose find-miss sentinel is
    // `ref.null.extern`, and the `=== undefined` comparison lowers to 0 for
    // it. Outside this PR (this PR's gc string[] emission is unchanged);
    // needs its own issue on the externref miss-rep comparison.
    skipGc: "pre-existing externref miss-rep === undefined bug on the gc lane",
  },
  {
    name: "string[].filter",
    body: `const a: string[] = ["alpha", "beta", "gamma"];
           return a.filter((s: string) => s.length > 4).length;`,
    want: 2,
  },
  {
    name: "string[].findIndex with (value, index, array) arity",
    body: `const a: string[] = ["x", "y", "z"];
           return a.findIndex((s: string, i: number, arr: string[]) => i === 1 && arr.length === 3 && s === "y");`,
    want: 1,
  },
  {
    name: "string[].findLast",
    body: `const a: string[] = ["alpha", "beta", "gamma"];
           const r = a.findLast((s: string) => s.length === 5);
           return r === "gamma" ? 1 : 0;`,
    want: 1,
  },
  {
    name: "string[].findLast miss returns undefined",
    body: `const a: string[] = ["alpha"];
           const r = a.findLast((s: string) => false);
           return r === undefined ? 1 : 0;`,
    want: 1,
    // Same pre-existing gc-lane externref miss-rep bug as the find case above.
    skipGc: "pre-existing externref miss-rep === undefined bug on the gc lane",
  },
  {
    name: "string[].findLastIndex",
    body: `const a: string[] = ["alpha", "beta", "gamma"];
           return a.findLastIndex((s: string) => s.length === 5);`,
    want: 2,
  },
  {
    name: "string[].every",
    body: `const a: string[] = ["alpha", "beta", "gamma"];
           return a.every((s: string) => s.length >= 4) ? 1 : 0;`,
    want: 1,
  },
  {
    name: "string[].some short-circuits after the first match",
    body: `const a: string[] = ["a", "b", "c"];
           let calls = 0;
           const r = a.some((s: string) => { calls++; return s === "a"; });
           return r && calls === 1 ? 1 : 0;`,
    want: 1,
  },
  {
    name: "string[].forEach mutates an outer capture",
    body: `const a: string[] = ["ab", "cde"];
           let n = 0;
           a.forEach((s: string) => { n += s.length; });
           return n;`,
    want: 5,
  },
  {
    name: "string[].reduce with initial value",
    body: `const a: string[] = ["a", "b", "c"];
           const r = a.reduce((acc: string, s: string) => acc + s, "");
           return r === "abc" ? 1 : 0;`,
    want: 1,
  },
  {
    name: "string[].reduce without initial value seeds from the first element",
    body: `const a: string[] = ["a", "b", "c"];
           const r = a.reduce((acc: string, s: string) => acc + s);
           return r === "abc" ? 1 : 0;`,
    want: 1,
  },
  {
    name: "string[].reduce of an empty array with no initial value throws TypeError",
    body: `const a: string[] = [];
           try { a.reduce((acc: string, s: string) => acc + s); return 0; }
           catch (e) { return 1; }`,
    want: 1,
  },
  {
    name: "string[].reduceRight",
    body: `const a: string[] = ["a", "b", "c"];
           const r = a.reduceRight((acc: string, s: string) => acc + s, "");
           return r === "cba" ? 1 : 0;`,
    want: 1,
  },
  {
    name: "chained filter→find (result vec re-dispatches natively)",
    body: `const a: string[] = ["alpha", "beta", "gamma"];
           const r = a.filter((s: string) => s.length === 5).find((s: string) => s === "gamma");
           return r === "gamma" ? 1 : 0;`,
    want: 1,
  },
  // The struct-array cases below are fixed on the HOST-FREE lanes only. The gc
  // host lane deliberately keeps its `__make_callback` fallback (which is a
  // silent no-op for these host-free bodies — pre-existing): widening the gc
  // gate flipped 212 Temporal merge_group tests whose callbacks reference HOST
  // globals (`TemporalHelpers`/`Temporal`) that the closure-lifted path cannot
  // resolve. See hofElemKindOk in array-methods.ts and the #3126 issue file.
  {
    name: "object-struct array find returns the matched struct",
    body: `const objs = [{x: 1}, {x: 2}, {x: 3}];
           const r = objs.find((o: {x: number}) => o.x > 1);
           return r ? r.x : -1;`,
    want: 2,
    skipGc: "gc keeps the host fallback (host-global callbacks); struct-array vacuity is a pre-existing gc residual",
  },
  {
    name: "object-struct array filter",
    body: `const objs = [{x: 1}, {x: 2}, {x: 3}];
           return objs.filter((o: {x: number}) => o.x > 1).length;`,
    want: 2,
    skipGc: "gc keeps the host fallback (host-global callbacks); struct-array vacuity is a pre-existing gc residual",
  },
  {
    name: "object-struct array some",
    body: `const objs = [{x: 1}, {x: 2}];
           return objs.some((o: {x: number}) => o.x === 2) ? 1 : 0;`,
    want: 1,
    skipGc: "gc keeps the host fallback (host-global callbacks); struct-array vacuity is a pre-existing gc residual",
  },
  {
    name: "object-struct array every",
    body: `const objs = [{x: 1}, {x: 2}];
           return objs.every((o: {x: number}) => o.x > 0) ? 1 : 0;`,
    want: 1,
    skipGc: "gc keeps the host fallback (host-global callbacks); struct-array vacuity is a pre-existing gc residual",
  },
];

describe("#3126 — typed ref-element array HOFs, standalone lane (host-free)", () => {
  for (const { name, body, want } of CASES) {
    it(name, async () => {
      expect(await runStandaloneHostFree(t(body))).toBe(want);
    });
  }
});

describe("#3126 — typed ref-element array HOFs, gc host lane", () => {
  for (const { name, body, want, skipGc } of CASES) {
    (skipGc ? it.skip : it)(skipGc ? `${name} [skipped: ${skipGc}]` : name, async () => {
      expect(await runGc(t(body))).toBe(want);
    });
  }
});

describe("#3126 — controls (previously-working shapes unchanged)", () => {
  it("number[].find stays native and host-free standalone", async () => {
    expect(await runStandaloneHostFree(t(`const a: number[] = [1, 2, 3]; return a.find((x: number) => x > 1);`))).toBe(
      2,
    );
  });

  it("string[].map stays native and host-free standalone (#2688 gate)", async () => {
    expect(
      await runStandaloneHostFree(
        t(`const a: string[] = ["alpha", "beta"];
           const r = a.map((s: string) => s + "!");
           return r[1] === "beta!" ? 1 : 0;`),
      ),
    ).toBe(1);
  });

  it("dynamic any-receiver HOFs stay on the #3098 native dispatch", async () => {
    expect(await runStandaloneHostFree(t(`const a: any = [1, 2, 3]; return a.filter((x: any) => x > 1).length;`))).toBe(
      2,
    );
  });
});
