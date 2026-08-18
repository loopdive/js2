---
id: 4250
title: "Whole-program per-field write-kind verdict (unblocks the #743 ctor-param slot lever)"
status: done
completed: 2026-08-09
assignee: ttraenkler/fable-743-fixpoint
created: 2026-08-08
priority: high
horizon: l
feasibility: hard
goal: performance
sprint: 78
related: [743, 3683, 3753, 4155, 4157, 4246]
loc-budget-allow:
  # +16 (1935 → 1951): the literal-arm veto in `recordThisField` — the ONE place
  # the checker-typed slot is chosen, so the veto cannot live in a satellite
  # module; all verdict logic is in fnctor-ctor-param-types.ts / src/ir.
  - src/codegen/fnctor-escape-gate.ts
  # +10 (2010 → 2020): the two unsound-fold guard consults (compileTypeofExpression
  # + the comparison path) and one import — the fold sites are here and only here.
  - src/codegen/typeof-delete.ts
func-budget-allow:
  # 371 → 387: the veto block inside `deriveFnctorFields` (see above). Splitting
  # this function is #3399-class work, not something to smuggle under a
  # correctness fix.
  - src/codegen/fnctor-escape-gate.ts::deriveFnctorFields
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

- [x] A per-owner, per-field write-kind verdict exists and is consulted by
      `inferFnctorFieldTypeFromCtorParam` before it narrows a slot.
- [x] The `var A` repro above answers **1** in every configuration, including
      `JS2WASM_FNCTOR_CTOR_PARAM_SLOTS=1`.
- [x] The pre-existing literal-write case (`this.tag = 1` then `a.tag = "s"`)
      also answers 1 — fixing the flip's population without fixing main's
      original is not the goal.
- [x] Escape / computed-write / `delete` / reflection paths force the verdict to
      ⊤ (pinned by tests, each with a positive control proving the pin would
      otherwise have narrowed).
