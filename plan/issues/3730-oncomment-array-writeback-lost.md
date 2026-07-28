---
id: 3730
title: "acorn onComment array option: writes from a compiled-acorn-internal closure don't propagate back to the caller's array"
status: ready
sprint: current
created: 2026-07-28
updated: 2026-07-28
priority: medium
horizon: m
feasibility: hard
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: closures
goal: core-semantics
origin: "tests/dogfood/acorn-official-suite.mjs (#3729) — acorn's own test suite, 6/3518 failures"
related: [3729, 1710]
---

# #3730 — `onComment` array option writes lost across a compiled-internal closure

## Repro

Compile acorn (pinned `acorn@8.16.0`, `dist/acorn.mjs`) with js2wasm and
run acorn's own driver against it (`pnpm run dogfood:acorn-official-suite`,
#3729). 6 of acorn's own test cases fail with `array length mismatch N !==
0` — the caller's `onComment` array stays empty after parsing, when it
should have been populated:

```js
const comments = [];
acorn.parse("// line comment", { onComment: comments, ecmaVersion: 5 });
// real acorn:      comments.length === 1
// compiled acorn:  comments.length === 0
```

Affects any source with comments/directives/shebangs when `onComment` is
passed as an array: `// line comment`, `<!-- HTML comment`, `--> HTML
comment`, `#!/usr/bin/node` shebangs, block comments inside a `'use
strict'` function body, and a larger real-code case (`TestComments`, 4
expected comment records).

## Mechanism

`acorn/src/options.js`:

```js
if (isArray(options.onComment))
  options.onComment = pushComment(options, options.onComment)
```

`pushComment(options, array)` returns a closure that, each time acorn's
tokenizer hits a comment, does (paraphrased)
`array.push({ type, value, start, end, ... })` — i.e. acorn converts an
array-shaped `onComment` option into a **closure created and invoked
entirely inside acorn's own (compiled) code**, which captures the
caller-supplied array by reference and mutates it via `.push()`.

The `isArray(options.onComment)` check itself passes (compiled acorn
correctly recognizes the externref-passed array as an array), and parsing
completes without error — but whatever `.push()` calls happen inside that
internal closure never become visible on the ORIGINAL array object as seen
by the JS caller after `parse()` returns.

## Hypothesis (unconfirmed — not root-caused past this point)

This looks like an externref/closure identity gap: a closure defined
inside compiled code that captures an object passed in FROM the host
(externref) and mutates it via a method call (`.push`) may not be
correctly threading writes back to the same underlying host object —
either the closure captures a copy/wrapper rather than the live
reference, or the internal `.push()` dispatch resolves to a
compiled-side array representation distinct from the externref-boxed one
the host sees. Needs a minimal repro isolated from acorn's actual code to
confirm (a plain `function outer(arr) { return () => arr.push(1); }`,
called across the externref boundary) and to determine whether this is
narrow to `onComment`-shaped usage or a general closure-captures-external-
array gap.

## Scope

- [ ] Build a minimal, non-acorn repro isolating the exact failure shape
      (closure created inside compiled code, capturing an externally-passed
      array parameter, mutating it via `.push()` after the outer call that
      created the closure has already returned).
- [ ] Determine whether this is `onComment`-specific or a general
      closure/externref-array-identity gap (higher real-world weight if
      general — likely a broader compiler-correctness issue, not just an
      acorn quirk).
- [ ] Fix + regression test.
- [ ] Re-run `pnpm run dogfood:acorn-official-suite` — expect this bucket's
      6 failures to clear (update
      `tests/dogfood/acorn-official-suite.test.ts`'s `BASELINE_PASSED` from
      3507 upward once confirmed).

## Acceptance criteria

- [ ] Minimal repro (closure capturing + mutating an external array
      parameter) works correctly.
- [ ] All 6 `onComment`-related acorn official-suite failures clear.
- [ ] `BASELINE_PASSED` in `acorn-official-suite.test.ts` updated to reflect
      the improved pass count (no regression in the other buckets).
