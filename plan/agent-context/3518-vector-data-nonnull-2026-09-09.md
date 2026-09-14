# Vector constructor scratch nullability repair

Isolated worktree: /private/tmp/js2-3518-vector-data-nonnull-20260909.
Branch: codex/3518-vector-data-nonnull-20260909.
Exact base: 5404151bfc1b49d6cffed4a87a8985c51bd3dd93, the published native
resource declaration checkpoint. Authoritative upstream claim
3518:vector-data-nonnull verified for ttraenkler/codex-vector-data-nonnull;
claim terminal 1103 exited 0. The first sandboxed attempt exited 6 because DNS
was unavailable and wrote nothing. Approved network retry verified the claim.

## Production change

One instruction in WasmGcEmitter.emitVecNewFixed: ref.as_non_null immediately
after reloading the backing-array scratch local and before struct.new. Both
successful branches store a newly allocated array before the reload. Preserve
the nullable/defaultable scratch, non-null carrier data field, allocation order,
ABI, and unsupported nonempty-spare-capacity refusal. No lower.ts, source
admission, producer-original, consumer, baseline, or allowance changes.

The production hunk is independently applicable to the historical
2ccdcffd baseline and composed consumer; no commit has been made yet.

## Regression proof and limits

Dedicated test: tests/issue-3518-vector-construction-nullability.test.ts.
Five AST-to-IR component rows use explicit type overrides and a physical-fixture
resolver through analyzeSource -> lowerFunctionAstToIr ->
lowerIrFunctionToWasm -> WasmGcEmitter -> emitted binary validation and execution:
numeric and externref populated/empty fixed arrays, plus numeric counted-push
source whose empty constructor reserves spare capacity. The latter returns
after filling its three reserved slots; its constructor IR retains length zero.

The sixth construction case is explicitly IR-lowerer-only: externref empty
spare capacity. The current counted-push source proof admits numeric/boolean
values, not externref values. This case uses the canonical IR builder and real
lowerer, not a patched positive instruction stream. High approved the exact
production/test diff and this bounded proof split: five AST-to-IR component
rows with explicit type overrides/physical-fixture resolver, one IR-builder
row, and one refusal control. This is not whole-source admission or full
consumer execution. Parent owns the separate three-arm whole-consumer comparison.

Read-only Wasm probes inspect returned length, capacity and elements, including
3e9 numeric transport and externref identity/default nulls. Every positive
binary is validated and executed without a body patch. Only an isolated cloned
countermodel removes exactly one reload refinement; validation and compilation
must then reject it. A seventh test retains the unsupported capacity refusal.

## Validation receipts

- 72033: exit 0, initial six construction cases, 6/6, 10.59 seconds.
- 35986: exit 0, full unfiltered TS7 on this isolated tree.
- 20787: exit 0, 31/31 across the final seven-case suite plus existing
  ir-vec-new-fixed and ir-vec-two-backend suites, 15.70 seconds.

All validation is serialized. NODE_OPTIONS=--max-old-space-size=2048,
VITEST_FORK_MAX_OLD_SPACE_SIZE=2048, GOMEMLIMIT=2GiB, GOMAXPROCS=1;
Vitest uses --pool=forks --poolOptions.forks.singleFork=true
--no-file-parallelism. Existing node_modules is linked, not installed.
High final diff review approved emitter caba0379 and test 4f51e96a. Parent
authorized normal commit/push and a non-draft held PR stacked on the native
resource declaration checkpoint. Hook/publication results follow separately.
