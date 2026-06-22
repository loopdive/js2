---
id: 2591
title: "Standalone RegExp `v`-flag `\\q{…}` string disjunction — implement (or complete the refusal)"
status: done
sprint: 65
priority: medium
feasibility: medium
parent: 2161
area: regexp
goal: standalone-mode
language_feature: regexp
task_type: conformance
created: 2026-06-22
completed: 2026-06-22
assignee: ttraenkler/dev-regex-2591
---

# Standalone RegExp `v`-flag `\q{…}` string disjunction

Slice of umbrella #2161. **Substrate-independent** — pure regex-engine
parse/compile work.

## Problem

The `unicodeSets` (`v`-flag) test262 dir is the largest single compile-error
bucket in the standalone RegExp gap (~39 entries). After a re-probe on current
main, the set-operation features actually **work correctly**:

| v-flag form | standalone result |
|---|---|
| `/[[a-z]&&[aeiou]]/v.test("e")` (intersection) | ✓ correct |
| `/[[a-z]--[aeiou]]/v.test("z")` (subtraction) | ✓ correct |
| `/\p{Basic_Emoji}/v` (property of strings, non-string member) | ✓ correct |
| `/[\q{abc\|xyz}]/v.test("xyz")` (**string disjunction**) | **TRAPS at runtime: "illegal cast"** |

So the residual is concentrated in **one feature: `\q{…}` string disjunction**
(v-mode, §22.2.1 ClassStringDisjunction) — a class element that matches a
**multi-code-point string** rather than a single code point, e.g. `[\q{abc|d}]`
matches the 3-char sequence `"abc"` or the single char `"d"`.

## Root cause

`enumerateClassRanges` (`regex/unicode.ts:91-93`) **does** have a guard:

```ts
if (source.includes("\\q{")) {
  throw new RegexUnsupportedError("\\q{…} string disjunction — matches strings, not code points");
}
```

But the guard is **incomplete / bypassed for some forms**: the probe shows
`/[\q{abc|xyz}]/v` **compiles** and then traps at runtime with "illegal cast",
meaning a malformed class node reaches the bytecode VM instead of the refusal
firing. The v-mode nested-class extraction (`extractClassSource`,
`parse.ts:230`, which nests on `[`) and the `\q{`-containing operand do not
always route through the single `enumerateClassRanges` guard before being lowered
by `cpRangesToNode` — so the engine emits a CLASS node for an element that should
match a multi-unit string, and the result is a malformed/illegal-cast binary at
runtime.

This is the worst-of-both-worlds state: neither a clean refusal (a
`RegexUnsupportedError` → host fallback / honest compile_error) **nor** a correct
implementation. It must become one or the other.

## Implementation Plan

Two honest options. **Prefer (A) — implement it** (recovers the rows); fall back
to (B) only if the multi-char-in-class lowering proves too large for the slice.

### Option A — implement `\q{…}` by desugaring to alternation (preferred)

`\q{s1|s2|…}` inside a v-mode class is, semantically, an **alternation of the
literal strings** `s1|s2|…` (each `si` a possibly-multi-code-point literal),
unioned with any other class elements. The engine **already supports alternation
of literal strings outside classes** (the normal `(?:abc|d)` path through
`parseAlternation`). So the lowering is: parse the `\q{…}` body into its `|`-split
literal strings, build a `ReNode` alternation of literal-sequence nodes, and union
it with the rest of the class.

**File: `src/codegen/regex/parse.ts`**
- In the class-source handling (around `uEnum` / `extractClassSource`,
  lines ~200-250), detect a `\q{…}` element BEFORE handing the source to
  `enumerateClassRanges`. Split the class into:
  - the **single-code-point** part (ranges/escapes/props) → existing
    `enumerateClassRanges` → `cpRangesToNode` path, and
  - the **`\q{…}` string-disjunction** part → a new desugaring.
