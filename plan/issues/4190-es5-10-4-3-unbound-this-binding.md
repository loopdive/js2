---
id: 4190
title: "ES5 10.4.3 — unbound-receiver `this` is `undefined` in sloppy code, and an inlined IIFE inherits __module_init's `this`"
status: done
sprint: 78
priority: high
horizon: m
feasibility: hard
reasoning_effort: max
assignee: ttraenkler/W12-census-and-lever
goal: standalone-gap
completed: 2026-08-06
---

## Problem

Two independent defects in the same arm of codegen, both on the ES5 spec
algorithm §10.4.3 *Entering Function Code* (restated by ES2015+ as
`OrdinaryCallBindThis`, §10.2.1.2). Measured on `--target standalone`:

**(A) The sloppy half of the strict/sloppy split was never implemented.**
`src/codegen/expressions.ts`'s `ThisKeyword` arm falls through to
`emitUndefined()` whenever it finds no receiver binding. §10.4.3 says the value
depends on the *callee's own strictness*: strict code keeps the passed thisArg
verbatim, sloppy code binds the **global object**. Only the strict half existed.

```js
function sloppy() { return typeof this; }
sloppy();            // "undefined"   — want "object"
sloppy.call(null);   // "undefined"   — want "object"
```

**(B) An inlined top-level IIFE inherits `__module_init`'s `this`.**
The §3365 arm ("Script-goal top-level `this` is the global object") keys on
`fctx.name === "__module_init"` — a statement about the *emitted* function, not
about the source. `compileIIFE` inlines a top-level IIFE into `__module_init`,
so the IIFE body's `this` took that arm and became the global object **even
under a `"use strict"` prologue**. The tell is that the same callee behaves
differently purely by whether it was inlined:

```js
(function () { "use strict"; return typeof this; })()            // "object"    — want "undefined"
var f = function () { "use strict"; return typeof this; }; f()   // "undefined" — already right
```

(B) is what the `language/function-code/10.4.3-1-*gs` family asserts, and it is
**pre-existing** — verified by reverting (A) and re-running the repro.

## Why the previous attempts did not reach this

The comments in that arm record #1636-S1 (read `__current_this` unconditionally
→ regressed 171 tests, because a directly-called function never has it
installed and observes the global's `ref.null.extern` initial value as `null`)
and #1702 (null-guard that read → fixed the *strict* half). Both were about
where the receiver comes from. Neither supplied the sloppy answer for the case
where there is genuinely no receiver, and neither noticed that the
top-level-`this` arm was keyed on the emitted function name.

`fctx.directEvalSloppyThisFallback` already emitted exactly the right value for
sloppy direct-eval bodies, so the substrate was one branch away the whole time.

## Fix

New `src/codegen/helpers/sloppy-this-global.ts`:

- `unboundThisIsGlobalObject(ctx, expr)` — `!isStrictContext(expr,
  ctx.inferModuleStrictArguments)`. Applied at the two terminal fallbacks in the
  `ThisKeyword` arm (the `__current_this`-is-null branch and the final one), so
  the *value* of the fallback splits on strictness. It never widens WHICH bodies
  consult a receiver.
- `thisBelongsToTopLevelCode(expr)` — walks to the nearest `this`-binding
  construct (arrows transparent) and answers whether it is the SourceFile. Added
  as a third conjunct to the §3365 arm, so an inlined callee's `this` falls
  through to the strict/sloppy split instead of taking the top-level answer.

Deliberately target-independent: the host lane fails these clauses *harder*
than standalone does (124 vs 138 passing of the same 306 files), so there is no
host behaviour depending on the old answer.

## Measured

Instrument: `runTest262File(..., "standalone")` driven per-file, with the
`js2wasm:runtime-eval` namespace shimmed in (see "Instrument" below) and the
**full interpreter** provider tier, which is the only CI-comparable one.

