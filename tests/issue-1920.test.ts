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
});
