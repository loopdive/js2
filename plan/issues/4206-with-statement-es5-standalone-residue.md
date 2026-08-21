---
id: 4206
title: "`with` statement, ES5 standalone: 73-row residue reduced to 51; first IR closure-environment slice converts 22/39 legacy gate rows"
status: ready
sprint: current
created: 2026-08-07
updated: 2026-08-21
priority: high
horizon: xl
feasibility: hard
reasoning_effort: max
task_type: bug
area: codegen
es_edition: 5
language_feature: with-statement
goal: es5
related: [671, 1387, 3025, 4179, 4205, 4231, 4264, 1472]
origin: "2026-08-07 W23 census of the ES5 standalone failing residue (published standalone baseline 20260807, oracle v13). Supersedes the 2026-03 stub #671."
loc-budget-allow:
  # +5 lines of WIRING only (one import, one call, a 3-line pointer comment).
  # The 130 lines of new logic went to a NEW subsystem module,
  # src/codegen/declarations/dynamic-with-shape.ts — i.e. this change already
  # did what the ratchet asks for. The file sits exactly at its 1511 cap, so
  # any hook at all trips it; moving an unrelated sibling marker out purely to
  # buy back 5 lines would enlarge the diff for a budget technicality.
  - src/codegen/declarations/object-shape-widening.ts
  # #4206 closure slice: the backend-neutral contract and codegen adapter live
  # in new modules. These are the unavoidable IR selector/lowerer hooks plus
  # the FunctionContext field and selector/lowerer hooks.
  - src/ir/from-ast.ts
  - src/ir/select.ts
  - src/codegen/context/types.ts
  # #4206 pre-init-read slice (2026-08-19): §10.2.11 gives every `var` binding
  # `undefined` at function entry, but hoistVarDecl typed the slot from the
  # DECLARATION, so `return value;` before `var value = "value"` read back null
  # from a (ref null $AnyString) zero-init. The 150-line analysis lives in the
  # new module src/codegen/declarations/hoisted-var-preinit-read.ts; these are
  # the two irreducible wiring lines — one predicate call plus one import in
  # each driver (index.ts +2, closures.ts +1). Already compacted from +6/+7 by
  # folding the var-slot check into varBindingNeedsExternrefForUndefined and
  # reducing the closure-return hook to a single call.
  - src/codegen/index.ts
  - src/codegen/closures.ts
  # #4206 IR/legacy module-slot parity follow-up (2026-08-20): the complete
  # widening analysis moved into the new leaf module
  # src/ir/heterogeneous-module-bindings.ts. These capped drivers contain only
  # the resolver's preclaim check and the two one-line shared-oracle adapters;
  # keeping that wiring at the module-binding boundary preserves the strict
  # Program ABI invariant instead of adding a postclaim exception.
  - src/ir/module-bindings.ts
  - src/ir/integration.ts
  # #4206 with-routed-return slice (2026-08-21): the analysis
  # (`functionReturnsThroughWithScope`) lives in src/codegen/declarations.ts
  # beside the sibling `functionReturnsDynamicObjectCarrier` it mirrors. This
  # file gets ONLY the wiring: one import plus a two-line result-type arm in the
  # nested-function registration path, which is the third and last site that
  # picks a wasm result type for a function declaration. Splitting three lines
  # of dispatch into a new module would hide the arm from the two identical
  # arms it must stay in step with.
  - src/codegen/statements/nested-declarations.ts
func-budget-allow:
  # Four-line statement-dispatch hook; all selection logic is in the dedicated
  # isPhase1WithStatement helper and ir/with-environment subsystem.
  - src/ir/select.ts::isPhase1StatementListInScope
  # One shared-oracle option in each existing resolver-options object; the
  # analysis and policy remain outside these orchestration functions.
  - src/codegen/index.ts::planIrOverlay
  - src/ir/integration.ts::compileIrPathFunctions
  # #4206 with-routed-return slice (2026-08-21): a two-line arm added to the
  # existing result-type `if/else` chain, next to the generator and
  # foreign-eval arms it sits between. The analysis is elsewhere
  # (declarations.ts::functionReturnsThroughWithScope); this is the dispatch.
  - src/codegen/statements/nested-declarations.ts::compileNestedFunctionDeclarationInScope
  # #4206 eval-reachable-literal slice (2026-08-21): +3 / +1 lines of WIRING
  # only — one `collectEvalMutableNames(sourceFile)` call in the outer function
  # and one `if (evalMutableNames.has(varName)) mopSet.add(varName)` beside the
  # three existing `markStandalone*Targets` markers it joins. The whole analysis
  # lives in the new leaf module
  # src/codegen/declarations/eval-reachable-object-shape.ts. The marker line has
  # to sit in that block: it feeds the SAME `mopSet` whose concrete-struct
  # consumer guard immediately below is what keeps the promotion ABI-safe, so
  # hoisting it elsewhere would bypass that guard.
  - src/codegen/declarations/object-shape-widening.ts::collectGrowableObjectLiterals
  - src/codegen/declarations/object-shape-widening.ts::scanStatements#2
---

# #4206 — the `with` statement residue, correctly sized

## The lever, and the correction to it

118 of the 1,365 failing ES5 standalone files use `with`. **That number is not
the lever.** Splitting by what actually fails first:

| | files | evidence |
| --- | --- | --- |
| Compiler hard-refuses at the gate | **39** | error text is literally `#1387: with statement requires a proven closed object-literal shape before codegen` |
| Runtime scope-chain misresolution, no `this.x=` contamination | **11** | `Scope chain disturbed`, `with(null) x = 2 must throw TypeError`, `o.foo` wrong |
| Also carry a script top-level `this.x = …` — ~~first failure is #4205, not `with`~~ **MEASURED: these are `with`'s own** | **68** | see the correction below |
| total | 118 | |

Only **12 of the 118 pass in the host lane**, so this is a general semantics
gap, not a standalone-lowering gap.

### ⚠ CORRECTION (2026-08-07, W25 — supersedes the masking claim above)

The original text said those 68 were blocked behind #4205 and that this issue
should be discounted to **50** until #4205 landed. **That is measured false.**

#4205 was implemented (PR #4192) and A/B'd over 388 files, per file:
**ZERO changed error signature.** Not 96, not 68 — zero.

