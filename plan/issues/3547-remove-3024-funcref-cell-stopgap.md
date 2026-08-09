---
id: 3547
title: "codegen: remove the #3024 funcref-cell struct.new stopgap in compileClosureCall (dead after #3534 — producer eliminated + zero-producer probe)"
status: done
sprint: 75
assignee: ttraenkler/fable-3534
created: 2026-07-23
updated: 2026-07-23
completed: 2026-07-23
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: refactor
area: codegen
language_feature: closures
goal: correctness
related: [3024, 3534, 3533]
---

# #3547 — remove the #3024 funcref-cell stopgap (design step 3 of #3534)

## What was removed

`compileClosureCall`'s boxed-capture arm (`src/codegen/expressions/calls-closures.ts`)
carried a #3024 stopgap: when the ref cell's field-0 was a bare `funcref` AND the
lifted self carrier was a single-funcref-field wrapper, rebuild the carrier via
`struct.new` instead of the externref unwrap + guarded cast. This PR removes the
branch and its `isSingleFuncRefWrapperStruct` helper (and the now-unused
`refCellValueType` import).

## Why removal is EVIDENCE-BASED, not optimistic (two halves, both load-bearing)

1. **The one known producer is gone.** #3534's instrumented root cause showed
   funcref-typed "cells" were never real ref cells: the `variables.ts`
   declaration path RETYPED a boxed capture's cell local to the closure STRUCT
   and re-registered that struct as `boxed.refCellTypeIdx` (a closure struct's
   field 0 is `funcref` — hence the "bare funcref cell" the #3024 call site
   observed). #3534/#3505 fixed the retype at the source: the declaration now
   writes THROUGH the cell and never retypes it, so this producer cannot mint
   funcref-cells anymore.
2. **A probe confirms no OTHER producers exist.** "No producers found" alone
   would be weaker — a probe can only show absence on the surfaces it covers.
   Combined with (1), the argument closes: the only mechanism ever observed to
   create the shape is eliminated, and an env-gated probe in
   `getOrRegisterRefCellType` (flag any cell minted over `funcref` or a
   `__closure_*`/`__fn_cap_*`/`__fn_wrap_*`/`closureInfoByTypeIdx` ref) shows
   ZERO hits on the POST-#3505-merge tree (which also includes #3504 and the
   other codegen PRs landed 2026-07-23) across:
   - the 13-case closure corpus (#3534 issue file),
   - 5 dedicated shapes: module-level + function-local mutually-recursive
     consts, nested-fndecl mutual recursion, accessor-transitive capture,
     `var pf = fn-using-forward-const`,
   - the 4 module-reassignment shapes (#3546 probe),
   - all 7 matcher-invoking `Function/prototype/toString` files,
   - the full 80-file `Function/prototype/toString` dir,
   - the 34-file `class/elements/*-literal-names` dir.

   Probe recipe (temporary edit, env-gated `JS2WASM_PROBE_A3`, removed before
   commit): log in `getOrRegisterRefCellType` when `valType.kind === "funcref"`
   or the target type is a registered closure struct / funcref wrapper.

## Post-removal validation (all measured)

- 13-case corpus: **byte-identical** (every sha256 unchanged vs pre-removal).
- `Function/prototype/toString` sweep: identical 23 pass / 57 fail; the single
  `illegal cast` row (`S15.3.4.2_A16.js`, `__module_init` toString.call shape)
  is PRE-EXISTING with an identical signature on the pre-#3534 baseline —
  distinct mechanism, untouched by this family.
- `class/elements/*-literal-names`: identical 30 pass / 4 fail.
- Guard tests `issue-3534-closure-value-representation` (6) +
  `issue-3024-tostring-closure-funcref` (1): green.

## Bookkeeping correction to #3534's notes (recorded here + amended there)

#3534's Test Results overstated the toString-dir trap elimination as "67 → 0";
the accurate figure is **67 → 1**, the 1 being the pre-existing
`S15.3.4.2_A16.js` row above (present with the identical signature in the
pre-fix baseline sweep). The "0" was read from an accidentally head-truncated
sweep capture. Family-attributable elimination: 66 rows.
