---
id: 5364
title: "Cross-module decoder registry is process-global — a second linked project against the same provider binary resolves its instances through the FIRST project's exports (every batched `instanceof` count for Temporal is inflated)"
status: in-progress
assignee: ttraenkler/dev-5364
sprint: current
priority: high
horizon: m
goal: core-semantics
reasoning_effort: high
requested_by: ttraenkler/fable-lead
created: 2026-09-06
# 2026-09-06 (#5364). This PR's own runtime growth is ~30 LOC in src/runtime.ts
# (the exported `resetLinkedProjectRegistry` + the comment that says WHY the
# reset happens before instantiate rather than after teardown). The rest of the
# figure the gate sees is INHERITED from the stack this branch merges (#5251 /
# #5354 / #5208 / #5363); those grants are restated below so CI's merge-preview
# base cannot strand them by dropping the granting issue file from the
# change-set.
loc-budget-allow:
  - src/runtime.ts
  # Inherited from #5354 (PR #5670) and, through it, #5251 (PR #5648).
  - src/codegen/index.ts
  - src/codegen/destructuring-params.ts
  - src/codegen/property-access-dispatch.ts
  - src/codegen/type-coercion.ts
func-budget-allow:
  # Inherited from #5354 / #5251 — no function in this PR's own diff grows.
  - src/runtime.ts::_wrapForHost
  - src/codegen/index.ts::generateModule
  - src/codegen/index.ts::generateMultiModule
  - src/codegen/destructuring-params.ts::destructureParamObject
  - src/codegen/property-access-dispatch.ts::finalizeStructAndDynamicMemberGet
  - src/codegen/type-coercion.ts::coerceType
---

# #5364 — the #5225 registry assumes ONE live linked project per process

## Problem