Delta-debugging the canonical `with/S12.10_A1.1_T1.js` against the runner's own
message as invariant isolates a **pure `with` defect**: remove one `valueOf`
member from the with-object and the same file fails on `p1='x1'` instead of
`p1=null` — i.e. the with-scoped assignment wrote **through to the global**.
That is this issue's mechanism, not a global-`this` binding failure.

**So: size this issue from its own mechanism, undiscounted. There is no #4205
sequencing dependency, and nothing here counts toward another issue's yield.**

The original inference was that the global-`this` assertion appears on an
earlier *line* than the `with` block, so it must fail first. That is textual
ordering, not causation — it reads like a measurement and is not one. Re-derive
the population with the compiler's own predicates over effective source rather
than inheriting any count on this page; the census that produced them ran **no
local compiles**, and its lever #1 was wrong by a factor of 19 for exactly that
reason.

## Root cause

`src/codegen/with-scope.ts` implements only the Tier-1 closed-shape path: the
`with` target must be a syntactically closed object literal whose complete key
set is provable locally. `proveObjectLiteralWithTarget` rejects — and
`reportWithStatementDiagnostic` (line 838) raises the hard error — for any of:

- target is not an object-literal expression at all;
- the literal contains a spread (key set not local);
- the literal contains a getter/setter (needs dynamic property semantics);
- the literal contains a method (method-value routing deferred);
- the literal has a computed key.

The dominant rejection reason in the 39 is *"body contains a nested function or
class"*. The dynamic fallback is deferred to #1472.

## Sub-buckets inside the 39 CE files

| rejection reason | files |
| --- | --- |
| body contains a nested function/class | ~33 |
| other proof failures (spread / accessor / computed key / non-literal target) | ~6 |

Representative: `language/statements/with/S12.10_A1.12_T1.js`,
`S12.10_A3.8_T3.js`, `S12.10_A1.12_T5.js`, `language/statements/function/S13.2.2_A19_T8.js`.

## Sub-buckets inside the 11 runtime failures

- `language/identifier-resolution/S10.2.2_A1_T{5,6,7,8,9}.js` — 5 files,
  `Scope chain disturbed`: an identifier that the object environment record
  should shadow resolves to the outer binding.
- `language/statements/with/12.10-2-5.js` — `with(null)` must throw TypeError.
- `language/statements/with/12.10-0-8.js` — a setter on the `with` target is not
  invoked.
- `language/statements/try/S12.14_A14.js`, `built-ins/String/S15.5.5.1_A4_T1.js`,
  `language/reserved-words/ident-name-keyword-accessor.js`,
  `language/statements/function/S13.2.2_A18_T1.js`.

## Predecessors

- **#671** ("with statement support") is a 2026-03 backlog stub with no sizing.
  Close it as superseded by this issue.
- **#1387** (done) built the Tier-1 closed-shape path this issue extends.
- **#3025** (done) closed an earlier residual of the same gate.
- **#4179** (in-review) fixes top-level `with` bodies being dropped from
  `__module_init` — a different defect on the same statement. Re-measure after
  it lands.

## Acceptance criteria

- [x] **Measured count and outcome for the 39 gate-refusal files:** 39/39 were
      the nested-function/class gate. The first callable function-expression
      slice now yields **22 pass / 7 runtime fail / 10 explicit constructor
      refusals**; see the 2026-08-11 record.
- [ ] The 5 `S10.2.2_A1_T*` scope-chain files resolve identifiers through the
      object environment record. **Not attempted.**
- [ ] `with(null)` / `with(undefined)` throw TypeError. **Not attempted**
      (1 file, `12.10-2-5.js`).
- [x] A/B reports the **gate-refusal** and **runtime wrong-answer** cohorts
      separately — done, plus the lowering path each file actually takes.
      One PR carries only the Tier-2 slice; the reasoning is recorded.

**Not yet satisfied — this issue stays open.** The PR fixes a real standalone
unsoundness (RED-on-base regression test) but converts **0 test262 files**,
because the whole `S12.10_A1.*` family dies on an earlier assertion owned by a
`with`-free defect. Remaining work is enumerated under "Deferred, precisely
located" below and is now scoped from measurement rather than from the census.

## Measurement provenance

Same as #4205: `classifyEdition() === 5` over the standalone baseline
(48,619 rows, oracle v13, 2026-08-07), 8,931 files / 7,566 pass / 1,365 fail.

---

# W26 implementation record (2026-08-07)

**Headline: 0 test262 conversions, 0 regressions — and the reason is measured,
not guessed.** A real unsoundness in the standalone `with` lowering is fixed and
locked in by a RED-on-base regression test, but every affected file also fails
an EARLIER assertion caused by a defect that is **not** `with`'s.

## Re-derived population (undiscounted, from the change's own reachability)

Population derived by parsing each file's **effective source** (body + `assert.js`
+ `sta.js` + `includes:`) and asking the compiler's own dispatch predicate — does
a `ts.WithStatement` node exist — **not** by error-string grep.

| | files |
| --- | --- |
| ES5 standalone total | 8,931 (pass 7,574 / fail 1,357) |
| **FAILING + `with`-reachable** (the lever) | **105** |
| **PASSING + `with`-reachable** (the control) | **96** |

Not 118 (the census figure) and not 50 (the discounted one).

### Cohort 1 — gate refusals (`#1387`): 39

The issue file predicted "~33 nested function/class + ~6 other proof failures".
**Measured: 39 of 39 are the nested-function/class boundary.** Zero are spread,
accessor, method, computed key or non-literal target. This is ONE mechanism, not
a family of proof gates.

### Cohort 2 — runtime wrong-answers: 66

Which lowering path each lever file actually takes, instrumented through
`compileWithStatement`'s own dispatch:

| path taken | lever files |
| --- | --- |
| `CE-nested-fn` — hard `#1387` refusal | 39 |
| **`T2-dynamic`** (30 of them via a bare-identifier `delete`) | **41** |
| `T1-struct` only | 24 |
| no `with` reached (harness-only match) | 1 |

## Root cause found and fixed: Tier-2 dynamic `with` is BLIND in standalone

