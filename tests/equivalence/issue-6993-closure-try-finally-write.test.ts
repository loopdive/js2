// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6993 — a closure first constructed inside a `try` block (or catch clause)
// boxed its capture AFTER the `finally` body had been pre-compiled against the
// raw slot, so a write (or read) of the binding in the finally missed the
// closure's cell. compileTryStatement now pre-boxes the shared bindings before
// it compiles the finally (closures/try-capture-prebox.ts).
//
// Every case runs on BOTH lanes: the default JS-host (gc) lane and
// `target: "standalone"`, each compared with native JS.
import { describe, expect, it } from "vitest";
import { compile } from "../../src/index.js";
import { assertEquivalent, evaluateAsJs } from "./helpers.js";

async function assertStandaloneEquivalent(source: string): Promise<void> {
  const result = await compile(source, { fileName: "issue-6993.ts", target: "standalone" });
  expect(result.success, result.errors.map((e) => `L${e.line}: ${e.message}`).join("\n")).toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  const exports = instance.exports as Record<string, () => unknown>;
  exports.__module_init?.();
  expect(exports.test!()).toBe(evaluateAsJs(source).test!());
}

const cases: [string, string][] = [
  [
    "var written in finally, closure returned from try",
    `function f(): () => number { var x = 0; try { return function () { return x; }; } finally { x = 5; } }
     export function test(): number { return f()(); }`,
  ],
  [
    "let incremented in finally, arrow returned from try",
    `function f(): () => number { let x = 0; try { return () => x; } finally { x++; } }
     export function test(): number { return f()(); }`,
  ],
  [
    "nested try/finally, both finallys write",
    `function f(): () => number { let x = 0; try { try { return () => x; } finally { x += 2; } } finally { x += 3; } }
     export function test(): number { return f()(); }`,
  ],
  [
    "two-level closure nesting",
    `function f(): () => () => number { let x = 0; try { return () => () => x; } finally { x = 4; } }
     export function test(): number { return f()()(); }`,
  ],
  [
    "closure built in try, catch writes (control: catch compiles after try)",
    `function f(): () => number { let x = 0; let g: () => number = () => -1; try { g = () => x; throw 1; } catch (e) { x = 9; } return g; }
     export function test(): number { return f()(); }`,
  ],
  [
    "closure built in catch, finally writes",
    `function f(): () => number { let x = 0; try { throw 1; } catch (e) { return () => x; } finally { x = 7; } }
     export function test(): number { return f()(); }`,
  ],
  [
    "throwing try: catch and finally both write",
    `function f(): () => number { let x = 0; let g: () => number = () => -1; try { g = () => x; throw new Error("e"); } catch (e) { x += 1; } finally { x += 10; } return g; }
     export function test(): number { return f()(); }`,
  ],
  [
    "no return: finally write seen by closure and by the frame",
    `export function test(): number { let x = 0; let g: () => number = () => -1; try { g = () => x; } finally { x = 6; } return g() + x; }`,
  ],
  [
    "finally reads a value the try wrote through the closure's cell",
    `export function test(): number { let x = 0; let r = 0; try { const g = () => x; x = 4; r = g(); } finally { r = r * 10 + x; } return r; }`,
  ],
  [
    "closure first built in finally sees the try block's write",
    `export function test(): number { let x = 0; let g: () => number = () => -1; try { x = 3; } finally { g = () => x; } x += 10; return g(); }`,
  ],
  [
    "parameter written in finally",
    `function f(x: number): () => number { try { return () => x; } finally { x = x * 2; } }
     export function test(): number { return f(21)(); }`,
  ],
  [
    "var declared in try, written in finally",
    `function f(): () => number { try { var x = 1; return () => x; } finally { x = 8; } }
     export function test(): number { return f()(); }`,
  ],
  [
    "try in a conditional arm; the skipping path keeps the raw value",
    `function f(c: boolean): number { let x = 1; let g: () => number = () => -1; if (c) { try { g = () => x; } finally { x = 2; } } x += 100; return g() + x; }
     export function test(): number { return f(true) * 1000 + f(false); }`,
  ],
  [
    "block-scoped shadow inside try is a different binding",
    `export function test(): number { let x = 1; let g: () => number = () => -1; try { let x = 2; g = () => x; } finally { x = 9; } return g() * 100 + x; }`,
  ],
  [
    "string capture",
    `export function test(): number { let s = "a"; let g: () => string = () => ""; try { g = () => s; } finally { s = "abc"; } return g().length; }`,
  ],
  [
    "module-level try/finally",
    `let x = 0; let g: () => number = () => -1; try { g = () => x; } finally { x = 5; }
     export function test(): number { return g(); }`,
  ],
];

describe("#6993 closure built in try sees writes made in finally", () => {
  for (const [name, src] of cases) {
    it(`gc: ${name}`, async () => {
      await assertEquivalent(src, [{ fn: "test", args: [] }]);
    }, 60_000);
    it(`standalone: ${name}`, async () => {
      await assertStandaloneEquivalent(src);
    }, 60_000);
  }
});
