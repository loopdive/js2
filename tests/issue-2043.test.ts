// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2043 — always-on total emit-time index validation.
 *
 * Pins that EVERY index space the encoder writes is range-checked, so the
 * late-import index-shift class (#1809/#1839/#1602/#1886/#1666/#1677/#2029)
 * surfaces as a named, located codegen error instead of the raw encoder's
 * `u32 out of range: -1` — or worse, a silently valid-but-wrong binary.
 *
 * #2029's diagnostic finding motivated the extension: the old funcref-only
 * walker did NOT fire on `class A extends Uint8Array {}` under standalone,
 * because the poison there is a `global.get -1`, not a funcIdx.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { emitBinary } from "../src/emit/binary.js";
import type { Instr, ValType, WasmFunction, WasmModule } from "../src/ir/types.js";

/**
 * Module shaped like real codegen output: one import func, one type each of
 * func/struct/array, a global, a tag, a table + element segment, two funcs.
 */
function testModule(mutate?: (mod: WasmModule) => void): WasmModule {
  const i32: ValType = { kind: "i32" };
  const main: WasmFunction = {
    name: "main",
    typeIdx: 0,
    locals: [{ name: "tmp", type: i32 }],
    body: [{ op: "i32.const", value: 0 } as Instr],
    exported: true,
  };
  const helper: WasmFunction = {
    name: "helper",
    typeIdx: 0,
    locals: [],
    body: [{ op: "i32.const", value: 1 } as Instr],
    exported: false,
  };
  const mod = {
    types: [
      { kind: "func", name: "t0", params: [], results: [i32] },
      { kind: "struct", name: "s0", fields: [{ name: "f0", type: i32, mutable: true }] },
      { kind: "array", name: "a0", element: i32, mutable: true },
    ],
    imports: [{ module: "env", name: "ext", desc: { kind: "func", typeIdx: 0 } }],
    functions: [main, helper],
    exports: [{ name: "main", desc: { kind: "func", index: 1 } }],
    tables: [{ elementType: "funcref", min: 1 }],
    elements: [{ tableIdx: 0, offset: [{ op: "i32.const", value: 0 } as Instr], funcIndices: [1] }],
    globals: [{ name: "g0", type: i32, mutable: true, init: [{ op: "i32.const", value: 0 } as Instr] }],
    tags: [{ name: "exc", typeIdx: 0 }],
    stringPool: [],
    externClasses: [],
    nodeBuiltinModules: new Set(),
    stringLiteralValues: new Map(),
    asyncFunctions: new Set(),
    declaredFuncRefs: [],
    memories: [],
    dataSegments: [],
  } as unknown as WasmModule;
  mutate?.(mod);
  return mod;
}

const body = (mod: WasmModule): Instr[] => mod.functions[0]!.body;

describe("#2043 validateModuleIndices covers every index space", () => {
  it("baseline module is valid", () => {
    expect(() => emitBinary(testModule())).not.toThrow();
  });

  it("global.get -1 (the #2029 poison shape) — named error with function location", () => {
    const mod = testModule((m) => {
      body(m).unshift({ op: "global.get", index: -1 } as Instr, { op: "drop" } as Instr);
    });
    expect(() => emitBinary(mod)).toThrow(/global index out of range.*-1.*function 'main'.*#2043/s);
  });

  it("global.get inside an if/else arm is walked (where #2029's poison hid)", () => {
    const mod = testModule((m) => {
      body(m).unshift(
        { op: "i32.const", value: 1 } as Instr,
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [],
          else: [{ op: "global.get", index: -1 }, { op: "drop" }],
        } as unknown as Instr,
      );
    });
    expect(() => emitBinary(mod)).toThrow(/global index out of range/);
  });

  it("undefined index (failed map lookup, the `u32 out of range: undefined` sub-bucket)", () => {
    const mod = testModule((m) => {
      body(m).unshift(
        { op: "global.get", index: undefined as unknown as number } as Instr,
        {
          op: "drop",
        } as Instr,
      );
    });
    expect(() => emitBinary(mod)).toThrow(/global index out of range.*undefined/s);
  });

  it("struct.new with stale type index", () => {
    const mod = testModule((m) => {
      body(m).unshift({ op: "struct.new", typeIdx: 99 } as Instr, { op: "drop" } as Instr);
    });
    expect(() => emitBinary(mod)).toThrow(/type index out of range.*99/s);
  });

  it("struct.get field index past the struct's fields", () => {
    const mod = testModule((m) => {
      body(m).unshift(
        { op: "ref.null", typeIdx: 1 } as Instr,
        { op: "struct.get", typeIdx: 1, fieldIdx: 7 } as Instr,
        { op: "drop" } as Instr,
      );
    });
    expect(() => emitBinary(mod)).toThrow(/struct field index out of range.*7/s);
  });

  it("ref.null heap type -1 (#1338 'Unknown heap type -1') — abstract codes stay legal", () => {
    const bad = testModule((m) => {
      body(m).unshift({ op: "ref.null", typeIdx: -1 } as Instr, { op: "drop" } as Instr);
    });
    expect(() => emitBinary(bad)).toThrow(/heap type index out of range.*-1/s);
    const eqHeap = testModule((m) => {
      // eq abstract heap type = -19: legal in a heap-type position.
      body(m).unshift({ op: "ref.null", typeIdx: -19 } as Instr, { op: "drop" } as Instr);
    });
    expect(() => emitBinary(eqHeap)).not.toThrow();
  });

  it("call_ref with out-of-range type index", () => {
    const mod = testModule((m) => {
      body(m).unshift(
        { op: "ref.null", typeIdx: 0 } as Instr,
        { op: "call_ref", typeIdx: 42 } as Instr,
        { op: "drop" } as Instr,
      );
    });
    expect(() => emitBinary(mod)).toThrow(/type index out of range.*42/s);
  });

  it("local.get past params+locals (stale local slot)", () => {
    const mod = testModule((m) => {
      // main has 0 params + 1 local → valid locals are [0, 1).
      body(m).unshift({ op: "local.get", index: 9 } as Instr, { op: "drop" } as Instr);
    });
    expect(() => emitBinary(mod)).toThrow(/local index out of range.*9/s);
  });

  it("throw with stale exception tag index", () => {
    const mod = testModule((m) => {
      body(m).unshift({ op: "throw", tagIdx: 5 } as Instr);
    });
    expect(() => emitBinary(mod)).toThrow(/exception tag index out of range.*5/s);
  });

  it("export pointing past the function space (stale export index)", () => {
    const mod = testModule((m) => {
      m.exports[0]!.desc.index = 12;
    });
    expect(() => emitBinary(mod)).toThrow(/function index out of range.*export 'main'/s);
  });

  it("element segment carrying a -1 funcIdx", () => {
    const mod = testModule((m) => {
      m.elements[0]!.funcIndices[0] = -1;
    });
    expect(() => emitBinary(mod)).toThrow(/function index out of range.*element-segment/s);
  });

  it("global initializer with stale global reference", () => {
    const mod = testModule((m) => {
      m.globals[0]!.init = [{ op: "global.get", index: 33 } as Instr];
    });
    expect(() => emitBinary(mod)).toThrow(/global index out of range.*global 'g0' init/s);
  });

  it("function whose signature typeIdx is stale", () => {
    const mod = testModule((m) => {
      m.functions[1]!.typeIdx = -1;
    });
    expect(() => emitBinary(mod)).toThrow(/type index out of range.*function 'helper' signature/s);
  });

  it("simulated stale captured index: a funcIdx captured before a +2 import shift", () => {
    // The canonical #2043 shape: codegen captured helper's index (2) into a JS
    // local, then two late imports were prepended WITHOUT the body being
    // shifted. The baked call now points where helper used to be… but here we
    // simulate the failed-lookup flavor that lands past the end instead.
    const mod = testModule((m) => {
      body(m).unshift({ op: "call", funcIdx: 2 } as Instr, { op: "drop" } as Instr);
      // Captured BEFORE the shift: still points at slot 2 = helper. Now grow
      // the function space check by removing helper — slot 2 vanishes and the
      // captured index dangles (1 import + 1 defined func → valid [0, 2)).
      m.functions.pop();
      m.exports[0]!.desc.index = 1;
      m.elements[0]!.funcIndices[0] = 1;
    });
    expect(() => emitBinary(mod)).toThrow(/function index out of range.*2/s);
  });

  it("validation is read-only: bytes identical with and without it", () => {
    const withValidation = emitBinary(testModule());
    process.env.JS2WASM_SKIP_INDEX_VALIDATION = "1";
    let without: Uint8Array;
    try {
      without = emitBinary(testModule());
    } finally {
      process.env.JS2WASM_SKIP_INDEX_VALIDATION = "";
    }
    expect(Buffer.from(withValidation).equals(Buffer.from(without))).toBe(true);
  });
});

describe("#2043 end-to-end: the #2029 repro produces a named, located error", () => {
  it("class A extends Uint8Array under standalone names the poisoned index space", async () => {
    const src = `class MyArr extends Uint8Array {}\nconst a = new MyArr();\nconsole.log(a instanceof MyArr);\n`;
    const r = await compile(src, { fileName: "repro-1915.ts", target: "standalone" });
    // Until the #2029 producer is fixed this compile fails — but it must fail
    // with the NAMED index-space error, never the raw encoder RangeError.
    if (!r.success) {
      const msgs = r.errors.map((e: { message: string }) => e.message).join("\n");
      expect(msgs).toMatch(/index out of range/);
      expect(msgs).toMatch(/#2043/);
      expect(msgs).not.toMatch(/u32 out of range/);
    }
  });
});
