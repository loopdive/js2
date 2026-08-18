---
id: 3984
title: "Standalone: `Object.defineProperties(arr, {length: {...}})` never reaches ArraySetLength — the array length is silently left unchanged"
status: done
sprint: 78
created: 2026-08-01
completed: 2026-08-01
updated: 2026-08-18
assignee: ttraenkler/g-arraylen
priority: high
horizon: m
complexity: M
feasibility: medium
task_type: bugfix
area: codegen
language_feature: arrays, property descriptors
es_edition: es5
goal: standalone-mode
related: [3251, 3661, 3662, 3663, 1906, 739, 2668]
loc-budget-allow:
  - src/codegen/vec-overlay.ts
  - src/codegen/expressions/call-builtin-static.ts
  - src/codegen/object-ops.ts
func-budget-allow:
  - src/codegen/vec-overlay.ts::fillVecOverlayHelpers
  - src/codegen/expressions/call-builtin-static.ts::compileBuiltinStaticCall
  - src/codegen/object-ops.ts::compileObjectDefineProperties
origin: "2026-08-01: highest-confidence unowned lever in the standalone ES5+untagged goal scope; identified in plan/log/analysis-2026-08-01-descriptor-dedup-map.md as the largest uncovered descriptor family."
---

# `Object.defineProperties` never reaches `maybeEmitVecLengthDefine`

## Problem

`maybeEmitVecLengthDefine` (`src/codegen/object-ops.ts`) implements §10.4.2.4
ArraySetLength for WasmGC vec receivers: RangeError validation of the new
length, rejection of accessor descriptors on `length`, the illegal
attribute-change TypeError, the backing-store grow, and the actual length set.

It had **exactly one call site** — inside `compileObjectDefineProperty`. The
static object-literal expansion inside `compileObjectDefineProperties`
**re-parses the descriptor inline** instead of delegating, so it never reached
that machinery.

The consequence is not a refusal. It is a **silent wrong answer**:

```js
var a = [0, 1, 2];
Object.defineProperties(a, { length: { value: 2 } });
a.length; // 3  — WRONG, and nothing throws
```

Nothing downstream can detect this. A refusal (`compile_error`, an explicit
"not yet supported" throw) is visible to the report's root-cause classifier and
to the standalone floor; a wrong *value* is not. That is the priority argument:
this defect is invisible by construction.

This is a **routing gap over already-working machinery** — the singular
`Object.defineProperty(arr, "length", …)` form is correct today, including the
RangeError and accessor-rejection paths. It is therefore distinct from the
**#3251 per-index overlay-substrate epic** (XL, fable-pinned), which is about
giving array indices real descriptor records. #3984 adds no substrate; it routes
an existing, tested code path to a second caller. The two do not collide.

## Evidence

All probe files were **validated against Node first** — all 11 pass on a real
engine, so every failure below is a compiler defect and not a wrong assertion.
Probes live in `.tmp/probe-arraylen/` (gitignored); `node-oracle.mjs` is the
validator.

| # | probe | Node | host lane | standalone (main) |
|---|---|---|---|---|
| c0 | control: `a.length`, `a[1]` on a fresh array | PASS | PASS | PASS |
| g2 | `defineProperty(a,"length",{value:2})` | PASS | PASS | **PASS** |
| g1 | `defineProperties(a,{length:{value:2}})` | PASS | PASS | **FAIL — length stays 3** |
| c1 | `gOPD(a,"length")` on a fresh array | PASS | PASS | **FAIL — `undefined`** |
| d1 | `gOPD(a,"0")` | PASS | PASS | PASS |
| d2 | `gOPD({x:7},"x")` | PASS | PASS | PASS |
| d3 | `a.hasOwnProperty("length")` | PASS | PASS | PASS |
| d4 | `gOPN(a)` includes `"length"` | PASS | PASS | **FAIL — not listed** |
| d5 | `gOPD({length:3},"length")` | PASS | PASS | PASS |
| w1 | `defineProperty(a,"length",{writable:false})` → `gOPD().writable` | PASS | **FAIL — reads back `true`** | FAIL (confounded, see below) |
| w2 | `defineProperties(a,{length:{writable:false}})` → `gOPD().writable` | PASS | **FAIL — reads back `true`** | FAIL (confounded) |

