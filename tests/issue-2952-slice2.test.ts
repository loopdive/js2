// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2952 slice 2 — IR adoption of unlabeled `break` / `continue` via the
// Design-A depth-resolver machinery, plus statement-level `if` inside loop
// bodies (the enabler for the canonical `if (c) break;` shape).
//
//   - A1 loop identity:  `loopLabel` on while/for/forof.* nodes, synthesised
//     per loop by from-ast (`IrFunctionBuilder.freshLoopLabel`).
//   - A2 branch instr:   `IrInstrBrLabel { label, mode }` — NO depth stored
//     in the IR (a stored depth would rot under buffer re-nesting).
//   - A3 depth resolver: `lower.ts` threads a `ctrlStack` of CtrlFrames
//     (one per structured Wasm frame) and derives each `br` immediate at
//     emit time; crossed try-finallys are inlined before the br.
//   - `if.stmt`:         void statement-if in nested buffers (both arms are
//     body-statement buffers; else may be empty).
//
// Semantics matrix covered here: break/continue in all five claimed loop
// kinds (while / do-while / for / for-of vec / nested), continue-target
// placement (pre-test while re-runs cond; for runs update; do-while falls
// to cond; forof.vec advances the counter), break-across-try/finally
// (finally inlined exactly once), and the slice-3 boundaries (labeled
// break/continue not claimed).

import { describe, expect, it } from "vitest";

import { ts } from "../src/ts-api.js";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";
import { planIrCompilation } from "../src/ir/select.js";
import { verifyIrFunction } from "../src/ir/verify.js";
import { IrFunctionBuilder } from "../src/ir/builder.js";
import { irVal, type IrType } from "../src/ir/nodes.js";
import { createTestIrFunctionIdentityFactory } from "./helpers/ir-identities.js";

const identities = createTestIrFunctionIdentityFactory("issue-2952-slice2");

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

describe("#2952 slice 2 — selector claims (claim-row backed by lowering)", () => {
  it("claims while + if(c) break", () => {
    const claimed = selectionFor(`
      export function test(): number {
        let i = 0;
        while (i < 100) {
          if (i >= 7) { break; }
          i++;
        }
        return i;
      }
    `);
    expect(claimed.has("test")).toBe(true);
  });

  it("claims statement-if/else inside a loop body (no break needed)", () => {
    const claimed = selectionFor(`
      export function test(): number {
        let even = 0;
        let odd = 0;
        for (let i = 0; i < 10; i++) {
          if (i % 2 === 0) { even++; } else { odd++; }
        }
        return even * 100 + odd;
      }
    `);
    expect(claimed.has("test")).toBe(true);
  });

  it("claims labeled break (boundary lifted by slice 3)", () => {
    // Slice 2 recorded this as a NOT-claimed boundary; slice 3 adopts
    // labeled loops, so the claim flips (see issue-2952-slice3.test.ts for
    // the full labeled matrix).
    const claimed = selectionFor(`
      export function test(): number {
        let n = 0;
        outer: for (let i = 0; i < 3; i++) {
          for (let j = 0; j < 3; j++) {
            if (j === 1) { break outer; }
            n++;
          }
        }
        return n;
      }
    `);
    expect(claimed.has("test")).toBe(true);
  });

  it("does NOT claim break outside any loop (inLoop gate)", () => {
    // A try body at function top level is a body-statement context with
    // inLoop=false — a break there is invalid JS anyway, but the gate must
    // reject the shape rather than claim-and-throw.
    const claimed = selectionFor(`
      export function test(): number {
        let n = 0;
        try {
          break;
        } finally {
          n = 1;
        }
        return n;
      }
    `);
    expect(claimed.has("test")).toBe(false);
  });
});

