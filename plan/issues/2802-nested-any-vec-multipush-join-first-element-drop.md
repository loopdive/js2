---
id: 2802
title: "nested `any`-vec mutation hits a host Array mirror instead of the WasmGC vec"
status: done
assignee: ttraenkler/codex-acorn
sprint: 77
priority: high
horizon: m
feasibility: hard
reasoning_effort: high
created: 2026-06-28
updated: 2026-07-30
completed: 2026-07-26
task_type: bugfix
area: codegen
language_feature: value-representation
goal: acorn-dogfood
related: [1712, 2784, 2794, 3603]
depends_on: [2784]
blocks: [1712]
---

# #2802 — nested `any`-vec mutation hits a host Array mirror

## Reactivated 2026-07-26 — full Acorn census proves a real parser path

The old “does NOT hit Acorn’s real path” assessment was true for the 23-file
curated corpus but is disproved by the full pinned-Acorn/Test262 differential.
Acorn’s named-RegExp-backreference validator stores names in
`RegExpValidationState.backReferenceNames` and calls:

```js
state.backReferenceNames.push(state.lastStringValue);
```

On the compiled parser, `regexp_eatKGroupName` is reached with `"a"`, the
`groupNames.ab` write is present, and `switchN` is true, but the nested vec’s
length remains zero after `push`. The final validation loop therefore never
runs and compiled Acorn accepts dangling named backreferences rejected by
node-acorn.

The exact host mechanism is now pinned. `__extern_method_call` first wraps the
WasmGC vec as an Array facade and reads `wrappedObj.push`. That is a callable
native `Array.prototype.push`, so it mutates only the materialized JS mirror and
returns before the existing raw-vec `__vec_push` fallback inside the
“not-a-function” arm can run. The fallback was correct but unreachable.

The fix performs the positive `__vec_mut_supported` interception before generic
host method lookup, then invokes `__vec_push`/`__vec_pop` on the raw WasmGC vec.
Read-only host materialization stays in the later fallback. Combined with
#1769’s nullable-return repair, the real four-family #3666 probe is now **4/4
files, 8/8 matching syntax rejections, 0 mismatches**.

This repairs the concrete Acorn path but does **not** close the broader original
storage-split symptom below. A fresh regression probe still observes three
pushes as length 2, and the separate read-only `join` bridge is not available
for that synthetic `any` receiver. Keep this issue open until both the original
multi-push contract and the Acorn path are green.

> Historical note (superseded 2026-07-26): the issue was originally deferred
> after Acorn's var-declaration path did not reproduce it. The full Test262
> census later found the real named-RegExp-backreference path described above,
> so the old “off Acorn's path” conclusion no longer applies.

## Symptom (observed during #2794's (2) vec-read work)

A vec stored in a struct field, accessed via an `any`-typed receiver, then
multi-pushed and read, can drop the FIRST pushed element:

```js
class Scope { lexical: string[]; constructor() { this.lexical = []; } }
function mkScope(): any { return new Scope(); }
const s: any = mkScope();
s.lexical.push("a");
s.lexical.push("b");
s.lexical.push("c");
s.lexical.join("|");      // → "b|c"   (expected "a|b|c" — first element dropped)
```

Yet `indexOf` of each element in SEPARATE function calls returned the correct
indices (0/1/2), so the inconsistency is non-trivial — it points at a
vec-IDENTITY / storage split (the push and the read seeing different vec
instances, or the first push targeting a transient vec before the field is
stabilized), the **same class as the S3 fix (#2784)** for
`this.scopeStack.push` round-trips.

## Likely mechanism (verify-first)

The nested field vec (`s.lexical` where `s` is `any`) is read via the host proxy
on each access. If `s.lexical` returns a fresh/transient vec wrapper on the first
push (before the field is written back), the first element lands on a vec that is
then replaced — mirroring the `currentVarScope()` / `scopeStack` storage-split
that #2784 fixed one level up. Confirm whether `s.lexical` reads a STABLE vec
identity across pushes (the `_hostProxyCache` / `__extern_get` field read should
return the same backing vec each time).

## Acceptance

- The repro above yields `"a|b|c"`; `length`/`indexOf` consistent with all
  pushed elements across mixed read/write sequences on a nested `any`-vec field.

## Resolution (2026-07-26)

The full Acorn differential confirmed that generic host lookup exposed a
materialized Array facade for a WasmGC vec. Native `push`/`pop` therefore
mutated only the temporary mirror, leaving Acorn's live nested
`backReferenceNames` vector unchanged.

`__extern_method_call` now intercepts vec `push`/`pop` before generic property
lookup and routes supported receivers through the module's canonical
`__vec_push`/`__vec_pop` exports. The fix preserves the existing read-only
materialization path and wrapper reversal. The clean published-head Test262
comparison is exact for all **53,259 files / 102,312 variants**, including the
dangling named-backreference family that reopened this issue.

## Method

- Banked probe under the #2794 branch `.tmp/` (`vec-read.ts` + `vec-read-run.mjs`,
  the multi-push + join case). Compile is small/fast (no full acorn needed).

