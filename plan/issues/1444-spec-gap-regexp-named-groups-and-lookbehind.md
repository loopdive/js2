---
id: 1444
title: "spec gap: RegExp named groups (unmatched + duplicate) and lookbehind edge cases"
status: done
completed: 2026-06-12
created: 2026-05-20
updated: 2026-05-20
priority: medium
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: runtime
language_feature: regexp-named-groups, regexp-lookbehind
goal: spec-completeness
sprint: 52
related: []
---
# #1444 - RegExp named groups and lookbehind

## Problem

Two related regex-engine gaps remain after the host-imported regex
support landed:

1. **Named capture groups**, when *unmatched*, must appear on
   `result.groups` as `undefined` keys (the `groups` object is an
   `Object.create(null)` with one own key per name). Duplicate group
   names (ES2025 / regexp-duplicate-named-groups) must resolve to the
   last matched alternative.
2. **Lookbehind** alternation, sticky, and variable-length combinations
   match incorrectly. These tests are all in
   `built-ins/RegExp/lookBehind/`.

Sample failing tests:
- `test/built-ins/RegExp/named-groups/groups-object-unmatched.js` —
  asserts `result.groups.x === undefined` when `(?<x>x)` doesn't match
  the alternation chosen. Currently `result.groups.x` resolves to a
  matched string of a different group instead of `undefined`.
- `test/built-ins/RegExp/named-groups/duplicate-names-exec.js` —
  `/(?<x>a)|(?<x>b)/.exec("bab")` should be `["b", undefined, "b"]`.
- `test/built-ins/RegExp/named-groups/unicode-match.js` — null deref
  inside `assert_compareArray`.
- `test/built-ins/RegExp/lookBehind/sticky.js` — sticky+lookbehind.
- `test/built-ins/RegExp/lookBehind/variable-length.js`,
  `alternations.js`, `backreferences.js`.

## Failure count

- `built-ins/RegExp/named-groups`: 18 failures
- `built-ins/RegExp/lookBehind`: 15 failures
- Plus a small tail of `match-indices` and `CharacterClassEscapes` that
  appear related (~10 more).

## Root cause

The compiler uses host-imported regex helpers (`RegExp` is treated as
an external class). When the host runtime returns the regex match
result, the wasm side wraps it as a typed Array result. The
`groups` object is currently not populated for unmatched named groups
— either the host helper drops `undefined`-valued own properties before
returning, or the wasm wrapping step strips them.

For lookbehind, the underlying engine (browser-native `RegExp` in JS
host mode, or a bundled engine in standalone mode) should already
support lookbehind, but the failures suggest the *standalone* engine
lacks some lookbehind combinations.

Both buckets require digging into the regex runtime layer rather than
the codegen layer.

## Implementation sketch

1. Audit the host-imported regex result wrapping in `src/runtime.ts` —
   ensure the returned object preserves all named-group keys with
   `undefined` for unmatched ones, and that the `groups` object is the
   *same one* the test inspects.
2. For duplicate names, the engine must surface the *last matched*
   alternative as the `groups` value; the current wrapper may collapse
   on the first-defined name.
3. Standalone-mode lookbehind: confirm whether the bundled engine
   supports it. If not, document the gap and either pull in an
   upstream fix or mark the bucket deferred.

## Acceptance criteria

1. `/(?<x>a)|(?<x>b)/.exec("bab")` returns `["b", undefined, "b"]` with
   `result.groups.x === "b"`.
2. `result.groups` for `/(?<a>a).|(?<x>x)/.exec("ab")` has both `a` and
   `x` as own keys, with `x === undefined`.
3. `built-ins/RegExp/named-groups` failures drop by ≥80%.
4. Lookbehind alternation/sticky/variable-length tests pass in JS host
   mode; standalone mode gap documented if not fixed.

## Files to inspect

- `src/runtime.ts` (host RegExp wrapping, ~900-1000)
- `src/codegen/string-ops.ts` (match/exec result handling)
- Standalone regex engine (if applicable)
- `tests/issue-1444.test.ts`
