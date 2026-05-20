---
id: 1556
title: "architect-spec: struct-field type mismatch in binding-pattern param destructuring — root cause of #1543/#1544 illegal-cast cluster"
status: spec-done
created: 2026-05-20
spec_done: 2026-05-20
priority: high
feasibility: hard
reasoning_effort: max
task_type: architect-spec
area: codegen, type-resolver
language_feature: destructuring, classes, async-generators, for-of
goal: test262-conformance
related: [1542, 1543, 1544, 1550, 1555]
blocks: [1543, 1544]
---

# #1556 — Architect spec: binding-pattern param struct-field type mismatch

## Background

Senior-dev investigation (2026-05-20) of #1543 and #1544 found that both issues
share the same underlying root cause, distinct from the architect spec that was
written for them. The original specs pointed at `coerceType externref→vec`
(already implemented) and `ref.test` guards (only address runtime traps, not
compile-time failures).

Same root cause also overlaps with #1542 and #1555.

## Root cause (confirmed by probe)

`src/codegen/literals.ts:447` has an explicit exclusion:

```ts
// exclude binding-element params to avoid 150+ dstr regressions
if (ts.isParameter(expr.parent) && ts.isBindingElement(expr.parent)) {
  // falls through to typed-struct path
}
```

This exclusion forces synthesized default values (e.g. `{}` in `method({ x = f() } = {})`)
through the **typed-struct path** rather than `__new_plain_object` (externref).

The TS-inferred struct type for a binding pattern like `{ x = thrower() }` with
a `never`-typed initializer yields struct fields with `i32` types. But the
destructure emitter downstream reads those fields expecting `externref`.

**Resulting Wasm validation error (compile time):**
```
local.set[0] expected type externref, found struct.get of type i32
```

**Why test262 sees "illegal cast" instead** (runtime): the test262 harness wraps
the call in a closure (`assert_throws(() => method())`). The closure parameter
type gets widened to `externref` at the boundary, masking the validation error —
the module instantiates, but the wrong type flows through at runtime, producing
an illegal cast trap inside `__closure_3` / `__closure_4`.

## Three distinct failure shapes under this root cause

| Shape | Symptoms | Example issues |
|-------|----------|----------------|
| Compile-time Wasm validation error | Module fails to instantiate | plain `method({ x = f() } = {})` |
| Runtime illegal cast in closure wrapper | test262 "illegal cast" in assert_throws | #1543 (74 tests), #1544 (45 tests) |
| Default initializer not fired | Compiles OK but `x = thrower()` not evaluated | #1542 overlap, #1544 rest/elision |

## Three fix paths (architect must choose + design)

### Path A — Widen field types in inferred binding-pattern struct types
For binding patterns used as params (and for-of bindings), widen all inferred
field types to `externref` before the struct is emitted.

- **Pro**: spec-correct; dstr emitter gets the type it expects
- **Con**: requires reworking `src/compiler/type-resolver.ts` where struct field
  types are inferred for binding patterns. Risk: the 150+ dstr cases that
  `literals.ts:447` was protecting could regress if field narrowing is elsewhere
  depended upon.
- **Regression gate**: run the full dstr test family (`language/destructuring/`,
  `language/statements/for-of/`, `language/statements/class/`) before/after.

### Path B — Route synthesized defaults through `__new_plain_object`
Remove or narrow the `literals.ts:447` exclusion so that `{}` defaults for
binding-pattern params go through the externref path.

- **Pro**: simpler than Path A; only touches `literals.ts`
- **Con**: same 150+ regression risk. The comment says "avoid regressions" but
  does not document WHICH regressions — architect must audit.
- **Required**: audit what the 150+ cases are before removing the guard.

### Path C — Defensive `ref.test` guard at use sites
At every dstr emitter site that reads a field from a binding-pattern struct,
emit `ref.test (ref extern)` before the `struct.get`.

- **Pro**: surgical; doesn't touch type-resolver or literals
- **Con**: only fixes RUNTIME traps (illegal cast). Does NOT fix the
  compile-time Wasm validation error (that happens before any guard can run).
  A test that triggers the compile-time path will still fail to instantiate.
- **Conclusion**: Path C alone is insufficient. Could be combined with Path A
  or B as a belt-and-suspenders safety net.

## Architect deliverables

1. Audit what the 150+ dstr regressions referenced in `literals.ts:447` actually
   are. Run `pnpm run test:262` filtered to `language/destructuring/` with the
   exclusion removed — enumerate which tests flip from pass→fail.
