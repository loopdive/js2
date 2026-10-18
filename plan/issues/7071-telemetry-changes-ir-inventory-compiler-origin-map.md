---
id: 7071
title: "`trackIrOutcomes` hands the IR inventory the compiler-origin map that production compile does not, so prelude code (timer shim) is inventoried and routed differently with telemetry on — same behaviour, different bytes"
status: ready
sprint: Backlog
created: 2026-10-18
updated: 2026-10-18
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: ir
language_feature: ir-telemetry
goal: ir-full-coverage
related: [7002, 5297, 3519]
---

# Telemetry changes the IR inventory's view of compiler preludes

Found while implementing [#7002](./7002-ir-gate-integrity-telemetry-stride-ledger.md)
step 1 (telemetry must not change the result). #7002 fixed the two cases that
changed `success`; this one changes only the binary.

## Evidence (main `2cc15166` + #7002, 2026-10-18)

- `website/playground/examples/js/async.ts`, default (gc) target:
  `compile(src)` and `compile(src, { trackIrOutcomes: true })` both succeed,
  but the binaries differ — the `$__ir_closure_N` / `$__fn_wrap_N_type` types
  are emitted in a different order (11,374 bytes both ways).
- Root cause, by A/B: `src/compiler.ts` builds
  `irIds.maybe(positionMap, options.trackIrOutcomes || isIrCutoverAuditRequested() || backend === "linear")`.
  Forcing that argument to `true` makes the telemetry-off compile produce the
  telemetry-on bytes. The options carry `compilerOriginAt`, which
  `src/ir/identity.ts` uses to classify compiler-injected statements: with it,
  the timer-shim `setTimeout` prelude becomes a `synthetic-support` terminal
  and takes the isolated timer-shim preparation
  (`src/ir/compiler-timer-shim-preparation.ts`); without it the prelude is an
  ordinary `top-level-function`.
- Not seen in test262: telemetry parity was byte-identical on 268/268 files
  (stride 200, standalone) and 268/268 (stride 200 offset 100, gc) after #7002.
  Only sources with compiler-origin preludes are affected.

## Decision needed

Pick one inventory for both modes:

- **Always pass the origin map** (production gains the accurate prelude
  classification and the timer-shim route). Changes production bytes for
  prelude-bearing programs — needs an equivalence + test262 check and a note
  that gc output changes.
- **Never pass it outside linear** — telemetry then measures exactly what
  production does, but prelude rows lose their `synthetic-support` identity
  and the #5297 timer-shim tests need re-reading.

## Acceptance

- Remove the `gc:website/playground/examples/js/async.ts` entry from
  `KNOWN_BYTE_DIVERGENCE` in
  `tests/equivalence/issue-7002-ir-gate-integrity-telemetry-stride-ledger.test.ts`
  (the test fails once the divergence is gone, by design).
