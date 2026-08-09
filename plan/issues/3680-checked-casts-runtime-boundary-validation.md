---
id: 3680
title: "Checked casts at trust boundaries — `JSON.parse(x) as T` inserts runtime validation that throws with the offending path (scriptc-inspired)"
status: backlog
sprint: Backlog
created: 2026-07-26
priority: medium
horizon: l
feasibility: hard
reasoning_effort: high
task_type: feature
area: host-interop
language_feature: type-assertions
goal: correctness
---

# #3680 — Checked casts at trust boundaries

## Context / provenance

From the 2026-07-26 [vercel-labs/scriptc](https://github.com/vercel-labs/scriptc)
comparison. Two scriptc behaviors compose into one guarantee:

- `JSON.parse(...) as Config` "inserts a runtime validation that throws a
  catchable error naming the offending path."
- "Every value crossing back into static code is validated at runtime — a
  lying type throws a catchable `TypeError` instead of corrupting memory."

Their bet is the same as ours — TS types are compiler input — which makes a
lying type assertion a *soundness* hole, not a style issue.

## Problem for js2wasm

We compile against static types too, and a wrong `as T` can currently produce
type-confused Wasm values. The exposure sites:

1. **`JSON.parse(...) as T`** and similar untyped-to-typed narrowing — the
   classic external-data trust boundary.
2. **Host → wasm crossings in JS-host mode** — externref values coming back
   from host imports get coerced per the declared type
   (`src/codegen/type-coercion.ts`); a mismatched actual value is either a
   trap (bad DX: uncatchable, no message) or silent garbage (worse), depending
   on the coercion.
3. **`any`-typed values narrowed by assertion** inside otherwise-typed code.

In WasmGC mode a bad downcast at least traps on `ref.cast`; a trap is memory-
safe but *uncatchable and unlabeled*. In linear-memory mode the equivalent
confusion can silently misread memory. scriptc's move — a **catchable
`TypeError` naming the offending path** — is strictly better DX and, for the
linear backend, a real safety fix.

## Proposal

1. **Recognize checked-cast sites** in the IR front-end: `expr as T` where the
   source type is `any`/`unknown`/`JSON.parse` result and `T` is a
   structurally-describable type (via `ctx.oracle`, not the raw checker).
2. **Emit a validator** specialized per `T` — walk the value's runtime shape
   against `T` (primitives, arrays, object fields, nesting; v1 skips generics
   and function-typed fields). Track the access path during the walk.
3. **Throw catchable `TypeError`** with the offending path
   (`config.retries[2]: expected number, got string`) using the existing
   error-model machinery — never a bare wasm trap.
4. Apply the same validator at **host-import return boundaries** when the
   declared return type is a checkable shape (opt-in flag first —
   `--checkedBoundaries` — to measure overhead before making it default).
5. Both modes: validators must be Wasm-native for standalone mode (dual-mode
   principle — a JS-host fast path is fine, but not required for v1).

## Overlap / prior art

- `src/codegen/type-coercion.ts` owns today's boundary coercions — validators
  slot in as a strict variant of the same layer.
- Peephole already trusts `ref.cast` results (removes redundant
  `ref.as_non_null`); checked casts must compose with that, not fight it.

## Acceptance criteria

- [ ] `JSON.parse(bad) as Config` throws catchable `TypeError` naming the
      first offending path, in both JS-host and standalone modes
- [ ] A correct value passes with no observable behavior change
- [ ] `--checkedBoundaries` validates host-import returns against declared
      types; off by default, overhead measured in the benchmark sidebar
- [ ] Equivalence tests cover: valid, top-level type mismatch, nested field
      mismatch, array element mismatch
- [ ] No raw `checker.*` calls (oracle-ratchet gate)
