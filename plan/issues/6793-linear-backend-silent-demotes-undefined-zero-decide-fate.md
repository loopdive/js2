---
id: 6793
title: "linear backend: `undefined` is `0` (silent wrong results), the IR overlay swallows compiler throws as silent demotes, 0 commits in the last ~900, nothing required in CI — decide its fate"
status: in-progress
sprint: Backlog
created: 2026-09-30
updated: 2026-10-02
assignee: "ttraenkler/claude-dev-6793"
branch: "claude/issue-6793-linear-silent-demote"
priority: high
horizon: l
feasibility: hard
reasoning_effort: high
task_type: planning
area: codegen
language_feature: compiler-internals
goal: compiler-architecture
related: [6778, 1868, 3908, 1975, 1976, 3922, 1860, 1859]
requested_by: ttraenkler/claude-review
origin: "2026-09-30 codebase review (plan/agent-context/claude-codebase-review-2026-09-30.md) — H12/H13/H14"
---

# #6793 — the linear backend is advertised, unmaintained, and silently wrong

## Findings (measured 2026-09-30, HEAD e303c5c7)

**Silent wrong results.**

| source (`target: "linear"`) | linear | gc/legacy | gc/IR | JS |
|---|---|---|---|---|
| `const a=[1,2]; const v=a[5]; v===0 ? 100 : 1` | `100` | `1` | `1` | `1` |

`src/codegen-linear/runtime.ts:1068-1084` (`__arr_get`): "OOB … returns 0.0,
the backend's undefined representation"; `src/codegen-linear/index.ts:2498`:
"use f64.const 0 as sentinel for undefined". Every `undefined` vs `0`
distinction (`=== undefined`, `?? default`, `typeof`, `in`, holes) is wrong by
construction. 11 other probe cases (−0, `%`, NaN, `|0`, OOB-store length,
finally, i32 wrap, shift) agreed across lanes.

**Swallowed compiler bugs.** `src/ir/backend/linear-integration.ts:1344-1357`
catches every throw from the IR build stage; `rethrowLinearOwnerInvariant`
(`:272-276`) rethrows only `IrPlanningIdentityInvariantError`. A bare
`TypeError` **or an `IrInvariantError`** is demoted, and
`src/codegen-linear/index.ts:366-380` compiles the function on the direct
path with no diagnostic (`rejections`, `:1496`, is read only by coverage
tooling). The WasmGC lane hard-errors the same case (`src/ir/outcomes.ts:96-120`,
`src/codegen/index.ts:2390-2404`). Lowering-stage throws do rethrow
(`:1568-1580`); the build stage is the hole.

**Invalid binaries with `success: true`** — #6778 (mixed `+`), and the
`collectLinearCodegenErrors` claim in `src/compiler.ts:1025-1027`.

**Maintenance / enforcement.** Shallow clone of 918 commits
(2026-09-06 → 09-30): `src/codegen-linear` **0** commits, `src/ir` 16,
`src/codegen` ~330. `linear-tests` runs (`ci.yml:838`) but is not required
(`docs/ci-policy.md:911`); `cross-backend-parity.yml:12-27` is explicitly
"NOT a required check" over a 29-program corpus (6 flagged
`expectLinearUnsupported`). On the playground corpus the linear target
compiles **0 / 13** files (210 clear `ctx.errors`: `.appendChild`,
`console.log`, `await`, `toFixed`, …). README's FAQ says the project "keeps a
linear-memory backend for WASI-oriented targets"; `src/index.ts:526` maps
`wasi` to WasmGC, and linear is only reachable as `target: "linear"`.

## Decision required

**Status 2026-10-02: still OPEN.** Not decided in the either-way PR
(`claude/issue-6793-linear-silent-demote`); the (a)/(b) call is the project
lead's. The issue stays `in-progress` until it is recorded here with its date
and who made it.

- **(a) Staff it.** Fix #6778 and the `undefined` representation (tagged or
  NaN-boxed slot), route every IR-overlay throw through `classifyIrFailure`
  and hard-error invariants like the gc lane, make `linear-tests` and
  `cross-backend-parity` required, grow the parity corpus with the review
  probes.
- **(b) Label it experimental.** `--target linear` prints an experimental
  warning, README/FAQ/docs stop implying WASI parity, the parity workflow is
  kept advisory but its corpus gets the `undefined` row so the gap is
  measured, and #1860/#1859 (naming, module READMEs) are closed as won't-fix
  until (a) is chosen.

Either way, the silent-demote catch (`linear-integration.ts:1344-1357`) is
fixed now: an untyped throw is a compiler bug and must surface as an error.

## Acceptance

- This issue records the decision, its date, and who made it.
- `linear-integration.ts` build-stage catch rethrows anything that is not
  `IrUnsupportedError`; a test injects a `TypeError` into a build hook and
  asserts a compile error.
- Parity corpus contains the `undefined`-vs-`0` row and mixed `+`.
- Under (b): CLI warning text present; README FAQ and `docs/cli.md` updated.

## Implementation Plan

Scope (orchestrator decision, 2026-10-02): only the work this issue says
happens **either way**. The (a)/(b) decision, the `undefined` representation,
CLI warning text and README/`docs/cli.md` claims are deliberately NOT touched —
they belong to the pending decision.

