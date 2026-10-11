---
id: 4016
title: "standalone: String.prototype search-value methods refuse the spec's plain-ToString path"
status: in-progress
sprint: current
priority: high
horizon: l
feasibility: hard
reasoning_effort: max
goal: standalone-gap
assignee: ttraenkler/M-regexp
created: 2026-08-01
updated: 2026-09-20
oracle-ratchet-allow: []
loc-budget-allow:
  - src/codegen/regexp-standalone.ts
---

## 2026-09-20 wrap-up handoff — unfinished split coercion follow-up

The original plain-ToString scope completed on 2026-08-02. This issue is
reopened for the unfinished split-coercion follow-up below; this handoff PR
contains documentation only, not the unpublished implementation.

### Preserved work and measured evidence

- Candidate: `/private/tmp/js2-4016-split-coercion-order-20260920`, branch
  `codex/4016-split-coercion-order-20260920`. Matched baseline:
  `/private/tmp/js2-4016-split-coercion-order-baseline-20260920`.
  Both were synced to `ac76d8c6cd63864e04de4592a5179050ff1b1f91` without
  discarding dirty work. The implementation is committed locally but its
  attempted draft publication was blocked by the mandatory coercion-site gate.
  The implementation checkpoint is `1fb196048b26b9a686eaf5a4719cc646a1d1353a`;
  no remote code PR is claimed.
- Owned source: `string-search-value.ts`, `string-ops.ts`,
  `string-proto-split.ts`, and new `string-split-coercion.ts`, all under
  `src/codegen/`. The helper SHA256 is
  `ed7f9af98d71a5e7712f790039728164fccee847c0e66e97b56514a55d3f787b`.
  That is the measured pre-format helper. The formatted checkpoint helper is
  `3c6275a4bc6db55c43af1ce77e1aed60c820effcb6d9fac6e5a1cc33ecbf5f5c`.
  A redundant `kind: "native"` property before a spread carrying that same
  discriminant was removed for TS2783; final `string-search-value.ts` SHA256 is
  `7b7511b4f1e08a8725246adf869e618bbb659943f4799e2e251fa6b6c3f6a49b`.
  The raw runtime results below predate that cleanup, not a rerun of this head.
  No IR, context-layout, or `registry/imports.ts` change was made.
- The implementation stages call operands once, performs limit coercion before
  separator conversion, uses exact ToUint32 reduction, and rejects native
  Symbols after ToPrimitive. A narrow host-assisted undefined-separator arm
  preserves that existing call shape without provisioning unrelated proxies.
- Frozen raw fixture SHA256:
  `49ab2f32f2a2fb3f5e04c7335008acb21576ed427f423593444793e9c0111353`;
  preserved Git blob `6a182414d4cdb4c5b1511e055740314d75734497` in the local
  repository. Node 24.19, pool 1/single fork: **31P/11F to 39P/3F**, eight
  failure-to-pass transitions and no lost passes, with identical 42 test names.
  The JSON/log receipts are under each worktree's `.tmp/4016/`, named
  `full42-{baseline,candidate}-ac76d8c6cd-node24-pool1-20260920`.
- **That is not a 42-valid-test conformance denominator.** The receiver-order
  fixture asserts a result from an object with no `.split` method. Root's
  type-erased Node execution instead throws TypeError after argument effects
  reach `1234`. None of the eight observed gains is this invalid row. Keep the
  raw receipts, but do not pin its invalid expected value as a compiler defect.
  Valid primitive direct and genuinely borrowed-call oracles produce
  `1234672` and `12345672`, respectively. Details are in
  `.tmp/4016/root-receiver-oracle-correction.md`.
- The other raw residuals are the host post-ToPrimitive Symbol case (baseline
  wrong result, candidate invalid Wasm from a stale undefined-global index)
  and a descriptor-before-split host TypeError. These failure signatures must
  not be described as unchanged. The 12 original split tests previously
  measured **8P/4F to 9P/3F** at `de232b80`; those are historical receipts,
  not a fresh full-suite measurement.

### Resume plan and boundaries

1. Preserve raw42, repair the invalid fixture, and Node-verify direct,
   borrowed, nullish, and abrupt-receiver expectations. Run the corrected,
   versioned fixture identically on baseline and candidate before publication.
2. Obtain shared-file ownership clearance before touching
   `src/codegen/registry/imports.ts::fixupModuleGlobalIndices`. A recorded
   trace shows a host global insertion shifts imports 0 to 1 while the cached
   undefined index remains 11 and points to `__symbol_counter:i32`.
   Do not work around this cache defect in the split caller or collide with
   the other machine's IR migration.
3. Keep the custom `@@split` originals and descriptor-boundary residuals
   explicit. Do not close the umbrella based on the bounded coercion gains.
4. Resolve the mandatory coercion-site gate before publication: the new
   `string-split-coercion.ts` adds two `__to_primitive` and three
   `__unbox_number` references. Route through the shared coercion engine or
   obtain a substantive, reviewed migration decision; do not grant an
   allowance solely to turn the gate green. The attempted normal pre-push
   stopped here after typecheck, lint, formatting, and oracle checks; later
   gates are not claimed. Its durable log is
   `.tmp/4016/draft-checkpoint-push-1fb196048b-20260920.log`.
5. After a fresh upstream sync, rerun corrected comparisons and normal
   repository gates, then publish against `loopdive/js2`. No code PR was
   opened for this unfinished implementation during wrap-up. No check was
   disabled and no expected result was weakened to force publication.

All compiler/test processes were terminal at wrap-up. Resume only on request;
preserve the worktrees, raw receipts, and unfinished code.

## Problem

In `--target standalone`, six `String.prototype` methods share one refusal:

```
Codegen error: String.prototype.<m>(...) with a RegExp or symbol-protocol search
value is not supported in --target standalone (#1474).
```

It fires from `src/codegen/string-ops.ts` for `match` / `matchAll` / `search`
unconditionally, and for `replace` / `replaceAll` / `split` whenever the first
argument is not *statically* a string.

