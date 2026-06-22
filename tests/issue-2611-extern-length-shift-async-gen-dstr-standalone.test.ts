// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2611 (slice of umbrella #2158, Family F — invalid-Wasm-binary, the "deeper
// shift orphan" predicted by Slice F-1) — `--target standalone` emitted invalid
// Wasm for an async-generator (or generator) class method whose parameter binds
// a destructuring pattern with a default value, once the module is large enough
// to trigger a body-time late import. The validator rejected the module with
// "local index out of range — N at function '__extern_length'" (the #2043
// late-import index-shift class).
//
// Root cause (NOT a funcIdx-of-a-call shift, despite the #2043 diagnostic): a
// name↔body desync. `tryEmitInlineDynamicCall` (calls.ts) adds the
// `__get_undefined` late import for the arity-pad path via `ensureLateImport`,
// which DEFERS the index shift (records `ctx.pendingLateImportShift`) — but,
// unlike every sibling late-import call site, it never flushed. The pending
// shift then leaked past further function registrations: `__module_init`'s
// `startFuncIdx` and the funcMap entries of functions registered AFTER the
// import were computed at post-import indices (already correct), while the
// native runtime helpers registered BEFORE the import (`__extern_length` /
// `__extern_get_idx` / …) stayed stale-low by the unflushed `added`. At
// finalize, `fillExternGetIdxVecArms` resolved
// `mod.functions[funcMap.get("__extern_get_idx") - numImportFuncs]` to the WRONG
// slot — `__extern_length` (registered one slot earlier) — and spliced
// `__extern_get_idx`'s vec arms (which use local index 4 + `array.get`) into
// `__extern_length`'s body (only locals 0–3), so the validator rejected
// `__extern_length` with "local index out of range — 4".
//
// Fix: flush the deferred shift immediately after the `__get_undefined` add in
// `tryEmitInlineDynamicCall`, before any further function is registered —
// repairing only the genuinely-stale pre-import indices and keeping the index
// space self-consistent through finalize (mirrors `emitUndefined`, which already
// flushes after the same add). Flushing the half-applied shift late instead
// would re-bump the already-correct `startFuncIdx` ("invalid start function").
//
// Spec references:
// - ECMA-262 §15.5 GeneratorFunction / §27.6 AsyncGenerator definitions
// - ECMA-262 §10.2.11 FunctionDeclarationInstantiation (default-param firing)
// - ECMA-262 §8.6.2 BindingInitialization / §13.3.3 destructuring
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { instantiateWithRuntime } from "./equivalence/helpers.js";

/**
 * The slice's core assertion: shapes that previously emitted invalid Wasm now
 * produce a VALID module under `--target standalone`. `WebAssembly.compile`
 * validates the binary, isolating the index-shift fix — a regression of the
 * orphan re-introduces a `CompileError` ("local index out of range" /
 * "invalid start function").
 *
 * To reach the bug the module must be large enough that a body-time late import
 * is added AFTER the native runtime helpers are registered. A standalone module
 * that touches an arity-padded dynamic call (the `__get_undefined` trigger) in
 * the same compile as the async-generator class-method destructuring-param
 * default reproduces it without the full test262 harness preamble.
 */
async function expectValidatesStandalone(src: string): Promise<void> {
  const r = await compile(src, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  // Throws CompileError if the binary is invalid Wasm (the bug).
  await WebAssembly.compile(r.binary);
}

/** Host-mode runtime correctness — the env runtime drives the async generator. */
async function runHost(src: string): Promise<unknown> {
  const r = await compile(src);
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const inst = await instantiateWithRuntime(r);
  return (inst.exports as { test: () => unknown }).test();
}

describe("#2611 async-gen/gen class-method dstr-param default emits valid standalone Wasm", () => {
  it("standalone validates: async-generator method, defaulted array dstr param", async () => {
    await expectValidatesStandalone(
      `class C {
         async *m([a, b] = [3, 4]) { yield a; yield b; }
       }
       export function test(): number {
         const c = new C();
         return 0;
       }`,
    );
  });

  it("standalone validates: static async-generator method, defaulted object dstr param", async () => {
    await expectValidatesStandalone(
      `class C {
         static async *m({ x, y } = { x: 1, y: 2 }) { yield x; yield y; }
       }
       export function test(): number { return 0; }`,
    );
  });

  it("standalone validates: plain generator method, defaulted nested dstr param", async () => {
    await expectValidatesStandalone(
      `class C {
         *m({ w: [p, q] } = { w: [5, 6] }) { yield p; yield q; }
       }
       export function test(): number { return 0; }`,
    );
  });

  it("standalone validates: async-generator method + array-rest defaulted param", async () => {
    await expectValidatesStandalone(
      `class C {
         async *m([head, ...rest] = [1, 2, 3]) { yield head; }
       }
       export function test(): number { return 0; }`,
    );
  });

  // Regression guard for the `startFuncIdx` over-shift that a late (finalize)
  // flush of the half-applied pending shift would re-introduce: the module init
  // (`(start)` section) must still point at `__module_init` (a `[] -> []` func).
  // An over-shift surfaces as "invalid start function: non-zero parameter or
  // return count". Top-level code forces a real `__module_init`.
  it("standalone validates: async-gen dstr-default method + top-level init code", async () => {
    await expectValidatesStandalone(
      `class C {
         async *m([a, b] = [3, 4]) { yield a; yield b; }
       }
       let sentinel: number = 0;
       sentinel = sentinel + 1;
       export function test(): number { return sentinel; }`,
    );
  });

  // Host-mode runtime correctness: the destructuring-param-default semantics
  // must be unchanged by the index-shift fix.
  it("host runtime: async-gen method default fires when arg omitted → 3,4", async () => {
    expect(
      await runHost(
        `class C { async *m([a, b] = [3, 4]) { yield a; yield b; } }
         export async function test(): Promise<number> {
           const g = new C().m();
           const r1 = await g.next();
           const r2 = await g.next();
           return (r1.value as number) * 10 + (r2.value as number);
         }`,
      ),
    ).toBe(34);
  });

  it("host runtime: async-gen method explicit arg overrides default → 7,8", async () => {
    expect(
      await runHost(
        `class C { async *m([a, b] = [3, 4]) { yield a; yield b; } }
         export async function test(): Promise<number> {
           const g = new C().m([7, 8]);
           const r1 = await g.next();
           const r2 = await g.next();
           return (r1.value as number) * 10 + (r2.value as number);
         }`,
      ),
    ).toBe(78);
  });
});
