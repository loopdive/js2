---
id: 7643
title: "Standalone runtime eval: `Function` as a value, or a `new Function` source with a function expression, throws a bare `undefined`"
status: done
completed: 2026-11-28
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
returns 2 and 3 once `function never() { if (false) eval(dyn("0")); }` is added. Both sides decide the finality of the
shared runtime value types from their own content. `finalizeLeafStructTypes` (`src/codegen/index.ts`) marks a leaf
struct final unless something in the module subtypes it, and WasmGC treats a final and a non-final type as different
types.

| `RUNTIME_RECGROUP_TYPE_NAMES` member | provider (cached build) | consumer, no direct-eval site | consumer, with one |
| ------------------------------------ | ----------------------- | ----------------------------- | ------------------ |
| `$__vec_externref`                    | open                    | `final`                       | open               |
| `$__vec_f64`, `$ConsString`, `$HashedString` | `final` (PRV-7643, wasm-dis) | `final` | `final` (PRV-7643) |

So the two sides agree only by accident, type by type:
- **`$__vec_externref` (the result envelope).** It mismatches in a consumer without a direct-eval site.
  `__extern_get_idx` cannot see into the provider's envelope, so both reads return `undefined`, and
  `emitRuntimeEvalResultUnwrap` throws the "error" value, which is `undefined`. This is #7643.
- **The string types.** They match today only because both sides happen to be `final`. Opening them on one side
  alone breaks provider-built ropes (PRV-7643):
  - `var a = "abc…z"; var b = a; for (6×) b = b + a; b` returns a provider rope;
  - `length`, `charCodeAt` and `slice` on it trap "illegal cast" when only the consumer's `$ConsString` is open;
  - on main, the direct-eval module returns the right answer.

The gc lane fails too, with `RangeError: stack overflow` (PRV-7643), so the fix there is a repair, not a cosmetic byte
change.

#5383 S2k names this hazard: "finality of an ABI root must be a CONSTANT of the ABI, never a function of what the
individual module happens to subtype". It pins the members open only under `ctx.mod.canonicalRuntimeRecGroup`, which
the runtime-eval seam deliberately does not use (`create-context.ts`: "older provider seams (notably QuickJS
runtime-eval) already share their own established type layout"). So for this seam the constant was never set, on
either side.

## Implementation Plan

**Rule.** Every `RUNTIME_RECGROUP_TYPE_NAMES` member is open on **both** sides of the runtime-eval seam: in a consumer
that imports `js2wasm:runtime-eval`, and in a build that defines the provider ABI. Finality becomes a constant of the
seam, as #5383 S2k requires, instead of an accident of content.

**Module.** `finalizeLeafStructTypes` (`src/codegen/index.ts`). Its keep-open condition becomes
`ctx.mod.canonicalRuntimeRecGroup !== undefined || sharesRuntimeEvalValueAbi(ctx)`, and the #5383 S2k comment gains
one sentence: the runtime-eval seam shares the same members without the group, on both sides.

**Predicate.** One export, `sharesRuntimeEvalValueAbi(ctx)`, in `src/codegen/expressions/runtime-eval-provider.ts`,
the seam's owner. It is true when either:
- the module imports `RUNTIME_EVAL_IMPORT_MODULE` (consumer);
- `ctx.runtimeEvalBoundaryPlan` has a `provider-definition` site (provider). That site already exists: the plan
  records it for every top-level `__runtime_*` ABI function (`isRuntimeEvalBoundaryProviderName`). It covers the real
  provider and the test stubs alike, with no new compile option and no reliance on `canonicalRuntimeTypes`.