`src/runtime/cross-module-struct-owners.ts` (#5225) keeps a **process-global**
`modules` Set of every exports object ever registered through
`registerLinkedProviderModule` / `registerLinkedConsumerModule`, and never
unregisters one. Two instances of the SAME provider binary (the compile-once
Temporal provider, instantiated once per compiled test262 row) share canonical
WasmGC types, so instance A's `__struct_field_names` names instance B's struct.
`decoderFor` then answers a struct minted by project 2 with project 1's exports,
and `__class_object_of` (#5354, `_owningClassObject` in `src/runtime.ts`)
returns project 1's class-object singleton. The consumer's live `C` and the
instance's resolved constructor are two complete, internally consistent,
unrelated mirrors: `x instanceof C === false` while `x.constructor.name` reads
right.

Measured by dev-5363 (branch `issue-5363-thrown-error-seam`, deterministic):

- `.tmp/probe-solo-5363.mts` — `var x = d.add({days:1}); …` run ALONE in a fresh
  process: `inst=true protoIs=true ctorIs=true`.
- `.tmp/probe-bisect-5363.mts` — the byte-identical program after ten other
  linked programs in the same process: `inst=false protoIs=false ctorIs=false`,
  `cn=PlainDate`.
- Conformance: `intl402/Temporal/PlainDate/prototype/add/month-boundary-gregory.js`
  fails `endYesterdayNextDay: instanceof` inside the 123-row batch and, alone
  with the same driver + cache, fails on the NEXT layer instead
  (`Unsupported era name: gregory`, a polyfill-version gap).
- Instrumented in `_hostConstructorForInstance`: a program-2 struct resolved
  through registry index 0 (program 1's provider exports).

**Why this matters beyond the 123-row drivers:** `scripts/test262-worker.mjs`
runs MANY rows per fork (the `CompilerPool` recycles a fork only on FATAL), and
since #5353 every Temporal row instantiates the same provider binary in that
fork. So the published conformance number and every merge-group regression diff
carry the same contamination — a Temporal row's `instanceof` verdict depends on
which rows ran before it in the same fork. Every `: instanceof` bucket count
quoted so far (dev-5208's 22, dev-5354's 13, dev-5363's 23) is inflated and is
not a per-row compiler result.

Two fixes were tried on the #5363 branch and **reverted** — do not repeat them
without the Step-1 instrumentation below:

1. *Project-scoped registry* (tag each module with the instantiation's root
   import object; exclude peers of other projects) regressed the #5225
   consumer→provider route: `d.add({days:1})` → `TypeError: invalid
   duration-like` from the second program on — the provider could no longer
   decode a consumer-minted object literal.
2. *Newest-registered-first tie-break* in `decoderFor`: no effect, because stale
   exports ALSO arrive outside `decoderFor` — directly as a
   `callbackState.getExports()` captured by an import closure (traced through
   the Map/Set method bridge, `src/runtime.ts` ~L11361).

Not reproducible with a small class provider (`.tmp/probe-twoproject.mts`,
three back-to-back linked projects, all correct) — it needs the polyfill's
surface. Repro of record is the Temporal batch above.

## Implementation Plan (Fable, 2026-09-06)

Two deliverables, in this order. Ship (A) even if (B) takes longer — (A)
de-contaminates every future measurement AND the CI lane on its own.

**A. Interim, mechanical: a registry reset the row drivers call between
projects.**

1. `src/runtime/cross-module-struct-owners.ts` — add `reset(): void` that
   clears `modules`, sets `enabled = false`. The `owners` / `states` WeakMaps
   are keyed on per-instance objects and need no clearing, but state that in a
   comment rather than leaving it implied.
2. `src/runtime/linked-provider-mirror-ownership.ts` — the #5222 twin
   (`_linkedProviderMirrors`) holds provider exports the same way; give it the
   same `reset()` and check whether any other module-level singleton keyed on
   exports exists (`grep -n "registerProviderExports\|registerModule"`).
3. `src/runtime.ts` — export `resetLinkedProjectRegistry()` next to
   `registerLinkedProviderModule` (~L6156) that calls both resets. Re-export it
   from `scripts/runtime-bundle-entry.ts` — the worker holds its OWN runtime
   copy (`runtimeBundle`, #5353 finding 3); a reset in the compiler bundle's
   copy would be the same silent-wrong-copy bug that PR describes.
4. Call it **before each row's instantiate** at the two drivers:
   `scripts/test262-worker.mjs` (just before `instantiateTest262Module`, ~L2000
   — guarded `typeof runtimeBundle.resetLinkedProjectRegistry === "function"`,
   so an old bundle degrades to today's behaviour with a stderr announce, same
   shape as `temporalWiringAvailable`) and `tests/test262-runner.ts` (before
   the instantiate that follows `compileWithTemporalGlobal`, ~L4372). Also the
   `.tmp/bucket-run.mts` family drivers if they instantiate in-process.
5. Measure: the 123-row list (`issue-5249-fix/.tmp/family-123.txt`), provider
   linked, fresh cache, batch vs. one-row-per-process on the SAME compiler
   revision. Acceptance for (A): batch `: instanceof` count == solo count, and
   `month-boundary-gregory.js` fails on `Unsupported era name` in the batch.

**B. Root fix: scope the registry to a project, without breaking the
consumer→provider route.**

1. **Instrument attempt 1 before redoing it.** Log, in `decoderFor`, `(local,
   obj-owner-found, project-of-local, project-of-owner)` for the failing
   `d.add({days:1})` call. The likely cause: `wireCompiledInstance(imports,
   instance, linked)` registers the consumer AFTER the provider has already
   received the literal, or the consumer is registered under a different key
   than `rootImports` (the worker passes `linkedRuntime`; check which `imports`
   object `instantiateTest262Module` hands to `wireCompiledInstance`). State
   the answer in the PR with the log line.
2. Key projects on the **`rootImports` object identity**: `instantiateLinkedProviders`
   receives it (L220) and `wireCompiledInstance` receives the same object as
   `imports`. Keep `projects: WeakMap<WebAssembly.Imports, Set<exports>>` and
   `projectOf: WeakMap<exports, Set<exports>>`; `registerModule(exports,
   project)`; `decoderFor` iterates ONLY `projectOf.get(local)`. When `local`
   is `undefined` (host-originated read with no module context) fall back to
   the most recently created project, and say why in a comment.
3. The second staleness source (import closures capturing an old
   `callbackState`): those closures live in the old project's import object,
   so once `decoderFor` stops crossing projects they can only be reached by an
   object that genuinely belongs to the old project. Verify with the
   `probe-bisect` program that no cross-project answer remains; if one does,
   trace it and either fix or file it with the trace — do not widen this
   issue.
4. Keep the single-module lane byte-identical: with no project registered,
   `enabled` stays false and every read takes the existing path. Prove it with
   the #3903 hot-path guard already in the file's header comment (no new Wasm
   calls on `__extern_get` when `enabled === false`).
5. Tests: `tests/issue-5364-linked-project-scope.test.ts` — two linked
   projects from the same provider binary in ONE process, second project's
   instance `instanceof` its own `C` true, AND the #5225 route
   (`provider.fn({literal})` decoding a consumer literal) still passes in the
   second project. Base-failing for the first assertion under today's global
   registry; the second assertion is the regression guard for attempt 1.

**Order-preservation constraints.** `registerLinkedProviderModule` is called
unconditionally per provider (#5225 comment in `linked-provider-runtime.ts`
~L242) — keep that. `decoderFor`'s caching of NONE is load-bearing for the
`__extern_get` hot path (#3903) — do not remove it.

## Acceptance criteria

1. (A) landed: `resetLinkedProjectRegistry` exported from both bundles and
   called per row in the worker and the in-process runner; batch == solo on the
   123-row `: instanceof` count, numbers stated.
2. (B) landed or split into its own follow-up with the Step-1 log line quoted.
3. No new host import; single-module lane unchanged (equivalence gate at
   baseline).

## Notes

- Filed from dev-5363's measurement on PR for
  `issue-5363-thrown-error-seam` (#5363 verdict: reported defect does not
  exist; this is the real one).
- Related: #5225 (registry), #5222 (mirror ownership), #5354 (class identity),
  #5353 (worker runs rows in a long-lived fork — the CI exposure).
- Id reserved via `claim-issue --allocate --allow-unscanned` (gh unavailable in
  this container); open PRs hand-checked 2026-09-06 — highest in-flight issue
  file is #5363.
