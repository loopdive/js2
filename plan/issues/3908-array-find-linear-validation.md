---
id: 3908
title: "linear backend: array/find emits an invalid module — local.set[0] expected i32, found local.get of type f64"
status: ready
created: 2026-07-31
updated: 2026-07-31
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bug
area: codegen-linear
language_feature: array-methods
goal: performance
sprint: current
horizon: m
es_edition: multi
related: [3902, 3904]
---

# #3908 — `array/find` linear-memory lane fails Wasm validation

## Status: open — reproduced independently by two agents

## Problem

The linear-memory lane of the `array/find` benchmark emits a module that
fails validation at instantiation:

```
WebAssembly.instantiate(): Compiling function #50:"run" failed:
local.set[0] expected type i32, found local.get of type f64
```

Repro:

```bash
npx tsx benchmarks/run.ts --suite arrays --filter find
```

An f64 value is flowing into an i32 local slot in the linear backend's
lowering. It reproduces on `main` today.

## Why it was invisible until now

`benchmarks/harness.ts` silently downgraded any failing strategy to a skip and
dropped the row entirely, so a broken lane was indistinguishable from a lane
that was deliberately not applicable. #3904 changed that: failed strategies are
now recorded with `status: "failed"` and their error.

**Consequence: once #3904 lands, this becomes a visible `FAILED` bar on the
public performance page.** Better to fix it before then than to explain it
after.

## Scope

1. Find the f64→i32 slot mismatch in `src/codegen-linear/`. The callback-shaped
   `find` lowering is the obvious suspect — the predicate returns a boolean but
   the element is a `number`, so a slot is probably being reused across two
   types.
2. **Sweep the other suites' linear lanes.** The same mismatch is unlikely to
   be unique to `array/find`. Note that the linear lane currently produces
   results for only 2 of 28 benchmarks (`mixed/fibonacci`,
   `mixed/matrix-multiply`) — the other 26 are absent, and until #3904 lands we
   cannot tell which are legitimately skipped and which are failing like this
   one. Re-run after #3904 to get the real inventory, and report it here.
3. Add a validation regression test for whatever shape is at fault.

## Acceptance criteria

1. `array/find`'s linear-memory lane produces a valid module and a real number.
2. The issue reports how many of the 26 currently-absent linear lanes are
   failures vs. deliberate skips, measured after #3904 lands.
3. A regression test covers the faulty lowering shape.

## Notes

- Found by `issue-3902-array-sort` while un-skipping `array/find`'s gc-native
  lane, and independently reproduced by `issue-3904-dom-lane`. Neither touched
  the linear backend; it is a pre-existing defect in both cases.
- Per `docs/architecture/codegen-axes.md`, the linear backend is not superseded
  by WasmGC — both stay. So this is a real gap, not dead code.
