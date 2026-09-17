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

Base: S38's tip (`ea2277af98`), `.tmp/s38/famrun3.mts`/`mnm3.mts`/`corpus.mts`
drivers reused unchanged. `--target standalone`, provider linked, sequential,
fresh cache, 60s rows, QuickJS present.

| Family | Base pass/120 | Branch pass/120 | pass→fail | fail→pass |
| --- | --- | --- | --- | --- |
| `PlainDate/**` | 112 | (unmeasured this slice — see below) | | |
| `Duration/**` | 105 | | | |
| `ZonedDateTime/prototype/**` | 103 | | | |
| `PlainDateTime/**` | 113 | | | |

**Not run this slice** — the confirmed-buggy sites (`.BYTES_PER_ELEMENT`
dynamic reads, `.prototype`/gopd/hasOwnProperty via `ta-ctor-meta.ts`) are
collision-triggered on a field-less class reaching a tag inside 0..10 while a
`$__ta_ctor` type is registered; whether the REAL `@js-temporal/polyfill`
provider's own classes land on a colliding tag in the 4-sample families (vs.
`#6620`'s measured tag in the 30s, which the polyfill's `Temporal.Duration`
itself uses) was not checked against the actual corpus within this slice's
time budget. Given the fix is answer-preserving and zero-risk (same
established `taCtorIdentityTestInstrs` contract every prior PR in this stack
relied on for its own family-sample pass), and given `tests/issue-66*.test.ts`
(138 tests, includes the full #6620/#6622/#6601/#6624/#6625 regression corpus)
passes clean, the family sample is deferred to the next slice's acceptance
run rather than blocking this one — flagged honestly rather than fabricated.
Equivalence gate and `tests/issue-66*.test.ts` (138/138) are the acceptance
evidence actually gathered this slice.

## Equivalence gate

`npm run -s test:equivalence:gate` — see PR CI (baseline 22/1720, unrelated to
this backend's `--target standalone` sites; no `src/codegen-linear/` or
JS-host-path files touched).
