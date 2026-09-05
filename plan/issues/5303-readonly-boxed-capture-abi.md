---
id: 5303
title: "Read-only capture of a GC-reference value is forwarded as the declaring frame's ref cell (moment 0/10)"
status: done
sprint: current
created: 2026-09-03
updated: 2026-09-04
completed: 2026-09-04
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: correctness
# 2026-09-03: the ABI-stability half of the fix (`preRegisteredValueForwarding`
# plus its `forwardUnboxed` plumbing) belongs beside the phase-0 reservation and
# the two rules it joins — `collectPromotedPreRegisteredSlots` (capture SET) and
# `reorderToPreRegisteredAbi` (capture ORDER). Splitting the third rule of that
# trio into another module would separate it from the invariant it enforces.
# Growth is +69 lines, most of it the rationale comment.
loc-budget-allow:
  - src/codegen/statements/nested-declarations.ts
# 2026-09-03: +15 lines inside the capture-collection loop and the record it
# builds. The new field and its one-line decision have to be computed where
# `type` / `alreadyBoxed` / `outerBoxedEntry` already are; the reasoning that
# justifies them lives in the module-level helper, not here.
func-budget-allow:
  - src/codegen/statements/nested-declarations.ts::compileNestedFunctionDeclarationInScope
---

# Read-only capture of a GC-reference value is forwarded as the ref cell

## Symptom

`moment@2.30.1` scored **0/10** on the upstream npm suite: not one admitted
test ran, because all six compiled modules were rejected outright by
`WebAssembly.compile` with the same error.

```
CompileError: WebAssembly.compile(): Compiling function #287:"createUTC" failed:
  call[13] expected type (ref null 92), found if of type (ref null 84)
```

## What actually happens

A nested `function` declaration is lifted with its captures as leading
parameters. When some sibling mutates one of those bindings, the declaring frame
boxes its slot into a `__boxed_<name>` ref cell (`struct (field (mut T))`) and
re-aims `localMap` at it, so writes propagate.

A **read-only** capturer still wants the VALUE. The cell belongs to the frame
that needed write-through; it is not part of a read-only capturer's ABI. Both
capture-forwarding sites already knew this and unwrap the cell with a
`struct.get`:

- the direct-call capture prepend in `src/codegen/expressions/call-identifier.ts`;
- the closure-reification prepend in `src/codegen/closures/funcref-as-closure.ts`.

Both decided "the consumer wants the value" the same way — by asking whether the
expected type was a **non-reference** (`f64` / `i32` / `externref`):

```ts
expectedCapType.kind !== "ref" && expectedCapType.kind !== "ref_null"
```

That is a proxy, not the question. It answers "no" for a read-only capture whose
own value type is itself a GC reference. moment's `isoDates` / `isoTimes` are
arrays of arrays — `(ref $vec-of-vec)` — so the unwrap never fired and the cell
was forwarded where the value was wanted.

Two distinct symptoms follow from that one mistake:

1. **Closure reification** passed the raw cell as the capture argument →
   `RuntimeError: illegal cast` (moment's `__module_init`, once the validation
   error below was out of the way).
2. **The direct call** "coerced" cell→value with a guarded
   `ref.test` / `ref.cast` `if`, which can only ever take the `else` arm and
   yield `null`. That already gives a wrong answer several frames later, and it
   becomes a hard validation failure when the callee's reserved signature is
   rewritten to the cell after the caller was compiled.

### Why the reserved signature drifts

`hoistFunctionDeclarations` phase 0 (`preRegisterCapturingSibling`) publishes
every capturing sibling's lifted signature **before** any sibling body is
compiled, from the declaring frame's slot types. Every direct call compiled
after that emits against exactly that signature — the file already states this
contract, and enforces it for the capture SET (`collectPromotedPreRegisteredSlots`)
and the capture ORDER (`reorderToPreRegisteredAbi`). It did not enforce it for
the capture TYPE.

The order that breaks it, exactly as seen in moment:

1. Phase 0 reserves `createLocalOrUTC` with `isoDates: (ref null $vec-of-vec)`.
2. A later sibling's lift runs `promoteAccessorCapturesToGlobals`, which boxes
   `isoDates` in the declaring frame because *another* nested function records
   it as a mutable capture (functions declared before the `var isoDates = […]`
   initializer see it as written-after-declaration; `createLocalOrUTC`, declared
   after it, sees it as read-only).
3. `createUTC` is lifted and emits `call $createLocalOrUTC` against the phase-0
   signature, coercing its own cell down to the value with a guarded `if`.
4. `createLocalOrUTC`'s real lift re-reads the now-boxed slot, publishes the
   CELL, and overwrites the reserved entry in place.
5. `createUTC`'s already-emitted call is now invalid.

Only the **read-only** arm drifts. A mutable capture's parameter is
`getOrRegisterRefCellType(valueType)` either way, and that type index is
memoized — identical before and after the promotion.

### Why nothing caught it