- The combined class node becomes an **alternation**: `(?: <q-strings> | <cp-class> )`
  consuming a variable number of units. Longest-match / leftmost-alternative
  ordering must follow the spec (ClassStringDisjunction tries each operand;
  the overall class is an alternation — order the multi-char strings to match
  spec semantics; verify against the test262 expectations, NOT memory).

**File: `src/codegen/regex/unicode.ts`**
- Add an exported helper `parseStringDisjunction(qBody: string): string[]` that
  splits `\q{a|bc|}` on top-level `|` (respecting `\|` escapes) into the literal
  string operands (the empty operand matches the empty string).
- The `enumerateClassRanges` `\q{` guard (line 91) is then only hit for the
  residual code-point part (which no longer contains `\q{`); keep it as the
  catch-all for any `\q{` that slips through, so a parse miss is a loud refusal,
  never a silent illegal-cast.

**File: `src/codegen/regex/compile.ts`**
- The desugared alternation of literal strings compiles through the existing
  alternation + literal-sequence bytecode (no new VM op needed — a literal
  multi-char string is a sequence of CHAR ops, already supported). Confirm the
  empty-string operand (`\q{|a}`) compiles to a zero-width arm.

### Option B — complete the refusal (fallback if A is too big)

If the in-class multi-char alternation lowering is out of slice scope:
- Make the `\q{}` refusal **total**: route EVERY `\q{`-containing class through a
  single guard so it always throws `RegexUnsupportedError` (→ honest
  compile_error / host fallback in JS-host mode), and **fix the bypass** so no
  malformed node ever reaches the VM (no more runtime "illegal cast").
- This recovers 0 rows but removes the silent-wrong/trap state. Only do (B) if (A)
  is infeasible in the slice; note the residual.

### Edge cases
- `\q{}` (empty body) and `\q{|a}` (empty operand) → match the empty string.
- `\q{a|bc}` mixed with ranges in the same class: `[\q{ab}c-e]` → alternation of
  `"ab"` and the class `[c-e]`.
- Escaped `\|` and `\}` inside the body must NOT split / close the disjunction.
- Case-insensitive (`vi`) string disjunction — fold each operand; reuse the
  engine's existing `i`-mode folding for the literal chars.
- Nested set ops containing `\q{}` (`[[\q{ab}]&&[…]]`) — string operands in an
  **intersection/subtraction** are an ES edge (a string can only survive `&&`
  if the other operand also contains it). If this proves intricate,
  **narrow-refuse `\q{}` inside `&&`/`--`** (loud, not silent) and implement only
  top-level/union `\q{}` for the slice; note the carve-out.

### Representative failing test262 paths
- `test/built-ins/RegExp/unicodeSets/generated/string-literal-*.js`
- `test/built-ins/RegExp/unicodeSets/generated/character-class-escape-*.js`
- (the `\q{…}` cases within the `unicodeSets/generated/` set)
- `test/built-ins/RegExp/match-indices/...` (the `v`-flag indices variants overlap)

### Estimated rows recovered
~25-39 for Option A (the `\q{}` subset of `unicodeSets`). Option B recovers 0 but
removes the trap/silent-wrong state — only if A is infeasible.

### Test gate (standalone, empty importObject, no env/`__extern_*` leak)
- `/[\q{abc|xyz}]/v.test("xyz") === true`
- `/[\q{abc}]/v.test("a") === false`
- `"zzabc".match(/[\q{abc}]/v)[0] === "abc"`
- `/[\q{ab}c-e]/v.test("d") === true` (mixed with a range)
- empty operand `/[\q{|a}]/v.test("") === true`

## Resolution (2026-06-22) — Option A implemented (desugar to alternation)

Implemented **Option A**: a v-mode `[…]` class containing `\q{…}` is desugared,
at parse time, to an **alternation of literal-string arms** unioned with the
residual code-point class. Each operand becomes a `concat` of single-code-point
nodes; the residual members enumerate the usual Slice-B way. Arms are ordered
**longest-first** (§22.2.2 ClassSetExpression matches longer strings before
shorter ones), so multi-char operands precede the length-1 class and the empty
operand sorts last (zero-width).

