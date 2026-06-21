// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2203 — Standalone closure-capturing native generator emitted invalid funcidx.
 *
 * A nested `function*` that BOTH captures an outer-function variable AND yields,
 * compiled `--target standalone`, used to fail at binary-emit:
 *
 *     Codegen error: function index out of range — undefined at function 'g'
 *
 * Root cause (funcidx desync, #2043/#1461 class): the host-import predicate
 * `sourceNeedsGeneratorHostImports` decided whether to register the JS-host
 * generator buffer imports (`__gen_create_buffer`, `__create_generator`, …) in
 * standalone via `isNativeGeneratorCandidate`. That candidate check ignored
 * captures, so a capturing generator was deemed "native" and the host imports
 * were SKIPPED — yet the emission gate in `nested-declarations.ts` only takes
 * the native path when `captures.length === 0`, so the capturing generator
 * actually fell through to the host buffer path. That path bakes
 * `funcMap.get("__gen_create_buffer")!`, which resolved to `undefined` because
 * the import was never registered → the emitter raised the funcidx error.
 *
 * Fix: make `isNativeGeneratorCandidate` capture-aware
 * (`generatorCapturesEnclosingScope`). A generator that captures an
 * enclosing-function binding is non-native everywhere, so the import predicate
 * agrees with the emission gate and registers the host-fallback imports.
 *
 * NOTE: for-of / array-destructuring iteration over a *host-buffer* generator
 * in standalone is a SEPARATE, pre-existing gap — the standalone iterator
 * runtime (`ensureNativeIteratorRuntime` / `__array_from_iter_n`) only handles
 * the canonical `$Vec`, not a host JS Generator externref. It fails (NaN /
 * null-deref) even for a *no-capture native* generator on main, so it is out of
 * scope for this funcidx fix and tracked separately. Direct `.next()` driving
 * works and is covered here.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { instantiateWithRuntime } from "./equivalence/helpers.js";

async function compileStandalone(src: string) {
  return compile(src, { fileName: "test.ts", target: "standalone" });
}

async function runStandalone(src: string): Promise<number> {
  const r = await compileStandalone(src);
  expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
  const inst = await instantiateWithRuntime(r);
  return (inst.exports as { test(): number }).test();
}

describe("#2203 standalone closure-capturing native generator", () => {
  it("minimal capture × yield no longer emits an invalid funcidx", async () => {
    const r = await compileStandalone(
      `export function test(): number { let f = 0; function* g() { yield f; } return f; }`,
    );
    expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
  });

  it("the original repro returns the captured outer value", async () => {
    expect(
      await runStandalone(`export function test(): number { let f = 0; function* g() { yield f; } return f; }`),
    ).toBe(0);
  });

  it("drives a capturing generator via .next() reading the captured value", async () => {
    expect(
      await runStandalone(`export function test(): number {
        let f = 7;
        function* g() { yield f; yield f + 1; }
        const it = g();
        const a = it.next().value as number;
        const b = it.next().value as number;
        return a * 100 + b; }`),
    ).toBe(708);
  });

  it("mutates the captured value before stepping (boxed ref-cell capture)", async () => {
    expect(
      await runStandalone(`export function test(): number {
        let f = 1;
        function* g() { yield f; }
        f = 5;
        const it = g();
        return it.next().value as number; }`),
    ).toBe(5);
  });

  it("keeps a no-capture nested generator on the native path (still compiles)", async () => {
    const r = await compileStandalone(
      `export function test(): number { function* g() { yield 1; } const it = g(); return it.next().value as number; }`,
    );
    expect(r.success).toBe(true);
    // No-capture native generators emit ZERO host imports (the #2172 invariant).
    expect((r.imports ?? []).length).toBe(0);
  });

  it("registers host-fallback imports for the capturing generator", async () => {
    const r = await compileStandalone(
      `export function test(): number { let f = 2; function* g() { yield f; } const it = g(); return it.next().value as number; }`,
    );
    expect(r.success).toBe(true);
    const names = new Set((r.imports ?? []).map((i) => i.name));
    expect(names.has("__gen_create_buffer")).toBe(true);
    expect(names.has("__create_generator")).toBe(true);
  });
});
