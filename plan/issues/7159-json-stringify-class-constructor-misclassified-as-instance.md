---
id: 7159
title: "Native-first and standalone: JSON.stringify(C) of a class constructor prints {} / null instead of undefined"
status: done
sprint: current
created: 2026-10-25
updated: 2026-10-31
completed: 2026-10-31
priority: low
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: classes
goal: correctness
parent: 6979
related: [7149, 7158, 6734, 7201]
# 2026-10-31 (#7159): +5 lines / +3 in emitJsonStringifyValue — one dependency
# call, one arm build, one splice. The arm itself lives in
# json-stringify-carriers.ts; the codec only gains the call sites.
loc-budget-allow:
  - src/codegen/json-codec-native.ts
func-budget-allow:
  - src/codegen/json-codec-native.ts::emitJsonStringifyValue
---

# #7159 — `JSON.stringify(C)` where `C` is a class

Found by the fresh-context review of PR #6912 (#7149, finding 4). Pre-existing
on `origin/main`; #7149 changed the no-host output from `null` to `{}`:

```js
class C { #x = 1 }
console.log(JSON.stringify(C));          // "{}" after #7149, "null" before   (node: undefined → prints "undefined")
console.log(JSON.stringify({ a: C }));   // {"a":{}} on every lane incl. host-assisted   (node: {})
```

## Cause (as diagnosed; verify before fixing)

A class constructor value shares (or is represented by) its instance struct on
the no-host lanes, so the closed-struct classifier treats it as an instance.
Per spec a function is skipped by `SerializeJSONProperty` (`undefined` at top
level, omitted as a property value). The host-assisted lane gets the
top-level case right but still prints `{"a":{}}` for the property case, so the
function check is missing in the property path on every lane.

## Implementation Plan (Fable, 2026-10-25; implement on Opus)

1. Reproduce both programs on gc host-assisted, gc native-first and standalone;
   also `JSON.stringify([C])` (node: `[null]`) and `JSON.stringify(function
   f(){})` / an arrow.
2. In the JSON value-kind dispatch, test "is callable" (the same predicate
   `typeof v === "function"` lowers to) BEFORE the closed-struct classifier
   and before the object arm, returning the undefined sentinel for top-level /
   property positions and `null` inside arrays. Do not add host imports; keep
   the host-assisted gc bytes identical unless the property-path fix requires a
   change there — then state it in the PR body with the byte delta.
3. Tests: `tests/issue-7159-json-stringify-function-values.test.ts` with the
   four programs on all three lanes vs node.

Acceptance: node's output on gc native-first and standalone for all four
programs; equivalence gate reports no new regressions.

## Resolution (2026-10-31)

Cause confirmed: a class VALUE is its lazily built `$C` struct singleton
(`__class_C`, same type and `__tag` as an instance), so the codec's
closed-struct classifier walked it as an instance (`{}` / `{"y":0}`), and the
`__get_member_toJSON` dispatcher returned the INSTANCE `toJSON` for it.

Fix, local to JSON, in §25.5.2 order:

1. **toJSON first (step 2).** For a callable value the `toJSON` lookup now uses
   the generic `__extern_get` read, which sees a class's own (static) members,
   instead of the `__get_member_toJSON` dispatcher, which would answer the
   INSTANCE method for a class value. So `static toJSON()` is still called
   (`{a: C}` → `{"a":"S"}`, as on main) and an instance `toJSON` no longer leaks
   onto the class value (`{c: C}` → `{}`; main gave `{"c":"I"}`).
   (`json-stringify-carriers.ts::jsonToJsonMethodLookupInstrs`.)
2. **Then the callable test (step 11), on toJSON's result.**
   `__json_stringify_value` asks `__typeof_function` (the predicate `typeof v
   === "function"` lowers to — closures, class singletons, branded builtin
   constructors, callable proxies) before every object arm and returns the
   codec's "no serialisation" null: omitted as a property, `null` in an array,
   under a replacer and with an indent too. A `toJSON` returning a class value
   is therefore skipped as well (main serialised it as an instance).
   (`json-stringify-carriers.ts::jsonCallableSkipInstrs`.)

No host import, no change to the classifier, `ref.test` legality or type APIs.

Round 1 of this fix ran the callable test BEFORE toJSON, which dropped a static
`toJSON` that main called — caught in review of PR #7001 and corrected here.

Not fixed here:

- **Top level** (`JSON.stringify(C)`, `JSON.stringify(f)`): still `"null"`,
  node `undefined` — now the same answer plain functions already gave (it was
  `{}` for a class). The result lives in a string-typed slot that cannot hold
  `undefined`; a call-site fold to `undefined` was tried and dropped because
  `console.log(JSON.stringify(C))` and `const s = JSON.stringify(C)` then trap
  (illegal cast), exactly as `console.log(JSON.stringify(undefined))` already
  does on main. That is #6734.
- **wasi**: a class instance, and an object literal holding a function inside
  an array, serialise as `null` (pre-existing, same on main; #7201).
- **Other class-value misclassification** seen while probing: `Object.keys(C)`
  answers the instance field names (`["y"]`, node: static names) and `for (k in
  C)` iterates them, on all three lanes. Same root (class value = instance
  struct); not JSON, not cheap — left for a follow-up.
- A plain function's OWN `toJSON` property (`f.toJSON = () => "T"`) is not
  called — node gives `{"a":"T"}`, every lane omits the function. The same
  answer on main: the codec's toJSON step only looks at objects and class
  structs, not closures. Pinned with `it.fails`.
- **wasi** also does not call a static `toJSON` on a class (same on main).

Tests: `tests/equivalence/issue-7159-json-stringify-function-values.test.ts` —
issue rows, replacer, indent, prototype / static / returned-class `toJSON`
rows, and a callable kind (class,
function, arrow, method, bound) × position (property, array, nested) sweep on
gc native-first, standalone and wasi vs node, plus printed `console.log` rows.
Top-level rows are `it.skip` pinned for #6734.
