---
id: 5364
title: "Cross-module decoder registry is process-global — a second linked project against the same provider binary resolves its instances through the FIRST project's exports (every batched `instanceof` count for Temporal is inflated)"
status: done
completed: 2026-09-06
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
# 2026-09-06 (#5364). host-import-policy `maximumRuntimeTsLines` 19313 -> 19337.
# Attributed by measurement, not by assumption: origin/main's src/runtime.ts is
# 19149 lines and this branch's is 19337 (+188), of which the INHERITED #5354 /
# #5251 stack is 164 — already inside the old 19313 ceiling. The 24 lines that
# actually need this grant are #5364's OWN: commit 1f3a520a64 is +24/-0 on
# src/runtime.ts (`resetLinkedProjectRegistry` and the comment explaining why the
# reset runs before instantiate rather than after teardown). 19313 + 24 = 19337,
# so the bump is exactly this PR's own diff and nothing else rides in on it.
# (The `~30 LOC` in the note above was an estimate written before the salvage;
# the measured figure is 24.) No host import is added or changed — the gate's
# per-family import counts are unchanged; only the line-count ceiling moves.
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

## Findings (dev-5364, 2026-09-06) — the registry is only HALF the leak

**(A) as specified does not meet its own acceptance criterion, and the reason is
worth more than the fix.** `resetLinkedProjectRegistry` is implemented, exported
and called per row from the ONE test262 instantiate seam
(`scripts/test262-import-object.mjs`, which BOTH drivers pass through — a single
call site that provably lands in the same runtime copy the project registers
into, rather than two hand-placed driver calls that can drift). Measured on the
123-row list with a fresh `JS2WASM_TEMPORAL_CACHE`, provider linked, one
compiler revision:

| lane                                     | `: instanceof` | pass | artifact                  |
| ---------------------------------------- | -------------- | ---- | ------------------------- |
| batch, no reset (base)                    | 23             | 13   | `.tmp/batch-no-reset.tsv`  |
| batch, registry reset ONLY                | 23             | 13   | `.tmp/batch-with-reset.tsv`|
| batch, BOTH resets                        | **0**          | 27   | `.tmp/batch-fixed.tsv`     |
| one row per process (solo), both resets   | **0**          | 27   | `.tmp/solo-fixed.tsv`      |

All four lanes are 123 rows on one compiler revision, provider linked
(`JS2WASM_TEST262_TEMPORAL=1`), each with a `JS2WASM_TEMPORAL_CACHE` created
fresh for that revision. The solo lane is one node process per row
(`.tmp/solo-loop.sh`), which is the reference verdict a fork cannot contaminate.

**Acceptance met, and in the strong form.** Batch-with-both-resets and solo do
not merely agree on the two counts — all 123 rows are byte-identical, status AND
failure-reason string (`diff` of the two sorted TSVs is empty). The batched run
is now indistinguishable from 123 fresh processes.

**The registry reset moved the batch count by zero; the realm-global reset moved
all of it.** Rows 1 and 2 of the table are the same 23 and the same 13 — adding
`resetLinkedProjectRegistry` changed nothing observable on this list.
`month-boundary-gregory.js` still failed on `endYesterdayNextDay: instanceof`
in the batch with the registry reset ON, while failing solo on `Unsupported era
name: gregory`. Adding `resetTemporalRealmGlobals` took `: instanceof` to 0 and
+14 rows to pass. The registry reset is kept anyway: it is correct on its own
terms (the registry genuinely has no unregister path, and the unit tests pin the
resolution order it fixes), it is what makes the two-live-projects bound below
statable, and it costs one call on a path that runs once per linked row.

**Why: the stale exports do not come through `decoderFor` at all.** Instrumented
`_owningClassObject` with a per-project generation counter and an identity map
over exports objects (`.tmp/` probes, run on the two-row pair
`era-japanese` + `month-boundary-gregory`):

```
[5364] reset -> gen 2
[5364] STALE gen=2 exportsId=E1@g1
    at _owningClassObject (src/runtime.ts)
    at _hostPrototypeForInstance / Object.getPrototypeOf (proxy trap, runtime.ts:8770)
    at [Symbol.hasInstance]
    at __call_get_day (wasm://wasm/007e5ce2 — the PROVIDER)
    at __get_member_day (wasm://wasm/0034d2c6 — row 2's CONSUMER)
    at __module_init  <- row 2, i.e. gen 2
```

Row 2's consumer is reading a host mirror whose export slot is row **1**'s
provider exports. The registry was empty of them at the time; the mirror was
reached directly.

**Root cause — a realm global, not a registry.** `@js-temporal/polyfill` keeps
every Temporal object's internal slots in ONE store reached through
`globalThis[Symbol("@@Temporal__GetSlots")]` / `@@Temporal__CreateSlots`, and
installs it **first-writer-wins**. Confirmed by listing `globalThis`'s own
symbols after each row (`.tmp/probe-globals.mts`): both symbols appear after row
1 and are still there for row 2. So every Temporal row after the first in a fork
resolves its objects through **row 1's provider instance**, whatever the decoder
registry says.

