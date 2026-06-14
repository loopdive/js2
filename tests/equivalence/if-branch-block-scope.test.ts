import { describe, it } from "vitest";
import { assertEquivalent } from "./helpers.js";

// #2064 — block-scoped (let/const) declarations inside if/else branch blocks
// must not leak into the enclosing scope. compileIfStatement iterated branch
// statements directly, bypassing the saveBlockScopedShadows/restore that the
// generic Block case applies, so an inner `let x` clobbered the outer binding
// in fctx.localMap (and an inner `const` leaked const-ness).
describe("if/else branch block scope does not leak (#2064)", () => {
  it("then-branch let shadow is restored", async () => {
    await assertEquivalent(
      `export function test(): number {
         let x = 1;
         const c: boolean = true;
         if (c) { let x = 2; x++; }
         return x; // must be 1
       }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("else-branch let shadow is restored", async () => {
    await assertEquivalent(
      `export function test(): number {
         let x = 1;
         const c: boolean = false;
         if (c) { x = 100; } else { let x = 2; x++; }
         return x; // must be 1
       }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("const-folded if (true) does not leak the inner binding", async () => {
    await assertEquivalent(
      `export function test(): number {
         let x = 1;
         if (true) { let x = 2; x++; }
         return x; // must be 1
       }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("inner const does not make the outer let constant", async () => {
    await assertEquivalent(
      `export function test(): number {
         let x = 1;
         const c: boolean = true;
         if (c) { const x = 9; }
         x = 7; // must be legal
         return x; // must be 7
       }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("nested if shadow and else-if chain", async () => {
    await assertEquivalent(
      `export function test(): number {
         let x = 10;
         const a: boolean = true;
         const b: boolean = false;
         if (a) {
           let x = 20;
           if (b) { let x = 30; } else { x += 1; }
         } else if (b) {
           const x = 99;
         }
         return x; // must be 10
       }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("inner binding value is used within the branch, outer restored after", async () => {
    await assertEquivalent(
      `export function test(): number {
         let total = 0;
         let x = 5;
         const c: boolean = true;
         if (c) { let x = 100; total += x; }
         total += x;
         return total; // 100 + 5 = 105
       }`,
      [{ fn: "test", args: [] }],
    );
  });
});
