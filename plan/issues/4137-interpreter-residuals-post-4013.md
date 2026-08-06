---
id: 4137
title: "standalone interpreter residuals after #4013: `SyntaxError: NaN` (36), a null-deref in setEvalVariableEnvironmentBinding (16), Phase-1 emitter gaps (22)"
status: in-progress
assignee: ttraenkler/L3-annexb-hoisting
sprint: current
created: 2026-08-03
updated: 2026-08-06
priority: medium
horizon: m
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: runtime
language_feature: eval
goal: standalone-mode
related: [1781, 2200, 2928, 2929, 4013, 4023, 4131, 4162]
origin: "2026-08-03 delta /harvest-errors, baselines 2090e7bfd342 (gitHash b65d2f5a, 13:19Z standalone); oracle v12/honest"
# (#4137 arm 2) The CatchParameter's Environment Record has to be pushed inside
# `emitTry`, which lives in the interpreter's single emitter god-file. There is
# no subsystem module to move a try-clause emission into without inventing one,
# and the scope markers it needs (`SIMPLE_CATCH_SCOPE_LABEL`, `scopeBindsName`)
# are read by five other emit sites in the same file. +60 LOC is the fix plus
# the B.3.5 exemption rationale, not barrel spill; `isActiveBlockLexical` /
# `cancelsAnnexBVarBinding` were folded into one scan to hold it down.
loc-budget-allow:
  - src/interp/emitter.ts
---

# #4137 — the residual tail of the newly-linked standalone interpreter

## TL;DR

PR #4013 made CI's standalone shards link the **real** runtime-eval provider
(previously the refusal provider), which retired the entire
`dynamic code evaluation is not supported` / `dynamic eval is not supported in
standalone mode` refusal family — **559 records → 0** — and turned **343 of
those 559 into passes**. Of the 216 that still fail, three signatures are
**new**, produced by the interpreter itself rather than by the code under test.
They total **74 records** and did not exist at any earlier baseline.

| signature | records | category |
| --- | ---: | --- |
| `SyntaxError: NaN` | 36 (24 annexB, 12 standard) | `syntax_error` |
| `dereferencing a null pointer [in setEvalVariableEnvironmentBinding() ← callBuiltin ← run ← interpEnter]` | 16 | `null_deref` |
| `Error: interp/emitter: unsupported in Phase 1: …` | 22 | `other` |

**Prior art — read before starting.** Two of the three are already recorded
somewhere; this issue exists to give them a **published-baseline count** and an
owner, not to claim discovery:

- `SyntaxError: NaN` is recorded in **#2928** (line ~593) as an
  "error-message rendering defect in the thrown path", measured at **8** files in
  a local interpreter run. It is **36** in the published CI lane now that #4013
  links the real provider.
- The null-deref arm overlaps **#4131**'s recorded residual and **open PR #4077**
  (`codex/2929-annexb-init-update`, "five `existing-var-update` files became null
  dereferences"). **The frame differs**: #4131/#4077 cite
  `dereferencing a null pointer in __module_init()`, these 16 cite
  `setEvalVariableEnvironmentBinding() ← callBuiltin ← run ← interpEnter`.
  Confirm whether #4077 closes them before doing any work here.

## 1. `SyntaxError: NaN` — 36 records

The message is the *number* `NaN`, not a diagnostic. Whatever formats this error
is interpolating an unresolved position/offset instead of a message. Two things
are wrong and they are separable:

- **The text is unusable.** No test, triager or bucketing script can act on it,
  and it collapses 36 distinct causes into one opaque bucket.
- **It is thrown on `skip-early-err` tests**, i.e. tests whose whole point is
  that an early error must *not* be raised at that point. Samples:
  - `test/annexB/language/eval-code/indirect/global-if-decl-else-stmt-eval-global-skip-early-err-try.js`
  - `test/annexB/language/eval-code/direct/func-if-decl-else-decl-a-eval-func-skip-early-err-try.js`
  - `test/language/expressions/class/elements/arrow-body-derived-cls-direct-eval-contains-superproperty-1.js`

Fix the message first — the second half cannot be diagnosed while the diagnostic
is `NaN`.

## 2. Null-deref in `setEvalVariableEnvironmentBinding()` — 16 records

A hard crash inside the interpreter's var-environment binding path, all on
annexB eval-code:

- `test/annexB/language/eval-code/direct/global-if-decl-else-decl-b-eval-global-init.js`

This overlaps the residuals already recorded on **#4131** (annexB
existing-var-update). #4131 is merged; confirm whether this crash is one of its
two recorded residuals or a third, distinct one before starting.

## 3. `interp/emitter: unsupported in Phase 1` — 22 records

Honest refusals, listed for the Phase-2 scope of #2928:

| unsupported construct | records |
| --- | ---: |
| regex literal | 13 |
| class method key `PrivateIdentifier` | 4 |
| class element `PropertyDefinition` | 3 |
| expression `TaggedTemplateExpression` | 1 |
| binary operator `\|` | 1 |