**Reuse / duplicate removed.**
- The consumer half already exists: the private `linksRuntimeEvalProvider` in `src/codegen/iterator-native.ts:496`
  (#6651 A9).
- It moves to `runtime-eval-provider.ts`, and `sharesRuntimeEvalValueAbi` calls it.
- iterator-native keeps asking its own, narrower question (does this unit import the provider?). That question must
  stay false for the provider build, or the provider's iterator bytes would change. So iterator-native imports the
  moved helper.
- Result: one consumer predicate (moved, not copied) and one seam predicate built on it. There is no second
  consumer-link sibling.

**Tests** (`tests/issue-7643-runtime-eval-abi-finality.test.ts`):
- (i) **Unit:** the predicate holds for a consumer, for a provider-shaped source (an `export function
  __runtime_indirect_eval(…)`) and for neither. After `finalizeLeafStructTypes`, every group member is open in the
  first two and unchanged in the third.
- (ii) **Both sides agree:** the finality of every group member in the cached interpreter provider equals the
  consumer's, read structurally from the binaries or via `canonicalHashOfTypeGroup`. This is the property the bug
  violates, independent of which type happens to mismatch.
- (iii) **Control:** a module with no runtime-eval import and no provider definition keeps its leaf finality, so the
  rule stays scoped.
- The e1–e8 runtime probes and PRV-7643's rope probe s1 need the interpreter-tier provider build, so they are PR
  evidence, not tests.

**Byte identity.** These change by design:
- the provider binary, and with it the cache key;
- every consumer whose group members were `final`, including direct-eval modules, whose `$__vec_f64` and string types
  flip too;
- **gc included**, which is broken today (stack overflow).

Modules with neither shape cannot change. The implementation PR reruns the A/B on current main (after #7572) over:
- the 150 eval/`Function` test262 files, as is and with exports appended, on gc, standalone and Prepared;
- the provider binary;
- a direct-eval-only sample.

It must show that the only WAT difference in each changed module is finality on group members.

**Evidence to rerun with the implementation (interpreter tier).**
- e1–e8;
- PRV-7643's s1–s7, including the rope probe;
- `(0, eval)(dyn("Function"))`, `typeof Object`, nested functions and an object literal.

PRV-7643 measured that all ten members open on both sides makes s1–s7 match the baseline and every repro return 1.

**Seen while probing, not this issue.** `(0, eval)(dyn("noSuchName"))` throws `ReferenceError:
intrinsicErrorConstructor is not defined`, where the message should name `noSuchName`. It needs its own id.

## Result (implementation, main 02f43e19 = a755911c + #7572)

**Code.**
- `sharesRuntimeEvalValueAbi` is exported from `src/codegen/expressions/runtime-eval-provider.ts`. It is true when
  the module imports the provider, or when the boundary plan has a `provider-definition` site.
- `linksRuntimeEvalProvider` moved there from `iterator-native.ts`, which imports it.
- `finalizeLeafStructTypes` keeps every group member open on both sides. The comment on that rule was wrong: it said
  the gc lane stays byte-identical. It now says what the rule covers.

**Test.** `tests/issue-7643-runtime-eval-abi-finality.test.ts`, gc and standalone:
- the consumer has every member open;
- a provider-shaped build has every member open. Like the real provider, it subtypes `$__vec_externref` through
  `arguments[0]`;
- both sides have the same finality;
- a no-seam control is unchanged.

On main, 6 of 8 rows fail (all but the control); with the fix, 8/8 pass. Both sides are compiled in-test, so the
both-sides check never depends on a cached provider (PRV-7643 note 1).

**Runtime (interpreter tier, standalone).**

| probe | main | fix |
| ----- | ---- | --- |
| e1, e2, e4–e7 | throw `undefined` | 1 |
| e3 | `TypeError: boom` | `TypeError: boom` |
| e8 | 1 | 1 |
| rope (PRV-7643 s1 shape: `length`, `charCodeAt` and `slice` checks), no direct-eval site | throws `undefined` | 7 (all three checks pass) |
| the same rope, with a direct-eval site | 7 | 7 |
| provider string `"x" + "y"`, no direct-eval site | throws `undefined` | `"xy"` |

**Bytes.**
- 150 eval/`Function` test262 files, gc, standalone and Prepared: 33/150 differ as is and 32/150 with exports
  appended. All 900 compiles succeed.
- Sampled changed modules, including two with a direct-eval site, gc and standalone: once `sub final` → `sub` is
  normalised, the diff is empty. The only change is `$__vec_externref`, `$__vec_f64`, `$ConsString` and
  `$HashedString` becoming non-final.
- Provider: the same size (7,154,870 bytes). Its `wasm-dis` diff is exactly types `$5`, `$44` and `$271`, from
  `sub final` to `sub`, and empty once normalised. Its cache key changes once.
- No test262 file declares a `__runtime_*` provider name (grep: 0 files), so no user program is classified as a
  provider by accident (PRV-7643 note 2).

**Pre-existing, unchanged.** Running the 2928 state-pool and #6651 files gives the same 24 failing rows on main and on
the fix.

## Acceptance

- e1–e8 answer as node does (e3 catches `TypeError: boom`; the others return 1), on gc and standalone, on the
  interpreter tier.
- PRV-7643's s1–s7 match the baseline, and the rope probe returns the right answer with and without a direct-eval site.
- Tests (i)–(iii) pass. (ii) fails on main.
- The byte A/B changes only group-member finality, only in modules with one of the two shapes and in the provider.
  The provider's cache key changes once, and the PR says so.
- Code quality:
  - one exported seam predicate, built on the moved helper, with no copy;
  - the existing keep-open rule is extended rather than given a sibling;
  - no change to the rec-group opt-in.
