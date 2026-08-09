---
id: 3996
title: "codegen: keep local indexes stable across package-entry emission"
status: in-progress
sprint: Backlog
created: 2026-07-30
updated: 2026-08-09
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
language_feature: n/a
goal: dogfood
related: []
loc-budget-allow:
  - src/codegen/closure-exports.ts
  - src/codegen/context/types.ts
  - src/codegen/expressions/new-super.ts
  - src/codegen/fnctor-constructor-identity.ts
  - src/codegen/statements/nested-declarations.ts
  - src/codegen/expressions/call-identifier.ts
  - src/codegen/object-ops.ts
func-budget-allow:
  - src/codegen/closure-exports.ts::emitClosureMethodCallExportN
  - src/codegen/expressions/calls.ts::tryEmitInlineDynamicCall
  - src/codegen/object-ops.ts::compileObjectKeysOrValues
---

# codegen: keep local indexes stable across package-entry emission

## Problem

Packages:
- lodash 4.18.1 lodash.js: __cb_6
- redux 5.0.1 redux.mjs: observable
- moment 2.30.1 moment.mjs: normalizeObjectUnits

Failure: Binary emit error: RangeError: Codegen error: local index out of range — 19 (valid: [0, 15))

Derive local indexes from the final function layout after deferred imports, types, and import insertion.

Reproduce: pnpm run dogfood:lodash, pnpm run dogfood:redux, pnpm run dogfood:moment.

## 2026-08-09 measured Redux decomposition

On `origin/main` at `ed4ebd253f14aa`, the pinned Redux 5.0.1 entry failed before
binary emission in `observeState`: the lifted descendant called the ancestor's
capturing sibling `getState`, but the call used local indexes from the original
`createStore` frame. After forwarding the already-threaded captures through
the immediate `subscribe` frame, the next independent failure was Redux's
JSDoc-less `bindActionCreator(actionCreator, dispatch)`. Its returned function
resolved the local `dispatch` parameter to an unrelated bare-name nested
declaration and prepended that declaration's captures.

Fixing those two frame-selection defects exposed an invalid binary in
`combineReducers`' returned `combination` function:

```text
local.tee expected (ref null ...), found local.get of type i32
```

The name-only free-variable scan excluded function-scoped `var` but
intentionally did not exclude block-scoped declarations. Because the enclosing
function also had locals named `i` and `key`, `combination` spuriously captured
and boxed those outer slots even though every use resolved to its own
`for (let i ...)` / `const key`. The inner numeric `i` was then consumed through
the outer ref-cell type. The narrow correction uses checker declaration
identity only for same-name collision candidates and removes a capture only
when every real reference resolves inside the closure.

That compile-only checkpoint was subsequently extended to Redux's original
runtime workload. The remaining generic defects were at the host/Wasm closure
boundary rather than in Redux itself: closure dispatch had to restore host
proxies to their underlying Wasm structs, first-class escaping reducers could
not be narrowed to the single object shape seen at a direct call site, and a
callback retained by `subscribe` needed a shared mutable capture cell rather
than a value copied back when the registration call returned.

Measured result with the complete correction applied:

- `pnpm run dogfood:redux-workload` compiles and validates the pinned Redux
  5.0.1 entry, then passes the original differential workload 1/1 with the
  native Node result `781`.
- The npm-compat report path independently compiles a 57,186-byte binary,
  validates it, and passes the same API workload 1/1.
- The focused Redux regressions pass 9/9, including cross-shape reducer calls,
  retained subscriber state, and the multi-module closure dispatcher ABI.
- The exact full workload compile measured about 2.0 s locally; timing is
  informational and is not a compatibility gate.

Redux is therefore compile-, validation-, and runtime-verified. Lodash and
Moment remain separate residuals under the same package-frontier umbrella; a
Redux win is not evidence that either is fixed, so this umbrella issue remains
open.

## 2026-08-09 measured Moment fnctor-constructor residual

On integrated baseline `e1f0525b0170d6`, the pinned Moment 2.30.1 entry reached
the synthesized `__fnctor_Duration_new` constructor but emitted references to
the factory frame's capture slots: `ordering@80`, `locales@66`,
`baseConfig@65`, `localeFamilies@67`, `hookCallback@121`, and the mutable
`globalLocale@212`. The constructor frame declared only one user parameter and
59 locals, so stack-balance correctly rejected the first `local.get 80`.

