---
id: 4250
title: "Whole-program per-field write-kind verdict (unblocks the #743 ctor-param slot lever)"
status: ready
created: 2026-08-08
priority: high
horizon: l
feasibility: hard
goal: performance
sprint: current
related: [743, 3683, 3753, 4155, 4157, 4246]
---

## Problem

**A fnctor field's Wasm slot is chosen from the CONSTRUCTOR's write, and writes
that reach the field from anywhere else are not consulted.** When a later write
stores a value the slot cannot hold, the read comes back wrong — silently, with
no trap and no diagnostic.

This is a **pre-existing defect on `main`**, reachable today with every
experimental flag off, whenever the constructor's write is a literal the checker
can type:

```js
var A = function A() { this.tag = 1; };   // -> $tag (mut f64)
var a = new A();
a.tag = "s";
typeof a.tag === "string";                // JS: true.  Compiled: 0
```

Measured 2026-08-08 on `upstream/main` @ `15c3c9375`, standalone, all flags off:
`test()` returns `0`. The string write is lost by the f64 slot.

### Why it is being filed now

The #743 derivation-defaults flip (2026-08-08) had to decide whether to ship
`inferFnctorFieldTypeFromCtorParam` — the lever that extends the same slot
choice to constructors whose write is an **opaque parameter**:

```js
var A = function A(n) { this.tag = n; };   // flag off: $tag externref -> 1 (correct)
var a = new A(1);                          // flag on:  $tag f64       -> 0 (wrong)
a.tag = "s";
```

That is the same defect with a **much larger population**: an opaque-parameter
constructor write is the normal shape in real JS (it is exactly why the lever
was built — acorn's `Parser.pos`). Shipping it would have enlarged a
silent-wrong-answer class in exchange for slots measured at **zero** value-level
effect (#4246: `$AnyValue` allocation count identical flag-on and flag-off), so
the lever was left behind an opt-in `JS2WASM_FNCTOR_CTOR_PARAM_SLOTS=1` while
the rest of the family went default-ON.

**Both of the lever's arms have the hole, not just one** — probed separately:

| arm | shape | later write | flag off | flag on |
| --- | --- | --- | --- | --- |
| param | `this.tag = n` | `a.tag = "s"` | 1 | **0** |
| field-fact | `this.mark = this.pos` | `a.mark = "s"` | 1 | **0** |

The field-fact arm was expected to be safe, because the satellite's field pass
joins over the writes it can see. It is not: the writes it enumerates are
`this.<f>` writes inside the owner's own methods. A write through an instance
BINDING (`a.mark = …`) is not in that set.

## What is needed

A whole-program, per-field verdict: **"every write that can reach this field
holds a value of kind K"** — the field analogue of what
`inferParamTypeFromCallSites` already provides for parameters, where a
parameter's writes ARE its call sites.

`ctx.numericPropertyNames` (#3683 S4a, `src/codegen/numeric-property-analysis.ts`)
is the closest existing thing and is **not** a substitute:

- it is keyed by property NAME across the whole program, not per owner;
- it demands every write be *syntactically* numeric, which is precisely why
  acorn's `Parser.pos = startPos` never qualified and why the #743 lever exists;
- it therefore cannot express "this write is numeric because the fixpoint proved
  the value flowing into it is".

The two must COMPOSE: the fixpoint proves the constructor's opaque write is
numeric, and the write-kind verdict proves nothing else violates the slot.

## Why this looks buildable on existing machinery

The satellite fixpoint already enumerates reaching writes per field — that
enumeration is what the #4246 pin census counts (the `Parser.pos — final: f64
over 56 write(s)` line, down from 78). The missing pieces are scope, not
mechanism:

1. **Extend the write scan past `this.<f>`** to writes through a binding whose
   provenance is a tracked owner. `src/ir/fnctor-receiver-provenance.ts` already
   computes exactly that provenance (⊥ / R / ⊤) for the re-attribution pass — a
   ⊤ receiver must poison the field, which is the sound direction.
2. **Make the escape rule explicit.** Once an instance escapes the module (or
   the field name is reachable through a computed write, a `delete`, or the
   reflection arms), the verdict must be ⊤. `analyzeNumericPropertyNames`
   already has poison handling for the name-keyed version to model this on.
3. **Export it.** `runFieldPass` (`src/ir/fnctor-field-lattice.ts:212`) computes
   the field join and does not export it; #4155's Results section already notes
   a `computeFnctorGraphFieldFacts` export would be needed beside the two at
   `fnctor-method-edges.ts`.

## Acceptance criteria

- [ ] A per-owner, per-field write-kind verdict exists and is consulted by
      `inferFnctorFieldTypeFromCtorParam` before it narrows a slot.
- [ ] The `var A` repro above answers **1** in every configuration, including
      `JS2WASM_FNCTOR_CTOR_PARAM_SLOTS=1`.
- [ ] The pre-existing literal-write case (`this.tag = 1` then `a.tag = "s"`)
      also answers 1 — fixing the flip's population without fixing main's
      original is not the goal.
- [ ] Escape / computed-write / `delete` / reflection paths force the verdict to
      ⊤ (pinned by tests, each with a positive control proving the pin would
      otherwise have narrowed).
- [ ] CI conformance pair (artifact-vs-artifact, never against the committed
      baseline — see #4239) shows no non-timeout flips.
- [ ] Once green, `JS2WASM_FNCTOR_CTOR_PARAM_SLOTS` flips to the family's
      unset-⇒-ON rule and stops being the exception in
      `src/derivation-flags.ts`.

## Notes

- Do NOT "fix" this by requiring `numericPropertyNames` before narrowing. That
  makes the #743 lever a strict subset of S4a — every slot it could then move,
  S4a already moves — which is the same as deleting it.
- The value case for the lever is currently **unproven**: #4246 measured zero
  allocation movement and +124 B for the slots it recovers. This issue is worth
  doing for the CORRECTNESS half (it also fixes main's existing defect); the
  performance half should be re-measured, not assumed.
