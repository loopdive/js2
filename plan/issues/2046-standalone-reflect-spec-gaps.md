---
id: 2046
title: "standalone Reflect: receiver arg silently dropped, deleteProperty ignores freeze/configurable, no ToPropertyKey (#1905 follow-up)"
status: in-progress
sprint: 64
created: 2026-06-10
updated: 2026-06-21
priority: high
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen, runtime
language_feature: reflect, objects
goal: standalone-mode
related: [1905, 1888, 1629, 2042]
origin: "2026-06-10 sprint-61 code review of merged PR #1261 (#1905): the standalone Reflect.get/set/has/deleteProperty subset has four spec-semantics gaps, two of them silent-wrong-value."
---

# #2046 — Standalone Reflect spec gaps (#1905 follow-up)

## Problem

The #1905 native Reflect subset is structurally sound (dual-mode gating,
fail-loud for apply/construct/defineProperty, index-shift-safe helper
bodies), but review found four spec deviations. The first two produce
**silently wrong values** — worse than the refusals they replaced.

1. **Receiver argument evaluated then dropped** —
   `src/codegen/expressions/calls.ts:5067` (`Reflect.get(target, key,
   receiver)`) and `:5081` (`Reflect.set(target, key, value, receiver)`)
   call `emitAndDropOptionalArg`. With accessor properties (live since
   #1888 S5b — `__extern_get`/`__extern_set` invoke stored getters/setters),
   the getter/setter runs with `this = target` instead of `receiver`
   ([§28.1.5 / §28.1.12 → §10.1.8/§10.1.9](https://tc39.es/ecma262/#sec-reflect.get)),
   and `Reflect.set` writes to the wrong object. Minimal fix until receiver
   plumbing exists: **refuse loudly** when `arguments.length > 2` (get) /
   `> 3` (set) — a one-line gate restoring the fail-loud invariant.
2. **`Reflect.deleteProperty` ignores integrity levels and configurability**
   — routing at `calls.ts:5102-5111` into `__delete_property`
   (`src/codegen/object-runtime.ts:1187-1266`), which checks neither
   object-level `OBJ_FLAG_SEALED`/`OBJ_FLAG_FROZEN` nor per-entry
   `FLAG_CONFIGURABLE` (creatable via #1629's `__defineProperty_value`).
   `Reflect.deleteProperty(Object.freeze({x:1}), "x")` **deletes and
   returns true** (spec: keep, return false). Inconsistent with the same
   PR's own `__reflect_set`, which does preflight frozen/non-writable.
   The helper's "data props are always configurable" comment is stale.
3. **Non-object targets** — `Reflect.deleteProperty(primitive, k)` returns
   **true** (`object-runtime.ts:1201-1211`; the arm is correct for sloppy
   `delete`, wrong for Reflect — §28.1.4 requires TypeError). get/has/set
   on primitives return undefined/false/false instead of TypeError
   (`object-runtime.ts:509-516, 1468-1478, 1071-1081`) — less harmful but
   still silent deviations.
4. **No ToPropertyKey** — keys pass as raw externref into `$__obj_hash`
   which `ref.cast $AnyString` (`object-runtime.ts:289`), so
   `Reflect.get(o, 1)` **traps** instead of coercing to `"1"`
   (§7.1.19). Numeric keys are common in the test262 bucket.

Also from review (lower priority): inherited-accessor `Reflect.set` does not
walk the proto chain (documented #1888 scope boundary, consistent with plain
assignment); `tests/issue-1905.test.ts` lacks proto-chain, receiver, and
non-string-key cases; the `fallbackReturn(n, "i32-true")` dead branch at
`calls.ts:5088/5099/5110` would be safer as `i32-false`.

## Suggested order

1. The two one-line gates: refuse explicit receiver args (fix 1) and route
   non-`$Object` deleteProperty to TypeError (fix 3a). Converts
   silent-wrong to loud.
2. Integrity/configurability preflight in the delete route (share
   `__reflect_set`'s existing frozen/sealed checks; honor
   `FLAG_CONFIGURABLE`).
3. ToPropertyKey: brand-switch the key before `__obj_hash` (number →
   numeric-string via the #1335/#1759 number-to-string path; symbol keys
   may refuse loudly for now).
4. Real receiver support (plumb receiver through `__extern_get`/`__extern_set`
   accessor invocation) — coordinate with #1888 Slice 5 accessor work.

## Acceptance criteria

- `Reflect.deleteProperty(Object.freeze({x:1}), "x")` returns false and
  keeps the property; configurable:false entries likewise.
- `Reflect.get(o, 1)` returns `o["1"]` — no trap.
- Explicit-receiver forms either honor the receiver or refuse at compile
  time — never silently mis-bind `this`.
- TypeError (catchable) for non-object targets across all four methods.
- tests/issue-1905.test.ts extended with proto-chain, frozen-delete,
  numeric-key, and receiver cases; standalone test262
  `built-ins/Reflect/{get,set,has,deleteProperty}` rows improve.

## Resolution — PR-A + PR-B (2026-06-14)

PR-A (defects 1 + 3a) and PR-B (defect 2) landed; PR-C (real receiver) is
senior/deferred and PR-D (ToPropertyKey) rides #2042 — both remain, so this
issue stays `in-progress`.

**PR-A — restore fail-loud** (`src/codegen/expressions/calls.ts`, all inside
`if (ctx.standalone)`):
- **Defect 1 (receiver mis-bind):** `Reflect.get`/`Reflect.set` now refuse
  loudly (`reportError`) when an explicit receiver is present
  (`arguments.length > 2` / `> 3`) instead of evaluating-then-dropping it (which
  silently bound `this = target` for accessors, §28.1.5/§28.1.12 →
  §10.1.8/§10.1.9). Removed the now-dead `emitAndDropOptionalArg`.
- **Defect 3a (non-object deleteProperty):** added a CALL-SITE `ref.test $Object`
  guard on the target; a non-`$Object` target throws a catchable TypeError
  (`emitThrowTypeError`, §28.1.4). The SHARED `__delete_property` helper is
  untouched (sloppy `delete primitive[k]` stays a no-op success).
- Cleanup: the boolean-Reflect `fallbackReturn` dead branches now return
  `i32-false` (registration-failure default), not a phantom `true`.

**PR-B — delete configurability/integrity preflight**
(`src/codegen/object-runtime.ts`, `__delete_property`):
- After finding a live entry, refuse (return 0, keep the prop) when the object
  is sealed/frozen **OR** the entry is non-configurable
  (`FLAG_CONFIGURABLE` cleared), per §10.1.10 OrdinaryDelete.
- **Verified subtlety:** `__object_freeze`/`__object_seal` set only the
  object-level `$Object.flags` `OBJ_FLAG_SEALED` bit and do NOT clear each
  entry's `FLAG_CONFIGURABLE`, so the preflight checks BOTH the object
  `OBJ_FLAG_SEALED` bit and the per-entry `FLAG_CONFIGURABLE` bit.
  `Object.preventExtensions` (NONEXTENSIBLE only, not SEALED) does NOT block
  delete — confirmed. Correct for both `Reflect.deleteProperty` and sloppy
  `delete` (§13.5.1.2 — both refuse a non-configurable own prop).

**Remaining (out of this PR):**
- **PR-C (real receiver plumbing)** — senior/deferred, coordinates with #1888
  Slice 5 accessor-invocation machinery.
- **PR-D (ToPropertyKey)** — `Reflect.get(o, 1)` still traps ("illegal cast" on
  `ref.cast $AnyString` in `__obj_hash`). This is the SAME numeric-key fix as
  #2042 PR-A; reuse #2042's shared key-coercion helper once it lands rather than
  duplicating. Coordinated with dev-b.

## Test Results (2026-06-14)

- `tests/issue-2046.test.ts` (new) — 10/10: explicit-receiver refusal (get+set),
  no-receiver get/set work, non-object deleteProperty throws TypeError,
  object deleteProperty deletes, frozen/sealed deleteProperty → false + kept,
  preventExtensions delete still succeeds, sloppy delete honors freeze, sloppy
  delete normal succeeds.
- `tests/issue-1905.test.ts` — green (4/4, no regression).
- Pre-existing unrelated failures (byte-identical to origin/main, untouched by
  this change): `tests/object-define-property.test.ts` /
  `tests/delete-operator.test.ts` import the broken `tests/helpers.js`;
  `tests/equivalence/reflect-api.test.ts` "Reflect.construct creates a new
  instance" fails identically on clean origin/main (host-mode, not standalone).

## Implementation Plan (architect, 2026-06-17) — s63 gate slice S5 (+ PR-D dependency)

This issue owns slice **S5** of the #1472 gate (see #1472 coordinating spec).
The `standalone-reflect-refusal` bucket is now almost pure CE (295 CE / 20 fail
of 315), so S5 is a refusal-retirement slice.

### Bucket breakdown (report 2026-06-16)
- `Reflect.construct` refusal — 152 rows (largest)
- `Reflect.defineProperty` refusal — 53 rows
- `Reflect.getOwnPropertyDescriptor` refusal — 15 rows
- explicit-receiver `Reflect.get`/`Reflect.set` refusal — 29 rows
  (these are **correctly** refused per PR-A — leave them, they are honest)

### PR-D dependency (numeric keys) — consume #2042 S1, do NOT duplicate
The deferred PR-D ("`Reflect.get(o, 1)` still traps on `ref.cast $AnyString` in
`__obj_hash`") is now subsumed by **#2042 S1** (`__to_property_key` hardening at
`__obj_find`/`__obj_hash`). Once S1 lands, `Reflect.get(o, 1)` returns `o["1"]`
with zero extra work here — verify and close PR-D. Coordinate with the S1 dev so
only ONE coercion helper exists.

### S5 fix (`src/codegen/expressions/calls.ts`, inside the `if (ctx.standalone)`
Reflect dispatch block)
- **`Reflect.defineProperty(t, k, desc)`** → route to the #2042 **S3**
  `__defineProperty_desc` native; return its boolean success as i32 (Reflect
  returns `false` on failure rather than throwing). **Depends on #2042 S3.**
- **`Reflect.getOwnPropertyDescriptor(t, k)`** → route to the existing native
  `__getOwnPropertyDescriptor` (already in `OBJECT_RUNTIME_HELPER_NAMES`). No new
  runtime work — just replace the refusal with the call. **No dependency** —
  ship this first as the cheapest win.
- **`Reflect.construct(target, argsList)`** (152 rows, the big one) → route the
  2-arg form to the same construct path standalone `new X(...)` uses; **refuse**
  the 3-arg `newTarget` form (proto override needs the class/proto graph). This
  one is gated on the standalone construct machinery — coordinate with the
  #2158 class/construct owner. If construct plumbing isn't ready, keep its
  refusal and ship the two descriptor wins separately so they aren't blocked.

### Edge cases
- `Reflect.defineProperty` must return a **boolean**, never throw, even when the
  underlying define would TypeError (e.g. non-configurable redefine) — wrap the
  S4 validation so a rejected define returns `false` in the Reflect path while
  `Object.defineProperty` throws. (Same native, two call-site return shapes.)
- Non-object target → already TypeError via PR-A's `ref.test $Object` call-site
  guard; keep it for the new methods too.

### Acceptance signatures
- `built-ins/Reflect/getOwnPropertyDescriptor/*` and
  `built-ins/Reflect/defineProperty/*` standalone rows move refusal → pass.
- `Reflect.get(o, 1)` no longer traps (via #2042 S1).
- `Reflect.construct` 2-arg form passes where standalone `new` already works;
  3-arg form refuses loudly (no silent wrong newTarget).
- Extend `tests/issue-2046.test.ts` / `tests/issue-1905.test.ts` with
  numeric-key get, `Reflect.defineProperty` data+accessor desc, and
  `Reflect.getOwnPropertyDescriptor` round-trip.

## S5 slice landed — getOwnPropertyDescriptor + PR-D confirmation (2026-06-21)

PROBE-VERIFIED against current main HEAD (075d90ee5) before any change:

- **PR-D (numeric-key `Reflect.get`) — already fixed, no code change.** `#2042
  S1`'s `__to_property_key` hardening landed, so `Reflect.get(o, 1)` returns
  `o["1"]` (probe: `=> 42`) instead of trapping on the `ref.cast $AnyString` in
  `__obj_hash`. Closed PR-D; pinned with a regression test.
- **`Reflect.getOwnPropertyDescriptor` — was still refused; now routed.** The
  native `__getOwnPropertyDescriptor` (registered in `OBJECT_RUNTIME_HELPER_NAMES`)
  is now reachable end-to-end under standalone — verified independently via
  `Object.getOwnPropertyDescriptor` (value/writable/missing all correct). The
  stale registration comment near it (claiming "not reached end-to-end") predates
  #2042's read-side wiring.

**Change** (`src/codegen/expressions/calls.ts`, inside the `if (ctx.standalone)`
Reflect dispatch block, after the `ownKeys` arm): replaced the
`getOwnPropertyDescriptor` refusal with a route to the native
`__getOwnPropertyDescriptor`, returning the descriptor `$Object` (or `undefined`
for a missing own prop). §26.1.7 step 1 (non-object target → TypeError) is
enforced at the CALL SITE with the same `ref.test $Object`-guard /
`emitThrowTypeError` pattern PR-A introduced for `deleteProperty` — the shared
native (which returns `undefined` for non-`$Object` receivers, correct for the
`Object.*` caller) is untouched. ToPropertyKey on the key is handled inside the
native via `__to_property_key`, so numeric keys work.

New tests in `tests/issue-2046.test.ts` (16/16 green; 1905 4/4 unchanged): gOPD
data value, writable+enumerable+configurable flags, missing-prop→undefined,
numeric-key coercion, non-object→TypeError, and the PR-D numeric-key get pin.

**Still refused (out of this PR, issue stays `in-progress`):**
- **`Reflect.defineProperty`** — blocked on the write-side native
  `__defineProperty_desc` (generic `{value|get|set, writable?, …}` descriptor),
  which is deferred to **#2043** (see the NOTE near `__getOwnPropertyDescriptor`'s
  registration in `object-runtime.ts`). Route it the moment that native lands;
  remember the Reflect path returns `false` on a rejected define rather than
  throwing.
- **`Reflect.construct`** (152 rows, the big one) — gated on the standalone
  construct machinery (coordinate with the #2158 class/construct owner). 2-arg
  form → standalone `new X(...)` path; 3-arg `newTarget` form refuses loudly.
- **PR-C (real receiver plumbing)** — senior/deferred, coordinates with #1888
  Slice 5 accessor invocation; the explicit-receiver get/set refusal stays correct
  meanwhile.
