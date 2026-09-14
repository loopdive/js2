---
id: 5379
title: "A value built by instantiation N of a linked provider is dispatched through instantiation N−1's export map — host mirrors keep the FIRST instantiation's exports, so every test262 strict rerun (and every later row in a fork) reads the wrong module (bounds #5377's +7; `Instant.epochNanoseconds` passes fresh, fails in-process)"
status: done
completed: 2026-09-07
assignee: ttraenkler/dev-5379
sprint: current
priority: high
horizon: m
goal: core-semantics
reasoning_effort: high
requested_by: ttraenkler/fable-lead
created: 2026-09-07
# 2026-09-07 — this PR STACKS on PR #5699 (#5377), so it carries that PR's
# commits and therefore its growth. The #5377 grants are RESTATED here verbatim
# in scope because a growth allowance must live in a file the PR modifies,
# and #5377's issue file is not modified by this one (the stranded-grant class
# named in CLAUDE.md § "Hooks and ratchet gates").
#
# `src/runtime.ts` — INHERITED from #5377, not grown by #5379: this issue adds
# no line to it (its own change is +29/-7 in
# `src/runtime/cross-module-struct-owners.ts`, below the gate's per-file floor).
# MEASURED on this branch 2026-09-07 by `LOC_GATE_BASE=$(git rev-parse
# origin/main) node scripts/check-loc-budget.mjs` (base 7ab54a11b0):
# src/runtime.ts 19440 → 19600 (+160), src/codegen/class-bodies.ts
# 4328 → 4393 (+65). #5377's issue file quotes +255 for runtime.ts against a
# DIFFERENT base (798b8a06e0); both are restated so neither is mistaken for the
# other. #5377's own rationale for the growth — #5373's +95
# (three coercion sites, `_isTaggedUserClassInstance` / `_classChainMethod` /
# `_classChainToString`) plus #5377's ~160 (the two instance→class-object
# registries, `_classObjectForInstance`, `_classObjectOwnedBy`, `_classChainRead`,
# three call sites, the `__set_subclass_proto` fourth argument and rationale).
#
# `src/codegen/class-bodies.ts` — INHERITED from #5377 (+65): the
# `__set_subclass_proto` fourth argument carried in a LOCAL emitted into the
# LIVE body, and the constructor-entry class-object materialization.
loc-budget-allow:
  - src/runtime.ts
  - src/codegen/class-bodies.ts
# INHERITED from #5377, restated for the same stranded-grant reason.
# `resolveImport` physically contains the member-read imports and
# `__set_subclass_proto`; `<anonymous>#95` is the `__extern_method_call` closure
# inside it; `compileClassBodiesInner` builds every class constructor's
# `FunctionContext`.
func-budget-allow:
  - src/runtime.ts::resolveImport
  - src/runtime.ts::<anonymous>#95
  - src/codegen/class-bodies.ts::compileClassBodiesInner
---

# #5379 — host mirrors dispatch through a stale instantiation's exports

## Problem