`g1` failing on standalone while **passing on the host lane** is what makes this
a standalone-lane routing defect rather than a shared front-end bug.

## Three distinct defects, not one

The probe sweep separated three defects that were previously entangled. **Only
the first is in scope for #3984.**

### D1 — the routing gap (standalone-only) — THIS ISSUE

`compileObjectDefineProperties`' static expansion never called
`maybeEmitVecLengthDefine`. Fixed here.

### D2 — array `length`'s `writable` is silently dropped on store (BOTH lanes)

**This closes the open question the dedup map flagged as blocking.** An earlier
two-step probe was withdrawn as ambiguous between a `[[DefineOwnProperty]]` gap
and a failure to *store* `writable:false`. The single-step readback resolves it.

On the **host lane**, where `gOPD` on array `length` is fully functional —
proven by control `c1`, which correctly reports `{value: 3, writable: true}` on
a fresh array — setting `writable:false` and reading straight back with **no
intervening define** returns `true`:

```js
var a = [0, 1, 2];
Object.defineProperty(a, "length", { writable: false });
Object.getOwnPropertyDescriptor(a, "length").writable; // true — WRONG
```

This is unambiguous: the readback instrument is sound on that lane (`c1` proves
it), and the store still does not take. It affects **both** the singular and
plural forms (`w1` and `w2` fail identically), so it is **not** the routing gap
and the #3984 fix does not touch it. It is a **second defect underneath**, and
it is invisible to this issue's A/B — exactly as predicted. `maybeEmitVecLengthDefine`
is explicit about this: `writable` is in the ignored-names list, commented
`// \`writable\` (freeze deferred)`.

### D3 — array `length` is absent from descriptor reflection (standalone-only)

On standalone, `gOPD(arr,"length")` returns `undefined` (c1) and
`getOwnPropertyNames(arr)` omits `"length"` (d4) — while
`arr.hasOwnProperty("length")` answers `true` (d3). The discriminators rule out
the obvious alternatives: `gOPD` works on array *indices* (d1), on plain-object
properties (d2), and on the key `"length"` when the receiver is a plain object
(d5). So the vec's `length` is a struct field with no descriptor record, and
`hasOwnProperty` has a special case the reflection surface lacks.

D3 is why the `writable` question **cannot** be answered on the standalone lane
at all: there is nowhere to store an attribute for a property that does not
exist in the descriptor model. D2 and D3 should be filed and funded separately;
both are plausibly prerequisites for #3251.

## Fix

`src/codegen/object-ops.ts`, in the per-key loop of
`compileObjectDefineProperties`' static object-literal expansion: delegate to
`maybeEmitVecLengthDefine` before the inline descriptor parse.

The helper is **fully self-gating** (string key `"length"`, object-literal
descriptor, side-effect-free receiver resolving to a WasmGC vec struct) and
returns `false` for everything it does not own, so the call is a no-op for every
other property and every non-array receiver.

Two downstream effects had to be handled explicitly:

- **Stack balance.** The helper is written for the singular form, whose call
  result *is* the receiver, so it leaves a value on the stack. This loop's
  per-key code must leave the stack empty (the receiver is pushed once at the
  end from `objLocal`), so the value is dropped. The throw branches emit
  `unreachable` before returning, which makes the trailing `drop` validate as
  unreachable code.
- **Key order.** The check sits *inside* the per-key loop, so descriptors are
  still applied in source key order, as §7.3.26 DefinePropertiesRoutine requires.

The receiver is recompiled by the helper rather than read from `objLocal`; that
is safe precisely because the helper's own `isSideEffectFreeReceiver` gate
requires it, and it keeps this call site identical to the existing one.

