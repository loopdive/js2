# Independent IR pipeline strategy spike — experimental HOLD

## Decision and scope

This is a bounded experiment requested by the user, not approval to rewrite the
compiler or retire direct code generation. Reuse the migrated IR components to
attempt the unchanged standalone async example without legacy compilation.
Preserve every existing branch, fixture, guard and original failure. Continue the
existing array/Promise blocker fixes; do not start unrelated migration slices.

The experiment began 2026-09-15 at 01:01:21 UTC, with a coordinator-selected
45-minute ceiling ending 01:46:21 UTC. Investigation stopped at 01:25:57 UTC:
**24 minutes 36 seconds elapsed**, including parallel review and test runs, not
a sum of worker CPU time. Remaining work is publication/hooks, not more spike
implementation. No production source was changed.

## Pinned reference and reproducible drivers

- Repository: `loopdive/js2`.
- Base for both drivers: `c3f80a8b6cf9a25a617c9af101047a91c4301264`.
- Branch: `codex/ir-independent-spike-20260915`.
- Fixture: `website/playground/examples/js/async.ts`, unchanged.
- SHA-256: `6bc4fc96cc65881c9919a39b840afaf1001dfd3d0e05ef0cc141441a051f7915`.
- Candidate: `tests/issue-3518-independent-pipeline-spike.test.ts`.
- Separate legacy process: `tests/issue-3518-independent-spike-legacy-reference.test.ts`.

Each driver is run with Node/Vitest, one fork, a 2048 MB worker ceiling and no file
parallelism. Run each file separately, not as a shared process with legacy spies.

```sh
VITEST_MAX_FORKS=1 VITEST_FORK_MAX_OLD_SPACE_SIZE=2048 node node_modules/vitest/vitest.mjs run tests/issue-3518-independent-pipeline-spike.test.ts --pool=forks --poolOptions.forks.singleFork=true --no-file-parallelism --reporter=verbose
VITEST_MAX_FORKS=1 VITEST_FORK_MAX_OLD_SPACE_SIZE=2048 node node_modules/vitest/vitest.mjs run tests/issue-3518-independent-spike-legacy-reference.test.ts --pool=forks --poolOptions.forks.singleFork=true --no-file-parallelism --reporter=verbose
```

Candidate target/backend: `standalone`/`wasmgc`; native string constants and
concatenation; full native delay/async-family projection for the exact async
fixture. Shared exception tag, UTF-8 storage, source maps, ownership, escape,
intermediate-allocation verification and naive-dominance verification are false.
Normal final prepared-program validation and acceptance validation remain active.
Number formatting selects `integerBeforeScratch: true` and builds the genuine
canonical radix formatter body. No support body is omitted or fabricated.

The four async axes are GVN off/on crossed with direct/codec-round-tripped
prepared data. These are **not O0/O2**: other middle-end passes still run with GVN
off. The scalar control does not request async-only projections.

Legacy options retain `experimentalIR: false`, `target: standalone`, `emitWat:
true`, fallback/outcome tracking and the exact fixture filename. No semantic
diagnostics are suppressed. These are distinct compiler configurations, not a
claim of byte equality between pipelines.

## Observations and original failures

1. Initial scalar attempt incorrectly enabled the full async-family projection.
   Source preparation rejected it with `native async family: full-family
   projection requires a certified delay owner`. This is a driver configuration
   failure, not evidence that scalar IR emission is impossible. Only the scalar
   driver's projection request was corrected; the async request remains intact.
   The initial process's full terminal output was not retained by the tool after
   context truncation, so no initial aggregate pass count is claimed.
2. Corrected scalar control prepared one unit/function and three ABI entries,
   emitted a 61-byte valid Wasm module and actually returned `42`. No measured
   legacy entrypoint was called. This is one scalar program, not async coverage.
3. All four async axes prepared 5 units, 16 functions, 32 ABI entries, 29
   allocations and one genuine formatter support batch. All four stopped at
   `body-shape-rejected`, stage `build`, with the same 18-gap physical-setup
   rejection, located at `fetchUser`, line 17, column 1, source range 676–844.
   They did not emit, instantiate or execute the async program.
