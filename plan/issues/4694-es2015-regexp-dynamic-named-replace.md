---
id: 4694
title: "ES2015 standalone RegExp dynamic named-group string replacement"
status: done
sprint: current
created: 2026-08-25
updated: 2026-08-25
completed: 2026-08-25
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: regexp
language_feature: regexp-named-groups
goal: es2015-standalone
depends_on: []
files:
  - src/codegen/regexp-dynamic-pattern.ts
  - src/codegen/regexp-standalone.ts
  - tests/issue-4694.test.ts
loc-budget-allow:
  - src/codegen/regexp-standalone.ts
func-budget-allow:
  - src/codegen/regexp-dynamic-pattern.ts::ensureDynamicPatternTokenDecoder
---

# #4694 — ES2015 standalone RegExp dynamic named-group string replacement

## Scope

This issue owns the five current-main failures in
`test/built-ins/RegExp/named-groups/string-replace-*.js` whose pattern and
flags are supplied through runtime loop values. It explicitly excludes custom
`exec`, overridden `Symbol.replace`, function replacers, and the blocked #4687
result-record/protocol semantics.

## Current-main reproduction (before implementation)

Base: `upstream/main` at `7cb7e0b8053c635639529c1e51d1ae1751872656`.
The exact `runTest262File(..., "standalone")` pins ran in this worktree with
the pinned pnpm-10 PATH. Five failures and nine passing controls were observed.

| Test262 row | Expected | Baseline status / exact error |
| --- | --- | --- |
| `built-ins/RegExp/named-groups/string-replace-get.js` | `"badc"` / `"bacd"` as specified for global/non-global flags | `fail`: `Test262Error: Expected SameValue(«"badc"», «"bacd"») to be true \| at L24: assert.sameValue("badc", "abcd".replace(re, "$<snd>$<fst>"));` |
| `built-ins/RegExp/named-groups/string-replace-missing.js` | `"cd"` or `""` for missing names | `fail`: `Test262Error: Expected SameValue(«""», «"cd"») to be true \| at L13: assert.sameValue("cd", "abcd".replace(re, "$<42$1>"));` |
| `built-ins/RegExp/named-groups/string-replace-numbered.js` | `"badc"` / `"bacd"` for `$2$1` | `fail`: `Test262Error: Expected SameValue(«"badc"», «"bacd"») to be true \| at L23: assert.sameValue("badc", "abcd".replace(re, "$2$1"));` |
| `built-ins/RegExp/named-groups/string-replace-unclosed.js` | `"$<sndcd"` / `"$<snd$<snd"` | `fail`: `Test262Error: Expected SameValue(«"$<snd$<snd"», «"$<sndcd"») to be true \| at L19: assert.sameValue("$<sndcd", "abcd".replace(re, "$<snd"));` |
| `built-ins/RegExp/named-groups/string-replace-undefined.js` | `""` / `"cd"` for an unmatched named group | `fail`: `Test262Error: Expected SameValue(«""», «"cd"») to be true \| at L23: assert.sameValue("", "abcd".replace(re, "$<thd>"));` |

The adjacent dynamic-constructor controls
`string-replace-escaped.js` and `string-replace-nocaptures.js` passed: escaped
`$$` does not require named metadata, while a pattern without named groups must
preserve `$<...>` literally. Static substitution controls from #4692 remain
non-goals and stayed green.

The seven static controls were
`subst-after.js`, `subst-before.js`, `subst-capture-idx-1.js`,
`subst-capture-idx-2.js`, `subst-dollar.js`, `subst-matched.js`, and
`prototype/Symbol.replace/named-groups.js`; all passed. Their baseline
`wasm_sha` values were `3f9938648d07`, `87c8b600aeb5`, `0db4c209c265`,
`aa9a0709d284`, `af735b2d91de`, `6dec125a208a`, and `423b3398ca1c`,
respectively.

## Root-cause hypothesis

The standalone dynamic constructor already reuses the native regex VM and
capture-slot array, but its `$NativeRegExp` carrier stores only flags, capture
count, bytecode, class table, source, scratch count, and lastIndex. Two narrow
gaps combine here. First, `staticConstStringValue` treats a `for...of` binding
with no initializer as an unassigned `var` and folds it to static `undefined`;
the `flags` loop values therefore become `""` instead of reaching the runtime
constructor. Second, after that is corrected, the dynamic tokenizer must accept
the named-capture opener and the replacement core needs a names table when the
pattern source is statically recoverable but flags are runtime values.

