---
id: 1719
title: "Array destructuring ignores overridden Array.prototype[Symbol.iterator] ('items[Symbol.iterator] must be a function', 71 fails)"
status: blocked
blocked_on: needs-architect (array↔host-prototype identity — NOT the codegen gate)
wip_branch: issue-1719-impl @ 59d9ab9f9
created: 2026-05-29
updated: 2026-05-29
related_object_representation: [1130, 1320, 1732, 1632, 1665]
priority: high
feasibility: hard
task_type: bugfix
area: codegen
language_feature: destructuring-iterator-protocol
goal: test262-conformance
sprint: Backlog
es_edition: 2015
test262_fail: 71
test262_category: language/expressions, language/statements
related: [1016, 1320, 1021]
---

# #1719 — Array destructuring must use the (possibly overridden) Array iterator (71 fails)

## Problem

71 tests fail with:

```
%Array%.from requires that the property of the first argument,
items[Symbol.iterator], when exists, be a function
```

All are `*-iter-val-array-prototype.js` array-destructuring tests across
`language/expressions/{class,object,function,async-generator}/dstr/` and
`language/statements/{class,for,for-of,function,generators}/dstr/`. Each test
overrides `Array.prototype[Symbol.iterator]` (or `Array.prototype.values`) with
a custom generator and asserts that **array destructuring uses the overridden
iterator**.

## Root-cause hypothesis

ArrayAssignmentPattern / ArrayBindingPattern destructuring (§8.5.2
IteratorBindingInitialization / §13.15.5.3 DestructuringAssignmentEvaluation)
must call `GetIterator(rhs)` which reads `rhs[Symbol.iterator]` **dynamically at
runtime**. Our codegen takes a fast static path for array RHS values that
iterates the backing store directly (or calls a fixed `%Array%.from`-style
bridge) and therefore **ignores a user-monkeypatched `Array.prototype[Symbol.
iterator]`**. When the test replaces the prototype iterator with a value the
fast path doesn't recognise, the bridge reports "items[Symbol.iterator] … be a
function" instead of invoking the override.

The fix is to route array destructuring through a real `GetIterator` that reads
the live `@@iterator` method off the value's prototype chain (honouring
overrides), rather than a compile-time-specialised array walk — at least when
the static type cannot prove the prototype iterator is intact.