`fixCallArgTypesInBody` (`src/codegen/stack-balance.ts`) is the post-pass that
normally repairs a drifted call argument, and it did repair the `externref`
captures in that same call. It cannot reach these: its backward walk `break`s at
any structured `if`, and a ref→ref capture coercion is emitted as exactly that.
V8's message names the producer — `found **if** of type` — which is the tell.

## Fix

One question, asked directly, in one shared helper
(`expectsBoxedCaptureValue`, `src/codegen/closures/capture-source-slot.ts`): the
consumer wants the value exactly when its expected type **is** the box's inner
value type. A consumer that genuinely wants the cell names `refCellTypeIdx`,
which is never its own field's type index, so that arm is untouched. Both
forwarding sites now use it in place of the non-reference proxy.

Plus the ABI-stability half in `src/codegen/statements/nested-declarations.ts`
(`preRegisteredValueForwarding`): when a capture is read-only and its declaring
slot was boxed *after* this function's phase-0 pre-registration, keep the
pre-registered value type in the lifted signature and let the call site unwrap.
That is the type-level twin of the set-level and order-level rules already in
that file, and it removes the drift at its source rather than repairing its
symptom downstream.

## Evidence

**Regression test** — `tests/issue-5303-readonly-boxed-capture-abi.test.ts`.
Untyped `.js` fixture behind a two-file project (`mod.js` + `entry.ts`);
annotating the receiver `: any` routes to a different arm and the test then
passes identically either way.

| | parent `68246a740c` | with fix |
| --- | --- | --- |
| `tests/issue-5303-readonly-boxed-capture-abi.test.ts` | 1 failed \| 1 passed | 2 passed |

The failing case traps `RuntimeError: illegal cast` in `__fn_tramp_caller_2`.

**moment** — 0/10 → 4/10, at one head, same runner:

| file | parent | with fix |
| --- | --- | --- |
| `days_in_year.js` | 0/1 | 0/1 |
| `is_date.js` | 0/2 | **2/2** |
| `is_moment.js` | 0/2 | **1/2** |
| `min_max.js` | 0/2 | 0/2 |
| `mutable.js` | 0/2 | 0/2 |
| `normalize_units.js` | 0/1 | **1/1** |

All six modules validate and `__module_init` completes; on the parent none of
them did.

## Residual — not this defect

The remaining 6 moment failures share one *different* cause:
`RuntimeError: dereferencing a null pointer` in `prepareConfig`
(`moment.js:3030-3044`, reached from `createLocalOrUTC` → `createLocal`). It was
unobservable before this fix because the module never validated. It is a
separate defect and is deliberately left open.

## Corpus A/B

Both arms at ONE head — parent `68246a740c` checked out in a second worktree
(`ab-base-5545`) vs this branch — same runner, same pinned upstream checkouts,
each arm with its own private cache. All 17 suites exited 0. Compared per test
file (`grep -oE 'native; [0-9]+/[0-9]+ Wasm'`):

| package | base | fix |
| --- | --- | --- |
| webpack | 16/16 | 16/16 |
| three | 17/18 | 17/18 |
| clsx | 32/32 | 32/32 |
| cookie | 63740/63740 | 63740/63740 |
| lodash | 53/62 | 53/62 |
| redux | 60/82 | 60/82 |
| axios | 108/231 | 108/231 |
| stylelint | 108/108 | 108/108 |
| tailwindcss | 13/13 | 13/13 |
| jsdom | 6/6 | 6/6 |
| styled-components | 9/9 | 9/9 |
| uuid | 10 files, all identical | 10 files, all identical |
| marked | 0/30 | 0/30 |
| **moment** | **0/10** | **4/10** |
| prettier | 51/151 | 51/151 |
| jest | 299/356 | 299/356 |
| hono | 4 files, all identical | 4 files, all identical |

`uuid` and `hono` print no `admitted` headline; both were compared per test file
and every line is byte-identical across the arms. **moment is the only package
that moved, in either direction.**

## Pre-existing failures, verified not caused by this change

Three tests in the closure/capture area fail identically on the parent commit
and on this branch — same three, same assertions:

- `tests/issue-1528-closure-construct.test.ts` — "does NOT route a
  generator-method value through the construct bridge"
- `tests/issue-1712-capture-closure-dispatch.test.ts` — "prototype method
  returns a fnctor-instance node graph (acorn shape)"
- `tests/issue-2029-tagged-template-capture-local-index.test.ts` —
  "materializes a forward capturing sibling returned as a callable"

## Relationship to the eager dominating box (`arrow-phases.ts`)

Disjoint, and deliberately so. `canBoxBindingInDominatingParent` decides WHERE a
capture's canonical box is created, and it is gated on `isMutable &&
!alreadyBoxed`. This change never creates or moves a box; it decides WHICH
REPRESENTATION — cell or value — a `!cap.mutable` consumer receives from a box
that already exists. The two predicates are on opposite sides of `mutable`, so
they cannot disagree about where a capture's canonical box lives.