1. **Build-stage catch** — `src/ir/backend/linear-integration.ts` (the path in
   the dispatch brief, `src/codegen-linear/linear-integration.ts`, does not
   exist; the catch is in `compileLinearIrFunctions`' build fixpoint loop).
   The catch keeps the `IrPlanningIdentityInvariantError` rethrow, then
   classifies with `classifyIrFailure(e, "build")` exactly as the WasmGC lane
   does (inlined, no new helper, so the god-file does not grow). An
   `invariant` outcome (an `IrInvariantError`, or any untyped throw →
   `unexpected-internal-throw`) is rethrown as an `IrInvariantError` carrying
   the original code, stage and cause, with message
   `linear-ir: IR build of <fn> hit invariant <code>: <detail>`; `compile()`
   turns it into `success: false` + `Codegen error: …`. Only an
   `IrUnsupportedError` is recorded in `lastFailure` and kept pending for the
   fixpoint retry (unchanged behaviour for typed demotes).
2. **Regression test** — `tests/issue-6793-linear-build-stage-throw.test.ts`.
   ESM namespace exports cannot be `vi.spyOn`-ed, so `lowerFunctionAstToIr`
   (the only build hook, single call site in the loop) is wrapped with a partial
   `vi.mock` that throws only for an armed function name (the pattern of
   `tests/issue-4113-ir-final-allocation-provenance.test.ts`). Cases: control
   (victim IR-compiles), injected `TypeError` → hard error, injected
   `IrInvariantError` → hard error keeping its code, injected
   `IrUnsupportedError` → demotes to the direct path, module validates and runs.
3. **Parity corpus** — `tests/cross-backend/corpus.ts` + harness
   `tests/cross-backend-diff.test.ts`. The runner had NO expected-divergence
   mechanism: an unflagged divergence fails, and `expectLinearUnsupported` only
   covers programs that do not compile on linear. Skipping was not acceptable,
   so a per-call `expectLinearDivergence: "<issue>"` flag was added with the
   same ratchet direction: the harness asserts the call STILL diverges (so the
   advisory `cross-backend-parity` check stays green on main) and fails —
   prompting flag removal — once linear agrees. Rows added: `undefined/vs-zero`
   (8 calls: 3 agree and are diffed normally, 5 flagged), `undefined/typeof`
   and `undefined/nullish-default` (`expectLinearUnsupported`: linear rejects
   `typeof` and `??` at compile time). Mixed `+` was already present
   (`string/mixed-plus`, #6778).

## Resolution (either-way part, 2026-10-02 — decision still open)

Measured on `db906b6007` (origin/main) vs this branch.

**Injected build-stage throw** (`tests/issue-6793-linear-build-stage-throw.test.ts`):

| injected into `lowerFunctionAstToIr(victim)` | before | after |
|---|---|---|
| `TypeError` | `success: true`, silent demote, no diagnostic | `success: false`, `Codegen error: linear-ir: IR build of victim hit invariant unexpected-internal-throw: …` |
| `IrInvariantError("selection-preparation-mismatch")` | `success: true`, silent demote | `success: false`, same code in the diagnostic |
| `IrUnsupportedError("body-shape-rejected")` | demotes, runs | demotes, runs (unchanged) |

Before the fix the test file is 2 failed / 2 passed; after, 4 / 4 passed.

**Census before the fix** (temporary log-only instrumentation of the catch,
not committed): across all `tests/linear-*`, `tests/issue-*linear*` and
`tests/cross-backend-diff.test.ts`, the build-stage catch fired 45 times, all
typed `IrUnsupportedError` — 0 untyped, 0 invariant. `check:linear-ir` over the
13-file playground corpus fired it 0 times (every rejection is select-stage).
So the fix changes no existing linear compile; it closes the hole for future
throws.

**Parity rows** (gc = WasmGC; every gc value equals Node's):

| call | gc | linear | flag |
|---|---|---|---|
| `let x: number\|undefined; x === undefined` | 1 | 1 | diffed |
| `let x; x === undefined` | 1 | 1 | diffed |
| `isUndef()` (omitted optional param) | 1 | 1 | diffed |
| `const v = [1,2][5]; v === 0 ? 100 : 1` | 1 | **100** | `expectLinearDivergence` |
| `const x: number\|undefined = 0; x === undefined` | 0 | **1** | `expectLinearDivergence` |
| `let x: number\|undefined; x === 0` | 0 | **1** | `expectLinearDivergence` |
| `isUndef(0)` | 0 | **1** | `expectLinearDivergence` |
| `const x: number\|undefined = 0; x == null` | 0 | **1** | `expectLinearDivergence` |
| `typeof x === "undefined"` | 1 | compile error | `expectLinearUnsupported` |
| `x ?? 7` / `0 ?? 7` | 7 / 0 | compile error | `expectLinearUnsupported` |

**Tests** (single fork): linear + cross-backend set before 339 passed / 4
failed / 1 skipped; after 346 passed / 4 failed / 1 skipped. The 4 failures
are pre-existing on `db906b6007` with the unmodified source
(`issue-3497-linear-jsdoc-landing-signatures` ×1, `issue-3500-linear-ir-recursive-call-graph-type-evidence`
×3 — all three are invalid linear binaries emitted with `success: true`,
`f64.eq`/`f64.le` on an i32 local in `recur`) and are not touched here.

**Left out (pending the decision):** the `undefined` representation, CLI
experimental warning, README/FAQ/`docs/cli.md`, making `linear-tests` /
`cross-backend-parity` required, and the pre-seed signature `catch {}` earlier
in `compileLinearIrFunctions` (it only skips signature pre-seeding; the same function
still goes through the build stage, which now surfaces its throw).