describe("#2952 slice 2 — break/continue runtime semantics", () => {
  it("while + break exits at the guard", async () => {
    expect(
      await runIr(`
        export function test(): number {
          let i = 0;
          while (i < 100) {
            if (i >= 7) { break; }
            i++;
          }
          return i;
        }
      `),
    ).toBe(7);
  });

  it("pre-test while + continue re-evaluates the cond", async () => {
    expect(
      await runIr(`
        export function test(): number {
          let i = 0;
          let sum = 0;
          while (i < 10) {
            i++;
            if (i % 2 === 1) { continue; }
            sum += i;
          }
          return sum;
        }
      `),
    ).toBe(30);
  });

  it("for + continue still runs the update (no infinite loop)", async () => {
    expect(
      await runIr(`
        export function test(): number {
          let sum = 0;
          for (let i = 0; i < 10; i++) {
            if (i % 2 === 0) { continue; }
            sum += i;
          }
          return sum;
        }
      `),
    ).toBe(25);
  });

  it("for + break", async () => {
    expect(
      await runIr(`
        export function test(): number {
          let sum = 0;
          for (let i = 0; i < 1000; i++) {
            if (i === 5) { break; }
            sum += i;
          }
          return sum;
        }
      `),
    ).toBe(10);
  });

  it("do-while + break (post-test, body ran)", async () => {
    expect(
      await runIr(`
        export function test(): number {
          let i = 0;
          do {
            if (i === 3) { break; }
            i++;
          } while (i < 100);
          return i;
        }
      `),
    ).toBe(3);
  });

  it("do-while + continue falls through to the cond", async () => {
    expect(
      await runIr(`
        export function test(): number {
          let i = 0;
          let sum = 0;
          do {
            i++;
            if (i > 5) { continue; }
            sum += i;
          } while (i < 10);
          return sum;
        }
      `),
    ).toBe(15);
  });

  it("for-of (vec) + break", async () => {
    expect(
      await runIr(`
        export function test(): number {
          const arr = [10, 20, 30, 40, 50];
          let sum = 0;
          for (const x of arr) {
            if (x > 30) { break; }
            sum += x;
          }
          return sum;
        }
      `),
    ).toBe(60);
  });

  it("for-of (vec) + continue advances the element counter", async () => {
    expect(
      await runIr(`
        export function test(): number {
          const arr = [1, 2, 3, 4, 5];
          let sum = 0;
          for (const x of arr) {
            if (x === 3) { continue; }
            sum += x;
          }
          return sum;
        }
      `),
    ).toBe(12);
  });

  it("nested loops: unlabeled break binds the INNER loop", async () => {
    expect(
      await runIr(`
        export function test(): number {
          let count = 0;
          for (let i = 0; i < 3; i++) {
            for (let j = 0; j < 10; j++) {
              if (j === 2) { break; }
              count++;
            }
          }
          return count;
        }
      `),
    ).toBe(6);
  });

  it("nested loops: unlabeled continue binds the INNER loop", async () => {
    expect(
      await runIr(`
        export function test(): number {
          let count = 0;
          for (let i = 0; i < 3; i++) {
            for (let j = 0; j < 4; j++) {
              if (j === 1) { continue; }
              count++;
            }
          }
          return count;
        }
      `),
    ).toBe(9);
  });

  it("break across try/finally runs the finally exactly once per exit", async () => {
    // 4 normal iterations + 1 break iteration = finally runs 5 times.
    expect(
      await runIr(`
        export function test(): number {
          let fin = 0;
          let i = 0;
          while (i < 10) {
            try {
              if (i === 4) { break; }
              i++;
            } finally {
              fin += 100;
            }
          }
          return i + fin;
        }
      `),
    ).toBe(504);
  });

  it("continue across try/finally runs the finally then re-loops", async () => {
    expect(
      await runIr(`
        export function test(): number {
          let fin = 0;
          let sum = 0;
          for (let i = 0; i < 5; i++) {
            try {
              if (i % 2 === 0) { continue; }
              sum += i;
            } finally {
              fin += 1;
            }
          }
          return sum * 100 + fin;
        }
      `),
    ).toBe(4 * 100 + 5); // sum = 1+3, finally every iteration
  });

  it("statement-if with else in a loop body (plain adoption, no exits)", async () => {
    expect(
      await runIr(`
        export function test(): number {
          let even = 0;
          let odd = 0;
          for (let i = 0; i < 10; i++) {
            if (i % 2 === 0) { even++; } else { odd++; }
          }
          return even * 100 + odd;
        }
      `),
    ).toBe(505);
  });

  it("conditional slot write inside an if arm survives iterations", async () => {
    expect(
      await runIr(`
        export function test(): number {
          let last = -1;
          let i = 0;
          while (i < 20) {
            if (i % 7 === 0) { last = i; }
            i++;
          }
          return last;
        }
      `),
    ).toBe(14);
  });

  it("dead statements after break are skipped (buffer-termination rule)", async () => {
    expect(
      await runIr(`
        export function test(): number {
          let i = 0;
          while (i < 100) {
            i++;
            break;
            i = 999;
          }
          return i;
        }
      `),
    ).toBe(1);
  });
});

describe("#2952 slice 2 — verifier rules (A-design)", () => {
  const f64: IrType = irVal({ kind: "f64" });

  it("rejects br.label with no enclosing loop binding the label", () => {
    const b = new IrFunctionBuilder(identities.next("bad"), [f64], false);
    b.openBlock();
    b.emitBrLabel(b.freshLoopLabel(), "break");
    const v = b.emitConst({ kind: "f64", value: 0 }, f64);
    b.terminate({ kind: "return", values: [v] });
    const errors = verifyIrFunction(b.finish());
    // (slice 4 wording: break may target a loop OR a block/switch frame.)
    expect(errors.some((e) => e.message.includes("targets no enclosing loop/block/switch label"))).toBe(true);
  });

  it("accepts br.label bound by the enclosing loop and rejects a mid-buffer one", () => {
    // while (cond) { break; }  — built directly against the builder.
    const build = (trailingDead: boolean) => {
      const b = new IrFunctionBuilder(identities.next("f"), [f64], false);
      b.openBlock();
      const label = b.freshLoopLabel();
      let condV: import("../src/ir/nodes.js").IrValueId | null = null;
      const cond = b.collectBodyInstrs(() => {
        condV = b.emitConst({ kind: "i32", value: 1 }, irVal({ kind: "i32" }));
      });
      const body = b.collectBodyInstrs(() => {
        b.emitBrLabel(label, "break");
        if (trailingDead) {
          void b.emitConst({ kind: "f64", value: 9 }, f64);
        }
      });
      b.emitWhileLoop({ cond, condValue: condV!, body, loopLabel: label });
      const ret = b.emitConst({ kind: "f64", value: 0 }, f64);
      b.terminate({ kind: "return", values: [ret] });
      return b.finish();
    };
    expect(verifyIrFunction(build(false))).toEqual([]);
    const errors = verifyIrFunction(build(true));
    expect(errors.some((e) => e.message.includes("must be the last instruction"))).toBe(true);
  });
});