4. The corrected first run reported 5/5 test assertions passing but terminated
   **exit 1** with `[vitest-worker]: Timeout calling "onTaskUpdate"`. This is a
   failed test process, not a green receipt. A subsequent run captures output to
   a worktree-local log; the original reporting failure is not erased or waived.
5. The initial separate legacy compile succeeded, emitted 163560 bytes, passed
   engine validation, and reported no IR outcomes. Its retained warning says
   `env.__timer_set_timeout` survives the standalone target. That function was
   the sole actual module import. Compilation alone is not execution credit.
6. The strengthened candidate rerun also had 5/5 assertions pass but terminated
   exit 1 with the same worker reporting timeout (98.79 seconds). File capture
   did not resolve it. A subsequent driver run yields the event loop between
   long synchronous cases without changing any compiler checks or runner error
   policy. Neither prior failed run is retroactively counted as green.
7. **The legacy reference fails execution under this driver.** The unchanged
   binary, bound using production `buildCompiledImports`, a controlled queued
   timer provider and `imports.setInstance`, calls raw zero-argument `main()`.
   A fresh raw/wrapped entry control also reproduces the trap (below). It registers ten 30 ms timers
   before any callback fires, then traps in `__async_resume_fmain` with
   `RuntimeError: dereferencing a null pointer`. No Promise returns; final state
   and value are unavailable. Actual exports omit stdout readers, so output is
   unobserved, not empty or verified. The separate run is **0/1 passing, exit
   1**. The [throwing driver](3518-independent-spike-legacy-execution-driver-2026-09-15.txt)
   is retained as text, not converted into conformance credit. This retained
   copy adds the reviewed compile-success assertion so future compile failures
   cannot silently pass without reaching execution; the runtime throw is intact.
   The compile-only predecessor was 1/1 passing. No baseline repair is attempted
   during this spike; this failure must survive into any later three-arm plan.

The exact 18-gap text and complete located rejection are pinned in the candidate
test. It comprises unsupported async frames; two non-scalar result carriers;
two missing native runtime callable materializations and three unresolved calls
to them; four unresolved clock calls; and six missing native Promise inventory
and producer/association/dispatch/construction/composition proofs. Eighteen is
the diagnostic count, **not eighteen independent implementation tasks**.

## Reuse and missing work

The independent route already exists:
`analyzeMultiSource` → `prepareIrProgramSources` → genuine formatter preparation
→ `captureTypedIrProgramInput` → `prepareTypedIrProgram` →
`acceptPreparedIrProgram` → `emitAcceptedIrProgram` → `emitBinary` → engine.
The scalar control reaches its end. The unchanged async fixture reaches the real
backend acceptance boundary through this same route.

The formatter's frontend builder lowers the canonical self-hosted source to IR
with the source allocation owner and real callee contracts. It does not require
creating a legacy CodegenContext. Replacing or dropping it would weaken this
experiment, not make the pipeline more independent.

The missing native runtime producer/materialization work is real. A wrapper or
new entrypoint cannot supply frame, Promise, vector, closure invocation, property
dispatch and construction authority. Existing migrated components are reusable;
calling the old compiler underneath them is not an independent implementation.

Legacy state to audit before reusing more components includes module/type/import/
global mutation; function handles, saved bodies and late index shifts; vector and
closure/capture registries; Promise/scheduler caches; object/accessor/undefined/
string owners; prescan demand flags; and ABI session/finalization scope. This is
an audit list, not a claim that all those dependencies have been removed.

## Measurement limits

Rawls independently compiled the same source/options once, then used the same
163560-byte `result.binary` for two fresh instances and fresh production import
adapters: raw `instance.exports.main` and
`wrapCompiledExports(result, instance).main`. Actual metadata was
`mainSignature: {params: [], result: "promise"}` and
`mainBoundary: {params: [], result: {kind: "promise", policy: "opaque-handle"}}`.
Both modes registered exactly ten 30 ms timers, fired none, returned no value
and trapped with `RuntimeError: dereferencing a null pointer` in
`__async_resume_fmain`, Wasm function 329 at `0x23654`, called by `main`, function
69 at `0xf104`. The wrapped stack additionally names `runtime.ts:19411`.
Source inspection confirms the wrapper calls the raw function before return
Promise conversion. This rules out a missing entry wrapper, not all possible
harness defects or the underlying compiler root cause.

