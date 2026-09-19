# Compiler checkpoint: current-main composition

Published PR5753 head before this composition: `ed60d22a8a0281ead6ef858562d27f2c62854632`.
Verified upstream main: `4a6cbdf1ee80b5d1618a7c87b014bc792f0fddc7`.
The isolated tree is `/private/tmp/js2-5753-published-composition-20260915`.
The dirty root and all incomplete September 15 writer trees are preserved.

## Reviewed merge decisions

- Function prototype publication uses main's single `call`/`apply`/`bind`
  implementation, including its linked-provider callable handling. Remove the
  duplicate old import and early `call` arm; preserve the PR's hasOwnProperty
  implementation. Call and bind are variadic; apply remains fixed-arity.
- Nullish comparisons preserve main's inert `void` recognition and the PR's
  type-checked shadowed `undefined` handling. Transparent wrappers must not
  bypass the identifier check. Add tests for wrappers on both comparison sides
  in gc and standalone without changing existing fixtures.
- Callback parameter lowering applies main's nullable element correction,
  then the PR's optional parameter preservation and erased collection ABI.
- Receiver dispatch imports both constructor-kind and runtime constructor
  identity helpers, preserving their distinct call sites.
- Typecheck exposed a second, unmarked duplicate allocLocal import in
  object-get-prototype-of; remove only that redundant import.

The read-only integration review identified these decisions before mutation;
no unpublished capture, generator, class-static, or Error/Proxy fix is imported.
The old function-proto-call helper remains unused, not retired by this merge.

## Verification record

TypeScript7 passes after the duplicate-import correction. Initial typecheck
failure remains in `.tmp/5753-sep19-merge-typecheck.log`; successful repeat is
`.tmp/5753-sep19-merge-typecheck-second.log`.
Pre-commit LOC/function checks pass, but their in-progress-merge comparison base
still includes upstream changes; normal post-commit gates must recheck the
actual PR delta. No allowance or gate changes were made.

The first 15-file focused run terminated with JavaScript heap exhaustion at the
configured 512 MB worker limit. Its results are incomplete, not a pass, and
remain in `.tmp/5753-sep19-merge-controls.log`. Only after terminal exit was
confirmed, the identical selection was started with one worker and the existing
VITEST_FORK_MAX_OLD_SPACE_SIZE=2048 option. No running test was killed and no
test expectation changed. Results belong in
`.tmp/5753-sep19-merge-controls-2gb.log`: all 15 selected files and 77 checks
pass, with no unhandled errors. The inherited effectful-void residual assertion
records a known wrong comparison result and is preservation, not conformance.

The staged whole-merge whitespace check also reports two pre-existing upstream
documentation whitespace findings (issues6486 and6492). Those upstream files
were not rewritten as incidental cleanup.

## Preserved blockers and handoff

Keep the PR held. Previous complete merge-group conformance regressions are not
cleared by a source-level merge check. The separate unpublished capture candidate
has 31/34 expanded controls and 58/62 original controls plus an RPC timeout;
those are failures, not acceptance. Do not merge that candidate indiscriminately.
The full class-static ownership, generator receiver and capture lifetime work
still requires current-main reconciliation and original-fixture evidence.

PR5883 independently published `fa671bf12cb65d778233211d6c5b35fb72bf843e`
with current main and inventory correction: 13 observable-Promise +5 memoization
controls and normal pre-push gates passed. It remains held, not delivered on main.
Its incomplete Promise setter work is not part of that checkpoint.

PR5748's recovered local P0 lifetime/finalization extraction is unpublished.
Its historical negative tests are 8/10 (two forged-view failures), runtime is
74 lines over budget, and WAT comparison failed before comparison. Main has
deleted several of its touched owners. Do not transplant the old patch wholesale.
Neither these checkpoints nor their inventories prove end-to-end IR execution
or direct-codegen retirement.
