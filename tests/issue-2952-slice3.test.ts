// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2952 slice 3 — IR adoption of LABELED break / continue targeting labeled
// LOOPS (`lbl: while/do/for/for-of`).
//
// Design (per the issue's Design-A spec): a labeled loop needs NO new IR
// kind. `lowerLabeledStatement` pre-allocates the loop's `loopLabel` id and
// hands it to the loop lowerer via `cx.pendingLoopLabel`; the label NAME →
// id mapping travels on `cx.labelEnv`, so `break lbl` / `continue lbl`
// lower to the SAME `br.label{label, mode}` instr slice 2 introduced, and
// the lowering-time ctrlStack depth resolver needs no new machinery.
//
// The one genuinely new lowering obligation (flagged in the slice-2 bank):
// a labeled branch that CROSSES an inner `forof.iter` loop must run that
// loop's `__iterator_return` on the way out (IteratorClose, §14.7.5.7) —
// the loop's own close call sits past the frame the br skips. The crossing
// close is emitted by the resolver via the `iterCloseSlot` carried on the
// forof.iter break frame; a br that TARGETS the frame lands AT the
// existing close call and emits nothing extra (no double close).
//
// Labeled NON-loop statements (`lbl: { break lbl; }`) stay legacy — they
// need a `labeled.block` IR kind, banked for the switch slice (a switch
// `break` targets exactly that frame shape).

import { describe, expect, it } from "vitest";

import { ts } from "../src/ts-api.js";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";
import { planIrCompilation } from "../src/ir/select.js";

async function runIr(src: string, arg?: unknown): Promise<unknown> {
  const r = await compile(src, { fileName: "test.ts", experimentalIR: true });
  if (!r.success) {
    throw new Error(`compile failed:\n${r.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`);
  }
  const imps = buildImports(r.imports as never, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imps as never);
  if (typeof (imps as { setExports?: (e: unknown) => void }).setExports === "function") {
    (imps as { setExports: (e: unknown) => void }).setExports(instance.exports);
  }
  return (instance.exports as { test: (a?: unknown) => unknown }).test(arg);
}

function selectionFor(source: string): Set<string> {
  const sf = ts.createSourceFile("test.ts", source, ts.ScriptTarget.Latest, true);
  const sel = planIrCompilation(sf, { experimentalIR: true });
  return new Set(sel.funcs);
}

/**
 * A host iterable whose iterators record `return()` calls — the observable
 * for IteratorClose-on-abrupt-exit. Typed as `Set<number>` on the Wasm
 * side (the iter-host arm only needs an externref-shaped iterable; the
 * runtime `__iterator` import calls `[Symbol.iterator]()` on whatever
 * arrives).
 */
function trackedIterable(values: number[]): {
  iterable: Iterable<number>;
  state: { returns: number; iterators: number };
} {
  const state = { returns: 0, iterators: 0 };
  const iterable: Iterable<number> = {
    [Symbol.iterator]() {
      state.iterators++;
      let i = 0;
      return {
        next: () =>
          i < values.length ? { done: false, value: values[i++]! } : { done: true, value: undefined as never },
        return: () => {
          state.returns++;
          return { done: true, value: undefined as never };
        },
      };
    },
  };
  return { iterable, state };
}

