# Sprint 73 retrospective

**Window:** 2026-07-19 → 2026-07-21

**Release:** v0.64.0

**Completed:** 28 issues

**Carried forward:** 191 issues

## Outcome

Sprint 73 made Test262 results honest and portable. At the start of the window,
the JS-host lane reported 28,294 / 43,106 (65.6%) and standalone reported
27,378 / 43,106 (63.5%). Merge-queue run 29799448439 closed the window with:

| Lane       |                   Start |                   Close |                 Change |
| ---------- | ----------------------: | ----------------------: | ---------------------: |
| JS-host    | 28,294 / 43,106 (65.6%) | 30,282 / 43,099 (70.3%) | +1,988 passes; +4.7 pp |
| Standalone | 27,378 / 43,106 (63.5%) | 28,136 / 43,106 (65.3%) |   +758 passes; +1.8 pp |

The headline gain is useful, but the more important result is measurement
parity: the project runner and the external test262.fyi path now execute the
original harness with the same fixture, negative-test, async-completion, and
result-classification rules. Passes are no longer created by weakening or
silently omitting parts of the upstream harness.

## What went well

- The original-harness investigation found and removed silent false passes in
  module-goal detection, missing fixture graphs, expected-negative handling,
  top-level await, and dynamic fixture discovery.
- Compiler fixes addressed the newly visible causes instead of patching test
  expectations: module-global `globalThis` storage, callable harness exports,
  standalone vector reads, RegExp value carriers, deferred dynamic imports,
  authentic RangeError objects, and `Reflect.construct`/NewTarget support.
- `@loopdive/js2` now ships a one-shot `js2-test262` CLI. The proposed upstream
  integration uses the unchanged generic test262.fyi runner and publishes one
  standalone WebAssembly GC result.
- The IR work advanced in bounded slices: the object-runtime self-host family,
  checker-backed multi-module overlays, builtin lowering, and the optional
  Porffor source-to-native canary all landed without pretending the broader IR
  migration is complete.
- The merge-queue trap ratchet did its job. It rejected a 29-test illegal-cast
  increase caused by a standalone constructor marker changing the JS-host
  closure ABI. The recovery scoped that representation change to host-free
  compilation and added direct regression coverage.

## What did not go well

- Full FYI comparisons were initially run too broadly and serially, making
  stopped sessions expensive. Deterministic samples and live error harvesting
  should precede a whole-corpus confirmation.
- Stricter classification initially looked like a pass-rate regression. The
  project needed clearer separation between newly honest failures and actual
  compiler regressions.
- Sixteen completed issues were missing `sprint: current` or carried unrelated
  sprint labels, so the release wrap had to reconstruct their membership.
  Sprint metadata should be set when work begins.

## Carry-over

All 191 unfinished issues remain `sprint: current`. The immediate release-tail
items are #3510, publishing the standalone test262.fyi engine after v0.64.0 is
verified, and blocked #3494, real standalone loading for executable literal
dynamic-import module graphs. The wider carry remains the value-representation,
async/Promise, generator, module, and IR-retirement program; sprint 73 landed
useful slices but did not close those architecture epics.

## Keep

1. Treat the original unmodified Test262 harness as the semantic oracle.
2. Compare runner classifications before interpreting pass-rate movement.
3. Let the merge-queue trap ratchets block unsafe representation changes.
4. Fix shared compiler/runtime causes; do not add path-specific pass allowances.
5. Start external publication with the smallest independently meaningful lane.
