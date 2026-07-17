/**
 * #908 — remove redundant codegen (dead value traffic) after a discarded
 * compound assignment to a module global. The tail codegen for
 * `result += squared(10)` in expression-statement position emits
 * `global.set N; global.get N; drop` — the store, then a re-read of the just-
 * stored value that is immediately dropped (the unused "expression result").
 * Reading a Wasm global is side-effect-free, so `global.get N; drop` is pure
 * dead value traffic. Peephole Pattern 2b removes the get/drop pair, leaving
 * the `global.set N` store intact.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { peepholeOptimize } from "../src/codegen/peephole.js";
import type { Instr, WasmModule } from "../src/ir/types.js";

function moduleWithBody(body: Instr[]): WasmModule {
  return {
    types: [{ kind: "func", name: "$f", params: [], results: [] }],
    imports: [],
    functions: [{ name: "f", typeIdx: 0, locals: [], body, exported: false }],
    globals: [],
    exports: [],
    memories: [],
    tables: [],
    elements: [],
    dataSegments: [],
    tags: [],
  } as unknown as WasmModule;
}

describe("#908 peephole pattern 2b — dead global read/drop", () => {
  it("removes `global.get N; drop`, leaving the preceding `global.set N`", () => {
    const mod = moduleWithBody([
      { op: "f64.const", value: 42 } as Instr,
      { op: "global.set", index: 2 } as Instr,
      { op: "global.get", index: 2 } as Instr,
      { op: "drop" } as Instr,
    ]);
    const removed = peepholeOptimize(mod);
    expect(removed).toBe(2);
    const body = mod.functions[0]!.body;
    // Only the store survives; the dead re-read + drop are gone.
    expect(body.map((i) => i.op)).toEqual(["f64.const", "global.set"]);
    expect((body[1] as { index: number }).index).toBe(2);
  });

  it("collapses a chain of `global.get N; drop` pairs", () => {
    const mod = moduleWithBody([
      { op: "global.get", index: 0 } as Instr,
      { op: "drop" } as Instr,
      { op: "global.get", index: 1 } as Instr,
      { op: "drop" } as Instr,
    ]);
    expect(peepholeOptimize(mod)).toBe(4);
    expect(mod.functions[0]!.body.length).toBe(0);
  });

  it("does NOT touch a `global.get` whose value is actually consumed", () => {
    // global.get feeding an add is live — must be preserved.
    const mod = moduleWithBody([
      { op: "global.get", index: 2 } as Instr,
      { op: "f64.const", value: 1 } as Instr,
      { op: "f64.add" } as Instr,
      { op: "global.set", index: 2 } as Instr,
    ]);
    expect(peepholeOptimize(mod)).toBe(0);
    expect(mod.functions[0]!.body.length).toBe(4);
  });
});

describe("#908 end-to-end — discarded global compound assignment is lean and correct", () => {
  const SOURCE = `function squared(n: number): number {
  return n * n;
}
let result = 0;
for (let i = 0; i < 10000; i++) {
  result += squared(10);
}
export function getResult(): number {
  return result;
}
`;

  it("emits no dead `global.get; drop` and computes the right value (optimizer off)", async () => {
    // optimize:false isolates the in-codegen peephole from Binaryen wasm-opt
    // (which would also remove the pair) — so a clean WAT proves Pattern 2b
    // fired, not wasm-opt.
    const r = await compile(SOURCE, { fileName: "issue-908.ts", optimize: false });
    expect(r.success).toBe(true);
    expect(WebAssembly.validate(r.binary as unknown as BufferSource)).toBe(true);
    // No `global.get` immediately followed by `drop` remains in the text.
    expect(/global\.get[^\n]*\n\s*drop/.test(r.wat)).toBe(false);
  });
});