- [ ] CI conformance pair (artifact-vs-artifact, never against the committed
      baseline — see #4239) shows no non-timeout flips. *(pending: validated by
      the PR's merge_group re-run)*
- [x] Once green, `JS2WASM_FNCTOR_CTOR_PARAM_SLOTS` flips to the family's
      unset-⇒-ON rule and stops being the exception in
      `src/derivation-flags.ts`.

## 2026-08-09 — IMPLEMENTED (branch `issue-4250-write-kind-verdict`, stacked on PR #4255)

### The mechanism, as built

- **Verdict = the #4246 satellite's converged per-field write JOIN, exported in
  TWO views** (`src/ir/fnctor-method-edges.ts`):
  - `computeFnctorGraphFieldVerdicts` — POISON-GUARDED: DYNAMIC wherever any
    cannot-see path exists. The fail-closed side.
  - `computeFnctorGraphFieldWriteJoins` — the poison-FREE raw joins. The
    violation-detection side. **The split is load-bearing and was found by
    measurement, not design**: a poison means "unseen writes may also reach
    this field" — it must never ERASE the enumerated string write that proves
    a violation. acorn has ~20 dictionary-object computed writes
    (`exports[name] = true`, `this.undefinedExports[k] = node`, …); with one
    map, any one of them blanked the very evidence that fixes the repro in
    that whole module.
- **The write enumeration was extended past `this.<f>`** (the issue's "missing
  pieces are scope, not mechanism" list, all three):
  1. Dynamic-key writes and `delete`s on non-`this` receivers, and
     `Object.defineProperty/defineProperties/assign` on instance bindings, are
     now DEFERRED POISONS (`DeferredFieldPoison`), resolved by the #4246
     receiver-provenance pass: receiver ⇒ R poisons R (per-name for a literal
     `defineProperty` key, all fields otherwise); ⇒ ⊤ poisons everything;
     ⇒ ⊥ (null/undefined/builtin instance/object-or-array LITERAL/primitive)
     poisons nothing. The provenance pass and the poisons alternate to a
     fixpoint (each only widens the other — monotone); an UNCONVERGED
     provenance run applies every deferred poison at worst-case severity
     rather than dropping it (a dropped poison reads as a clean field —
     optimism in the forbidden direction).
  2. Named binding writes were ALREADY enumerated (the all-bucket) — the
     issue's "instance-binding writes are invisible" diagnosis was true of the
     CONSUMERS, not the enumeration: the slot arms keyed off the carrier's
     fact (`pos`) and never consulted the written field's own join (`mark`).
  3. Exported, name-keyed like `paramFacts` (unique callable names only).
- **Three consumers**:
  1. `inferFnctorFieldTypeFromCtorParam` — fail-closed gate ahead of every
     arm: no narrowing unless the GUARDED verdict is f64-class. Absent owner,
     absent field, merely-unproven write ⇒ NO.
  2. `deriveFnctorFields`' literal arm — proven-violation veto
     (`fnctorFieldNumericWriteViolation`, raw joins): a checker-typed f64/i32
     slot demotes to externref when an enumerated write stores a kind the slot
     cannot hold (string/object/bool for f64; non-bool for the bool-branded
     i32).
  3. `typeof` const-folds (`typeofFoldContradictedByFieldVerdict`, raw joins),
     both fold sites in `typeof-delete.ts` — see the two-defect finding below.
- **Flags** (`src/derivation-flags.ts`): `JS2WASM_FIELD_WRITE_VERDICT` (token
  rule, unset ⇒ ON) gates roles 2–3 and DOMINATES the slot lever —
  `fnctorCtorParamSlotsEnabled()` is now `verdict && tokenRule(SLOTS)`, so the
  unsound lever-without-verdict combination is unreachable by one stray env
  line. SLOTS itself joins the family's unset-⇒-ON rule (the acceptance flip).

### Finding: the repro was TWO defects, not one

The issue diagnosed "the string write is lost by the f64 slot". Measured: with
the slot correctly demoted to externref, the repro STILL answered 0 — the
value round-trips (`a.tag === "s"` answers 1) but `typeof a.tag` was
**const-folded to "number" from the checker's type**, which types the property
from the constructor's write alone (`staticTypeofForType`). Both halves ship
here; the typeof guard joins the existing unsound-fold guard family
(#4204/#2623/#2992) and fires only on a PROVEN contradiction.

### Recorded asymmetry (deliberate, per-role)

- The LEVER gate is fail-closed: a merely-unproven write blocks narrowing
  (pinned: an unproven binding write keeps the slot boxed and the dynamic
  value round-trips).
- The LITERAL arm's veto and the typeof guard are violation-only: an unproven
  write does NOT demote a long-shipped checker-typed slot or kill a
  long-shipped fold. Fail-closed there would mass-demote working programs for
  no observed defect; the residual exposure is exactly main's pre-#4250
  exposure, now strictly reduced. (Pinned by a test documenting the NaN
  coercion on the unproven path.)

### Measurements (acorn 8.16.0, standalone `-O3`, census env `JS2WASM_FNCTOR_FIELD_PROVENANCE=1 JS2WASM_FNCTOR_CTOR_PARAM_TYPES=1`)

- **Census 52 typed / 1 discarded / 43 unknown, binary 1,046,104 B — IDENTICAL
  to the #4255 base branch, all 96 rows compared** (file-copy A/B in one
  worktree). Canaries 2,3,4,5; imports `[]`; exactly the 3 pre-existing parity
  IR-FALLBACKs.
- **The lever recovers 0 acorn slots under the verdict**, because acorn trips
  the global cannot-see poison: irreducible ⊤-provenance computed writes
  remain (`exports[name] = …` through dictionary-valued params;
  `this.context[…]` whose write chain bottoms in a method call). The ⊥ rules
  for object/array/primitive literals and builtin instances retire several
  sites but not all, and one is enough. This is honest fail-closure, not a
  bug: on acorn the lever was already measured at ZERO value-level effect
  (#4246: `$AnyValue` allocations identical), so nothing of measured value is
  forgone. The flag still flips per the family's "derive always; do not read
  the default as evidence of a win" doctrine — it is now merely SOUND as well
  as inert on this corpus.
- All four filed arms answer 1: literal/default, param/default,
  param+SLOTS, field-fact+SLOTS. `JS2WASM_FIELD_WRITE_VERDICT=0` restores the
  pre-#4250 wrong answer (pinned — the kill switch is real).

### Tests

`tests/issue-4250-write-kind-verdict.test.ts` (23): the four arms E2E + bool
violation + the raw-join-under-poison survival case; verdict unit surface for
every poison class WITH positive controls (in-module helper flow, pinned-
receiver computed write poisons ONLY that owner, ⊤-receiver poisons all,
builtin-receiver poisons nothing, delete, defineProperty per-key,
Object.assign per-owner); the fail-closed/violation-only asymmetry pair; the
kill switch. `tests/issue-743-derivation-defaults.test.ts` re-pinned for the
SLOTS flip + verdict dominance.

Known pre-existing on the base branch (NOT this slice; reproduced on untouched
`166635930`): `issue-3683-numeric-fields` "excludes presence-tracked" and
"reflection arms" — fixed by #4255's own final test commit (green after
merging post-#4255 `upstream/main` in). Still-red INDEPENDENT of this slice:
`issue-2107` "undefined-any reports typeof 'undefined'" (standalone + wasi) —
red on pure `upstream/main` @ `4e90526dd` in a clean worktree AND on the
#4255 branch with all nine of this slice's files reverted (file-copy A/B), so
it is main's, possibly #4255-flip fallout; flagged to the coordinator.

## Notes

- Do NOT "fix" this by requiring `numericPropertyNames` before narrowing. That
  makes the #743 lever a strict subset of S4a — every slot it could then move,
  S4a already moves — which is the same as deleting it.
- The value case for the lever is currently **unproven**: #4246 measured zero
  allocation movement and +124 B for the slots it recovers. This issue is worth
  doing for the CORRECTNESS half (it also fixes main's existing defect); the
  performance half should be re-measured, not assumed.