## Follow-ups (NOT fixed here — recommend filing)

- **D2 — `writable` dropped on store for array `length`, BOTH lanes.** Blocks
  any test asserting on `length`'s writability, and is a prerequisite for the
  "non-writable length blocks later index adds" behaviour that
  `maybeEmitVecLengthDefine` currently lists as DEFERRED. Single-step repro in
  the Evidence table (w1/w2 on the host lane).
- **D3 — array `length` missing from descriptor reflection, standalone.**
  `gOPD`/`gOPN` do not see it while `hasOwnProperty` does. Plausibly a
  prerequisite for #3251, and the reason D2 cannot even be measured on the
  standalone lane.

Together these gate most of the 69 files this issue's fix did not flip, so they
are the natural next lever in this family rather than more routing work.

## Acceptance criteria

- `Object.defineProperties(arr, {length: {value: n}})` sets the length on the
  standalone target, matching the singular form.
- RangeError / accessor-rejection / illegal-attribute behaviour reaches the
  plural form too (same machinery, same call).
- No regression in the default lane, and no movement in the in-sweep controls.
- Attribution demonstrated by kill-switch removal, not by a before/after count.

## Measurement

Instrument validated before any claim: the scan reproduces standalone official
**43,106 run / 25,460 pass (59.1%)** and the ES5+untagged goal scope
**8,545 / 6,004 (70.3%)** exactly.

**The population is GATED, not a forecast.**

### Denominators — two derivations, stated separately

The dedup map sized this lever as **102 by mechanism / 100 reachable / 55
standalone-only** within the ES5+untagged **goal scope**. This issue's own scan
used a broader mechanism regex over the **whole standalone official scope**, and
gets **314 by mechanism / 223 currently failing / 103 reachable** (103 = fails
standalone *and* passes the host lane, so a standalone fix can flip it; 120 of
the 223 fail the default lane too and are unreachable from here).

These are **different denominators over different scopes, not a correction of
one by the other.** The A/B below is reported against the 103 this issue
actually gated. Neither figure should be read as a flip ceiling.

### Paired A/B — both arms in one process, attribution by removal

