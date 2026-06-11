---
id: 2046
title: "standalone Reflect: receiver arg silently dropped, deleteProperty ignores freeze/configurable, no ToPropertyKey (#1905 follow-up)"
status: ready
sprint: Backlog
created: 2026-06-10
updated: 2026-06-10
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
