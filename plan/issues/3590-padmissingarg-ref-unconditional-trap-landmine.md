---
id: 3590
title: "padMissingArg `ref` case emits ref.null + ref.as_non_null — an unconditional trap that passes validation"
status: ready
sprint: current
created: 2026-07-24
updated: 2026-07-24
priority: medium
horizon: s
feasibility: medium
task_type: bug
area: codegen
goal: core-semantics
related: [3024, 3563, 3189, 3589]
origin: "Found by the PR-queue shepherd while diagnosing the #3563 auto-park, 2026-07-24. Currently unexercised; filed so it is fixed before it is reached."
---

# #3590 — `padMissingArg`'s `ref` case is an unconditional null-deref trap

## Problem

The iterator-dispatcher argument padding added by #3563
(`emitMethodDispatch` → `padMissingArg`, `src/codegen/index.ts`) pads a missing
trailing method argument per parameter type. The **non-nullable GC-ref** case is:

```ts
case "ref":
  return [{ op: "ref.null", typeIdx: (pt as { typeIdx: number }).typeIdx }, { op: "ref.as_non_null" }];
```

`ref.null $T` pushes a null, and `ref.as_non_null` **traps if its operand is
null**. Because the operand is _literally_ `ref.null`, this sequence traps
**100% of the time it executes**.

It is not a validation error — it type-checks correctly as `(ref $T)`, which is
exactly what makes it dangerous: the module compiles and validates cleanly, and
the failure only appears at runtime, as an **uncatchable** trap.

The adjacent `ref_null` case is a softer version of the same problem:

```ts
case "ref_null":
  return [{ op: "ref.null", typeIdx: (pt as { typeIdx: number }).typeIdx }];
```

This does not trap at the pad site, but it hands the callee a null that the
callee will dereference on any field access — relocating the same uncatchable
trap one frame deeper.

The general point: **a GC-ref parameter has no trap-free default value.** Unlike
`i32`/`f64` (which have a genuine zero / NaN missing-arg sentinel) and
`externref` (which has a real host `undefined` via `__get_undefined`), there is
no inhabitant of `(ref $T)` that can be synthesised without allocating one.

## Impact

**Currently unexercised** — no test in the suite hits it today. The dispatcher
instrumentation run during the #3563 diagnosis showed the only padded parameter
in the observed failing case was `{"kind":"f64"}`, the numeric sentinel.

But it is a landmine on a path that is actively growing (#3024 has ~15 merged
slices, each making more modules validate and therefore more dispatch arms
reachable). The first user iterator with a typed `next(v: SomeClass)` parameter
that reaches this dispatcher will trap uncatchably — and, because
`ref.as_non_null` cannot be caught, it will trip the **#3189 uncatchable-trap
ratchet** in the `merge_group` and auto-park whichever PR happens to be in
flight. That is a hard-to-attribute failure landing on an innocent PR, which is
precisely the expensive kind.

## Proposed fix (prototyped, then deliberately reverted — see Notes)

Do not pad what cannot be padded: **omit the dispatch entry entirely** when any
extra parameter is a GC ref.

```ts
// A GC-ref extra param has NO trap-free default, so it must NOT be padded.
if (extraParams.some((pt) => pt.kind === "ref" || pt.kind === "ref_null")) continue;
```

Why this is safe:

- The module **still validates** — which is the entire point of #3563. The
  omitted arm simply falls through to the dispatcher's existing
  `ref.null.extern` default, i.e. the protocol call yields `undefined`.
- It **cannot re-introduce** the `not enough arguments on the stack` invalid-Wasm
  failure, because no call is emitted for the omitted entry at all.
- The outcome degrades from an **uncatchable trap** to a **catchable** protocol
  failure (a `TypeError`-shaped result), which is strictly better and is what the
  #3189 ratchet is asking for.
- Semantically nothing is lost: calling `.next()` with no argument on an iterator
  whose `next` requires a typed parameter is already a type error in TypeScript,
  and the previous behaviour for that arm was a guaranteed trap.

The `ref` / `ref_null` cases should then be **removed** from `padMissingArg`
rather than left dead. If the guard is ever dropped, the `default` arm's
`externref` value fails Wasm validation **loudly** at build time, instead of
silently re-emitting a null-deref trap — a much better failure mode.

## Acceptance criteria

1. No emitted instruction sequence in `emitMethodDispatch` can trap
   unconditionally; specifically `ref.null` immediately followed by
   `ref.as_non_null` is gone.
2. A regression test compiles a user iterator whose `next`/`return` declares a
   **typed (class) parameter**, asserts the module **validates**, and asserts the
   protocol call does **not** trap.
3. `null_deref` / `illegal_cast` trap-category counts do not grow.
4. The existing #3024 iterator-dispatch arity tests still pass (the CE
   eliminations are preserved).

## Notes

- Found while diagnosing the #3563 auto-park; **not** the cause of that park (see
  #3589 for the actual cause — a pre-existing `assert`-harness null-deref that
  #3563 unmasks).
- The fix above **was prototyped** against the #3563 head during the
  investigation, and confirmed to keep the module valid. It was then
  **deliberately reverted and NOT shipped**, for two reasons: (1) it did not fix
  the failure actually being diagnosed, so it would have been unvalidated
  behaviour change riding along on an unrelated park; and (2) it belongs to the
  branch's owner / a proper dev cycle with its own regression test, not to a
  shepherd editing someone else's PR under them. Recording the reasoning here so
  the prototype is not silently lost.
- Best landed either as a follow-up to #3563 once it un-parks, or folded into
  #3563 itself by whoever picks that branch back up — with criterion 2's
  regression test attached.
