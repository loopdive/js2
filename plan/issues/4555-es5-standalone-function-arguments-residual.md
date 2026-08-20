---
id: 4555
title: "ES5 standalone: Function builtins / function-code / arguments-object residual (75 rows, 2026-08-19 census)"
status: in-progress
sprint: current
created: 2026-08-19
updated: 2026-08-20
assignee: ttraenkler/es5-standalone-push
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: conformance
area: codegen, runtime
es_edition: 5
language_feature: functions
goal: es5
related: [4163, 4492, 4491, 4515, 4556]
origin: "2026-08-19 standalone ES5 census against baselines-repo test262-standalone-current.jsonl (48,735 entries, fetched 04:52). Lane 'function-semantics' of an 8-way fan-out."
---

# #4555 — ES5 standalone Function / function-code / arguments-object residual

## Census (2026-08-19)

Standalone ES5 is **8,506 / 9,029 (94.2 %)**, leaving **523 non-passes**
(495 `fail`, 24 `compile_error`, 4 `compile_timeout`). Classification is the
authoritative `scripts/generate-editions.ts` edition classifier run over the
fresh standalone baseline, so the denominator matches the published
`test262-standalone-editions.json` (8,506/9,029) exactly.

This issue owns the **75-row** slice under:

- `built-ins/Function/**`
- `language/function-code/**`
- `language/arguments-object/**`

## Signature histogram (top rows)

| rows | signature |
| ---: | --- |
| 6 | `Expected a TypeError to be thrown but no exception was thrown at all` |
| 4 | `The value of X is expected to be X Expected SameValue(«X», «X»)` |
| 4 | `Expected true but got false` |
| 3 | `TypeError: cannot read property X of null` |
| 3 | `X had incorrect value!` |
| 2 | `The value of this[X] is expected to be X Expected SameValue(«undefined», «X»)` |
| 2 | `The value of retobj[X] is expected to be true` |

**There is no dominant cluster.** The standalone residue at 94 % is a long
tail — the largest single signature in the whole 523-row corpus is 13 rows.
Plan for many small root causes, not one lever. Cluster size is a ceiling on
what a fix can move, not a forecast (#3626 §2.1 method).

## Reproduction

The `--standalone` flag is load-bearing; without it you measure the JS-host
lane, which is a different (and much worse: 84.8 %) corpus.

```bash
npx tsx .tmp/t262.mts --standalone built-ins/Function/prototype/apply/S15.3.4.3_A6_T1.js
node .tmp/t262run.mjs --standalone .tmp/lane-tests.txt 3
```

## Acceptance criteria

- Net increase in standalone ES5 passes across the 75-row lane, measured
  before/after with the same runner.
- Regression guard (`551` locally-verified-passing standalone ES5 tests) stays
  at 551/551.
- No test-name/path special-casing; no edits to the runner's skip logic
  (`shouldSkip`, `HANGING_TESTS`) — those manufacture passes rather than earn
  them.

## Known local limitation

Tests whose root cause is `eval` cannot be faithfully validated on the dev Mac:
CI's standalone lane uses a QuickJS eval tier that needs clang-18 (Homebrew
`llvm@18` requires Xcode Command Line Tools, absent here), and the fallback
interpreter tier diverges semantically. Such rows are recorded as blocked
rather than fixed. See #4163 for the umbrella note.

## 2026-08-19 FINAL — lane 0 → 18 of 75, `target=standalone`

Branch `es5-function-semantics` @ `d46d320`, 10 commits, tree clean.
**Guard 551/551 → 551/551.** `npx tsc --noEmit` clean. No test-name/path
special-casing; no runner or skip-logic edits.

**Of the 57 remaining, 31 are QuickJS-eval-provider-blocked locally and 26 are
real.** So the local reachable pool for this lane was 44, not 75 — the lane
closed 18 of those 44.

### Ten root causes

