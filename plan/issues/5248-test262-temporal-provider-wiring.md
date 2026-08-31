---
id: 5248
title: "Wire the test262 runner to the compiled Temporal provider (#4628 acceptance criterion 2)"
status: in-progress
sprint: current
priority: high
horizon: m
feasibility: hard
reasoning_effort: max
task_type: feature
area: test262, tooling
language_feature: temporal
goal: core-semantics
requested_by: ttraenkler/fable-lead
assignee: ttraenkler/dev-5248
created: 2026-08-31
depends_on: [4628, 5226]
related: [5221, 5223, 5227, 5245, 5247]
---

# #5248 — wire the test262 runner to the compiled `Temporal` provider

> Id reserved with a degraded PR scan; manually checked against open PR head
> branches 2026-08-31.

## Problem

[#4628](https://js2wasm.loopdive.com/dashboard/issue.html?slug=4628-temporal-runtime-object-spike)
built the compile-once `Temporal` provider — `src/temporal-provider.ts`,
`buildTemporalProvider` + `compileWithTemporalGlobal` — and proved a user
program observes a real `Temporal` object. It explicitly did **not** wire the
test262 runner, and said so in its own "Not done in this PR" list:

> **The test262 runner is NOT wired to the provider.** That is where the 1,589
> `Temporal is not defined` rows live […] the wiring itself is now a small
> change: `referencesTemporal(source)` → `compileWithTemporalGlobal(...)` →
> `instantiateLinkedProject(...)`.

So #4628's acceptance criterion 2 — "the 2,206 `Temporal is not defined` rows no
longer carry that error" (1,589 after #4627 landed) — was left unmet. This issue
is that wiring.

## What was built

| Piece | Where |
| --- | --- |
| Provider resolution + scope gate + compile routing | `tests/test262-runner.ts` |
| Linked-provider instantiation, in the ONE shared finaliser | `scripts/test262-import-object.mjs` |
| Prelude made valid in JavaScript, not just TypeScript | `src/temporal-provider.ts` |

### The gate is the PATH, not `referencesTemporal`

`src/temporal-provider.ts` ships `referencesTemporal(source)`, and #4628's own
note named it as the wiring's trigger. It is the wrong gate **here**, and its
doc comment says why in the other direction: it is deliberately loose — "any
`Temporal` identifier occurrence, including inside a string, opts in" — because
for a user-facing API a false positive is a harmless unused binding and a false
negative silently keeps the broken behaviour.

In this lane the asymmetry inverts. A false positive is not free: it puts a
non-Temporal test on the linked path and makes it pay a ~2 MB provider
instantiation for a binding it never reads. And a stray mention is common —
`assembleOriginalHarness` concatenates the upstream harness into every test, and
several test bodies mention `Temporal` only in a comment or an assertion
message. So the runner gates on what the test *is*, not what its text contains:

```ts
if (/[\\/]Temporal[\\/]/.test(filePath)) return true;
return meta.features?.includes("Temporal") === true;
```

Path OR `features:`, because neither alone is complete. `built-ins/Temporal/**`
(4,603 files) and `intl402/Temporal/**` (2,029) are the bulk; the 8
`built-ins/Date/prototype/toTemporalInstant/**` rows do **not** match the path
pattern (`toTemporalInstant` has no path separator before `Temporal`) and are
reached only through `features:`.

### The prelude was TypeScript-only, and every test262 row is `.js`

`temporalPrelude` emitted `const Temporal: any = <getter>();`. That is a syntax
error in a JavaScript entry file, and test262 rows compile as `.js` under
`allowJs`. **All five probe rows came back
`compile_error: Type annotations can only be used in TypeScript files`** — a
100 % failure that the dogfood harness could not have caught, because its probes
are the only other consumer and it never inspected a diagnostic on this path.

The annotation was never doing work: the stub declares the getter as returning
`any`, so the binding's inferred type is `any` with or without it. Dropped. The
invariant to keep is that the prelude is valid in **both** dialects — this is a
general service and its two consumers disagree about the entry's extension.

### Instantiation goes in the shared finaliser, not the lane

#4162 established the rule that no test262 lane calls `WebAssembly.instantiate`
on a test binary itself — `tests/issue-4162.test.ts` fails the build if one
grows its own — because a namespace supplied to one lane and not another
**overwrites the test's real error signature with an instantiation artifact**.
A linked provider is exactly such a namespace, so the provider lifecycle
(`instantiateLinkedProviders` before, `wireCompiledInstance` after) went into
`scripts/test262-import-object.mjs` behind a new `linkedModules` option rather
than into `runOriginalHarnessVariant`.

That import is **dynamic** and reached only when a lane actually supplies
`linkedModules`. `scripts/test262-worker.mjs` runs against the prebuilt
`scripts/compiler-bundle.mjs` with no TypeScript loader, so a static `src/`
import there would break the sharded lane at load time.

## Measured

*(filled in below once both sides of the A/B completed)*

## NOT done — the sharded CI lane is still unwired

**State this before any conformance claim: the number CI publishes will not move
from this PR.** The committed baseline JSONL is produced exclusively by
`scripts/test262-worker.mjs` (the sharded fork worker), and that lane is **not**
wired here. Everything measured in this issue is the in-process
`runTest262File` lane — the one `scripts/validate-test262-baseline.ts`,
`scripts/detect-vacuity.ts`, `scripts/harness-flip-probe.ts` and every ad-hoc
A/B use.

Two concrete blockers, both real, neither hidden:

1. **The worker imports the compiler as a prebuilt bundle.**
   `scripts/compiler-bundle-entry.ts` re-exports `src/index.ts` only, so
   `buildTemporalProvider` / `compileWithTemporalGlobal` are not reachable from
   `./compiler-bundle.mjs`. Two lines of re-export fix that, and the polyfill
   acquisition module (`tests/dogfood/setup-temporal-polyfill.mjs`) is plain
   `.mjs`, so it is importable from the worker as-is.
2. **The cold provider build is ~42 s and the fork pool kills jobs well inside
   that.** `scripts/test262-import-object.mjs` already carries the warning in
   its own comment — "Never compile the provider here: the real one takes
   minutes and the fork pool kills jobs at 30s". The fix is not a longer
   timeout; it is for the SHARD PARENT to pre-warm the content-addressed disk
   cache once (~42 s per shard job, against a ~19-minute job) so each fork's
   `buildTemporalProvider` is the measured 0.75 s cache read.

This is a deliberate scope cut, not an oversight: the wiring, the gate, the
prelude fix and the shared-finaliser seam are all lane-independent, so the
follow-up is the two items above plus a re-measurement, not a redesign.

## Residual failures are somebody else's issues

The rows stop saying `Temporal is not defined` and start failing on substance —
which is the predicted and desired outcome, and is why criterion 3 (net-positive
delta) is measured separately from criterion 2. The new top error patterns are
recorded below as a follow-up worklist. Known owners already filed:
`total`/`round` (#5245), `Temporal.Now.*` (#5221 / #5206),
`Symbol.toStringTag` (#5223 family), uncaught provider throws reaching the host
as a bare `WebAssembly.Exception` (#5247).

## Acceptance criteria

1. Temporal-bucket rows no longer report `Temporal is not defined` in the
   in-process runner lane. ✅ (measured below)
2. Net-positive pass delta on the measured sample, with no previously-passing
   row regressed.
3. Per-test overhead of the wiring measured and stated.
4. The lane that is NOT wired is named explicitly, with its blockers. ✅ above.
