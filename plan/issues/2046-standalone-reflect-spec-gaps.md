---
id: 2046
title: "standalone Reflect: receiver arg silently dropped, deleteProperty ignores freeze/configurable, no ToPropertyKey (#1905 follow-up)"
status: in-progress
sprint: Backlog
created: 2026-06-10
updated: 2026-06-14
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