Arm A = kill switch on (main's behaviour), arm B = fix enabled. Same process,
same files, only the switch differs, so the delta cannot be cross-run drift.

| | |
|---|---|
| rows scored | A=105, B=105 vs floor 105 ✓ |
| arm A pass | 1 / 105 |
| arm B pass | 35 / 105 |
| **net** | **+34** |
| lost | **0** |
| `compile_timeout` | **0** (none to re-run solo) |
| in-sweep controls | **both HELD** |
| **ratio** | **34 flipped / 103 reachable gated = 33.0%** |

All 34 gains are `built-ins/Object/defineProperties/15.2.3.7-6-a-*` — exactly
the predicted family, no scatter.

The sweep was **re-run unchanged after the god-file refactor** and reproduced
the same 34 / 0 / 0 / controls-held, confirming the module split did not
quietly change behaviour. A **final arm with the kill switch deleted** and
`upstream/main` merged confirms the shipped code reproduces arm B exactly.

### Merge-queue park — a real regression the PR-level checks could not see

The first PR went green at PR level, was enqueued, and was then **auto-parked**
from the `merge_group` re-validation. One gate failed: the **#3189
uncatchable-trap ratchet**, `oob` 50 → 52, from `15.2.3.7-6-a-150` / `-151`.

Both files set `length` to 2^32−2 / 2^32−1. `maybeEmitVecLengthDefine` carries a
deliberate 16M allocation guard: above it, it updates `vec.length` **without**
growing the backing `$data` array, breaking the invariant
`length <= array.len(data)` that the same function's comment states. Routing the
plural form into it turned a clean assertion failure into an **uncatchable trap**.

**A named `trap-growth-allow` was formally available** (both files were baseline
`fail`, which is the valve's stated precondition) **and was deliberately not
taken.** Converting a catchable failure into an uncatchable trap is a genuine
quality regression regardless of prior status — banking a floor for it would
have hidden a real defect.

**Fixed at this call site, not in the shared helper.** The singular boundary
twins `15.2.3.6-4-160` / `-161` cover the same two values and **currently pass**,
so changing the helper's guard would risk two current passes to repair two
current failures — an unmeasured trade. `tryEmitVecLengthDefineForDefineProperties`
now declines a **valid uint32 above the 16M ceiling**; the pre-existing
singular-path hazard is documented in-source as latent and out of scope.

The predicate is narrow on purpose. A first attempt declined on **magnitude
alone** and silently cost two of the 34 flips (`-152` / `-153`, both
`Expected a RangeError to be thrown`): an out-of-range literal like 2^32 is an
*invalid* length whose required outcome is a RangeError, which the helper emits
correctly and safely — it throws without touching the array, so there is no
invariant to break. Only the **valid-but-unbackable** band is unsafe. Caught by
the verification set, not by inspection.

Post-fix verification: both flagged files non-trapping (clean `fail`, matching
the baseline error exactly), both singular twins still `pass`, **34/34 gains
held**.

**Second, independent confirmation of the +34:** the `merge_group` diff reported
`Host stable-path fine-gate net: +34 (43 improvements − 9 regressions)` — a
different instrument, on the merged state, agreeing with the paired A/B.

### Why the other 69 gated files did not flip

They are gated by **D2 and D3 above**, not by this routing gap: without a
descriptor record for array `length` (D3) and with `writable` dropped on store
(D2), the `defineProperties` tests that assert on *attributes* rather than on
the length *value* cannot pass no matter how the define is routed. That is the
honest ceiling of this issue, and it is why D2/D3 are worth filing.

## Standalone follow-up (2026-08-08, #4227): this routing is HOST-ONLY now

The routing added here was applied to **both** lanes, and on the standalone lane
that was the wrong direction: it put the compile-time inline ArraySetLength in
front of the native `__vec_dp_value` length arm, which — since #3251 S3 —
implements the FULL algorithm (the step-15 non-configurable shrink stop and the
`length` [[Writable]] bit) against the #3251 overlay companion. The inline path
cannot see that companion, so on standalone
`Object.defineProperties(arr, {length: {value: n}})` shrank straight past
non-configurable indices and ignored a frozen length.

That is exactly the reason the **singular** `Object.defineProperty` caller had
already been standalone-gated off (the "#3251 S3" note in
`compileObjectDefineProperty`); the plural caller introduced here simply
predated the same reasoning being applied to it. The gate now lives **inside**
`tryEmitVecLengthDefineForDefineProperties` rather than at either call site, so
the two callers cannot drift apart again.

Host mode is unchanged — this issue's measured +34 is a host-lane number and
still routes through the inline path.

Flipped standalone: `15.2.3.7-6-a-112` / `-158` / `-160` / `-165` / `-166` /
`-168` / `-169` / `-170` / `-172` / `-173` / `-175`. The "other 69 gated files"
ceiling recorded above is a HOST-lane statement and is untouched.

### LOC allowance for the #4227 change-set

The two rejection guards that came with it (§10.4.2.2 step 3, §10.1.6.3 step 2)
were extracted into their own module, `src/codegen/vec-define-rejections.ts`,
which is where the substance lives. What remains in the god-files is the wiring
that cannot be moved: the two spliced call sites plus the `throwTypeMsg` hook in
`vec-overlay.ts`' S3 record, and the syntactic `ToObject` nullish guard on
`Object.getOwnPropertyNames` in `call-builtin-static.ts`, which has to sit in
that call's own dispatch arm. The same two lines are what the function-budget
gate sees, hence the matching `func-budget-allow` for the host functions. The
`object-ops.ts` entry is the plural loop passing `compileObjectDefineProperty`
into `tryEmitVecLengthDefineForDefineProperties` as the standalone route — one
argument, spread over a prettier-wrapped call.
(the allowance itself is declared in this file's frontmatter, which is what the
gate reads.)