Lever = every ES5-label standalone failure whose `es5id` clause is one of the
`[[Call]]` this-binding algorithms: **10.4.3** (100), **15.3.4.4** `call` (25),
**15.3.4.3** `apply` (25), **11.2.3** function calls (18) = **168 files**.

| run | lever (168 baseline failures) | control (138 baseline passes, same clauses) |
| --- | ---: | ---: |
| base (`origin/main`) | **0 / 168** | **138 / 138** |
| + fix (A) | 39 / 168 | 138 / 138 |
| + fix (B) | **58 / 168** | **138 / 138** |

**+58 fixed, 0 regressed.** A broad control of 600 randomly sampled
currently-passing ES5-label standalone files whose source mentions `this` was
also run; see the PR body for its result.

The two-sided validation matters here: the lever reading 0/168 at base proves
the instrument agrees with the baseline, and the control reading 138/138 proves
the instrument can *see a pass* — three earlier lanes in this campaign measured
against an instrument that could only ever report failure.

## Deliberately out of scope — the residual 110, with root causes

- **~30 files: `.call` / `.apply` / `.bind` drop the thisArg entirely when the
  callee is a function EXPRESSION.** `src/codegen/named-this-call.ts` (#4025)
  installs the receiver only for a stable named `FunctionDeclaration`
  (`resolveDeclaration` requires `ts.isFunctionDeclaration`), so:

  ```js
  function decl() { return this; }        decl.call(o) === o   // true
  var expr = function () { return this; }; expr.call(o) === o  // FALSE
  ```

  This is the `S15.3.4.4_A3_*` / `S15.3.4.3_A5_*` (`this["field"]`,
  `obj.touched`, `this["shifted"]`) residue. It needs the closure-dispatch path
  to install `__current_this`, which is a different subsystem from this fix.
  `tests/issue-4190.test.ts` carries a **canary** that fails the day this starts
  working, so the follow-up cannot land silently unmeasured.

- **~15 files: `new Function("…")` with a strict body** (`10.4.3-1-8?gs`) —
  belongs to the runtime-eval interpreter tier, not to codegen.

- **~10 files: primitive thisArg is not `ToObject`-boxed in sloppy code.**
  `sloppy.call(1)` answers `"number"`; §10.4.3 wants a boxed `Number` object.
  Same dispatch seam as the first bullet.

- **6 files: `illegal cast in __module_init()`** — a different mechanism that
  happens to live in this clause.

## Instrument note (cost three lanes before me)

`runTest262File` in `tests/test262-runner.ts` still does **not** supply the
`js2wasm:runtime-eval` namespace (#4147 / #4162 are filed and unlanded), so an
eval-mentioning standalone module dies at instantiate and **the link error
overwrites the real signature**. 3 of the first 6 files I ran hit it. Two
further traps, both hit in this session:

1. Only the **full interpreter** provider is CI-comparable. The `--refusal-only`
   tier makes those modules instantiate and then throw `dynamic code evaluation
   is not supported`, which is *not* what the baseline records — it silently
   substitutes one failure for another. Build both:
   `node --import tsx scripts/build-runtime-eval-provider.mjs` (~99 s), then run
   with `TEST262_FULL_RUNTIME_EVAL=1`.
2. A fresh worktree has neither `node_modules` nor a populated `test262/`;
   without them the runner reports `harness_error` for everything, which looks
   like a result. `bash scripts/provision-worktree-deps.sh` is the fix. A bare
   `ln -s` for `test262` was silently clobbered mid-session.

## Acceptance criteria

- [x] Sloppy function code with no receiver binds the global object; strict
      binds `undefined`.
- [x] A top-level IIFE keeps its own strictness rather than `__module_init`'s.
- [x] A genuinely top-level Script `this` still binds the global object (#3365
      not regressed).
- [x] Measured +58 / −0 on the 168-file lever, 138/138 control held.
- [x] `tests/issue-4190.test.ts` covers all four, plus a canary for the
      out-of-scope `.call`-on-function-expression gap.