Spec: [§7.4.2 GetIterator](https://tc39.es/ecma262/#sec-getiterator),
[§8.5.2 IteratorBindingInitialization](https://tc39.es/ecma262/#sec-runtime-semantics-iteratorbindinginitialization).

## Example failing tests

- `test/language/expressions/function/dstr/ary-ptrn-elem-id-iter-val-array-prototype.js`
- `test/language/statements/class/dstr/meth-static-dflt-ary-ptrn-elem-id-iter-val-array-prototype.js`
- `test/language/expressions/class/dstr/private-meth-ary-ptrn-elem-id-iter-val-array-prototype.js`
- `test/language/expressions/async-generator/dstr/named-ary-ptrn-elem-id-iter-val-array-prototype.js`

## Acceptance criteria

- The four example tests pass.
- The `iter-val-array-prototype` cluster drops from 71 to ≤ 10.
- No regression in the broad destructuring fixes (#1016, #1021, #1024, #1025)
  nor in #1320 (Array.from(externref) iterator bridge).

## Source

Filed by product-owner test262 triage 2026-05-29 against main baseline
(`.test262-cache/test262-current.jsonl`, 48,117 records).

## Root cause — confirmed (dev-a, 2026-05-29)

Reproduced. Hypothesis confirmed; exact site pinned to
`compileArrayDestructuring` in `src/codegen/statements/destructuring.ts`.

When the destructuring RHS resolves to a **known vec or tuple struct** (the
common typed-`T[]` case — `resultType` is a `ref`/`ref_null` to a WasmGC vec
struct), control reaches the fast path at **destructuring.ts:862-876** which
stashes the struct ref and delegates to `destructureParamArray(...mode:"decl")`.
That helper walks the WasmGC **backing store directly** (`array.get` / per-field
`struct.get` on the `{length,data}` vec) — it **never calls GetIterator and
never reads `@@iterator`** off the value's prototype chain. So a
module-monkeypatched `Array.prototype[Symbol.iterator]` (or
`Array.prototype.values`) is silently ignored.

Only the **externref branch** (`compileExternrefArrayDestructuringDecl`, used
for `resultType.kind === "externref"` / unknown structs at destructuring.ts:794,
824-827, 849-852) performs a real GetIterator (RequireObjectCoercible +
`@@iterator` + `.next()`, throw-propagating, #1454). The typed-vec/tuple fast
path and the f64/i32-box path go straight to the backing-store walk.

The failing `*-iter-val-array-prototype.js` cases compile their RHS as a typed
array → hit the fast path → override ignored → wrong values or the
`%Array%.from … items[Symbol.iterator] … be a function` bridge error.

### Why this is NOT a localized fix (scope flag → architect)

The fast path is the **hot, common-case** array-destructuring lane shared by
declaration dstr, parameter dstr (`destructureParamArray`), for-of bindings,
and the loop paths. Honouring an overridden prototype iterator needs one of:

1. **Compile-time intactness gate** (preferred): a module pre-scan sets a
   `ctx`-level flag when `Array.prototype[Symbol.iterator]` /
   `Array.prototype.values` is ever assigned (or `Object.defineProperty`'d);
   when set, the vec/tuple fast-path sites coerce to externref and delegate to
   the existing `compileExternrefArrayDestructuringDecl` GetIterator lane.
   Touches `compileArrayDestructuring`, `destructureParamArray`, the param lanes,
   and for-of. Zero perf/behavior change when the flag is clear (the common
   case); full §8.5.2 fidelity when set.
2. **Always GetIterator**: drop the fast path — large perf + behavioral
   regression risk across the dstr suites #1016/#1021/#1024/#1025/#1320
   explicitly guard. Not advisable.

Either is broad codegen-core surgery on the dstr hot path, not a ~1-file change.
Per the dev guardrail this warrants an **architect spec** (precision of the
pre-scan, the for-of interaction, and the perf gate need sign-off before a dev
lands it). Spec refs: §7.4.2 GetIterator, §8.5.2 IteratorBindingInitialization,
§13.15.5.3 DestructuringAssignmentEvaluation.

Repro (worktree `issue-1719-array-dstr-iterator`): override
`Array.prototype[Symbol.iterator]` with a generator yielding a *different* 3rd
value (`42`), then `const [x,y,z] = [1,2,3]` — `z` resolves to the backing
store, not the override. Direct compile confirms the typed-vec fast path is
taken (the externref GetIterator lane is never reached for a typed array RHS).

## Implementation attempt + BLOCKER — spec premise disproved (dev-a, 2026-05-29)

**Status: blocked on architect.** The intactness-gate spec above was
implemented IN FULL on branch **`issue-1719-impl` @ 59d9ab9f9** (ctx
`arrayIteratorMaybeOverridden` flag, `sourceOverridesArrayIterator` module
pre-scan with wrapper-stripping LHS match + assignment/`Object.define*`
detection, and BOTH gate sites — `compileArrayDestructuring` and
`destructureParamArray` — coercing a vec/tuple RHS to externref and routing to
the GetIterator lane when the flag is set). **The gate code is sound and ready
to build on.** Verified:

- No-override fast path is **byte-identical** to before (`const [x,y,z]=[1,2,3]`
  → `z===3` PASS — zero perf/behavior change when the flag is clear).
- With the override present, the gate **fires** and routes to the externref
  lane (the result changes `3` → `0`, proving the pre-scan + gate work).

**But the spec's core premise is invalid.** Routing to the externref
`__array_from_iter_n` GetIterator lane returns **empty**, NOT the override's
yielded values. Root cause, found by an orthogonal test:

- A plain `[...arr]` spread of an array with an overridden
  `Array.prototype[Symbol.iterator]` also yields **empty**.
- `for-of` over the same array throws **`[object Object] is not iterable`**.

So the WasmGC vec coerced via `extern.convert_any` is **not a host JS Array** —
the override lives on the **host's** `Array.prototype`, and the compiled array's
runtime value is *not* on that prototype chain. No codegen gate can make the
GetIterator lane observe a host-prototype override, because the value handed to
the host isn't a host Array. The `__array_from_iter_n` GetIterator path
(`src/runtime.ts:5157`) cannot reach the override.

### Conclusion: object-representation gap, not a codegen gate

This is the **same root cause** as the array/object accessor-observation and
function-object-identity cluster — compiled WasmGC values are not host JS
objects on the host prototype chains:

- **#1130** — Array methods don't observe accessor getters (same: compiled
  array ≠ host Array).
- **#1320** — Array.from iterator bridge (same host-object identity gap).
- **#1732** — String.prototype method function-object invariants (compiled
  builtin method ≠ host function object).
- **#1632** (bound functions) / **#1665** ($Iterator) — function-object
  representation track.

#1719 needs an **architect decision on array↔host-prototype identity**, NOT a
re-spec of the gate. The decision interacts with the dual-mode/standalone axis
(a host-Array representation only helps JS-host mode; standalone needs a
Wasm-native @@iterator dispatch) — so it is a strategic call, surfaced to the
project lead, not a localized fix. Hold #1719 until that lands; then the
`issue-1719-impl` gate becomes the front-end half of the solution.
