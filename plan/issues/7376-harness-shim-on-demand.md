---
id: 7376
title: "Harness assembly: emit the runtime shim's print / $262 only where the unit names them"
status: done
sprint: current
created: 2026-11-19
updated: 2026-11-19
completed: 2026-11-19
priority: high
horizon: s
feasibility: easy
reasoning_effort: high
task_type: implementation
area: test262, ir
goal: ir-full-coverage
depends_on: []
related: [7354, 3418, 4626, 3451, 3461]
---

# #7376 — runtime shim on demand

## Problem

`scripts/test262-fyi-runtime.js` defines exactly two top-level bindings,
`var print` and `var $262`, and every single-unit test262 assembly prepends
both. On the Prepared whole-program path (#7354) the shim is a wall of its
own: shim + `var x = 1;` refuses at shim line 4 with "module-level closure
binding 'print' not in module-init Slice 2 scope". The ordinary standalone
pipeline already drops the unused shim before codegen
(`src/deadcode-elide.ts`, #3418); the Prepared path does not.

Measured by lane S14 on main `89e4748241`: of 8,717 positive ES5 files, 21
need `$262` (20 name it, 1 via the `detachArrayBuffer.js` include) and 17 need
`print` (async flag, `doneprintHandle.js`); 8,678 need neither. Over all
editions 47,185 of 53,575 files need neither.

The shim is not the first Prepared stop today (`assert.js:20`, `dyn.typeof`,
comes first), so this removes a wall that sits behind the current one.

## Implementation Plan

- **Module.** `tests/test262-original-harness.ts` only; no `src/` change.
  `harnessSourceParts(meta, async, body?)` gains an optional third argument.
  With it, the runtime part keeps a top-level `var NAME` statement only if
  `NAME` occurs as a token in the rest of the unit (includes, `assert.js`,
  `sta.js`, the iterator-binding preamble and the body), closed to a fixpoint
  over the statements kept. An elided statement leaves its newlines, so every
  harness line number and `bodyLineOffset` are unchanged. The shim stays one
  file.
- **Callers.** `assembleVariant` (the single-unit assembly behind
  `assembleOriginalHarness`, used by the ordinary and the Prepared pipelines)
  passes the body. The native and linked split assemblies and
  `resolveStrictRerun` do not, so they keep the full shim and their decisions
  are unchanged.
- **Reuse.** The #4626 `$262` → `$26_` rename now edits the runtime part
  before the join instead of searching the joined prefix for the shim text,
  which the elision would have broken. `escapeRegExp` and `parseScript` are
  reused; the shim's statement ranges are parsed once and cached.
- **Text-level on purpose.** A name in a string, an `eval` text or a member
  name counts, so the kept set is a superset of the real references and an
  `eval("$262…")` still finds the shim.
- **Quality criterion.** One rule in one place, no second assembly path, no
  per-binding special case: adding a binding to the shim needs no change here.

## Acceptance

1. Ordinary standalone verdicts identical on every affected file, by a run.
2. A Prepared stop-point table before and after.
3. Tests: a body that names `$262` only inside a string or an eval text keeps
   it; a unit that names neither gets no shim binding
   (`tests/issue-7376-shim-on-demand.test.ts`).

## Results

See the PR body for the measured verdict identity and the stop-point table.