Deleting those two symbols between rows makes the batch answer what a solo
process answers — `.tmp/probe-slotreset.mts`, same pair:

```
dropped: []                                                  ROW era-japanese          fail eraName must be string…
dropped: ["Symbol(@@Temporal__GetSlots)","Symbol(@@Temporal__CreateSlots)"]
                                                             ROW month-boundary-gregory fail Unsupported era name: gregory
```

That is the solo verdict, in a batch. The fix therefore ships as
`resetTemporalRealmGlobals()` in `scripts/test262-temporal.mjs`, called from the
same seam. It is a **harness** repair, not a compiler one: the polyfill is
entitled to assume one instance per realm, and it is the many-rows-per-fork
model (#5353) that violates it.

## The sharded worker lane (#5353) is covered, with no worker-side change

`scripts/test262-worker.mjs` instantiates every row through
`instantiateTest262Module` (~L2002), so both resets reach the CI lane that
actually motivated this issue. They arrive by different routes, and the
difference matters:

- **`resetTemporalRealmGlobals` — unconditional, no worker-side dependency.** It
  is a STATIC import inside the seam itself, so it runs in the worker whatever
  the caller passes. This is the reset that carries the entire measured effect,
  and it cannot silently degrade.
- **`resetLinkedProjectRegistry` — supplied by the caller.** It is destructured
  from `options.linkedRuntime`, which the worker sets to its own bundled runtime
  copy (`scripts/runtime-bundle.mjs`, built from `runtime-bundle-entry.ts`, whose
  `export *` carries the symbol). A bundle built before this change has no such
  export; that degrades rather than throws, and
  `announceMissingLinkedProjectReset` says so once per process.

`tests/issue-5364-linked-project-scope.test.ts` pins the asymmetry directly: it
calls the seam with a `linkedRuntime` that deliberately omits
`resetLinkedProjectRegistry` and asserts the realm store is dropped anyway.

The worker's OTHER `instantiateTest262Module` call (~L1640,
`buildInvalidBinaryError`) passes no `linkedModules` and so takes neither reset
— correct: it is the diagnose-why-this-binary-is-invalid path, not a row.

Suites run: `tests/issue-5353-sharded-temporal-lane.test.ts` (14) and
`tests/issue-5248-test262-temporal-wiring.test.ts` (4) both pass unchanged;
`tests/issue-5364-linked-project-scope.test.ts` is 6 passing.

## (B) — not attempted, and the plan's premise for it needs revisiting

Deliverable B (a `rootImports`-keyed project scope for the #5225 registry) was
NOT implemented. The measurement above says why it should be re-scoped before
anyone spends a lane on it: the observable it was supposed to move — the batched
`: instanceof` count — is dominated by the realm-global channel, not by
`decoderFor`. Attempt 1 was reverted for breaking the consumer→provider literal
route, and re-doing it now would be paid for with that risk against a benefit
this branch measured at zero on the 123-row list.

What is still true and still unfixed: **two linked projects live SIMULTANEOUSLY
in one process are unsupported.** `resetLinkedProjectRegistry` retires the
previous project rather than scoping per project, so reading project 1 after
project 2 has been instantiated takes the miss path. Nothing in the test262
lanes does that (a row is finished before the next starts), so it is bounded to
embedders that hold two linked graphs at once. A follow-up that does the
`rootImports` keying should be justified by THAT, with its own repro, rather
than by the Temporal conformance number.

## Acceptance criteria

1. **(A) landed — met, though not by the mechanism the plan predicted.**
   `resetLinkedProjectRegistry` is exported from both bundles and called per
   linked row from the one seam both drivers pass through. Batch == solo on the
   123-row list: `: instanceof` 0 vs 0, pass 27 vs 27, and in fact all 123 rows
   are byte-identical. The criterion is met by `resetTemporalRealmGlobals`,
   which the measurement forced into scope; the registry reset on its own moved
   the count by 0 (table above).
2. **(B) NOT attempted — and it should be re-scoped, not merely deferred.** See
   the section below: the observable B was meant to move is dominated by the
   realm-global channel, so B's own justification has to be rebuilt on the
   simultaneous-two-projects case with its own repro.
3. **No new host import; single-module lane unchanged.** Nothing here touches
   the import object or codegen — both resets are harness-side, on a path that
   runs only when `linkedModules` is non-empty. Equivalence gate at baseline
   (24 failing / 1718 passing).

## Notes

- Filed from dev-5363's measurement on PR for
  `issue-5363-thrown-error-seam` (#5363 verdict: reported defect does not
  exist; this is the real one).
- Related: #5225 (registry), #5222 (mirror ownership), #5354 (class identity),
  #5353 (worker runs rows in a long-lived fork — the CI exposure).
- Id reserved via `claim-issue --allocate --allow-unscanned` (gh unavailable in
  this container); open PRs hand-checked 2026-09-06 — highest in-flight issue
  file is #5363.
