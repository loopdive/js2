---
id: 3461
title: "test262: productionize native-harness fast oracle (worker mode flag + harness split + binding shim)"
status: done
completed: 2026-07-23
sprint: Backlog
priority: high
horizon: l
task_type: ci
area: ci
goal: maintainability
parent: 3450
---

# test262: productionize the native-harness fast oracle (host lane)

Child (a) of the #3450 HYBRID two-oracle pipeline. Full spec:
`plan/design/3450-hybrid-two-oracle-plan.md` §1.

## Problem

The #3450 fast lane needs the spike's throwaway native-harness compile path
(`.tmp/spike-3450/native-harness-worker.mjs`) turned into a production mode of
`scripts/test262-worker.mjs`: run the assembled harness prefix as **native JS**
in the per-test sandbox and compile **only the test body** to wasm (~4.5–5×
cheaper host compile). Off by default; host lane only.

## Scope

- `tests/test262-original-harness.ts`: add `assembleNativeHarness(source, meta)`
  returning split `{ harnessPrefix, bindingShim, body, bodyLineOffset, strict }`
  variants (primary + optional strictRerun). Reuse `assembleVariant`'s prefix
  assembly (incl. `dedupeTopLevelFunctionDeclarations`); do NOT concat body.
- Binding shim: emit `var <name> = globalThis.<name>;` for ONLY the harness
  symbols the body references (member-call bridge gap — see spec §1). Match
  identifier tokens; extra binds are inert, omitted binds are the only failure.
- `scripts/test262-worker.mjs`: `TEST262_ORACLE_MODE=fast` flag; when set + host
  target, compile `bindingShim + body` only and `runInContext(harnessPrefix)`
  natively in the sandbox before instantiation. Verdict tail unchanged.
- Strict rerun: harness runs once (strict-neutral); body still compiles twice
  (1.7× multiplier stays).

## Acceptance criteria

1. `TEST262_ORACLE_MODE=fast` + host reproduces the spike flip set on the
   252-test stratified sample.
2. Flag unset ⇒ byte-identical to today (400-test sample, zero row deltas).
3. Standalone target ignores the flag entirely.
4. `bodyLineOffset` keeps body error-line mapping exact.
5. No new host import beyond the existing `globalSandbox` bridge.
