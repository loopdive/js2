/**
 * #3952 — closure-valued binding-element defaults in a generator's parameter
 * pattern (`*m({ f = () => 41 } = {})`) no longer bail the native plan.
 *
 * #3386 bailed arrow / function-expression / class-expression element defaults
 * and set the bar for lifting it: "once the closure-valued spill round-trip is
 * proven in all lanes". Every admitting test below meets that bar the strong
 * way — it spills the closure, **suspends**, resumes, and **calls** it. Import
 * freedom plus a plain value read would pass a module that stored a broken
 * reference it never invoked, which is precisely the failure the round-trip
 * claim is about.
 *
 * Kill-switch (2026-08-01): restore the un-narrowed #3386 predicate and every
 * admitting test fails with `WebAssembly.instantiate(): Import #0 "env": module
 * is not an object or function`.
 *
 * The still-bailing tests are equally load-bearing: they pin shapes measured to
 * be BROKEN when admitted, so a future widening has to face them rather than
 * silently trade a loud leak for a runtime trap.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.ts";

type Compiled = { success: boolean; binary: Uint8Array; errors?: unknown; imports?: { name: string }[] };

async function compileStandalone(src: string): Promise<Compiled> {
  const r = (await compile(src, { fileName: "t.ts", target: "standalone" })) as unknown as Compiled;
  expect(r.success, `compile failed: ${JSON.stringify(r.errors).slice(0, 300)}`).toBe(true);
  return r;
}

/** Instantiating with NO import object is itself the leak assertion. */
async function runStandalone(src: string): Promise<unknown> {
  const r = await compileStandalone(src);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test?: () => unknown }).test?.();
}

async function importCount(src: string): Promise<number> {
  return ((await compileStandalone(src)).imports ?? []).length;
}

/** yield once (suspend), then on RESUME call the defaulted closure and yield its result. */
const callAfterSuspend = (decl: string, call: string): string => `${decl}
export function test(): number {
  const it = ${call};
  it.next();
  return (it.next().value as number);
}`;

describe("#3952 closure-valued element defaults round-trip the generator spill", () => {
  it("object-literal method · arrow default is callable after a suspension", async () => {
    const src = callAfterSuspend(
      `const o = { *m({ f = () => 41 }: { f?: () => number } = {}) { yield 0; yield f() + 1; } };`,
      `o.m()`,
    );
    expect(await importCount(src)).toBe(0);
    expect(await runStandalone(src)).toBe(42);
  });

  it("object-literal method · function-expression default is callable after a suspension", async () => {
    const src = callAfterSuspend(
      `const o = { *m({ f = function () { return 41; } }: { f?: () => number } = {}) { yield 0; yield f() + 1; } };`,
      `o.m()`,
    );
    expect(await importCount(src)).toBe(0);
    expect(await runStandalone(src)).toBe(42);
  });

  it("class method · arrow default is callable after a suspension", async () => {
    const src = callAfterSuspend(
      `class C { *m({ f = () => 41 }: { f?: () => number } = {}) { yield 0; yield f() + 1; } }`,
      `new C().m()`,
    );
    expect(await importCount(src)).toBe(0);
    expect(await runStandalone(src)).toBe(42);
  });

  it("class method · function-expression default is callable after a suspension", async () => {
    const src = callAfterSuspend(
      `class C { *m({ f = function () { return 41; } }: { f?: () => number } = {}) { yield 0; yield f() + 1; } }`,
      `new C().m()`,
    );
    expect(await importCount(src)).toBe(0);
    expect(await runStandalone(src)).toBe(42);
  });

  it("ARRAY pattern · arrow default is callable after a suspension", async () => {
    const src = callAfterSuspend(
      `const o = { *m([f = () => 41]: (() => number)[] = []) { yield 0; yield f() + 1; } };`,
      `o.m()`,
    );
    expect(await importCount(src)).toBe(0);
    expect(await runStandalone(src)).toBe(42);
  });

  it("a SUPPLIED closure beats the default", async () => {
    const src = callAfterSuspend(
      `const o = { *m({ f = () => 41 }: { f?: () => number } = {}) { yield 0; yield f() + 1; } };`,
      `o.m({ f: () => 6 })`,
    );
    expect(await runStandalone(src)).toBe(7);
  });

  it("NamedEvaluation still names the defaulted closure after a suspension", async () => {
    // The actual test262 predicate of the `*-init-fn-name-arrow` templates:
    // `assert.sameValue(arrow.name, 'arrow')`. `"arrow".length === 5`.
    const src = `const o = { *m({ arrow = () => {} }: { arrow?: () => void } = {}) { yield 0; yield arrow.name.length; } };
      export function test(): number { const it = o.m(); it.next(); return (it.next().value as number); }`;
    expect(await importCount(src)).toBe(0);
    expect(await runStandalone(src)).toBe(5);
  });
});

describe("#3952 shapes measured BROKEN when admitted — the bail is kept deliberately", () => {
  // Each of these was admitted in the experiment and then failed at RUNTIME.
  // Pinning them means a future widening must re-measure rather than assume.

  it("GENERATOR function-expression default keeps the host path (objlit lane traps)", async () => {
    const src = callAfterSuspend(
      `const o = { *m([g = function* () { yield 41; }]: (() => Generator<number>)[] = []) { yield 0; yield (g().next().value as number) + 1; } };`,
      `o.m()`,
    );
    expect(await importCount(src)).toBeGreaterThan(0);
  });

  it("CLASS-expression default keeps the host path (null deref in BOTH lanes)", async () => {
    const src = callAfterSuspend(
      `const o = { *m({ K = class { v(): number { return 41; } } }: { K?: new () => { v(): number } } = {}) { yield 0; yield new K().v() + 1; } };`,
      `o.m()`,
    );
    expect(await importCount(src)).toBeGreaterThan(0);
  });

  it("generator FUNCTION-EXPRESSION host keeps the host path for closure defaults", async () => {
    // Control that justifies this one: the same lane already traps on an element
    // default with a plain NUMERIC value, so its defect is closure-INDEPENDENT
    // and pre-existing. Admitting here would swap a loud leak for a runtime trap.
    const src = callAfterSuspend(
      `const g = function* ({ f = () => 41 }: { f?: () => number } = {}) { yield 0; yield f() + 1; };`,
      `g()`,
    );
    expect(await importCount(src)).toBeGreaterThan(0);
  });
});

describe("#3952 regression guards — unchanged shapes", () => {
  it("numeric element default stays native", async () => {
    const src = callAfterSuspend(
      `const o = { *m({ n = 41 }: { n?: number } = {}) { yield 0; yield n + 1; } };`,
      `o.m()`,
    );
    expect(await importCount(src)).toBe(0);
    expect(await runStandalone(src)).toBe(42);
  });

  it("call-expression element default stays native", async () => {
    const src = callAfterSuspend(
      `function mk(): number { return 41; }
       const o = { *m({ n = mk() }: { n?: number } = {}) { yield 0; yield n + 1; } };`,
      `o.m()`,
    );
    expect(await importCount(src)).toBe(0);
    expect(await runStandalone(src)).toBe(42);
  });
});
