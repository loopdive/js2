// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2158 (slice — Family F, invalid-Wasm-binary) — a function/method parameter
// whose binding pattern carries a DEFAULT value (`= …`) and whose pattern binds
// a NESTED sub-pattern (an object property bound to an array sub-pattern, or a
// nested array) emitted invalid Wasm: the param-missing default guard `if`
// consumed an `externref` where an `i32` condition was expected
// (`if[0] expected type i32, found call of type externref`).
//
// Root cause: a funcIdx index-shift orphan. `destructureParamObject`'s externref
// struct-fast-path (destructuring-params.ts) detaches the OUTER function body to
// a then/else branch buffer via a plain JS-local swap (not `pushBody`), so the
// outer body is not on `fctx.savedBodies`. A late import added deep inside the
// recursive `destructureParamObjectExternref` / `destructureParamArray` calls
// for the nested sub-pattern (`__array_from_iter_n` / `__extern_get_idx` /
// `__extern_length`) triggered a `shiftLateImportIndices` walk that never
// reached the orphaned outer body — leaving the already-emitted
// `call __extern_is_undefined` (the param-default missing-arg guard, an i32
// producer) pointing one-or-more functions too low (e.g. at `__object_seal`,
// an externref producer). Tracking the outer body in `ctx.liveBodies` for the
// recursion window (mirroring the then/else #779d tracking) closes the orphan.
//
// Spec references:
// - ECMA-262 §10.2.11 FunctionDeclarationInstantiation (default-param firing)
// - ECMA-262 §8.6.2 BindingInitialization / §13.3.3 destructuring
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { instantiateWithRuntime } from "./equivalence/helpers.js";

/**
 * The slice's core assertion: the shapes that previously emitted invalid Wasm
 * now produce a VALID module. `WebAssembly.compile` validates the binary
 * without needing the (separate, still-open) standalone host-import fallback
 * for `__array_from_iter_n`, so it isolates the funcIdx-shift fix. A regression
 * of the orphan re-introduces a `CompileError` here.
 */
async function expectValidatesStandalone(src: string): Promise<void> {
  const r = await compile(src, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  // Throws CompileError if the binary is invalid Wasm (the bug).
  await WebAssembly.compile(r.binary);
}

/** Host-mode runtime correctness — the env runtime satisfies the destructuring. */
async function runHost(src: string): Promise<unknown> {
  const r = await compile(src);
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const inst = await instantiateWithRuntime(r);
  return (inst.exports as { test: () => unknown }).test();
}

describe("#2158 dstr-param default with nested sub-pattern emits valid Wasm", () => {
  it("standalone validates: { x: [y] } = { x: [42] } (object prop → array sub-pattern)", async () => {
    await expectValidatesStandalone(
      `function f({ x: [y] } = { x: [42] }) { return y; }
       export function test(): number { return f(); }`,
    );
  });

  it("standalone validates: class method, same shape", async () => {
    await expectValidatesStandalone(
      `class C { method({ x: [y] } = { x: [42] }) { return y; } }
       export function test(): number { return new C().method(); }`,
    );
  });

  it("standalone validates: 2-element nested array + default", async () => {
    await expectValidatesStandalone(
      `function f({ x: [a, b] } = { x: [1, 2] }) { return a + b; }
       export function test(): number { return f(); }`,
    );
  });

  it("standalone validates: nested array w/ its own default + outer default", async () => {
    await expectValidatesStandalone(
      `function f({ w: [a, b, c] = [4, 5, 6] } = { w: [7, 8, 9] }) { return a + b + c; }
       export function test(): number { return f(); }`,
    );
  });

  it("standalone validates: explicit arg still validates (default not fired)", async () => {
    await expectValidatesStandalone(
      `function f({ x: [y] } = { x: [42] }) { return y; }
       export function test(): number { return f({ x: [7] }); }`,
    );
  });

  // Host-mode runtime correctness: the same shapes must produce the right value
  // (the funcIdx fix must not have changed destructuring semantics).
  it("host runtime: default fires when arg omitted → 42", async () => {
    expect(
      await runHost(
        `function f({ x: [y] } = { x: [42] }) { return y; }
         export function test(): number { return f(); }`,
      ),
    ).toBe(42);
  });

  it("host runtime: explicit arg overrides default → 7", async () => {
    expect(
      await runHost(
        `function f({ x: [y] } = { x: [42] }) { return y; }
         export function test(): number { return f({ x: [7] }); }`,
      ),
    ).toBe(7);
  });

  it("host runtime: nested array default + outer default → 15", async () => {
    expect(
      await runHost(
        `function f({ w: [a, b, c] = [4, 5, 6] } = { w: [7, 8, 9] }) { return a + b + c; }
         export function test(): number { return f(); }`,
      ),
    ).toBe(24); // [7,8,9] → 24 (outer default fires; nested w present so inner default does not)
  });
});
