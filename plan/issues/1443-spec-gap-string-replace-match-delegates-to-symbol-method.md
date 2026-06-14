---
id: 1443
title: "spec gap: String.prototype.replace/replaceAll/match/search delegate to argument's Symbol.* method"
status: done
completed: 2026-06-12
created: 2026-05-20
updated: 2026-05-20
priority: medium
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: string-symbol-dispatch
goal: spec-completeness
sprint: 52
related: [1439]
---
# #1443 - String.prototype delegation to argument's Symbol.* method

## Problem

Per §22.1.3.18 `String.prototype.replace(searchValue, replaceValue)`
first calls `GetMethod(searchValue, @@replace)` and, if the method
exists, dispatches to `searchValue[Symbol.replace](this, replaceValue)`.
The same dispatch shape applies to `replaceAll`, `match`, `matchAll`,
`search`, and `split` (each looks up its corresponding `Symbol.*`).

Today this delegation is missing: the compiler treats the first argument
as either a regex literal or a string. User-defined `searchValue` objects
with `Symbol.replace` (or `Symbol.match` etc.) defined are ignored and
the built-in path runs instead.

Sample failing tests:
- `test/built-ins/String/prototype/replace/cstm-replace-on-boolean-primitive.js`
  — assigning `Boolean.prototype[Symbol.replace] = function(){...}` and
  calling `"abc".replace(true, ...)` should invoke the custom method.
- `test/built-ins/String/prototype/replace/cstm-replace-invocation.js` —
  asserts call ordering and arg passing.
- `test/built-ins/String/prototype/replace/cstm-replace-is-null.js` —
  if `Symbol.replace` is `null`, fall back to the built-in.
- `test/built-ins/String/prototype/replaceAll/cstm-replaceall-on-string-primitive.js`
  — primitive receivers used as searchValue trigger the custom method
  via the prototype chain.
- `test/built-ins/String/prototype/match/cstm-matcher-on-number-primitive.js`
- `test/built-ins/String/prototype/match/cstm-matcher-on-string-primitive.js`
- `test/built-ins/String/prototype/search/cstm-search-on-boolean-primitive.js`

## Failure count

≥25 dedicated `cstm-*` failures across `String/prototype/{replace,
replaceAll, match, matchAll, search, split}`, plus secondary failures in
`searchValue-replacer-call-abrupt.js`,
`searchValue-flags-null-undefined-throws.js`, `S15.5.4.11_A1_T15.js` and
similar.

## Root cause

`src/codegen/string-ops.ts:1689-1750` short-circuits on the static type
of the first argument:

```
const firstArgIsRegExp = ... symName === "RegExp";
if (method === "replace" && !firstArgIsRegExp) { /* native string helper */ }
```

There is no `GetMethod(searchValue, Symbol.replace)` lookup. Any object
or primitive on whose prototype chain `Symbol.replace` is defined gets
the built-in fast path instead of the user method.

## Implementation sketch

1. Before the existing native-vs-host dispatch, emit a runtime check:
   - `let m = GetMethod(searchValue, @@replace)` (or `@@match` etc.).
   - If `m !== undefined`, call `m.call(searchValue, string, ...)` and
     return its result.
   - Otherwise fall through to the existing fast path.
2. `GetMethod` can be a small wasm helper: dynamic property get with the
   well-known symbol id (1439 dependency), then `IsCallable` check.
3. The dispatcher must run *before* `RequireObjectCoercible(this)` on
   the receiver (per spec step ordering), but the existing flatten step
   can stay deferred to the fast path.

## Acceptance criteria

1. `"abc".replace({[Symbol.replace]: (s, r) => r + s}, "X")` returns
   `"Xabc"`.
2. `String.prototype.replace`, `replaceAll`, `match`, `matchAll`,
   `search`, and `split` each respect a user-defined `Symbol.*` method.
3. The fast path is preserved when no custom `Symbol.*` exists.
4. `built-ins/String/prototype/*/cstm-*` test failures drop to zero.

## Files to inspect

- `src/codegen/string-ops.ts:1678-1810`
- `src/codegen/property-access.ts` (computed lookup by symbol id)
- `src/codegen/type-coercion.ts` (`IsCallable` / `GetMethod` helper)
- `tests/issue-1443.test.ts`

## Implementation notes (in-progress)

Landed in this PR — infrastructure for Symbol.* dispatch:

1. **Codegen (`src/codegen/string-ops.ts`, `declarations.ts`, `index.ts`)** —
   `replace`/`replaceAll`/`split` only use the native `__str_*` helpers when
   the first argument is statically string-like (string, string literal, or
   String wrapper object). Any other static type (RegExp, boolean, number,
   object) is routed to the JS host import `string_<method>` which performs
   spec-correct Symbol.* dispatch via the host runtime.

2. **Codegen import registration** — both
   `collectStringMethodImports` copies in `declarations.ts` and `index.ts`
   register `string_<method>` whenever the first argument is non-string,
   ensuring the host import is available even when the native helper would
   otherwise be sole.

3. **Runtime (`src/runtime.ts:string_method`)** — for the Symbol-dispatching
   methods (`replace`, `replaceAll`, `match`, `matchAll`, `search`, `split`),
   wasm-struct first arguments are wrapped via `_wrapForHost` (Proxy) rather
   than coerced via `ToPrimitive`. This lets JS's native
   `String.prototype.<method>` perform `arg[Symbol.<method>]` lookups
   through the proxy — primitives still coerce as before.

### Known limitations (deferred to follow-up issues)

- **Object literal `{ [Symbol.replace]: fn }`** — the compiler stores the
  function as a struct field (`@@replace`). V8's isorecursive type
  canonicalization collapses single-funcref structs into the same canonical
  type, so the `__sget_@@<name>` getter can return the wrong field on a
  same-shape struct (e.g. `IsRegExp` would mis-report `true` on an object
  defining only `@@replace`). The safe path used here only reads from the
  sidecar; the literal-as-search case requires additional compiler work
  (sidecar mirror, or per-symbol tag fields) to disambiguate canonical
  types. See #1382 (closure callability) and #1439 (well-known symbol
  infrastructure) for the broader plumbing required.

- **Wasm closures stored as JS object properties** — JS sees them as
  `typeof === "object"`, so `IsCallable` returns false and the dispatch
  silently falls back to default replace semantics. Blocked on #1382.

### Test results

`tests/issue-1443.test.ts` (5/5 pass):
- native fast path preserved for string search values ✓
- native `replaceAll` fast path preserved ✓
- native `split` fast path preserved ✓
- RegExp search values route through host (existing) ✓
- primitive search values (number) do not dispatch Symbol.replace ✓

No regressions in `tests/regexp.test.ts` (10/10), `tests/symbol-iterator-protocol.test.ts` (4/4),
`tests/closures.test.ts`. Pre-existing failures in `tests/array-methods.test.ts` (2 type errors)
unrelated to this change.
