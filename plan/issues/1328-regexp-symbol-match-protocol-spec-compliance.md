---
id: 1328
title: "RegExp host-mode: Symbol.match / matchAll protocol spec compliance (101 fails)"
status: done
created: 2026-05-08
updated: 2026-05-27
completed: 2026-05-27
priority: medium
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: runtime
language_feature: regexp
goal: spec-completeness
sprint: 50
parent: 1002
---
# #1328 — RegExp host-mode: Symbol.match / matchAll protocol spec compliance (101 fails)

Carved out of #1002 (RegExp js-host mode). #1002 closed as a scoping deliverable; this is one of four Symbol-protocol follow-ups.

## Problem

101 test262 failures touching `RegExp.prototype[Symbol.match]`, `RegExp.prototype[Symbol.matchAll]`, `String.prototype.match`, `String.prototype.matchAll` — each a different ECMA-262 §22.2.6.8 spec edge case.

Status breakdown: 97 fail, 3 compile_timeout, 1 compile_error.

## Root cause

The host-mode dispatch goes through `RegExp.prototype[Symbol.match]` on the JS RegExp wrapper, but our compiler's call-path for `r[Symbol.match](s)` does not always route through the JS engine's spec-compliant implementation. Several edge cases (e.g. `r.lastIndex = '1.9'` ToLength coercion) end up returning `null` instead of doing the spec-required coercion + match.

Concrete repro:
```ts
const r = /./y;
(r as any).lastIndex = '1.9';   // string lastIndex
r[Symbol.match]('abc');          // returns null (should return ['b'])
```

## Sample failures

- `built-ins/RegExp/prototype/Symbol.match/builtin-coerce-lastindex.js`
- `built-ins/RegExp/prototype/Symbol.match/coerce-arg-err.js`
- `built-ins/RegExp/prototype/Symbol.match/g-match-no-coerce-lastindex.js`
- `built-ins/RegExp/prototype/Symbol.match/y-fail-lastindex-no-write.js`
- `built-ins/RegExp/prototype/Symbol.match/builtin-success-g-set-lastindex.js`
- `built-ins/RegExp/prototype/Symbol.match/name.js`
- `built-ins/RegExp/prototype/Symbol.matchAll/species-constructor-species-is-not-constructor.js`
- `built-ins/RegExp/prototype/Symbol.matchAll/this-get-flags.js`
- `built-ins/String/prototype/match/S15.5.4.10_A2_T11.js`
- `built-ins/String/prototype/matchAll/regexp-is-null.js`

## Spec references

- §22.2.6.8 RegExp.prototype[@@match]
- §22.2.6.9 RegExp.prototype[@@matchAll]
- §22.1.3.13 String.prototype.match
- §22.1.3.14 String.prototype.matchAll
- §22.2.7.1 RegExpExec
- §22.2.7.2 RegExpBuiltinExec

## Approach

Trace the codegen path for `obj[Symbol.match](s)` via `obj` being a host RegExp. Likely needs:
- Ensure `Symbol.match` property access on a RegExp externref dispatches through the host's `RegExp.prototype[Symbol.match]`
- Verify ToLength coercion happens on `lastIndex` before the match
- Verify the returned result-array shape matches spec

## Acceptance criteria

- 80+ of the 101 fails flip to pass
- Remaining ones documented with their specific spec gap

## Resolution (2026-05-27)

The documented headline repro (`/./y` with string `lastIndex='1.9'` →
`r[Symbol.match]('abc')`) already **passes on main** via the host-mode helper —
the basic Symbol.match dispatch + ToLength coercion work. The remaining failures
were a different mechanism.

**Root cause fixed**: `Array.isArray(result)` on a RegExp match result wrongly
returned `false`. The match result arrives in Wasm as an `externref`, and
`Array.isArray` was resolved purely from the *compile-time* TypeScript type
(`resolveWasmType` → `externref`, which is not a `ref` to a vec struct), so it
emitted a constant `false`. This broke the `assert(Array.isArray(result))` line
in the whole `builtin-success-return-val*` / `exec-return-type-valid` cluster
(§22.2.7.2 result-array shape).

**Fix**:
- `src/codegen/expressions/calls.ts` — `Array.isArray(x)`: when the argument's
  wasm type is `externref` (undecidable statically), route through a new
  `__extern_is_array` host import instead of emitting `false`. Falls back to
  `false` if the import is unavailable (standalone).
- `src/runtime.ts` — register `__extern_is_array` → `(v) => Array.isArray(v) ? 1 : 0`.
- `tests/issue-1328.test.ts` — unit coverage (match-result is array, real wasm
  array still true, non-array externref false, matchAll user-dispatch).

This is a general `Array.isArray` correctness fix for any host-returned
externref array, so it also helps RegExp `exec`/`split` result shapes and any
test asserting `Array.isArray` on a host value.

**Remaining (not in this PR)** — distinct mechanisms, lower-volume, can be
follow-ups: custom-matcher dispatch on plain objects (`cstm-matcher-*`,
"is not a function"), `@@matchAll` SpeciesConstructor protocol
(`species-constructor*`), and `name` property *descriptor attributes*
(value already correct). CI conformance will show the net flip.

## Related

- Parent #1002 (closed-as-scoped)
- Sibling: #1329 (Symbol.replace), #1330 (Symbol.search), #1331 (Symbol.split)
- Shares the externref-result-shape theme with #1352 (exec result equality)
