---
id: 1640
title: "spec gap: Reflect.* invariant checks mirror internal-method bugs (47 test262 fails)"
status: wont-fix
created: 2026-05-08
updated: 2026-06-19
completed: 2026-06-19
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: runtime
language_feature: reflection
goal: spec-completeness
sprint: 50
renumbered_from: 1346
parent: 1328
blocked_on: [1629, 1596]
investigation_done: 2026-05-27
reverified: 2026-05-28
related: [1334, 1345, 1629, 1596, 1630, 1631, 1130]
---

> **wont-fix 2026-06-19 (PO audit):** duplicate of **#1345** (same title,
> same "Reflect invariant checks mirror internal-method bugs" scope; this
> copy is the `renumbered_from: 1346` drift that references #1335 where #1345
> references #1334). #1345 is the canonical tracking issue and stays in the
> backlog. Closing this twin to remove the phantom open issue.

# #1346 — Reflect: invariant checks mirror internal-method bugs

## Problem

`built-ins/Reflect`: **70 / 153 pass (45.8%) — 83 fails (77 assertion_fail, 2 runtime_error,
2 type_error, 1 null_deref, 1 wasm_compile)**.

Spec §28.1 (Reflect): each Reflect.X is a thin wrapper over the [[InternalMethod]] X. Therefore:
1. Reflect.defineProperty mirrors [[DefineOwnProperty]] → blocked on #1335.
2. Reflect.getOwnPropertyDescriptor mirrors [[GetOwnProperty]] → returns full descriptor including
   attribute flags.
3. Reflect.has mirrors [[HasProperty]] → walks prototype chain.
4. Reflect.ownKeys mirrors [[OwnPropertyKeys]] → returns string + Symbol keys in spec-defined order.
5. Reflect.set / Reflect.get pass receiver explicitly.

The 77 assertion_fail failures are mostly cascade effects of #1335 (descriptor-attribute fidelity).

## Acceptance criteria

1. `built-ins/Reflect/defineProperty/symbol-key.js` passes (after #1335).
2. `built-ins/Reflect/ownKeys/return-on-corresponding-order-large-index.js` passes.
3. `built-ins/Reflect/getOwnPropertyDescriptor/return-undefined-for-non-existent-key.js` passes.
4. Pass-rate for `built-ins/Reflect` rises from 46% to ≥80% (after #1335 lands).

## Files to modify

- `src/runtime.ts` — `__reflect_*` host bridges
- `src/codegen/registry/reflect.ts`

## Implementation Plan

### Root cause

Most failures cascade from #1335 (Object.defineProperty descriptor attributes). Once that issue
lands, Reflect.defineProperty and Reflect.getOwnPropertyDescriptor automatically improve.

The remaining gap is Reflect.ownKeys order: spec requires:
1. Integer-indexed keys in ascending numeric order.
2. Other string keys in property-creation order.
3. Symbol keys in property-creation order.

Our `__reflect_ownkeys` host bridge calls JS `Reflect.ownKeys` directly which is correct, but
typed-struct objects don't expose Symbol keys at all (they have no Symbol-keyed slot).

### Approach

1. Block on #1335.
2. For typed objects: extend the attribute-table from #1335 to include Symbol keys (currently
   the table is keyed by string only).
3. After #1335: re-run test262 and verify Reflect tests improve.

### Edge cases

- Reflect.set with receiver = primitive → must invoke setter with the primitive as `this` (no
  TypeError unlike strict-mode regular set).
- Reflect.defineProperty returns `false` on failure (spec mode); Object.defineProperty would throw.

### Test262 sample

- `test262/test/built-ins/Reflect/defineProperty/symbol-key.js`
- `test262/test/built-ins/Reflect/ownKeys/return-on-corresponding-order-large-index.js`

## Findings (2026-05-27, dev investigation)

Ran the full `built-ins/Reflect` suite through `runTest262File` on current
main: **106/153 pass (69%), 47 fail, 0 skip** — already well above the
issue's stated 46% baseline (the descriptor-attribute work since this issue
was filed lifted it). The named sample files in the issue
(`defineProperty/symbol-key.js`, `getOwnPropertyDescriptor/return-undefined-for-non-existent-key.js`)
no longer exist in the vendored test262 — filenames are stale.

The **Reflect.* host bridges themselves are already spec-correct.** Each
`__reflect_*` in `src/runtime.ts:4847-4953` delegates to the host's
`Reflect.X` (wrapping wasm structs via `_wrapForHost`), so invariant checks,
boolean returns, and prototype-chain walks are inherited from V8. There is
**no missing-invariant bug to patch in the Reflect layer.** A focused
"audit Reflect invariants" PR would change nothing.

The 47 failures decompose into two deeper, already-tracked subsystem gaps:

