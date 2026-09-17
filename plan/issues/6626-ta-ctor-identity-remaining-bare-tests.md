---
id: 6626
title: "standalone: the LAST batch of bare `ref.test $__ta_ctor` receiver tests — dataview-native.ts (5 sites), property-access-dispatch.ts (1 site), ta-ctor-meta.ts (2 call sites / shared isTaCtor helper)"
status: done
sprint: current
priority: high
horizon: s
feasibility: hard
reasoning_effort: high
goal: standalone-gap
parent: 5383
completed: 2026-09-17
assignee: ttraenkler/sendev-s39
loc-budget-allow:
  # 2026-09-17 (S39) — `dataview-native.ts` grows 5 lines: each of the 5
  # audited sites gains one doc-comment line pointing at
  # `emitTaCtorBytesPerElement`'s canonical comment plus swaps a 2-instruction
  # bare `ref.test` push for the `taCtorIdentityTestInstrs(...)` spread —
  # same established helper #6620/#6622/#6601 already use at every OTHER
  # `$__ta_ctor` receiver test in the backend, not a new mechanism.
  - src/codegen/dataview-native.ts
func-budget-allow:
  # 2026-09-17 (S39) — `fillTaCtorGetMetaArm` grows 8 lines: `isTaCtor()`'s doc
  # comment (explaining WHY the shared 5-splice-site receiver guard needed the
  # brand-checked identity test, matching the #6620/#6622 doc-comment
  # precedent) plus the inline `taCtorIdentityTestInstrs` swap at the function's
  # second bare-test call site. `tryConstructorPrototypeIdentity` grows 3 lines
  # for the same swap plus a one-line doc pointer. Neither function gained a
  # new code path — both already tested `$__ta_ctor` structurally; this makes
  # the existing test brand-checked.
  - src/codegen/ta-ctor-meta.ts::fillTaCtorGetMetaArm
  - src/codegen/property-access-dispatch.ts::tryConstructorPrototypeIdentity
---

# #6626 — the last audited batch of bare `ref.test $__ta_ctor` receiver tests

## Problem

