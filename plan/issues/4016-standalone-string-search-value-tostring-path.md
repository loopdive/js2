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
