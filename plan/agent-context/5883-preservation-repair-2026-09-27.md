# PR5883 preservation repair — September 27

## Current checkpoint and next bounded work

Source-preservation repair is published as `61d206221baa9e007d1da44233bce925952ebb03`.
Its CI run `36276574230` completed successfully, but the semantic HOLD remains:
the separate observable vector path retains saved-length iteration and raw
backing reads. CI success is not acceptance of mutation/hole behavior.

The twelve exact historical inputs recovered below unblock a paired rerun.
First rerun them unchanged on exact61d; then repair only the demonstrated
observable-vector defects. Live-length checks alone are insufficient: semantic
element reads, growable aggregate state, stable callback indices and both
synchronous/deferred completion must agree. Main's `promise-combinator-drive.ts`
is an implementation precedent, not evidence that this separate route is fixed.
Preserve original source receipts, all controls and the hold until measured.

## Parent pre-publication checks

After the agent returned code ownership and the test slot, the parent ran the
exact CI dead-export command with preservation-v1/core-types/core-nodes: exit 0,
6/6 full and 6/6 cut source witnesses. Strict graph closure remains FAIL at the
two existing nonliteral dynamic imports, with retirement NOT CERTIFIED.
Final TypeScript 7 and stack-balance checks pass (no fixup-bucket increases).
Logs: `.tmp/preservation-dead-exports-final-20260927.log` and
`.tmp/preservation-stack-final-20260927.log`.

Remote PR head was reverified as `42807efe4f` with its hold intact before
publication. Publish this as a preservation repair checkpoint, not a claim of
full conformance or approval to remove the hold. The two exact-base host
timeouts below remain unresolved.

## Scope and ownership

Start: `42807efe4f1456864b762a07c2814ea518b3ba79`.
Worktree: `/Users/thomas/Code/js2/.codex-worktrees/codex-5883-preservation-repair-20260927`.
Branch: `codex/5883-preservation-repair-20260927`.
This worktree and branch were already provisioned at the requested commit;
the scoped source/test status was clean before this plan was written.

Authorized changes: restore the live Promise combinator adapter, relocate
main's observable protocol, preserve D1 capability helpers and D2b callers,
adjust necessary production imports, and add focused tests. No commit/push.
Parent owns the separate read-only PR5753 diagnosis. This task owns the
serialized test slot: one Vitest fork, 2048 MB heap. No dependency installation.
Existing node_modules symlink is present. Existing PR remains held.

## Plan recorded before code

1. Independently verify that `3316b27608` is the approved post-B1/pre-D1 donor
   and that it matches D1's parent. Read the original source receipts and B1
   inverse, then validate that exact donor against the unchanged ledgers.
2. Move all twelve main observable declarations, associated types and D2b
   carrier parameterization into a live observable protocol module. Preserve
   main's optional observable entrypoints and exact ordinary/null fallbacks.
   Keep the separate observable implementation and its cached-null diagnostic.
3. Keep the original adapter active for ordinary combinators, original custom
   settle/check paths, and the IR Promise.all provider. Restore its complete
   approved source, including imports, comments and private declarations.
4. Give D1 local behavior-identical copies of the three private capability
   helpers and their types: the frozen declaration/module receipts preclude
   exporting or extracting the historical declarations. Preserve shared cache
   keys and resource names, with no duplicate registration.
5. Rewire D2b to the relocated protocol; derive resource types from the original
   public runtime function, and select only its already-admitted all/race
   reactions outside the frozen adapter. Preserve the original allSettled/any
   registration and all source gates.
6. Validate the unchanged positive source-preservation suite first, then the
   focused blast radius and new relocation/cache-order/fallback tests. Check
   TS7 and stack balance serially. Record failures without rebaselining.

## Non-negotiable boundaries and risks

Original fixtures, receipt scripts, B1 factory/inverse, delay-EH forwarding
evidence and gate allowances stay unchanged. No implementation retirement,
dead archival copy, or full-IR/equivalence claim. Real production callers must
continue reaching both the original adapter and relocated protocol.