**The refusal conflates two different things.** Every one of these methods
begins the same way (§22.1.3.11/.12/.13/.14/.19/.23, step 2 in each): *if the
search value is neither `undefined` nor `null`, `GetMethod(searchValue,
@@<protocol>)`, and if that is not `undefined`, call it.* Only when that lookup
comes back `undefined` does the method fall through to its own **string** path:

| method | fall-through when there is no `@@` method |
| --- | --- |
| `split` / `replace` / `replaceAll` | `ToString(searchValue)` — a plain string operation, **no regex at all** |
| `search` / `match` | `RegExpCreate(ToString(searchValue), undefined)` |
| `matchAll` | `RegExpCreate(ToString(searchValue), "g")` |

So "the argument is not a statically-known backend RegExp" is *not* the same
question as "this needs a JS host". `"a1b".split(123)` needs no regex engine and
no host; `"abc".search("b")` needs a regex built from a runtime string — and the
standalone backend has had a **runtime pattern compiler** since #2161
(`ensureDynamicStandaloneRegExpCompiler`, the same one `new RegExp(dynamicSrc)`
goes through). Verified before writing any code: a standalone probe doing
`new RegExp("A" + "B").exec("ssABB")` returns `["AB"]` at index 2.

### Measured population — stamp every number with this

| | |
| --- | --- |
| Baseline | `test262-standalone-current.jsonl`, `--force`-refetched |
| `oracle_version` / lane | 12 / `honest` |
| Row timestamps | `1.8.2026, 22:26:58` → `22:32:46` |
| Rows / bad JSON / duplicate `file` keys | 48,619 / 0 / 0 |
| Official scope | **43,505 run / 25,929 pass (59.6 %)** |
| Goal scope (`es5id` present, or none of `es5id`/`es6id`/`esid`) | **8,545 run / 6,242 pass (73.0 %) / 2,303 non-pass** |
| Corpus files that failed to open | **401** — all newer-proposal areas (Iterator helpers 140, `AsyncDisposableStack` 52, `Promise.allKeyed` 39, …). The baseline's test262 checkout is NEWER than `/workspace/test262`. **0 of them are in this population**, and none carry `es5id`, so goal scope is unaffected (it reproduces the census's 8,545 exactly). |

Population = official rows, non-pass, whose `error` matches the refusal string:

- **99 files** all-official — `search 25 · match 20 · split 19 · replace 17 · matchAll 11 · replaceAll 7`
- **43 files** in goal scope
- Negative control: the refusal is absent from 17,477 of the 17,576 official
  non-pass rows, so the detector is not vacuous.

### What this REFUTES about the framing it was dispatched under

1. **The "51 files in goal scope" figure does not reproduce.** Cutting goal
   scope by the refusal string directly on a 5.5 h fresher baseline gives
   **43**. The "~98 all-official" figure does reproduce (**99** now).
2. **The overlap with the census's RegExp buckets is ≤ 2 files, not unknown-and-large.**
   Only 2 of the 99 live under `built-ins/RegExp/` (both
   `named-groups/groups-object-subclass*`) and 1 under `built-ins/JSON/`; the
   other 96 are under `String/prototype`. The census's *RegExp unsupported
   pattern/arity* bucket (21) is Tier-1, keyed on a **different** refusal
   string, so it is disjoint by construction — a row carries exactly one error.
   *RegExp engine semantics* (68) is Tier-2 and the census is an ordered
   first-match-wins partition, so no file can be in both. **Nothing here should
   be discounted for double-counting beyond those 2.**
3. **This is not one cluster, it is two mechanisms with very different costs**,
   and the goal-scope half is almost entirely the *cheap* one. Of the 99, the
   ~40 `cstm-*` / `custom-*-emulates-undefined` files are genuine
   `GetMethod(@@protocol)` **dispatch on a user object** — and **not one of them
   is in goal scope** (they are all `esid`-tagged ES6+ tests). Every one of the
   43 goal-scope files is the plain-`ToString` arm.
