---
id: 4736
title: "ES2015 Promise.resolve thenable host fulfillment"
status: done
completed: 2026-08-25
sprint: current
created: 2026-08-25
updated: 2026-08-25
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen, promises
es_edition: es2015
language_feature: promise-resolve
goal: spec-completeness
depends_on: []
related: [4727, 4734, 4735]
source_cap: 180
loc-budget-allow:
  - src/runtime.ts
func-budget-allow:
  - src/runtime.ts::buildImports
files:
  - src/runtime.ts
  - tests/issue-4736.test.ts
---

# #4736 — Promise.resolve thenable host fulfillment

## Scope and dependency

This slice owns the exact `built-ins/Promise/resolve/resolve-thenable.js`
protocol in the JS-host and standalone targets: a thenable's `then` callback
must be invoked and the resulting promise must fulfill with the original object
identity. Self-resolution (#4727), capability-constructor resolution (#4734),
custom-then identity (#4735), subclasses/species, and Promise combinators are
explicitly excluded. The fix starts from current `upstream/main`
(`627013f0f`); no #4951 dependency is currently required because this residual
does not use the self-resolution or capability paths.

## Measured baseline

The authoritative `runTest262File` harness was run against current
`upstream/main` (`627013f0f`) with a 60-second per-file timeout. The target is
host-only broken while standalone is already green. The two non-thenable rows
are identity controls; the foreign-thenable row is a minimal scheduling and
receiver control:

| Test262 row | Host baseline | Standalone baseline |
| --- | --- | --- |
| `built-ins/Promise/resolve/resolve-thenable.js` | **fail**, `Test262:AsyncTestFailure:Test262Error: The promise should be fulfilled with the provided value.`, `wasm_sha=c20fb3a07a7d` | **pass**, `wasm_sha=7a91c63b3276` |
| `built-ins/Promise/resolve/resolve-non-thenable.js` | pass, `wasm_sha=60848ce6f601` | pass, `wasm_sha=cedc012d8a5d` |
| `built-ins/Promise/resolve/arg-non-thenable.js` | pass, `wasm_sha=5e6d974bdf65` | pass, `wasm_sha=dd64495e7951` |
| `built-ins/Promise/resolve/S25.Promise_resolve_foreign_thenable_2.js` | **fail**, `Expected SameValue(«3», «4») to be true`, `wasm_sha=2eab4b950ac7` | pass, `wasm_sha=dc291f619130` |

The host result is the bug reproduction; the standalone pass is a positive
control for the same thenable protocol and object-identity assertion.

The host-only failures share the host boundary: the Wasm object-literal
thenable reaches the `Promise_resolve` import in `src/runtime.ts` as a raw
WasmGC struct. V8 cannot observe its callable `then` field, so native
`Promise.resolve` fulfills with the opaque thenable carrier (or invokes the
wrong receiver in the foreign-thenable control). Standalone uses the existing
Wasm Promise substrate and does not cross that boundary.

## Plan

1. Trace the host Promise.resolve thenable path from the exact Test262 harness
   through the `Promise_resolve` import and the existing host combinator
   thenable mirror, confirming where the fulfilled value loses the thenable's
   original object identity.
2. Wire the narrowest host-only correction by reusing that mirror for
   `Promise_resolve`, preserving the existing standalone thenable substrate and
   excluding self-resolution, capability, custom-then, subclass, and
   combinator paths. Keep production growth at or below 180 net lines.
3. Add focused equivalence controls for a non-thenable value and a thenable
   whose callback resolves with an object, covering both host and standalone
   lanes without broad Promise-family changes.
4. Re-run the exact official target and controls, then run TS5, TS7, lint,
   format, hooks, and the focused tests before merging latest upstream without
   rebasing or force-pushing.

## Implementation and Test Results

The host `Promise_resolve` import now applies the existing `_wrapForHost`
thenable mirror before calling native `Promise.resolve`. It wraps only WasmGC
structs whose `then` field is callable; primitives, ordinary objects, and
non-thenable structs remain raw, preserving `===` identity. The standalone
codegen path is unchanged. The production diff is 18 insertions and 21
deletions (net -3 lines), well below the 180-line cap.

After the fix, the exact target and all three controls pass in both lanes. The
focused `tests/issue-4736.test.ts` suite passes 8/8 tests. Direct quality
checks also pass: TypeScript 5 (`tsc --noEmit`), TypeScript 7
(`tsc --noEmit -p tsconfig.ts7.json`), Biome lint, and Prettier check. The
repository pnpm wrappers could not run in this linked-dependency worktree
because pnpm attempted to remove `node_modules` without a TTY; the equivalent
direct binaries were run, and the pre-commit/pre-push hooks are run before
publication.

## Acceptance and non-goals

- The exact `resolve-thenable.js` target passes in both host and standalone.
- Minimal non-thenable and thenable/object-identity controls remain passing in
  both lanes.
- No behavior changes are made to self-resolution, capability constructors,
  custom-then identity, subclasses/species, or combinators.
- Production source growth is no more than 180 net lines.