`binary operator '|'` is the odd one out — a single missing bitwise op in an
otherwise-complete expression emitter is a one-line gap, not a phase boundary.

## Context: what the interpreter bought

Disposition of the 559 previously-refused records at the new baseline:

| | records |
| --- | ---: |
| now `pass` | 343 (61.4 %) |
| still failing | 216 (38.6 %) |

Restricted to the **ES5+untagged goal scope** (8,648 files, `scope_official` ∧
(`es5id` ∨ no edition id), intersected across both lanes): the dynamic-code
exclusion set was **147** files, of which **74 now pass and 73 still fail**.

---

## Work log — 2026-08-06, L3 (annexB B.3.3 lever)

Two of the three arms are fixed and measured. The third (`SyntaxError: NaN`) is
diagnosed to a reproducible pair of probe files but deliberately **not** fixed
here; see below for why and for the handoff.

### Instrument (read this before trusting or reproducing any number)

`tests/test262-runner.ts`'s in-process `runTest262File` **does not attach the
`js2wasm:runtime-eval` provider namespace**, so on the standalone lane every
eval-mentioning module fails to instantiate with
`Import "js2wasm:runtime-eval": module is not an object or function`. On this
185-file lever that was 81 files of pure instrument artifact. The authoritative
oracle is `scripts/test262-worker.mjs` (what `tests/test262-shared.ts` drives and
what produces the baselines). Filed separately as **#4162**; three agents hit it
independently the same day.

The harness used for every number below mirrors test262-shared's normal path:
`CompilerPool(n, "unified")` + `assembleOriginalHarness` + strict rerun. Build
order matters and is not optional:

1. `esbuild src/index.ts → scripts/compiler-bundle.mjs` **and**
   `esbuild src/runtime.ts → scripts/runtime-bundle.mjs`
   (`scripts/run-test262-vitest.sh:173-176` — *not* `compiler-bundle-entry.ts`).
2. `node scripts/build-runtime-eval-provider.mjs` — **after** step 1, because the
   provider cache key folds in the compiler-bundle hash. ~2 min, and it must be
   redone after every source change being A/B'd.
3. Run with `TEST262_FULL_RUNTIME_EVAL=1`. Without it you silently get the
   REFUSAL tier and every eval test reports
   `TypeError: dynamic code evaluation is not supported` — a different, equally
   fake signature.

Instrument responsiveness was confirmed, not assumed: the baseline run's error
histogram reproduces the published one term for term (27/24/24/16/15/13…), and
the score moved 0 → 16 → 40 in step with the two source changes, with the
flipped files matching the predicted buckets exactly.

### Measured

Population: the 185 standalone ES5-label failures under
`annexB/language/{global-code,function-code,eval-code}` (2026-08-06 baseline).

| build | pass / 185 | delta | regressions |
| --- | ---: | ---: | ---: |
| `origin/main` (176e4408f) | 0 | — | — |
| + WeakMap-miss fix | 16 | **+16** | 0 |
| + catch-parameter Environment Record | 40 | **+24** | 0 |

### 1. Null-deref in `setEvalVariableEnvironmentBinding` — FIXED (+16)

Not a #4131 residual and not an Annex B semantics gap. It is a **standalone ABI
mismatch**: a `Map`/`WeakMap` miss whose value type is a **class** reads back as
`null`, not `undefined`, because the nullable class reference has no distinct
`undefined` representation. Measured directly (`.tmp/probe/wm.ts`,
`.tmp/probe/wm2.ts`):

| expression | standalone result |
| --- | --- |
| `WeakMap.get(missing) === null` evaluated **inline** | `false` |
| `const v = WeakMap.get(missing); v === null` | **`true`** |
| `typeof WeakMap.get(missing) === "undefined"` inline | `true` |

So the coercion happens **at the local store** — precisely where an absence test
reads it. `setEvalVariableEnvironmentBinding` tested `existing !== undefined`
only; the miss passed the guard and `setOwnEnvironmentBinding` dereferenced it.

`variableEnvironmentFor` had the same shape with a *different* consequence — it
returned the miss rather than continuing the parent walk, truncating the chain at
the first unregistered record. Fixed alongside. **It is not what moved the
number**: the 24 `binding value is updated following evaluation` failures I
expected it to fix stayed at 24 until the catch fix landed. Stated because a
plausible-but-wrong attribution is worth recording.

`src/interp` has ~30 further `x !== undefined` / `x === undefined` absence tests;
the ones whose value type is a class (several `INTERP_BINDINGS.get(...)` reads in
`loop.ts`) carry the same latent hazard. Not swept here — each needs its own
reachability argument, and this issue's arm is closed.

### 2. `binding value is updated following evaluation` (24) — FIXED

Root cause is in the interpreter's **emitter**, not in Annex B. `emitTry` bound
the CatchParameter with `bind()`, which writes into `names` — a flat,
function-wide name→register map **with no pop**. §14.15.3 gives the parameter its
own declarative Environment Record, so `catch (f)` shadowed `f` for the entire
rest of the body: every name resolution emitted *after* the clause read the catch
register. That is why the family's `before` assertion passed (emitted before the
clause, resolves to the eval var cell) while `after` read the caught value:

