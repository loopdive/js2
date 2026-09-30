// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6768 lever 1 — the function reachability sweep stubs every defined function
// no root can reach, before the finalize passes walk the module.

import { afterEach, describe, expect, it, vi } from "vitest";
import { compile } from "../src/index.js";
import { createEmptyModule, type Instr, type WasmModule } from "../src/ir/types.js";
import {
  reachableFunctionPositions,
  stubUnreachableFunctions,
  stubsReachedAfterFinalize,
} from "../src/codegen/function-reachability-sweep.js";
import { eliminateDeadImports } from "../src/codegen/dead-elimination.js";
import { STABLE_FUNC_BASE } from "../src/wasm/physical/function-handles.js";

function fn(name: string, body: Instr[], exported = false) {
  return { name, typeIdx: 0, locals: [{ name: "t", type: { kind: "i32" as const } }], body, exported };
}

/** 1 import + 10 defined functions exercising every root, non-root and edge kind. */
function fixture(): WasmModule {
  const mod = createEmptyModule();
  mod.types.push({ kind: "func", params: [], results: [] });
  mod.imports.push({ module: "env", name: "imp", desc: { kind: "func", typeIdx: 0 } });
  const shared: Instr[] = [{ op: "call", funcIdx: 1 + 2 }]; // → f2 (live handle)
  mod.functions.push(
    fn("f0_export", [{ op: "block", blockType: { kind: "empty" }, body: [{ op: "call", funcIdx: 0 }] } as Instr]),
    fn("f1_dead_shares", shared),
    fn("f2_via_shared", []),
    fn("f3_live_shares", [{ op: "block", blockType: { kind: "empty" }, body: shared } as Instr]),
    fn("f4_stable_target", [{ op: "return_call", funcIdx: STABLE_FUNC_BASE + 1 }]),
    fn("f5_stable_callee", []),
    fn("f6_dead", [{ op: "call", funcIdx: 1 + 7 }]),
    fn("__box_number", []),
    fn("f8_declared_ref_only", []),
    fn("f9_exported_flag_only", [], true),
  );
  // f5 is reachable only through its stable ordinal 1.
  mod.funcOrdinalToPosition = [0, 5];
  mod.exports.push({ name: "main", desc: { kind: "func", index: 1 + 0 } });
  mod.elements.push({ tableIdx: 0, offset: [{ op: "i32.const", value: 0 }], funcIndices: [1 + 3] });
  // f4 is reachable only through a global initializer's ref.func.
  mod.globals.push({
    name: "g",
    type: { kind: "funcref" },
    mutable: false,
    init: [{ op: "ref.func", funcIdx: 1 + 4 }],
  });
  // Neither a declarative segment entry nor the `exported` flag is callable.
  mod.declaredFuncRefs.push(1 + 8);
  return mod;
}

describe("#6768 function reachability sweep", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("follows exports, elements, global inits, stable handles, shared arrays and late-pass helper roots", () => {
    const live = [...reachableFunctionPositions(fixture())];
    //            f0 f1 f2 f3 f4 f5 f6 box f8 f9
    expect(live).toEqual([1, 0, 1, 1, 1, 1, 0, 1, 0, 0]);
  });

  it("stubs dead bodies with fresh arrays, leaving shared arrays intact for live owners", () => {
    const mod = fixture();
    const sharedBefore = mod.functions[1]!.body;
    const count = stubUnreachableFunctions(mod, reachableFunctionPositions(mod));
    expect(count).toBe(4);
    expect(mod.functions[1]!.body).toEqual([{ op: "unreachable" }]);
    expect(mod.functions[1]!.locals).toEqual([]);
    expect(mod.functions[6]!.body).toEqual([{ op: "unreachable" }]);
    expect(sharedBefore).toEqual([{ op: "call", funcIdx: 3 }]);
    expect(mod.functions).toHaveLength(10); // stubbed, never removed
    expect(stubsReachedAfterFinalize(mod)).toEqual([]);
    // A late reference to a stub is what the verifier exists to catch.
    mod.functions[0]!.body.push({ op: "call", funcIdx: 1 + 6 });
    expect(stubsReachedAfterFinalize(mod)).toEqual(["f6_dead"]);
  });

  it("keeps the import/type layout computed from the original bodies", () => {
    const withSweep = fixture();
    const without = fixture();
    // Make the dead f6 the ONLY user of a second import.
    for (const m of [withSweep, without]) {
      m.imports.push({ module: "env", name: "only_dead", desc: { kind: "func", typeIdx: 0 } });
      // Every defined handle shifts by one for the second import.
      for (const f of m.functions) {
        for (const i of f.body) if ("funcIdx" in i && i.funcIdx >= 1 && i.funcIdx < STABLE_FUNC_BASE) i.funcIdx += 1;
      }
      m.exports[0]!.desc.index += 1;
      m.elements[0]!.funcIndices = m.elements[0]!.funcIndices.map((i) => i + 1);
      m.declaredFuncRefs = m.declaredFuncRefs.map((i) => i + 1);
      m.functions[6]!.body = [{ op: "call", funcIdx: 1 }];
    }
    eliminateDeadImports(withSweep, undefined, { sweepUnreachableFunctions: true });
    eliminateDeadImports(without);
    expect(withSweep.imports.map((i) => i.name)).toEqual(without.imports.map((i) => i.name));
    expect(withSweep.types).toEqual(without.types);
    expect(withSweep.functions[6]!.body).toEqual([{ op: "unreachable" }]);
    expect(without.functions[6]!.body).toEqual([{ op: "call", funcIdx: 1 }]);
  });

  it("standalone compile: stubs part of the runtime floor, validates, runs, same verdict with the sweep off", async () => {
    const source = `
      export function run(n: number): number {
        const xs: number[] = [];
        for (let i = 0; i < n; i++) xs.push(i * 2);
        let s = "";
        for (const x of xs) s += String(x);
        return s.length + xs.length;
      }
    `;
    const build = async (sweep: "0" | "1") => {
      vi.stubEnv("JS2WASM_FUNC_SWEEP", sweep);
      vi.stubEnv("JS2WASM_FUNC_SWEEP_VERIFY", "1");
      const result = await compile(source, { target: "standalone", fileName: "t.ts" });
      expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
      expect(WebAssembly.validate(result.binary!)).toBe(true);
      const module = new WebAssembly.Module(result.binary!);
      const instance = new WebAssembly.Instance(module, {});
      (instance.exports.__module_init as (() => void) | undefined)?.();
      return { value: (instance.exports.run as (n: number) => number)(12), bytes: result.binary!.length, module };
    };
    const off = await build("0");
    const on = await build("1");
    expect(on.value).toBe(off.value);
    expect(on.value).toBe(19 + 12); // "0246810121416182022".length + 12
    expect(on.bytes).toBeLessThan(off.bytes);
    expect(WebAssembly.Module.exports(on.module)).toEqual(WebAssembly.Module.exports(off.module));
    expect(WebAssembly.Module.imports(on.module)).toEqual(WebAssembly.Module.imports(off.module));
  });
});