The generic correction gives every synthesized fnctor constructor the same
leading capture contract as a lifted nested function: immutable captures are
value parameters, mutable captures are shared ref-cell parameters, and TDZ
flag cells (when present) follow the value captures. The call site resolves
each capture from the caller's live frame or promoted cell global, then emits
user arguments and the standalone constructor-identity parameter. The ctor
body registers those parameters before compiling sibling calls, so no source
or package name is special-cased.

Measured on the same pinned entry after the correction:

- `node --import tsx tests/dogfood/npm-compat-catalog-harness.mjs --package moment --json`
  succeeds: 379,959-byte binary, `WebAssembly.validate` succeeds in 9.4 s.
- Focused runtime regression `tests/issue-3996-fnctor-constructor-captures.test.ts`
  passes: two synthesized `Box` instances share a mutable sibling capture and
  return the native-equivalent result `27`.
- Moment's catalog harness has no differential workload yet, so package
  correctness remains **unverified** after compile/validation.

The earlier frame-index failure is resolved. Any next Moment residual should be
recorded separately from this constructor-frame fix rather than weakening the
frame invariant.

## 2026-08-09 measured Lodash cached-constructor ABI residual

The capture forwarding added for Moment exposed a separate cache-consistency
bug in the pinned Lodash 4.18.1 entry. `LodashWrapper`'s synthesized constructor
was first minted with no leading captures. Later compilation of the repeated
`runInContext` frame replaced the bare-name `nestedFuncCaptures` entry with an
`undefined` capture. Cached `new LodashWrapper(...)` sites then recomputed that
new layout while still calling the immutable old Wasm signature. In
`wrapperClone`, this shifted the expected type of `wrapper.__wrapped__` and
emitted an `i32` where the constructor expected `externref`, so the package
compiled but failed `WebAssembly.validate`.

The generic correction stores the exact capture layout in `funcConstructorMap`
when the constructor function and its Wasm type are created. Every cache hit
uses that same snapshot both to recover the user-parameter suffix and to emit
capture arguments. Later changes to global, bare-name capture discovery can no
longer mutate an already-minted constructor ABI.

Measured after the correction:

- The focused source regression fails validation before the fix and now runs to
  the native-equivalent result `42`.
- `tests/issue-3996-fnctor-constructor-captures.test.ts` remains green with
  result `27`, retaining the Moment capture-forwarding behavior.
- The exact pinned Lodash catalog harness compiles a 1,458,438-byte binary in
  about 25.9 s and `WebAssembly.validate` succeeds.
- Lodash still has no runtime differential workload in the catalog harness, so
  package correctness remains **unverified** beyond compile and validation.

## 2026-08-09 merge-queue standalone boolean-carrier regression

The integrated npm-compat branch initially failed its authoritative
merge-group Test262 run at 27,063 standalone host-free passes, 2,324 below the
committed high-water mark. An exact baseline diff found 2,387 lost passes and
63 gains; 2,366 losses were assertion failures dominated by propertyHelper's
`<name> should be an own property` messages.

A local commit bisect identified `4237ffebcf0ff51` and file-level isolation
narrowed the regression to the new typed-i32 path in
`src/codegen/closure-exports.ts`. Standalone boolean values crossing a host
closure boundary can use the engine's i31 numeric carrier. Routing them through
`__unbox_boolean` therefore produced false, while the existing
`__unbox_number` union decoder already accepts i31, boxed-number, and
boxed-boolean carriers. Both free-call and method-call closure bridges now use
that decoder before the saturating i32 conversion.

Measured validation after the correction:

- A 20-file authentic standalone harness sample drawn directly from the lost
  pass set changed from 0/20 to 20/20 passing.
- `tests/issue-1308.test.ts` and the nine focused Redux runtime regressions pass
  18/18 together.
- The authoritative full-corpus confirmation remains the next merge-queue run;
  the high-water mark is not re-seeded or weakened.

## Provenance

Migrated on 2026-08-01 from a GitHub issue on `loopdive/js2` (opened 2026-07-30)
that was created by an agent in error — this project tracks work as markdown
under `plan/issues/`, not as GitHub issues. The GitHub issue has been closed and
points here. **No content was dropped:** the Problem section above is the
original issue body verbatim.

Metadata below the title is newly assigned and is a **starting estimate, not a
measurement** — `priority`, `horizon` and `feasibility` were not stated in the
original and have not been validated against the corpus. Re-derive before
scheduling.