describe("#2952 slice 3 — selector claims (labeled loops)", () => {
  it("claims labeled break out of nested for loops", () => {
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

  it("claims labeled continue targeting the outer while", () => {
    const claimed = selectionFor(`
      export function test(): number {
        let i = 0;
        let n = 0;
        outer: while (i < 4) {
          i++;
          for (let j = 0; j < 3; j++) {
            if (j === 1) { continue outer; }
            n++;
          }
          n = n + 100;
        }
        return n;
      }
    `);
    expect(claimed.has("test")).toBe(true);
  });

  it("claims multi-label loops (a: b: while) with breaks to either name", () => {
    const claimed = selectionFor(`
      export function test(): number {
        let n = 0;
        a: b: while (n < 10) {
          for (let j = 0; j < 3; j++) {
            if (n === 5) { break a; }
            if (j === 2) { break b; }
            n++;
          }
        }
        return n;
      }
    `);
    expect(claimed.has("test")).toBe(true);
  });

  it("claims a labeled loop nested inside another loop body", () => {
    const claimed = selectionFor(`
      export function test(): number {
        let n = 0;
        for (let i = 0; i < 3; i++) {
          mid: for (let j = 0; j < 3; j++) {
            for (let k = 0; k < 3; k++) {
              if (k === 1) { continue mid; }
              n++;
            }
          }
        }
        return n;
      }
    `);
    expect(claimed.has("test")).toBe(true);
  });

  it("claims a labeled non-loop block (boundary lifted by slice 4's labeled.block)", () => {
    const claimed = selectionFor(`
      export function test(): number {
        let n = 0;
        blk: {
          n = 1;
          break blk;
        }
        return n;
      }
    `);
    expect(claimed.has("test")).toBe(true);
  });

  it("does NOT claim a break whose label is out of scope", () => {
    // `break outer` AFTER the labeled loop closed — invalid JS; the
    // selector must reject the shape rather than claim-and-throw.
    const claimed = selectionFor(`
      export function test(): number {
        let n = 0;
        outer: for (let i = 0; i < 2; i++) { n++; }
        for (let i = 0; i < 2; i++) {
          if (n > 0) { break outer; }
        }
        return n;
      }
    `);
    expect(claimed.has("test")).toBe(false);
  });
});

describe("#2952 slice 3 — labeled break/continue runtime semantics", () => {
  it("labeled break exits BOTH loops (classic nested search)", async () => {
    expect(
      await runIr(`
        export function test(): number {
          let n = 0;
          outer: for (let i = 0; i < 5; i++) {
            for (let j = 0; j < 5; j++) {
              if (i === 2 && j === 1) { break outer; }
              n++;
            }
          }
          return n;
        }
      `),
    ).toBe(11); // i=0: 5, i=1: 5, i=2: j=0 → 11, then break at j=1
  });

  it("labeled continue skips the REST of the outer iteration (outer update still runs)", async () => {
    // The `continue outer` sits in a NESTED loop's buffer — this exercises
    // the deep `bufferHasBrLabel` scan that decides the outer for's
    // dedicated continue-target block. Without it the branch would miss
    // the update and hang.
    expect(
      await runIr(`
        export function test(): number {
          let n = 0;
          outer: for (let i = 0; i < 3; i++) {
            for (let j = 0; j < 3; j++) {
              if (j === 1) { continue outer; }
              n = n + 1;
            }
            n = n + 100; // must be skipped every iteration
          }
          return n;
        }
      `),
    ).toBe(3); // each outer iteration: j=0 counts, j=1 continues outer
  });

  it("labeled continue on an outer while re-runs its cond (pre-test target)", async () => {
    expect(
      await runIr(`
        export function test(): number {
          let i = 0;
          let n = 0;
          outer: while (i < 4) {
            i++;
            for (let j = 0; j < 3; j++) {
              if (j === 1) { continue outer; }
              n++;
            }
            n = n + 100;
          }
          return n;
        }
      `),
    ).toBe(4);
  });

  it("labeled break on a do-while (post-test loop as the labeled target)", async () => {
    expect(
      await runIr(`
        export function test(): number {
          let n = 0;
          outer: do {
            do {
              n = n + 1;
              break outer;
            } while (n < 5);
          } while (n < 5);
          return n;
        }
      `),
    ).toBe(1);
  });

  it("multi-label loop: both names bind the same loop", async () => {
    expect(
      await runIr(`
        export function test(): number {
          let n = 0;
          a: b: while (n < 100) {
            for (let j = 0; j < 10; j++) {
              if (n >= 7) { break a; }
              if (j === 4) { break b; }
              n++;
            }
          }
          return n;
        }
      `),
    ).toBe(4); // n counts j=0..3, then `break b` exits the WHILE (both
    // labels bind the same loop — verified against V8: node prints 4)
  });

  it("labeled break crossing a try/finally runs the finally exactly once", async () => {
    expect(
      await runIr(`
        export function test(): number {
          let fin = 0;
          let n = 0;
          outer: for (let i = 0; i < 5; i++) {
            for (let j = 0; j < 5; j++) {
              try {
                n++;
                if (n === 3) { break outer; }
              } finally {
                fin = fin + 1;
              }
            }
          }
          return n * 100 + fin;
        }
      `),
    ).toBe(3 * 100 + 3); // finally on 2 normal + 1 breaking iteration
  });

  it("labeled break crossing an inner for-of (vec path) exits cleanly", async () => {
    expect(
      await runIr(`
        export function test(): number {
          const arr: number[] = [10, 20, 30];
          let n = 0;
          outer: for (let i = 0; i < 3; i++) {
            for (const v of arr) {
              n = n + v;
              if (n >= 60) { break outer; }
            }
          }
          return n;
        }
      `),
    ).toBe(60); // 10+20+30 (i=0 completes at 60 → break at the >= check)
  });

  it("statements after a labeled break are dead code (not emitted)", async () => {
    expect(
      await runIr(`
        export function test(): number {
          let n = 0;
          outer: for (let i = 0; i < 3; i++) {
            for (let j = 0; j < 3; j++) {
              if (j === 0) {
                break outer;
                n = n + 1000;
              }
            }
          }
          return n;
        }
      `),
    ).toBe(0);
  });
});

describe("#2952 slice 3 — IteratorClose on labeled branches crossing forof.iter", () => {
  it("labeled break crossing an inner iter-host for-of closes its iterator", async () => {
    const { iterable, state } = trackedIterable([1, 2, 3, 4, 5]);
    const result = await runIr(
      `
        export function test(s: Set<number>): number {
          let n = 0;
          outer: for (let i = 0; i < 3; i++) {
            for (const x of s) {
              n = n + 1;
              if (n >= 2) { break outer; }
            }
          }
          return n;
        }
      `,
      iterable,
    );
    expect(result).toBe(2);
    expect(state.iterators).toBe(1);
    // The iterator was mid-iteration (5 values, consumed 2) — the ONLY way
    // return() runs is the crossing br's inlined close.
    expect(state.returns).toBe(1);
  });

  it("labeled continue of the outer loop closes the inner iterator each crossing", async () => {
    const { iterable, state } = trackedIterable([1, 2, 3, 4, 5]);
    const result = await runIr(
      `
        export function test(s: Set<number>): number {
          let n = 0;
          outer: for (let i = 0; i < 3; i++) {
            for (const x of s) {
              n = n + 1;
              continue outer;
            }
          }
          return n;
        }
      `,
      iterable,
    );
    expect(result).toBe(3); // one element consumed per outer iteration
    expect(state.iterators).toBe(3); // fresh iterator per outer iteration
    expect(state.returns).toBe(3); // each closed by the crossing continue
  });

  it("labeled break TARGETING the for-of itself closes exactly once (no double close)", async () => {
    const { iterable, state } = trackedIterable([1, 2, 3, 4, 5]);
    const result = await runIr(
      `
        export function test(s: Set<number>): number {
          let n = 0;
          outer: for (const x of s) {
            n = n + 1;
            for (let j = 0; j < 3; j++) {
              if (j === 0) { break outer; }
            }
          }
          return n;
        }
      `,
      iterable,
    );
    // The br targets the forof frame → lands AT the loop's own close call;
    // the resolver must NOT emit an extra close for the matched frame.
    expect(result).toBe(1);
    expect(state.iterators).toBe(1);
    expect(state.returns).toBe(1);
  });
});
