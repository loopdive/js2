/**
 * #6651 cluster A, round 2 — two independent generator-lowering widenings,
 * both driven by a control that was RE-RUN rather than inherited.
 *
 * 1. Binding-element defaults. The admission condition for a closure- or
 *    class-valued element default (`*f({ cls = class {} })`) was spelled as
 *    LANE IDENTITY — `ts.isMethodDeclaration(decl)` plus a class/object-literal
 *    parent. The property that actually carries #4769's argument is "the value
 *    never crosses a suspension", which is a property of the BODY. A generator
 *    function DECLARATION and a generator function EXPRESSION reach the same
 *    factory/resume split, so the same argument applies to them verbatim.
 *
 * 2. `isFunctionLikeScope` did not name accessors, constructors or class static
 *    blocks, so a `return` inside one of them was attributed to the enclosing
 *    generator. That sent `function* g() { ({ get yield() { return 1 } }); }` —
 *    a statement with no yield and no generator-level return — into the
 *    structural state lowering, where it is unmodeled, and bailed the whole
 *    generator to the host path.
 *
 * Kill-switches. (1) Restore the `ts.isFunctionExpression(decl)` blanket arm or
 * the `isMethodDeclaration` conjunct and the admitting cases below fail with
 * `imports > 0`. (2) Drop the accessor from `isFunctionLikeScope` and the
 * `get yield()` case leaks the whole `env::__gen_*` family.
 *
 * The negative cases are as load-bearing as the positive ones: the
 * computed-property-name carve-out is what keeps the second widening from
 * trading a loud refusal for a silent wrong answer, which is exactly what it
 * did before that carve-out existed (measured: five
 * `accessor-name-*-computed-yield-expr` rows flipped compile_error →
 * `SameValue(«undefined», «"get yield"»)`).
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.ts";

type Compiled = { success: boolean; binary: Uint8Array; errors?: unknown; imports?: { name: string }[] };

async function compileStandalone(src: string): Promise<Compiled> {
  const r = (await compile(src, { fileName: "t.ts", target: "standalone" })) as unknown as Compiled;
  expect(r.success, `compile failed: ${JSON.stringify(r.errors).slice(0, 300)}`).toBe(true);
  return r;
}

async function importCount(src: string): Promise<number> {
  return ((await compileStandalone(src)).imports ?? []).length;
}

/** Instantiating with NO import object is itself the leak assertion. */
async function runStandalone(src: string): Promise<unknown> {
  const r = await compileStandalone(src);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test?: () => unknown }).test?.();
}

/** The error-severity diagnostics of a standalone compile (empty when it succeeds). */
async function standaloneErrors(src: string): Promise<string> {
  const r = (await compile(src, { fileName: "t.ts", target: "standalone" })) as unknown as {
    errors?: { severity: string; message: string }[];
  };
  return (r.errors ?? [])
    .filter((e) => e.severity === "error")
    .map((e) => e.message)
    .join("; ");
}

