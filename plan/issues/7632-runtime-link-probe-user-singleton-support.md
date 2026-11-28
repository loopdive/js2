---
id: 7632
title: "Runtime-link probe: the user module fails with 'could not allocate its exact singleton support'"
status: ready
sprint: current
created: 2026-11-28
updated: 2026-11-28
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: ir
goal: ir-full-coverage
related: [2928, 7631]
---

# #7632: the runtime-link probe's user module no longer compiles

## Problem

`tests/issue-2928-runtime-link.test.ts` › "returns and invokes an interpreted closure across the Wasm module boundary"
is red on main 234cf440. The report reads:

```
CompileError: WebAssembly.Module(): BufferSource argument is empty
    at main (tests/interp/runtime-function-link-probe.mjs:956)
```

The empty binary is the probe's **user** module (`USER_SOURCE`, compiled with `target: "standalone"`), not the
runtime provider. The provider builds in provider-only mode, so the first case in the same file passes. The user
compile fails with:

```
Codegen error: prepared function-value target ir-unit:v1:ir-source%3Av1%3A0000000000000000%3Aentry%3Aruntime-eval-user.ts:root:top-level-function:0000000000000000 could not allocate its exact singleton support
```

This is the `IrInvariantError` in `src/codegen/ir-imported-call-planning.ts` (~L1126).
`ensureFuncClosureSingletonAccessor` returns no singleton, trampoline, cache global or accessor for the target.

Found while working on #7631 (PR #7565). The cause is not #7631: the probe's provider builds with the old private
`INTERP_FILES` list and with the shared one alike.

## Repro

```bash
node --max-old-space-size=3072 --import tsx tests/interp/runtime-function-link-probe.mjs | head -c 400
```

Minimisation so far: compiling the helper functions (`dynamic`, `dynamicAny`, …) together with any single exported
function of `USER_SOURCE` succeeds. Only the full source fails, so the trigger is a combination of exports that share
a function-value target. The next step is to bisect over subsets of exports.

## Acceptance

- The probe's user module compiles, and the closure case of `tests/issue-2928-runtime-link.test.ts` passes.
- Either the IR refuses the shape at select, or it allocates the singleton support. It must never claim the unit and
  then throw.
