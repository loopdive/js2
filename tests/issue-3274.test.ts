// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3274 (subtask of #3182, WAVE-B slice 1) — decomposition smoke test.
//
// `ensureObjectRuntime` in src/codegen/object-runtime.ts was ~7,378 LOC. This
// slice extracted its property-**descriptor + object-integrity** helper-build
// block (~2,464 LOC) VERBATIM into the sibling module
// src/codegen/object-runtime-descriptors.ts (`buildObjectDescriptorHelpers`),
// replacing the inline block with a single call that threads the captured
// `registerNative` minter + type indices + dep func indices + $flags/$Object
// bit constants through a state bundle. The relocation is byte-identical (proved
// via scripts/prove-emit-identity.mjs: IDENTICAL across all 39 gc/standalone/wasi
// emits), so this is armor + a reachability check for the extracted helpers, NOT
// a behavioural change.
//
// The cases below exercise the standalone-native descriptor helpers this slice
// now builds — `__defineProperty_value` (data descriptor store),
// `__defineProperty_accessor` (accessor get slot), and
// `__getOwnPropertyDescriptor` (descriptor read-back) — end to end with ZERO
// host imports, confirming the extracted `registerNative` sequence still
// produces the working native runtime.

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(body: string): Promise<{ result: number; envImports: string[] }> {
  const src = `export function test(): number { ${body} }`;
  const r = await compile(src, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const envImports = WebAssembly.Module.imports(new WebAssembly.Module(r.binary))
    .filter((i) => i.module === "env")
    .map((i) => i.name);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  const result = (instance.exports as { test(): number }).test();
  return { result, envImports };
}

describe("#3274 — object-runtime descriptor/integrity helpers survive extraction (standalone-native)", () => {
  it("__defineProperty_value: stores a data descriptor and reads it back", async () => {
    const { result, envImports } = await runStandalone(
      'var o: any = {}; Object.defineProperty(o, "x", { value: 42, writable: true, enumerable: true, configurable: true }); return o.x;',
    );
    expect(result).toBe(42);
    expect(envImports).toEqual([]); // pure native path — no host import leaked
  });

  it("__defineProperty_accessor: installs an accessor get slot", async () => {
    const { result, envImports } = await runStandalone(
      'var o: any = {}; Object.defineProperty(o, "y", { get: function() { return 7; } }); return o.y;',
    );
    expect(result).toBe(7);
    expect(envImports).toEqual([]);
  });

  it("__getOwnPropertyDescriptor: reports writable:false for a non-writable data prop", async () => {
    const { result, envImports } = await runStandalone(
      'var o: any = {}; Object.defineProperty(o, "x", { value: 5, writable: false, enumerable: true, configurable: true }); var d: any = Object.getOwnPropertyDescriptor(o, "x"); return d.writable ? 1 : 0;',
    );
    expect(result).toBe(0);
    expect(envImports).toEqual([]);
  });

  it("__getOwnPropertyDescriptor: reads back the descriptor value", async () => {
    const { result } = await runStandalone(
      'var o: any = {}; Object.defineProperty(o, "x", { value: 9, writable: true, enumerable: true, configurable: true }); var d: any = Object.getOwnPropertyDescriptor(o, "x"); return d.value;',
    );
    expect(result).toBe(9);
  });
});