Preserve helper registration order, shared cache identity, subtype layouts,
late-import index behavior, detached instruction ownership and optional vector
fallback narrowing. Bounded D1 source duplication is necessary while its
original private declarations remain pinned; tests must cover mixed consumers.

## Verified source boundary and production ownership

The exact `3316b27608` donor equals the file at D1's parent `82b83e1de5^`.
Restored file SHA256:
`4c14d929347b28e46cd5b6fe050d14f40baec1313881506db9619fbf59c7aa1a`.
Git blob SHA1 (also independently verified by parent):
`55f7951d0a64076e68cc42eb0dfb8469a320a1fa`.
The unchanged B1 inverse verifies its complete historical donor bytes (72,926
bytes). No reconstruction or receipt helper was changed.

Direct positive verification before repair, overlaying the published `42807`
adapter into the same reader, fails at `current declaration order
src/codegen/promise-combinators.ts`. Direct verification after restoration
passes the original 20+4 declarations, all historical/module receipts, eight
donors, four delay rows, one vector loop, one shared dispatch helper, and the
separate original tagged/foreign delay-EH forwarding evidence.

`promise-combinator-observable-protocol.ts` owns main's twelve observable
functions, D2b's carrier parameterization and the main opt-in wrappers. The
namespace ordinary routes use those wrappers, which delegate to the original
live adapter; the IR provider still imports the original directly. D2b imports
the relocated preparation/element/runtime helpers. Both observable pipelines
share their existing runtime cache, with the separate module's null guard intact.

Parent reported the published dead-export failure on main's f64 recognizer.
Both pre-repair recognizer bodies are text-identical. The namespace retains
its existing separate-module admission entrypoint; that entrypoint now delegates
once to the relocated canonical classifier. This is real production admission,
with no duplicate probing or gate broadening. The new protocol has one additive
compiler-boundaries record marked `unmigrated / mixed-needs-split`; it is not an
allowance or completion claim.

Ordinary wrappers delegate without pre-registration. Observable-support failure
can re-enter the idempotent original ensures; focused tests compare complete
module/maps/IDs and emitted bodies/locals at that fallback, including cached-null
and cold fault-injected failure. D1's bounded local helper copies share the
original capability cache; runtime tests observe both live production routes
in both orders and require identical cache identity and a single registration.

## Validation and handoff

- First unchanged source-preservation suite: **145/145 pass**, including the
  positive 11 public-source artifacts / 19 executions. Historical external
  baseline pair NOT RUN; physical acceptance and retirement NOT CERTIFIED.
  Evidence: `.tmp/delay-combinator-preservation-Y8UYa7`.
- Initial TS7: pass.
- First new focused run: 10/12 pass; two vector fallback assertions used the
  wrong argument ordinal in the new test (7 instead of 6). Corrected the test;
  no production change was needed. All 12 new tests pass in the broader rerun.
- Broader focused run: **137/139 pass, 12/13 files pass**, 258.33 seconds.
  Both failures are the unchanged `tests/promise-combinators.test.ts`
  `Promise.all with resolved values` / `Promise.race with resolved values`
  tests, each timing out at the unchanged 35-second limit. They instantiate
  through the host runtime and await the returned promise. Exact-base control
  below reproduces both failures; their underlying cause is not diagnosed here.
- Serialized focused run log: `.tmp/preservation-focused-20260927.log`.
- LOC/function gates pass against explicit `LOC_GATE_BASE=42807efe4f`, without
  allowances. Initial LOC check caught two added import lines in the namespace
  driver; a shorter relevant buffer-ownership comment removes the net growth.
- Boundary inventory passes: `inventoryValid=true`, `graphComplete=false`.
  Evidence: `.tmp/preservation-boundaries-20260927.log`.
- Independent static comparison: all 12 moved function bodies retain semantic
  receipts after mapping only the reaction-selector name/unused ctx argument;
  the three D1 helper bodies match published 42807, and the two pre-repair f64
  recognizer bodies are text-identical.
