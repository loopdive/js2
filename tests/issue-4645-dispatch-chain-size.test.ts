// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4645 — regression floor for the dynamic member-dispatch chain size.
//
// THE CLIFF. Each `__get_member_*` / `__set_member_*` / `__sget_*` dispatcher is
// a chain of arms. For a collision-stamped struct, five builders used to write
// the arm as two nested `if`s that BOTH named the same "rest of the chain"
// array object. That made the chain's tail have two parents, so the number of
// root-to-node paths DOUBLED per stamped arm — and nothing in the compiler
// dedupes, including the binary encoder. A 12-arm chain in the
// `@js-temporal/polyfill` bundle reached 266 distinct instructions walked
// 1,315,939 times; the whole-module compile went from 18 s at 83 KB of input to
// 109 s at 109 KB and did not terminate in 45 minutes at 157 KB, emitting a
// 29 MB binary on the way. See `buildShapeGuardedArm` in
// `src/codegen/shape-guarded-arm.ts` for the fix.
//
// THE GUARD, and why it is shaped this way. Wall-clock is not gated here — it
// is load-dependent and flaky (the #3437 harness budget gate makes the same
// argument). Emitted BINARY SIZE is a deterministic proxy: it is exactly what
// the path explosion inflates, it is a pure function of the input, and the
// signal is enormous. On the fixture below, doubling the number of colliding
// shapes from 8 to 16 grows the binary 1.8x when the chain is a list and 217x
// when it is a doubling DAG (10 KB → 19 KB vs 53 KB → 11.5 MB, measured
// 2026-08-28 on this fixture with and without the fix). The RATIO is the
// primary assertion so ordinary codegen growth cannot drift it red; the
// absolute ceiling is a vacuity backstop.

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildShapeGuardedArm } from "../src/codegen/shape-guarded-arm.js";
import type { Instr } from "../src/ir/types.js";

/**
 * `n` object literals that are STRUCTURALLY IDENTICAL (three f64 slots) but
 * name their slots differently, so WasmGC canonicalization merges their heap
 * types and the compiler stamps each with a `$shape` id — the exact condition
 * that selects the shape-guarded arm. They share one property (`year`), read
 * and written through a dynamic `any` receiver, which is what builds the
 * multi-arm dispatcher chain.
 */
function collidingShapes(n: number): string {
  const lines: string[] = [];
  for (let i = 0; i < n; i++) lines.push(`const o${i} = { year: ${i}, f${i}a: ${i}, f${i}b: ${i} };`);
  lines.push(`const all = [${Array.from({ length: n }, (_, i) => `o${i}`).join(", ")}];`);
  lines.push("let acc = 0;");
  lines.push("for (const o of all) { acc += o.year; o.year = acc; }");
  lines.push("export function main() { return acc; }");
  return lines.join("\n");
}

async function binarySize(n: number): Promise<number> {
  const result = await compile(collidingShapes(n), {
    allowJs: true,
    skipSemanticDiagnostics: true,
    fileName: "issue-4645-synthetic.js",
  });
  expect(result.success).toBe(true);
  expect(result.binary.length).toBeGreaterThan(0);
  return result.binary.length;
}

describe("#4645 — member-dispatch chains stay linear in the number of colliding shapes", () => {
  it("does not double the emitted binary per shape-stamped arm", async () => {
    const small = await binarySize(4);
    const large = await binarySize(8);

    // Four more arms must add arms, not double the chain four times.
    // Measured 2026-08-28 — fixed: 6,839 → 10,444 = 1.53x. Broken: 9,716 →
    // 52,974 = 5.45x. Four arms is deliberately the SMALLEST fixture that
    // separates the two: at 16 arms the broken build emits 11.5 MB and OOMs a
    // vitest worker, which is a worse CI failure mode than a clean assertion.
    expect(large / small).toBeLessThan(3);

    // Vacuity backstop: the fixture really did compile a whole module, and the
    // module is nowhere near the scale the explosion produced.
    expect(small).toBeGreaterThan(2_000);
    expect(large).toBeLessThan(30_000);
  }, 120_000);

  it("references the rest of the chain exactly once per arm", () => {
    const next: Instr[] = [{ op: "unreachable" }];
    const hit: Instr[] = [{ op: "nop" }];
    const arm = buildShapeGuardedArm(
      1,
      7,
      { shapeId: 42, shapeFieldIdx: 3 },
      { kind: "val", type: { kind: "f64" } },
      hit,
      next,
    );

    // Count how many places in the arm hold the IDENTITY of `next`. Two was the
    // bug: it is what turns the chain into a doubling DAG.
    let occurrences = 0;
    const visit = (instrs: Instr[]): void => {
      for (const instr of instrs) {
        const node = instr as unknown as Record<string, unknown>;
        for (const key of ["body", "then", "else", "catchAll"]) {
          const child = node[key];
          if (!Array.isArray(child)) continue;
          if (child === next) occurrences++;
          else visit(child as Instr[]);
        }
      }
    };
    visit(arm);
    expect(occurrences).toBe(1);
  });

  it("only casts on the ref.test-true path, so a non-matching receiver cannot trap", () => {
    const arm = buildShapeGuardedArm(
      1,
      7,
      { shapeId: 42, shapeFieldIdx: 3 },
      { kind: "empty" },
      [{ op: "nop" }],
      [{ op: "unreachable" }],
    );
    // The guard `if` yields an i32; the `ref.cast` lives in its `then` arm and
    // its `else` arm is the constant 0. A flattened `i32.and` form would put the
    // cast unconditionally in the operand sequence — that is the trap.
    const guardIf = arm.find((i) => i.op === "if") as Extract<Instr, { op: "if" }>;
    expect(guardIf.blockType).toEqual({ kind: "val", type: { kind: "i32" } });
    expect(guardIf.then.some((i) => i.op === "ref.cast")).toBe(true);
    expect(guardIf.else).toEqual([{ op: "i32.const", value: 0 }]);
    expect(arm.some((i) => i.op === "ref.cast")).toBe(false);
  });
});
