---
id: 6793
title: "linear backend: `undefined` is `0` (silent wrong results), the IR overlay swallows compiler throws as silent demotes, 0 commits in the last ~900, nothing required in CI — decide its fate"
status: ready
sprint: Backlog
created: 2026-09-30
updated: 2026-09-30
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
