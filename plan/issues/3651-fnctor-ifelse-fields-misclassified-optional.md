---
id: 3651
title: "Fnctor fields assigned in both if/else arms are misclassified as optional"
status: in-progress
sprint: current
created: 2026-07-26
updated: 2026-07-26
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: arrow-functions
goal: self-hosting-dogfood
parent: 1712
depends_on: []
related: [2608, 3308, 2841]
assignee: ttraenkler/codex-acorn
---

# #3651 — Fnctor fields assigned in both if/else arms are misclassified as optional

## Problem

Standalone compiled Acorn rejects a bare arrow expression such as
`(a, b, c) => a + b + c` with `SyntaxError: Unexpected token (1:10)`, even
though larger corpus files containing arrow functions still parse.

The regression was exposed by widening `tests/dogfood/acorn-probe.mjs` from one
parenthesized-arrow case to six bare-arrow variants and preserving the
Wasm-exception payload in the report. On the Acorn branch before the fix:

- single-construct in-Wasm parity: **14/20**;
- every bare-arrow variant threw at its `=>` token;
- corpus scale walk: **13/13** exact node-count parity.

An exact local-vs-local A/B against upstream commit
`932e042a20d45ce5172f3926a62ad03e9df53fb4` showed upstream at **15/15** and
the Acorn branch at **14/15** on the original probe. The same failure reproduced
at the pre-sync Acorn publication commit
`f80654c4455664ce1bd7b95bbe871f8e5fd5026c`, proving that the later upstream
merge did not introduce it.

## Root cause

`deriveFnctorFields` marks every `this.<field> = ...` encountered inside an
`if` arm as conditional. It does not reconcile a complete `if/else` whose two
arms both assign the field.

Acorn's `Parser` constructor initializes `pos`, `lineStart`, and `curLine` in
both arms of:

```js
if (startPos) {
  this.pos = startPos;
  this.lineStart = ...;
  this.curLine = ...;
} else {
  this.pos = this.lineStart = 0;
  this.curLine = 1;
}
```

The compiler therefore added hidden presence bits to fields that are actually
present on every successfully constructed Parser. The finalized dynamic member
getter honored the false `pos` presence bit in lifted parser methods and
returned standalone `undefined`. Acorn's arrow lookahead then lost its position
state and rejected the `=>`.

This is distinct from a genuinely optional one-arm field such as
`if (withValue) this.foo = null`: that field must keep presence tracking so
reads and `Object.hasOwn` distinguish absence from an explicitly stored default
value.

## Implementation

- Add conservative definite-assignment reconciliation to
  `deriveFnctorFields`: direct `this` assignments in both arms of a complete
  `if/else` are treated as guaranteed, including chained assignments and nested
  complete branches.
- Stop the statement-sequence proof at abrupt control flow.
- Expand the Acorn in-Wasm probe with identifier, parenthesized, multi-param,
  default-param, and async bare-arrow inputs.
- Preserve Wasm exception name/message payloads in the probe report.
- Add a focused standalone fnctor regression while retaining the existing
  never-assigned optional-field assertion.

## Acceptance criteria

- [x] All six bare-arrow variants parse in the standalone Acorn probe.
- [x] Single-construct node-count parity is **20/20**.
- [x] Corpus scale node-count parity remains **13/13**, with no runaway or
      undercount.
- [x] `tests/issue-2608-new-this-fnctor-static.test.ts` is **17/17**, including
      both complete-`if/else` and genuinely optional field cases.
- [x] Full Acorn host corpus remains **23/23 exact**, including Acorn
      self-parse, with no quirks or real divergences.
- [x] Standalone Acorn artifact validates with zero function imports and
      executes the `parse`, `parseExpressionAt`, and `tokenizer` in-module
      canaries (`2`, `3`, and `4` respectively; 1,704,853-byte artifact).
- [ ] Typecheck and the scoped codegen regression battery pass.