Tier-2 resolves the Object Environment Record through `__extern_has` (HasBinding),
`__extern_get`, `__extern_set` and `__delete_property`. Standalone binds those to
the **native `$Object` open-hash helpers**, which walk `$Object` links — and a
WasmGC struct is not an `$Object`. The walk terminates immediately, **HasBinding
answers 0 for every name**, and the `with` degrades to a silent no-op whose
writes cascade past the object onto the outer/global binding.

This is unsoundness, not a coverage gap: Tier-2 is supposed to be the semantic
backstop for everything Tier-1 declines, and there it is structurally blind.

It also explains a census anomaly: the **standalone host-import-leak cohort
measured ZERO** across this entire family. Not because nothing leaks — because
the failure is silent. The module compiles clean with `imports: []`.

**Fix**: `src/codegen/declarations/dynamic-with-shape.ts` pins a `with` target
whose body contains a bare-identifier `delete` (the exact Tier-1 disqualifier, and
recognisable without type info) to the `$Object` representation, joining the
existing standalone `$Object`-hash-consumer set. Narrow by design — a target that
already proves Tier-1 keeps the zero-overhead struct path.

## A/B — two-sided, instrument validated

Base cut on `origin/main@1f613276d8`. Provider rebuilt at the FULL interpreter
tier per arm after **deleting the cache file** (keys did move: base
`89023379b8934c3e` → head `bb901ab226f8c791`; artifact byte size identical at
3,995,550 both arms, confirming size is not evidence).

**Base agreement: 201/201 file-by-file against the published *standalone*
baseline, 0 disagreements.** Lever 0/105 at base, control 96/96 at base.

| | base | head |
| --- | --- | --- |
| lever (105 failing, `with`-reachable) | 0/105 | **0/105** |
| control (96 passing, `with`-reachable) | 96/96 | **96/96** |
| fail→pass | — | **0** |
| pass→fail | — | **0** |
| still-failing, signature changed | — | **0** |

Unit-level A/B on the exact test262 object shape (RED-on-base verified):

| repro | base | head |
| --- | --- | --- |
| with-scoped write lands in the object (`myObj.p1 === 'x1'`) | **fail** (`a`) | **pass** |
| with-scoped bare `delete` removes the property | **fail** (`c`) | **pass** |
| with-scoped write does not clobber the outer binding | fail | **pass** |
| global assertion `p1 === 1` | fail (`null`) | fail (`null`) |

So the repair is real and measured; it converts no *files* because each
`S12.10_A1.*` file asserts ~19 things and dies on assertion #1, which this does
not touch.

### Base-sha caveat, stated rather than glossed

