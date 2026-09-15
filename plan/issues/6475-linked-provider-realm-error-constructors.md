---
id: 6475
title: "Linked provider rebuilds its own env, so it resolves different error constructors than the consumer's realm"
status: done
sprint: current
created: 2026-09-14
updated: 2026-09-15
completed: 2026-09-15
priority: high
horizon: l
feasibility: hard
reasoning_effort: max
task_type: bug
area: runtime
language_feature: module-linking
goal: test262-conformance
depends_on: [3451]
related: [3451, 2527, 5225, 5226]
# id reserved 2026-09-14 with pr_scan="degraded" (gh unreachable): verified
# against upstream main + the assignment ref, NOT against in-flight PRs.
---

# #6475 — a linked provider does not share the consumer's realm intrinsics

## Problem

`assert.throws(TypeError, fn)` fails from inside a linked harness provider with

```
Expected a TypeError but got a different error constructor with the same name
```

Measured 2026-09-14 across 404 rows of the #3451 slice-3 sample: **~32 rows**,
the second-largest residual class after async completion (#6476). Affected
constructors: `TypeError`, `ReferenceError`, `SyntaxError`, `RangeError`.

## Where it comes from

`buildProviderImportObject` (`src/linked-provider-runtime.ts`) builds the
provider's import object as

```ts
env: { ...(overrides?.env ?? {}), ...built.env },
```

— **provider-owned wrappers win over the inherited root ones**, deliberately,
because the adapter carries per-instance callback/host state.

The test262 runner installs a **fresh per-test realm** (`scripts/test262-sandbox-globals.mjs`):
the consumer's `TypeError` is that realm's. The provider's `env` is rebuilt from
its own metadata and therefore resolves the *ambient* intrinsics. Two
constructors, same name, not `===`.

This is invisible outside a linked graph, and invisible inside one unless the
embedder swaps realm intrinsics — which is exactly what the runner does. A
micro-probe with a plain import object does NOT reproduce it; the runner's
sandbox is load-bearing for the repro.

## Constraint a fix must respect

The precedence is not arbitrary. Letting the ROOT `env` win wholesale would hand
the provider the consumer's per-instance callback/host state, which is the bug
that comment was written to prevent. The answer is likely a *split*: realm
INTRINSICS (error constructors, `Object`, `Array`, …) inherited from the root,
per-instance ADAPTER state kept provider-owned.

## Acceptance criteria

- [x] A native error thrown in a linked consumer satisfies
      `assert.throws(<NativeError>, …)` evaluated in the provider — all four of
      `TypeError`/`RangeError`/`ReferenceError`/`SyntaxError`, in
      `tests/issue-6475-linked-provider-realm.test.ts`, against a real second
      realm (`vm.createContext` over the runner's own `SANDBOX_GLOBAL_NAMES`).
      The same file asserts the repro still FAILS without `linkedHost`, with
      the issue's exact message.
- [x] The per-instance adapter state the current precedence protects is still
      provider-owned — the guarding assertions are the #3451 substrate ones
      (`tests/issue-3451-linked-harness-substrate.test.ts`: "assert.throws
      (Test262Error, …)", "e instanceof Test262Error", "callback identity");
      they are re-run WITH the host context in the new file's
      "provider-owned adapter state survives the host context" case, and the
      substrate file itself is unchanged and green.
- [x] The Temporal provider lane (#5353) shows no verdict change —
      `tests/issue-5353-sharded-temporal-lane.test.ts`,
      `tests/issue-5248-test262-temporal-wiring.test.ts` and
      `tests/issue-5225-consumer-literal-seam.test.ts` all green (35 tests with
      the two #3451 files). Scope note: that is the lane's own test coverage,
      not a Temporal test262 corpus run.
- [x] The ~32 rows in the #3451 slice-3 sample flip to agreement — re-measured
      2026-09-15, real worker, both lanes at this commit: **0** rows in this
      class, total differences 109/404 → 21/399 (#3451, "Re-measured
      2026-09-15").

## Implementation Plan (2026-09-14, Fable lane; implementation: Opus) — shared with #6476

Root cause, precisely: `buildProviderImportObject` (`src/linked-provider-runtime.ts`)
builds the provider's `env` with `buildCompiledImportsRuntime(providerResult)`
— **no `deps`, no `options`** — while the consumer's import object was built by
the worker as `buildImports(result.imports, { console: consoleProxy },
stringPool, { globalSandbox: harnessSandbox })` (`scripts/test262-worker.mjs`
~L2027). So the provider's wrappers resolve intrinsics from the ambient realm
(`globalSandbox` undefined → `fallback` at `src/runtime.ts:11074`) and print to
the real console. The precedence rule (`built.env` wins) is correct and stays;
what is missing is the **host context** at build time.

1. **`src/linked-provider-runtime.ts`** — add an optional third argument to
   `instantiateLinkedProviders(artifacts, rootImports, host?: LinkedProviderHost)`
   with `interface LinkedProviderHost { deps?: Record<string, unknown>; options?: BuildImportsOptions }`
   (import the `BuildImportsOptions` type from `./runtime.js`). Thread it into
   `buildProviderImportObject(artifact, overrides, host)` and call
   `buildCompiledImportsRuntime(providerResult, host?.deps, host?.options)`.
   No change when `host` is absent (every existing caller).
2. **`scripts/test262-import-object.mjs`** — `instantiateTest262Module(binary,
   importObj, options)` gains `options.linkedHost` and forwards it:
   `instantiateLinkedProviders(linkedModules, importObj, options.linkedHost)`.
3. **`scripts/test262-worker.mjs`** — where the linked lane calls
   `instantiateTest262Module`, pass
   `linkedHost: { deps: { console: consoleProxy }, options: { globalSandbox: harnessSandbox } }`
   — the SAME two values the consumer's `buildImports` received on that row.
   The `providerLabel`/runtime-eval provider attachment stays as is.
4. **Tests** — `tests/issue-6475-linked-provider-realm.test.ts`: build the
   harness provider (`assert.js + sta.js`), compile a body
   `assert.throws(TypeError, function () { null.x; });` and one each for
   `RangeError`/`ReferenceError`/`SyntaxError`, instantiate through
   `instantiateTest262Module` with a `globalSandbox` whose `TypeError` etc. are
   fresh subclasses (mirroring `scripts/test262-sandbox-globals.mjs`) — the
   row must PASS with the host and FAIL without it (prove the repro, then the
   fix). Add a case asserting the provider's adapter state is still its own:
   a provider callback registered through the provider's exports must not be
   visible through the consumer's (name the exact assertion from
   `tests/issue-5225*` or `tests/issue-5353*` that guards this today and
   reuse it).
5. **Measure** with the real worker: the #3451 slice-3 sample dirs
   (`built-ins/Object/defineProperty`, `language/expressions/class`,
   `built-ins/Promise/prototype/then`, `language/statements/with`, plus
   `Array/prototype/map` + `for-of`), honest vs `TEST262_ORACLE_MODE=linked`
   at the same commit, per-test diff. Record the new difference count and the
   class breakdown in #3451 under "Slice 3 measurements" (append a dated row).
   Expected: the ~32 native-error rows AND the 49 async rows (#6476, same
   mechanism: `$DONE → print → console.log` now reaches the row's console
   proxy) flip to agreement.

Acceptance is the issue's list plus: honest lane byte-identical
(`tests/issue-3451-linked-harness-lane.test.ts` still green), Temporal lane
tests (`tests/issue-5353*`, `tests/issue-5248*`) unchanged.
