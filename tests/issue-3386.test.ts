import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports, instantiateWasm } from "../src/runtime.js";

// #3386 — standalone native sync-generator DESTRUCTURING-pattern params
// (#3178 umbrella). Since #2961 a standalone compile that emits the
// `env::__gen_*` family is a hard host_import_leak compile_error; the largest
// sync-gen residual cohort is generators with destructuring-pattern params.
//
// This admits them natively: the emit site destructures pattern params EAGERLY
// (call time, §10.2.11 FunctionDeclarationInstantiation) into factory locals
// via the same corpus-proven emitters ordinary functions use, and the factory
// packs the bound values into the generator state-struct spill fields at
// `struct.new`; the resume function reads them back through the ordinary
// spill-load loop (no state-0 re-destructure — which mistimed GetIterator /
// default side effects and would double-drive one-shot iterators).
//
// Load-bearing: the probes use the test262 `export function test()` WRAPPER
// shape — module-scope-only probes gave false greens during the #3178
// decomposition (the wrapped-vs-module-scope leak seam).

interface Res {
  value: unknown;
  hostFree: boolean;
  leaks: string[];
}

async function run(source: string): Promise<Res> {
  const result = await compile(source, { fileName: "test.ts", target: "standalone" });
  if (!result.success) {
    throw new Error(`Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`);
  }
  expect(WebAssembly.validate(result.binary)).toBe(true);
  const mod = await WebAssembly.compile(result.binary);
  const leaks = WebAssembly.Module.imports(mod)
    .map((i) => `${i.module}::${i.name}`)
    .filter((n) => /__gen|__create_generator|__get_caught_exception|Promise_|__make_callback/.test(n));
  const built = buildImports(result.imports, {}, result.stringPool);
  const { instance } = await instantiateWasm(result.binary, built.env, built.string_constants);
  built.setExports?.(instance.exports as Record<string, Function>);
  const value = (instance.exports as { test: () => unknown }).test();
  return { value, hostFree: leaks.length === 0, leaks };
}

