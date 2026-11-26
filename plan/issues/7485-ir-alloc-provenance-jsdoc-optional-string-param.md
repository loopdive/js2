---
id: 7485
title: "Ordinary pipeline: IR alloc-provenance check fails for String(g0()) over an omitted JSDoc string param"
status: ready
created: 2026-11-26
updated: 2026-11-26
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: ir
goal: core-semantics
sprint: Backlog
related: [7456, 7448]
---

# #7485 — Ordinary pipeline: IR alloc-provenance check fails for `String(g0())` over an omitted JSDoc string param

## Problem

The ordinary pipeline fails to compile a small `.js` program: the IR claims the exported caller, then its final
allocation-provenance check (#1586) rejects it, and the error surfaces as a compile error rather than a select-time
refusal (CLAUDE.md: "refuse at select, never claim a unit and then withdraw it"). Default target and
`--target standalone` alike. Found while working on [#7448](7448-ordinary-jsdoc-param-number-wrong-value.md).

## Reproduction (2026-11-26, `origin/main` `41f0654e8c`)

```js
/** @param {string=} s */ function h(s){ return s + "!" }
function g0() { return h(); }
export function g() { return String(g0()) === "undefined!"; }
export function s() { return String(g0()); }
```

node: `String(g0())` is `"undefined!"`, so `g()` is `true`.

js2wasm, `compile(src, { fileName: "t.js", allowJs: true [, target: "standalone"] })` and the same with
`compile(src, opts, undefined, "refuse")`, all four answer the same compile error, for units `g` and `s`:

```
Codegen error: IR path failed for g: IR alloc-provenance check failed (#1586):
  - [g] live instr "call" references retired/aliased-away AllocSiteId 2 (stale provenance) [IR-FALLBACK]
Codegen error: IR path failed for s: IR alloc-provenance check failed (#1586):
  - [s] live instr "call" references retired/aliased-away AllocSiteId 2 (stale provenance) [IR-FALLBACK]
```

| JSDoc on `h` | default | standalone |
| --- | --- | --- |
| `@param {string=} s` | CE above (`g`, `s`) | CE above (`g`, `s`) |
| `@param {string} [s]` (only `g` exported) | CE above (`g`) | CE above (`g`) |
| `@param {string} s` | traps: dereferencing a null pointer | same |

PR #7435 (#7448 option C) also makes the omitted `@param {string} s` form reach this compile error (main: the
null-pointer trap in the last row; with #7435: the alloc-provenance CE).

## Acceptance criteria

- All three rows compile on both targets and `g()` answers `true` (`String(g0())` is `"undefined!"`).
- No unit fails the final alloc-provenance check after being claimed: either the IR carries a live allocation site
  through the call, or the selector refuses the unit before claiming it.
- A test pins the rows on both targets.
