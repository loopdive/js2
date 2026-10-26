# Physical snapshot review boundary

Base: `61b1b07d2b5666b6ebb84fbbe93ee8a07655d090` (upstream main).

Review production `src/wasm/physical/data-snapshot.ts` and its only consumer,
`src/wasm/physical/module-reservations.ts`. The extraction preserves the existing
filled-function traversal, including eager Set construction, sibling capture
before child descent, and complete child visitation after a mismatch. All other
ledger domains retain the exact pinned textual algorithm. No audit is removed.

Run the checked-in regression selection from the repository root:

```sh
node node_modules/vitest/vitest.mjs run --config plan/log/3527-physical-snapshot-review-20261026/vitest.review.config.mjs
node node_modules/typescript7/lib/tsc.js --noEmit -p tsconfig.ts7.json
```

The baseline and final candidate both have 315 passes and one failure out of
316: the unrelated declaration-hash pin in the unchanged module-records file.
The six intrinsic mutation controls pass on both. Three default compiler samples
(arithmetic, strings, closure/object) have identical binaries and WAT in both
arms; this is bounded compatibility evidence, not full IR runtime qualification.

## Rejected broadening

`rejected-broadening.patch` extends structural matching to descriptor, type,
global, publication and recgroup records. It is evidence, not an adopted patch.
To reproduce in a disposable checkout of this branch, apply that patch and run
`tests/issue-3527-snapshot-intrinsic-observations.test.ts`: all six controls fail.
Restore the checkout afterwards. The committed controls and raw failure log show
that live getters replacing map, freeze, stringify, toString, padStart or join
change the accepted/rejected result. No scope exemption has been granted.

C review question: what explicit ownership/capture boundary can make recursive
validation cheaper while retaining detection of transient mutation/restoration?
Caching successful checks or removing intermediate observations is not justified
by the final closing audit. This branch provides the physical boundary and its
counterexamples; it does not contain the complete uncommitted recursive-owner
integration graph or claim to resolve its timeout failures.