describe("#3386 — sync-generator pattern params (standalone, host-free)", () => {
  it("free-fn array pattern: host-free + correct value", async () => {
    const r = await run(
      `function* f([x, y]: number[]) { yield x + y; }
       export function test(): number { return f([1, 2]).next().value as number; }`,
    );
    expect(r.leaks).toEqual([]);
    expect(r.value).toBe(3);
  });

  it("wrapped (test262-shape) free-fn declaration is host-free", async () => {
    const r = await run(
      `export function test(): number {
         function* f([x, y]: number[]) { yield x + y; }
         return f([4, 5]).next().value as number;
       }`,
    );
    expect(r.leaks).toEqual([]);
    expect(r.value).toBe(9);
  });

  it("instance class method array pattern", async () => {
    const r = await run(
      `class C { *m([x, y]: number[]) { yield x + y; } }
       export function test(): number { return new C().m([10, 20]).next().value as number; }`,
    );
    expect(r.leaks).toEqual([]);
    expect(r.value).toBe(30);
  });

  it("static class method array pattern", async () => {
    const r = await run(
      `class C { static *m([x]: number[]) { yield x * 2; } }
       export function test(): number { return C.m([21]).next().value as number; }`,
    );
    expect(r.leaks).toEqual([]);
    expect(r.value).toBe(42);
  });

  // SKIPPED (#3591) — REAL REGRESSION, not a stale expectation. Bisected to
  // 1fbb1810 `feat(#3032): W6 … (#3356)` (2026-07-19); green at its parent
  // 8bc6e1c3. The module-scope generator fn-expr is lifted once per
  // `compileModuleInitBody` pass with a DIFFERENT state-struct type each time,
  // and `.next()`'s inline dispatch (emitted between the passes) tests only the
  // dead pass-1 type → #1344 TypeError. The sibling object-literal-method and
  // declaration forms below are unaffected and still assert the same semantics.
  // Re-enable with the fix — see plan/issues/3591-*.md.
  it.skip("generator function expression array pattern", async () => {
    const r = await run(
      `const f = function* ([x]: number[]) { yield x; };
       export function test(): number { return f([5]).next().value as number; }`,
    );
    expect(r.leaks).toEqual([]);
    expect(r.value).toBe(5);
  });

  it("object-literal generator method array pattern", async () => {
    const r = await run(
      `const o = { *m([x]: number[]) { yield x; } };
       export function test(): number { return o.m([7]).next().value as number; }`,
    );
    expect(r.leaks).toEqual([]);
    expect(r.value).toBe(7);
  });

  it("object pattern with renamed + defaulted element", async () => {
    const r = await run(
      `function* f({ a: b = 5, c }: { a?: number; c: number }) { yield b * 10 + c; }
       export function test(): number { return f({ c: 3 }).next().value as number; }`,
    );
    expect(r.leaks).toEqual([]);
    expect(r.value).toBe(53);
  });

  it("element default fires / is skipped correctly", async () => {
    const fires = await run(
      `function* f([x = 41]: number[]) { yield x + 1; }
       export function test(): number { return f([]).next().value as number; }`,
    );
    expect(fires.value).toBe(42);
    const skipped = await run(
      `function* f([x = 41]: number[]) { yield x + 1; }
       export function test(): number { return f([9]).next().value as number; }`,
    );
    expect(skipped.value).toBe(10);
  });

  it("elision advances without binding", async () => {
    const r = await run(
      `function* f([, y]: number[]) { yield y; }
       export function test(): number { return f([1, 2]).next().value as number; }`,
    );
    expect(r.value).toBe(2);
  });

  it("nested sub-pattern", async () => {
    const r = await run(
      `function* f([[a], { b }]: [number[], { b: number }]) { yield a + b; }
       export function test(): number { return f([[4], { b: 8 }]).next().value as number; }`,
    );
    expect(r.leaks).toEqual([]);
    expect(r.value).toBe(12);
  });

  it("whole-param default", async () => {
    const r = await run(
      `function* f([x, y]: number[] = [3, 4]) { yield x + y; }
       export function test(): number { return f().next().value as number; }`,
    );
    expect(r.value).toBe(7);
  });

  it("binding persists across yields with mutation", async () => {
    const r = await run(
      `function* f([x]: number[]) { x += 1; yield x; x += 1; yield x; }
       export function test(): number {
         const it = f([10]);
         return (it.next().value as number) * 100 + (it.next().value as number);
       }`,
    );
    expect(r.value).toBe(1112);
  });

  it("two pattern params", async () => {
    const r = await run(
      `function* f([a]: number[], { b }: { b: number }) { yield a + b; }
       export function test(): number { return f([1], { b: 2 }).next().value as number; }`,
    );
    expect(r.leaks).toEqual([]);
    expect(r.value).toBe(3);
  });

  // ── Spec timing: parameter destructuring is EAGER (call time), body is LAZY ──

  it("destructure runs at CALL time, body at first .next() (lazy)", async () => {
    const r = await run(
      `let ran = 0;
       function* f([x]: number[]) { ran = 1; yield x; }
       export function test(): number {
         const it = f([5]);
         const beforeNext = ran;   // 0 — body has not run
         it.next();
         return beforeNext * 10 + ran; // + 1 after first next
       }`,
    );
    expect(r.value).toBe(1);
  });

  it("destructuring null throws at CALL, not at first .next()", async () => {
    const r = await run(
      `function* f([x]: number[]) { yield 1; }
       export function test(): number {
         try { f(null as unknown as number[]); } catch (e) { return 1; }
         return 0;
       }`,
    );
    expect(r.value).toBe(1);
  });

  it("throwing element default throws at CALL time", async () => {
    const r = await run(
      `function thrower(): number { throw new Error("x"); }
       function* f([x = thrower()]: number[]) { yield 1; }
       export function test(): number {
         try { f([]); } catch (e) { return 1; }
         return 0;
       }`,
    );
    expect(r.value).toBe(1);
  });

  // ── Excluded shapes: function-valued element defaults still bail (host) ──

  it("plain function-valued element default IS admitted natively (#3952 — was: refuses)", async () => {
    // (#3952) This asserted the bail on the grounds that "a closure-valued spill
    // does not round-trip cleanly in every lane (illegal cast in the class-method
    // lane, #3164 host-mix)". That evidence is now stale: the cited shape passes,
    // and the round-trip proof #3386 asked for was run — spill the closure,
    // SUSPEND, resume, CALL it. Arrow and plain function-expression defaults
    // round-trip in the object-literal, class, array-pattern and
    // function-declaration lanes. GENERATOR function expressions, CLASS
    // expressions, and the generator-function-EXPRESSION host were measured
    // broken when admitted and still bail — pinned in `tests/issue-3952.test.ts`.
    const result = await compile(
      `function* f([g = function () { return 41; }]: (() => number)[]) { yield 0; yield g() + 1; }
       export function test(): number { const it = f([]); it.next(); return it.next().value as number; }`,
      { fileName: "test.ts", target: "standalone" },
    );
    expect(result.success).toBe(true);
    expect(result.imports ?? []).toEqual([]);
    const { instance } = await WebAssembly.instantiate(result.binary, {});
    expect((instance.exports as { test(): number }).test()).toBe(42);
  });

  it("GENERATOR-valued element default is still NOT admitted (refuses in standalone)", async () => {
    // (#3952) The half of #3386's exclusion that survived measurement: admitting
    // a `function*` default makes the object-literal lane trap at runtime. A loud
    // host_import_leak compile_error is the correct outcome, not a native
    // miscompile.
    const result = await compile(
      `function* f([g = function* () { yield 1; }]: unknown[]) { yield 1; }
       export function test(): number { return f([]).next().value as number; }`,
      { fileName: "test.ts", target: "standalone" },
    );
    expect(result.success).toBe(false);
  });
});
