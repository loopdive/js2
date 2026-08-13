---
id: 833
title: "Consider sloppy mode support for legacy octal escapes and non-strict code"
status: ready
created: 2026-03-28
updated: 2026-08-13
priority: low
feasibility: hard
model: fable
reasoning_effort: max
goal: contributor-readiness
sprint: Backlog
test262_skip: 16
loc-budget-allow:
  - src/compiler.ts
---
# #833 -- Consider sloppy mode support for legacy code

## Problem

16 test262 tests use octal escape sequences (`\01`, `\07`, etc.) which are forbidden in strict mode. Since we compile all code as ES modules (which are always strict), TypeScript's parser rejects them.

Some of these tests explicitly test strict mode rejection (correct behavior for us), but others test sloppy mode where octals should work.

## Broader question

Should we support a non-strict/sloppy compilation mode? This would affect:
- Octal escape sequences in strings (16 tests)
- `with` statement (550 tests currently skipped)
- Duplicate parameter names
- `arguments.callee`
- Implicit globals from undeclared variables
- `delete` on unqualified identifiers

## Approach options

1. **Do nothing** — all code is strict (current behavior, correct for modules)
2. **Add `--sloppy` flag** — compile as script instead of module, disable strict checks
3. **Per-file detection** — if test metadata has `flags: [noStrict]`, compile as sloppy

Option 3 is most useful for test262 since it has explicit flags. For real-world code, strict mode (option 1) is the right default.

## ECMAScript spec reference