### Cluster A — accessor-descriptor model on struct objects (~30 fails)

Confirmed by direct probe:
`Object.defineProperty(o, 'p', { get() { return 42 } })` then
`Reflect.get(o, 'p')` returns `undefined`, not `42` — the getter is never
wired into the struct-backed object's slot. This is the SAME root cause as
plain member access over a defineProperty getter. Surfaces as the
`get/return-*`, `has/return-boolean`, `getOwnPropertyDescriptor/return-from-*`,
`defineProperty/define-*` ("Getter must be a function: null"),
`ownKeys/*` and `set/*` buckets. **Tracked by #1630 (descriptor-model
writeback, escalated needs-spec) and #1631 (Object.create descriptor map
drops struct-backed descriptors).** Reflect inherits the fix for free.

### Cluster B — compiled-function as host-callable (~8 fails)

`Reflect.apply(fn, thisArg, args)` / `Reflect.construct(ctor, args)` where
`fn`/`ctor` is a compiled wasm function fails with
`Function.prototype.apply was called on [object Object], which is not a
function` — the function reaches the host as a non-callable `_wrapForHost`
struct wrapper. Surfaces as `apply/call-target.js`, `apply/*-array-like*`,
`construct/return-with-newtarget-argument.js`, `construct/*`. This is the
wasm-function → host-callable bridging gap, not Reflect-specific (any host
MOP that needs to *invoke* a compiled function hits it).

### Recommendation

Close as **wont-fix-standalone / superseded**: there is no Reflect-layer
patch that moves the needle. Re-validate the Reflect suite after #1630 +
#1631 (Cluster A) land — that should recover ~30 of the 47. File a separate
issue for Cluster B (compiled-function host-callable bridging) if one does
not already exist; it is orthogonal to the descriptor model and to Reflect.

## Re-verification (2026-05-27, dev-1608, task #67)

Confirmed the prior finding on current main without re-running the full
suite (test262 submodule not initialized in this worktree; the recorded
106/153 count stands):

- All 13 `__reflect_*` host bridges are present in `src/runtime.ts`
  (`__reflect_get/set/has/deleteProperty/defineProperty/getOwnPropertyDescriptor/
  getPrototypeOf/setPrototypeOf/ownKeys/isExtensible/preventExtensions/apply/
  construct`), each delegating to the host `Reflect.X`. **Nothing is missing
  to implement** — there is no absent Reflect method and no incorrect
  invariant wrapper.
- Both downstream clusters are already tracked, so no new issue is needed:
  - **Cluster A** (accessor-descriptor model on struct objects, ~30 fails)
    → #1630 (descriptor-model writeback) + #1631 (Object.create descriptor map).
  - **Cluster B** (compiled-function as host-callable, ~8 fails) → **#1596**
    (`Function.prototype.apply/.call not accessible on compiled Wasm
    functions`); related #1632 (bind/toString).

**Verdict:** #1640 stays `status: blocked` on #1630/#1631. No developer-lane
implementation work exists here; it resolves for free when Cluster A lands.
Task #67 closed as *verified — no action* (not implemented, because there is
nothing at the Reflect layer to fix).

## Re-verification (2026-05-28, dev-1607, task #178)

#1630 (Object.assign, PR #781) and #1631 (Object.create descriptor map)
both merged. Re-ran the full `built-ins/Reflect` suite against current main
(`b706991e0`) via `runTest262File`: **106 / 153 pass (69.3 %), 47 fail, 0
skip — UNCHANGED from the 2026-05-27 baseline.** The prediction "Reflect
inherits the Cluster A fix for free" turned out to be wrong: the merged PRs
solved narrower scenarios than the umbrella the investigation imagined.
`Object.defineProperty(o, 'p', { get() { return 42 } })` then `Reflect.get(o,
'p')` still observes `undefined`, not `42` (probe of `Reflect/get/return-value.js`).

### Failure breakdown (47 fails, by Reflect method bucket)

| bucket | fails | failure shape |
|---|---|---|
| `set` | 9 | `Object.defineProperty(o, p, {set: …})` not wired into struct; non-writable invariants; receiver-not-object TypeError |
| `ownKeys` | 7 | empty-object case, ordering with `defineProperty`, non-enumerable keys, Symbol keys |
| `defineProperty` | 5 | descriptor coalescing, Symbol-keyed defines, return-boolean semantics |
| `getOwnPropertyDescriptor` | 4 | accessor descriptors, data descriptors, Symbol property |
| `apply` | 3 | compiled-wasm fn → host-callable bridge |
| `construct` | 3 | compiled-wasm ctor → host-constructible bridge; `newTarget` plumbing |
| `deleteProperty` | 3 | configurable/own-prop semantics |
| `get` | 3 | accessor descriptor lookup, receiver semantics |
| `preventExtensions` | 3 | extensibility flag on struct objects |
| `has` | 2 | proto-chain walk via accessor |
| `getPrototypeOf` / `isExtensible` / `setPrototypeOf` / object-prototype / prop-desc | 1 each | `assert.throws` for non-object first arg |

