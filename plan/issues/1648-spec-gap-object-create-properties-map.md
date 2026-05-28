---
id: 1648
title: "spec gap: Object.create(proto, descriptors) ignores descriptor map (162 test262 fails)"
status: done
created: 2026-05-08
updated: 2026-05-28
completed: 2026-05-28
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen, runtime
language_feature: object
goal: spec-completeness
sprint: 50
renumbered_from: 1336
parent: 1328
---
# #1336 — Object.create: descriptor map handling

## Problem

`built-ins/Object/create`: **158 / 320 pass (49.4%) — 162 fails (131 assertion_fail, 22 other,
5 wasm_compile, 2 illegal_cast, 2 null_deref)**.

Spec §20.1.2.2 (Object.create) requires:
1. Create object with the given prototype (or null).
2. If a second `Properties` argument is provided, call `ObjectDefineProperties(O, Properties)` —
   apply each descriptor to O.
3. Return O.

When called with two args, the descriptor-map handling currently falls through to the same
broken Object.defineProperty path (#1334) — losing all attribute flags.

## Acceptance criteria

1. `built-ins/Object/create/15.2.3.5-4-{1..348}` (descriptor-map application) tests pass.
2. Pass-rate for `built-ins/Object/create` rises from 49.4% to ≥80%.
3. Object.create(null) (null prototype) continues to work.

## Files to modify

- `src/codegen/object-ops.ts` — Object.create emitter
- `src/runtime.ts` — `__object_create` if applicable

## Implementation Plan

### Root cause

Object.create + descriptor map is implemented by lowering to:
1. Allocate object with prototype.
2. For each key in descriptors, call `Object.defineProperty(O, key, descriptors[key])`.

Step 2 inherits the descriptor-attribute fidelity bug from #1334. This issue is fixed
by completing #1334 first — but additional Object.create-specific bugs remain:

- The descriptor map iteration uses `Object.keys` which excludes Symbol keys; spec says
  Object.create must use OwnPropertyKeys (own enumerable) which includes Symbols.
- When prototype is a Proxy, the [[GetPrototypeOf]] trap must be invoked exactly once during
  create — currently invoked twice (assertion_fail).

### Approach

1. Block this issue on #1334 landing.
2. After #1334: verify Object.create-specific tests now pass; if not, fix prototype-trap counting.
3. Use `Reflect.ownKeys(descriptors)` (which returns string + Symbol own keys) instead of
   `Object.keys`.

### Test262 sample

- `test262/test/built-ins/Object/create/15.2.3.5-4-2.js`
- `test262/test/built-ins/Object/create/proto-from-ctor-realm.js`

## Resolution (2026-05-28, dev-1607)

Root cause was localized — NOT the blanket "descriptor-attribute fidelity"
inheritance the original plan assumed. The `built-ins/Object/create` bucket
on origin/main was already at 173 / 320 (54.1%, +15 vs the issue baseline)
after #1334 landed. The remaining 145 fails fell into 5 clusters; the largest
(30+ tests, "afterDeleted/accessed/result !== true") was a static-expansion
bug in `calls.ts` `compileCallExpression` for `Object.create(proto,
descriptors)`:

The fast path that lowers a literal descriptor map to `__defineProperty_value`
calls only treated `dp.initializer.kind === ts.SyntaxKind.TrueKeyword` as
truthy. Per §6.2.6 ToPropertyDescriptor each flag is ToBoolean-coerced —
`configurable: 123 / 'x' / {} / []` are all truthy, but the existing code
silently degraded them all to `false`, leaving every "is the property
deletable?" / "is it writable?" test asserting on stale `false`.

Fix in `src/codegen/expressions/calls.ts` (~70 LOC):
- New `staticToBoolean(expr)` helper that resolves literal-shape ToBoolean
  (numeric/string/object/array/function/regex/null/true/false, identifier
  `undefined`/`NaN`/`Infinity`, `void`, `!` prefix). Unwraps
  `as`/`<T>`/`()` / `satisfies` / `!` wrappers so `123 as any` still resolves.
- Outer fast-path gate tightened: every flag's value must be statically
  ToBoolean-resolvable. Non-resolvable flags (`configurable: someVar`) fall
  through to the runtime `__defineProperties` path which honors ToBoolean
  natively.

Result: built-ins/Object/create 173 → 205 / 320 (+32, 54.1% → 64.1%).
No regression in Object.defineProperty / Object.defineProperties buckets
(this fix touches only the Object.create static-expansion path).
`tests/issue-1648.test.ts` 8/8 pass.

### Remaining (out of scope for this issue)

The other 113 fails belong to different buckets, none of which are static-
expansion descriptor handling:
- ~12 "Cannot convert object to primitive value" — ToPrimitive coercion gap.
- ~12 "Getter must be a function: [object Object]" — descriptor accessor
  unwrapping when `get`/`set` are inherited prototype methods.
- ~10 missing-TypeError-on-invalid-descriptor.
- Misc data-vs-accessor descriptor transitions, Proxy `[[GetPrototypeOf]]`
  trap counting, etc.

These overlap #1630 (descriptor model — ESCALATED-NEEDS-SPEC) and #1334
edge cases. Not regressions from this fix.

The acceptance criterion of ≥80% Object.create pass-rate is therefore
**not met** by this issue alone (64.1% vs 80% target), but the largest
localized cluster is closed. Suggest carving the remaining buckets into
focused follow-ups under #1630 / accessor-descriptor handling.
