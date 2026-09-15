---
id: 5401
title: "Reject unsupported enumeration and deletion carrier flows"
status: in-progress
sprint: current
created: 2026-09-08
updated: 2026-09-08
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: correctness
parent: 5393
assignee: "ttraenkler/codex-enumeration-safety"
---

## Measured failures

The 168-case JavaScript audit records host deletion of fixed numeric object
fields retaining keys and returning NaN, numeric array deletion retaining
presence, and for-in over Object.create receivers producing no keys.
Standalone object spread changes Object.keys insertion order; collecting
for-in keys into an initially empty array and then sorting produces invalid
Wasm. The same key collection without sorting executes correctly, as does
sorting a prefilled string array.

Add source-located compile errors for these unsupported carrier flows,
preserving measured host spread, standalone deletion, plain host for-in,
and ordinary Object.keys controls. No blanket delete/enumeration ban.

## Implementation and validation

`collectUnsafeEnumeration` returns `JS2WASM_UNSOUND_ENUMERATION` findings at
the unsupported operation; the shared semantic pass applies them to compile
and compileMulti regardless of TypeScript diagnostic suppression. It follows
transparent wrappers and identifier aliases by symbol and declines literal
origin claims after rebinding. Builtin Object claims are declined in files
that bind a local Object.

Host guards cover deletion of present fixed numeric object fields/numeric
array elements and for-in over Object.create with a known nonempty object
prototype. Standalone guards cover Object.keys after spreading a multi-key
literal and sorting the same initially empty array into which for-in keys
were collected. Other object/array carrier forms remain outside this narrow
detector's proof; absence of a finding is not a general soundness guarantee.

Focused tests cover all six measured sources, source locations, opposite
target controls, aliases, rebinding, shadowing, and executed standalone
controls: 19/19 pass, including compileMulti. Adjacent semantic/lookup tests:
30/30 pass. TypeScript, function
budget, LOC budget, and coercion gates pass without baseline changes.

An initial focused run exhausted its worker heap while formatting a failed
assertion containing cyclic TypeScript AST nodes. The shadowed Object case
was then fixed and assertions now compare diagnostic messages; that aborted
run is not counted as a successful validation.

## Generic carrier correction

The full equivalence shard exposed a false refusal for `var obj:any={x:5}`:
its actual any-typed receiver uses the generic property carrier, whose
deletion tombstone correctly makes hasOwnProperty false. Numeric initializer
provenance alone does not establish a fixed carrier. The deletion guard now
excludes any-typed receivers using the checker type at the operation, with
executed direct and alias controls returning 10. Unannotated JavaScript
failure specimens remain refused.

Correction validation: 21 focused tests and all three active issue-1334
equivalence tests pass (one existing todo); TypeScript and diff checks pass.

## Observation-specific correction

The full equivalence shard also demonstrates that fixed-carrier deletion
results and numeric sentinel comparisons already work. The guard therefore
requires a measured unsupported observation after deletion: Object.keys on
the same object, membership of the deleted numeric array index, or a raw
deleted-property/typeof read passed to console (including value aliases
created after deletion). Boolean delete results, unrelated property reads,
undefined comparisons, and values captured before deletion are preserved.
This remains a narrow detector; unexamined consumers are not certified.

Combined validation: 25/25 focused tests, all three active issue-1334 tests,
all four delete-operator tests, and six of seven delete-sentinel tests pass.
The sole failure remains the known string-property sentinel mismatch (null
instead of `deleted`); there are no diagnostic refusals in those equivalence
files. One preexisting todo remains. TypeScript, diff, and function-budget
checks pass. The handoff combines both corrections atop the original patch.

## Execution-scope and restoration correction

Review found two further false positives: an unused nested function deleting
a global object before a textually later outer read, and a direct property
reassignment restoring the value before a raw read. Deletion observations
now stay within the same function execution scope. An unconditional direct
assignment to the same receiver/key in the same statement list suppresses
later raw-read or array-membership evidence. Conditional writes, writes to
other keys, and values captured before restoration do not suppress evidence.
Object.keys remains evidence because delete/reinsert can still change key
order even when the property's value has been restored.

The two reported programs are executed as host controls, expecting 2 and 1.
Additional positive diagnostics verify source locations for same-function
reads, delete/reinsert enumeration, captured deleted values, other-key writes,
and conditional restoration. The final complete audit verifies this integrated
correction; no code generation changes follow the full equivalence gates.

Combined validation: 45 passing tests, one unchanged string-deletion sentinel
failure, and one existing todo across the focused test and three deletion
equivalence files. TypeScript, diff, and function-budget checks pass.