### Changes
- `src/codegen/regex/unicode.ts` — new exported `parseStringDisjunction(qBody)`
  splits a `\q{…}` body on top-level `|` (respecting `\|`/`\}`/`\\` and `\u{…}`)
  into per-operand code-point arrays. Resolves the `\q{}`-specific escape set
  (`\b` = U+0008 backspace, `\u{…}`/`\uHHHH` incl. surrogate-pair joining,
  `\xHH`, `\cX`, identity escapes). Throws `RegexUnsupportedError` on a malformed
  escape (loud, never silent).
- `src/codegen/regex/parse.ts` — `parseAtom`'s v-mode `[` branch routes classes
  containing `\q{` to a new `uEnumClassWithStrings(source)` that extracts the
  top-level `\q{…}` spans (skipping nested `\u{…}` braces), builds the
  alternation, enumerates the residual class, and case-folds operands under `i`.
  Top-level set operations (`&&`/`--`) carrying strings are **narrowly refused**
  (loud `RegexUnsupportedError`) — string-set algebra is out of slice scope.

### Carve-out (noted residual)
Two combinations stay a **loud refusal** (`RegexUnsupportedError`), out of slice
scope and **unchanged from before this fix** (no regression):

1. **`\q{…}` inside a top-level v-mode set operation** (`[\q{ab}--_]`,
   `[[0-9]--\q{…}]`, `[\q{…}&&\q{…}]`, `[\p{…}&&\q{…}]`) — needs string-aware set
   algebra (a string survives `&&` only if both operands contain it). ~22 of the
   33 `unicodeSets/generated` `\q{…}` files are these.
2. **`\q{…}` unioned with a property-of-STRINGS** (`[\p{Emoji_Keycap_Sequence}\q{…}]`,
   `\p{Basic_Emoji}`, `\p{RGI_Emoji…}` — the fixed §22.2.1.9 list) — the property
   contributes multi-code-point members the single-code-point enumerator can't
   represent. A guard (`PROPERTY_OF_STRINGS_RE`) refuses this **loudly** so the
   property's strings are never silently dropped (which had given a wrong answer).
   A `\p{…}` over *code points* (`\p{ASCII}`, `\p{L}`) is unaffected and still
   unions fine with `\q{…}`.

The recovered rows come from the **union** forms — `string-literal-union-*`
(11 files), bare `[\q{…}]`, and `[\q{…}<ranges/escapes/code-point-props>]`.

## Test Results

All cases dual-run standalone (empty importObject, no `env`/`__extern_*` import)
vs the native host engine — `tests/issue-2591-vflag-q-string-disjunction.test.ts`
(60 assertions, all pass):

- `/[\q{abc|xyz}]/v.test("xyz") === true`, `.test("abc") === true`, `.test("a") === false` ✓
- `/[\q{abc}]/v.test("a") === false`, `"zzabc".match(...)[0] === "abc"` ✓
- `/[\q{ab}c-e]/v.test("d") === true` (mixed with a range) ✓
- empty operand `/[\q{|a}]/v.test("") === true`; empty body `/[\q{}]/v` matches "" ✓
- longest-first ordering: `/[\q{a|ab}]/v.match("ab")[0] === "ab"` ✓
- multi-disjunction `[\q{ab}\q{cd}]`, mixed-with-shorthand `[\q{xy}\d]` ✓
- escapes `[\q{a\|b}]`/`[\q{a\}b}]`, astral `[\q{\u{1f600}x}]`, case-insensitive `vi` ✓
- the real test262 union shape `^[\q{0|2|4|9️⃣}\q{…}]+$/v` (matchStrings +
  nonMatchStrings) ✓
- `#1911` `\q{…}`-narrowed-refusal test updated to assert the new compiling behaviour.

`tsc --noEmit` clean; prettier clean; existing regex suites (`#1911`, `#1912`,
`#1539`, `regex-bytecode`, `#2161` coercion) pass — the 5 unrelated failures in
`#1474`/`#1539` dynamic-`new RegExp(var)` tests pre-date this change on `main`.
