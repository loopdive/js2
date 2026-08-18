---
id: 4112
title: "REFUTED — LEVER 3: the `Function` constructor path IS wired to the runtime-eval provider; the blocker is the unpublished interpreter tier, and it sits INSIDE the ex-dynamic-code exclusion set"
status: done
completed: 2026-08-02
sprint: 78
created: 2026-08-02
updated: 2026-08-18
assignee: ttraenkler/dev-lever3
priority: medium
horizon: s
feasibility: n/a
task_type: analysis
area: conformance
language_feature: eval
goal: es5
related: [2928, 2929, 2527, 3977, 4057]
origin: "2026-08-02 dispatch, LEVER 3 of the <=ES5 standalone program: 'the runtime-eval provider is still unlinked on the Function constructor path — 206 <=ES5 failures'. Re-measured before building, per the program's measure-first rule. The premise did not survive."
---

# #4112 — LEVER 3 REFUTED: the `Function`-ctor consumer was already wired

**Verdict: the lever's premise is false, and no implementation was written.**
LEVER 3 was dispatched as an instance of the #4080 family — *"a correct
treatment exists and one consumer was never wired to it"* — with the `Function`
constructor named as the unwired consumer of the runtime-eval provider that
PR #3691 landed. It is wired. The residual failures are the **capability-less
refusal provider CI deliberately links**, answering exactly as designed.

This is the third of five levers in this program refuted by measurement before
any code was written. The write-up exists so the next agent does not rebuild on
the same premise — the failure signature *reads* like an unlinked import unless
you check which side produced it.

## Provenance

| | |
| --- | --- |
| standalone baseline | `loopdive/js2wasm-baselines`, `baseline_sha 6660c1158c026984b69d3e3b619255672a4da911`, generated **2026-08-02T19:39:50Z**, `oracle_version 12`, **48,619 rows** |
| host baseline | same run, **48,354 rows** |
| corpus files unopenable | **0** (floored and printed) |
| head includes | #3933, #3940, #3951 (verified by ancestry from `6660c1158`) |

Both lanes are the **refusal tier** — i.e. CI-comparable. Per #2928's E7 rule,
any figure taken with `TEST262_FULL_RUNTIME_EVAL=1` is the interpreter tier and
is **not** CI-comparable; nothing below uses that flag.

## Three independent proofs that the consumer is wired

1. **Baseline.** In the Function scope there are **0** rows failing at the
   runtime-eval import link. The E7-era signature
   (`Import #0 "js2wasm:runtime-eval": module is not an object or function`)
   is gone from this scope entirely.

2. **Code.** Both call shapes reach the provider through one site:
   - `Function(...)` — `tryStandaloneDynamicFunctionCtorValue`,
     `src/codegen/expressions/eval-inline.ts:1062`
   - `new Function(...)` — `src/codegen/expressions/new-builtin-globals.ts:606`

   both → `emitStandaloneDynamicFunctionRuntime` → `__runtime_new_function`.

3. **The issue's own record.** #2928's E7 findings (landed 2026-08-01,
   `aa5cd38dc`) already state that the 103 in-scope link failures went to **0**,
   and that "~90 of the 103 genuinely need the interpreter".

### The trap that makes this look like a wiring gap

The refusal message **contains the string `js2wasm:runtime-eval`**:

```
TypeError: dynamic code evaluation is not supported in this standalone build
(no js2wasm:runtime-eval interpreter ...)
```

