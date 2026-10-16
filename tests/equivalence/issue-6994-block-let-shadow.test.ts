// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6994 — a block-scoped `let`/`const` sharing its name with a module global,
// a module function or a nested function declaration resolved wrong:
//   (a) `hoistLetConstWithTdz` pass 2 claims a FUNCTION-level slot for the
//       nested block's name; the block's save/restore treated that slot as the
//       outer binding and reinstalled it at block exit, so post-block reads of
//       the real outer binding saw 0 / null / a trap. When the outer binding was
//       a nested function DECLARATION of the same body, the declaration even
//       adopted the block's slot (and its type).
//   (b) a call inside the block resolved to the nested declaration
//       (`nestedBindingVisible`) instead of the block's own closure binding.
//
// Every case runs on BOTH lanes: the default JS-host (gc) lane and
// `target: "standalone"`, each compared with native JS.
import { describe, expect, it } from "vitest";
import { compile } from "../../src/index.js";
import { assertEquivalent, evaluateAsJs } from "./helpers.js";

async function assertStandaloneEquivalent(source: string): Promise<void> {
  const result = await compile(source, { fileName: "issue-6994.ts", target: "standalone" });
  expect(result.success, result.errors.map((e) => `L${e.line}: ${e.message}`).join("\n")).toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  const exports = instance.exports as Record<string, () => unknown>;
  exports.__module_init?.();
  expect(exports.test!()).toBe(evaluateAsJs(source).test!());
}

const cases: [string, string][] = [
  [
    "block let shadowing a module let: post-block read sees the module binding",
    `let f = 1;
     export function test(): number { let r = 0; { let f = 7; r = f; } return r * 10 + f; }`,
  ],
  [
    "block const shadowing a module const",
    `const f = 3;
     export function test(): number { let r = 0; { const f = 5; r = f; } return r * 10 + f; }`,
  ],
  [
    "sibling blocks each shadowing a module let",
    `let f = 1;
     export function test(): number { let r = 0; if (r === 0) { let f = 2; r += f; } else { let f = 3; r += f; } { let f = 4; r += f; } return r * 10 + f; }`,
  ],
  [
    "nested function declaration vs block let closure: inner call takes the closure",
    `export function test(): number {
       function f(): number { return 1; }
       let a = f(); { let f = (): number => 2; a += f() * 10; } return a + f() * 100;
     }`,
  ],
  [
    "module function vs block let closure: post-block call reaches the module function",
    `function f(): number { return 1; }
     export function test(): number { let a = f(); { let f = (): number => 2; a += f() * 10; } return a + f() * 100; }`,
  ],
  [
    "nested function declaration vs block let number: post-block call",
    `export function test(): number {
       function f(): number { return 1; }
       let a = f(); { let f = 7; a += f * 10; } return a + f() * 100;
     }`,
  ],
  [
    "module function vs block let number",
    `function f(): number { return 1; }
     export function test(): number { let a = f(); { let f = 7; a += f * 10; } return a + f() * 100; }`,
  ],
  [
    "fn-decl-hoisted-over-let-shadow-in-block (declaration after the block)",
    `export function test(): number {
       let a = 0; { let f = (): number => 2; a += f() * 10; } a += f() * 100; return a;
       function f(): number { return 1; }
     }`,
  ],
  [
    "nested function used as a value vs block let closure",
    `export function test(): number {
       function f(): number { return 1; } const h = f;
       let a = f(); { let f = (): number => 2; a += f() * 10; } return a + f() * 100 + h() * 1000;
     }`,
  ],
  [
    "nested function with a capture vs block let closure",
    `export function test(): number {
       let k = 1; function f(): number { return k; }
       let a = f(); { let f = (): number => 2; a += f() * 10; } return a + f() * 100;
     }`,
  ],
  [
    "nested function vs block const function expression",
    `export function test(): number {
       function f(): number { return 1; }
       let a = 0; { const f = function (): number { return 3; }; a += f() * 10; } return a + f();
     }`,
  ],
  [
    "block function declaration vs inner block let closure",
    `export function test(): number {
       let a = 0; { function f(): number { return 1; } a += f(); { let f = (): number => 2; a += f() * 10; } a += f() * 100; } return a;
     }`,
  ],
  [
    "block let captured by a block function declaration, module global of the same name",
    `let x = 100;
     export function test(): number { let r = 0; { let x = 7; function g(): number { return x; } r = g(); } return r + x; }`,
  ],
  [
    "var shadow of a module function reads the var",
    `function f(): number { return 1; }
     export function test(): number { var f: any = 2; return f; }`,
  ],
];

describe("#6994 block-scoped shadow of a module / nested function binding", () => {
  for (const [name, src] of cases) {
    it(`gc: ${name}`, async () => {
      await assertEquivalent(src, [{ fn: "test", args: [] }]);
    }, 60_000);
    it(`standalone: ${name}`, async () => {
      await assertStandaloneEquivalent(src);
    }, 60_000);
  }
});