- On parent's follow-up, ran exactly the two failing tests against the original
  worktree at clean-source `42807efe4f1456864b762a07c2814ea518b3ba79`, with
  the same Vitest configuration, one fork, 2048 MB and unchanged 35-second
  timeout. **Both selected tests fail with the same timeout; 6 unrelated tests
  skipped**, 87.97 seconds. Log:
  `.tmp/preservation-host-exact42807-20260927.log`. This establishes that both
  observed failures predate the repair, not that the host runtime is correct.
- Last compiler/test session `78491` (baseline) has exited with status 1.
  Test slot explicitly released to parent again after that requested control.
  **All further compiler/gate execution paused by parent instruction.** No live
  test/compiler session remains. Dead-export/core-node execution, final TS7 and
  full stack-balance gate remain NOT RUN on the final tree. Initial TS7 passed;
  focused original stack/pop regression tests passed. Do not substitute those
  results for the pending final checks or claim the dead-export gate is green.

A broad git status hit a Git LFS sandbox write restriction while inspecting an
unrelated website asset; source/test-scoped status succeeds. No unrelated assets
were changed. The repair remains based on `42807`; parent handles later upstream
integration. No commit or push; PR remains held.
Parent's disjoint `plan/agent-context/3518-queue-drain-2026-09-27.md` handoff
was copied into this worktree for the batched checkpoint; it is not edited here.

## Review diff and remaining integration work

Review patch: `.tmp/5883-preservation-repair-20260927.diff` (this task's tracked
changes plus its new protocol module, two tests and handoff; parent queue-drain
document deliberately excluded from this task's patch and left in the tree).

Parent should run `check:dead-exports` with the existing preservation-v1,
core-types and core-nodes requirements, final TS7 and full stack gate when the
serialized slot is available. Preserve the two known dynamic-import limitations
and dispatch-cut UNKNOWN reporting; boundary inventory is not graph completion.
No timeout, fixture, ledger, allowance or retirement condition was changed.

The repair keeps the original adapter byte-identical to 3316 while moving live
observable consumers outside its frozen source boundary. It does not certify
full IR equivalence, retire either implementation, or remove the PR hold.

## Historical observable-vector review records recovered September 27

`5883-observable-vector-review-20260915.jsonl` preserves the exact twelve
JSONL records from the September 15 review: twelve unique complete sources,
eight divergences and four matching controls. These are **HISTORICAL results,
not new candidate evidence**. No compiler or tests were run for this recovery.

Provenance: line 1644, `payload.item.stdout`, of
`/Users/thomas/.codex/sessions/2026/09/15/rollout-2026-09-15T00-37-07-01a0a211-24dc-79f1-ba52-d7d13454152c.jsonl`.
That captured command output contains the original
`/private/tmp/js2-5883-hole-length-review-20260915.log`; the temporary log itself
is now missing. Recovery selects only lines beginning `{"method"`, retaining
their order, exact source strings, reference/actual results and evidence flags.
No sources or expectations were reconstructed or normalized.

The twelve-record file (including final newline) has SHA-256
`d9d792883c09853383845195ca9868ed97e506c6526b2434384c49a7f2d5f806`.
Each record reports successful compilation, zero imports and observable-body
presence. Six variants run under each of `all` and `race`: `none`, `grow-holes`,
`shrink-regrow-same`, `shrink-regrow-next`, `literal-hole`, `undefined-nan`.
Only `none` and `undefined-nan` match in both methods. The earlier shrink/push
probe batch is separate and is not included in these twelve records.

The September 15 HOLD comment attributes this historical review to clean
`df94fdac`, with relevant files verified byte-identical to published `647343cc`:
https://github.com/loopdive/js2/pull/5883#issuecomment-5673008243.
These records preserve the original acceptance inputs for a later paired run;
they neither establish results on `61d206221b` nor authorize HOLD removal.
Parent owns publication and the reserved serialized test slot. No source edits,
test execution, commit or push were performed for this recovery.
