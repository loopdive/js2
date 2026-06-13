---
id: 1439
title: "spec gap: RegExp.prototype Symbol.* protocol methods (replace/match/split/matchAll/search)"
status: done
completed: 2026-06-12
created: 2026-05-20
updated: 2026-05-20
priority: high
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: regexp-symbol-methods
goal: spec-completeness
sprint: 52
related: [1443]
---
# #1439 - RegExp.prototype Symbol.* protocol methods

## Problem

Direct invocation of well-known `Symbol.*` regex protocol methods produces a
null-pointer dereference at runtime. ECMAScript §22.2.5 defines:

- `RegExp.prototype[@@replace](string, replaceValue)`
- `RegExp.prototype[@@match](string)`
- `RegExp.prototype[@@matchAll](string)`
- `RegExp.prototype[@@search](string)`
- `RegExp.prototype[@@split](string, limit)`

Test262 calls them directly, e.g. `/./[Symbol.replace](arg, 'x')` — this is
the primary mechanism by which `String.prototype.replace`, `match`, etc.
delegate to a regex argument. Today this expression compiles, but the
resulting wasm dereferences a null ref.

Sample failing tests (all fail with "dereferencing a null pointer [in test()]"):
- `test/built-ins/RegExp/prototype/Symbol.replace/arg-1-coerce.js`
- `test/built-ins/RegExp/prototype/Symbol.replace/result-coerce-matched.js`
- `test/built-ins/RegExp/prototype/Symbol.match/builtin-coerce-lastindex.js`
- `test/built-ins/RegExp/prototype/Symbol.split/coerce-string-err.js`
- `test/built-ins/RegExp/prototype/Symbol.matchAll/*`

## Failure count

174 failures in `built-ins/RegExp/prototype/Symbol.*` (from
test262-current.jsonl):
- `Symbol.replace`: 63
- `Symbol.match`: 44
- `Symbol.split`: 31
- `Symbol.matchAll`: 19
- `Symbol.search`: 17

## Root cause

`src/codegen/literals.ts` maps well-known symbol names to small i32 ids
(`Symbol.replace` → 8, `Symbol.match` → 7, etc.) via `getWellKnownSymbolId`,
and `src/codegen/property-access.ts:1842-1849` emits an `i32.const` for
`Symbol.replace` literals. But there is **no codegen path** that recognises
`<regex>[<symbolId>](args)` as a regex protocol invocation:

- `src/codegen/string-ops.ts:1678-1690` only handles
  `string.replace/replaceAll/split` when the *first arg* is a regex literal
  or `new RegExp(...)` expression — it routes those through host imports.
- `Symbol.replace`/`Symbol.match`/etc. invocations on a regex receiver fall
  through to the generic computed-property dispatch, which yields a null
  externref because no `@@replace` field exists on the regex struct.
- `grep "@@replace" src/codegen/` returns no matches — the symbol-keyed
  protocol methods are simply not implemented.

When the dispatched call ref is null, the wasm `call_ref` aborts with
"dereferencing a null pointer" inside the test wrapper.

## Implementation sketch

1. In `src/codegen/expressions/calls.ts` (or `string-ops.ts`), detect
   `<receiverRegExp>[<symbolPropAccess>](...)` calls where the property
   access resolves to `Symbol.replace/match/matchAll/search/split` (via the
   existing well-known-symbol resolver). Inline-compile them to the existing
   host-imported regex helpers used by `String.prototype.replace` et al.
2. The first argument is the string. The host-imported regex helper already
   accepts `(regex, string)` for match/test/exec; replace/split take
   `(regex, string, replacement|limit)`. Reuse those imports.
3. For replace/replaceAll/split, coerce the first arg via
   `ToString(string)` — sample tests assert that an object's `toString`
   runs and `valueOf` does not (e.g. `arg-1-coerce.js`).
4. For functional `replaceValue`, the spec mandates `this` value `undefined`
   in strict mode; tests like `fn-invoke-this-strict.js` assert this.

## Acceptance criteria

1. `/./[Symbol.replace]('abc', 'x')` returns the correct string at runtime
   without a null deref.
2. All five `RegExp.prototype/Symbol.*` buckets in test262 drop by ≥80%
   relative to baseline.
3. `tests/issue-1439.test.ts` covers each of the five Symbol.* entries with
   string-coerced arguments and a custom-toString first arg.

## Files to inspect

- `src/codegen/property-access.ts` (well-known Symbol lookup, 1842-1849)
- `src/codegen/literals.ts` (`getWellKnownSymbolId`, `resolveWellKnownSymbol`)
- `src/codegen/string-ops.ts` (current RegExp-arg dispatch, 1678-1750)
- `src/codegen/expressions/calls.ts` (call-expression dispatch)
- `src/runtime.ts` (`@@replace`/`@@match`/`@@search`/`@@split` symbol table)
- `tests/issue-1439.test.ts`
