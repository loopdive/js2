// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1452 — for-statement initializer binding patterns must register their
// bound names in the loop's lexical scope.
//
// Two bugs were stacked here:
//
//  1. The scope-bookkeeping loop in `compileForStatement` only walked
//     `ts.isIdentifier(decl.name)` declarations, so for-loop bindings
//     introduced by an array / object / nested / rest pattern were not
//     saved-and-cleared from the outer scope. The pattern bindings then
//     leaked into the enclosing function after the loop exited (and
//     stomped any shadowed outer binding for the rest of the function).
//
//  2. The externref array fallback, the vec-struct array form, and the
//     tuple-struct array form of array destructuring assigned each
//     binding's local but never flipped its TDZ flag to "initialized".
//     The first read inside the loop body therefore tripped the TDZ
//     check and threw `ReferenceError: x is not defined` even though
//     `local.set $x` had run.
//
// Fix:
//
//  * `collectPatternBindingNames` (new in `tdz.ts`) yields every
//    identifier name a `BindingName` introduces, including aliased
//    object properties (`{a: y}` → `y`) and rest elements
//    (`[...rest]` → `rest`).
//  * `compileForStatement` walks every declaration through the new
//    helper and runs the existing save/clear/restore flow per name.
//  * `syncDestructuredLocalsToGlobals` (the central
//    "destructure complete" sink for both array and object destructuring)
//    now calls `emitLocalTdzInit` per leaf identifier — a no-op for
//    non-let/const bindings, but the missing flip for every destructuring
//    branch that wasn't routing through the struct-path inline
//    `emitLocalTdzInit` already in place.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

interface RunResult {
  exports: Record<string, Function>;
}

async function run(src: string): Promise<RunResult> {
  const result = await compile(src, { fileName: "test.ts" });
  if (!result.success) {
    throw new Error(`compile failed:\n${result.errors.map((e) => `  L${e.line}:${e.column} ${e.message}`).join("\n")}`);
  }
  const importResult = buildImports(result.imports as never, undefined, result.stringPool);
  const inst = await WebAssembly.instantiate(result.binary, importResult as never);
  if (typeof (importResult as { setExports?: Function }).setExports === "function") {
    (importResult as { setExports: Function }).setExports(inst.instance.exports);
  }
  return { exports: inst.instance.exports as Record<string, Function> };
}

describe("#1452 — for-loop binding-pattern bindings are visible inside the body", () => {
  it("array pattern: single identifier binding is readable", async () => {
    const { exports } = await run(`
      export function test(): number {
        let n = 0;
        for (let [x] = [42]; n < 1; n++) {
          return x;
        }
        return -1;
      }
    `);
    expect(exports.test!()).toBe(42);
  });

  it("array pattern: multiple identifiers visible", async () => {
    const { exports } = await run(`
      export function test(): number {
        let n = 0;
        for (let [a, b] = [10, 20]; n < 1; n++) {
          return a + b;
        }
        return -1;
      }
    `);
    expect(exports.test!()).toBe(30);
  });

  it("object pattern (regression — already worked, lock it in)", async () => {
    const { exports } = await run(`
      export function test(): number {
        let n = 0;
        for (let {a, b} = {a: 10, b: 20}; n < 1; n++) {
          return a + b;
        }
        return -1;
      }
    `);
    expect(exports.test!()).toBe(30);
  });

  it("object pattern with renamed bindings: {a: x}", async () => {
    const { exports } = await run(`
      export function test(): number {
        let n = 0;
        for (let {a: x, b: y} = {a: 1, b: 2}; n < 1; n++) {
          return x * 10 + y;
        }
        return -1;
      }
    `);
    expect(exports.test!()).toBe(12);
  });

  it("rest pattern: [first, ...rest] binds both first and rest", async () => {
    const { exports } = await run(`
      export function test(): number {
        let n = 0;
        for (let [first, ...rest] = [1, 2, 3, 4]; n < 1; n++) {
          return first + rest.length;
        }
        return -1;
      }
    `);
    expect(exports.test!()).toBe(4);
  });

  it("nested array pattern: [[a, b]] binds inner names", async () => {
    const { exports } = await run(`
      export function test(): number {
        let n = 0;
        for (let [[a, b]] = [[5, 7]]; n < 1; n++) {
          return a + b;
        }
        return -1;
      }
    `);
    expect(exports.test!()).toBe(12);
  });
});

describe("#1452 — outer scope shadowing is reversible (per-loop block scope)", () => {
  it("array pattern shadow: outer x restored after loop", async () => {
    const { exports } = await run(`
      export function test(): number {
        let x = 100;
        for (let [x] = [42]; false; ) {}
        return x; // expect 100, not 42
      }
    `);
    expect(exports.test!()).toBe(100);
  });

  it("object pattern shadow: outer a restored after loop", async () => {
    const { exports } = await run(`
      export function test(): number {
        let a = 99;
        for (let {a} = {a: 1}; false; ) {}
        return a; // expect 99, not 1
      }
    `);
    expect(exports.test!()).toBe(99);
  });

  it("renamed object pattern shadow: outer y restored after loop", async () => {
    const { exports } = await run(`
      export function test(): number {
        let y = 77;
        for (let {a: y} = {a: 5}; false; ) {}
        return y; // expect 77, not 5
      }
    `);
    expect(exports.test!()).toBe(77);
  });

  it("rest binding shadow: outer rest restored after loop", async () => {
    const { exports } = await run(`
      export function test(): number {
        const rest: number[] = [];
        rest.push(1);
        rest.push(2);
        for (let [_, ...rest] = [9, 10, 11]; false; ) {}
        return rest.length; // outer rest unchanged → length 2
      }
    `);
    expect(exports.test!()).toBe(2);
  });
});

describe("#1452 — identifier-only declarations remain correct (regression net)", () => {
  it("simple let counter still works", async () => {
    const { exports } = await run(`
      export function test(): number {
        let sum = 0;
        for (let i = 0; i < 5; i++) sum += i;
        return sum; // 0+1+2+3+4 = 10
      }
    `);
    expect(exports.test!()).toBe(10);
  });

  it("for-of with array destructuring (sibling path — must still pass)", async () => {
    const { exports } = await run(`
      export function test(): number {
        let sum = 0;
        for (const [a, b] of [[1, 2], [3, 4]]) {
          sum += a * 10 + b;
        }
        return sum;
      }
    `);
    expect(exports.test!()).toBe(46);
  });
});
