// #1042 — async/await CPS state-machine lowering.
//
// Two layers: the pure analysis surface (`analyzeAsyncBody`) that #1373b's IR
// path also consumes, and the Slice 2A end-to-end resolved-value tests that
// exercise the gated state machine (single tail-await canonical shapes).
import { describe, it, expect } from "vitest";
import * as ts from "typescript";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";
import { analyzeAsyncBody, ASYNC_CPS_ENABLED, type AsyncCpsPlan } from "../src/codegen/async-cps.js";
import type { CodegenContext } from "../src/codegen/context/types.js";

// analyzeAsyncBody ignores its ctx argument (pure analysis). A cast is safe.
const FAKE_CTX = {} as CodegenContext;

function analyze(src: string): AsyncCpsPlan {
  const sf = ts.createSourceFile("_wrap.ts", src, ts.ScriptTarget.Latest, true);
  // Find the first function-like declaration at top level.
  const fn = sf.statements.find(ts.isFunctionDeclaration);
  if (!fn) throw new Error("test setup: no function declaration");
  return analyzeAsyncBody(FAKE_CTX, fn);
}

describe("#1042 PR1 — async CPS analysis surface", () => {
  it("the gate is ON (#1796 — per-function asyncFnNeedsCps resolves the sync-consumption contract)", () => {
    expect(ASYNC_CPS_ENABLED).toBe(true);
  });

  it("no await ⇒ zero await points (function-body hook keeps legacy path)", () => {
    const plan = analyze(`async function f(a: number) { return a + 1; }`);
    expect(plan.awaitPoints).toHaveLength(0);
    expect(plan.hasTryAcrossAwait).toBe(false);
  });

  it("single await ⇒ one await point", () => {
    const plan = analyze(`async function f(b: number) { const y = await foo(b); return y; }`);
    expect(plan.awaitPoints).toHaveLength(1);
  });

  it("multiple awaits ⇒ counted in pre-order", () => {
    const plan = analyze(`
      async function f() {
        const a = await one();
        const b = await two();
        const c = await three();
        return a + b + c;
      }
    `);
    expect(plan.awaitPoints).toHaveLength(3);
  });

  it("nested await ⇒ both outer and inner counted", () => {
    const plan = analyze(`async function f() { return await (await x()); }`);
    expect(plan.awaitPoints).toHaveLength(2);
  });

  it("awaits inside a nested async arrow are NOT counted (own state machine)", () => {
    const plan = analyze(`
      async function f() {
        const g = async () => { await inner(); };
        await outer();
        return g;
      }
    `);
    // Only the f-level `await outer()` — the arrow's `await inner()` belongs to
    // the arrow's own (separate) state machine.
    expect(plan.awaitPoints).toHaveLength(1);
  });

  it("live-after-await captures a local used after the await", () => {
    const plan = analyze(`
      async function f(a: number) {
        const x = a + 1;
        const y = await foo();
        return x + y;
      }
    `);
    expect(plan.awaitPoints).toHaveLength(1);
    const live = plan.liveAfterAwait.get(plan.awaitPoints[0]!)!;
    // `x` is declared before the await and read after ⇒ must be captured.
    expect(live.has("x")).toBe(true);
  });

  it("live-after-await excludes a local NOT used after the await", () => {
    const plan = analyze(`
      async function f(a: number) {
        const x = a + 1;
        sideEffect(x);
        const y = await foo();
        return y;
      }
    `);
    const live = plan.liveAfterAwait.get(plan.awaitPoints[0]!)!;
    // `x` is consumed entirely before the await ⇒ not live afterward.
    expect(live.has("x")).toBe(false);
  });

  it("live-after-await excludes globals/imports (only own locals captured)", () => {
    const plan = analyze(`
      async function f() {
        const y = await foo();
        return Math.max(y, globalThing);
      }
    `);
    const live = plan.liveAfterAwait.get(plan.awaitPoints[0]!)!;
    expect(live.has("Math")).toBe(false);
    expect(live.has("globalThing")).toBe(false);
  });

  it("try/catch spanning an await is flagged", () => {
    const plan = analyze(`
      async function f() {
        try { const y = await foo(); return y; }
        catch (e) { return 0; }
      }
    `);
    expect(plan.hasTryAcrossAwait).toBe(true);
  });

  it("try/catch NOT spanning an await is not flagged", () => {
    const plan = analyze(`
      async function f() {
        const y = await foo();
        try { return y; } catch (e) { return 0; }
      }
    `);
    expect(plan.hasTryAcrossAwait).toBe(false);
  });

  it("uncaught throw is flagged; throw inside try is not", () => {
    expect(analyze(`async function f() { await x(); throw new Error("boom"); }`).hasUncaughtThrow).toBe(true);
    expect(
      analyze(`async function f() { try { throw new Error("x"); } catch (e) {} await y(); }`).hasUncaughtThrow,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Slice 2A — end-to-end resolved-value tests.
//
// These validate the state machine with ASYNC_CPS_ENABLED on (#1796): a JS-host
// async fn that genuinely suspends and matches one of the canonical
// single-tail-await shapes returns a real Promise that resolves to the right
// value through `Promise_resolve` → `Promise_then2` → continuation. The
// `skipIf` is retained as a guard so the block self-disables if the gate is
// ever turned back off; with the gate on (the shipped state since #1796) the
// block always runs.
//
// Awaited sources are INTERNAL compiled async functions and literals — these
// marshal a real number across the await boundary. (Host `declare function` /
// `declare class` method calls returning `number` do not marshal correctly
// independently of CPS — sync `getV(): number` already returns NaN on main —
// so they are deliberately not used as the awaited value here.)
// ---------------------------------------------------------------------------
describe.skipIf(!ASYNC_CPS_ENABLED)("#1042 Slice 2A — single-await CPS resolved values", () => {
  async function compileRun(src: string, fn: string, ...args: number[]): Promise<unknown> {
    const result = await compile(src);
    expect(
      result.success,
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`,
    ).toBe(true);
    const imports = buildImports(result.imports, {}, result.stringPool);
    const { instance } = await WebAssembly.instantiate(result.binary, imports as WebAssembly.Imports);
    const exports = instance.exports as Record<string, (...a: number[]) => unknown>;
    if (imports.setExports) imports.setExports(exports as Record<string, Function>);
    return await exports[fn]!(...args);
  }

  it("S1: `return await P` resolves to the awaited value (identity continuation)", async () => {
    const v = await compileRun(
      `async function inner(): Promise<number> { return 7; }
       export async function f(): Promise<number> { return await inner(); }`,
      "f",
    );
    expect(v).toBe(7);
  });

  it("S2: `const x = await P; return x + 1` binds the resolved value", async () => {
    const v = await compileRun(
      `async function inner(): Promise<number> { return 41; }
       export async function f(): Promise<number> { const x = await inner(); return x + 1; }`,
      "f",
    );
    expect(v).toBe(42);
  });

  it("S3: `await P; return N` runs the post-await suffix", async () => {
    const v = await compileRun(
      `async function inner(): Promise<number> { return 0; }
       export async function f(): Promise<number> { await inner(); return 7; }`,
      "f",
    );
    expect(v).toBe(7);
  });

  it("captures a prefix local across the await", async () => {
    const v = await compileRun(
      `async function inner(): Promise<number> { return 10; }
       export async function f(): Promise<number> { const a = 3; const x = await inner(); return a + x; }`,
      "f",
    );
    expect(v).toBe(13); // 3 + 10
  });

  it("captures a parameter + prefix local across the await", async () => {
    const v = await compileRun(
      `async function inner(): Promise<number> { return 1; }
       export async function f(base: number): Promise<number> { const c = base * 2; const x = await inner(); return c + x; }`,
      "f",
      50,
    );
    expect(v).toBe(101); // 50*2 + 1
  });

  it("await of a literal resolves to the literal (PromiseResolve of a non-thenable)", async () => {
    const v = await compileRun(`export async function f(): Promise<number> { const x = await 41; return x + 1; }`, "f");
    expect(v).toBe(42);
  });

  it("an await-less async fn stays on the legacy path (gate predicate excludes it)", async () => {
    // No await ⇒ awaitPoints.length !== 1 ⇒ legacy synchronous codegen. Still
    // returns its number directly (not a Promise wrapper) under the legacy path.
    const v = await compileRun(`export async function g(): Promise<number> { return 42; }`, "g");
    expect(v).toBe(42);
  });

  it("a two-await async fn stays on the legacy path and still compiles + runs", async () => {
    // Two awaits ⇒ outside Slice 2A's single-tail-await scope ⇒ legacy path.
    const v = await compileRun(
      `async function a(): Promise<number> { return 10; }
       async function b(): Promise<number> { return 20; }
       export async function f(): Promise<number> { const x = await a(); const y = await b(); return x + y; }`,
      "f",
    );
    expect(v).toBe(30);
  });
});