#6620 (S33) and #6622 (S35) each found and fixed ONE bare `ref.test
$__ta_ctor` / `taCtorTypeIdx` receiver test that should have used the
brand-VALUE-checked `taCtorIdentityTestInstrs` (`registry/types.ts`, #5194 r3
F1 / #5383 S2f R11) instead — the collision being `$__ta_ctor`'s exact
`{kind: i32, brand: i32}` shape matching a field-less compiled class's root
(`{__tag: i32, __shape_brand: i32}`, `class-bodies.ts` #2158/#2009), for both
an INSTANCE and — per #3976 — a class-object VALUE. #6620's own file flagged
the remaining unaudited sites as `R-other-bare-ref-test`. This issue closes
that list.

## Audit — every site that structurally tests `$__ta_ctor` / `taCtorTypeIdx`

| File | Sites | Reachable wrong answer found? |
| --- | --- | --- |
| `dataview-native.ts` | 5 (`emitTaCtorBytesPerElement`, `emitDynamicTaViewConstruct`, `emitTaDynCtorConstructFromLocals` ×2 call sites, `ensureTaFromArrayLikeHelper`) | YES for `emitTaCtorBytesPerElement`; NOT REPRODUCED for the 3 dynamic-`new ctor(...)` construct sites (see below) |
| `property-access-dispatch.ts` | 1 (`tryConstructorPrototypeIdentity`'s `$262.createRealm().global` receiver arm) | NOT INDEPENDENTLY WITNESSED (needs the real `$262` test262 harness object) |
| `ta-ctor-meta.ts` | 2 call sites — one is the shared `isTaCtor()` helper reused at 5 splice points (`__builtinfn_get_meta` ×2, `__builtinfn_gopd` ×2, `__builtinfn_delete` ×1) | YES, multiply (`.prototype` read, `Object.getOwnPropertyDescriptor`, `hasOwnProperty`) |

All 8 sites now route through `taCtorIdentityTestInstrs`, which is
answer-preserving for a genuine `$__ta_ctor` value (both mint sites write the
brand) and can only ever REMOVE a false positive — matching the #6620/#6622
fix pattern exactly, no new mechanism introduced.

## S39 findings

**Reduction technique that worked, and why it differs from #6620/#6622's.**
#6620/#6622's collisions needed a LINKED cross-module provider (a field-less
class whose "class-object value" specifically gets the instance-sharing
`$Object`-struct representation per #3976). For `dataview-native.ts`'s
`emitTaCtorBytesPerElement` and every `ta-ctor-meta.ts` `isTaCtor()`-guarded
arm, the collision reproduces with a purely LOCAL, single-module field-less
class **INSTANCE** (`new PD()`, not the class value) cast through an `any`
parameter — no linking needed. This is a materially cheaper reduction and the
one used by every fix-witness in `tests/issue-6626-*.test.ts`. Measured with
`class C0{} class C1{} class C2{} class PD{ident(){return "pd";}}` (PD's
`__tag` = 3, inside `TA_CTOR_KINDS`' 0..10 range at index 3 = `Int16Array`,
byte width 2) plus `function mkTA(k){return new k(4);} var __internalTA =
mkTA(Uint8Array);` (required so `ctx.taCtorTypeIdx` is actually registered):

| Expression (on `x: any = new PD()`) | Base (file reverted) | Fixed |
| --- | --- | --- |
| `x.BYTES_PER_ELEMENT` (`dataview-native.ts` reverted) | `2` | `0` |
| `typeof x.prototype` (`ta-ctor-meta.ts` reverted) | `"object"` | `"undefined"` |
| `Object.getOwnPropertyDescriptor(x, "BYTES_PER_ELEMENT")` (`ta-ctor-meta.ts` reverted) | `{value:2,writable:true,enumerable:true,configurable:true}` | `null` |
| `Object.prototype.hasOwnProperty.call(x, "prototype")` (`ta-ctor-meta.ts` reverted) | `true` | `false` |

Each row measured by file-copy revert of the ONE named file (`git show
HEAD:<path> > .tmp/s39base/<path>.base`, `cp` in/out, `.tmp/s39/probe{1,2,5}.mts`),
current tree otherwise unchanged — never a whole-tree revert, so no other
already-fixed site (#6620's `ta-dyn-mop.ts`) confounds the reading.

**Clause of the hand-off that was wrong: the 3 remaining `dataview-native.ts`
dynamic-`new ctor(...)` construct sites (`emitDynamicTaViewConstruct`,
`emitTaDynCtorConstructFromLocals` ×2) did NOT reproduce a wrong answer within
this slice's budget**, despite being structurally identical bare `ref.test`
sites. Two reduction attempts, both giving the CORRECT answer on both the
reverted and fixed `dataview-native.ts`:

1. **Local field-less class as the dynamic ctor value** (`function dynNew(k){
   return new k(buf); } dynNew(PD)`, `buf` typed `ArrayBuffer`): declines to
   the correct `emitDynamicNewFallback` path (`new-super.ts`) — `PD` is a real
   LOCAL candidate there (`ctx.classObjectGlobals` includes it), which wins
   BEFORE the vulnerable TA-construct arm is even reached, regardless of the
   bare test's own correctness.
2. **Linked cross-module provider class as the dynamic ctor value** (same
   `dynNew` shape, `PD` from a `compileProject`-linked provider package,
   `.tmp/s39/probe4.mts`, mirroring #6620's own harness): also answered
   correctly on both trees. `emitDynamicNewFallback` should decline here (no
   local class candidates on the consumer side at all), yet the outcome was
   still correct both ways — the exact mechanism that resolves it correctly
   was not isolated within this slice's time budget (a #6620-style bisection,
   disabling arms one at a time, would be the next step but was not
   performed).

The fix is still applied at all 3 sites (defensive, answer-preserving,
zero-risk per the helper's own contract) and covered by CONTROL tests
(genuine dynamic TypedArray construct still works; the collision class still
constructs correctly through both reduction attempts) rather than fix-witness
tests. `property-access-dispatch.ts`'s `$262.createRealm().global` receiver
arm is fixed the same way but has no synthetic harness available outside the
real test262 `$262` object, so it is audit-only (code inspection matched the
site to the identical bare-`ref.test`-on-`ctx.taCtorTypeIdx` shape as every
other audited site) — also not independently witnessed.

## Corpus-wide footprint

The fixed arms are consulted by the standalone TypedArray-construct/metadata
surface generally, not by a narrow test family. The two CONFIRMED-buggy
mechanisms (`.BYTES_PER_ELEMENT`/`.prototype`/gopd/hasOwnProperty on an `any`
receiver that happens to collide) are collision-triggered — they require BOTH
a `$__ta_ctor` type registered in the module (any TA-constructor-as-value
usage) AND a field-less class/receiver landing on a colliding tag, which is
provider-composition-dependent rather than a fixed per-file test262 count (the
same characterization #6620/#6622 gave their own sites — "blocks the FULL
corpus wherever the module composition triggers it," not a fixed subset).

## Criterion 4 — four-family sample, must-not-move groups, corpus byte A/B

**Measured in the S39b slice** (branch `issue-5383-standalone-temporal-s39b`,
tip `21d3178748` = S39's own tip; base tree obtained by file-copy revert of
ONLY the 3 files S39 changed against S39's parent `ea2277af98`, restored after
each base run). Scripts: `.tmp/s39b/famrun3.mts` (copied from S38b's
`.tmp/s38/famrun3.mts`, `outDir` repointed), `.tmp/s39b/mnm3.mts` (same, plus a
new group D — see below), `.tmp/s39b/corpus.mts` (same, `WT` repointed to this
worktree). `--target standalone`, `@js-temporal/polyfill` 0.5.1 provider
linked (`hostBridge: "off"`), sequential, fresh `JS2WASM_TEMPORAL_CACHE` per
label (prewarmed via `scripts/prewarm-temporal-provider.mjs --target
standalone`, both prewarms measured `cacheHit=false`), 60s per family row / 30s
per must-not-move row, QuickJS eval provider present (rebuilt per label —
`scripts/build-quickjs-eval-provider.mjs`, content-addressed on the compiler
bundle hash, so the adapter key legitimately differs between base and fix; a
stale adapter for the wrong label surfaces loudly as a `quickjs provider is
not built` error, not a silent wrong answer — hit this once, rebuilt, verified
clean before trusting any row).

**Setup gap found and fixed before any row could run**: this worktree started
with no `test262/` submodule checkout, no `.test262-cache` QuickJS artifacts,
and no `scripts/compiler-bundle.mjs`. `git submodule update --init test262`
(shares the object store with the other worktrees via `.git/modules`, so this
was a local checkout, not a re-clone) and `npm run -s build:compiler-bundle`
resolved those. A second gap surfaced only once the family sample ran: the
standalone Temporal lane requires a `prewarm-<target>.json` stamp in the cache
dir (`test262TemporalLaneEnabled`) — a fresh `JS2WASM_TEMPORAL_CACHE` with no
stamp runs every Temporal-needing row UNLINKED (fail-soft to `ReferenceError:
Temporal is not defined`), which is silent and reads as "everything regressed"
if not caught. Running the prewarm script explicitly (not just setting the env
var) is required before any family/Temporal row.

### Four-family sample (120 files/family, alphabetical-walk first 120)

| Family | Base pass/120 | Branch pass/120 | pass→fail | fail→pass |
| --- | --- | --- | --- | --- |
| `PlainDate/**` | 112 | 112 | 0 | 0 |
| `Duration/**` | 105 | 105 | 0 | 0 |
| `ZonedDateTime/prototype/**` | 103 | 103 | 0 | 0 |
| `PlainDateTime/**` | 113 | 113 | 0 | 0 |
| **Total** | **433/480** | **433/480** | **0** | **0** |

Base reproduces S38b's own cited 112/105/113/103 exactly (`.tmp/s39b/fam/*-base.tsv`).
Per-file diff (`.tmp/s39b/diff_fam.py`) confirms **0 files moved either
direction** — not just an even aggregate, every one of the 480 rows answered
identically on both trees. This resolves the open question S39's own
write-up flagged (whether the real `@js-temporal/polyfill` classes land on a
colliding `$__ta_ctor` tag in these 4 families): they do not, in this sample.

### Must-not-move groups A/B/C (S38b's definitions, reused unchanged) + D (new, mandatory this slice)

Group D is new this slice — `TypedArray`/`TypedArrayConstructors`/`DataView`
built-ins, the families directly downstream of the 8 sites this issue fixes
(`dataview-native.ts` + `ta-ctor-meta.ts`), capped at the first 100 files per
subfamily (same convention group C already used for its own two 100-file
subfamilies, to keep the per-call wall-clock budget bounded — 1446 + 738 + 561
files exist in the full corpus, ~2745 total, well beyond one session's budget
at this granularity).

| Group | Files | Base pass | Branch pass | pass→fail | fail→pass |
| --- | --- | --- | --- | --- | --- |
| A (`Object/keys`, `expressions/object`, `Reflect/get`+`has`) | 1250 | 1125 | 1125 | 0 | 0 |
| B (`Object/entries`+`values`+`getOwnPropertyNames`, `for-in`) | 205 | 179 | 179 | 0 | 0 |
| C (`Object/getPrototypeOf`, `Reflect/getPrototypeOf`, `Function/prototype` ×100, `class/subclass` ×100, `expressions/class` ×100) | 249 | 196 | 196 | 0 | 0 |
| D (`TypedArray` ×100, `TypedArrayConstructors` ×100, `DataView` ×100) | 300 | 219 | 219 | 0 | 0 |
| **Total** | **2004** | **1719** | **1719** | **0** | **0** |

Per-file diff (`.tmp/s39b/diff_mnm2.py`) over all 2004 rows: **0 pass→fail, 0
fail→pass** across every group, including the new group D that this fix
directly touches. The base failures in A/B/C/D (async-generator
`compile_error`s, unrelated `Object`/`Reflect`/`class` gaps) are pre-existing
and identical on both trees, file for file.

### Corpus byte A/B

Same 42-file set S38b used (`website/playground/examples/**/*.ts` +
`tests/fixtures/**/*.ts`), compiled on both `gc` and `standalone` targets,
SHA-256 of the output binary compared (`.tmp/s39b/corpus-{base,fix}.jsonl`,
diffed with `.tmp/s39b/diff_corpus_s39b.py`):

| Target | Artifacts | Moved | CE/status flips |
| --- | --- | --- | --- |
| `gc` | 42 | 0 | 0 |
| `standalone` | 42 | 0 | 0 |

0 moved on `standalone` too (unlike S38b's 25/42, which touched a much
broader `getPrototypeOf` path) — this fix's 8 sites are narrow enough that
none of the 42 corpus files happen to exercise them.

Provider bytes: base `3,312,720 B` → fix `3,313,801 B` (**+1,081 B**) —
consistent with 8 call sites each swapping ~2 bare-test instructions for the
`taCtorIdentityTestInstrs` spread (comment lines add 0 bytes to the binary).

### Verdict

**Criterion 4 holds for this slice: 0 legitimate pass→fail across all three
measurement axes (family sample, must-not-move A/B/C/D, corpus byte A/B) —
and 0 fail→pass too, i.e. the fix is a pure no-op on every corpus slice
measured here.** That is expected and consistent with #6626's own
characterization: the 4 confirmed-buggy sites are collision-triggered
(require a field-less class/receiver landing on a `$__ta_ctor`-colliding tag
while a `$__ta_ctor` type is registered), and neither the real Temporal
polyfill's classes in the 4 sampled families nor any file in the
must-not-move/corpus sets happens to trigger that collision. The fix remains
justified as answer-preserving and zero-risk by construction
(`taCtorIdentityTestInstrs` can only ever remove a false positive), backed by
the 9 fix-witness/control tests in `tests/issue-6626-*.test.ts` that DO
reproduce the collision synthetically.

## Equivalence gate

`npm run -s test:equivalence:gate` (run in this S39b slice, fix tree):
**22 failing, 1720 passing, 22 known-failures in baseline — 0 new
regressions**, matching S39's own baseline exactly.
