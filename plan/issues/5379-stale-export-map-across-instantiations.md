---
id: 5379
title: "A value built by instantiation N of a linked provider is dispatched through instantiation N−1's export map — host mirrors keep the FIRST instantiation's exports, so every test262 strict rerun (and every later row in a fork) reads the wrong module (bounds #5377's +7; `Instant.epochNanoseconds` passes fresh, fails in-process)"
status: ready
sprint: current
priority: high
horizon: m
goal: core-semantics
reasoning_effort: high
requested_by: ttraenkler/fable-lead
created: 2026-09-07
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

## Notes

- Filed from PR #5699's "reported, not fixed" #1 and #5364 §4's second
  channel.
- Id reserved via `claim-issue --allocate --allow-unscanned` (no `gh` in this
  container); open PRs hand-checked 2026-09-07 — highest in-flight issue file
  is #5377 (PR #5699).
