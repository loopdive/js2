# Session B: Linear IR implementation lane

User assignment (2026-10-07): implement Linear IR consumption/emission,
Linear runtime/provider support, and Linear correctness/performance. Session A
owns shared IR/frontend/preparation/provenance, WasmGC and final integration.
Each task has an implementation plan in `plan/issues`, authored by Astra;
Sol6.1 implements bounded slices in isolated worktrees.

## Publication and coordination

- Branch: `codex/linear-session-b-20261007` on the fork remote.
- Exact starting HEAD and authenticated canonical main:
  `e7760d1c2af4636ede6a352154d193b234af5fc4`.
- Worktree: `/private/tmp/js2-linear-session-b-20261007`.
- Canonical claim book: `CLAIM_ASSIGN_REMOTE=upstream`,
  `refs/heads/issue-assignments` on `loopdive/js2`.
- Issue6888 is atomically reserved. Planning claim:
  `6888:linear-plan-20261007`, owner
  `ttraenkler/codex-linear-b-astra-plan-20261007`, branch
  `codex/6888-linear-spec-20261007`. Writer scope is the new issue6888 Markdown
  plan only. Implementation claims and exact file/function partitions follow
  task selection and collision review. Issue6888 is blocked on shared f32
  semantic admission; no implementation edit is released for it.
- Issue6891's Astra plan releases two independent, upstream effect-verified
  implementation claims: `6891:linear-stack-source-20261007`, owner
  `ttraenkler/codex-linear-b-stack-sol61-20261007`, and
  `6891:linear-stack-tests-20261007`, owner
  `ttraenkler/codex-linear-b-stack-tests-sol61-20261007`. Their branches are
  `codex/6891-linear-stack-source-20261007` and
  `codex/6891-linear-stack-tests-20261007` respectively. Sol6.1 Medium workers
  own only `runtime-stack-arena.ts::addLinearStackArenaRuntime`'s emitted
  allocation locals/body and the new issue6891 regression test respectively.
  Existing shared contracts suffice; no shared wiring is requested for6891.
- Coordination-file owner: this parent session, limited to this handoff.
  No ownership of shared compiler/API/registry wiring is assumed.

## Shared dependencies and active claims

Published shared contract inspected:
`codex/3518-linear-layout-legality-owners-20261004` on the fork at
`650cb1b0a08df7976662c721e0da884b109fbfe0`; its issue3518 owns the Linear layout,
backend-legality and relocation contract. Consume its published interfaces;
neither its claim nor existing source recipes transfer to this lane.
Canonical main already supplies the shared BackendEmitter, lowering handles,
LinearMemoryPlan and typed failure contracts.

Claim snapshot `987d1246d1688425fd56e72a116e07bb1a8ecf44` shows active Linear
source-map finalizer, public telemetry, batch and numeric-module-binding slices
under issue6865; early-return source/test/integration slices under issue3525;
and existing runtime/coercion work under issues4540,4542,4544,6778 and6793.
These stay owned by their current owners. Check the live book before every
coding release, because names and timestamps alone do not prove abandonment.

Session A's human-confirmed pending publication is branch
`codex/ir-session-a-coordination-20261007`, issue6889, document
`plan/log/ir-coordination-session-a.md`. It is not yet pushed, so no future
commit is treated as a verified dependency. A explicitly owns shared integration,
compiler entry points and active source-map files; leave these unchanged until
comparing explicit scopes. No active A/subagent claim is adopted while waiting.
Shared wiring changes require the designated owner's handoff; independent leaf
work may proceed once its own claims are effect-verified.

## Architecture and validation

Place semantics/contracts at the generic IR level and target-specific storage,
emission and runtime mechanisms in backend-specific modules. Group related
code in subfolders, reuse existing algorithms, and keep inlining/DCE in their
dedicated optimization modules. Avoid duplicate lowering drivers and widening
shared interfaces for a single target without the shared owner's agreement.

This initial coordination checkpoint contains no implementation or executed
regression result. Each implementation publication will record its exact HEAD,
owned files/functions, test commands and actual results, preserved failures,
shared dependency hashes and integration requirements. Return values are the
Linear differential observation surface; plain Linear lacks console output.
Session A coordinates queue submission. Legacy code remains until complete IR
equivalence has been demonstrated.

The previous handoff branch separately merged canonical main as
`c36e1cea16ec4a9c5ed2e75eb85e5e7d7ce570ff`; that historical PR composition is
not a dependency of this clean Linear branch.