2. Choose Path A, B, or a hybrid.
3. Write implementation plan in this issue file with:
   - Exact file:line changes
   - Type-widening strategy
   - Which existing tests serve as regression gates
   - Whether Path C guard is needed as a complement

## Architect decision (2026-05-20)

**Chosen approach: Path B (narrowed) + Path D (defensive coercion).**
Full implementation plan written into **#1543** and **#1544** (both
closed by one shared patch). Summary:

### Path B is now safe (audit of the 150-regression claim)

The `literals.ts:447` exclusion was added in `67c59de60` (fix #929,
2026-04-11). At that time `destructureParamObject` had only a single
code path: `ref.cast` the externref to the expected struct, with no
guard — passing in `__new_plain_object()` would null-deref. That is the
"150+ dstr regression" scenario the exclusion was guarding.

**That guard is now obsolete**: commit `9d82b4e2d` (PR #177 / #852)
rewrote `destructureParamObject` lines 489–521 to (a) `ref.test` first,
(b) take the struct fast path when true, (c) fall back to
`destructureParamObjectExternref` (which uses `__extern_get`) when
false. The 150-regression scenario is now caught by step (c) — the
exclusion is dead code masking a real bug.

### Path D (defensive coercion) as belt-and-suspenders

The new Path D — introduced during this architect-spec — addresses a
subtle gap I found while reading the destructure code:
`emitDefaultValueCheck` accepts an optional `targetType` parameter that
controls coercion of the struct-field type to the binding local's
declared type, **but the callsite at `destructuring-params.ts:620` does
not pass it**. As a result, when the struct-field path fires for a typed
struct whose field type doesn't match its local (e.g. field `i32`, local
`externref`), the value path emits an i32 → local.set externref
mismatch. Pass `targetType = getLocalType(localIdx)` to fix.

### Why not Path A

Path A (widening all binding-pattern struct field types to externref via
a sibling-struct registration) is the spec-cleanest fix but requires:

- Recognising binding-pattern context inside `ensureStructForType`.
- Registering a parallel widened struct (the original struct may still
  be in use elsewhere).
- Threading the widened type through `function-body.ts` param-type
  resolution.

Estimated ~150–200 lines. Held in reserve as the fallback if the
regression gate (full `dstr/*` family) flags regressions after Path B+D.

### Why not Path C alone

Path C (ref.test guards at all destructure use sites) only converts
runtime wasm traps into JS TypeErrors. It does NOT fix the **compile-
time Wasm validation error** documented as #1556 Shape 1 — that occurs
before any ref.test can run. Path C is therefore insufficient as a
standalone fix.

However, **Path C as a complement to B+D** is valuable for #1544's
for-of iteration-source `ref.cast` site (`loops.ts:2064–2072`). The
audit details are in **#1544's plan**.

### Regression gate

Before merge, run on the test262 vitest runner:

```bash
pnpm run test:262 -- --filter "language/destructuring/"
pnpm run test:262 -- --filter "language/statements/for-of/dstr/"
pnpm run test:262 -- --filter "language/statements/for-await-of/"
pnpm run test:262 -- --filter "language/statements/class/dstr/"
pnpm run test:262 -- --filter "language/expressions/class/dstr/"
pnpm run test:262 -- --filter "language/expressions/function/dstr/"
pnpm run test:262 -- --filter "language/expressions/arrow-function/dstr/"
```

Net pass must be ≥ 0 on every dir. Any dir-level regression triggers
fallback to Path A.

### Complexity

- Primary fix (B+D shared between #1543 and #1544): **~15 lines**.
- #1544-specific ref.test guard if Audit-1 trap persists: **~10 lines**.
- Total: **~15–25 lines**. Path A fallback: ~150–200 lines.

### #1543 vs #1544

Both close on the **same** patch. #1543 is the async-gen-method shape;
#1544 is the for-of rest/elision shape. Different test262 buckets,
identical compiler root cause. One PR, two issue closures.

## Notes

- `src/codegen/literals.ts:447` — the exclusion comment references "150+ dstr
  regressions" but there is no associated test or issue number. Find and document
  the actual regressions.
- #1542 's over-iteration bug (`__array_from_iter` materialising whole iterator)
  is a **separate** issue tracked in #1555. Do not conflate.
- #1543 original architect spec pointed at `coerceType externref→vec` — that
  code already exists on main and is not the fix.
- #1544 original architect spec pointed at `ref.test` guard (Path C) — valid as
  a partial fix for runtime traps only.