The 201-file A/B above was cut at `origin/main@1f613276d8`. Main then advanced
(#4203/#4204/**#4205** and others landed) and the branch merged it at
`a22a44a1c3`. The **arms were not re-run** on that tip; what WAS re-run there is
the unit matrix, and it reproduces every claim above:

- `s1` (with-scoped write lands in the object) — still **pass** with the fix;
- `s2` (`p1 === 1`) — still **fail** (`null`), so #4205's landed work does not
  unblock the lever;
- `s5` (the `with`-free `this.p1 = 1` vs bare `p1` split) — still **fail** on
  current main, so the blocker is intact and the 0-conversion reading is not a
  stale-base artefact of the kind that made #4201 read `FIXED 0`.

Anyone re-sizing this issue should still re-cut both arms rather than inherit
the 105/96 split — main is moving fast.

## Why the yield is 0 — and why it is NOT `with`'s fault

The 19-file `p1 === null` bucket (the largest in cohort 2) is blocked by a defect
that **reproduces with no `with` anywhere**:

```js
this.p1 = 1;
p1 = 'x1';
// bare `p1` and `this.p1` use DIFFERENT storage — the bare read does not see it
```

A script-top-level `this.p1 =` global-object property and a bare-identifier
read/write of the same name are not unified. That is #4205's mechanism.

This **refines** the 2026-08-07 census correction rather than reverting it. That
correction was right that #4205's *implementation* changed zero signatures here,
and right to reject the line-ordering inference. But "#4205's patch did not move
these" is not the same claim as "the blocking mechanism is `with`'s" — and the
delta-debug above shows it is not: it reproduces `with`-free. The `with`-side
defects are real and now fixed; they are simply **downstream** of the global
binding-unification defect, which fires first.

## Cohort A (39) is downstream of cohort D — do not size it independently

`S12.10_A1.7_T1` is byte-for-byte `S12.10_A1.1_T1`'s body wrapped in
`var f = function(){ … }; f();`; `A1.12`, `A1.8` and `A3.7`/`A3.8` are the same
relation. So implementing closure capture of the object environment record —
substantial work — would move those 39 files onto exactly the failures cohort D
already has. **Expected yield ≈ 0 until cohort D's blocker lands.** Sequence A
after D; do not staff it as an independent lever.

## Deferred, precisely located (not attempted here)

1. **Global-binding unification** (`this.p1 = 1` vs bare `p1`) — the actual
   blocker for ≥19 files, and `with`-free. Belongs with #4205.
2. **With-scoped `delete` result is not a boolean.** `del = delete p3` inside a
   Tier-2 `with` yields `1`, not `true` (base yielded `0` because the delete did
   not happen at all). `emitDynamicWithDelete` returns `{kind:"i32"}` and the
   with-write path coerces i32→externref as a **number** (`f64.convert_i32_s` +
   `__box_number`). A plain `delete o.p` is unaffected (its consumer is
   boolean-typed, so no boxing occurs). In scope for `with`, but unmeasured for
   yield, so deliberately left out of this PR.
3. **Cohort A** (39 files, nested function/class) — see above.
4. **The 24 `T1-struct`-only failures** — a separate mechanism from this one
   (includes the 11 `__str_concat` null-pointer files and `12.10-0-8`'s
   uninvoked setter). Not diagnosed here.

## Instrument note worth keeping (cost: ~1h)

`scripts/provision-worktree-deps.sh` **silently no-ops on this container**: with
no `/workspace`, `SOURCE_ROOT` resolves to the agent's *own* worktree, so it
"skips" every dep and exits **0**. Then the test262 pool worker dies at import on
a missing `scripts/compiler-bundle.mjs`, every test times out at 90 s, and the
run reports **201/201 FAILED with a 0-byte jsonl** — a uniform all-fail
indistinguishable from a catastrophic regression. Workaround:
`JS2_WORKTREE_SOURCE=/home/user/js2 bash scripts/provision-worktree-deps.sh <wt>`.

Also: the pool worker imports `scripts/compiler-bundle.mjs` and
`scripts/runtime-bundle.mjs`, **not `src/`**. Both MUST be rebuilt per A/B arm
(`esbuild src/index.ts …` / `esbuild src/runtime.ts …`, exactly as
`scripts/run-test262-vitest.sh` does) or the arm measures the previous compiler.
This is the same family as the provider-cache trap and is not yet in
`.claude/memory/reference_standalone_eval_instrument_reports_unmeasured_failures.md`.

---

## Handoff — 2026-08-07

The Tier-2 HasBinding fix landed (PR #4197) and the issue stays `ready` on
purpose: yield was **0**, and ~105 files remain.

**The real head of this cluster is NOT `with`, and it still has no issue.**
The 19-file `p1 === null` bucket is blocked by a defect that reproduces with no
`with` anywhere:

```js
this.p1 = 1;
p1 = 'x1';   // bare `p1` and `this.p1` use different storage
```

Re-verified on the merged tip **after #4205 landed** — still fails. That is
**global-binding unification**, ≥19 files, unowned and unfiled. File it before
staffing any more `with` work.

Also settled here, so it is not re-derived: cohort A (the 39 `#1387` gate
refusals) is measured **downstream** of cohort D — `S12.10_A1.7_T1` is
`A1.1_T1`'s body wrapped in a function expression, and `A1.12`/`A1.8`/`A3.7`/`A3.8`
stand in the same relation. Implementing closure capture of the object
environment would land those 39 on exactly the failures cohort D already has, so
expected yield ≈ 0. Sequence it after D, or not at all until D moves.

Session-wide context: `plan/agent-context/session-2026-08-07-lead-handoff.md`.

---

# 2026-08-11 — first closure-captured Object Environment Record slice

## Outcome

The fresh program residue was **73 failing ES5 standalone rows**. The original
39-row closure gate was re-run on canonical `main@ebba42dfff7ceb` with the FULL
interpreter provider. This slice converts **22/39** to pass, so the ES5 residue
falls to **51**. It is a real semantic slice, not a diagnostic deletion:

| original 39-row gate cohort | base | head |
| --- | ---: | ---: |
| pass | 0 | **22** |
| runtime fail | 0 | 7 |
| compile error | 39 | **10** |

The ten remaining compile errors are the `S12.10_A{1,3}.8_T*` constructor
rows. `new` needs a constructible-closure ABI that carries the captured
environment, so the shared selector retains an explicit `constructible closure
capture` refusal rather than compiling to a runtime `TypeError`.

## Root cause and contract

The statement compiler already kept an active `withScopes` entry while
compiling the body, but closure construction captured only identifier values.
Once control left the statement, the lifted function had no Object Environment
Record and bare names could not perform invocation-time `HasBinding`/Get/Set.

`src/ir/with-environment.ts` now owns the backend-neutral contract:

- capture the environment **receiver reference**, never a property snapshot;
- preserve outer-to-inner scope ordering;
- admit ordinary synchronous function expressions only;
- explicitly refuse arrows, declarations/hoisting, async/generators,
  classes/methods/accessors, and construction.

`src/ir/select.ts` and `src/ir/from-ast.ts` exercise that contract through an
actual first IR slice: a closed inline object literal, block body, no
field/declaration collision, and at least one admitted closure. The IR binds
fields as `withField` entries, emits ordinary `object.get`/`object.set`, captures
the receiver in `closure.new`, and rehydrates the property binding in the lifted
body. The regression test asserts `irBodyEmitted: true` and executes the module
host-free; this is not a legacy-only bypass.

The maintained standalone lowering consumes the same contract for the larger
measured surface (struct and dynamic externref receivers). Its normal WasmGC
closure ABI and JS-host callback capture struct carry the hidden receiver, then
recreate `withScopes` before body compilation. The lifted function's parameters
and own `var` bindings are added to the scope's blocked names because its own
Declarative Environment precedes the captured Object Environment Record.

## Maintained A/B and controls

Command (both arms, same 190 exact paths):

```sh
TEST262_TARGET=standalone TEST262_FULL_RUNTIME_EVAL=1 \
TEST262_PATH_FILTER='language/statements/with|language/statements/function/S13.2.2_A17_T2.js|language/statements/function/S13.2.2_A19_' \
TEST262_REPORTER=dot pnpm run test:262 -- --official-scope-only
```

| full filtered matrix | base | head | delta |
| --- | ---: | ---: | ---: |
| pass | 97 | **121** | **+24** |
| pass→non-pass | — | **0** | 0 |

The extra two improvements outside the 39-row ES5 cohort are the ES6
`has-property-err.js` and `scope-var-close.js` rows. All **97/97 passing
controls remain pass**. The maintained diff gate reports +24 net, zero
regressions, and no compile-timeout noise.

Full artifacts:

- base: `test262-standalone-results-20260811-225827.jsonl` (97/190);
- head: `test262-standalone-results-20260811-232846.jsonl` (121/190).

After the full run, the constructor selector was narrowed so `new
Test262Error(...)` does not look like construction of the captured closure. A
maintained one-row rerun of `S13.2.2_A19_T8.js` confirms the only status change:
the over-broad selector's compile error returns to its pre-existing assertion
failure. Pass and regression arithmetic is unchanged; inferred final broad
status is 121 pass / 54 fail / 15 compile error.

## Remaining 17 rows in the original cohort

- **10 constructor refusals:** constructible closure/environment ABI, named
  above.
- **2 early-return rows** (`A1.7_T3`, `A1.12_T3`): the function-local `var`
  correctly shadows the object, but its uninitialized value is represented as
  `null`, not `undefined`.
- **2 abrupt-completion rows** (`A3.7_T4/T5`): the assertion-message path traps
  in the pre-existing `__str_concat` null handling after an implicit-global
  result mismatch.
- **`S13.2.2_A17_T2`:** assigning a function value through the object
  environment loses the callable carrier (`getRight()` returns `null`).
- **`S13.2.2_A19_T7/T8`:** script-global ownership/hoisting assertions fail
  before or outside the captured-environment read.

This issue stays `ready`: the callable environment slice is complete and
measured, while constructor capture and those independently named runtime
mechanisms remain follow-up work.

## Re-measurement + root-cause routing (claude/es5-team-with, 2026-08-15)

Worked from the three sections the ES5-wave note marks as mandatory. **No source
change in this slice** — the item it named as "fix first" turned out to be worth
zero passes, and the root cause routes out of this issue entirely (to **#4495**).

### Correction 1 — the residue is 68 non-pass, not 115. The first baseline was instrument noise.

My first scan of `language/statements/with` at `--target standalone` reported
**66 pass / 102 fail / 13 CE**. That was wrong: **56 of the 115 non-pass rows
were `JS2WASM_EVAL_ENGINE=quickjs but the quickjs provider is not built`**.

The trap is one layer below the "Instrument note worth keeping" already in this
file: `TEST262_FULL_RUNTIME_EVAL=1` selects the **interpreter** tier, but since
**#4242 the default engine is quickjs**, and the selector deliberately never
builds an engine. So the flag this issue's own maintained A/B command uses no
longer implies a working provider.

| 181 files, `--target standalone` | pass | fail | CE |
|---|---:|---:|---:|
| broken instrument (provider missing) | 66 | 102 | 13 |
| **working instrument (authoritative)** | **113** | **55** | **13** |

Fix — build both bundles first, then the provider (both bundles must be rebuilt
**per A/B arm**; the pool worker imports `scripts/compiler-bundle.mjs`, not `src/`):

```sh
node_modules/.bin/esbuild src/index.ts   --bundle --platform=node --format=esm \
  --outfile=scripts/compiler-bundle.mjs --external:typescript --external:binaryen
node_modules/.bin/esbuild src/runtime.ts --bundle --platform=node --format=esm \
  --outfile=scripts/runtime-bundle.mjs  --external:typescript --external:binaryen
NODE_OPTIONS=--max-old-space-size=3072 node scripts/build-quickjs-eval-provider.mjs
```

Both the **13** `__str_concat` rows and the **10** `#1387` CE rows reproduce at
exactly the counts the ES5-wave note predicted, which cross-validates that note's
baseline and localises the error to the harness rather than to the corpus.

Current taxonomy (working instrument): 13 `__str_concat` · 10 `#1387` CE ·
4 `p1 === "x1"` actual `1` · 4 `result === undefined` actual `null` ·
3 missing-ReferenceError · 2 each `theirObj.p1` actual `true`,
`[Symbol.unscopables]` call count, CE `Reflect.set` with explicit receiver,
`$DONOTEVALUATE` reached · rest singletons.

### Correction 2 — the 13-row crash class is a ZERO-YIELD item. Demoted.

The ES5-wave note ranks the `__str_concat` crashes as "crash class, fix first".
Fixing them produces **no passes**, and this is checkable from the test sources
rather than a judgement call: **in all 13 files every string concatenation is
inside a `throw new Test262Error(...)`** (3 throw-concats, 3 total concats per
file), so a passing run never concatenates. The crash is reached only after the
assertion has already decided the test failed.

Verified directly: neutralising the message concatenation
(`throw new Test262Error('MARKER')`) and re-running the assembled harness still
**throws** — the assertion fails on its own merits.

**Consequence:** fixing the null-deref converts a hard crash into a clean
assertion failure. Worth doing for *diagnosability* (the crash hides the real
value mismatch and pollutes this taxonomy), but it must not be scheduled as a
13-row yield item. The passes come from Correction 3.

### Correction 3 — root cause is NOT `with`. Routed to #4495.

Bisected to a repro with no `with`, no globals, no try/catch:

```js
function id(x) { return x; }
var result = 'r';
result = id(1);
var out = '' + result;   // dereferencing a null pointer in __str_concat
```

A string-literal-initialised JS local keeps a **native-string slot**; assigning a
dynamic value stores **null** when the runtime value is not a string. The null is
**deliberate** at `src/codegen/type-coercion.ts:2469`, with generic ToString
explicitly rejected there on the record — so that site is not the bug and must
not be "fixed" with a ToString. The real defect is slot typing one level up.

Filed as **#4495** (`feasibility: hard`, `architect_spec: required`, Fable-lane
implementation plan required before dispatch — blast radius is every string local
in every `.js` file).

**#4495 subsumes this file's 2026-08-07 "real head of this cluster" item.** That
handoff named global-binding unification (`this.p1 = 1` vs bare `p1`, ≥19 files)
as the unfiled head; `this.p1` globals are dynamic to the checker and therefore
one **source** of #4495, but `id(1)` reproduces the identical crash with no
globals at all. One head, not two — do not file global-binding separately.

A/B'd against the (then-uncommitted, now merged as `5cde3f054`) #2867 S2/S2b
changes: byte-identical on both arms, so pre-existing and unrelated.

### Revised sequence for this cluster

1. **#4495** (head) — everything below is downstream.
2. Optionally fix the `__str_concat` null-deref for **diagnosability only**,
   labelled 0-yield, so the 13 rows report their real mismatch.
3. The 10 `#1387` CE rows stay where the 2026-08-11 slice left them
   (constructible-closure ABI). The "Cohort A is downstream of cohort D" analysis
   above still holds — nothing found to revise in it.
4. Re-measure after (1): the 4 `p1 === "x1"` and 4 `result === undefined` actual
   `null` rows are plausibly the same slot defect and may move for free.

Also filed from this slice: **#4496** (`__drain_microtasks()` in an
otherwise-empty module emits an invalid binary — `__str_ws_start` type mismatch;
unrelated to `with`, found while correcting a stale #2895 test assertion).

### Correction 4 (same day, supersedes part of Correction 3) — global-binding is a SEPARATE head

Correction 3 said #4495 "subsumes this file's 2026-08-07 real-head item" and that
global-binding should **not** be filed separately. **That was wrong**, and it is
corrected here rather than left to mislead. The controlled experiment below holds
the **type constant**, so #4495's slot-typing mechanism cannot explain the
results — no `with` anywhere, `--target standalone`:

| case (every value numeric) | result |
|---|---|
| `this.p1 = 1; var f = function(){ p1 = 2; }; f(); p1 === 2` | **WRONG** |
| `var p1 = 1; p1 = 2; this.p1 === 2` | **WRONG** |
| `var p1 = 1; this.p1 = 2; p1 === 2` | **WRONG** |
| `this.p1 = 'a'; f(){ p1 = 'b' }; f(); p1 === 'b'` (string throughout) | **WRONG** |
| `var p1 = 1; var f = function(){ p1 = 2; }; f(); p1 === 2` (var global) | ok |

`this.p` and bare `p` are **two different storages that never reconcile in either
direction**. The split only becomes observable across a **closure boundary** or a
**`this.`/bare direction change** — straight-line `this.p1 = 1; p1 = 'x1'` and a
plain bare read of a `this.`-assigned global both work, which is why it hides.

The two defects **co-occur** in this corpus because `this.p1 = 1` both splits the
storage and makes the value dynamic (feeding #4495's string-slot path). That
co-occurrence is exactly what produced the incorrect merge in Correction 3. The
clean separator is `function id(x){return x}`, which reproduces #4495 with no
globals at all.

**Global-binding unification still needs its own id** (the 2026-08-07 handoff was
right to call it out); #4495 does not cover it. Two heads, not one.

### Boundary answer for the remaining clusters — NEITHER is independently takeable

Measured, so the next lane does not re-derive it:

| cluster | rows | verdict |
|---|---:|---|
| `#1387` closed-shape CE gate | 10 (+1 `unscopables-inc-dec`) | **Not bounded.** All ten are the `S12.10_A{1,3}.8_T*` constructor rows, which this file's own 2026-08-11 slice already identified as needing a **constructible-closure ABI carrying the captured environment**. That is an ABI project, not a slice. |
| `p1 === "x1"` actual `1` | 6 | Downstream of **global-binding** (own head, needs an id). `with` is not involved — see Correction 4. |
| `result === undefined` actual `null` | 4 | Downstream of **#4495** — a native-string slot cannot represent `undefined` at function entry, so a hoisted `var` read before its declaration defaults to null. |
| `theirObj.p1` actual `true` | 2 | Not diagnosed. |

So the honest boundary is: **no further `with`-lane slice is takeable without
first landing #4495 and a global-binding issue.** Both are heads with wide blast
radius, both need a Fable-lane implementation plan, and neither should be started
off this file alone. This issue stays `ready` but should be treated as **blocked
on those two** rather than as a source of ready work.

## 2026-08-19 re-census + dispatch

Fresh standalone baseline (`test262-standalone-current.jsonl`, 48,735 entries,
fetched 2026-08-19 04:52): standalone ES5 is **8,506 / 9,029 (94.2 %)** with
**523 non-passes** (495 fail, 24 compile_error, 4 compile_timeout). Earlier
figures in this file predate that and should be read as history.

This issue's lane in the 2026-08-19 6-way fan-out: **56 rows — annexB eval-code/global-code, language/eval-code, statements/with**.
Umbrella + full partition: #4163.

The residue is a **long tail** — the largest single error signature across all
523 rows is 13. Expect many small root causes, not one lever.

Local gate for this lane: 551 locally-verified-passing standalone ES5 tests must
stay at 551/551. Reproduce with the `--standalone` flag (without it you measure
the JS-host lane, a different and much worse corpus at 84.8 %).

**eval-rooted rows cannot be validated on the dev Mac** — CI's QuickJS eval tier
needs clang-18 (see #4163 for the full toolchain finding); record them as
blocked rather than chasing them.

## 2026-08-19 landed slice — 13 rows, verified by the integrator

Commit `bbe5002` on `es5-eval-with-annexb`, merged to `es5-standalone-integration`.

**Lane 0 → 13 of 56, guard 551/551 (zero regressions), `target=standalone`** —
both figures re-measured independently by the integrator, not accepted from the
implementing lane.

### The 13-row cluster was neither `__str_concat` nor eval

`dereferencing a null pointer [in __str_concat() ← __module_init]` was the
largest single signature in the whole 523-row ES5 standalone residue, and it sat
under `language/statements/with/`, so it read as a `with`/eval problem. It is a
**lossy store** in slot widening:

`src/codegen/declarations/heterogeneous-scalar-var-widening.ts::assignmentWidens`
refused to widen a primitive-pinned module `var` slot when the RHS's static tag
was `mixed`. So `var result = "result"; result = p1;` keeps a
`(ref null $AnyString)` slot, a number RHS fails the string coercion, **null** is
stored, and the next `"" + result` dereferences it. The `with` scoping was
already correct — probing `S12.10_A3.1_T2` showed `p1`, `this.p1` and
`myObj.p1` all holding the right values; `result` was the only wrong one.

### This reverses #4204's recorded verdict

#4204 asserted that an unprovable (`mixed`) RHS must NOT widen, on the grounds
that it "would move a large fraction of the corpus onto the dynamic
representation for no measured benefit (5,943 syntactic candidates against 55
provable ones)". That estimate was not re-measured when it was written into the
negative test.

Measured 2026-08-19, both halves:

| check | result |
| --- | --- |
| 73 compiled `language/{statements,expressions}` modules, byte comparison | **1** module changed — and it **shrank** |
| 1,200-file standalone A/B | 856 → 859; **0 pass→fail, 0 altered failure signatures** |
| `tests/equivalence` | same 5 pre-existing failures in both arms |

So the corpus-cost concern does not hold, and the refusal was not a coverage
gap but a correctness bug. #4204's negative case was **updated in place** to
assert the new verdict with the measurement recorded beside it, rather than
deleted — the reversal stays visible to anyone re-deriving the predicate.
A RED-on-base regression test was added
(`tests/issue-4206-mixed-rhs-slot-widening.test.ts`).

### Side effect worth knowing

Rows hitting `quickjs provider is not built` went 4 → 11: the fix carries tests
*past* their earlier failing assertion and into an `eval` call. Those become
locally unverifiable rather than fixed — see the toolchain note in #4163.

## 2026-08-20 follow-up — keep inferred widening and IR binding selection aligned

The required #2906 async guard exposed an integration invariant after the
mixed-RHS widening landed. Its `let ran: number = 0` has an unreachable
`ran = x` after an awaited promise that always rejects. The RHS is necessarily
unconstrainable, so the widening analysis picked legacy `externref`; the IR
module-binding resolver correctly kept the explicit `number` annotation's f64
ABI. The compiler then rejected the claimed body because the two plans named
different physical storage for the same source binding.

The resolution preserves both contracts:

- explicit TypeScript annotations remain the representation authority (the
  same boundary recorded in #4495), so the #2906 binding stays f64 and its
  reader/module initializer remain IR-owned;
- JavaScript and inferred TypeScript bindings still widen on heterogeneous or
  mixed assignments, preserving the 13-row #4206 lever;
- the registry-free widening analysis now lives beside IR module bindings and
  is consumed by both direct allocation and IR selection. Until IR owns general
  dynamic module assignment/read coercions, a genuinely widened binding is
  rejected before claim instead of reaching the Program ABI invariant after
  claim. The invariant itself remains strict.

Regression coverage is in
`tests/issue-4206-module-widening-ir-parity.test.ts`: one case proves the typed
slot stays f64 and the reader emits through IR; the other proves an inferred
externref slot cleanly preclaim-demotes and still round-trips its runtime value.
## 2026-08-21 — two more `with` clusters closed, one re-diagnosed

Measured on `claude/pull-from-upstream-zgdo0m` @ c0297f920c, `--target
standalone`, single-test in-process runner, quickjs eval provider built
(adapter key `1429ec7ecf2163fd` — without it the whole `S12.10_A1.8_T*` family
reports a provider-missing error rather than its real result).

### Cluster A — `with`-routed RETURN value was coerced to the shadowed binding's type (5 rows)

`language/identifier-resolution/S10.2.2_A1_T5..T9` — all five `fail` →
all five `pass`.

```js
var x = 0;
var myObj = { x: "obj" };
function f1() { with (myObj) { return x; } }   // spec: "obj"
```

**The prior diagnosis was wrong in a way worth recording.** It read the failure
as `proveStructTypedWithTarget` declining an outer-scope receiver. Instrumented,
that proof *accepts* (`ACCEPT __anon_1`) and Tier-1 routes the read correctly —
proved by re-running with `var x = "outer"`, which returns `"obj"`. The bug is
one level up: the TS checker does not model `with`, so it resolves `return x` to
the outer `var x = 0` and infers `f1(): number`. Codegen pins the wasm result to
`f64` and coerces the routed *string* field into it, so `f1()` is `NaN`.

Fix: `functionReturnsThroughWithScope` (src/codegen/declarations.ts) — a
function with no explicit return annotation that has a `return <expr naming
something>` inside one of its own `with` bodies gets an `externref` result
instead of the inferred one. Transitive through a direct `return callee()`,
because T5–T8 wrap the `with` in an inner `f2` and return `f2()` from `f1`,
where the same misinference repeats. Wired at all three function-registration
sites (two in declarations.ts, one in statements/nested-declarations.ts).

### Cluster B — `new` over a `with`-body closure (10 rows)

`language/statements/with/S12.10_A1.8_T1..T5` and `S12.10_A3.8_T1..T5` — all
ten `compile_error` → all ten `pass`. Three stacked blockers, not the two on
record:

1. **The IR selector refused the statement.** `visitConstructors` in
   src/ir/with-environment.ts rejected any `new` over a with-captured closure.
   The with-captures ride the closure struct like ordinary captures, so
   construction needs no new lowering; the refusal is removed.

2. **`new f()` threw `TypeError: f is not a constructor` at the
   unresolvable-identifier arm.** TypeScript deliberately declines to resolve
   bare identifiers inside a `with` body, so `getSymbolAtLocation` answers
   `undefined` even for a `var` declared in the same block — and
   `tryNonConstructableNewTarget` reads "no symbol" as "no binding exists,
   throw". That arm now declines inside a `with` body
   (src/codegen/expressions/new-non-constructable-value.ts).

3. **The native-construct driver was never reserved, for the same reason.**
   `resolvesToConstructableFunctionValue` needs the callee's declaration, which
   the checker will not give inside a `with`. It now falls back to a syntactic
   scan for `var <name> = function (…) {…}` in the enclosing scope, declining on
   any rebind (src/codegen/expressions/new-super.ts). With that, the existing
   `__native_construct_N` driver constructs the closure value and the
   with-scoped writes inside the constructor body land on the receiver.

### Cluster C — `var f = function(){}` inside `with` — RE-DIAGNOSED, not fixed

`S13.2.2_A19_T8`'s CHECK#0 (`typeof __func` must be `"undefined"` at the top of
the program) was attributed to with-environment closure lifting installing a
hoisted module-level function binding. **It is not a `with` bug at all.** The
identical program with the `with` removed fails identically:

```js
if (typeof __func !== "undefined") throw …;   // observed: "function"
var __func = function () { return 2; };
```

So the defect is in the general `var f = function(){}` lowering (the binding is
hoisted already carrying its function value instead of `undefined`), and fixing
it means touching the typeof/var-function-expression model, not `with`. Not
attempted here.

`A19_T8` also has a **second, independent** failure: with CHECK#0 neutralised,
CHECK#1 passes but CHECK#2 returns the outer `b` (`"a"`) instead of the second
`with` receiver's `b` (`"b"`) — a re-declared `var __func` inside a *second*
`with` block keeps the first block's scope.

`S13.2.2_A17_T2/T3` and `A18_T1/T2` are a different subsystem again: they assign
to **undeclared** globals (`__obj = …`, `getRight = …`) and `A18` uses
`with (arguments)`. Out of reach without the implicit-global-binding work.

## 2026-08-21 (later) — 10 of the 12 `language/statements/with` residue rows closed

Measured on `claude/pull-from-upstream-zgdo0m` @ `88bd2ccf0e`, `--target
standalone`, single-test in-process runner, QuickJS eval provider built locally
(artifact `13c33e175f16`, adapter key `1429ec7ecf2163fd`). Row set: the 12
`language/statements/with` non-passes in
`benchmarks/results/test262-standalone-results-20260821-122045.jsonl`. All 12
re-verified failing on that head before any edit.

### Cluster D — a direct `eval` could mutate a literal the compiler had CLOSED (7 rows)

`S12.10_A4_T{4,5,6}` and `S12.10_A5_T{1,2,3,6}` — all seven `fail` → `pass`.

The membrane was NOT at fault, which is what the split below establishes. In a
module with `eval`, `myObj` crosses to QuickJS as a live membrane wrapper and
`__membrane_set` / `__membrane_delete` run the compiled object's own dynamic
paths. What fails is the REPRESENTATION on the compiled side: a closed struct
pins each field's storage type and its key set, so:

| eval'd code, `var myObj = { p1: 'a' }` | observed |
| --- | --- |
| `with(myObj){ p1 = 'b' }` (string → string) | correct — this is why `A4_T1..T3` always passed |
| `with(myObj){ p1 = {b:'hi'} }` | write silently DROPPED, `p1` stays `'a'` |
| `myObj.p1 = {b:'hi'}` (no `with`) | stores **null** |
| `with(myObj){ del = delete p1 }` | `del === true`, `'p1' in myObj` still true |

Isolation: adding a syntactic `delete myObj.p1` under `if (false)` — which
routes the literal to the open `$Object` via the existing
`markStandaloneDeleteTargets` poison — makes every one of those cases behave
correctly with no membrane change at all.

Fix: `collectEvalMutableNames`
(src/codegen/declarations/eval-reachable-object-shape.ts) joins the three
existing `markStandalone*Targets` markers in
`collectGrowableObjectLiterals`, so a var an `eval` can mutate is promoted to
the open representation and inherits that block's concrete-struct consumer
guard unchanged.

The trigger is deliberately narrow — opening a literal costs the fixed-key
`struct.get` fast path — and requires all four of: a direct by-name `eval`; a
compile-time-known argument (string / substitution-free template); the variable
occurring as an IDENTIFIER token in that text (scanned with `ts.createScanner`,
so a name inside a nested string or comment does not count); and the text
containing something that can mutate (`=`, a compound assignment, `++`/`--`,
`delete`). **Declared residual:** a computed eval source (`eval(src)`) promotes
nothing — it says nothing about which names it touches, and opening every
literal in the module on its account was not worth the cost.

Blast radius measured, not argued: all **538** currently-passing standalone rows
whose source contains an `eval(<literal>)` were re-run — 538/538 still pass.

### Cluster E — Tier-2 `with` bound a COPY of its target (3 rows)

`S12.10_A3.5_T{1,2,4}` — all three `fail` → `pass`.

`compileDynamicWithStatement` asked `compileExpression` for `externref`. For a
nominal struct that routes through the #2358 ToPrimitive-boundary arm, which
REIFIES (field-copies) a literal carrying `valueOf`/`toString` into a fresh
`$Object`. §14.11.7 binds ToObject(target) — the same object — so every write
made through the object environment record landed on the copy and was lost.

It is silent in a way worth recording: the body's own read of the name answers
the value it just wrote (the copy is consistent with itself), so only an
observation of the ORIGINAL object shows the loss.

Factor isolation (each row a separate compile+run):

| shape | `o.p1` after `with (o) { p1 = 'x' }` |
| --- | --- |
| `{p1, valueOf: fn}` inside `for (k in o)` | `'a'` — WRONG |
| `{p1, toString: fn}` inside `for (k in o)` | `'a'` — WRONG |
| `{p1, foo: fn}` inside `for (k in o)` | `'x'` — ok (name-triggered, not fn-member-triggered) |
| `{p1, n: 5}` inside `for (k in o)` | `'x'` — ok |
| `{p1, valueOf: fn}` with NO loop | `'x'` — ok (still proves Tier-1) |

So both factors are required: the enclosing `for…in` is what pushes the
statement onto Tier-2, and `valueOf`/`toString` is what makes the Tier-2
coercion copy.

Fix: compile the target with NO expected type and convert the reference by hand
(`extern.convert_any` for a `ref`/`ref_null`), so the record holds the live
object. `__extern_get`/`__extern_set` already carry closed-struct arms for it.

### Still failing — `S12.10_A5_T4` / `A5_T5`, and they advanced

Both now delete correctly (`'p1' in myObj` is `false`) and fail one check
later, on a defect that is NOT `with`-related and reproduces with a plain
syntactic `delete`:

```js
var o = { p1: {a:'hello'}, del:false };
delete o.p1;
o.p1.a;            // returns undefined; must throw TypeError
typeof o.p1;       // "object"; must be "undefined"
```

A member read off a deleted/absent property of an open `$Object` neither throws
nor types as `undefined`. That is its own head — property-access on the open
representation — and should not be filed against `with`.

### `language/statements/function` — 25 rows re-verified, clustered, none taken

All 25 reproduce on this head. Clustering (so the next lane does not re-derive
it), with the two `with`-adjacent clusters already covered above:

| cluster | rows | first cause |
| --- | ---: | --- |
| `f.prototype` / `prototype.constructor` object model | 4 | `S13.2.2_A1_T1/T2`, `S13.2_A4_T2`, `13.2-17-1` — overlaps the function-prototype lane, deliberately not taken here |
| `new F()` whose ctor RETURNS a function | 3 | `S13.2.2_A8_T1/T2/T3` — `typeof new F()` is `"object"`, want `"function"`; this is #2071's area |
| `arguments` extras lost on an INDIRECT call | 2 | `S13.2_A2_T1/T2` — `var g = F(); g("x")` reads `arguments[0]` as null when the callee has 0 formals; direct calls are fine |
| `+` picks numeric when one operand is `arguments[i]` | 1 | `S13_A2_T2` — `(function(arg){return arg + arguments[1]})(1,"1")` is `2`, want `"11"`; `typeof arguments[1]` is already correctly `"string"`, so the vec is right and the OPERATOR is wrong |
| implicit-global / `with (arguments)` | 4 | `S13.2.2_A17_T2/T3`, `A18_T1/T2` — unchanged from the earlier entry |
| `var f = function(){}` hoists carrying its VALUE | 2 | `S13.2.2_A19_T7/T8`. Re-measured with no `with` anywhere: `typeof __func` before the declaration line answers `"function"`; `this.hasOwnProperty('__func')` answers `false`. Two separate heads (hoisting model; global-binding unification) |
| unimplemented builtin | 1 | `S13.2.1_A5_T2` — `Math.sin` in standalone |
| unclustered singles | 8 | `S13_A6_T1`, `S13.2.2_A5_T1`, `A2`, `A4_T2`, `S13_A15_T3`, `S13_A11_T4`, `13.2-18-1`, `S13.2.1_A6_T2` |
