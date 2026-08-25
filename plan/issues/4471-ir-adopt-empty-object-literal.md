---
id: 4471
title: "IR: adopt the empty object literal `{}`"
status: done
sprint: 78
priority: medium
horizon: s
area: ir
goal: ir-full-coverage
related: [3518, 3583, 2949]
assignee: ttraenkler/opus-4471
completed: 2026-08-15
loc-budget-allow:
  - src/ir/select.ts
  - src/ir/from-ast.ts
---

# IR: adopt the empty object literal `{}`

## Problem

`ObjectLiteralExpression` is a `mixed` row in
[plan/log/ir-adoption.md](../log/ir-adoption.md): non-empty `{ key: val, … }`
and shorthand `{ a }` lower, but the EMPTY literal `{}` rejects at
`objectlit-empty` (measured 2026-08-15, #3583). The reject drops the **whole
containing function** to legacy via `body-shape-rejected`, so a single inert
`const o = {};` anywhere in a function costs that function's entire IR claim.

The standing comment on the reject asserted a reason that measurement
disproved:

> Empty literals get rejected by the codegen side (zero-property objects don't
> form a usable `IrType.object` shape)

## Measurement (2026-08-15)

Probes in `.tmp/4471/`, all run against this branch's base
(`3faec1ae`). Base copies of the three touched files were captured before the
first edit (`.tmp/4471/base/`) so every "before" column below is a run, not an
inherited figure.

### What legacy emits for `{}` — three different representations

`{}` is **representation-polymorphic in legacy**, decided by contextual type
and by a whole-program pre-pass. From `src/codegen/literals.ts` +
`src/codegen/declarations/object-shape-widening.ts`:

| Legacy shape for `{}`                | When                                                                     |
| ------------------------------------ | ------------------------------------------------------------------------ |
| struct WIDENED with expando fields   | a pre-pass saw later `o.x = …` writes → `compileWidenedEmptyObject`      |
| open `$Object` externref             | any/unknown/`object` context, pure string-index type, defineProperty recv |
| closed struct (fall-through)         | otherwise                                                                 |

None of these is a fieldless struct. That matters for scoping: legacy's `{}` is
not one thing the IR has to match, it is three, and the widened one is decided
by information the literal site does not carry.

### Is a zero-field IR shape actually unusable?

No — the standing comment was wrong. `emitObjectNew({ fields: [] }, [])` flows
through `ObjectStructRegistry.resolve` as an ordinary (fieldless) struct,
emits, instantiates, and matches legacy. Measured directly by lifting the
reject behind an env flag and running the corpus.

### Where it really breaks

A zero-field shape can serve **no** field access, so every use beyond "the
value exists" fails during lowering. Lifting the reject wholesale converted
**6 clean `unsupported` rejects into gated post-claim `invariant` demotions**
(`experimentalIR: true` turns those into hard compile errors):

| use                                | empty `{}`  | non-empty `{a:1}` | same boundary? |
| ---------------------------------- | ----------- | ----------------- | -------------- |
| property read via `as any`         | `invariant` | `invariant`       | SAME           |
| property write via `as any`        | `invariant` | `invariant`       | SAME           |
| call arg into a `dynamic` (`any`)  | `invariant` | `invariant`       | SAME           |
| `typeof o`                         | `invariant` | `invariant`       | SAME           |
| array-literal element `[o]`        | `invariant` | `invariant`       | SAME           |
| `{}` **return TypeNode**           | `invariant` | emitted           | DIFFERENT      |

So 5 of 6 are **not empty-specific** — they are the boundary the shipped
non-empty claim already has. The one genuinely empty-specific gap is on the
**type** side, not the literal side: `object TypeNode TypeLiteral could not be
lowered to IrType.object`, i.e. `IrType.object` has no zero-field
representation reachable from a TypeNode.

That the failures are shared does not make them free: claiming them would
enlarge the IR-only readiness debt on programs that compile cleanly today. The
`Post-claim demotions` bucket in `check:ir-fallbacks` is blind here — the
playground/website corpora contain **zero** `{}` (grepped), so the gate would
not have caught the regression.

### Why the "inert use" whitelist was abandoned

A whitelist of obviously-inert reference forms was tried and **every candidate
leaked**:

- `if (o) { … }` lowered and matched legacy, but `if (o) { … } else { … }`
  demoted with `if condition must be bool`. The IR has no `ToBoolean` for a
  ref, so the no-else form only worked incidentally.
- the conditional expression `o ? a : b` demoted.
- `while (o)` survived, but only in the bare form; `while (o && …)` did not.
- an alias `const p = o` is only safe if `p`'s own uses are inert, which this
  arm does not track.

With no reference form surviving measurement, "truthiness" is not a safe
category and the honest rule is **zero references**.

## Decision — narrow adoption

Claim `{}` only when it initializes an **un-annotated local binding that is
never referenced**. Everything else keeps rejecting at `objectlit-empty`.

- `src/ir/select.ts` — `isPhase1ObjectLiteral`'s empty arm now consults
  `isInertEmptyObjectLiteral`. Identifier matching is by TEXT, not symbol, so a
  same-named property key or shadowed binding counts as a reference and
  rejects; the walk descends into nested functions so a closure capture is
  seen. Both over-approximate, which is the safe direction.
- `src/ir/from-ast.ts` — `lowerObjectLiteral`'s empty-literal throw is
  removed. The property loop is already a no-op at zero properties, so the
  empty case falls through to `emitObjectNew({ fields: [] }, [])`;
  `lowerOrdinaryToPrimitiveObjectLiteral` returns null for a zero-property
  literal, so the valueOf/toString path is not entered.

`propagate.ts`'s `inferObjectLiteralAtom` deliberately still widens an empty
literal to `DYNAMIC`. The lattice type and the from-ast type disagree for these
bindings, which is harmless for an unreferenced one and kept the diff minimal.

## Deferred, with the reason typed precisely

| shape                                          | reason it stays rejected                                                     |
| ---------------------------------------------- | ---------------------------------------------------------------------------- |
| `{}` with any referenced binding               | no reference form survived measurement (see above)                           |
| `const o: any / object / {} = {}`              | legacy picks `$Object` externref or a widened struct, not a fieldless struct |
| `{}` as a nested property value (`{ a: {} }`)  | safe when shallow, but `p.a.x` demotes; needs a second-level use analysis    |
| `{}` as a call argument                        | needs `object{}` → `dynamic` coercion (#2949-adjacent)                       |
| `{}` as a return / param **TypeNode**          | `IrType.object` has no zero-field TypeNode representation                    |
| `let o = {}` reassigned                        | already rejected upstream of this arm                                        |

The nested-value and call-argument rows are the ones worth a follow-up: both
measured *safe in the shallow case* and both need real analysis rather than a
syntactic guard.

## Acceptance

A 32-shape sweep (`.tmp/4471/verify.mts`) where every case must be either
claimed-and-emitted with IR/legacy parity, or cleanly rejected. **A single
`invariant` outcome fails the adoption.**

Result: `PASS — 0 bad of 32; 4 claimed`. The 4 newly-claimed empty-literal
shapes are the unreferenced binding, two unreferenced bindings, and one inside
a loop; the non-empty baseline still claims.

## Test Results

- `tests/issue-4471.test.ts` — claim-backed positives, runtime parity,
  negative boundaries, dual-run equality.
- `pnpm run check:ir-fallbacks` — no growth (corpus contains no `{}`, so the
  numbers are unchanged in both directions; recorded because "unchanged" is the
  measurement, not an assumption).
- `pnpm run gen:ir-adoption -- --check` — clean.
- `pnpm run check:ir-only` — host lane unchanged, standalone floors unchanged.

## LOC budget

`loc-budget-allow` covers `src/ir/select.ts` and `src/ir/from-ast.ts`. The
growth is the selector guard plus the measured rationale for it; the rationale
is the part that keeps a future widening from re-deriving the leaky whitelist.
