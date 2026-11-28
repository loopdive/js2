---
id: 7643
title: "Standalone runtime eval: `Function` as a value, or a `new Function` source with a function expression, throws a bare `undefined`"
status: in-progress
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

## Root cause (measured 2026-11-28, main a755911c)

The hypothesis above is wrong. Neither trigger is specific to `Function`.

**Every global-scope provider entry with a dynamic source throws `undefined`.** `(0, eval)(dyn("1 + 1"))` and
`new Function(dyn("return 3;"))()` both throw. My earlier passing probes used *literal* sources, which the compiler
folds and never sends to the provider. Both triggers reach the provider:
- trigger 1, because `Function` as a value lowers to `indirect_eval("Function")`;
- trigger 2, because a source with a nested function is not folded.

**It works whenever the program also contains a direct-eval site, even dead code.** Linked by hand, the same program
returns 2 and 3 once `function never() { if (false) eval(dyn("0")); }` is added. The difference between the two
modules is the finality of the shared runtime value types:

| type | no direct-eval site | with one |
| ---- | ------------------- | -------- |
| `$__vec_externref`, `$__vec_f64`, `$ConsString`, `$HashedString` | `sub final` | `sub` |

`finalizeLeafStructTypes` (`src/codegen/index.ts`) marks a leaf struct final unless something subtypes it. A direct
eval pulls in the object runtime (`$__regexp_match_vec`, `$__arguments_vec_externref`, …), which subtypes those
types, so they stay open. The provider contains such subtypes too, so its copies are open. WasmGC treats a final and
a non-final type as different types. So in a consumer with no subtype:
- `__extern_get_idx` cannot see into the provider's result envelope (`$__vec_externref`): both reads return
  `undefined`, and `emitRuntimeEvalResultUnwrap` throws the "error" value, which is `undefined`;
- a provider-minted string is no `$AnyString` to the consumer.

#5383 S2k already names this hazard and pins the ABI roots open, but only when `ctx.mod.canonicalRuntimeRecGroup` is
set. The runtime-eval seam deliberately does not opt into the rec group (`create-context.ts`: "older provider seams
(notably QuickJS runtime-eval) already share their own established type layout"). So its finality was left to each
module's content.

## Implementation Plan

**Module.** `finalizeLeafStructTypes` in `src/codegen/index.ts`, the one place that decides finality.

**Change.** The keep-open rule for the `RUNTIME_RECGROUP_TYPE_NAMES` members applies when
`ctx.mod.canonicalRuntimeRecGroup !== undefined || linksRuntimeEvalProvider(ctx)`. The existing #5383 S2k comment
gains one sentence: the runtime-eval seam shares the same types without the group, so a module that links it pins
them open too.

**Reuse / duplicate removed.**
- `linksRuntimeEvalProvider(ctx)` already exists, private, in `src/codegen/iterator-native.ts:496` (#6651 A9).
- It moves to `src/codegen/expressions/runtime-eval-provider.ts`, the seam's owner, as an export. Both callers import
  it.
- No new predicate.

**The provider side.** The provider imports nothing from the seam, so this rule does not touch it. Its binary is
byte-identical with the prototype (sha `c3e1df7a…`, 7,154,870 bytes). Its types are open today only because of its
content. Pinning them there too, for example through the boundary plan's `provider-definition` site, would make the
seam robust both ways. **Left out on purpose**: no provider today is affected, and the rule cannot reach a provider
without a second predicate. Noted for the review to accept or reject.

**Tests.**
- `tests/issue-7643-runtime-eval-abi-finality.test.ts`:
  - (a) structural, red on main: a module with an indirect eval and no direct-eval site (gc and standalone) declares
    `$__vec_externref` and `$AnyString`'s string subtypes non-final;
  - (b) a control: a module that links no provider keeps `sub final`, so the rule stays scoped.
- The e1–e8 runtime probe needs the interpreter-tier provider build, so it stays PR evidence, not a test.

**Byte identity (prototype vs main a755911c; 150 eval/`Function` test262 files; assert + sta harness).**
- gc, standalone and Prepared: 33/150 differ as is, and 32/150 with `any`/`string` exports appended. All compiles
  succeed.
- WAT diff on a changed file (`built-ins/Function/15.3.2.1-10-6gs.js`), gc and standalone: exactly four lines change,
  `sub final` → `sub` on the four types above. Nothing else changes.
- Modules that link no provider cannot change, because the rule is gated on the import.
- **gc bytes change** for eval modules without a direct-eval site, which needs the owner's OK. The PR repeats the A/B
  on main after #7572 (a755911c predates it).

**Probes with the prototype (interpreter tier).**
- e1–e8 all answer as the acceptance requires (1, except e3, which catches `TypeError: boom`).
- `(0, eval)(dyn("Function"))` gives a function, and `typeof Object` gives `"function"`.
- Nested function expressions and an object literal work.

**Seen while probing, not this issue.** `(0, eval)(dyn("noSuchName"))` throws `ReferenceError:
intrinsicErrorConstructor is not defined`, where the message should name `noSuchName`. It needs its own id.

## Acceptance

- e1–e8 answer as node does (e3 catches `TypeError: boom`; the others return 1), on the interpreter tier.
- `(0, eval)(dyn(...))` and `new Function(dyn(...))` work in a module with no direct-eval site.
- The structural test is red on main and green after. Its control shows a module without the seam is unchanged.
- The byte A/B changes only the four ABI types' finality, and only in modules that import `js2wasm:runtime-eval`.
- Code quality:
  - one predicate, moved to the seam's module (no copy);
  - the existing keep-open rule is extended rather than given a sibling;
  - no change to the rec-group opt-in.
