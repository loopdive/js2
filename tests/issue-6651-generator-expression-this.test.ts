// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #6651 cluster A1 — `this` inside a native generator FUNCTION EXPRESSION
 * (standalone / no-JS-host lane).
 *
 * Before: `isNativeGeneratorExpressionShape` bailed on any `this` in the body,
 * so `Array.prototype[Symbol.iterator] = function*(){ … this.length … }` — the
 * shape 42 of the 197 rows in the #6651 cluster-A manifest are built on — fell
 * back to the eager-buffer HOST path and leaked `env::__gen_*` imports, which
 * is a hard compile error in `--target standalone`.
 *
 * Now the FACTORY (the lifted closure) snapshots the receiver into the frame's
 * `dynamic_this` field and the resume function restores it as its `this` local
 * — the #5255 free-declaration mechanism widened to the fn-expr closure ABI.
 *
 * The load-bearing property is the SNAPSHOT, not merely "this compiles": a
 * generator's body runs on a later `.next()`, long after the call that bound
 * its receiver has returned and `__current_this` has been restored. The
 * "receiver survives a suspension" case below is the one that fails if the
 * body reads the global lazily instead.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function runStandalone(src: string): Promise<{ value: unknown; genImports: string[] }> {
  const r = await compile(src, { fileName: "test.ts", skipSemanticDiagnostics: true, target: "standalone" });
  if (!r.success) throw new Error(r.errors[0]?.message ?? "compile error");
  const genImports = r.imports
    .map((i) => `${i.module}::${i.name}`)
    .filter((n) => n.includes("__gen_") || n.includes("__create_generator"));
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  (imports as { setExports?: (e: unknown) => void }).setExports?.(instance.exports);
  return { value: (instance.exports as { test(): unknown }).test(), genImports };
}

describe("#6651 A1 — `this` in a standalone native generator function expression", () => {
  it("binds the call-site receiver and emits NO __gen_* host imports", async () => {
    const src = `
      export function test(): number {
        const o: any = { n: 7, g: function*() { yield (this as any).n; yield (this as any).n + 1; } };
        const it = o.g();
        let sum = 0;
        let r = it.next();
        while (!r.done) { sum += r.value; r = it.next(); }
        return sum;
      }
    `;
    const { value, genImports } = await runStandalone(src);
    expect(genImports).toEqual([]);
    expect(value).toBe(15);
  });

  it("the receiver SURVIVES a suspension (frame snapshot, not a lazy global read)", async () => {
    // `it` is created from `a.g()` but resumed while an unrelated receiver
    // (`b.probe()`) is the most recent one installed. A lazy `__current_this`
    // read in the resume function would report b's field here.
    const src = `
      export function test(): number {
        const a: any = { n: 10, g: function*() { yield (this as any).n; yield (this as any).n; } };
        const b: any = { n: 99, probe: function() { return (this as any).n; } };
        const it = a.g();
        let total = it.next().value as number;
        b.probe();
        total += it.next().value as number;
        return total;
      }
    `;
    const { value, genImports } = await runStandalone(src);
    expect(genImports).toEqual([]);
    expect(value).toBe(20);
  });

  it("a nested arrow inherits the generator's `this`", async () => {
    const src = `
      export function test(): number {
        const o: any = { n: 5, g: function*() { const f = () => (this as any).n * 3; yield f(); } };
        return o.g().next().value as number;
      }
    `;
    const { value } = await runStandalone(src);
    expect(value).toBe(15);
  });

  it("A2 — a generator-valued param default binds in a zero-suspend method lane", async () => {
    // `*method([gen = function*(){}])` — the `gen-meth-*-init-fn-name-gen`
    // family. The default is produced by the factory's call-time destructure
    // and read back in the resume function that runs immediately after, so it
    // never crosses a suspension. Pre-#6651 this bailed to the host path and
    // leaked `__gen_*` into a standalone binary.
    const src = `
      export function test(): number {
        let n = 0;
        const C: any = class { *method([gen = function*() {}]: any[]) {
          if ((gen as any).name === "gen") n = n + 1;
          if (typeof gen === "function") n = n + 10;
        } };
        new C().method([]).next();
        return n;
      }
    `;
    const { value, genImports } = await runStandalone(src);
    expect(genImports).toEqual([]);
    expect(value).toBe(11);
  });

  it("A2 — a YIELDING method keeps the host path (the default would cross a suspension)", async () => {
    // The zero-suspend precondition is load-bearing, not incidental: with a
    // `yield` in the body the binding must survive the suspension, which is
    // the #3952 cross-suspend shape this deliberately does NOT admit. In
    // standalone that surfaces as a `__gen_*` host-import requirement — which
    // the test262 standalone lane scores as a compile_error rather than as a
    // silently wrong value. (`compile()` itself succeeds; the refusal lives in
    // the runner's host-import check, so assert on the import list.)
    const src = `
      export function test(): number {
        let n = 0;
        const C: any = class { *method([gen = function*() {}]: any[]) { yield 1; n = (gen as any).name === "gen" ? 1 : 0; } };
        const it = new C().method([]); it.next(); it.next();
        return n;
      }
    `;
    const { genImports } = await runStandalone(src);
    expect(genImports.length).toBeGreaterThan(0);
  });

  it("two receivers get two independent frames", async () => {
    const src = `
      export function test(): number {
        const g: any = function*() { yield (this as any).n; };
        const a: any = { n: 3, g: g };
        const b: any = { n: 40, g: g };
        const ia = a.g();
        const ib = b.g();
        return (ib.next().value as number) + (ia.next().value as number);
      }
    `;
    const { value } = await runStandalone(src);
    expect(value).toBe(43);
  });
});
