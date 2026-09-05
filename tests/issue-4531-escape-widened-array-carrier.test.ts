// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #4531 — an array literal of closed object structs whose value escapes into an
// untyped (implicit-any) call argument must pick the externref element carrier,
// and the BINDING's slot must widen with it: a checker-derived closed-struct vec
// slot forces a vec→vec converting copy whose per-element ref.test nulls every
// open-representation element (the diff-sequences transposed-callbacks shape).

import { describe, it } from "vitest";

import { assertEquivalent } from "./equivalence/helpers.js";

describe("#4531 escape-widened array carriers", () => {
  it("round-trips a pushed wrapper object through an opaque callee (diff-sequences shape)", async () => {
    await assertEquivalent(
      `const inner = (flip, callbacks) => {
         if (flip && callbacks.length === 1) {
           const { f, g } = callbacks[0];
           callbacks.push({
             f: (x, y) => f(y, x),
             g: (x, y) => g(y, x),
           });
         }
         const { f, g } = callbacks[flip ? 1 : 0];
         return '' + f(1, 2) + g(3, 4);
       };
       function run(f, g, flip) {
         const callbacks = [{ f, g }];
         return inner(flip, callbacks);
       }
       export function test(): string {
         const direct = run((x, y) => 'f' + x + y, (x, y) => 'g' + x + y, false);
         const flipped = run((x, y) => 'f' + x + y, (x, y) => 'g' + x + y, true);
         return direct + '|' + flipped;
       }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("keeps a non-escaping closed-struct array on its typed carrier", async () => {
    await assertEquivalent(
      `export function test(): number {
         const records = [{ a: 1 }, { a: 2 }, { a: 3 }];
         let sum = 0;
         for (let i = 0; i < records.length; i++) sum += records[i].a;
         return sum;
       }`,
      [{ fn: "test", args: [] }],
    );
  });
});
