// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Tests for #1731 / #1734 — a method call on a closure-valued struct field
 * whose receiver is a CALL expression emitted a bare `struct.get` on the call
 * result without first bridging the call's wasm return type to the struct type.
 *
 * The acorn dogfood loop (#1710) surfaced this as a Wasm *validation* failure:
 *
 *   WebAssembly.compile(): Compiling function "__closure_11" failed:
 *     struct.get[0] expected type (ref null 45), found call of (ref null 94)
 *
 * Root cause: in `compileCallablePropertyCall` (src/codegen/expressions/
 * calls-closures.ts), `recv.method(args)` where `method` is a closure-valued
 * field compiled the receiver, then emitted `struct.get <structTypeIdx>`
 * directly. When the receiver is a call whose declared wasm return type is
 * `externref` (or a different/wider struct ref than the resolved field-owner
 * struct), the bare `struct.get` operand is ill-typed and the binary fails
 * `WebAssembly.compile()`. The fix routes the receiver through
 * `any.convert_extern` (when externref) + a `ref.test`-guarded cast to the
 * struct type before the `struct.get`, mirroring the guarded cast already used
 * for the closure field itself — but only when the receiver's compiled type
 * isn't already exactly that struct (so the common case keeps a bare
 * `struct.get` with zero overhead).
 *
 * These cases assert the emitted binary VALIDATES and runs; the full acorn
 * surface is guarded by the opt-in `DOGFOOD_ACORN=1` harness (#1710).
 */
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

async function runExport(source: string, name: string): Promise<unknown> {
  const r = await compile(source, { fileName: "test.ts" });
  if (!r.success) {
    throw new Error(`compile failed: ${r.errors[0]?.message ?? "unknown"}`);
  }
  // Validation is the primary #1731 assertion — a wrong-typed struct.get fails
  // here before instantiation.
  await WebAssembly.compile(r.binary);
  // #1667: `result.importObject` is the ready-to-instantiate host runtime
  // (env + wasm:js-string + string_constants).
  const { instance } = await WebAssembly.instantiate(r.binary, r.importObject);
  const setExports = (r.importObject.env as Record<string, unknown>)?.__setExports as
    | ((e: Record<string, unknown>) => void)
    | undefined;
  if (setExports) setExports(instance.exports as Record<string, unknown>);
  return (instance.exports as Record<string, () => unknown>)[name]!();
}

describe("#1731 — method-closure field call off a call-expression receiver", () => {
  it("validates `factory().method(args)` where the field is a closure", async () => {
    const src = `
      function makeObj() {
        return {
          parse: (n: number) => n * 2,
          other: 1,
        };
      }
      export function test(): number {
        // Method call where the receiver is itself a call. The fixed codegen
        // bridges the call result to the object struct before struct.get.
        const a = () => makeObj().parse(21);
        const b = () => {
          const o = makeObj();
          return o.parse(10);
        };
        return a() + b();
      }
    `;
    const out = await runExport(src, "test");
    expect(out).toBe(62); // (21*2) + (10*2)
  });

  it("validates a captured-closure factory returning a method-bearing object", async () => {
    const src = `
      export function test(): number {
        const obj = { parse: (s: string) => s.length, pos: 0 };
        const get = () => obj;
        const useA = () => get().parse("ab");
        const useB = () => get().parse("cde");
        return useA() + useB();
      }
    `;
    const out = await runExport(src, "test");
    expect(out).toBe(5); // 2 + 3
  });

  it("keeps the direct (non-call) receiver path working", async () => {
    // Regression guard for the fast path: a plain identifier receiver must NOT
    // be routed through the guarded cast — it still emits a bare struct.get.
    const src = `
      export function test(): number {
        const obj = { run: (n: number) => n + 1, k: 0 };
        return obj.run(41);
      }
    `;
    const out = await runExport(src, "test");
    expect(out).toBe(42);
  });
});
