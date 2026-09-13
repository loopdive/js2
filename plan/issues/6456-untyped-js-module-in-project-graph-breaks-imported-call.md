---
id: 6456
title: "An untyped `.js` module in a `compileProject` graph breaks every call into it — traps on wasi/standalone, silently returns 0 on gc"
status: ready
sprint: current
created: 2026-09-13
updated: 2026-09-13
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: correctness
---

## Problem

Found while building the [#6428](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6428-standalone-async-return-thenable-value-sink)
regression fixture, which the plan had specified as an untyped `.js` producer +
a `.ts` entry (the dogfood package shape). The fixture failed for a reason that
has nothing to do with #6428: **any** imported function from an untyped `.js`
module in the graph answers wrongly.

The minimal repro has no async, no Promise, no cast — a two-file project whose
producer half is `.js` instead of `.ts`:

```js
// mod.js
export function c2() { return 7; }
```

```ts
// entry.ts
import { c2 } from "./mod.js";
export function tc2(): number { return c2(); }
```

## Measurement (2026-09-13, upstream/main dcdd1efa13, `compileProject` + `WebAssembly.instantiate(binary, importObject)`)

| producer half | `--target wasi` | `--target standalone` | gc / host (default) |
| --- | --- | --- | --- |
| `mod.js` (untyped) | **trap** (`WebAssembly.Exception`) | **trap** | **`0`** (silent wrong answer) |
| `mod.ts` (typed, same body) | `7` | `7` | `7` |
| no second file (body inlined into `entry.ts`) | `7` | `7` | `7` |

`compileProject` reports `success: true` with zero errors in every row, so there
is no compile-time signal at all. The gc row is the worse one: it does not trap,
it returns `0`.

Probe: `.tmp/probe-6456.mjs` on the #6428 worktree (three shapes × three
targets, `compileProject` + `WebAssembly.instantiate`).

## Why it matters

Every dogfood package half is untyped `.js`. The dogfood suites pass, so the
suite runner's own project assembly must be avoiding whatever this path does —
which means the defect is in the plain `compileProject` graph route that an
external user of the compiler hits first. A wrong answer with `success: true`
and no diagnostic is the most expensive failure shape we ship.

## Acceptance criteria

1. All three `mod.js` rows above answer `7`, matching the `mod.ts` rows.
2. Regression test under `tests/` covering the untyped-`.js`-producer project on
   `wasi`, `standalone` and gc, with the `mod.ts` twin as the anti-vacuity
   control.
3. If some part of the untyped-`.js` graph route is genuinely unsupported, it
   must be a **compile error**, never `success: true` with a wrong answer.

## Notes for whoever picks this up

Start by diffing the emitted module for the `mod.js` and `mod.ts` rows — same
body, same entry, so the delta isolates whatever the `.js` route drops (a
signature/ABI mismatch at the cross-module call is the first hypothesis: gc
returning `0` rather than trapping smells like a numeric result read off the
wrong carrier, and wasi/standalone trapping on the same call site fits a
cast/`ref.cast` on a mistyped result).

## Implementation Plan

**Reproduced on upstream/main 54c36a9fe3 (2026-09-13, `.tmp/probe-6456/run.mjs`, `compileProject` + `WebAssembly.instantiate`):** `mod.js` producer → wasi `WebAssembly.Exception`, standalone `WebAssembly.Exception`, gc `0`; `mod.ts` twin → `7` on all three. Passing `allowJs: true` explicitly to `compileProject` makes all three `mod.js` rows answer `7` — so the whole defect is option plumbing, not codegen ABI.

