# PR5883 integration and inventory correction

Published head inspected: `3ab3025f6c35e357eef6c06e249659f86ea8aef9`.
The isolated integration tree merges verified loopdive/js2 main
`3acb2c85b9d8a313bbd46f045344d00c4dd317f3` as
`75f454d4885ee6b8908113b81e02baab6aff4ede`.
The active writer and dirty user checkout are untouched.

The actual published quality failure in run34919050585, job104222843935,
is `invalid-inventory`: unclassified module/target
`src/codegen/promise-observable-combinators.ts`. Its published implementation
uses AST/context-driven lowering, native runtime preparation and direct Wasm
instruction construction. A descriptive unmigrated/mixed-needs-split entry
with backend-wasmgc destination corrects the missing classification. No gate,
allowance, activated boundary or implementation body is changed.

Verification against main3ac: inventoryValid=true, graphComplete=false,
errors=[] in `.tmp/5883-inventory-repaired.json`; this is not retirement proof.
Main memoization controls are recorded in `.tmp/5883-main-sync-controls.log`.

The independently reviewed vector Hole/Get/pop repair is being prepared in
the writer tree with portable production regression tests. Original diagnostic
sources, numeric failures and sixteen setter failures remain intact. Do not
copy the writer's incomplete Promise body or treat the vector prerequisite
as acceptance of the full observable-combinator protocol.

Keep PR5883 on hold. Integrate only complete, verified owned commits, rerun
the composed tests and normal gates, and publish to the existing PR. Actual
delivery requires protected-queue merge and verified content on upstream main.