| commit | rows | defect |
| --- | ---: | --- |
| `1b57bed` | +1 | under-applied call sites narrowed a param to f64/i32/i64 — which has no `undefined` — so the omitted arg was padded with **0** and `b === undefined` was false |
| `fc46bc9` | +2 | inlined-IIFE `this` took the **caller's** receiver; inside `new F()` that is the instance, so a `this.x` read `ref.cast`-trapped. Plus `typeof arguments` folded to `"undefined"` |
| `f73acf1` | +1 | `arguments.constructor` is %Object% — #2743a had landed this **host-mode-only** |
| `26b8f27` | +1 | `var x;` naming a formal parameter allocated a **fresh local**, wiping the argument |
| `44ec215` | +1 | `var arguments = e;` wrote **through** the arguments vec, so `= undefined` emitted `ref.as_non_null` on null — an unconditional trap |
| `655c6b6` | +4 | an `undefined` thisArg was installed as a **real receiver**, so sloppy `f.apply(undefined)` returned `undefined` instead of the global object. `f.apply(null)` was already correct — only the undefined half was missing |
| `a1aeb9a` | +1 | an inlined IIFE has no function object, so an **escaping** arguments object could never carry `callee` |
| `536a3c0` | +5 | §10.6 step 14 poison `callee` accessor on strict arguments objects. **#4243 had explicitly deferred this** — "minting %ThrowTypeError% needs a callable throwing function value, which this module does not build" — so this builds that intrinsic as a module singleton and defines the accessor through the existing native `__defineProperty_accessor` |
| `db6568d` | +1 | an under-applied IIFE that reads `arguments` got **none at all** |
| `d46d320` | +1 | the numeric **return** promotion turned that same under-applied param back into NaN |

### Extractions — CORRECTED 2026-08-19

An earlier revision of this entry said "six verbatim extractions". That was
wrong twice over, and the lane corrected it after verifying mechanically. Only
**four** of the six new modules are extractions at all —
`statements/var-slot-reuse.ts` and `helpers/undefined-receiver.ts` are **new
code** — and of those four, **three are byte-verbatim and one is not**:

| module | moved from | verdict |
| --- | --- | --- |
| `arguments-object-mop.ts` | `typeof-delete.ts` | byte-verbatim, 74/74 lines, only `function` → `export function` |
| `statements/null-guard-alias.ts` | `statements/variables.ts` | byte-verbatim, 52/52 lines, only an added `export` |
| `expressions/inline-iife-scope.ts` | `expressions/call-tail-dispatch.ts` | byte-verbatim, 161/161 lines, only an added `export` |
| `expressions/this-keyword.ts` | `expressions.ts` (`fc46bc9`) | **NOT byte-verbatim** — de-indented by 2, wrapped in a new `compileThisKeyword(ctx, fctx, expr)`, and **one 10-line hunk ADDED** (the new §10.4.3 arm). Diffing the de-indented base against the new body shows that one added hunk and nothing else: no renamed params, no changed signatures, no dropped branches. |

Every god-file touched still **shrank**, so no `loc-budget-allow:` /
`func-budget-allow:` entries are needed.

The lesson is the one `fc46bc9` illustrates: a commit carrying a 171-line new
module *and* a semantic fix is exactly the shape where a moved line can change
meaning unnoticed. Extractions should land as their own commit first.

### Unit suites caught a regression the conformance corpus missed (`7b28483`)

124 targeted suites, 1049 tests: base **59 failing**, branch-before-fix **62**.
Two newly-failing suites, one real:

- **`es5-standalone-this-and-construct.test.ts` (2 assertions) — a genuine
  regression.** `(function(){ this.touched = true; }).call(obj)` reuses the
  IIFE-inlining path, and #4246 binds its receiver via a `this` local in
  `localMap`. The new §10.4.3 arm runs *before* that rung — deliberately, since
  inside a constructor twin the enclosing `this` must not leak into a
  receiver-LESS inline — so it discarded a receiver the caller really passed.
  Both shapes land in `fctx.inlinedIifeNodes`, so that set cannot tell them
  apart; `inlined-call-receiver.ts` now records which callees sit inside a
  receiver-bound inline and the arm defers. Suite 22/22.
