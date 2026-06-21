// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #1920 — the WasmGC peephole walker recursed into `try.body` and `try.catches`
 * but NOT `try.catchAll`, so bodies built by e.g. wrapAsyncCallInTryCatch were
 * never peephole-optimized (the redundant `ref.as_non_null` after `ref.cast`
 * was left in). This drives `peepholeOptimize` directly with a hand-built
 * module so the catchAll path is exercised in isolation.
 */
import { describe, expect, it } from "vitest";
import { peepholeOptimize } from "../src/codegen/peephole.js";
import type { Instr, WasmModule } from "../src/ir/types.js";

function moduleWithTry(opts: { catchAll?: Instr[]; catchBody?: Instr[]; outerBody?: Instr[] }): WasmModule {
  const tryInstr: Instr = {
    op: "try",
    blockType: { kind: "empty" },
    body: opts.outerBody ?? [],
    catches: opts.catchBody ? [{ tagIdx: 0, body: opts.catchBody }] : [],
    ...(opts.catchAll ? { catchAll: opts.catchAll } : {}),
  } as Instr;
  return {
    types: [{ kind: "func", name: "$f", params: [], results: [] }],
    imports: [],
    functions: [{ name: "f", typeIdx: 0, locals: [], body: [tryInstr], exported: false }],
    globals: [],
    exports: [],
    memories: [],
    tables: [],
    elements: [],
    dataSegments: [],
    tags: [{ typeIdx: 0 }],
  } as unknown as WasmModule;
}

// The redundant pair the peephole removes: ref.cast then ref.as_non_null.
const redundantPair = (): Instr[] => [{ op: "ref.cast", typeIdx: 0 } as Instr, { op: "ref.as_non_null" } as Instr];

describe("#1920 peephole recurses into try.catchAll", () => {
  it("removes the redundant ref.as_non_null inside a catchAll body", () => {
    const mod = moduleWithTry({ catchAll: redundantPair() });
    const removed = peepholeOptimize(mod);
    expect(removed).toBe(1);
    const tryInstr = mod.functions[0]!.body[0] as Extract<Instr, { op: "try" }>;
    expect(tryInstr.catchAll).toEqual([{ op: "ref.cast", typeIdx: 0 }]);
  });

  it("still removes the pattern inside a named catch body (no regression)", () => {
    const mod = moduleWithTry({ catchBody: redundantPair() });
    const removed = peepholeOptimize(mod);
    expect(removed).toBe(1);
  });

  it("removes the pattern in both catch and catchAll bodies in one pass", () => {
    const mod = moduleWithTry({ catchBody: redundantPair(), catchAll: redundantPair() });
    const removed = peepholeOptimize(mod);
    expect(removed).toBe(2);
  });

  it("leaves a catchAll body without the pattern unchanged", () => {
    const mod = moduleWithTry({ catchAll: [{ op: "nop" } as Instr] });
    const removed = peepholeOptimize(mod);
    expect(removed).toBe(0);
    const tryInstr = mod.functions[0]!.body[0] as Extract<Instr, { op: "try" }>;
    expect(tryInstr.catchAll).toEqual([{ op: "nop" }]);
  });

  // #1920 — the recursion now goes through the shared walkChildren enumerator,
  // so the pattern must still be removed inside block/loop/if child bodies.
  it("recurses into block / loop / if-then / if-else child bodies", () => {
    const mkMod = (body: Instr[]): WasmModule =>
      ({
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
      }) as unknown as WasmModule;

    for (const wrap of [
      (inner: Instr[]): Instr => ({ op: "block", blockType: { kind: "empty" }, body: inner }) as Instr,
      (inner: Instr[]): Instr => ({ op: "loop", blockType: { kind: "empty" }, body: inner }) as Instr,
      (inner: Instr[]): Instr => ({ op: "if", blockType: { kind: "empty" }, then: inner, else: [] }) as Instr,
      (inner: Instr[]): Instr => ({ op: "if", blockType: { kind: "empty" }, then: [], else: inner }) as Instr,
    ]) {
      const mod = mkMod([wrap(redundantPair())]);
      expect(peepholeOptimize(mod)).toBe(1);
    }
  });
});

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

describe("#1920 peephole pattern 7 — 0/0 div → f64.const NaN", () => {
  it("collapses f64.const 0; f64.const 0; f64.div into a single f64.const NaN", () => {
    const mod = moduleWithBody([
      { op: "f64.const", value: 0 } as Instr,
      { op: "f64.const", value: 0 } as Instr,
      { op: "f64.div" } as Instr,
      { op: "drop" } as Instr,
    ]);
    const removed = peepholeOptimize(mod);
    expect(removed).toBe(2); // 3 → 1
    const body = mod.functions[0]!.body;
    expect(body[0]!.op).toBe("f64.const");
    expect(Number.isNaN((body[0] as { value: number }).value)).toBe(true);
    expect(body[1]!.op).toBe("drop");
  });

  it("does NOT touch a genuine f64 division (non-zero divisor)", () => {
    const mod = moduleWithBody([
      { op: "f64.const", value: 6 } as Instr,
      { op: "f64.const", value: 2 } as Instr,
      { op: "f64.div" } as Instr,
    ]);
    expect(peepholeOptimize(mod)).toBe(0);
  });
});

describe("#1920 peephole pattern 8 — local.set N; local.get N → local.tee N", () => {
  it("fuses a store immediately followed by a reload of the same local", () => {
    const mod = moduleWithBody([
      { op: "f64.const", value: 1 } as Instr,
      { op: "local.set", index: 3 } as Instr,
      { op: "local.get", index: 3 } as Instr,
      { op: "drop" } as Instr,
    ]);
    const removed = peepholeOptimize(mod);
    // set+get → tee (saves 1); then tee+drop → set via pattern 3 (saves 1).
    expect(removed).toBe(2);
    const body = mod.functions[0]!.body;
    expect(body.map((i) => i.op)).toEqual(["f64.const", "local.set"]);
  });

  it("does NOT fuse when the reloaded local index differs", () => {
    const mod = moduleWithBody([{ op: "local.set", index: 3 } as Instr, { op: "local.get", index: 4 } as Instr]);
    expect(peepholeOptimize(mod)).toBe(0);
  });
});
