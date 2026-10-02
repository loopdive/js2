# Method-dispatch physical comparison: implementation and dispatch

Parent-authored plan for issue3518 and held PR5753. This is a bounded
preservation diagnostic, not a new compiler feature or retirement decision.
Parent owns this plan, issue updates, acceptance and integration. Implementer B
and independent reviewer C use native Sol6.1 agents at medium effort. D owns a
single read-only PR5883 readiness snapshot. Shared main remains untouched.

## Established evidence and remaining gap

The V9 before/after runtime arms each passed six selected original cases, with
38 declared and32 explicitly unselected. Those results do not replace the full
176-case acceptance population. The separately executed saved-binary audit
matched all20 captured binary hashes and measured empty actual Module.imports
on those exact buffers without instantiation. Prior user-side observations
remain associated by ordinal, not retroactively bound to module identity.

The frozen V7 physical comparison has not run. Its eight cases are, in order:
exit-empty, exit-unresolved-wrapper, ordinary, default, tuple-rest, native,
eval, high-internal. It compares frozen before/after closure-exports subjects
over the existing shared-source manifest, not current main versus candidate.
It adds emitWat:true only in this diagnostic lane; original runtime options
and fixtures remain unchanged. Compiler-state unknowns intentionally prevent
a full correspondence verdict even when observed bytes agree.

## Exact implementation assignment B

Use only the existing owned worktree
`/Users/thomas/Code/js2/.codex-worktrees/codex-5753-own-field-guard-20260927`.
You are not alone in the repository; preserve all peer and pre-existing edits.
Create a guarded launcher and receipt contract under
`plan/agent-context/5753-v7-execution-contract-20261002/`; no production,
original fixture, frozen V6/V7/V8/V9 source, gate or package changes.

1. The launcher accepts exactly one arm and one of the eight case names. Require
   the owned cwd and reject additional arguments and launcher Node flags.
   Dispatch one child through process.execPath with exactly
   `--max-old-space-size=2048`, the existing V7 diagnostic pathname, arm and case.
   No shell interpolation, batching, retries, timeout termination or compiler
   import in the launcher. A separately requested comparison mode may invoke
   the unchanged V7 compare.mjs only after all16 children are terminal.
2. Enforce before then after for each case and the full case order. Refuse
   existing output/attempt directories. Preserve first stdout/stderr verbatim,
   child PID, exact argument vector, exit code or signal, and start/completion
   receipts. A failed launch or instrument failure ends the execution grant;
   no automatic rerun or silent skip. Propagate nonzero child/comparator exits.
3. Verify the frozen V7 SHA256SUMS, V6 shared-source manifest, both frozen
   subjects, complete cases.json/project fixtures, and V9 invocation/runtime
   manifests before each launch and after terminal completion. Pin the manifest
   bytes themselves in a new proposed source-review manifest. Do not regenerate
   historical pins on drift. Parent independently verifies and approves the new
   manifest before any compiler run. Include source/dependency paths and counts
   in receipts; a missing manifest or empty enumeration is a failure.
4. Match the existing V9 bounded compiler-environment contract. Reject inherited
   JS2WASM_* and TEST262_* keys even when empty, IR_VERIFY_ALLOC, DEBUG_1712,
   GEN_DEBUG, JS2_SYM_DEBUG, DEBUG_MARKED_CODEGEN, NODE_PATH and NODE_OPTIONS.
   Reject METHOD_PAIR_* and VITEST_* overrides; the diagnostic does not use the
   Vitest worker launcher. Require absent or exact TEST=true, VITEST=true and
   NODE_ENV=test, then set those three values identically in the child. Never
   silently remove conflicting controls. Record only PATH/CI presence and
   SHA256, not raw environment or secrets. Require their fingerprints to match
   the completed V9 before-runtime invocation and the other arm. Verify both
   completed runtime arms and their fixed environment fields before admission.
   A PATH mismatch is a reported setup mismatch, not permission to rewrite pins.
5. Freeze the installed Node version/executable and esbuild package/API/binary
   inputs actually used by V7, recording symlink resolution where applicable.
   Shared dependencies are read-only: no install, package or hook configuration.
   Exact external optimizer binary immutability is not implied by PATH equality;
   retain this limitation in the report.
6. Prepare source-only controls for malformed args, wrong cwd, existing outputs,
   bad/missing/empty pins, environment drift, missing predecessor and nonterminal
   prior run. Such controls must not spawn the real compiler. Return source and
   proposed hashes before executing anything, including those controls.

## Review and execution ownership

C reviews the complete launcher and manifest independently, especially whether
missing evidence can become success and whether failure outputs survive.
Parent reads the source and resolves findings before granting B the exclusive
local validation slot. No compiler, typecheck, Wasm, hook or test process may
overlap another local validation owner. Read-only CI/source work may proceed.

After approval, first run the source-only refusal controls, then the16 unchanged
diagnostic children in the prescribed order, one process at a time. Keep the
first result of every invocation. Run the unchanged comparator once only when
all expected receipts exist and are terminal. Observation-tool timeouts are not
authority to kill or restart a process. Report actual handles and terminal exits.

## Interpretation and acceptance

Compare complete event populations, declaration/Instr/registry order, route
records, errors, imports, WAT and Wasm bytes with the frozen comparator. Never
sort or normalize away differences, loosen a witness or suppress ownerUnknowns.
Two equal failures are not successful compilation; absent outputs are not equal
successful outputs. Keep all first-run infrastructure and compiler failures.

The current exit diagnostic checks no function/export publication, not full
unchanged owner state. Its event serializer allocates fresh observation-wrapper
IDs; do not strip those IDs or claim stronger within-arm equality. Additional
unchanged-state proof requires a separately reviewed exact projection. Likewise,
default-source body identity and unprojected ProgramAbi/type-cell/transitive
mutation ownership remain explicit unknowns. Comparator exit1 from these
unknowns is expected inconclusive evidence, not a repair target.

Archive exact receipts with lengths and hashes; distinguish new observations
from historical reports. Parent updates issue3518 with denominators and remaining
blockers, and integrates useful source/evidence into the existing PR5753 after
reconciling its actual remote head. Do not push the stale local B branch over it.
No additional checkpoint PR, hold removal, main push or legacy retirement is
authorized by this task. PR5883 continues separately through required checks and
the protected queue when justified; its delivery does not complete issue5197.
