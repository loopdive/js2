---
id: 1620
title: "$IteratorResult struct: eliminate __iterator_done/__iterator_value host imports (runtime wiring gap)"
status: done
created: 2026-05-24
updated: 2026-05-27
completed: 2026-05-27
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

## Implementation Plan

### Root cause (re-verified against current main + commit `4b9f14e30`)

`__iterator_next` cannot build a WasmGC `$IteratorResult` struct in pure JS —
the struct is a typed GC object, constructable only by the Wasm `struct.new`
inside the **exported** helper `__make_iterator_result(i32, externref)`. The
runtime reaches that export via `callbackState.getExports().__make_iterator_result`.

`buildImports` *always* creates `callbackState = { getExports: () => wasmExports }`
(runtime.ts:7393), but `wasmExports` starts `undefined` and is only populated
when the caller invokes the returned `setExports(instance.exports)` callback
(runtime.ts:7475-7477). Two facts decide everything:

1. The real driver (`src/index.ts` runner, runtime.ts:7690-7691) **does** call
   `setExports`. The shared equivalence helper (`tests/equivalence/helpers.ts:198,209`)
   **does** call `setExports`. So `symbol-iterator-protocol.test.ts` — which uses
   `compileToWasm` — would actually work under the struct path.
2. `tests/iterators.test.ts:12` hand-rolls `WebAssembly.instantiate` and **never
   calls `setExports`**. So in that one harness `wasmExports` stays `undefined`,
   `make` is `undefined`, `__iterator_next` returns the **raw JS object**, and the
   codegen's **unconditional** `any.convert_extern` + `ref.cast $IteratorResult`
   (loops.ts in #347, ~L3406-3410) traps with `illegal cast`.

So the "proven regression" is two distinct defects:
- **(a) a brittle/unconditional `ref.cast`** in codegen that assumes the struct is
  always present, with no guard, and
- **(b) a test-harness wiring gap** (`iterators.test.ts` forgets `setExports`).

Fixing (b) alone makes the existing tests pass, but leaves (a) as a latent
foot-gun: any future embedder that forgets `setExports` gets a hard trap instead
of a graceful fallback. We fix both.

### Chosen approach — **Option C, hardened** (struct is the single path; cast is guarded; wiring gap closed)

Rationale for rejecting A and B:

- **Option A is impossible as literally stated.** The runtime cannot synthesise a
  typed GC struct in JS; it *must* call the Wasm export. "Make the runtime aware
  of `__make_iterator_result` earlier" reduces to "ensure `setExports` is called",
  which is exactly the wiring gap (b).
- **Option B re-introduces the imports we are removing.** To read `done`/`value`
  from a *raw JS object* fallback, codegen would still need `__iterator_done` /
  `__iterator_value` host imports — defeating the issue's primary acceptance
  criterion ("imports eliminated"). A conditional `ref.test`+branch in codegen
  cannot dispatch to a JS-object reader without those imports.

**Option C** keeps the single struct path (imports gone), and addresses the two
defects with the smallest possible surface:

1. **Close the wiring gap (b)** so the struct is *always* reachable wherever the
   for-of struct codegen runs: make `iterators.test.ts` call `setExports`, exactly
   like the equivalence helper already does. This is the actual fix for the proven
   regression.
2. **Harden the cast (a)** so a missing struct degrades to a clear thrown error
   rather than a raw `illegal cast` trap, AND so the value field round-trips
   correctly: guard the `ref.cast` with `ref.test` and, on the (should-not-happen)
   false branch, throw a `TypeError` via the existing exn tag. This is defence in
   depth; under correct wiring it is never taken.

This minimises test churn (only the two stale WAT assertions + one harness line
change), keeps the import surface reduced, and removes the latent trap.

### Changes

**File: `src/codegen/index.ts` — `addIteratorImports` (current ~L6716)**
- Port the #347 version verbatim from commit `4b9f14e30:src/codegen/index.ts`
  (~L6402-6483): register the `__IteratorResult` struct type (fields
  `done: i32` immutable, `value: externref` immutable), store its idx on
  `ctx.iteratorResultTypeIdx`, add it to `ctx.structMap`/`ctx.structFields`,
  and define+export the Wasm helper `__make_iterator_result(i32 done, externref value)`
  returning `(ref null $IteratorResult)` via `struct.new`.
- **Remove** the three legacy imports `__iterator_done`, `__iterator_value`, and the
  now-unused `extToI32` func-type registration (current L6730-6741).
- **Keep** `__iterator`, `__iterator_next` (still `externref→externref`),
  `__iterator_return`, and `__iterator_rest` (#1052). Order: keep `__iterator_rest`
  registered before defining `__make_iterator_result` so `makeFuncIdx =
  ctx.numImportFuncs + ctx.mod.functions.length` (read live) stays correct — this
  is the index reconciliation #347 already proved clean.
- Verify `ctx.iteratorResultTypeIdx` exists on the codegen context type
  (`src/codegen/context/types.ts`); #347 added it there — port that field too.

**File: `src/codegen/statements/loops.ts` — `compileForOfIterator` (current ~L3330-3465)**
- Replace the three-import sequence (`nextIdx`/`doneIdx`/`valueIdx` lookups +
  the `call doneIdx` / `call valueIdx` reads) with the struct path from
  `4b9f14e30:src/codegen/statements/loops.ts` (~L3286-3416):
  - Look up `const iterResultTypeIdx = ctx.iteratorResultTypeIdx;` (error out if
    undefined, same as today's missing-import guard).
  - `__iterator_next(iter)` → `local.set resultLocal` (still `externref`).
  - **done read (guarded):** recover the struct, then read field 0:
    ```wasm
    local.get $result
    any.convert_extern              ;; externref -> anyref
    ref.test (ref $IteratorResult)  ;; guard before cast (avoids illegal_cast)
    if (result i32)
      local.get $result
      any.convert_extern
      ref.cast (ref $IteratorResult)
      struct.get $IteratorResult 0  ;; done: i32
    else
      ;; wiring gap: __make_iterator_result was unreachable. Throw a clear
      ;; TypeError instead of trapping. (ref.null.extern + throw <exnTag>)
      ref.null.extern
      throw $exnTag
    end
    ```
    Use `ensureExnTag(ctx)` (already imported/used at L3283) for the tag.
  - **value read:** identical guard pattern, `struct.get $IteratorResult 1`
    (`externref`) on the true branch; the false branch is already handled by the
    done read short-circuiting via throw, so value read may assume the struct is
    present (it executes only after `done` was successfully read this iteration).
    Keep it simple: `any.convert_extern` + `ref.cast` + `struct.get … 1` (the done
    guard one line above guarantees testability this iteration).
- Update the doc-comment pseudo-code block (current L3231-3238 / #347 L3188-3195)
  to describe the struct path, not `__iterator_done`/`__iterator_value`.
- Leave all the surrounding machinery untouched: null-check (L3279-3312),
  iterator-close `finallyStack` entry, break/continue depth math, the 1M-iteration
  guard, destructuring branches. #347 already preserved these; do not re-derive
  the depth arithmetic.

**File: `src/runtime.ts` — `__iterator_next` (current ~L5865-5893)**
- Replace with the consolidated #347 body (`4b9f14e30:src/runtime.ts` ~L5858-5912):
  resolve `next` (own/sidecar/`__sget_next`/`__call_fn_0`/`__call_next`), capture
  `raw`, extract `done` (own/sidecar/`__sget_done`) and `value`
  (own/sidecar/`__sget_value`), then:
  ```ts
  const exports = callbackState?.getExports();
  const make = (exports as any)?.__make_iterator_result;
  if (typeof make === "function") return make(done ? 1 : 0, value);
  return raw; // defensive only; codegen now throws TypeError if this path is hit
  ```
- **Delete** the `__iterator_done` (L5894-5903) and `__iterator_value`
  (L5904-5913) import branches entirely — they are no longer registered, so
  leaving them is dead code; remove for clarity.
- Fix the misleading comment: the fallback no longer keeps a "legacy host-import
  path" working (there is none); reword to "defensive only — codegen guards with
  ref.test and throws TypeError if the struct is unreachable (host forgot
  setExports)".

**File: `tests/iterators.test.ts`**
- **Wiring fix (the actual regression fix), L12:** after `instantiate`, call
  `setExports`, mirroring the equivalence helper:
  ```ts
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports as WebAssembly.Imports);
  if (typeof (imports as any).setExports === "function")
    (imports as any).setExports(instance.exports);
  ```
- **Stale WAT assertions, L90-91:** delete the two `expect(result.wat).toContain("__iterator_done")`
  and `__iterator_value` assertions; replace with assertions that prove the struct
  path:
  ```ts
  expect(result.wat).toContain("__make_iterator_result");
  // optionally: expect(result.wat).toContain("IteratorResult");
  ```
  Keep the `__iterator` and `__iterator_next` assertions (L88-89) — both imports
  still exist.

### Test assertions to update
- `tests/iterators.test.ts:90-91` — swap `__iterator_done`/`__iterator_value`
  for `__make_iterator_result` (struct path). (Required by acceptance.)
- `tests/iterators.test.ts:12` — add the `setExports` call (harness wiring).
- Audit for any other test asserting on the removed imports:
  `grep -rn "__iterator_done\|__iterator_value" tests/` — update/remove each hit
  the same way. (None expected outside `iterators.test.ts` per the issue, but
  verify before pushing.)

### Estimated test impact
- **Stays green (was the proven regression):** all 5 string for-of cases in
  `tests/iterators.test.ts` and the custom-iterable cases in
  `tests/symbol-iterator-protocol.test.ts` — no more `illegal cast` once the
  struct is the single path and `setExports` is wired.
- **No test262 regression expected:** string for-of and generic-iterable for-of
  run through `src/index.ts` / equivalence-style harnesses that already call
  `setExports`, so the struct is always reachable there. The codegen `ref.test`
  guard converts the (unreachable-under-correct-wiring) failure mode from a hard
  trap into a thrown `TypeError`, which is strictly safer.
- **Net conformance:** neutral-to-slightly-positive (fewer host calls per step:
  3 → 1). The primary win is host-independence: `__iterator_done` /
  `__iterator_value` imports eliminated, satisfying the `goal: host-independence`.

### Risks / coordination
- **`addUnionImports` index shift:** `__make_iterator_result` is a *defined &
  exported* Wasm function, not an import, so it does not participate in import
  index shifting; but confirm `makeFuncIdx` is computed live
  (`ctx.numImportFuncs + ctx.mod.functions.length`) and not cached before any
  later import additions. #347 got this right — preserve it.
- **`ctx.iteratorResultTypeIdx` field:** must exist on the codegen context type
  (`context/types.ts`). Porting #347's addition is required, or `addIteratorImports`
  won't compile.
- **No conflict with `__iterator_rest` (#1052):** both coexist; keep both. Already
  proven clean in `4b9f14e30`.
- **Async iterator path:** `compileForOfIterator` also serves `for await…of`
  (`stmt.awaitModifier` → `ensureAsyncIterator`). `__async_iterator` /
  `__gen_next` results must flow through the same `$IteratorResult` struct read.
  Verify the async path also lands its `next` result through `__iterator_next`
  (or an equivalent that calls `__make_iterator_result`); if `__async_iterator`'s
  iterator is consumed via a *different* `next` import, that import needs the same
  struct-construction treatment, or its for-of read must keep a separate path.
  Check `ensureAsyncIterator` and async-iterator tests before assuming parity.

## BLOCKED — Option C is not viable as specced (verified 2026-05-27, dev-1593)

Option C assumes the `$__IteratorResult` struct can be built in Wasm
(`__make_iterator_result`, exported), returned to the JS `__iterator_next`
bridge, and then flow back into Wasm as the import's `externref` result, where
the for-of read recovers it via `any.convert_extern` + `ref.cast`. **This
round-trip does not work in V8 (Node 25).**

Verified empirically (probes in `.tmp/`, branch `issue-1620-iterator-result-struct`):

- `__make_iterator_result` is exported and reachable (`setExports` wired).
- Calling it directly from JS — `instance.exports.__make_iterator_result(0, 7)`
  — returns **`undefined`** (`=== undefined` is `true`), whether the helper
  returns `(ref null $IteratorResult)` *or* externalizes via
  `extern.convert_any` to return `externref`. WAT confirms `struct.new 11`
  + `extern.convert_any` are emitted and the export signature is
  `(param i32 externref) (result externref)`.
- So the runtime's `return make(done?1:0, value)` hands `undefined` back as the
  `__iterator_next` import result. Wasm sees a null externref, the for-of
  `ref.test (ref $__IteratorResult)` guard is **false**, and the hardened
  else-branch throws `TypeError` (the `Exception` the failing test observes).
- The 5 string-for-of cases in `tests/iterators.test.ts` pass **only because
  strings never call `__iterator_next`** — they use the in-codegen array
  fast-path. Confirmed: wrapping `__iterator_next` shows it is never invoked
  for string for-of. So those green tests do **not** exercise the struct path;
  the **custom-iterable** case in `symbol-iterator-protocol.test.ts` is the
  only one that does, and it fails.

**Root cause:** a freshly-constructed internal WasmGC struct, externalized and
returned through a *plain JS import boundary*, is surfaced to JS as `undefined`
and cannot be re-internalized by the consumer. The struct cannot survive the
JS hop that `__iterator_next` (a JS host import) forces. This is the real
"runtime wiring gap" the issue warned about — it is a design constraint, not a
localized bug.

**Why the obvious fixes don't apply:**
- Externalizing in `__make_iterator_result` (the change tried) does not help —
  the externref still surfaces as `undefined`.
- Reverting to read `done`/`value` from the raw JS result object in Wasm would
  require `__iterator_done` / `__iterator_value` host imports — the very imports
  this issue exists to remove (Option B, already rejected in the spec).

**Needs architect respec.** Candidate directions (need a decision):
1. Build the `$__IteratorResult` struct **at the for-of call site in Wasm**,
   after `__iterator_next` returns the *raw JS result object* (which survives
   as externref). Reading `done`/`value` from a JS object in pure Wasm without
   host imports is the open problem — possibly via a single combined
   `__iterator_next_done_value` import that returns the two primitives packed,
   or via a Wasm-native iterator representation for compiler-emitted iterators
   (relates to #1665 native generators / shared `$Iterator` design).
2. Accept a narrowed scope: keep the host imports for the *JS-host* mode and
   only use the struct path in *standalone* mode where iterators are
   Wasm-native end to end (no JS hop). This satisfies `goal: host-independence`
   for standalone without breaking JS-host custom iterables.

WIP (this investigation + the externref attempt) is committed on branch
`issue-1620-iterator-result-struct` for the architect to build on.

## Implementation Plan (v2)

### Direction chosen — **Direction 1: multi-value import** (struct eliminated entirely)

The v1 (Option C) struct round-trip is dead: a WasmGC struct externalized and
returned through the `__iterator_next` JS import boundary surfaces as
`undefined` in V8/Node 25 (proven by dev-1593, see BLOCKED section). The struct
cannot survive the JS hop a host import forces.

Direction 1 sidesteps the struct completely. Change `__iterator_next` from
`(externref) → externref` to `(externref) → (i32 done, externref value)` — a
**Wasm multi-value result**. The runtime reads `done`/`value` off the raw JS
result object and returns them as a two-element JS array `[done ? 1 : 0, value]`.
V8/Node implement the JS↔Wasm multi-value ABI: a JS import declared with N
results must return an iterable of length N, which V8 destructures onto the Wasm
stack. Both values are **primitives** (i32 + externref), not a GC object, so
there is no struct, no `any.convert_extern`, no `ref.cast`, and no JS-hop
`undefined` problem. This deletes the `__iterator_done` and `__iterator_value`
imports outright — exactly the issue's primary acceptance criterion — with no
fallback host imports (so it also satisfies `goal: host-independence`).

**Feasibility confirmed** by source inspection (no probe needed — the encoders
already handle arbitrary result vectors):
- `addFuncType(ctx, params, results, name?)` (`src/codegen/registry/types.ts:30`)
  takes `results: ValType[]` of any length; the cache key
  (`funcTypeKey`, L12-28) already serialises the full results list.
- Binary type-section emitter writes the full results vector:
  `enc.vector(t.results, …)` (`src/emit/binary.ts:401`). No single-result
  assumption anywhere.
- WAT emitter maps all results (`src/emit/wat.ts:212,290`).
- A `call` to a `(result i32 externref)` import leaves two values on the stack
  (results pushed left-to-right ⇒ **`value` (externref) is on top, `done` (i32)
  below it**). The loop just does two `local.set`s in that order. No new opcode,
  no block-type machinery — the existing per-iteration code already runs inside
  the `loop` body where a bare `call` + `local.set` is legal.

### Changes

**File: `src/codegen/index.ts` — `addIteratorImports` (current ~L6741-6781)**

- Change the `__iterator_next` registration to use a **multi-value** func type
  instead of reusing `extToExt`:
  ```ts
  // __iterator_next: (externref) → (i32 done, externref value)
  // Multi-value result avoids the $IteratorResult struct (a GC struct cannot
  // survive the JS import hop — it surfaces as undefined in V8; see #1620).
  const extToDoneValue = addFuncType(
    ctx,
    [{ kind: "externref" }],
    [{ kind: "i32" }, { kind: "externref" }],
  );
  addImport(ctx, "env", "__iterator_next", { kind: "func", typeIdx: extToDoneValue });
  ```
  Leave the `__iterator` registration (and its `extToExt` type) exactly as is.
- **Delete** the `__iterator_done` import + its `extToI32` func-type
  registration (current L6755-6760) and the `__iterator_value` import (current
  L6762-6766). `extToI32` is now unused — remove the line so there's no dead
  type registration.
- **Keep** `__iterator`, `__iterator_return` (`extToVoid`), and `__iterator_rest`
  (`extToExt`) unchanged. Do NOT touch the `__make_iterator_result` /
  `$IteratorResult` machinery from PR #347 — it is not on current main (v1 was
  never merged), so there is nothing to port or remove here. The index math
  (`makeFuncIdx`) concerns in v1 do not apply: we add no defined+exported helper.
- **No `ctx.iteratorResultTypeIdx`** field is needed (that was v1-only). Do not
  add it.

**File: `src/codegen/statements/loops.ts` — `compileForOfIterator`
(current ~L3330-3465)**

- Update the lookup block (current L3330-3337): drop `doneIdx`/`valueIdx`; only
  `nextIdx` and `returnIdx` remain relevant from this set:
  ```ts
  const nextIdx = ctx.funcMap.get("__iterator_next");
  const returnIdx = ctx.funcMap.get("__iterator_return");
  if (nextIdx === undefined) {
    reportError(ctx, stmt, "for-of on non-array type requires iterator imports");
    return;
  }
  ```
- Allocate a **done** local alongside the existing `resultLocal`. `resultLocal`
  (externref) is now repurposed to hold the **value**; rename for clarity or keep
  it as the value slot. Add an i32 local for done:
  ```ts
  const nextDoneLocal = allocLocal(fctx, `__forof_done_raw_${fctx.locals.length}`, { kind: "i32" });
  ```
  (Distinct from the existing `doneFlag` at L3393, which is the iterator-close
  bookkeeping flag — keep that.)
- Replace the per-iteration `__iterator_next` + `__iterator_done` +
  `__iterator_value` sequence (current L3442-3465) with a single multi-value
  call. **Order matters** — value (externref) is on top of the stack, done (i32)
  below, so pop value first:
  ```wasm
  ;; result = __iterator_next(iter)  →  pushes  done(i32), value(externref)
  local.get $iter
  call $__iterator_next
  local.set $value        ;; top-of-stack = externref value  → resultLocal/value slot
  local.set $doneRaw      ;; next = i32 done                   → nextDoneLocal
  ```
  i.e. in instr terms:
  ```ts
  fctx.body.push({ op: "local.get", index: iterLocal });
  fctx.body.push({ op: "call", funcIdx: nextIdx });
  fctx.body.push({ op: "local.set", index: resultLocal });   // externref value (top)
  fctx.body.push({ op: "local.set", index: nextDoneLocal }); // i32 done (below)
  ```
- Replace the done-check (current L3448-3460) — no more `call doneIdx`; read the
  i32 local directly:
  ```ts
  fctx.body.push({ op: "local.get", index: nextDoneLocal });
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: [
      { op: "i32.const", value: 1 } as Instr,
      { op: "local.set", index: doneFlag } as Instr,
      { op: "br", depth: 2 } as Instr, // break: if + loop = depth 2
    ],
    else: [],
  });
  ```
- Replace the value read (current L3462-3465) — no more `call valueIdx`; the
  value is already in `resultLocal`. Just move it into `elemLocal`:
  ```ts
  fctx.body.push({ op: "local.get", index: resultLocal });
  fctx.body.push({ op: "local.set", index: elemLocal });
  ```
  (Or, micro-optimisation: `local.set` directly into `elemLocal` at the call
  site instead of `resultLocal`, dropping one local + one copy. Keep `resultLocal`
  only if it's referenced elsewhere — it is not, after this change, so collapsing
  is safe. Either is acceptable; prefer the explicit two-local version above for
  reviewability.)
- Update the doc-comment pseudo-code (current L3231-3238): replace the
  `__iterator_done` / `__iterator_value` lines with:
  ```
  *     (done, value) = __iterator_next(iter)   // multi-value result
  *     if done → break
  *     elem = value
  ```
- **Leave everything else untouched**: the null-check (L3279-3312), the
  break/continue depth `+3` math (L3384-3389 / L3500-3503), the `doneFlag`
  iterator-close bookkeeping, the `finallyStack` entry, the 1M-iteration guard,
  the try/catch_all iterator-close wrapper (L3521-3570), and all destructuring
  branches. None of these depend on how `done`/`value` are obtained.

**File: `src/runtime.ts` — `__iterator_next` (current ~L5877-5905)**

- Change the returned import function to compute `done`/`value` itself (folding
  in the logic currently split across `__iterator_done` / `__iterator_value`) and
  return a **two-element array** `[done ? 1 : 0, value]`:
  ```ts
  if (name === "__iterator_next")
    return (iter: any): [number, any] => {
      // Resolve iter.next (own / sidecar / __sget_next / WasmGC closure / __call_next)
      let raw: any;
      let next = iter.next ?? _sidecarGet(iter, "next");
      if (next === undefined) {
        const exports = callbackState?.getExports();
        next = exports?.__sget_next?.(iter);
      }
      if (typeof next === "function") {
        raw = next.call(iter);
      } else if (next != null && _isWasmStruct(next)) {
        const exports = callbackState?.getExports();
        const callFn0 = (exports as any)?.__call_fn_0;
        if (typeof callFn0 === "function") raw = callFn0(next);
      }
      if (raw === undefined) {
        const exports = callbackState?.getExports();
        const callNext = (exports as any)?.["__call_next"];
        if (typeof callNext === "function") raw = callNext(iter);
      }
      if (raw === undefined) throw new TypeError("iterator.next is not a function");

      // Extract done (own / sidecar / __sget_done)
      let done = raw.done ?? _sidecarGet(raw, "done");
      if (done === undefined) {
        const exports = callbackState?.getExports();
        done = exports?.__sget_done?.(raw);
      }
      // Extract value (own / sidecar / __sget_value)
      let value = raw.value;
      if (value === undefined) {
        value = _sidecarGet(raw, "value");
        if (value === undefined) {
          const exports = callbackState?.getExports();
          value = exports?.__sget_value?.(raw);
        }
      }
      // Wasm multi-value ABI: return an iterable of [i32 done, externref value].
      return [done ? 1 : 0, value];
    };
  ```
  Note the subtle change vs the old split path: the old `__iterator_next` could
  fall through `__call_fn_0` / `__call_next` returning `result != null` and
  return that struct directly; here `raw` is the result object and we always
  extract from it. Preserve the same resolution *order* (own next → sidecar →
  `__sget_next` → `__call_fn_0` closure → `__call_next`) so existing WasmGC
  iterator shapes keep working — only the final return shape changes.
- **Delete** the `__iterator_done` (L5906-5915) and `__iterator_value`
  (L5916-5925) import branches entirely — they are no longer registered by
  `addIteratorImports`, so they would be dead. Removing them keeps the import
  table honest.
- `__iterator_rest` and `__iterator_return` are **unchanged** — they read the raw
  iterator directly and never went through the result-struct path.

### Tests to update

- **`tests/iterators.test.ts` L88-91** — the stale assertions assert the WAT
  contains `__iterator_done` / `__iterator_value`. Those imports are gone. Update:
  ```ts
  expect(result.wat).toContain("__iterator");        // keep — still imported
  expect(result.wat).toContain("__iterator_next");   // keep — still imported
  // removed: __iterator_done / __iterator_value
  // The next import now has a 2-result type; optionally assert the multi-value
  // signature surfaced in the WAT, e.g.:
  // expect(result.wat).toMatch(/__iterator_next.*\(result i32 externref\)|\(result i32 externref\)/);
  ```
  Keep the assertion permissive — the exact WAT spelling of the import's result
  list depends on the formatter; asserting the two import *names* are gone +
  `__iterator_next` present is sufficient.
- **`tests/iterators.test.ts` L12 (harness)** — v1 required a `setExports` call
  because the struct path needed the exported `__make_iterator_result`. **v2 needs
  no exported helper**, so the existing hand-rolled `WebAssembly.instantiate`
  without `setExports` is fine for `__iterator_next` — the import is pure JS.
  However, the resolution chain still references `callbackState?.getExports()` for
  the `__sget_*` / `__call_*` fallbacks (only used by WasmGC struct iterators). The
  5 string for-of cases use the in-codegen array fast-path and never call
  `__iterator_next` at all, so they pass regardless. **No harness change required**
  for v2 — but add the `setExports` call anyway if you want the WasmGC-struct
  fallbacks exercisable in that harness (low priority).
- **`tests/symbol-iterator-protocol.test.ts`** — the custom-iterable case is the
  real exerciser of `__iterator_next`. It must pass (it currently fails on the
  v1 branch with the `undefined`-struct `TypeError`). With v2 it gets a real
  `[done, value]` array — verify it passes.
- **Audit**: `grep -rn "__iterator_done\|__iterator_value" tests/ src/` and
  remove/update every hit. None expected outside `iterators.test.ts` and the
  runtime branches being deleted, but verify before pushing.

### Edge cases

- **Async iterator path** (`for await…of`, `stmt.awaitModifier` →
  `ensureAsyncIterator`, L3316-3318): `ensureAsyncIterator` only swaps the
  `__iterator` call for an async-iterator acquisition; the per-step `next` still
  flows through `ctx.funcMap.get("__iterator_next")`. So the multi-value change
  covers the async path **for free** — but the runtime's `next.call(iter)` may
  return a **Promise** for async iterators (`{value, done}` wrapped in a Promise).
  The current code does not `await` (the async lowering handles suspension
  elsewhere). **Verify**: check whether `ensureAsyncIterator` registers a
  *separate* next import or reuses `__iterator_next`. If async iteration resolves
  the promise before reaching the result read (likely via the generator/async
  state machine), the `[done, value]` extraction sees a settled object and works.
  If async uses a distinct next import, that import needs the same multi-value
  treatment. Confirm against the async-iterator tests before assuming parity — do
  not block v2 on this; the sync custom-iterable case is the acceptance gate.
- **`__iterator_return`** is orthogonal and unchanged (separate import, reads the
  raw iterator, no result object). The iterator-close protocol (try/catch_all,
  finallyStack, post-loop break check) is untouched.
- **`raw` is null/undefined** (malformed iterator): the runtime throws
  `TypeError("iterator.next is not a function")` (preserved). Reading `.done`/
  `.value` off a non-null non-object `raw` returns `undefined` → `done=0`,
  `value=undefined` → externref null in Wasm, which the loop treats as a normal
  (non-done) element. This matches the old behaviour (old `__iterator_done`
  returned 0 for missing `done`). Acceptable.
- **`done` truthiness**: spec says `IteratorComplete` does `ToBoolean(result.done)`.
  `done ? 1 : 0` matches (preserved from old `__iterator_done`).
- **value is a JS number / boolean / string**: returned inside the array as-is;
  V8 boxes it to externref at the ABI boundary exactly as the old
  `__iterator_value` import return did. No behaviour change.
- **Multi-value JS-import ABI requirement**: the import MUST return an *iterable*
  of exactly length 2. A plain array literal `[d, v]` is iterable — correct. Do
  **not** return an object `{done, value}` (not the multi-value shape) or a bare
  scalar.

### Estimated impact

- Host calls per iteration step: **3 → 1** (`next`+`done`+`value` collapse into a
  single `__iterator_next`). Net-positive for perf and host-independence.
- Imports eliminated: `__iterator_done`, `__iterator_value`. Acceptance met.
- No GC-struct round-trip ⇒ no V8 `undefined` hazard ⇒ the BLOCKED failure mode
  is structurally impossible.
- test262: neutral-to-positive; string for-of unaffected (array fast-path),
  custom-iterable for-of fixed.

### Risks / coordination

- **Result stack order** is the one easy-to-get-wrong detail: with
  `(result i32 externref)`, externref `value` is on top. `local.set` value
  **first**, then done. Getting this backwards is a type mismatch the WAT/binary
  validator will catch immediately, but call it out in the PR.
- **No index-shift risk**: we add/remove only *imports* and change one import's
  type — `addUnionImports` shifting concerns from v1 do not apply (no new
  defined+exported helper).
- **No `context/types.ts` change**: `iteratorResultTypeIdx` is not introduced.
- Coexists cleanly with `__iterator_rest` (#1052) — untouched.
