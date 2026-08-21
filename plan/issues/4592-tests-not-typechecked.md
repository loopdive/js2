---
id: 4592
title: "No CI gate typechecks tests/ — 5,200 type errors across 2,274 files, and every @ts-expect-error in the suite is decorative"
status: ready
created: 2026-08-19
updated: 2026-08-19
priority: medium
feasibility: medium
reasoning_effort: high
task_type: infra
area: ci
language_feature: compiler-internals
goal: dogfood
sprint: current
horizon: l
model: opus
related: [3008, 3954, 4551]
# id 4592 reserved via claim-issue.mjs --allocate --allow-unscanned on
# 2026-08-19 (gh CLI absent in this container; pr_scan=degraded). Equivalent
# open-PR scan performed via the GitHub MCP at reservation time: the only open
# PRs were 4681, 4682 (Prepared-IR cutovers for the EXISTING issues #4590/#4591)
# and 4683 (npm-compat watchdog) — none adds an issue file.
---

# #4592 — `tests/` is typechecked by nothing

## The gap

There are two tsconfigs and neither covers the test suite:

- `tsconfig.json` — `include: ["src/**/*.ts"]`, `exclude: [… "tests"]`
- `tsconfig.ts7.json` — `extends: "./tsconfig.json"`, overriding neither

and there is no `typecheck:tests` script. `pnpm run typecheck` (the `quality`
lane's) therefore compiles `src/` only. Nothing anywhere else picks the suite up:
`vitest` transpiles per-file without type-checking, and biome lints without types.

## Why it matters more than "tests have some type errors"

**An `@ts-expect-error` that no lane compiles cannot fail.** Its whole purpose is
to go red when the thing it expects stops erroring — that is the assertion. In a
tree where nothing typechecks tests, every such marker is a comment.

This was found while writing the #3954 phase-3 falsification, whose
`tests/issue-3954-phase3-nonjs-domain.test.ts` uses exactly that idiom to pin the
**one-directional brand** finding (`JsTag → TagId` blocked, `TagId → JsTag` free).
That pin is the record of a real, still-open hole in the tag seam, and today it
is documentation rather than an enforced assertion. It is not the only one —
`@ts-expect-error` appears throughout the suite.

Same failure family as the gates this project already treats as load-bearing: a
check whose outcome is indistinguishable from "passed" when it never ran.

## Measured, 2026-08-19, on `main` at `6e24af546`

Compiled `src/**/*.ts` + `tests/**/*.ts` with the repo's own `compilerOptions`
(dropping only `rootDir`/`outDir`/`declaration*`/`incremental`, which are
emit-shaped and irrelevant to `--noEmit`):

| | count |
| --- | --- |
| errors in `tests/` | **5,200** |
| test files affected | **2,274** |
| errors in `src/` | **0** |

`src/` at zero is the useful control: this is test-only debt, not a tree-wide
regression, and the `quality` typecheck lane is doing its job on what it covers.

**The debt is far more concentrated than the raw count suggests.** By error shape:

| shape | count | note |
| --- | --- | --- |
| `Property 'X' does not exist on type 'X'` | 1,921 | **1,325 files are ONE root cause** — see below |
| `Argument of type 'X' is not assignable to parameter 'X'` | 1,568 | |
| `No overload matches this call` | 660 | largely the same instantiate call |
| `An import path can only end with '.ts' …` | 412 | config, not debt — `allowImportingTsExtensions` |
| `Could not find a declaration file for module 'X'` | 144 | `.mjs` scripts imported from tests |
| everything else | ~495 | long tail |

### The single dominant cause

**1,325 test files** produce `Property 'instance' does not exist on type
'Instance'` at a line of the shape:

```ts
const { instance } = await WebAssembly.instantiate(result.binary, imports);
```

`WebAssembly.instantiate` is overloaded: `(BufferSource, …) =>
Promise<WebAssemblyInstantiatedSource>` (which HAS `.instance`) and
`(Module, …) => Promise<Instance>` (which does not). Resolution is picking the
second. `CompileResult.binary` is declared `Uint8Array` (`src/index.ts:214`), so
this is an overload/lib-generics question (`Uint8Array<ArrayBufferLike>` vs
`BufferSource`/`ArrayBufferView<T>`), not 1,325 independent mistakes.

Settling that one signature plausibly clears ~37 % of the total. **The number to
act on is the count of distinct root causes, not 5,200** — and nobody currently
knows what that number is, because the compiler has never been pointed at these
files.

## Scope

Enforcement and measurement. No behaviour change, no conformance delta.

1. A `tsconfig.tests.json` + `typecheck:tests` script covering `tests/**/*.ts`,
   with `allowImportingTsExtensions` set so the 412 TS5097s are not counted as
   debt they are not.
2. Triage by **shape**, not by file. Fix the instantiate signature first and
   re-measure before planning anything else — the remaining distribution after
   that fix is the real input to this issue's plan.
3. A **ratchet**, in the shape this repo already uses (committed baseline,
   growth fails, `--update-on-decrease` banks improvements), wired into
   `quality`. A 5,200-error tree cannot go green in one PR, and a gate that
   cannot be turned on is worth nothing.
4. Once the ratchet exists, `@ts-expect-error` becomes enforceable again. Say so
   explicitly in the gate's output, because that — not the error count — is the
   property being restored.

## Acceptance criteria

- `pnpm run typecheck:tests` exists, runs in `quality`, and reports a count.
- A committed baseline; growth fails the gate, naming the file.
- The instantiate root cause is fixed or explicitly deferred with a reason.
- A stated count of distinct root causes behind the residual, replacing the raw
  5,200 as the tracking number.
- No change under `src/` that moves emitted bytes.

## Explicitly not in scope

- Fixing all 5,200. The ratchet is the deliverable; the backlog is drained
  against it over time, the same way `check:ir-fallbacks` and
  `check:oracle-ratchet` work.
- The **runtime** rot backlog in the same suite. `issue-tests.yml` (#3008)
  already baselines known-failing root tests post-merge, and ~40 % of sampled
  files are in it. That is a *behaviour* backlog with an owner; this issue is
  about *types*, which no lane covers at all. Do not conflate them — but the
  precedent is directly reusable, and #3008's two-layer design
  (post-merge detector + per-PR fix-on-touch) is the model to copy.
