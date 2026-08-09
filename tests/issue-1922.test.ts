// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #1922 — Shared IR traversal / use-collection module; fixes the live defect
 * where ordinary `while` / `for` loops silently demoted off the IR path.
 *
 * Root cause: ≥5 hand-rolled copies of "walk nested instruction buffers /
 * collect uses" lived across `verify.ts`, `lower.ts`, `passes/dead-code.ts`,
 * `passes/constant-fold.ts` and `passes/alloc-discipline.ts`, kept in sync only
 * by comments. DCE's copy returned only `[condValue]` for `while.loop` /
 * `for.loop` and never walked the cond/body/update buffers, so a value used
 * ONLY inside a loop (the canonical `const limit = …; while (i < limit) …`) was
 * invisible to liveness, got stripped, and the post-hygiene verifier then
 * rejected the dangling SSA ref — demoting the most ordinary loop shape to the
 * legacy path.
 *
 * The fix promotes the traversal to a single authority in `src/ir/nodes.ts`
 * (`forEachNestedBuffer` / `forEachInstrDeep` / `collectUses`) and routes every
 * consumer through it.
 *
 * These tests pin:
 *  1. UNIT — `deadCode` keeps loop-buffer-only values live (deterministic; this
 *     is the exact shape that produced the demotion).
 *  2. EXHAUSTIVENESS — `forEachNestedBuffer` visits the buffer(s) of every
 *     buffer-bearing IrInstr kind, and visits none for leaf kinds.
 *  3. END-TO-END — the `while (i < limit)` / `for (…)` programs compile under
 *     `experimentalIR: true` with zero post-claim fallbacks and run correctly.
 */
import { describe, expect, it } from "vitest";

import {
  asBlockId,
  asValueId,
  collectUses,
  forEachNestedBuffer,
  irVal,
  verifyIrFunction,
  type IrFunction,
  type IrInstr,
  type IrType,
} from "../src/ir/index.js";
import { deadCode } from "../src/ir/passes/dead-code.js";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";
import { createTestIrFunctionIdentityFactory } from "./helpers/ir-identities.js";

const irIdentities = createTestIrFunctionIdentityFactory("issue-1922");

const I32: IrType = irVal({ kind: "i32" });

function constI32(id: number, value: number): IrInstr {
  return { kind: "const", value: { kind: "i32", value }, result: asValueId(id), resultType: I32 };
}
function binary(id: number, op: "i32.lt_s" | "i32.add" | "i32.mul", lhs: number, rhs: number): IrInstr {
  return {
    kind: "binary",
    op,
    lhs: asValueId(lhs),
    rhs: asValueId(rhs),
    result: asValueId(id),
    resultType: I32,
  } as IrInstr;
}

// ---------------------------------------------------------------------------
// 1. UNIT — DCE must keep values used only inside a loop's buffers.
// ---------------------------------------------------------------------------

