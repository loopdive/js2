---
id: 1620
title: "$IteratorResult struct: eliminate __iterator_done/__iterator_value host imports (runtime wiring gap)"
status: ready
created: 2026-05-24
updated: 2026-05-24
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: feature+bugfix
area: codegen+runtime
language_feature: iterators, for-of
goal: host-independence
sprint: 56
renumbered_from: 1323
supersedes_pr: 347
---
# #1323 — $IteratorResult struct (runtime wiring gap)

Replace the `__iterator_done` / `__iterator_value` host imports with a Wasm-native
`$IteratorResult` struct returned by `__iterator_next`. The original attempt
(PR #347, closed) implemented the codegen side but left a runtime wiring gap that
**regresses conformance** — it must be re-done with the runtime fixed.

## Why PR #347 was closed (root cause — verified by sendev-432-347, 2026-05-24)

PR #347's conflict resolution against current main was clean, but the feature
itself is broken independent of the merge:

- #1323 changed the **legacy codegen path** (`src/codegen/statements/loops.ts`)
  so `__iterator_next`'s result is **unconditionally** `any.convert_extern` +
  `ref.cast` to `$IteratorResult`.
- But the runtime `__iterator_next` (`src/runtime.ts` ~L5904) only returns a real
  `$IteratorResult` struct when it can reach
  `callbackState.getExports().__make_iterator_result`.
- In the **default** `buildImports(imports, undefined, stringPool)` usage — which
  is what the tests (and most callers) use — `callbackState` is absent, so it
  hits the "defensive fallback" that returns the **raw JS object**, which then
  fails the `ref.cast` with a runtime `illegal cast`.
- The fallback's comment ("legacy host-import path still works") is **false**:
  the legacy path was rewritten to require the struct.

**Proven regression:** `tests/iterators.test.ts` (5 string for-of) +
`tests/symbol-iterator-protocol.test.ts` (custom iterable) **PASS on origin/main**
but **FAIL with #1323** (`illegal cast`). Same failures reproduce on the PR's
pre-merge tip — so it's the feature, not the merge.

## What a correct implementation needs

1. **Runtime must construct `$IteratorResult` without depending on `callbackState`** —
   OR the legacy codegen path must keep working (return the raw object / not cast)
   when `__make_iterator_result` is unreachable. Pick one; the cast and the
   constructor must be consistent across all `buildImports` usages, including the
   default (no callbackState) path.
2. **Update the stale test assertions**: `tests/iterators.test.ts:90-91` still
   assert the WAT contains `__iterator_done` / `__iterator_value` — the very
   imports #1323 removes. Update them to assert the struct path.
3. Reconcile with `__iterator_rest` (#1052) in `addIteratorImports` (both-sides-add
   in `src/codegen/index.ts`) — PR #347 already resolved this cleanly (keep both
   the `__iterator_rest` import and the `__make_iterator_result` helper/export;
   `makeFuncIdx` index math stays correct).

## Files
- `src/codegen/statements/loops.ts` — the unconditional cast site
- `src/runtime.ts` ~L5904 — `__iterator_next` / the `callbackState`-dependent
  `__make_iterator_result` reachability + defensive fallback
- `src/codegen/index.ts` — `addIteratorImports` (coexist with `__iterator_rest`)
- `tests/iterators.test.ts`, `tests/symbol-iterator-protocol.test.ts` — fix stale
  assertions + confirm string-for-of / custom-iterable pass

## Acceptance
- `__iterator_done` / `__iterator_value` host imports eliminated.
- `tests/iterators.test.ts` + `tests/symbol-iterator-protocol.test.ts` pass
  (no `illegal cast`) in the **default** buildImports path.
- Stale WAT assertions updated.
- No test262 regression (string for-of currently passes on main — must stay green).

PR #347's clean conflict resolution is preserved at local commit `4b9f14e30` if a
future dev wants the index.ts reconciliation as a starting point.

## Investigation 2026-05-27 (dev-1606) — ESCALATING: needs architect spec

Confirmed current main is the **clean host-import version** (NOT the broken #1323
code — that never merged; PR #347 closed). `__make_iterator_result` / `$IteratorResult`
do not exist anywhere in `src/`. So this is a fresh feature, and the closed branch
`4b9f14e30` is too stale to reuse: it predates #1618/#1651/#1653 WASI work and
*reverts* those changes — diffing against it is noise, not a starting point.

**A single-externref design is mathematically impossible (rules out the easy path):**
`__iterator_step(iter) -> externref` cannot encode both `done` and an arbitrary
`value`. Using `null` as the done sentinel breaks `for (const x of [undefined])` /
`[null]` — a real `undefined`/`null` element is indistinguishable from done. So a
`$IteratorResult` **struct (or two host calls) is genuinely required**. The struct is
the only host-independent option — and it inherently needs a Wasm-side constructor the
JS runtime can call, which is exactly the gap that sank PR #347.

**Real root cause of the #347 regression (verified):**
- `buildImports` always creates `callbackState = { getExports: () => wasmExports }`,
  but `wasmExports` is only populated when a caller invokes `setExports(instance.exports)`
  **after** instantiation (`runtime.ts:7361`).
- `compileAndRun`/`instantiateAndRun` *do* call `setExports` (`runtime.ts:7576`). **But
  the unit-test harness and raw embedders call `WebAssembly.instantiate(binary, imports)`
  directly and never call `setExports`** (`tests/iterators.test.ts:13`). In that path
  `getExports()` is `undefined`, so any runtime building the struct via
  `callbackState.getExports().__make_iterator_result` is unreachable → codegen
  `ref.cast` to `$IteratorResult` hits a raw JS object → runtime `illegal cast`.

**Scope is wider than the issue's "Files" list:** the two imports are consumed in
**two** codegen paths, both of which must switch consistently:
- legacy: `src/codegen/statements/loops.ts:3331-3332, 3447-3464`
- IR: `src/ir/lower.ts:1399-1423` (+ lowering docs `src/ir/nodes.ts:1250-1303`)

**Design decisions an architect must pick (the crux #347 got wrong):**
1. How is `$IteratorResult` constructed so it is reachable in the **default raw-instantiate
   path** (no `setExports`)? Options:
   a. Make `__iterator_next` a **Wasm-native helper** that reads `.done`/`.value` via
      thin host shims and packs the struct *in Wasm* (struct construction always
      reachable; still needs host reads — doesn't fully remove host deps in JS mode).
   b. Force every instantiation path (incl. the test harness + embedder docs) to call
      `setExports`, then build the struct in JS via `__make_iterator_result`. Fragile —
      re-arms the same trap for the next raw embedder unless enforced by a wrapper.
   c. Keep host imports as fallback, use the struct path only when the constructor export
      is reachable (issue option 1b) — then the imports are NOT eliminated, conflicting
      with acceptance criterion 1.
2. Whether full elimination is compatible with JS-host mode at all, or whether it is only
   achievable in `--standalone`/WASI mode (where there is no JS iterator object to read
   and the iterator is already a Wasm struct). Cross-reference #1665 native generators —
   #93 flags a "shared $Iterator design gap"; this is the same gap and should be specced
   together.

Recommendation: route to architect for a spec choosing (a)/(b)/(c) and defining the
construction + reachability contract across legacy + IR + both instantiation paths
before any code lands. Implementing blind risks repeating the #347 regression.

Worktree `issue-1620-iterator-result-struct` created during investigation; **no source
changes made** — safe to remove or reuse by the spec implementer.