A regex for `js2wasm:runtime-eval|module is not an object or function` matches
**all** of them and reports a link failure that no longer exists. The census of
2026-08-01 hit the same trap independently (its refutation 3: "the *link*
failure is gone, but the same files now throw a refusal whose text still
contains `js2wasm:runtime-eval`, so a naive regex re-matches all 118"). Two
agents, same string, same wrong conclusion — so this is a property of the
message, not of either reader. **Discriminate on which side produced the text**,
not on the substring.

## The real mechanism

CI links a **capability-less refusal provider** — 53,152 bytes, 2.5 s to
compile, zero imports, both entry points return `[false, TypeError]` — because
the real Acorn+interpreter provider is **2,447,002 bytes and 151 s to compile**,
which is unaffordable across 36 standalone shards. So the `Function`-ctor call
reaches the provider and the provider declines. The blocker is #2928's own
"What is still owed" item 2: publish the interpreter tier to CI via #2527
packaging. That is XL packaging work, not a narrow wiring fix.

## Re-measured population

Two denominators are in play and are **not interchangeable** (this is #3977's
refutation 6). Both are given.

### A. Goal scope — `es5id` present OR no id key (the ex-dynamic-code goal)

Instrument validated: this classifier reproduces the 2026-08-01 census
denominator **exactly**.

| | 2026-08-01 census | **this run (2026-08-02)** |
| --- | ---: | ---: |
| goal scope run | 8,545 | **8,545** ✓ |
| pass | 6,176 | **6,432** |
| not-pass | 2,369 | **2,113** |
| T1 dynamic-code refusals | 144 | **147** |

**+256 goal-scope passes in one day.** Anchored to the two baseline shas above,
not to memory.

Function scope = `built-ins/Function/**` + `language/statements/function/**`:

| | files |
| --- | ---: |
| not-pass, goal scope | **269** |
| — T1 dynamic-code refusal | **97** |
| — SyntaxError-shape, also interpreter-dependent | **11** |
| — **remainder, reachable without the interpreter** | **161** |

### B. `classifyEdition() === 5` (the #3977 denominator)

589 ES5-classified Function-scope files: 319 pass / 247 fail / 23 CE =
**270 not-pass**; **102** are the provider refusal; **0** are link failures.

Against the dispatch brief's figures, measured on the same scope:
`built-ins/Function/prototype` **110/189** (brief said 123/189) and
`language/statements/function` **71/213** (brief said 83/213) — **25 already
fixed** between the brief being written and this measurement.

## The classification that decides #2527's priority

**97 of the interpreter-dependent Function-scope files are T1 dynamic-code
refusals — 66.0 % of the entire 147-file goal-scope exclusion bucket.**

The stakeholder ruling of 2026-08-01 restated the goal as **~95.4 %
ex-dynamic-code**, excluding the dynamic-code files as decline-by-dependency
rather than failures. The interpreter tier's yield therefore lands almost
entirely on files that are **already out of scope**.

> **#2527 / the interpreter tier is real work, but it is NOT on the ES5-goal
> critical path.** It should be scheduled against the runtime-eval goal on its
> own merits, and it must not be sold as an ES5 lever.

**Non-circularity control** (the census's own control, re-run here): the same
detector over goal-scope **passes** finds **309 files that use
`eval`/`Function` and pass anyway** (census reference: 248 for
eval/`with`/`Function`). Dynamic code is not automatically fatal, so the
exclusion is identified by **engine refusal**, not by feature mention.

## Exclusion-set fold-in: 11 newly identified members

These 11 are interpreter-dependent but were **not** in the exclusion set,
because their failure text is an assertion, not the refusal string. The
mechanism is **refusal-TypeError masking interpreter-dependence**: the test
wants the interpreter's *parser* to raise a `SyntaxError` for a bad
`Function(...)` body; the refusal tier throws `TypeError` first, so the file
presents as `Expected a SyntaxError but got a undefined` /
`(e instanceof SyntaxError) is expected to be true`.

```
test/built-ins/Function/S15.3.2.1_A1_T8.js
test/built-ins/Function/S15.3.2.1_A1_T13.js
test/built-ins/Function/S15.3.2.1_A3_T6.js
test/built-ins/Function/S15.3.2.1_A3_T9.js
test/built-ins/Function/S15.3.2.1_A3_T10.js
test/built-ins/Function/15.3.2.1-11-1-s.js
test/built-ins/Function/15.3.2.1-11-3-s.js
test/built-ins/Function/15.3.2.1-11-5-s.js
test/built-ins/Function/15.3.2.1-10-6gs.js
test/language/statements/function/13.0-13-s.js
test/language/statements/function/13.0-14-s.js
```

Folding them in takes the goal-scope dynamic-code bucket **147 → ~158**. This
**applies** the standing 2026-08-01 ruling to newly identified members; it does
not change the ruling. Listed here so the exclusion set stays auditable rather
than drifting.

## The in-scope remainder of this area

**161 files**, reachable without the interpreter. It is a long tail, not a rock
— the largest single signature is 16 files (6 % of 269):

| files | signature |
| ---: | --- |
| 16 | `Expected a TypeError to be thrown but no exception was thrown at all` |
| 11 | `newInstance.valueOf() Expected SameValue(«null», «true»)` |
| 9 | `dereferencing a null pointer [in __module_init()]` |
| 7 | `obj.property Expected SameValue(«undefined», «12»)` |
| 4 | `dereferencing a null pointer [in __fnctor___func_new() ← __module_init]` |
| 4 | `standalone target emitted host imports: env::Object_isPrototypeOf (#2961)` |
| 3 | `'__get_builtin' (dynamic-shape object/property operation) is not yet supported` |

Two of these are already-named programmes elsewhere (the missing-throw family
is Overlay A of the 2026-08-01 census, 155 files; the `__get_builtin` gap is the
dynamic-property substrate). Nothing here justifies a dedicated lever.

## For task #42 (one clean interpreter-tier measurement)

The numbers above are the **refusal-tier / CI-comparable control arm**, taken at
a head that already includes #3933/#3940/#3951 — which is what #2928's E7 asked
for, since arm C was measured at `608cd95e6` and predates them. The
**interpreter arm still cannot be run in CI at all**: it needs
`TEST262_FULL_RUNTIME_EVAL=1` locally, and such a number is explicitly not
CI-comparable until #2527 publishes the provider. #42 should reuse this arm as
its control and state the tier with its own figure.

## Reproducing

Scripts are ~40 lines each and were left in the authoring worktree under
`.tmp/` (`scope.mts` — the goal-scope classifier with its 8,545 control;
`lever3-classify.mts`; `es5-function.mts`). The goal-scope rule is:
**frontmatter has `es5id`, OR has none of `es5id`/`es6id`/`esid`.** Positive
control both directions: `S8.5_A1.js` {es5id} in ✓ ·
`Symbol.toStringTag.js` {es6id} out ✓.
