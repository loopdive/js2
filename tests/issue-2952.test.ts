// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2952 slice 1 — IR adoption of `do { body } while (cond)`.
//
// A do-while is a POST-test loop: the body runs once unconditionally, then
// the condition decides whether to repeat. This slice reuses the existing
// `while.loop` IR node with a new `postCond: true` flag; only the lowering
// emission order flips (body → cond-check). No new instr kind, so every IR
// pass treats a do-while exactly as a while.
//
//   - selector:  src/ir/select.ts::isPhase1DoStatement
//   - lowering:  src/ir/from-ast.ts::lowerDoStatement (postCond while.loop)
//   - emission:  src/ir/lower.ts::case "while.loop" (postCond branch)
//
// The distinguishing correctness check is that the body runs AT LEAST ONCE
// even when the condition is immediately false — a `while` would run zero
// times, a `do-while` runs one time. Bodies containing break/continue are
// (still) rejected by the selector's body-shape gate, so this slice only
// claims the multi-exit-free subset (the shared blocker tracked in #2952
// for switch / labeled break / for-in is unaffected).

import { describe, expect, it } from "vitest";

import { ts } from "../src/ts-api.js";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";
import { planIrCompilation } from "../src/ir/select.js";

async function runIr(src: string): Promise<unknown> {
  const r = await compile(src, { fileName: "test.ts", experimentalIR: true });
  if (!r.success) {
    throw new Error(`compile failed:\n${r.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`);
  }
  const imps = buildImports(r.imports as never, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imps as never);
  if (typeof (imps as { setExports?: (e: unknown) => void }).setExports === "function") {
    (imps as { setExports: (e: unknown) => void }).setExports(instance.exports);
  }
  return (instance.exports as { test: () => unknown }).test();
}

function selectionFor(source: string): Set<string> {
  const sf = ts.createSourceFile("test.ts", source, ts.ScriptTarget.Latest, true);
  const sel = planIrCompilation(sf, { experimentalIR: true });
  return new Set(sel.funcs);
}

describe("#2952 slice 1 — IR claims do-while (post-test loops)", () => {
  it("selector claims a do-while function", () => {
    const claimed = selectionFor(`
      export function test(): number {
        let x: number = 0;
        do {
          x = x + 1;
        } while (x < 5);
        return x;
      }
    `);
    expect(claimed.has("test")).toBe(true);
  });

  it("body runs at least once even when cond is immediately false (vs while == 0)", async () => {
    // The defining do-while semantic: `do { x++ } while (false)` runs the
    // body ONCE, so x === 1. A `while (false)` loop would leave x === 0.
    expect(
      await runIr(`
        export function test(): number {
          let x: number = 0;
          do {
            x = x + 1;
          } while (x < 0);
          return x;
        }
      `),
    ).toBe(1);
  });

  it("counts 0..4 then stops (post-test bound)", async () => {
    expect(
      await runIr(`
        export function test(): number {
          let sum: number = 0;
          let i: number = 0;
          do {
            sum = sum + i;
            i = i + 1;
          } while (i < 5);
          return sum;
        }
      `),
    ).toBe(0 + 1 + 2 + 3 + 4);
  });

  it("nested do-while inside a while body", async () => {
    expect(
      await runIr(`
        export function test(): number {
          let total: number = 0;
          let a: number = 0;
          while (a < 3) {
            let b: number = 0;
            do {
              total = total + 1;
              b = b + 1;
            } while (b < 2);
            a = a + 1;
          }
          return total;
        }
      `),
    ).toBe(3 * 2);
  });

  it("do-while whose body has `break` IS claimed (slice 2 lifted the boundary)", async () => {
    // Slice 1 rejected break/continue bodies (the multi-exit-free subset);
    // slice 2 adopts unlabeled break/continue via `br.label` + the
    // lowering-time depth resolver, so the same shape now claims AND runs
    // with post-test semantics (body executes once before the break).
    const src = `
      export function test(): number {
        let x: number = 0;
        do {
          x = x + 1;
          break;
        } while (x < 5);
        return x;
      }
    `;
    expect(selectionFor(src).has("test")).toBe(true);
    expect(await runIr(src)).toBe(1);
  });

  it("LABELED break on a do-while IS claimed (slice 3 lifted the boundary)", () => {
    const claimed = selectionFor(`
      export function test(): number {
        let n: number = 0;
        outer: do {
          do {
            n = n + 1;
            break outer;
          } while (n < 5);
        } while (n < 5);
        return n;
      }
    `);
    expect(claimed.has("test")).toBe(true);
  });
});
