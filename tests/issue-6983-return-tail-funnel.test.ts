// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6983 — prettier/lodash-es regime binaries timed out under `wasm-opt -O4`:
// Binaryen's code-folding compares identical terminating tails pairwise, and
// the generic `__extern_set` dispatcher ends ~4,800 arms with the same
// `i32.const c; global.set G; return`. The finalize-time funnel branches those
// arms to one shared exit block per (G, c). These tests pin that the rewrite
// keeps behavior (including branches that leave the body, which it must shift
// past the new blocks), validates, and lets -O4 finish.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { createEmptyModule } from "../src/ir/types.js";
import type { Instr, WasmModule } from "../src/ir/types.js";
import { emitBinary } from "../src/emit/binary.js";
import { optimizeBinaryAsync } from "../src/optimize.js";
import { funnelRepeatedReturnTails } from "../src/codegen/helpers/return-tail-funnel.js";

const i32 = { kind: "i32" } as const;

/** `set(x)`: arm k (x == k) writes h = k, then status = 1 + k % 2 and returns. */
function dispatcherModule(arms: number): WasmModule {
  const mod = createEmptyModule();
  mod.types.push({ kind: "func", params: [i32], results: [] } as never);
  mod.types.push({ kind: "func", params: [], results: [i32] } as never);
  mod.globals.push({
    name: "status",
    type: i32,
    mutable: true,
    init: [{ op: "i32.const", value: 0 }],
  });
  mod.globals.push({
    name: "h",
    type: i32,
    mutable: true,
    init: [{ op: "i32.const", value: 0 }],
  });
  const body: Instr[] = [
    { op: "i32.const", value: 0 },
    { op: "global.set", index: 1 },
    // x == -1 leaves through a branch to the FUNCTION label (status untouched).
    { op: "local.get", index: 0 },
    { op: "i32.const", value: -1 },
    { op: "i32.eq" },
    { op: "br_if", depth: 0 },
  ];
  for (let k = 0; k < arms; k++) {
    body.push(
      { op: "local.get", index: 0 },
      { op: "i32.const", value: k },
      { op: "i32.eq" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          {
            op: "block",
            blockType: { kind: "empty" },
            body: [
              { op: "i32.const", value: k },
              { op: "global.set", index: 1 },
              // x == -2 - k style escape from two labels deep: br 2 = function.
              { op: "local.get", index: 0 },
              { op: "i32.const", value: 100000 },
              { op: "i32.gt_s" },
              { op: "br_if", depth: 2 },
            ],
          },
          { op: "i32.const", value: 1 + (k % 2) },
          { op: "global.set", index: 0 },
          { op: "return" },
        ],
      },
    );
  }
  body.push({ op: "i32.const", value: 9 }, { op: "global.set", index: 0 });
  mod.functions.push({
    name: "set",
    typeIdx: 0,
    locals: [],
    body,
    exported: true,
  });
  mod.functions.push({
    name: "status",
    typeIdx: 1,
    locals: [],
    body: [{ op: "global.get", index: 0 }],
    exported: true,
  });
  mod.functions.push({
    name: "h",
    typeIdx: 1,
    locals: [],
    body: [{ op: "global.get", index: 1 }],
    exported: true,
  });
  mod.exports.push({ name: "set", desc: { kind: "func", index: 0 } });
  mod.exports.push({ name: "status", desc: { kind: "func", index: 1 } });
  mod.exports.push({ name: "h", desc: { kind: "func", index: 2 } });
  return mod;
}

async function observe(binary: Uint8Array, inputs: number[]): Promise<string[]> {
  const { instance } = await WebAssembly.instantiate(binary, {});
  const exp = instance.exports as {
    set(x: number): void;
    status(): number;
    h(): number;
  };
  return inputs.map((x) => {
    exp.set(x);
    return `${x}:${exp.status()}:${exp.h()}`;
  });
}

/** 40 classes + one inherited accessor: `__extern_set` gets ~800 status-write exits. */
function classSetterProgram(): string {
  let src = "";
  for (let i = 0; i < 40; i++) src += `class S${i} { constructor(a) { this.a = a; this.b${i} = a + ${i}; } }\n`;
  src += `Object.defineProperty(S0.prototype, "z", { get: function () { return 1; }, set: function (v) {}, configurable: true });\n`;
  const calls = Array.from({ length: 40 }, (_, i) => `t += put(new S${i}(${i}), "b${i}", ${i});`).join(" ");
  return `${src}function put(o, k, v) { o[k] = v; return o[k]; }\nexport function run() { var t = 0; ${calls} return t; }\n`;
}

describe("#6983 return-tail funnel", () => {
  for (const options of [{ semanticProviders: "native-first" }, { target: "standalone" }] as const) {
    it(`funnels the compiled __extern_set exits (${JSON.stringify(options)})`, async () => {
      const result = await compile(classSetterProgram(), {
        fileName: "m.mjs",
        skipSemanticDiagnostics: true,
        emitWat: true,
        emitWatOnlyFunctions: ["__extern_set"],
        ...options,
      } as never);
      expect(result.success, result.errors?.[0]?.message).toBe(true);
      const lines = result.wat.split("\n").map((line) => line.trim());
      let exits = 0;
      for (let i = 0; i + 2 < lines.length; i++) {
        if (lines[i]!.startsWith("i32.const") && lines[i + 1]!.startsWith("global.set") && lines[i + 2] === "return")
          exits++;
      }
      expect(exits).toBeLessThanOrEqual(2); // one per (status, value), was ~800
      const importObject = (result.importObject ?? {}) as WebAssembly.Imports & {
        __setInstance?: (instance: WebAssembly.Instance) => void;
      };
      const { instance } = await WebAssembly.instantiate(result.binary, importObject);
      importObject.__setInstance?.(instance);
      expect((instance.exports.run as () => number)()).toBe(780);
    }, 120_000);
  }

  const inputs = [-1, 0, 1, 2, 63, 64, 199, 200, 5000];

  it("leaves a function with few repeated tails byte-identical", () => {
    const mod = dispatcherModule(10);
    const before = emitBinary(mod);
    expect(funnelRepeatedReturnTails(mod)).toBe(0);
    expect(emitBinary(mod)).toEqual(before);
  });

  it("funnels repeated exits without changing behavior", async () => {
    const plain = emitBinary(dispatcherModule(200));
    const mod = dispatcherModule(200);
    expect(funnelRepeatedReturnTails(mod)).toBe(200);
    const funnelled = emitBinary(mod);
    expect(WebAssembly.validate(funnelled)).toBe(true);
    expect(funnelled.length).toBeLessThan(plain.length);
    expect(await observe(funnelled, inputs)).toEqual(await observe(plain, inputs));
  });

  it("lets wasm-opt -O4 finish on a dispatcher-sized function", async () => {
    const mod = dispatcherModule(3000);
    funnelRepeatedReturnTails(mod);
    const result = await optimizeBinaryAsync(emitBinary(mod), {
      level: 4,
      timeoutMs: 120_000,
    });
    expect(result.warning).toBeUndefined();
    expect(result.optimized).toBe(true);
    expect(await observe(result.binary, inputs)).toEqual(await observe(emitBinary(dispatcherModule(3000)), inputs));
  }, 180_000);
});
