# Prepared IR output checkpoint — 2026-10-05

The internal `runPreparedIrPipelinePresentation` entry feeds authentic
whole-program emission into the existing output finalizer. Public routes and
legacy code remain. This is a bounded productive checkpoint under issue 3525,
“IR-only R5: whole-program single- and multi-source Prepared ownership”.

The new ordinary suite passes 44/44, with zero pending/todo or unhandled errors.
Both host backends execute scalar functions, cross-file calls, primitive globals,
automatic initialization and explicit deferred initialization (0 → 1 → 2).
Both actual generated helpers execute. Linear compared artifacts are exact;
WasmGC legacy bookkeeping strings produce an explicit, retained difference in
pool/manifest/helper data. This is not full artifact parity.

Existing prepared-driver and validation suites pass. The six-row finalizer
suite retains two failures. All six rows and full failure text match clean
`650cb1b0a08df7976662c721e0da884b109fbfe0` with only absolute worktree path
replacement. Those failures are not accepted coverage. Initial new-test fixture
and oracle failures remain in the worktree evidence; no existing gate or fixture
was weakened. Full typecheck and repository lint pass; the native dead-export
gate accepts preservation only, with graph closure open and retirement uncertified.

Astra High specified/reviewed the hard contracts. Sol GPT-6.1 Medium writers
implemented separate source and test files in isolated worktrees. Root Codex
GPT-6.1 Sol High owns compiler integration and delivery. Canonical child claims:
`3518:output-finalizer-context-20261004`,
`3525:prepared-presentation-internal-20261004`,
`3525:prepared-presentation-tests-20261004`. Historical claims and work remain.

Integration branch: `codex/3525-prepared-pipeline-presentation-20261004`.
Normal signed checkpoint `75308922465e52880270fb1ec7e231aee61342b4`
completed all 18 normal selected suites: 2,690/2,690 tests passed, with all five
reviewed file contents exact. Independent ordinary 44/44 evidence remains
separate from the hook's inherited ignored-unhandled-error policy.

Dependency PR 6475, “refactor(ir): give linear layout contracts and backend
legality canonical owners”, is delivered as
`7755320d74de1b52eafedbf6cc5cd37d57c6a081`. Fresh canonical main
`27b18d375f0c446fcd5662056a35261db9881f7b` contains the merge and all 31
owned paths exactly. Its 102 merge-group conformance shards, final regression
gate and differential run succeeded. Each retained conformance lane contains
48,735 unique rows with original failures preserved; this is not whole-IR
acceptance. CI was cancelled, with two issue-test jobs cancelled and the
aggregate issue-test job failed; do not call all merge-group CI green.
The cancellation cause is unverified. Local current-root normal hooks separately
completed both affected suites. The presentation checkpoint's protected main
delivery remains pending. All 33 freshly reviewed incoming main paths are
preserved during normal composition. Broader provider/carrier/layout/options/
target coverage remains open.

Issue 6837, “Modular IR analysis and optimization pipeline with measured
performance parity”, remains prepared but unaccepted. Attempt four actually
terminated with driver/worker exit 1, 4/8 reports and 143/240 pairs: the strict
load threshold refused a sample. Preserve all measurements and staged work;
there is no performance acceptance or automatic retry. Compose its preserved
metadata only after the dependency lands and input equivalence is verified.

Retirement remains a later decision requiring the complete IR path to be tested
and equal. The dirty primary worktree, old worktrees, unrelated fixes and
original failures must remain intact.


### Existing PR6481 compiler-inventory correction

The exact quality failure is preserved and is corrected by one truthful unmigrated compiler inventory row. Native inventory1825/modules, source types, layering, cycles, budgets and oracle pass on the prepared correction; graph/architecture completeness remains false. Newfixedreceipt dd0273b, helperfreeze49101c,14-readerfreeze8d949 and numericmanifest a42e073b compose byte-exact reciprocal proofs without changing the reviewed compiler algorithm or legacy routes. Strict ordinary isolated tests and normal17-file commit hook are the next concrete gates; no runtime success or merge is claimed in this pre-execution entry. Boolean71ecd and old6837 private drafts remain intact.


The additional strict14-test typing profile exited1 with41 existing-body diagnostics. Authentic git archive5a under the identical profile reproduces every message/code/column/order, with only the reviewed inserted source-line mapping; both failures and complete attribution3a02d8 are preserved. Native production typecheck and new helper/test focused typing exit0. No casts, exclusions or old-body repairs were added. Astra final static review80a8fb4f independently authenticates the entire helper prefix, all10 historical Git originals, exact5 C1 changes and unique external binding; it approves ordinary runtime, not publication or retirement. Separate ordinary14-reader2301 and new45-control executors were launched once in regular private worktrees on exact a42e073b. Results remain pending in this pre-hook record.