```js
// annexB/language/eval-code/**/*-no-skip-try — 24 files, one shape
var before = typeof f;                                   // "undefined"  ok
try { throw null; } catch (f) { { function f(){ return 123; } } }
var after  = typeof f;                                   // want "function", got "object"
                                                         //   ^ the caught `null`
```

Fix: route the parameter through the lexical-scope machinery blocks already use
(`BUILTIN_PUSH_LEXICAL_ENV` + control-stack marker + `RESTORE_ENV`), so
`emitLoadName` / `storeName` / `initializeName` and the `typeof` fast path all see
it via `isActiveBlockLexical` and stop seeing it when the clause ends.

**The wrinkle, and the reason for a second scope label.** Making the parameter an
ordinary block lexical *cancels* Annex B — and measurably did: the intermediate
build scored `run = 1` on the repro (null leak gone, function never assigned).
B.3.5 **exempts a simple `CatchParameter: BindingIdentifier`**; only a
destructuring parameter cancels, and `emitTry` rejects those earlier.
`SIMPLE_CATCH_SCOPE_LABEL` marks the scope so `isActiveBlockLexical` (name
resolution) counts it while `cancelsAnnexBVarBinding` (the two Annex B sites, in
`emitBlock` and the switch emitter) does not.

Side effects, all in the correct direction: `boundNames` no longer gains a
permanent entry for the parameter (which is what kept `typeof f` on the stale
register), and a closure declared inside a catch block can now see the parameter
at all — previously it could not, since registers are frame slots invisible to a
nested `FunctionEmitter`.

### 3. `SyntaxError: NaN` (24 here / 36 published) — DIAGNOSED, NOT FIXED

**It is Acorn's `pp.raise` message, and the "NaN" is a `number`.** Proof, in
three independent steps:

1. `acorn.mjs:3756` is `message += " (" + loc.line + ":" + loc.column + ")"`.
2. Take a program where **node-acorn genuinely raises**:
   `eval("try { throw {}; } catch (f) { function f() {} }")`. Node reports
   `Identifier 'f' has already been declared (1:39)`. The standalone interpreter
   reports message `"NaN"` exactly (`.tmp/probe/acornraise.ts`).
3. The shape reproduces standalone with no eval at all: `.tmp/probe/pa10.ts`
   returns `viaLength = 3` (`"NaN".length`) and `viaTypeof = 2` (number).

**Why it is not fixed here, stated plainly:**

- It is a **codegen** bug (`any`-typed compound `+`), not an interpreter bug, so
  it does not belong in this issue's `src/interp` change and lands in
  `src/codegen/expressions/operator-assignment.ts` — concurrently owned by
  another lane today.
- It is **context-sensitive, not a flat rule**, and anyone who assumes otherwise
  will conclude the bug does not exist. The near-identical `.tmp/probe/pa9.ts`
  compiles **correctly** while `.tmp/probe/pa10.ts` does not; the only difference
  is surrounding call sites. Whole-program parameter inference is deciding a
  numeric lowering for `message`. **That probe pair is the diagnostic** — start
  from it.
- **Fixing the message will not, on its own, flip these 24 tests.** They are the
  `skip-early-err` family, whose point is that an early error must *not* be
  raised. node-acorn does **not** raise on their actual shape
  (`catch ({ f }) { if (true) function f(){} }` parses fine), yet compiled-acorn
  does. So there is a **second, separate** defect in compiled-acorn's scope
  tracking underneath the unreadable message. #4137 already says "fix the message
  first — the second half cannot be diagnosed while the diagnostic is `NaN`";
  that ordering is confirmed, and the second half is real.

### Also refuted / worth knowing

- **`typeof` and `===` against a string literal are unreliable when applied to an
  `any` holding a freshly-built native string.** An earlier probe of mine
  (`.tmp/probe/plusassign2.ts`) "showed" that `any += stringLiteral` works and
  `any += <concat>` does not; re-measured through `String(...)` the distinction
  partly dissolved. Do not size the `+=` bug from `typeof`-based probes.
- The 15 `Initialized binding created prior to evaluation` failures are the
  **AOT** twins of arm 2 (`function-code/*-no-skip-try`), not interpreter
  failures. They need #2200 Phase 2 (`annexBOuterBindings`) plus B.3.5, whose last
  attempt (#1769) cost −1180 net. Explicitly out of scope here.

## Acceptance criteria (updated)

- [ ] `SyntaxError: NaN` never reaches a test result — **diagnosed, not fixed**;
      root cause and a failing/passing probe pair recorded above.
- [x] The `setEvalVariableEnvironmentBinding` null-deref is fixed — and it is
      **not** a #4131 residual; it is a standalone null-vs-undefined ABI bug.
- [ ] Each `interp/emitter` Phase-1 gap is either implemented or listed in
      #2928's Phase-2 scope with a count — untouched.
- [x] Re-measured, with counts: 0 → 40 of 185, 0 regressions (table above).