Measured by dev-5377 (PR #5699, `.tmp/dbgM5.log`, `.tmp/fix2-temporal.json`)
with an instrumented runtime, provider linked:

```
[dbg5377reg]  name=JSBI classObj=object#1   exports=object#3     (instantiation 1)
[dbg5377reg]  name=JSBI classObj=object#125 exports=object#127   (instantiation 2)
[dbg5377read] inst=object#226 exports=object#127 classObj=object#125   → i.constructor === JSBI  true
[dbg5377read] inst=object#226 exports=object#3   classObj=object#125   → FALSE
```

An instance minted by instantiation 2 reaches a read whose `exports` (the
`callbackState.getExports()` an import closure captured) belong to
instantiation 1. Consequences, all measured:

- `Temporal.Instant.from("2024-01-01T00:00:00Z").epochNanoseconds` is a
  correct `bigint` in a FRESH process and throws `Cannot convert
  23396352,513294428,1 to a BigInt` in a process that has already run other
  Temporal files (the test262 strict rerun of the same file is enough).
- #5377 had to add `_classObjectOwnedBy` — both identity arms stand down when
  the class object was minted by a different instantiation than the exports
  the read arrived with — because landing them ungated regressed 5 rows with
  `Error: Convert JSBI instances to native numbers using toNumber`. That gate
  is what bounds #5377's +7 on the 481-row sample: a sharded worker runs
  hundreds of files per fork, so most rows are "later rows".
- This is the SECOND channel #5364 §4 named and could not close ("stale
  exports also arrive directly as a `callbackState.getExports()` from an import
  closure, traced through the Map/Set method bridge, `src/runtime.ts` ~L11361").
  #5364's per-row registry + realm-global reset fixed the first channel
  (the polyfill's `@@Temporal__GetSlots` store) and made batch == solo on the
  123-row list; this channel is what still differs between "fresh process" and
  "strict rerun in the same process".

## Implementation Plan (Fable, 2026-09-07)

**Step 1 — find the holder.** Which object outlives an instantiation and
carries `exports`/`callbackState` of the old one? Candidates, in order:
1. `_wrapForHost` mirror caches keyed on CLASS OBJECT or on class NAME
   (`_hostConstructorForInstance`, the `_subclassCtors` bucket, the
   `_instanceClassObject` WeakMap) — a mirror minted for instantiation 1's
   class object handed to instantiation 2's instance through a name-keyed
   lookup.
2. Import closures created in `buildImports(...)` for instantiation 1 that a
   host-side object (a Map/Set method bridge, `_wasmClosureDynamicWrapperCache`
   entry, a `Proxy` trap) still references — reachable because the polyfill's
   realm globals or the runtime's module-level singletons keep the object
   alive across rows.
3. The #5225 `_crossModuleStructs` registry: `resetLinkedProjectRegistry`
   (#5364) retires the previous project, but `decoderFor`'s `owners` WeakMap
   can still answer an old exports object for a struct that survived (a
   struct cached in a module-level Map).
Instrument `dbg5377read`-style: on every read where `exports !==` the
receiver's owning exports, log the holder's construction site (a stack captured
when the closure/mirror was created — a `WeakMap<object, string>` set in
`buildImports` and `_wrapForHost` is enough). Quote the holder in the PR.

**Step 2 — fix at the holder.** Two acceptable shapes; pick by Step 1:
- (a) Mirrors and wrappers resolve `exports` from the RECEIVER at call time
  (`_decoderExportsFor(raw, …)` / `_owningClassObject` → its instantiation's
  exports), never from the closure that created them. This is the #5225 rule
  applied to the dispatch side.
- (b) The stale holder is dropped at instantiation boundary — extend
  `resetLinkedProjectRegistry()` (#5364) to clear the module-level caches that
  hold exports/callbackState (mirror cache, dynamic-wrapper cache, name-keyed
  ctor buckets) when a NEW linked project starts, so nothing from instantiation
  1 can answer for instantiation 2.
(b) is cheaper and fixes the test262 lanes; (a) is the correct fix for
embedders holding two projects at once (the #5364 (B) residual). Ship (b)
first if (a) does not converge; state which.

**Step 3 — remove the ownership gate once the channel is closed.** With no
stale exports reachable, `_classObjectOwnedBy`'s `_MISS` arm (#5377) becomes
dead; keep it but assert (test) that it never fires on the 481-row sample —
that assertion is the proof the channel is closed.

**Step 4 — tests.** `tests/issue-5379-stale-export-map.test.ts`: TWO
instantiations of the same provider binary in one process (the
`tests/issue-5364-linked-project-scope.test.ts` two-project harness), second
project's instance read through a host mirror → `i.constructor === C` true and
`Number(i)`/`String(i)` dispatch through the SECOND module's exports (assert on
a module-identifying export, e.g. a counter export incremented per module).
Base-failing.

**Step 5 — measure.** `Instant.epochNanoseconds` in a fresh process AND after
ten other Temporal rows in the same process (dev-5363's `probe-bisect`
shape); the 481-row `Instant/**` + `ZonedDateTime/prototype/**` sample and the
123-row family, batch driver (#5364's), base vs fix, fresh cache, 0 pass→fail
— expect the +7 of #5377 to grow now that "later rows" are no longer bounded.
Never the full bucket.

**Order-preservation constraints.** #5364's `resetLinkedProjectRegistry` and
`resetTemporalRealmGlobals` stay; #5377's identity arms stay; the single-module
lane is unaffected (no linked project ⇒ no second instantiation of a provider).

## Acceptance criteria

1. Step 1 answered with the holder's construction site.
2. `Instant.epochNanoseconds` is a `bigint` after ten other Temporal rows in the
   same process; the #5377 ownership-gate `_MISS` count on the 481-row sample is
   0.
3. 481-row + 123-row samples measured, 0 pass→fail, counts with artifacts.

## Findings (dev-5379, 2026-09-07) — the channel was already closed; the holder is real but demoted, not dropped

**The premise no longer holds on this base, and the reason is a date.**
`.tmp/dbgM5.log` — the trace the issue is filed from — was captured
**2026-09-06 23:46**. #5364's merge commit `640f6939d0` landed on `main` at
**2026-09-07 01:29**, and #5377's ownership-gate commit `4654f50e5f` (02:17 on
its own branch) does **not** contain it (`git merge-base --is-ancestor
640f6939d0 4654f50e5f` → 1). So both the observed cross-instantiation arrival
**and** the 5-row regression that forced the `_classObjectOwnedBy` gate were
measured on a base **without** `resetLinkedProjectRegistry` /
`resetTemporalRealmGlobals`. The #5377 branch then merged #5364 in
(`6c0c38dda8`) and never re-measured whether the gate was still load-bearing.

**Step 1 — the holder, quoted.** The only candidate on the plan's list that
genuinely survives an instantiation boundary is candidate 3, and it is not a
mirror cache:

```ts
// src/runtime/cross-module-struct-owners.ts
export function createCrossModuleStructOwners(canBeWeakKey: (value: unknown) => boolean) {
  const modules = new Set<Record<string, Function>>();
  const owners  = new WeakMap<object, Record<string, Function>>();   // <- the holder
  const states  = new WeakMap<Record<string, Function>, { getExports: () => Record<string, Function> }>();
```

`owners` is written at `decoderFor`'s three `owners.set(obj, …)` sites and was
read back **before** any liveness check:

```ts
const cached = owners.get(obj as object);
if (cached !== undefined) return cached === local || cached === NONE ? undefined : cached;
```

`reset()` (#5364) clears `modules` and leaves `owners`/`states` alone, on this
stated premise:

> `owners` and `states` are deliberately NOT cleared: both are WeakMaps keyed on
> the per-instance objects of the project being dropped, so they become
> unreachable with it.

That premise is **false**. `classStaticParent`'s `classParentsByName`
(`src/runtime/class-static-parent.ts` L10) is a process-global **strong** `Map`
of class objects keyed by class **NAME**, so project 1's objects outlive
project 1 by construction; a host mirror handed to an embedder keeps its struct
alive the same way. And `stateFor` is the exact object #5364 §4 named as the
second channel — `_crossModuleCallbackState` (`src/runtime.ts` L6246) replaces
an import closure's `callbackState` with `_crossModuleStructs.stateFor(owner)`,
i.e. **a `callbackState.getExports()` that answers a module's exports.** When
`owner` came out of the stale cache, that is literally "stale exports arrive
directly as a `callbackState.getExports()` from an import closure".

**Step 2 — shipped (b), not (a); (a) does not converge and cannot.** (a) asks
mirrors to resolve exports "from the RECEIVER at call time". There is nothing to
resolve from: a raw WasmGC struct carries no decoder — that is the premise
`cross-module-struct-owners.ts`'s own header states, and it is why the registry
exists at all. So (a) reduces to the same lookup, and the fix has to be at the
lookup. Shipped shape: **a retired module never outranks a live one.** On a
cache hit whose module is no longer in `modules`, `decoderFor` re-probes the
live project and prefers whatever it answers; the retired entry is **kept as the
fallback** rather than dropped, because a retired module's Wasm instance is
alive as long as the struct is and is still the correct decoder for what it
minted — dropping it would turn a working read of a surviving cross-project
value into the `ref.test`-miss default (0). Only the ORDER changes. The `NONE`
negative-cache arm short-circuits before the liveness check, so the #3903
`__extern_get` hot path (~10k/`run()`) is byte-identical.

**Step 3 — the assertion, measured.** `_classObjectOwnedBy` answers "foreign"
**0** times on the 481-row sample:

| lane | rows | gate evaluations | `_MISS` | distinct registering export sets |
| --- | --- | --- | --- | --- |
| `Instant/**` + `ZonedDateTime/prototype/**` | 481 | 427,547 | **0** | 776 |
| 4 linked Temporal probes | 4 | 1,927 | **0** | 5 |

Instrumented with three independent detectors, all reading 0: the gate itself; a
broad stale check on every class-object resolution path
(`_owningClassObject`, its cached arm, `_classObjectForInstance`'s direct and
proto arms); and a drift check that records the FIRST exports each class object
is seen with and flags any later arrival with a different one — the last one
does not depend on `_classCtorCallbackStates` being populated, so it closes the
init-window blind spot. Artifacts `.tmp/base-instzdt.json`, `.tmp/tp5379e.log`.
The gate is therefore **dead code on this base and is kept anyway**, per the
plan: it costs one `WeakMap.get` on a path that already did one, and it is the
only thing standing between a future regression of the reset seam and the 5-row
`Convert JSBI instances to native numbers using toNumber` failure #5377 measured.

**`Instant.epochNanoseconds` is correct in-process.** `.tmp/probe-base.json`:
`pass` in a fresh process AND `pass` after ten other `Instant/**` rows have run
in the same one (`PROBE_ROWS=10`, `.tmp/probe-inproc.mts`). The issue's headline
symptom does not reproduce.

## Samples — base vs fix, byte-identical

Both lanes, one compiler revision, one `JS2WASM_TEMPORAL_CACHE` created fresh
for it (`.tmp/tcache`), provider linked (`JS2WASM_TEST262_TEMPORAL=1`), one row
per line through `runTest262File` (`.tmp/bucket-run.mts`).

| sample | rows | base | fix | pass→fail | fail→pass |
| --- | --- | --- | --- | --- | --- |
| `Instant/**` + `ZonedDateTime/prototype/**` | 481 | 294 pass / 187 fail | 294 pass / 187 fail | **0** | 0 |
| #5249 calendar family | 123 | 27 pass / 96 fail | 27 pass / 96 fail | **0** | 0 |

`diff` of the sorted TSVs is empty on both — status AND failure-reason string.
Artifacts: `.tmp/base-instzdt.tsv` / `.tmp/fix-instzdt.tsv`,
`.tmp/base-123.tsv` / `.tmp/fix-123.tsv`, `.tmp/diff-instzdt.txt`,
`.tmp/diff-123.txt`.

## Reported, not fixed

- **Two linked projects live SIMULTANEOUSLY are still unsupported** — #5364
  deliverable (B), unchanged. Without a reset between them, `decoderFor`
  iterates `modules` in **insertion order**, so a struct minted by project 2 and
  first classified while project 1 is still registered caches project 1, and
  `decodes()` cannot tell "minted it" from "can name it" (two instances of one
  binary share canonical WasmGC types — that is the whole aliasing problem).
  **Bound:** unreachable from either test262 driver, because the ONE instantiate
  seam resets before every linked row and the strict rerun goes through it too;
  reachable only by an embedder holding two linked graphs at once. The fix is
  the `rootImports`-keyed project scope, which was reverted once for breaking
  the #5225 consumer→provider literal route and needs its own repro.
- **This issue's own fix is not observable in any measured lane.** The 481-row
  and 123-row samples are byte-identical base vs fix; the change is pinned by
  the registry unit tests, which ARE base-failing, and by the reasoning above.
  A change with no conformance delta is reported as such rather than credited.

## Notes

- Filed from PR #5699's "reported, not fixed" #1 and #5364 §4's second
  channel.
- Id reserved via `claim-issue --allocate --allow-unscanned` (no `gh` in this
  container); open PRs hand-checked 2026-09-07 — highest in-flight issue file
  is #5377 (PR #5699).