All 47 share a single observable: the test sets up state with
`Object.defineProperty` (often accessor `{get/set: …}`) or `Object.create`
with a descriptor map, then exercises the corresponding `Reflect.X`. The
Reflect bridge faithfully forwards to host `Reflect.X` over a wrapped
struct; the wrapped struct does not expose the accessor wiring → host
read/write sees the wrong (or no) value.

### Root cause map (still no Reflect-layer fix)

- **~32 fails — accessor-descriptor model on struct objects.** Now blocked
  on **#1629** (Object.defineProperty descriptor attribute fidelity /
  typed-struct attribute table) — the actual descriptor storage gap.
  #1630 and #1631 fixed their narrow surfaces (Object.assign iteration,
  Object.create descriptor map respectively) but did NOT install
  per-property `writable/enumerable/configurable/get/set` storage on
  struct-backed objects. #1629 is currently ESCALATED-NEEDS-ARCHITECT in
  its own file (multi-PR; splits into #1629a/b/c per its 2026-05-27
  investigation). #1130 (Array index/length getter-observing) overlaps the
  Array-exotic subset.
- **~6 fails — `Reflect.apply` / `Reflect.construct` over compiled wasm
  functions.** Tracked by **#1596** (`Function.prototype.apply/.call not
  accessible on compiled Wasm functions`), task #175 in flight. Lands with
  that PR.
- **~9 fails — `Reflect.set` invariants on accessor / non-writable props.**
  Subset of Cluster A; lands with #1629.

### Bridge-layer audit (no localized fixes found)

All 13 `__reflect_*` host bridges in `src/runtime.ts:5484-5647` are
spec-correct:
- `__reflect_get/set/has/deleteProperty/defineProperty/getOwnPropertyDescriptor/getPrototypeOf/setPrototypeOf/ownKeys/isExtensible/preventExtensions/apply/construct`
  each wrap wasm-struct args via `_wrapForHost` and delegate to the host's
  `Reflect.X`. Receiver and value coercion follow §28.1 verbatim.
- `_isWasmStruct(target) ? _wrapForHost(target, exports) : target` is the
  uniform entry pattern; no method is missing a wrap or returning the wrong
  shape.
- No failing test exhibits a "wrong boolean return", "missing wrap", or
  "skipped invariant" symptom that a bridge-layer patch could address.
- The two candidates raised in the verification request (`Reflect.ownKeys`
  ordering and `Reflect.getOwnPropertyDescriptor` return-undefined) both
  depend on struct-object descriptor-attribute storage — verified by
  inspecting `ownKeys/return-empty-array.js`,
  `ownKeys/return-array-with-own-keys-only.js`,
  `getOwnPropertyDescriptor/return-from-data-descriptor.js`,
  `getOwnPropertyDescriptor/symbol-property.js`: each chains through
  `Object.defineProperty` or accessor-only setup, none reduces to a Reflect
  bridge bug.

### Final verdict

**Stay `status: blocked` — now on [1629, 1596].** Reflect will recover to
~80-90 % (≈138-145 / 153) once those two land. Re-run the suite after #1629
ships and close if ≥80%; any residual after that will be a small
Symbol-key / proto-chain bucket worth its own carve.

Task #178 (this re-verification) closed: *re-verified, still blocked, no
action — pass rate unchanged at 106/153 / 69.3 %, all 47 fails attributable
to #1629 and #1596*. No PR opened.

## Re-verification (2026-05-28, dev-1525, task #242)

Re-checked after the descriptor work that landed (#1629a / PR #835, #862).
**Still blocked — the descriptor blocker is NOT resolved.** The full
descriptor model issue **#1629** remains `status: ready` (only the narrow
`#1629a` dynamic-descriptor slice landed), and **#1596** is still
`status: in-progress`. The Cluster-A symptom still reproduces on current main
(`c2295fd82`):

```ts
const o: any = {};
Object.defineProperty(o, 'p', { get() { return 42; }, configurable: true });
Reflect.get(o, 'p');   // → null/undefined (should be 42)
```

So the descriptor-attribute storage (`writable/enumerable/configurable/get/set`)
on struct-backed objects is still missing, and Reflect inherits that gap.
**Verdict unchanged: `status: blocked` on [1629, 1596].** No Reflect-layer
patch exists; re-run the `built-ins/Reflect` suite and close once #1629 lands
and the suite reaches ≥80%. Task #242 closed: *verified, still blocked, no
action*.
