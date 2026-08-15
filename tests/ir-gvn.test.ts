// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4424 — structure-tree GVN, end-to-end through the IR path.
//
// Observability note that shapes these cases: GVN merges only PURE
// operand-determined instructions, so a wrongly-SCOPED merge never changes
// the merged VALUE — it manifests as an AVAILABILITY bug (the lowerer reads
// a local the executed path never materialized, yielding the local's default
// instead of the computation). The scope-safety cases below are built so
// exactly that would show: the redundant expression is reused on a path
// where the earlier occurrence did not execute.
//
// The poison case is the liveness control (#4157's rule: a mechanism that
// never fired proves nothing): under `JS2WASM_IR_GVN=poison` a detected
// numeric duplicate is replaced with a garbage constant, so the result MUST
// differ from the correct one iff the merge actually fired on the executed
// path.
import { afterEach, describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function run(
  source: string,
  fnName: string,
  args: ReadonlyArray<number | boolean>,
  gvnMode: string | undefined,
): Promise<unknown> {
  const prev = process.env.JS2WASM_IR_GVN;
  // Biome disallows `delete process.env.X`; assigning undefined leaves the
  // STRING "undefined" behind, which is fine here only because gvnFromEnv
  // whitelists explicit on-tokens ("1"/"true"/"poison") — any other value,
  // including "undefined", reads as OFF.
  process.env.JS2WASM_IR_GVN = gvnMode;
  try {
    const r = await compile(source, { nativeStrings: true, experimentalIR: true });
    if (!r.success) throw new Error(`compile failed:\n${r.errors.map((e) => e.message).join("\n")}`);
    const { instance } = await WebAssembly.instantiate(r.binary, buildImports(r.imports, undefined, r.stringPool));
    return (instance.exports[fnName] as (...a: unknown[]) => unknown)(...args);
  } finally {
    process.env.JS2WASM_IR_GVN = prev; // see the assignment note above
  }
}

/** Flag-on must produce exactly the flag-off result for every arg tuple. */
async function sameOnAndOff(source: string, fn: string, argTuples: ReadonlyArray<ReadonlyArray<number | boolean>>) {
  for (const args of argTuples) {
    const off = await run(source, fn, args, undefined);
    const on = await run(source, fn, args, "1");
    expect(on, `args=${JSON.stringify(args)}`).toStrictEqual(off);
  }
}

afterEach(() => {
  process.env.JS2WASM_IR_GVN = undefined; // string "undefined" — an off-token
});

describe("#4424 structure-tree GVN — equivalence with the flag on", () => {
  it("straight-line redundancy", async () => {
    await sameOnAndOff(
      `export function f(x: number): number {
        const a = x * 2 + 1;
        const b = x * 2 + 1;
        return a + b;
      }`,
      "f",
      [[5], [0], [-3]],
    );
  });

  it("if-arm value reused after the join must not be served from the arm", async () => {
    // With a scope bug, the post-if occurrence is renamed to the then-arm's
    // id; on c=false that local was never materialized → wrong result.
    await sameOnAndOff(
      `export function f(c: boolean, x: number): number {
        let r = 0;
        if (c) { r = x * 3 + 1; }
        return (x * 3 + 1) + r;
      }`,
      "f",
      [
        [true, 4],
        [false, 4],
      ],
    );
  });

  it("then-arm entry must not serve the else arm", async () => {
    await sameOnAndOff(
      `export function f(c: boolean, x: number): number {
        let r = 0;
        if (c) { r = x * 7 - 2; } else { r = (x * 7 - 2) + 100; }
        return r;
      }`,
      "f",
      [
        [true, 3],
        [false, 3],
      ],
    );
  });

  it("loop-body value reused after the loop must not be served from the body", async () => {
    // With n=0 the body never runs; a leaked body entry would surface the
    // unmaterialized local instead of recomputing.
    await sameOnAndOff(
      `export function f(n: number, x: number): number {
        let acc = 0;
        for (let i = 0; i < n; i++) { acc = acc + (x * 5 + 3); }
        return acc + (x * 5 + 3);
      }`,
      "f",
      [
        [0, 2],
        [3, 2],
      ],
    );
  });

  it("redundancy within one loop iteration stays correct", async () => {
    await sameOnAndOff(
      `export function f(n: number, x: number): number {
        let acc = 0;
        for (let i = 0; i < n; i++) {
          acc = acc + (x * 4 + i) + (x * 4 + i);
        }
        return acc;
      }`,
      "f",
      [
        [4, 3],
        [0, 3],
      ],
    );
  });

  it("outer value reused inside a loop body stays correct", async () => {
    await sameOnAndOff(
      `export function f(n: number, x: number): number {
        const k = x * 9 + 7;
        let acc = 0;
        for (let i = 0; i < n; i++) { acc = acc + (x * 9 + 7); }
        return acc + k;
      }`,
      "f",
      [
        [3, 2],
        [0, 2],
      ],
    );
  });
});

describe("#4424 structure-tree GVN — poison liveness control", () => {
  it("poison mode changes the result of a program with a fired merge", async () => {
    const source = `export function f(x: number): number {
      const a = x * 2 + 1;
      const b = x * 2 + 1;
      return a + b;
    }`;
    const correct = await run(source, "f", [5], undefined);
    expect(correct).toBe(22);
    const withGvn = await run(source, "f", [5], "1");
    expect(withGvn).toBe(22);
    const poisoned = await run(source, "f", [5], "poison");
    // If the merge did not fire on the executed path, poisoned === correct
    // and this test rightly FAILS — a silent mechanism must not pass its own
    // liveness control.
    expect(poisoned).not.toBe(22);
  });
});
