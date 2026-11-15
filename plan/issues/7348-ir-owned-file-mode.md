---
id: 7348
title: "IR-owned files: when the IR lowers every unit of a file, it owns the file's storage and calling conventions"
status: ready
sprint: current
created: 2026-11-15
updated: 2026-11-15
priority: high
horizon: xl
feasibility: hard
reasoning_effort: high
task_type: implementation
area: ir
goal: ir-full-coverage
depends_on: []
related: [7346, 7347, 7338, 7106, 2855]
---

# #7348 — IR-owned files

## Problem

Program goal: every ES5 test262 file compiles on `--target standalone` with
zero legacy units ("IR-only").

Today the IR and the legacy compiler share one module, unit by unit. So every
IR unit must agree with legacy on anything another unit could touch:

- the Wasm type of each module variable's slot
  (`vardecl-module-storage-unrepresentable`, `expr-module-extern-consumer`,
  `forin-receiver-not-dynamic-externref`, …);
- how a function value is stored and called (`vardecl-let-closure`,
  `expr-local-call-target`, `expr-new-module-binding-callee`,
  `closure-return-type`);
- parameter carriers (`param-dynamic-carrier-diverges-from-legacy`).

These refusals do not say "the IR cannot lower this". They say "the IR would
store it differently from legacy". In a file where the IR lowers **every**
unit, there is no legacy unit to agree with, and the refusals have no reason
to exist. But that is exactly the state the goal wants for every file, and the
agreement rules are what keep most files from reaching it.

Project-lead decision of 2026-11-15 (`CLAUDE.md`, "IR migration: foundations
first"): build the mechanisms many files need, and do not over-orient on the
legacy compiler where a different IR representation is faster to build or
better.

## Measured

From the raw rows of the 2026-11-14 census (main `8e2a65b374`, 8,591 ES5 files
compile, 6,990 blocked), re-derived 2026-11-15 by label text. The selector
records only the first refusal per statement, so these are upper bounds, not
compile results.

| measure | files |
| --- | --- |
| blocked files | 6,990 |
| carry at least one storage or calling-convention agreement label | 4,439 |
| carry only such labels | 842 |

The label set used: `module-storage-unrepresentable`,
`expr-module-extern-consumer`, `vardecl-let-closure`,
`expr-local-call-target`, `expr-new-module-binding-callee`,
`forin-receiver-not-dynamic-externref`, `forin-head-module-var`,
`expr-module-extern-call-brand`, `compound-dynamic-module-operand`,
`vardecl-module-value-flow`, `module-binding-alias`,
`module-assign-incompatible`, `vardecl-var-kind`, `closure-return-type`,
`expr-call-callee-nonident`, `call-graph-closure`, `vardecl-noinit`,
`module-scalar-method`.

For comparison, the narrow slices of 2026-11-11 to 2026-11-15 freed 2 to 55
files each.

## Implementation Plan

### Target structure

- **One decision per file: mixed or IR-owned.** Selection runs first under the
  IR-owned rules. If every unit of the file is claimed, the file is compiled
  IR-owned. Otherwise selection runs again under today's mixed rules, and the
  file compiles exactly as on main. There is no third state, and no unit is
  claimed and then withdrawn: the mode is decided before any lowering.
- **IR-owned rules live in one place.** A single "storage authority" value
  passed to the selector and to from-ast answers what a module variable's
  slot is, how a function value is represented, and what a parameter's
  carrier is. In mixed mode it is today's legacy-backed resolver
  (`resolveModuleBindingGlobal`, the closure plans). In IR-owned mode it is a
  new IR authority. The agreement refusals ask the authority; they are not
  each given an `if (irOwned)` branch.
- **The IR authority's first representation is the simplest sound one.**
  Every module variable is a dynamic-carrier slot unless its value kind is
  proven scalar; every function value is one closure representation the IR
  already lowers; a call through a variable is one indirect-call path.
  Performance refinements (typed slots, direct calls) are later issues. This
  is deliberately not a copy of legacy's home table.
- **What it reuses.** The dynamic carrier and its runtime, the planned-closure
  lowering, module-init lowering, the identity inventory of units.
- **What duplicate it removes, over time.** Each agreement refusal becomes
  dead in IR-owned mode. As files move, the per-home modules
  (`module-binding-vec.ts`, `module-binding-class-instance.ts`, the script-var
  closure site, `fnctor` parity probes) lose callers and are deleted in
  follow-up issues. This issue adds no new per-home module.

### Step 0: measure with a prototype, before any design is fixed

Build a throwaway switch (an environment variable, not shipped) that makes
the selector answer every agreement label in the list above as "admitted",
and run the 6,990 blocked files plus 300 IR-only control files. Report:

1. files where selection now claims every unit (the real ceiling of this
   issue);
2. for those files, what from-ast then fails on, grouped (this is the work
   list, in order of size);
3. for the files still blocked, the first remaining label, grouped (what
   this issue does not reach).

The prototype is not merged. Its numbers replace the table above.

### Slices (to be cut after Step 0, by yield)

- **S1: the mode decision and the authority seam**, with the IR authority
  answering exactly as the legacy-backed one. No file changes route; this is
  the refactor that makes the rest possible. JS-environment and standalone
  output byte-identical on the whole equivalence suite.
- **S2: module variables.** In an IR-owned file, a module variable's slot is
  the IR's. Object and array literals, strings and call results stored in
  script variables stop being refused for their slot type.
- **S3: function values.** `var f = function…`, calls through a variable,
  function-valued properties, IIFEs, callbacks. One closure representation.
- **S4: constructors through variables** (`new f()` on a script variable).

Each slice states its measured yield from Step 0's work list before it
starts.

### Constraints

- Standalone only. The JS environment keeps mixed mode; its output stays
  byte-identical.
- A file that is not fully claimed compiles exactly as on main: byte-identical
  standalone output for every file that stays mixed.
- No test verdict may regress. A file that turns IR-owned must pass if it
  passes on main; where legacy answers wrongly and the IR-owned file answers
  as the specification says, that is recorded as a gain, not preserved.
- No new host imports.
- The IR code-quality rule applies: one authority seam, no flag parameter
  threaded through arms, no selector-side copy of from-ast rules.

## Acceptance criteria

Correctness:

1. Step 0 report with the three tables, dated, with the head it ran on.
2. Per slice: census on the blocked files and the control set (gained, lost
   0, units newly legacy 0, new compile errors 0, post-claim errors not
   increased); verdicts of every routing-changed file; standalone bytes
   identical for every file that stays mixed; JS-environment bytes identical.
3. No completed-edition regression in the merge-queue run.

Code quality:

4. The mode is decided once per file, before lowering; no claim-then-withdraw.
5. Agreement refusals ask one authority; no per-refusal mode branch.
6. A fresh-context adversarial review per slice records its verdict in the
   PR body.