4. **`replace`/`replaceAll` is NOT reachable by removing this refusal**, even
   though it contributes 24 files to the population. Measured on a standalone
   probe: `"gnulluna".replace("null", function(a1,a2,a3){return a2+"";})` —
   which uses the *already-supported* string search value — fails today with
   `RuntimeError: illegal cast`. **Function replacers are a separate,
   pre-existing defect.** 7 of the 8 goal-scope `replace` files pass a function
   replacer (two of them via `Function("…")`, i.e. also blocked on #2928), so
   widening the gate here would convert a loud compile-time refusal into a
   runtime illegal cast. `replace`/`replaceAll` therefore keep the refusal.

## Fix

Split the one conflated question into the two the spec actually asks.

### 1. `TypeOracle.wellKnownSymbolMemberOf` (`src/checker/oracle.ts`)

The gate needs "can this value carry `@@split`?", which no existing oracle fact
expresses (`factOfType` returns a bare `{kind:"object"}` with no shape). Rather
than reach for the raw checker in `src/codegen/**` — which is exactly what the
#1930/#3273 ratchet exists to stop — the question is added to the oracle, where
it belongs. It is **tri-state on purpose**:

- `true` — present (`RegExp` carries all five);
- `false` — **provably** absent (every constituent resolved, none declared it);
- `undefined` — unknowable (`any`/`unknown`, or a union with such a part).

Only a provable `false` licenses the ToString path. TypeScript models
`[Symbol.split]` as a late-bound property with escaped name `__@split@<declId>`
(bare `__@split` in some ambient shapes); both spellings are matched. No checker
object escapes, so this respects the oracle's no-leak contract. **The change-set
adds zero `getTypeAtLocation`/`ctx.checker` sites under `src/codegen/**`, so no
`oracle-ratchet-allow` is claimed.**

### 2. `isPlainToStringSearchValue` (`src/codegen/regexp-standalone.ts`)

The shared admissibility predicate. Deliberately conservative in three places,
each of which is a correctness requirement rather than caution:

- **`undefined`/`void` is excluded**, and routed by a separate predicate
  `isDefinitelyUndefinedExpr`. Every method special-cases an undefined search
  value *differently*: `split(undefined)` returns `[S]` **without splitting**,
  while `search(undefined)` builds the **empty** pattern. Folding them together
  would be a silent wrong answer. `isDefinitelyUndefinedExpr` also widens the
  pre-existing purely-syntactic test to any expression whose type is exactly
  `undefined`/`void` — test262 writes an undefined separator as
  `function(){}()` (S15.5.4.14_A1_T9), which the syntactic test misses.
- **`symbol` stays refused** — §7.1.17 `ToString(symbol)` throws, and this lane
  cannot raise it (same carve-out as #3724).
- **`any`/`unknown` stay refused.** The single exception is a *syntactic* `null`
  literal, which is `any` under `strictNullChecks: false` yet is unambiguously
  the null value, and `null` skips the protocol lookup by inspection.

### 3. `search` / `match` — `RegExpCreate(ToString(arg), "")` at runtime

`emitCoercedRegExpToLocal` builds the regex through the existing runtime pattern
compiler and parks it in a local. `emitRegexSearchCall` /
`emitRegexExecArrayCall` gain a `regexpOverride` option, symmetric with the
`inputOverride` that was already there, so the shared emitters are reused
untouched rather than duplicated.

The override exists **for evaluation order**, not just for plumbing. The spec
runs `ToString(this)` (step 3) *before* `RegExpCreate` (step 4) evaluates the
search value's `toString`, and both can be observable. The shared emitter loads
the regex first, so both operands are materialised into locals by the caller,
at the caller's chosen point, and the emitter only ever sees `local.get`s.

A coerced regex is non-global by construction, so `match` always takes the
`.exec`-shaped arm; static group/`d`-flag recovery is skipped outright rather
than being trusted to decline on a search-value expression that is not a regex
source at all.

### 4. `split` — `ToString(separator)` into the existing native helper

The new arm mirrors the string-like arm operand-for-operand (receiver →
separator → limit) so **argument** evaluation stays left-to-right as at any call
site; the only difference is `emitArgAsNativeString` (the #2598 ToString engine)
in place of the raw `compileExpression`, which would feed a mistyped ref to a
helper expecting `ref $AnyString`.

*Not* changed: the spec coerces `ToUint32(limit)` (step 4) before
`ToString(separator)` (step 5), which is the reverse of the operand order here.
Reordering the two coercions would require holding an un-coerced arbitrary value
across the limit coercion; more importantly it would invert **argument**
evaluation for `s.split(f(), g())`, trading a non-observable deviation for an
observable one. The existing string-separator arm already ships this order, so
this arm introduces no new deviation. No file in the population distinguishes
the two orders (the `-throws` variants throw under either).

The undefined-separator arm now also **evaluates and discards** a non-syntactic
separator expression. It matched only side-effect-free syntactic forms before;
with the type-level widening it can match `f()`, and folding the value away must
not delete the call.

### Where the code lives, and the LOC ratchet

Both files this touches — `regexp-standalone.ts` (4,261) and `string-ops.ts`
(3,795) — are god-files already at their #3102 cap, and the gate's instruction
is *"add code to the subsystem module, not the barrel/driver"*. The first
version ignored that and grew them **+255 / +55**.

The §22.1.3 search-value dispatch is a genuine subsystem, so it now lives in
**`src/codegen/string-search-value.ts`**: the admissibility predicates, the
`RegExpCreate(ToString(v))` lowering, and the coerced `search` / `match` /
`split` entry points. The split is meaningful, not cosmetic — *this* module owns
the **decision** (is the spec's plain-ToString path the whole of the semantics
here?), `regexp-standalone.ts` keeps the **engine plumbing** it calls into.

A **third** gate then caught what the first extraction still left behind: the
per-function ceiling (#3400 / R-FUNC) failed on
`string-ops.ts::compileNativeStringMethodCall` (+18 on a 1,135-line function).
The honest reading is that only *my* arm had moved while the decision it belongs
to was still split across the god-function. So the **whole** §22.1.3.23 step-2
separator decision moved — the pre-existing undefined-separator arm (#2161 B2)
along with the new ToString one — behind a single
`tryCompileStandaloneSplitSeparator` entry point that declines for a string-like
separator so the byte-identical existing arm still handles it.

Final state:

| file | cap | before | after | |
| --- | ---: | ---: | ---: | --- |
| `src/codegen/regexp-standalone.ts` | 4,261 | 4,516 (+255) | **4,280 (+19)** | allowance |
| `src/codegen/string-ops.ts` | 3,795 | 3,850 (+55) | **3,755 (−40)** | **below cap — no allowance** |
| `src/codegen/string-search-value.ts` | — | — | 391 | new |
| `compileNativeStringMethodCall` | 1,135 | 1,153 (+18) | **under** | — |

`string-ops.ts` ends up **smaller than before this change**, and the per-function
gate passes without an allowance. The one remaining `loc-budget-allow` covers the
seam in `regexp-standalone.ts` and nothing else: one import line, four `export`
keywords on primitives the subsystem calls (`stripStaticWrapper`,
`ensureDynamicStandaloneRegExpCompiler`, `emitRegexSearchCall`,
`emitRegexExecArrayCall`), the `regexpOverride` option field on the two shared
emitters, and a two-line delegation at each call site. It is not a licence for
the logic, which lives in the new module.

Worth recording as a process point: three independent budget gates
(LOC-regrowth, per-function ceiling, oracle ratchet) each rejected a different
shortcut here, and following all three produced a **better** decomposition than
the design I started with — the two split arms are now one decision in one place
instead of two arms 50 lines apart inside a god-function.

## Test Results

Instrument validated in both directions before the change, on the harness used
for every number below (`runTest262File(..., "standalone")` — **status only**;
its error category and line are not the CI path, and it does not apply the
#2961 host-import refusal):

- **Positive control** — 6 files the baseline records as standalone `pass` in
  `String/prototype`: **6 / 6 pass**.
- **Negative control / kill-switch-removed measurement** — the 43 goal-scope
  population files on unmodified `upstream/main`: **0 / 43**, all 43 failing
  with exactly this refusal. This is the attribution proof: the "before" arm is
  the same harness, same corpus, same files, with the change absent.
- **Regression guard** — the 166 files the baseline records as standalone `pass`
  across the six touched directories (`String/prototype/{search,match,matchAll,`
  `split,replace,replaceAll}` and `annexB/.../String/prototype`): **166 / 166**,
  re-run after the subsystem extraction. The extraction moved ~280 lines, so it
  was re-measured rather than assumed.

Node was used as the oracle for every hand-written probe **before** it was run
against the compiler.

### Flips

| Set | before | after |
| --- | ---: | ---: |
| **Goal-scope population (43)** | 0 | **35** |
| — `search` (15) | 0 | **15** |
| — `match` (11) | 0 | **11** |
| — `split` (9) | 0 | **9** |
| — `replace` (8, deliberately out of scope) | 0 | 0 |
| **All-official population (99)** | 0 | **47** |
| **Guard set — 166 files the baseline records as standalone `pass` in the six touched directories** | 166 | **166** (0 regressed) |

**Every file in the three lanes this change addresses now passes: 35 / 35.** The
only goal-scope residuals are the 8 `replace` files that are deliberately out of
scope.

**File counts are not flip ceilings**, and the project's measured reference point
is 103 reachable → 34 flipped (33 %). This one is far higher because the
population was cut by a **Tier-1 refusal string**: every member is *conclusively*
gated on this one mechanism, so the usual "gated ≠ reachable" discount does not
apply. That is a property of how the population was selected, not a claim that
levers generally behave this way.

#### A refuted intermediate claim, kept as a warning

An earlier revision of this file reported **31 / 43** and explained the 4
residuals as "an argument whose static type is `any` — the conservative boundary
of `wellKnownSymbolMemberOf`". **That explanation was wrong**, and it was wrong
in the most seductive way: it was a *plausible* story that matched the intended
design, so it read as a finding rather than as a symptom.

The real cause was a **silently no-op edit**. A scripted `str.replace()` meant to
switch the `search`/`match` gates from `isStaticallyUndefinedExpr` to
`isDefinitelyUndefinedExpr` did not match (whitespace), printed `ok`, and changed
nothing — so those two gates kept the narrower syntactic predicate while the
`split` gate got the wider one. The 4 residuals were exactly the type-level
`undefined` cases (`var x;` and `function(){}()`), which the wider predicate
handles. They flipped the moment the intended edit actually landed, during the
LOC extraction.

Two things to carry forward: a scripted source edit must **assert its match
count** (the later extraction script did, which is how this surfaced), and a
residual that has a tidy explanation still needs the explanation *checked*
against the failing file rather than inferred from the design.

## Deliberately out of scope

- **`replace` / `replaceAll` string-coercion** — blocked on function replacers
  (see refutation 4 above), a separate pre-existing defect. Follow-up.
- **`matchAll` string-coercion** — needs `RegExpCreate(x, "g")` plus the
  iterator result shape, and §22.1.3.14 makes a non-global regexp argument a
  runtime `TypeError`, which this lane has no path for yet.
- **The `cstm-*` symbol-protocol arm (~40 files, 0 in goal scope)** — genuine
  `GetMethod` dispatch on an arbitrary object. Different mechanism, different
  cost; it is the reason this issue's title says *search-value*, not *RegExp*.

## 2026-10-04 Astra: two retained split residuals, source-only diagnostic plan

### Status, provenance, and limits

This appendix is a proposal, not implementation clearance or semantic acceptance.
Planning branch `codex/4016-split-residual-plan` starts at explicit
`fdb116928b5861fd628abfde95da5e3deb91f689`, in its own worktree. The preceding
390 lines are preserved. The actual issue filename is this file, not the
suggested `4016-dedicated-regexp-symbol-dispatch-widening.md`.

Read-only source/evidence donor:
`/Users/thomas/.codex/worktrees/pr-6206-shepherd/js2`, HEAD
`92afa58c6e831cbb8dd184c70100593581865307`, with its existing merged-main and
structural-refactor working changes. HEAD alone does not identify that source.
The retained refactor terminal records production fingerprint
`67125c379cca08da1c1dd7a37963ec7fb4b3c0d1867a034c481a6a99779ad6ad` unchanged
before/after execution. `.tmp/6206-refactor.json` SHA256 is
`ea972e12223a4da94ece638586c979c554ce3b19f48af34c609e243c6cef27fc`.
The actual canonical Node 24.19 run completed 73 PASS / 4 FAIL; terminal exit
1, signal null. This is retained evidence, not an execution by this planner.
Root's matched baseline is 64 PASS / 13 FAIL with all 64 passes retained.
The accepted dependency refactor preserves 73/4; it did not repair these two
semantic residuals. Neither diagnostic is an original Test262 gain.

Frozen 77 manifest `.tmp/6206-fixed-manifest.json` SHA256:
`1b87e586a3f25a5d1ba44ca82beca20493d3a1621460e1199d287593caf9b652`.
The unchanged 47-case fixture is
`tests/issue-4016-standalone-search-value-tostring.test.ts`, SHA256
`92bd8d30a494c17e6d1e04c07c0498a51a61311a619303a48c1f5f2c7fc46efc`.
Two of its four failures (assertions at lines 179 and 190) demand obsolete
compile refusals and already fail main. Preserve them and their expectations;
this task neither removes them nor calls a 75/2 result green publication.

No compiler/provider build, compile, runtime execution, fixture edit, claim
mutation, source edit, dependency change, or publication occurred in this task.
The native P1 worker owns the heavy lease. No GitHub polling was performed.

### D: direct ordinary-object receiver, expected 1234, actual 1

The exact fixture at lines 211–235 returns an ordinary object from a nested
function declared `receiver(): string` using `as unknown as string`. The
object has `@@toPrimitive`, but no `.split`. The four operand functions append
digits 1, 2, 3, 4; the receiver conversion would append 5, limit conversion 6,
separator conversion 7. Its catch returns `order` only for TypeError. Actual 1
therefore proves a TypeError was caught after the first recorded effect, not
that ordinary method lookup or any particular conversion caused that throw.

The contract is ordinary call evaluation, not borrowed String split:
evaluate receiver once; Get its current `split` once; evaluate all arguments
left-to-right; reject a missing/noncallable method only then. Genuine nullish
member bases and throwing property getters fail before argument evaluation.
An argument throw wins over the later noncallability error. Do not turn this
into `String.prototype.split.call(receiver, ...)` or ToString(receiver).
This ordering follows [ES2015 EvaluateCall/EvaluateDirectCall](https://262.ecma-international.org/6.0/#sec-evaluatecall)
and [argument evaluation](https://262.ecma-international.org/6.0/#sec-argument-lists-runtime-semantics-argumentlistevaluation).

Source-supported first-loss hypothesis D1 (not yet WAT-confirmed):

- `statements/nested-declarations.ts` lines 1508–1545 chooses the physical
  nested-function return type from its signature through `resolveWasmType`.
- `expressions.ts` lines 1535–1555 erases assertions but passes the expected
  type through. Type erasure here does not prove value preservation across ABI.
- `statements/control-flow.ts::compileReturnStatement` lines 551–554 supplies
  `fctx.returnType`; `normalizeReturnExpression` lines 174–195 applies
  `coerceType` when the natural value differs from that physical result.
- `type-coercion.ts::coerceType` lines 2677–2745 and 2798–2818 contain the
  differing-struct guarded casts, including nullable destinations that can
  answer null instead of preserving the ordinary-object reference. These
  source arms are candidates, not proof of the exact selected arm here.
- `expressions/call-receiver-method.ts` lines 3350–3436 admits the statically
  string-typed receiver into `compileNativeStringMethodCall`; its raw receiver
  callback is defined at `string-ops.ts` lines 2755–2756. The protocol probe in
  `string-symbol-protocol.ts` lines 198–236 declines non-re-evaluable call
  receivers/search expressions, as these operands are.
- `string-search-value.ts::tryCompileStandaloneSplitSeparator` stages the
  receiver at 594–595, then emits RequireObjectCoercible at 596–601, before
  argument staging at 604–615. `string-proto-split.ts` lines 294–304 emits that
  nullish guard. If the producer already replaced the object with null, this
  consumer correctly rejects the wrong value early. Moving its guard after
  arguments would hide the producer loss and break real-nullish calls.

D2 is distinct: if WAT proves the object survives to the call boundary, the
statically selected intrinsic lane does not itself Get `receiver.split`.
It can therefore bypass ordinary Get/callee semantics. A runtime string brand
alone is not permission to coerce a non-string receiver, synthesize a missing
method, or return the guarded string dispatcher's benign sentinel. D1 and D2
can coexist; repairing only the first does not establish the complete call.

Conditional implementation contract, after first-loss proof and clearance:

1. If D1 is confirmed, preserve the real object through the function's physical
   result ABI, then make reservation, body, direct caller, and closure caller
   agree on that carrier. Identify the declaration-owned return fact and its
   existing reservation consumers before proposing exact edits. Merely changing
   `normalizeReturnExpression` cannot return externref into a string-ref
   signature. No generic string coercion/global ABI widening is authorized.
2. At the actual direct-call admission seam, a value not proven to be the
   current intrinsic must use current ordinary Get with the saved receiver.
   Save its returned callee before argument effects, stage all raw arguments
   once, then check/call that saved value with the original receiver as `this`.
   A getter that changes the property during arguments must not be re-read.
   User methods keep arbitrary return values, not forced string-vector results.
3. Keep the native intrinsic branch only on a valid intrinsic/receiver contract;
   preserve existing limit-before-separator conversion and surplus effects.
   Do not widen `compileGuardedNativeStringMethodCall` across all string methods
   as a split workaround. If the existing ordinary route cannot honor Get before
   args, stop and name that additional consumer; do not silently adopt it.

### H: host Symbol callback, expected 1, actual normal 0

The exact fixture at lines 417–440 calls native-strings host split with
`void Date.now()` separator and a concrete object whose
`[Symbol.toPrimitive](hint: string)` increments captured `calls`, checks the
numeric hint, and returns a captured undescribed Symbol. Its try returns 0
after split; its catch returns 1 for exactly one correctly hinted callback,
otherwise 2. Thus observed 0 means the split call returned normally. It does
NOT expose callback count/hint and cannot prove zero callbacks.
The bare Symbol fixture at lines 405–415 throws a host-visible TypeError and
passes; Symbol construction itself also has a passing independent control.

Concrete source path and competing, falsifiable hypotheses:

- `string-search-value.ts` lines 588–622 prepares helpers before effects,
  stages receiver/separator/limit, and recaptures live providers afterwards.
  Lines 632–640 use `emitHostStagedSplitLimitFromExternref` for the proven
  undefined separator. No limit AST replay is needed or acceptable.
- `helpers/string-split-coercion.ts::emitHostStagedSplitLimitFromExternref`
  tests exact undefined, otherwise emits ToPrimitive(number), ToNumber, exact
  ToUint32. `coercion-engine.ts` lines 128–169 registers the real host hint
  global and resolves `__to_primitive`/`__unbox_number` from current handles.
  Preserve these late-import/index invariants; no evidence currently implicates
  the accepted callback-injection architecture or exact ToUint32 algorithm.
- `runtime.ts` lines 13906–13912 delegates the host import to
  `_hostToPrimitive`; that walker (4203 onward) checks real property, sidecar,
  then Wasm method export `__call_@@toPrimitive`, then struct closure-field and
  ordinary valueOf/toString fallbacks. The real reached representation matters.
- H1: `index.ts::emitToPrimitiveMethodExport` lines 9156–9162 explicitly skips
  any entry whose declared hint parameter is not externref. A native-string
  `hint: string` can therefore be omitted. If another entry creates the export,
  the dispatch miss returns `ref.null.extern` (9188), which `_hostToPrimitive`
  accepts as primitive (4313–4316), and ToNumber turns into zero. If the export
  is absent, the walker instead continues through its remaining probes. Which
  case occurs here requires the actual module's exports and dispatch ladder.
- H2: if the method is reached, the export's lines 9204–9215 box every i32
  result through `__box_number`, ignoring Symbol/boolean metadata. A symbol ID
  returned as a number is accepted by host ToNumber and causes normal return.
  Inspect the actual method/result type and callback wrapper before claiming
  this is reached. `symbol-field-carrier.ts::symbolBoundaryCoercionInstrs`
  lines 70–77 already expresses branded i32 -> host Symbol through
  `__box_symbol`; that is a reusable contract, not authority to edit the module.
- H3: a missing method/field producer or wrong captured environment could make
  neither intended callback route available. Inspect the concrete closure field,
  registration key, callable body, and capture parameters. Do not invent a
  sidecar or substitute an unrelated same-shape/name method to obtain a pass.
- H4: inspect the emitted exact-undefined branch and live import indices. If
  an object is classified as undefined or the provider index is wrong, H1/H2
  are not first loss. The passing late-import control does not exclude a
  case-specific shift. Record evidence, do not reintroduce cached raw indices.

`runtime/host-async-imports.ts::createHostNumberUnboxImport` lines 77–112
ultimately applies host Number to the primitive; a genuine Symbol throws.
This narrows the question to the value reaching it, not a demand for another
split-specific Symbol-shaped rejection. Do not trust its adjacent broad BigInt
comment as a new task or change that separate contract.

Conditional implementation contract: repair the proven ToPrimitive producer /
export boundary, not the split limit algorithm. A real native-string hint needs
an existing host-string-to-native conversion before calling the typed method;
do not feed host externref directly to a native-ref parameter or drop the hint.
Preserve concrete receiver/capture identity and per-instance callable state.
Normalize the actual return with semantic Symbol/boolean metadata, not plain
i32 numeric boxing; carry native/host strings, null, undefined, objects, and
abrupt completions honestly. Reserve all converters/boxers before capturing
function indices, then resolve current handles. An absent method must remain
distinct from a present method returning null. Do not globally change exported
dispatcher miss semantics without auditing all its readers. Exact source scope
must be chosen from the four-module evidence below, not all hypotheses at once.

### Ownership intersections: positive evidence, not source clearance

The root retains the delegated `4016:pr-6206-shepherd` production leaf; this
planner owns only this append. A local assignment-tree read at
`b08e3f94fb3715634d074383f5a3f2aaae739c59` is a dated snapshot, not a fresh
server predispatch check. It records 3481 (opus-3481, write10507-bejvnko7),
4406 (opus-4406, write10455-jvv8gdrd), 5374 (dev-5374,
write3356-6whu869a), 4637 (claude-es5-standalone, write21722-b4gyvn3s),
6651 (project-thread-yhj9pp, write11530-bzpj3qae), and 6775 (opus-6775,
write1573-liurq9bq) still in progress. Historical done MD5374 does not release
its held record. Bare4016 done and 1917 released do not grant broad successors.
Held `3518:export-marshalling` and `3518:native-string-value-abi-planning`
are additional ABI adjacency, not assignments this planner can borrow.

MD3481 positively reserves Symbol coercion, index wiring, type-coercion, and
host ToPrimitive work; MD4406 specifically owns return normalization / boxed
ABI consumers. MD5374 concerns module ownership in the actual host walker.
Any proposed change in those exact protocols needs owner adjudication even
when unrelated IR implementation on another machine is explicitly cleared.

Retained fully paginated 16-PR path inventory in the R2-A donor
`.tmp/6835-r2-a/open-pr-inventory.json` identifies these positive overlaps:
6468: index, nested-declarations, expressions, control-flow, type-coercion,
call-receiver-method, string-ops; 6341: index/expressions; 5784:
index/expressions/nested-declarations; 5753: those plus type-coercion,
call-receiver-method, symbol-field-carrier; 5748: index/coercion-engine/runtime;
5911: runtime. PR6206 itself owns the split/coercion integration paths.
These path intersections are not exact-function conflicts or absence proofs.
The inventory retains no selected patch for the newly implicated exact bodies.
Root confirmed no fully reviewed local hunk receipt and instructed that they
remain HELD/unadjudicated. No further GH poll or claim mutation is needed for
this documentation; before implementation, inspect exact current patches and
ask for a named function-level carve-out. No source GO is implied here.

### Finite next diagnostic: four original source strings, no adaptive expansion

After separate root approval and the heavy lease becomes available, collect
exactly these four unchanged strings from the frozen fixture using TypeScript
template-literal text, retaining whitespace/comments/annotations. SHA256s below
were computed read-only from its cooked `src` literal, not a rewritten probe:

1. D-object, fixture line211, target standalone, export f, expected 1234:
   `722768e1c25652ff613f821b48db40ded30101226b0d673525d5563b525cf66b`.
2. D-primitive, line238, target standalone, export f, expected 1234672:
   `b3631deb609d48c4f5d26e13ed456a76d8e1d343e9c8bfd368264c3060b1967f`.
3. H-callback, line417, nativeStrings true with normal host runtime, export f,
   expected 1:
   `9341bb96f2a63aac005af0b3082ff697a82859e8e827f96d86e124877c7615d4`.
4. H-bare, line405, same host lane, export f, expected escaping host TypeError:
   `6131e3b910481a9c44019b396b3ba8d02199ab6668693e7f0fdb6467f12fe0e0`.

Do not add `: any` to receiver/limit, remove the `hint: string` annotation,
change assertion boundaries, inject counters, add exports, monkeypatch host
imports, or replace method shorthand with a field closure. Those alter the
producer/carrier path. Compile-only/WAT observation and existing export lists
are enough for this first bounded attribution step; no provider rebuild.

Each artifact receipt must bind exact source hash, complete source fingerprint,
compiler options, canonical Node24 executable/version, binary/WAT hashes,
actual import/export list, compile/validate/instantiate/export-call result,
thrown category, terminal exit/signal, and pre/post production identity.
Standalone imports must stay empty. Host instantiation must reproduce the
fixture's buildImports + instantiateWasm + setInstance lifecycle unchanged.
Do not report collector exit0 as four test passes. If donor bytes differ from
the retained refactor fingerprint, stop and obtain a matched checkpoint first.

For D, map receiver declaration's actual result signature and complete return
tail; identify any object-to-null conversion before the call. Then map f's
receiver call, current method Get (or its absence), guard, all three argument
calls, callable check, and catch. Pair every claim with exact WAT indices and
source emitters. Compare D-primitive's same boundaries. If D-object reaches a
different source arm than hypothesized, report that first loss and stop.

For H, list whether `__call_@@toPrimitive`, `__sget_@@toPrimitive`, and relevant
closure dispatch exports exist; decode the exact limit shape/capture closure,
hint parameter and result carrier; inspect matching and miss arms. Resolve the
actual host hint global and imported helper indices after Date.now staging.
Follow the returned primitive into ToNumber, comparing H-bare's Symbol boxing
path. A normal0 only proves no caught abrupt completion. Static reachability
does not establish callback execution/count: if these four unmodified modules
cannot distinguish hypotheses, report that precise remaining observation need
to root; do not invent a fifth source or a production patch while collecting.

### Acceptance and stop boundary for a later, separately cleared repair

Root must read this complete append and the four-source receipts before any
implementation dispatch. The diagnostic run stops after its four fixed cases,
even if inconclusive. An implementation proposal must identify its proven
first-loss hunk, every physical ABI reader it changes, owner carve-out, and
normal static-gate cost before source GO. Neither ABI rewrite is preapproved.

Preserve all 73 current passes and the complete frozen 77 identities/expectations
in a matched rerun after any authorized repair. Require D-object1234,
D-primitive1234672, H-callback1, H-bare TypeError; keep the two stale refusal
reds visible and separately adjudicated, not weakened. No original gains are
claimed without unchanged original Test262 measurements.

Before production semantic acceptance, root must approve a separate supplemental
manifest covering null/undefined base before arguments, throwing getter before
arguments, absent/noncallable method after arguments, argument abrupt precedence,
getter once with mutation during arguments, own/inherited callable and arbitrary
return identity; and host hint exactness, Symbol/boolean/number/null/undefined /
object results, callback abruptness, same-shape distinct captures, and ordinary
valueOf fallback. Those are contracts, not newly executed tests in this task.
Keep standalone/host boundary controls, late registration, and closure identity.
No gate exemption, oracle edit, refusal removal, generic coercion workaround,
runtime miss-status rewrite, or expanded source ownership is authorized.

## 2026-10-04 one-shot owned-PR shepherd audit (20:42 UTC)

Root requested a read-only publication handoff for six owned open PRs. This
appendix records their server snapshot, not a watch, merge authorization or
semantic-completion claim. No PR, review, check, claim or source was mutated;
no fetch, merge, build or runtime execution occurred. The separate P2 Script
plan remains frozen. Preserve this MD's preceding 676 lines (SHA256
`1bc2c65b27726c94322010ad678bca1c603266792224d0152d22ec0dd117af88`).

### Provenance and current integration base

The initial sandbox API read failed to connect and supplied no state. A single
network-enabled GraphQL snapshot then read all six PR heads/bases, merge state,
draft/hold state and review threads. Every review connection reported
`totalCount=0`, `hasNextPage=false`: zero unresolved inline review threads for
each PR, not an approval or proof of no issue-level discussion. ReviewDecision
was null for all six. Each required-check list was read once with
`gh pr checks --required`; completed failing job details and logs were read,
with truncated log tails retrieved as content, not repeated status polling.

Actual server `refs/heads/main` at this snapshot:
`1787b1af4a2f010f51ca1f45fc68fa540bfa4673`.
Server compare from validated `fdb116928b5861fd628abfde95da5e3deb91f689`
reported ahead2/behind0, merge-base=fdb, two commits: npm-compat refresh
`6ad7760e71342f4270f899f564cd962b4d06f0a9` and PR6474 merge1787b1af.
Exactly six files changed: `npm-compat-history.json`, `npm-compat-perf.json`,
`npm-compat.json` under both `benchmarks/results/` and its website/public mirror.
No compiler, provider, test or workflow source delta in that comparison.
The distinct PR `baseRefOid` values below are returned PR metadata, NOT current
main; none was silently substituted for the server tip. Publication still
requires current integration and normal gates under its actual owner.

### Required-check interpretation used for every PR

All six returned the required names `quality`, `equivalence-gate`, `cla-check`,
`cheap gate (main-ancestor + lint)`, `merge shard reports`, and
`check for test262 regressions`. Five PRs returned ten rows: six non-skipped
workflow jobs, three SKIPPED same-name PR-stub jobs, and a duplicate successful
legacy CLA status with no job URL. Skipped rows and duplicate CLA status were
not counted as additional verification. PR6435 instead has seven rows: six
SUCCESS workflow jobs plus legacy CLA; three of those jobs ARE the PR-stub
workflow, so non-skipped still does not mean actual conformance execution.

For5883/6206/6234/6246/6436 the actual Test262 Sharded cheap/report/regression
jobs all returned SUCCESS; equivalence and CLA jobs also SUCCESS. Their PR-level
report/regression success is not a measured merge-group Test262 sweep. Quality
is SUCCESS only on5883 and6435 and FAILURE on the other four. No returned
required context is pending. Failed quality steps leave downstream steps
SKIPPED, not implicitly passed. Exact failed-job head_sha matched each PR head.

### Per-PR actionable handoff

**[PR5883 — fix(promise): preserve observable intrinsic combinator protocol](https://github.com/loopdive/js2/pull/5883)**

- Head `6f73c8edd15a2fb88f3f7c34166ec5ce0337ae80`, branch
  `codex/5197-promise-observable-r3-2-20260913`; base metadata
  `2b8101b9bc9a1910ce32a26e5b74e8a503f5b471` (`main`). OPEN, not draft,
  `hold` present, CONFLICTING/DIRTY, zero review threads.
- Six actual required workflow jobs SUCCESS. [Quality job](https://github.com/loopdive/js2/actions/runs/36997490120/job/110807440554)
  matches this head and its lint/format/typecheck, changed-root tests, required
  guards and conformance-number steps all succeeded. Cheap/report/regression
  jobs in run36997490192 are110807442225/110807478495/110807478544.
- Blockers are the explicit hold and merge conflict despite green historical
  head CI. Coordinate with the existing Promise owner before resolving/rebasing;
  no inference that author is finished and no permission to remove the hold.

**[PR6206 — fix(string): stage standalone split coercion before conversion](https://github.com/loopdive/js2/pull/6206)**

- Head `92afa58c6e831cbb8dd184c70100593581865307`, branch
  `codex/4016-resume-20260927`; base metadata
  `aca46e64cded68942686f67a52c38bb1d3c358ab`. OPEN draft,
  CONFLICTING/DIRTY, no hold, zero review threads.
- [Quality job](https://github.com/loopdive/js2/actions/runs/36367765816/job/108757496910)
  failed `Changed root test files must pass`: published fixture47 has42 PASS,
  5 FAIL. Two refusal pins expected false/received true; direct-object call
  expected1234/received1; host Symbol-returning conversion expected1/received0;
  descriptor-before-split threw `Cannot convert object to primitive value` at
  `_normalizeDescKey`. Required guard and later steps were skipped. Other five
  required jobs passed (cheap/report/regression run36367765431,
  jobs108757495884/108757515806/108757515864).
- The newer local merged/refactored candidate73P4F/77 is NOT this published CI
  result. Preserve its four reds and all73 positives; the preceding appendix's
  four-source diagnosis is still required. Existing split shepherd owns that
  integration; don't create a duplicate repair, weaken refusal tests, or mark
  ready just because the architecture-only refactor passed locally.

**[PR6234 — fix(codegen): normalize direct Map.get equality results](https://github.com/loopdive/js2/pull/6234)**

- Head `9bb4f293940e0029dff22ad1d224febde903d424`, branch
  `codex/3585-map-result-equality`; base metadata
  `3eb7ae5da3951641b97c1af2e9fc27a0c7c41435`. OPEN draft,
  MERGEABLE/BEHIND, no hold, zero review threads.
- [Quality job](https://github.com/loopdive/js2/actions/runs/36387719119/job/108816556863)
  failed changed-root tests:7 PASS/3 FAIL of10. Object/nullish controls returned
  2 vs3, mixed results687 vs1023, missing/undefined/null42 vs63. Required guard
  and later steps skipped. Other five required jobs passed;
  cheap/report/regression run36387719020 jobs108816557621/108816583986/108816583922.
- Continue the already assigned narrow Map observation repair and matched
  preservation gates, then integrate current main under the owner. Published
  three reds remain until new measured head; no credit for four unrelated
  frozen Map originals and no broad binary-ops/storage rewrite permission.

**[PR6246 — fix(eval): stage arguments before runtime snapshot](https://github.com/loopdive/js2/pull/6246)**

- Head `49e6fe14795de20020c2c68901cf184ef308a325`, branch
  `codex/5157-eval-spread-arguments`; base metadata
  `9187cce7452e3fec5845d09b118c98164e899dde`. OPEN draft,
  CONFLICTING/DIRTY, no hold, zero review threads.
- [Quality job](https://github.com/loopdive/js2/actions/runs/36974562907/job/110735479296)
  failed `CLAUDE.md names only paths and CLI flags that exist` at line676:
  `.claude/ci-status/pr-<N>.json` directory absent, plus missing
  `ci-status-feed.yml`, `ci-status-basic.yml`, `ci-status-pending.yml`.
  Four dangling references; changed-root tests and required guards were NOT
  reached. Other five required jobs passed; cheap/report/regression
  run36974562938 jobs110735480428/110735503880/110735503917.
- Existing shepherd must retain the approved M1 argument/cache/late-binding
  semantic merge and dependency-cycle repair. This remote failure is old docs,
  not proof current merged source passes tests or M2 direct-spread semantics.
  Resolve integration with current maintained docs, not a gate exemption or
  four historical annotations used to evade a still-active protocol fix.

**[PR6435 — fix(ci): execute native eval guards with a full provider](https://github.com/loopdive/js2/pull/6435)**

- Head `16120f29f62e5748f8d9fec795695fca302a4a8a`, branch
  `codex/es6-native-eval-ci`; base metadata
  `ff310447e51b6443c5a3c34c62bd80f38c64269e`. OPEN draft,
  MERGEABLE/CLEAN, no hold, zero review threads.
- [Quality job](https://github.com/loopdive/js2/actions/runs/37033068204/job/110924447677)
  matches head, SUCCESS including changed-root tests and required guards;
  equivalence110925681991 and CLA110924433538 SUCCESS. Cheap/report/regression
  are SUCCESS jobs110924566085/110924566422/110924566201 in
  run37033068390, explicitly **Test262 PR stub**. No real Test262 sweep is
  established by those three green contexts.
- Closest mechanical candidate, but still draft and not declared ready by this
  audit. Owner must confirm completion and full-provider evidence, then make
  the explicit ready/publication decision; workflow-touching queue permissions
  and current-main integration remain the shepherd's checks. Do not toggle draft.

**[PR6436 — feat(intl): add locale canonicalization kernel](https://github.com/loopdive/js2/pull/6436)**

- Head `77711ef957faa069f35acc55d6d3c0a2a64ecc02`, branch
  `codex/6809-intl-locale-canonicalization`; base metadata
  `7c8edb29224f7497bc2be8544dfabc166f4dd63d`. OPEN, not draft,
  MERGEABLE/BEHIND, no hold, zero review threads.
- [Quality job](https://github.com/loopdive/js2/actions/runs/37224664939/job/111501740327)
  failed `src/codegen flat-directory budget`:829→830 (+1). Import-cycle and
  preceding lint/type/format passed; every later architecture/test/guard step
  was skipped. Other five required jobs passed; cheap/report/regression
  run37224664953 jobs111501740965/111501765389/111501765545.
- Exact next repair is owner-approved file placement/import reconciliation,
  not changing the budget. The positive6809 owner claim remains held pending
  explicit clearance; this audit does not supply it. Later semantic gates still
  need execution on the repaired current head, not extrapolation from step15.

No PR in this six-item snapshot is certified ready for publication by this
audit. Root/assigned shepherd retains follow-up ownership; there is no watcher,
scheduled recheck, rerun, comment, review resolution or external write here.