## Implementation Plan

(arch, 2026-07-12. Verify-first, per the issue. Anchors verified on main.)

### Where the round-trip actually lives (read this before instrumenting)

Host (gc) mode; `s: any` is a WasmGC `$Scope` struct handled as externref.

- `s.lexical` read → host import `__extern_get(s, "lexical")`
  (src/runtime.ts sidecar machinery) → returns the vec struct, possibly
  wrapped by `_wrapForHost` (identity-stable per struct via
  `_hostProxyCache`, runtime.ts:5281).
- `.push("a")` → `__extern_method_call` → the **#1712 vec-mutator arm**
  (runtime.ts:11517-11565): `_unwrapForHost(obj)` → `rawVec`, then
  `__vec_mut_supported(rawVec)` gate → `exports.__vec_push(rawVec, x)`
  (Wasm-side per-vec-type dispatch, reserved up front by #2784 S3 —
  src/codegen/index.ts:5923-5940; `__vec_mut_supported` emit at :6352-6381).
  If the gate says NO, control falls to the **#2794 read-materialize arm**
  (runtime.ts:11570-11600): `_VEC_PRIMITIVE_READ_METHODS` copies the vec
  into a fresh JS array and applies the native method — for a READ that is
  fine; if a PUSH ever falls past the mut arm, the mutation lands on a
  transient copy and is lost.
- `.join("|")` → the same #2794 read-materialize arm (join is read-only).

### Step 1 — reproduce + pin the arm (half a day)

1. Re-run the banked probe on current main (the #2784/#2794 fixes may have
   moved the behavior; the issue predates them in detail).
2. Instrument runtime.ts: log per call — method name, whether
   `__vec_mut_supported(rawVec)` returned 1, `__vec_len` before/after, and a
   stable id for `rawVec` (e.g. a WeakMap counter). Three pushes then join:
   the log will show exactly which push (if any) took the fallthrough arm
   and whether all four calls saw the SAME rawVec identity.
3. Prime suspect A — **empty-literal vec typing**: `this.lexical = []` in
   the constructor may allocate a DIFFERENT vec type (generic/externref vec)
   than the field's declared `string[]` vec; `__vec_push`'s per-vec-type
   dispatch (index.ts:5923) then rejects the first push (returns <0 / gate
   fails) → first element lands via some fallback → dropped or stored on a
   replaced backing. Check the WAT: which vec type the constructor stores vs
   which type `__vec_push`'s dispatch arms cover.
4. Prime suspect B — **first-push backing replacement**: `__vec_push` grows
   by replacing the `data` array field inside the vec struct. If the FIELD
   READ (`s.lexical`) returned a copy/snapshot rather than the struct (or
   the host cached a materialized JS array across the push), the first
   push's grow is invisible to later reads. The `indexOf`-correct /
   `join`-wrong asymmetry fits a stale materialization cached between the
   read-materialize arm calls.

### Step 2 — fix per finding

- **If A (typing)**: make the empty-array-literal initializer in a class
  field/constructor assignment adopt the DECLARED field vec type (codegen
  side — the array-literal typing at the assignment site), or add the
  missing vec-type arm to the `__vec_push` dispatch builder
  (index.ts:5923-5960 region). Prefer the former: one representation, no
  dispatch growth.
- **If B (stale materialization/identity)**: ensure the #2794
  read-materialize arm NEVER caches the built JS array across calls (it
  currently builds fresh each call — verify), and that `_unwrapForHost`
  reverses every wrapper shape the field read can produce (the
  closure-bridge reverse at runtime.ts:11534-11539 is one such repair;
  the miss may be an analogous unreversed wrapper for string-vecs).

### Reuse

- The #1712 vec-mutator arm + #2794 read arm (runtime.ts:11517-11600) —
  extend the existing arms; do not add a new method-call path.
- `__vec_push`/`__vec_mut_supported` Wasm exports
  (src/codegen/index.ts:5923/:6352, the #2784 S3 reserve-up-front pattern) —
  any new vec-type arm goes into the same builders.
- `_wrapForHost`/`_hostProxyCache`/`_unwrapForHost` (runtime.ts:5281) for
  identity-stability questions.

### Acceptance / tests

- The issue's repro yields `"a|b|c"`; `length`/`indexOf`/`join` consistent
  across interleaved push/read sequences on a nested `any`-vec field.
- Add `tests/issue-2802.test.ts`: the repro + an interleaved
  push/read/push/join variant + a `this.field = []`-then-push-in-same-method
  variant (distinguishes A from B).
- acorn dogfood lane unchanged (this edge is off acorn's real path — #2794
  diffed EQUAL — so any fix must be regression-neutral there).
