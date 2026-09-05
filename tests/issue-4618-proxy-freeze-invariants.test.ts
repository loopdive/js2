// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #4618: `Object.freeze()` on a wasm object handed to the host tripped two
// proxy invariants in `_wrapForHost`:
//  1. freeze calls [[PreventExtensions]]; the handler had no trap, so the
//     EMPTY proxy target got locked while `ownKeys` still reported the wasm
//     object's keys — "'ownKeys' on proxy: trap returned extra keys but proxy
//     target is non-extensible" (§10.5.11). The trap now materializes every
//     key onto the target first.
//  2. after the lock, `getOwnPropertyDescriptor` re-derived descriptors that
//     could disagree with the target's now-authoritative ones (§10.5.5); the
//     trap now serves the target's descriptors verbatim once non-extensible.
// react upstream (dev builds freeze every element): 85 → 87/146.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { wrapExports } from "../src/runtime.js";

async function run(source: string) {
  const result = await compile(source, {
    testRuntime: true,
    fileName: "issue-4618-proxy-freeze.ts",
    skipSemanticDiagnostics: true,
  });
  expect(result.success).toBe(true);
  const importObject = (result as { importObject?: WebAssembly.Imports }).importObject ?? {};
  const { instance } = await WebAssembly.instantiate(result.binary!, importObject);
  (importObject as { __setInstance?: (i: WebAssembly.Instance) => void }).__setInstance?.(instance);
  return wrapExports(instance, {
    signatures: (result as { exportSignatures?: unknown }).exportSignatures,
  }) as Record<string, (...args: unknown[]) => unknown>;
}

describe("#4618 host Object.freeze() on a wasm-object proxy", () => {
  it("freeze + ownKeys + descriptors satisfy the proxy invariants", async () => {
    const exp = await run(`
      export function make(): any {
        const el: any = { type: "div", key: null, props: { children: "hi" } };
        return el;
      }`);
    const el = (exp.make as () => Record<string, unknown>)();
    // 1. freeze must not throw (PreventExtensions materializes keys first)
    expect(() => Object.freeze(el)).not.toThrow();
    // 2. ownKeys after the lock must not violate §10.5.11
    expect(Object.keys(el).sort()).toEqual(["key", "props", "type"]);
    // 3. descriptors must be consistent with the locked target (§10.5.5)
    const d = Object.getOwnPropertyDescriptor(el, "type");
    expect(d).toBeDefined();
    expect(d!.value).toBe("div");
    expect(d!.configurable).toBe(false);
    expect(Object.isFrozen(el)).toBe(true);
    // reads still work through the frozen proxy
    expect(el.type).toBe("div");
  });
});