describe("#6651 A2 · element defaults are admitted by SUSPENSION, not by lane", () => {
  it("generator function DECLARATION · class-valued default, zero suspend", async () => {
    // The `statements/generators/dstr/*-init-fn-name-class` shape: the body
    // never yields, so the class never has to survive a spill round-trip.
    // The default is bound and observable, host-free. NamedEvaluation
    // (`cls.name === "cls"`, §13.15.2 / ES2015 §13.3.3.7 step 6.d) is the
    // predicate of the test262 rows this unblocks and it holds THERE — those
    // rows are untyped JS at module scope and pass on the isolated standalone
    // runner. It is deliberately NOT asserted here: reading `.name` off a
    // class-valued default through a TS annotation traps in the
    // ALREADY-ADMITTED object-literal lane too, so it is a pre-existing
    // TS-lane gap and not this widening's to prove. The control below pins
    // that, rather than leaving it as prose.
    const src = `let out = 0;
function* f({ cls = class {} }: { cls?: unknown }) { out = cls ? 7 : 0; }
export function test(): number { f({}).next(); return out; }`;
    expect(await importCount(src)).toBe(0);
    expect(await runStandalone(src)).toBe(7);
  });

  it("CONTROL · the TS `.name` read on a class default traps in the OLD lane too", async () => {
    // If this ever starts returning 3, the `.name` assertion above can be
    // tightened in both lanes at once — and this control is how you find out.
    const src = `let out = 0;
const o = { *m({ cls = class {} }: { cls?: { name: string } }) { out = (cls as { name: string }).name.length; } };
export function test(): number { o.m({}).next(); return out; }`;
    expect(await importCount(src)).toBe(0);
    await expect(runStandalone(src)).rejects.toThrow();
  });

  it("generator function DECLARATION · generator-valued default, zero suspend", async () => {
    const src = `let out = 0;
function* f({ g = function* () { yield 41; } }: { g?: () => Generator<number> }) { out = (g().next().value as number) + 1; }
export function test(): number { f({}).next(); return out; }`;
    expect(await importCount(src)).toBe(0);
    expect(await runStandalone(src)).toBe(42);
  });

  it("generator function EXPRESSION · arrow default, ACROSS a suspension", async () => {
    const src = `const g = function* ({ f = () => 41 }: { f?: () => number }) { yield 0; yield f() + 1; };
export function test(): number { const it = g({}); it.next(); return it.next().value as number; }`;
    expect(await importCount(src)).toBe(0);
    expect(await runStandalone(src)).toBe(42);
  });

  it("generator function EXPRESSION · array-pattern class default, zero suspend", async () => {
    const src = `let out = 0;
const g = function* ([cls = class {}]: unknown[]) { out = cls ? 7 : 0; };
export function test(): number { g([]).next(); return out; }`;
    expect(await importCount(src)).toBe(0);
    expect(await runStandalone(src)).toBe(7);
  });

  it("a SUPPLIED value still beats the default in the newly admitted lane", async () => {
    const src = `let out = 0;
function* f({ n = 41 }: { n?: number }, k: () => number) { out = n + k(); }
export function test(): number { f({ n: 1 }, () => 1); const it = f({ n: 1 }, () => 1); it.next(); return out; }`;
    expect(await runStandalone(src)).toBe(2);
  });

  it("NEGATIVE · a YIELDING body keeps the host path for a class-valued default", async () => {
    // `zeroSuspendDefaultLane` is what excludes this. It is the cell measured to
    // FAIL when admitted (#3952's own experiment), so the bail stays.
    const src = `const g = function* ({ K = class { v(): number { return 41; } } }: { K?: new () => { v(): number } }) { yield 0; yield new K().v() + 1; };
export function test(): number { const it = g({}); it.next(); return it.next().value as number; }`;
    expect(await importCount(src)).toBeGreaterThan(0);
  });
});

describe("#6651 A2 · an accessor body is a scope; its computed NAME is not", () => {
  it("`yield` as a literal property name no longer bails the generator", async () => {
    // test262 `yield-as-literal-property-name`: the getter's `return 1` belongs
    // to the getter, not to `g`.
    const src = `let out = 0;
function* g() { ({ get yield() { return 1; } }); out = 7; }
export function test(): number { g().next(); return out; }`;
    expect(await importCount(src)).toBe(0);
    expect(await runStandalone(src)).toBe(7);
  });

  it("a constructor's `return` inside a generator body is likewise not the generator's", async () => {
    const src = `let out = 0;
function* g() { class C { constructor() { return; } } out = new C() ? 7 : 0; }
export function test(): number { g().next(); return out; }`;
    expect(await importCount(src)).toBe(0);
    expect(await runStandalone(src)).toBe(7);
  });

  it("NEGATIVE · a computed accessor NAME containing `yield` still suspends, so it still bails", async () => {
    // The carve-out. Without it this compiles to a generator that never
    // suspends and answers the wrong value instead of refusing — the exact
    // trade the project treats as a regression.
    const src = `let out = 0;
function* g() { class C { get [yield 1]() { return 2; } } out = C ? 7 : 0; }
export function test(): number { g().next(); return out; }`;
    // The refusal is the #680 diagnostic — LOUD, which is the whole point.
    expect(await standaloneErrors(src)).toMatch(/sequential numeric yields/);
  });

  it("GUARD · a plain `return` still routes through the generator terminator", async () => {
    const src = `function* g() { if (true) { return 5; } return 9; }
export function test(): number { return g().next().value as number; }`;
    expect(await importCount(src)).toBe(0);
    expect(await runStandalone(src)).toBe(5);
  });
});