describe("#1922 DCE keeps loop-buffer-only SSA values live", () => {
  it("while.loop: a value used only in the cond buffer survives DCE + verify", () => {
    // f(n) { limit = n*2; i = 0; one = 1; while (i < limit) { i + one } return i }
    // `limit` (v1) and `one` (v4) are used ONLY inside the loop buffers.
    const v_n = 0;
    const v_limit = 1;
    const v_i0 = 2;
    const v_two = 3;
    const v_one = 4;
    const v_cond = 5;
    const v_inext = 6;
    const fn: IrFunction = {
      ...irIdentities.next("f"),
      params: [{ value: asValueId(v_n), type: I32, name: "n" }],
      resultTypes: [I32],
      exported: true,
      valueCount: 7,
      blocks: [
        {
          id: asBlockId(0),
          blockArgs: [],
          blockArgTypes: [],
          instrs: [
            constI32(v_two, 2),
            binary(v_limit, "i32.mul", v_n, v_two),
            constI32(v_i0, 0),
            constI32(v_one, 1),
            {
              kind: "while.loop",
              result: null,
              resultType: null,
              condValue: asValueId(v_cond),
              cond: [binary(v_cond, "i32.lt_s", v_i0, v_limit)],
              body: [binary(v_inext, "i32.add", v_i0, v_one)],
            } as IrInstr,
          ],
          terminator: { kind: "return", values: [asValueId(v_i0)] },
        },
      ],
    };

    expect(
      verifyIrFunction(fn).map((e) => e.message),
      "pre-DCE verify is clean",
    ).toEqual([]);
    const after = deadCode(fn);
    const survives = (id: number): boolean => after.blocks[0]!.instrs.some((i) => i.result === asValueId(id));
    expect(survives(v_limit), "limit (cond-buffer-only) survives DCE").toBe(true);
    expect(survives(v_one), "one (body-buffer-only) survives DCE").toBe(true);
    // The post-hygiene verifier (the gate that demoted the function) is clean.
    expect(
      verifyIrFunction(after).map((e) => e.message),
      "post-DCE verify is clean",
    ).toEqual([]);
  });

  it("for.loop: values used only in cond/body/update buffers survive DCE + verify", () => {
    // g(n) { limit = n*2; s = 0; for (i=0; i<limit; i = i+step) { s + i } return s }
    // limit (v1, cond) and step (v6, update) are buffer-only.
    const v_n = 0;
    const v_limit = 1;
    const v_s0 = 2;
    const v_two = 3;
    const v_i0 = 4;
    const v_zero = 5;
    const v_step = 6;
    const v_cond = 7;
    const v_snew = 8;
    const v_inext = 9;
    const fn: IrFunction = {
      ...irIdentities.next("g"),
      params: [{ value: asValueId(v_n), type: I32, name: "n" }],
      resultTypes: [I32],
      exported: true,
      valueCount: 10,
      blocks: [
        {
          id: asBlockId(0),
          blockArgs: [],
          blockArgTypes: [],
          instrs: [
            constI32(v_two, 2),
            binary(v_limit, "i32.mul", v_n, v_two),
            constI32(v_zero, 0),
            constI32(v_s0, 0),
            constI32(v_i0, 0),
            constI32(v_step, 1),
            {
              kind: "for.loop",
              result: null,
              resultType: null,
              condValue: asValueId(v_cond),
              cond: [binary(v_cond, "i32.lt_s", v_i0, v_limit)],
              body: [binary(v_snew, "i32.add", v_s0, v_i0)],
              update: [binary(v_inext, "i32.add", v_i0, v_step)],
            } as IrInstr,
          ],
          terminator: { kind: "return", values: [asValueId(v_s0)] },
        },
      ],
    };

    expect(
      verifyIrFunction(fn).map((e) => e.message),
      "pre-DCE verify is clean",
    ).toEqual([]);
    const after = deadCode(fn);
    const survives = (id: number): boolean => after.blocks[0]!.instrs.some((i) => i.result === asValueId(id));
    expect(survives(v_limit), "limit (cond-buffer-only) survives DCE").toBe(true);
    expect(survives(v_step), "step (update-buffer-only) survives DCE").toBe(true);
    expect(
      verifyIrFunction(after).map((e) => e.message),
      "post-DCE verify is clean",
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2. EXHAUSTIVENESS — forEachNestedBuffer is the single buffer authority.
// ---------------------------------------------------------------------------

describe("#1922 forEachNestedBuffer covers every buffer-bearing IrInstr kind", () => {
  // A unique marker instr per buffer, so we can assert WHICH buffers were
  // surfaced (not just how many).
  const marker = (id: number): IrInstr => constI32(id, id);

  // For each buffer-bearing kind, a minimal instance and the buffers we expect
  // forEachNestedBuffer to surface, in order.
  const cases: { name: string; instr: IrInstr; expected: readonly IrInstr[] }[] = (() => {
    const ifThen = marker(101);
    const ifElse = marker(102);
    const ifInstr = {
      kind: "if",
      result: asValueId(110),
      resultType: I32,
      cond: asValueId(100),
      thenValue: asValueId(101),
      elseValue: asValueId(102),
      then: [ifThen],
      else: [ifElse],
    } as IrInstr;

    const fvBody = marker(201);
    const forofVec = {
      kind: "forof.vec",
      result: null,
      resultType: null,
      vec: asValueId(200),
      body: [fvBody],
    } as IrInstr;

    const fiBody = marker(301);
    const forofIter = {
      kind: "forof.iter",
      result: null,
      resultType: null,
      iterable: asValueId(300),
      body: [fiBody],
    } as IrInstr;

    const fsBody = marker(401);
    const forofString = {
      kind: "forof.string",
      result: null,
      resultType: null,
      str: asValueId(400),
      body: [fsBody],
    } as IrInstr;

    const wCond = marker(501);
    const wBody = marker(502);
    const whileLoop = {
      kind: "while.loop",
      result: null,
      resultType: null,
      condValue: asValueId(501),
      cond: [wCond],
      body: [wBody],
    } as IrInstr;

    const fCond = marker(601);
    const fBody = marker(602);
    const fUpdate = marker(603);
    const forLoop = {
      kind: "for.loop",
      result: null,
      resultType: null,
      condValue: asValueId(601),
      cond: [fCond],
      body: [fBody],
      update: [fUpdate],
    } as IrInstr;

    const tBody = marker(701);
    const tCatch = marker(702);
    const tFinally = marker(703);
    const tryFull = {
      kind: "try",
      result: null,
      resultType: null,
      body: [tBody],
      catchClause: { body: [tCatch] },
      finallyBody: [tFinally],
    } as IrInstr;

    const tBodyOnly = marker(801);
    const tryBodyOnly = {
      kind: "try",
      result: null,
      resultType: null,
      body: [tBodyOnly],
    } as IrInstr;

    return [
      { name: "if", instr: ifInstr, expected: [ifThen, ifElse] },
      { name: "forof.vec", instr: forofVec, expected: [fvBody] },
      { name: "forof.iter", instr: forofIter, expected: [fiBody] },
      { name: "forof.string", instr: forofString, expected: [fsBody] },
      { name: "while.loop", instr: whileLoop, expected: [wCond, wBody] },
      { name: "for.loop", instr: forLoop, expected: [fCond, fBody, fUpdate] },
      { name: "try (full)", instr: tryFull, expected: [tBody, tCatch, tFinally] },
      { name: "try (body only)", instr: tryBodyOnly, expected: [tBodyOnly] },
    ];
  })();

  for (const c of cases) {
    it(`visits the buffer(s) of ${c.name} in order`, () => {
      const seen: IrInstr[] = [];
      forEachNestedBuffer(c.instr, (buffer) => {
        // Each buffer in these fixtures holds exactly one marker instr.
        expect(buffer.length).toBe(1);
        seen.push(buffer[0]!);
      });
      expect(seen).toEqual(c.expected);
    });
  }

  it("surfaces NO buffers for leaf (non-control-flow) instr kinds", () => {
    const leaves: IrInstr[] = [
      constI32(1, 1),
      binary(2, "i32.add", 0, 1),
      { kind: "call", args: [asValueId(0)], callee: 0, result: asValueId(3), resultType: I32 } as IrInstr,
      { kind: "global.get", global: 0, result: asValueId(4), resultType: I32 } as IrInstr,
    ];
    for (const leaf of leaves) {
      let count = 0;
      forEachNestedBuffer(leaf, () => count++);
      expect(count, `${leaf.kind} has no nested buffer`).toBe(0);
    }
  });

  it("collectUses({deep}) surfaces buffer-interior uses; shallow does not", () => {
    // while.loop with cond `i < limit` (v2 < v1) and body `i + one` (v2 + v4).
    const loop = {
      kind: "while.loop",
      result: null,
      resultType: null,
      condValue: asValueId(5),
      cond: [binary(5, "i32.lt_s", 2, 1)],
      body: [binary(6, "i32.add", 2, 4)],
    } as IrInstr;
    // Shallow == direct: only the condValue.
    expect(collectUses(loop).map(Number)).toEqual([5]);
    // Deep: condValue + cond-buffer uses (2,1) + body-buffer uses (2,4).
    expect(collectUses(loop, { deep: true }).map(Number)).toEqual([5, 2, 1, 2, 4]);
  });
});

// ---------------------------------------------------------------------------
// 3. END-TO-END — ordinary loops stay on the IR path and run correctly.
// ---------------------------------------------------------------------------

describe("#1922 ordinary loops compile through the IR path (no post-claim fallback)", () => {
  async function runIr(src: string, fn: string, args: number[]): Promise<{ value: unknown; postClaim: number }> {
    const r = await compile(src, { fileName: "test.ts", experimentalIR: true });
    if (!r.success) throw new Error(`compile failed: ${r.errors[0]?.message ?? "?"}`);
    const imps = buildImports(r.imports as never, undefined, r.stringPool);
    const { instance } = await WebAssembly.instantiate(r.binary, imps as never);
    (imps as { setExports?: (e: unknown) => void }).setExports?.(instance.exports);
    const f = (instance.exports as Record<string, unknown>)[fn] as (...a: number[]) => unknown;
    return { value: f(...args), postClaim: (r.irPostClaimErrors ?? []).length };
  }

  it("while (i < limit) — the canonical demotion probe — stays on IR and computes", async () => {
    const src = `export function f(n: number): number {
      const limit = n * 2; let i = 0;
      while (i < limit) { i = i + 1; }
      return i;
    }`;
    const { value, postClaim } = await runIr(src, "f", [5]);
    expect(postClaim, "no post-claim IR fallback").toBe(0);
    expect(value).toBe(10);
  });

  it("for (let i = 0; i < limit; i++) — stays on IR and computes", async () => {
    const src = `export function g(n: number): number {
      const limit = n * 2; let s = 0;
      for (let i = 0; i < limit; i = i + 1) { s = s + i; }
      return s;
    }`;
    const { value, postClaim } = await runIr(src, "g", [4]);
    expect(postClaim, "no post-claim IR fallback").toBe(0);
    // sum 0..7 = 28
    expect(value).toBe(28);
  });
});