- [§B.1 Additional Syntax](https://tc39.es/ecma262/#sec-additional-syntax) — legacy octal escapes, HTML comments
- [§B.3 Other Additional Features](https://tc39.es/ecma262/#sec-other-additional-features) — sloppy-mode function hoisting, __proto__
- [§11.8.4 String Literals](https://tc39.es/ecma262/#sec-string-literals) — non-strict octal escape sequences


## Implementation (if pursued)

- TypeScript's `createSourceFile` accepts `ScriptTarget` and `ScriptKind` but not a strict/sloppy flag — TS always allows strict-mode-only restrictions in its parser
- Would need to either suppress specific TS diagnostics or pre-process the source to work around TS's strict enforcement
- The `with` statement would need a separate compilation strategy (not supported by TS at all)

## Acceptance criteria

- Decision documented: support sloppy mode or not
- If yes: 16 octal tests + potentially 550 `with` tests unskipped

## Implementation Plan

> **2026-08-13 scope correction:** the plan below is retained as historical
> context for legacy octal syntax, but its statement that `with` is outside the
> ES5 target is superseded. The `es5` goal now includes every edition row in
> both lanes, including `eval`, `Function`, and `with`. Dynamic `with` remains a
> separate implementation stream (#671, #2663, #4179, #4206), not an exclusion.

(Author: architect, 2026-05-21. Recommendation: **adopt Option 3
(per-file detection from test262 metadata)** for octal escapes
only. `with` statement is explicitly out of scope per repo
CLAUDE.md.)

### Entry points

- **Test harness**: `tests/test262-runner.ts` — read `flags` field
  from the test's frontmatter (already partially parsed); when
  `flags` includes `"noStrict"` set `ctx.sloppyMode = true`.
- **Compiler**: `src/checker/index.ts` — wrap `createSourceFile`
  with a sloppy-mode preprocessing step.
- **Parser**: TypeScript rejects octal escapes via diagnostic
  `TS1487`; suppress this specific diagnostic when
  `ctx.sloppyMode` is set.

### Algorithm

1. **Detect sloppy mode**:
   - From test262 metadata: `flags: [noStrict]`.
   - From source: `'use strict'` directive presence → strict.
   - User code via new flag `--sloppy` (future, low priority).

2. **Preprocessing for octal escapes**:
   - When `ctx.sloppyMode`: pre-transform `\NNN` escape sequences
     in string literals to their `\uXXXX` equivalents BEFORE
     handing source to TS parser.
   - Tokenize via a minimal scanner that handles only string
     literals; replace `\0`..`\7` followed by digits with the
     numeric codepoint.

3. **TS diagnostic suppression**:
   - Filter `program.getSyntacticDiagnostics()` to exclude codes
     `TS1487` (octal escape), `TS1100` (eval/arguments assign),
     `TS1104` (delete on identifier) — but only in sloppy mode.

4. **`with` statement**: explicitly NOT implemented. Throw a
   clear compile-time error directing users to refactor.

### Edge cases

- **Mixed sloppy/strict in one file**: function-level `'use strict'`
  directives. Honour TS's per-scope strict tracking; preprocess
  applies only to string literals outside strict scopes — too
  complex; for simplicity, treat the whole file as sloppy if the
  file-level mode is sloppy, ignoring inner strict-mode functions.
- **Escapes inside template literals**: per spec, tagged templates
  preserve invalid escapes via `raw`. Skip the preprocess for
  template literals.
- **Numeric literal octals (`017`)**: rejected in strict mode;
  similar treatment via preprocessor → convert `017` to `15` (or
  reject if unambiguous parse fails).
- **Sloppy-mode function-in-block hoisting**: covered by #1518;
  do not duplicate here.

### Test262 paths

- Files with `flags: [noStrict]` and `\NNN` escapes — ~16.
- Acceptance: 12+ of 16 pass.

### Dependencies

- **#1518** — sloppy function-in-block hoisting; independent.
- **#1264/#1265** — eval strict/sloppy; orthogonal scope.

### Risks

- Preprocessing string literals is fiddly; mistakes silently
  corrupt valid programs. Add a vitest that verifies the
  preprocessor is a no-op for files without legacy octals.
- TS diagnostic suppression can mask real bugs; only suppress
  the documented codes.

### Decision

The historical recommendation estimated ~200 LOC + tests for the octal slice.
Its exclusion of `with` from the ES5 goal is superseded by the scope correction
above.

## Current-main implementation plan (2026-08-13)

### Measured slice

Exact source `81125e5e248847a5df94c3e2a3a20016782e1df4`, corpus
`b363f29d3c43c626dc852744ad64a0b48a003693`, and oracle v13 report the same
seven ES5 compile errors in host and standalone:

- `annexB/language/comments/multi-line-html-close.js`
- `annexB/language/comments/single-line-html-close.js`
- `annexB/language/comments/single-line-html-open.js`
- `annexB/language/comments/single-line-html-close-first-line-{1,2,3}.js`
- `annexB/language/comments/single-line-html-close-unicode-separators.js`

`single-line-html-close-asi.js` is already a pass and is a regression control;
`language/comments/single-line-html-close-without-lt.js` must remain a parse
negative.

### Parser-to-IR design

TypeScript cannot construct an AST for Annex B HTML-like comments, so this
syntax requires one bounded pre-parse step. For an explicitly selected Script
goal (`inferModuleStrictArguments === false`):

1. Identify literal spans with the TypeScript frontend so marker text inside
   strings, template raw segments, and regular expressions is protected.
2. Scan ordinary comments and lexical line boundaries. Recognize `<!--` at an
   input-element boundary and `-->` only at the start of a logical line after
   optional whitespace/block comments, including the first line and U+2028/
   U+2029 boundaries.
3. Replace the recognized single-line comment text with the same number of
   spaces while preserving every line terminator. The source-position map is
   therefore identity.
4. Send the resulting AST through the ordinary IR selector and emitter. Do not
   add an AST-only codegen path or a legacy fallback for this syntax.
5. Leave Module-goal source byte-for-byte untouched so HTML-like comments stay
   syntax errors there.

### Validation gates

- Unit cases cover first-line, whitespace/comment prefixes, multiline-comment
  prefixes, U+2028/U+2029, literals, regular expressions, templates, and
  ordinary comments.
- An IR inventory probe must report `kind: emitted`, `irBodyEmitted: true`, and
  `legacyBodyEmitted: false` in host and standalone; standalone must have zero
  Wasm imports.
- All seven exact-current compile errors must pass through the authoritative
  original-harness runner in both lanes.
- The Module-goal and no-preceding-line-terminator negative controls must remain
  failures.

### Result (2026-08-13)

Implemented in `src/compiler/html-like-comments.ts` and wired before other
pre-parse rewrites in `compileSourceSync`. Focused validation is green:

- 8/8 issue tests;
- 7/7 exact-current Test262 cases in host;
- 7/7 exact-current Test262 cases in standalone;
- IR-only probe green in both lanes, with no standalone imports.

This removes seven compile errors from each lane. It does not change the full
9,029-test denominator and does not claim completion of legacy octal syntax or
dynamic `with` semantics.
