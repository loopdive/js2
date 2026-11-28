---
id: 7643
title: "Standalone runtime eval: `Function` as a value, or a `new Function` source with a function expression, throws a bare `undefined`"
status: ready
sprint: current
created: 2026-11-28
updated: 2026-11-28
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: runtime-eval
goal: runtime-eval
related: [2928, 7487, 7632, 7633]
---

# #7643: reading `%Function%`, or creating a function inside `new Function`, throws `undefined`

## Problem

On `--target standalone`, linked to the interpreter provider, two kinds of program throw the primitive `undefined`.
A TypeError would be the expected failure:

1. **`Function` read as a value in AOT code.** `function k(): any { const F: any = Function; return F; }`, then a bare
   `k()` throws. No interpreted code runs.
2. **A `new Function` source that contains a function expression.** It throws at creation, even when the function is
   never called:
   - `new Function("d = function () { return 5; };")`;
   - `new Function("var q = function () { return 5; }; return q();")`;
   - `new Function("return function () { return 5; };")`.

Plain sources work: `new Function("v = 7;")()`, `new Function("return typeof v;")()` and `new Function("return 3;")()`.

**It is not the cross-module tag of #7633.** A `try { … } catch (e)` in the AOT code always catches the throw. What it
receives is `typeof e === "undefined"`, `e === undefined`, with no message. The provider's error envelope itself works:
`new Function("throw new TypeError('boom');")()` arrives as `TypeError: boom`.

This is where the reviewer's "interpreted function assigned to `d`, then `d()` from AOT" throw comes from (PR #7572
review). It is trigger 2, plus trigger 1 when the program also reads `Function` as a value. It does not depend on `d`
being called from AOT.

**Unverified hypothesis.** Both triggers need the realm's `%Function%` intrinsic as a value:
- trigger 1 lowers to `indirect_eval("Function")` (`emitStandaloneIntrinsicFunctionValue`,
  `src/codegen/expressions/eval-inline.ts`);
- trigger 2 creates an interpreted function object, which needs Function's prototype and constructor.

Fetching it fails, and the failure crosses the boundary as a bare `undefined` rather than as an error. Two things to
pin down: where the `undefined` is thrown, and why the error value is lost.

## Measurement (main ea628a78, 2026-11-28)

Built and linked as in the PR #7572 review. The tier line must read
`runtime-eval tier: INTERPRETER (key f62231f0a9c53637, TEST262_FULL_RUNTIME_EVAL=1)`. Any `src/` edit changes the
cache key and silently drops to the refusal tier, so rebuild after each edit.

```bash
TEST262_FULL_RUNTIME_EVAL=1 JS2WASM_EVAL_ENGINE=interpreter node --max-old-space-size=6144 --import tsx scripts/build-runtime-eval-provider.mjs
TEST262_FULL_RUNTIME_EVAL=1 JS2WASM_EVAL_ENGINE=interpreter node --max-old-space-size=4096 --import tsx .tmp/rt7643.mts
```

`.tmp/rt7643.mts`:

```ts
import { compile } from "../src/index.ts";
import { instantiateTest262Module } from "../scripts/test262-import-object.mjs";

const src = `
function d(): number { return 1; }
var v: any = 1;
var lastMessage: string = "";
function k(): any { const F: any = Function; return F; }
function codeOf(e: any): number {
  const m: string = "" + (e && e.message);
  lastMessage = (typeof e) + "|" + (e === undefined ? "U" : e === null ? "N" : "v") + "|" + ("" + e).slice(0, 60);
  const cls = e instanceof TypeError ? 1 : e instanceof ReferenceError ? 2 : e instanceof SyntaxError ? 3 : e instanceof Error ? 5 : 9;
  return cls * 1000000 + m.length * 1000 + (m.length > 0 ? m.charCodeAt(0) : 0);
}
export function msgChar(i: number): number { return i < lastMessage.length ? lastMessage.charCodeAt(i) : -1; }
export function e1(): number { try { new Function("d = function () { return 5; };")(); return 1; } catch (e) { return codeOf(e); } }
export function e2(): number { try { new Function("d = function () { return 5; };"); return 1; } catch (e) { return codeOf(e); } }
export function e3(): number { try { new Function("throw new TypeError('boom');")(); return 1; } catch (e) { return codeOf(e); } }
export function e4(): number { try { new Function("var q = function () { return 5; }; return q();")(); return 1; } catch (e) { return codeOf(e); } }
export function e5(): number { try { return new Function("return function () { return 5; };")() === undefined ? 2 : 1; } catch (e) { return codeOf(e); } }
export function e6(): number { try { k(); return 1; } catch (e) { return codeOf(e); } }
export function e7(): number { try { k(); return new Function("return 3;")() === 3 ? 1 : 0; } catch (e) { return codeOf(e); } }
export function e8(): number { try { return new Function("return typeof v;")() === "number" ? 1 : 0; } catch (e) { return codeOf(e); } }
`;
const r = await compile(src, { fileName: "rt7643.ts", inferModuleStrictArguments: false, skipSemanticDiagnostics: true, target: "standalone" });
if (!r.success) throw new Error(r.errors.map((e: any) => e.message).join(" | "));
const ex = (await instantiateTest262Module(r.binary, {}, { target: "standalone", providerLabel: "rt7643" })).exports as any;
for (const f of ["e1", "e2", "e3", "e4", "e5", "e6", "e7", "e8"]) {
  const value = ex[f]();
  let message = "";
  if (value >= 1000000) for (let i = 0; i < 80; i++) { const c = ex.msgChar(i); if (c < 0) break; message += String.fromCharCode(c); }
  console.log(f, value, message);
}
```

| probe | source | result |
| ----- | ------ | ------ |
| e1 | `new Function("d = function () {…};")()` | throws `undefined` |
| e2 | `new Function("d = function () {…};")`, not called | throws `undefined` |
| e3 | `new Function("throw new TypeError('boom');")()` | caught `TypeError: boom` (control) |
| e4 | `"var q = function () {…}; return q();"` | throws `undefined` |
| e5 | `"return function () {…};"` | throws `undefined` |
| e6 | `k()` (AOT reads `Function` as a value) | throws `undefined` |
| e7 | `k()`, then `new Function("return 3;")()` | throws `undefined` |
| e8 | `new Function("return typeof v;")()` | 1 (passes) |

## Acceptance

- e1–e7 answer as node does:
  - e6 and e7 return 1 and 1;
  - e1, e2 and e4 return 1;
  - e5 returns 1.
- A provider failure that does occur crosses as its error value, never as a bare `undefined`.
- The probe becomes a test, run against the interpreter tier.
