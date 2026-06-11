// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Serializer-time index guard (late-import index-shift safety net, #2043).
 *
 * The recurring late-registration index-shift class
 * (#1809/#1839/#1602/#1886/#1666/#1677/#2029) produces an index that is either
 * out of range (a failed map lookup baked as `-1`) or stale-low (captured
 * before a deferred shift). Both used to surface only as an opaque
 * `u32 out of range: -1` at the raw encoder, or as a silently
 * valid-but-wrong index that wasmtime later rejected with
 * "expected externref, found i32" on a random test262 shard.
 *
 * `validateModuleIndices` is ALWAYS-ON since #2043 (escape hatch:
 * JS2WASM_SKIP_INDEX_VALIDATION=1) and turns that whole class into a named,
 * pinpointed codegen error at emit time. These tests pin:
 *   1. a valid module emits unchanged (validation is read-only);
 *   2. an out-of-range / negative funcIdx throws a named error by default;
 *   3. the escape hatch restores the raw (unvalidated) encoder behaviour.
 */
import { afterEach, describe, expect, it } from "vitest";
import { emitBinary } from "../src/emit/binary.js";
import type { Instr, WasmFunction, WasmModule } from "../src/ir/types.js";

/** Minimal valid WasmModule with one exported `() -> i32` function returning 0. */
function minimalModule(bodyOverride?: Instr[]): WasmModule {
  const fn: WasmFunction = {
    name: "main",
    typeIdx: 0,
    locals: [],
    body: bodyOverride ?? [{ op: "i32.const", value: 0 } as Instr],
    exported: true,
  };
  return {
    types: [{ kind: "func", name: "type0", params: [], results: [{ kind: "i32" }] }],
    imports: [],
    functions: [fn],
    exports: [{ name: "main", desc: { kind: "func", index: 0 } }],
    tables: [],
    elements: [],
    globals: [],
    tags: [],
    stringPool: [],
    externClasses: [],
    nodeBuiltinModules: new Set(),
    stringLiteralValues: new Map(),
    asyncFunctions: new Set(),
    declaredFuncRefs: [],
    memories: [],
    dataSegments: [],
  } as unknown as WasmModule;
}

describe("serializer index guard (always-on, #2043)", () => {
  afterEach(() => {
    process.env.JS2WASM_SKIP_INDEX_VALIDATION = "";
  });

  it("is a no-op on a valid module", () => {
    expect(() => emitBinary(minimalModule())).not.toThrow();
  });

  it("accepts an in-range self-call — funcIdx 0 in [0, 1)", () => {
    const mod = minimalModule([
      { op: "call", funcIdx: 0 } as Instr,
      { op: "drop" } as Instr,
      { op: "i32.const", value: 0 } as Instr,
    ]);
    expect(() => emitBinary(mod)).not.toThrow();
  });

  it("throws a NAMED error on a -1 funcIdx (failed funcMap lookup) by default", () => {
    const mod = minimalModule([{ op: "call", funcIdx: -1 } as Instr, { op: "i32.const", value: 0 } as Instr]);
    expect(() => emitBinary(mod)).toThrow(/function index out of range.*-1.*function 'main'/s);
  });

  it("throws a NAMED error on an out-of-range funcIdx (stale-high)", () => {
    // Only func 0 exists (max = 1); call 5 is past the end — the stale-index case.
    const mod = minimalModule([{ op: "call", funcIdx: 5 } as Instr, { op: "i32.const", value: 0 } as Instr]);
    expect(() => emitBinary(mod)).toThrow(/function index out of range/);
  });

  it("JS2WASM_SKIP_INDEX_VALIDATION=1 bypasses the guard (raw encoder error instead)", () => {
    process.env.JS2WASM_SKIP_INDEX_VALIDATION = "1";
    const mod = minimalModule([{ op: "call", funcIdx: -1 } as Instr, { op: "i32.const", value: 0 } as Instr]);
    let msg = "";
    try {
      emitBinary(mod);
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e);
    }
    expect(msg).toMatch(/u32 out of range/);
    expect(msg).not.toMatch(/function index out of range/);
  });

  it("emitted bytes are identical with and without validation (read-only proof)", () => {
    const withValidation = emitBinary(minimalModule());
    process.env.JS2WASM_SKIP_INDEX_VALIDATION = "1";
    const without = emitBinary(minimalModule());
    expect(Buffer.from(withValidation).equals(Buffer.from(without))).toBe(true);
  });
});