That read-only Node/tsx diagnostic caught and printed both exceptions and exited
0: **not execution success**. Provenance: Rawls tool session `36585`, output
chunk `1d715a`. Its stdout did not print the source hash; the hash comes from the
separate fixture check and retained Vitest log, not invented diagnostic output.

Twelve configured legacy export spies are positively exercised before measuring
zero calls. They cover compiler entrypoints, legacy generation/context creation,
integration and legacy self-hosted emission. They do **not** prove absence of
import-time work or same-module lexical bypass. Source review complements these
traps; the result is not proof of static whole-graph closure. Existing strict
closure failures and direct-codegen retirement blockers remain in force.

The async tests explicitly expect the exact current rejection. Green diagnostic
tests are not green async execution. A change in acceptance must cause the
experiment to be reconsidered and the accepted program executed/compared, not
silently change the expected outcome. No fixture subset replaces the example.

## Legacy development while IR progresses

Pin the comparison revision and fixture corpus, not all legacy development.
Legacy bug fixes may continue. Shared parser, checker, runtime and interface
changes need one named owner and checks against both pipelines. Record each new
legacy behavior with its regression fixture and IR adoption state. Advance the
comparison revision only after reviewing those changes and replaying the same
corpus. Major new features need an explicit IR adoption plan.

Preserve the separately approved three-arm acceptance discipline: original
baseline with original failures; narrowly repaired baseline with reviewed repair
diff; candidate compared exactly against that repaired baseline. This spike
makes no baseline repair and cannot claim that comparison passed because its
async candidate does not execute.

## Recommendation — no wholesale rewrite or default switch

Reuse and incrementally complete the existing independent route; do not launch
a wholesale rewrite or switch the default compiler on this evidence. The route
is viable for a measured scalar control, but it does not yet run the unchanged
async example. Complete genuine runtime producer/materialization contracts next
only under a reviewed implementation plan, retaining all existing guards.

Publish this experiment as a non-draft **HOLD / do-not-merge** PR for review. Do
not auto-enqueue it or count it as migration delivery. The parent integration
owner continues shepherding existing PRs through the protected queue.

## Final receipt

The yielding candidate run completed **exit 0, 5/5 assertions, 86.07 seconds**,
without unhandled errors. All four measured axes have identical exact source
unit and function-owner/name pairs, retained in
[the identity receipt](3518-independent-spike-identities-2026-09-15.json).
These identities are now asserted; their [final assertion rerun](3518-independent-spike-candidate-final-2026-09-15.txt)
completed **exit 0, 5/5, 90.30 seconds**. The
[strengthened failed run](3518-independent-spike-candidate-timeout-2026-09-15.txt)
is also retained.
TypeScript 7 completed exit 0. The two earlier reporting-error runs remain failed;
event-loop starvation is a hypothesis, not a proven root cause.

Separate baseline execution completed **exit 1, 0/1 passing**. Its
[unaltered failure log](3518-independent-spike-legacy-failure-2026-09-15.txt)
is retained along with the failing driver. The raw/wrapped entry control above
completed. No successful async runtime
comparison has been produced.

For executable regression recording, the new experimental legacy test is an
**exact-negative diagnostic**: setup and compilation must succeed; only the call
to `main` is caught; its exact RuntimeError/message/async-resume stack plus ten
ordered 30 ms registrations, no timer firing and no successful return are
required. A different error or successful return fails. Independent High review
accepted this distinction. This changes no pre-existing test or fixture and
repairs no compiler behavior. A passing diagnostic is never baseline conformance.
The original 0/1 execution log and throwing driver remain available separately.
The final exact-negative legacy diagnostic completed **exit 0, 1/1, 11.21
seconds**. This does not replace or reverse the 0/1 execution failure above.
Scoped Biome lint and TypeScript 7 passed. An initial ESLint invocation failed
because this repository has no ESLint configuration; the repository's actual
lint tool is Biome. No configuration or gate was changed.