The first hypothesis was confirmed. The existing dynamic nested-capture
machinery can emit the capture SAVE records, but its tokenizer did not consume
`(?<name>` as one capturing opener. Separately, the replacement core
(`ensureRegexReplace` → `ensureRegexGetSubstitution`) received a zero-count
names table whenever runtime flags made full pattern+flags metadata unavailable.
The fix adds a conservative runtime named-opener token decoder, reuses the
existing SAVE records and names-table ABI, and recovers names from a statically
provable pattern while deliberately leaving runtime-only patterns unsupported.
The dynamic compiler also now allows top-level alternation between capture
envelopes; nested alternation remains refused because it needs the blocked
#4687 result-record protocol. Finally, `for...of`/`for...in` bindings stay
runtime values instead of being folded to `undefined`, and replacement's
global bit is read from the carrier when flags are dynamic.

The implementation must reuse the existing dynamic nested-capture metadata or
runtime representation if present. It must not introduce a second replacement
algorithm or broaden custom protocol behavior. If dynamic named-group metadata
cannot be represented without a broad carrier/runtime redesign, mark this
issue blocked with evidence and do not commit source changes.

## Implementation plan

1. Re-run each five failure pins plus the two dynamic controls and static
   substitution controls with the pinned pnpm-10 PATH and exact standalone
   runner seam; capture baseline pass/fail results.
2. Trace the dynamic constructor's existing nested-capture metadata/runtime
   path and identify the narrowest reusable representation for names and
   numbered captures.
3. If the representation is already available, thread only the required
   metadata into the established `__regex_replace` / GetSubstitution call,
   keeping changed `src/` lines at or below 150 and adding strict focused
   tests.
4. Run exact five pins, dynamic controls, static controls, and focused tests;
   assert every expected pass and zero regressions.
5. Fetch and merge latest `upstream/main`, rerun all focused checks and normal
   prepush checks, then push and open a ready PR against
   `loopdive/js2:main` from this fork branch.

## Risks and non-goals

- Do not implement custom `exec`, custom/overridden `Symbol.replace`, result
  record coercion/protocol semantics (#4687), or function replacers.
- Do not broaden the dynamic RegExp grammar or create a parallel replacement
  implementation.
- Do not claim a dynamic carrier can expose named metadata unless the runtime
  data is actually present and tested for both matched and unmatched groups.
- A broad redesign of the RegExp carrier/runtime is a blocker for this bounded
  issue; leave the issue blocked with measurements instead of speculative code.

## Acceptance

- All five named dynamic-constructor replacement rows pass in standalone.
- `string-replace-escaped.js` and `string-replace-nocaptures.js` remain green,
  along with the static substitution controls.
- Focused tests use strict pass assertions and cover global/non-global,
  numbered, named, missing, unmatched, and unclosed substitutions.
- No custom protocol, custom `exec`, or function-replacer behavior changes.
- Source expansion is <=150 lines and reuses existing dynamic metadata/runtime.
- Post-merge focused and control runs pass with zero regressions.

## Intended files

- `src/codegen/native-regex.ts`
- `src/codegen/regexp-standalone.ts`
- `tests/issue-4694.test.ts`

## Test Results

Baseline on `upstream/main@7cb7e0b8053c635639529c1e51d1ae1751872656`:

- Five target rows failed with the exact errors recorded above.
- Dynamic controls passed: `string-replace-escaped.js` (`2ca102b16b9b`) and
  `string-replace-nocaptures.js` (`041683ee9f40`).
- Seven static controls passed with the hashes listed above.

Focused implementation run, exact command seam
`runTest262File(path, "issue-4694", 120000, "standalone")`, passed all five
targets, both dynamic controls, and all seven static controls:

- `string-replace-get.js` — `728d2a55a42a`
- `string-replace-missing.js` — `f8f8270961b4`
- `string-replace-numbered.js` — `b27a014df865`
- `string-replace-unclosed.js` — `0151e7ff35b0`
- `string-replace-undefined.js` — `0fc2ab548423`
- `string-replace-escaped.js` — `4dc3cc1cc77a`
- `string-replace-nocaptures.js` — `4e4998a9ecd4`
- Static controls remained pass (`3f9938648d07`, `87c8b600aeb5`,
  `0db4c209c265`, `aa9a0709d284`, `af735b2d91de`, `6dec125a208a`,
  `423b3398ca1c`).

`tests/issue-4694.test.ts` contains strict pass assertions for the same exact
rows. Changed source-line count is 130 (`git diff --numstat` over
`src/codegen/regexp-dynamic-pattern.ts` and `src/codegen/regexp-standalone.ts`).
