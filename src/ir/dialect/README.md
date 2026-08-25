# `src/ir/dialect/` — source-language dialects of the IR (R-OWN)

**Responsibility:** instruction kinds whose meaning is defined by a *source
language* rather than by compilation in general. Today there is one dialect,
`js.ts` (ECMAScript). Introduced by **#3954 phase 2**; the per-kind boundary
question is owned by **#4551**.

Normative background: `docs/architecture/codegen-axes.md` (the axes doctrine)
and #3954 ("Name the IR's ambient ECMAScript assumptions").

## What belongs here

An instruction belongs in a dialect when **its semantics come from a language
specification**. `dyn.truthy` is ECMA-262 §7.1.2; `iter.next` is the JS
iterator protocol; `await` is JS async semantics. None of them means anything
to a source language that is not JavaScript.

An instruction belongs in the neutral core (`../nodes.ts`) when two unrelated
source languages would give it the same meaning: control flow, calls, closures,
refcells, slots, arithmetic, try/throw.

## What is deliberately NOT here yet

`vec.*`, `class.*`, `object.*`, `string.*`, `box`/`unbox`/`tag.test`,
`forof.vec`/`forof.string`, and `coerce.to_externref`.

Whether those are neutral is **genuinely unsettled**, not merely unreviewed.
Spot-checks reversed the intuitive reading more often than they confirmed it —
`vec.*` array holes turn out to live in `src/codegen/array-holes.ts`, *above*
the IR, and `string.*` is already parameterized by `IrStringEncoding` rather
than hardcoding UTF-16. #4551 produces the per-kind verdict with cited
evidence.

**An unresolved kind stays in core.** Placing one here on a hunch gives a guess
the authority of a lint rule, and moving it back later is expensive.

## Rules (enforced by `scripts/check-ir-dialect.mjs`, in `quality`)

| # | Rule |
| --- | --- |
| R1 | Only `src/ir/nodes.ts` may import a dialect — it assembles the `IrInstr` union and re-exports the names. Every other core file imports from `nodes.js`. |
| R2 | `nodes.ts` re-exports every name a dialect declares. The split is a declaration move, not an API change: 54 files import `nodes.js`. |

Both rules have negative tests — each was confirmed to fail on a deliberate
violation before being wired into CI.

## Dependencies (R-DEP)

May import: `../nodes.js` (**`import type` only** — interfaces are erased, so
the core↔dialect cycle has no runtime edge), `../types.js`.

Must NOT import: `src/codegen/**`, `src/codegen-linear/**`, `src/ir/backend/**`.
A dialect declares *what a construct means in its source language*; it never
knows how any backend lowers it.