- **`es5-standalone-arguments-callee.test.ts` (1 assertion) — not a
  regression.** A #4243 placeholder asserting `gOPD(arguments,"callee") ===
  undefined` in strict code, whose own comment scoped it to "not that the strict
  behaviour is complete" because the %ThrowTypeError% accessor "this issue does
  not yet mint". `536a3c0` mints it. Updated to assert the full §10.6 step 14
  descriptor plus a throwing-write case. Suite 13/13.

Lane and guard unchanged after the fix: **18/75**, **551/551**.

### 2026-08-20 regression correction — binding-aware `typeof arguments`

The `fc46bc9` fast path recognized `arguments` by spelling plus `localMap`
membership. An explicit parameter, initialized `var`, or function declaration
named `arguments` can occupy the same local-map key, so both direct `typeof`
and the comparison shortcut incorrectly constant-folded those bindings to
`"object"`. The integration symptom was `tests/issue-1102.test.ts` returning 1
instead of 11 for the parameter-default/eval closure case.

`isArgumentsObjectIdentifier` now resolves binding identity exclusively
through `ctx.oracle.valueDeclarationOf` and verifies that the live local still
has the canonical arguments-vec carrier. The declaration-less implicit object
and a no-op `var arguments;` redeclaration take the §10.6 shortcut; parameters,
scalar initialized/reassigned vars, and function declarations do not. When a
hoisted `function arguments(){}` leaves the checker flow type stale after a
numeric/boolean `var arguments = value`, the exact scalar local carrier supplies
the IR-side `typeof` verdict. Reference carriers deliberately fall through: a
reified eval environment or closure wrapper is not itself the source value.
The focused
lowering also applies the ES5 §10.5 FormalParameters BoundNames rule before
materializing an implicit object. That shared recursive gate covers every
existing materializer: exported and nested declarations, closures, object
methods, inline calls, and constructor function expressions. A spelling-keyed
`localMap` therefore cannot overwrite a real `arguments` parameter in one of
those alternate lowering paths.

`tests/issue-4555-typeof-arguments.test.ts` now runs 17 runtime cases under each
oracle backend, including a value supplied dynamically through the Wasm export,
an omitted optional parameter, an arrow capture, direct-eval scope reification, hoisted-function/`var`
rebindings, and every affected lowering path. Six structural controls pin
plain, object-pattern, array-pattern, aliased, and negative BoundNames cases.
This also pins the roots represented by
`test262/test/language/function-code/S10.2.1_A4_T1.js` and
`test262/test/language/eval-code/direct/arrow-fn-body-cntns-arguments-func-decl-arrow-func-declare-arguments-assign-incl-def-param-arrow-arguments.js`.

This correction deliberately stops at the ES5-safe formal-parameter rule. Full
ES2015+ FunctionDeclarationInstantiation parity still needs a stable hidden
implicit-arguments local created before default-parameter evaluation, followed
by separate body-environment bindings. That follow-up is required before a
top-level lexical `arguments` declaration and parameter-expression closures can
share one ordinary function without carrier aliasing.

The same-name hoisted-function plus reference-valued `var` initializer remains
a separate carrier-unification gap: a string initializer can currently emit an
invalid local store, while an object initializer can retain the hoisted
function's static verdict. This patch does not disguise those broader failures
as part of the scalar `typeof` correction.

The under-applied IIFE fallback (`params.length > args.length`) is another
separate ES5 gap: unlike the inlined matching/over-applied path, it currently
does not materialize an implicit arguments object at all. It needs its own
observable `arguments.length`/indexed-value slice rather than being hidden in
this binding-identity fix.

### Locally-decidable pool is 35 of 75, not 44

31 rows are QuickJS-provider-blocked outright, and a further **9 of the 26
"actionable" rows are eval / `Function`-constructor rooted** — they merely reach
a non-QuickJS path locally, so their real behaviour is still gated on the eval
tier (`15.3.5.4_2-95/96/97gs`, `S15.3.4.3_A1_T1`, `S15.3.4.4_A1_T1`,
`S15.3.4.3_A8_T6`, `S15.3.4.4_A7_T6`, `S15.3.5_A1_T1/T2`). So the lane closed 18
of a **35**-row locally-decidable pool.

### Queued follow-ups (largest remaining, all reachable)

- **`Function.prototype.bind` is unimplemented in standalone** — 3 rows.
- **`arguments.length` is modelled as an ARRAY-EXOTIC length**, so writes coerce
  and `defineProperty` raises "Invalid array length" — 3 rows.
- **A getter reached through a PRIMITIVE receiver gets `this === null`** — 3 rows.