**Responsible arm (confirmed, not hypothesis).** `compileProject` (`src/index.ts:1305-1307`, #1107) auto-enables `allowJs` only when the *entry* is `.js/.mjs`. With a `.ts` entry the flag stays off, `compileMulti` passes `allowJs: undefined` into `analyzeMultiSource` (`src/checker/index.ts:1095ff`), and `ts.createProgram` silently drops the `./mod.js` root: `program.getSourceFiles()` = `[entry.ts]`, `multiAst.diagnostics` = `[]`, the only signal is TS6504 in `program.getOptionsDiagnostics()`, which nobody reads. The import binding `c2` then has no declaration; the call lowers to `ref.null extern; call $__unbox_number` (gc → `0`) / the throw arm on host-free targets. Emitted WAT for the `.js` row has no `$c2` function at all (`.tmp/probe-6456/entry.ts.wat`). Every dogfood harness passes `allowJs: true` (`tests/dogfood/upstream-suite-runner.mjs:1075` etc.), which is why the suites never see this.

**Fix, two layers, in order:**
1. `src/index.ts` `compileProject`: move the #1107 auto-enable after `resolveAllImports`, and set `allowJs: true` when **any** file in `allFiles` matches `/\.[cm]?js$/` (entry or dependency). This is the same policy the dogfood packages already get, so no new leniency shape is introduced. Keep an explicit `options.allowJs === false` honoured? — no such caller exists; treat `undefined` as "auto". Do not touch `compileFilesSource`/`analyzeFiles` (disk/tsconfig path, separate route).
2. Criterion 3 guard, `src/checker/index.ts` `analyzeMultiSource` + the project-service twin (`src/checker/language-service.ts` ~L416): add `droppedRoots: string[]` to `MultiTypedAST` = `rootNames.filter(n => !program.getSourceFile(n))`. In `src/compiler.ts` `compileMulti` right after the analyze phase (~L1826): if `multiAst.droppedRoots.length > 0`, push one `CompileError` per file (`"<file> was not included in the program (TypeScript: <flattened TS6504 text from program.getOptionsDiagnostics()>); pass allowJs"`) and `return failResult(errors)` before the diagnostic loop. This makes a direct `compileMulti({"./entry.ts","./mod.js"})` without `allowJs` a compile error instead of `success: true` + wrong answer.

**Order-preservation constraints:** layer 1 must not reorder `files`/`fileKeys` construction or change `entryKey`; layer 2 runs before any diagnostic is pushed so `errors` ordering for existing failures is unchanged; no change to `isEntryDiag`, `hasSyntaxErrors`, `hasHardTypeErrors`, or the early-error `allowJs` skip in `runPipeline` (`src/compiler.ts:~1005`). Before landing layer 2, grep `tests/*.test.ts` for `compileMulti`/`compileMultiSource` calls whose file map mixes `.js` keys with no `allowJs` — any such test that expected success was relying on the drop and needs `allowJs: true` (measure: run `npm test -- tests/compile-multi*.test.ts tests/issue-1058-*.test.ts` plus the greps' hits).

**Probe first:** `.tmp/probe-6456/run.mjs` exists (three targets × `entry.ts`/`entry2.ts`); re-run it with `allowJs` removed after layer 1 — all six rows must print `7`.

**Regression test** `tests/issue-6456-untyped-js-dep-project.test.ts`, mkdtemp fixture pattern from `tests/issue-1058-consumer-driven-barrels.test.ts`: untyped `mod.js` (`export function c2() { return 7; }`) + `entry.ts` importing `./mod.js`; `compileProject` on `wasi`, `standalone`, gc; instantiate with `result.importObject`; expect `tc2() === 7` (fails on parent: trap/0). Anti-vacuity control: `mod.ts` twin with identical body must also answer `7` on all three. Guard test: `compileMultiSource` with `{"./entry.ts", "./mod.js"}` and no `allowJs` → `success === false`, an error naming `mod.js` and `allowJs` (fails on parent: `success: true`).

**Expected movement:** dogfood anchors unchanged (webpack 16/16 · three 17/18 · clsx 32/32 · cookie 63740 · lodash 59/62 · redux 67/82 · axios 208/231 · stylelint 108 · tailwindcss 13 · jsdom 6 · styled-components 9 · uuid 75 · marked 16/30 · moment 10 · prettier 107/151 · jest 335/356 · hono ~261/324) — all harnesses already pass `allowJs: true`. Standalone lane: no test262 movement (single-file runner); the standalone/wasi rows of the new test are the lane's evidence. Ratchet gates: LOC growth is small (<40 lines in three files); no oracle/checker raw calls introduced.

## Dispatch

**opus** — the defect is confirmed and the fix is two small chokepoint edits plus a guard, but the dev must survey existing `compileMulti` tests for ones that silently depended on the dropped-root behaviour and keep the diagnostic-policy gates untouched, which needs judgment rather than a mechanical apply.
