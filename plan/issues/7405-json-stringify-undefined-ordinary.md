---
id: 7405
title: "Ordinary pipeline answers `JSON.stringify(undefined)` with \"null\" instead of `undefined`"
status: ready
sprint: Backlog
created: 2026-11-19
updated: 2026-11-19
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
goal: core-semantics
related: [7354]
---

# #7405 — Ordinary pipeline answers `JSON.stringify(undefined)` with "null" instead of `undefined`

## Problem

`JSON.stringify(v)` where `v` is `undefined` (or any value whose serialization is `undefined`: a function, a symbol)
must return the value `undefined` (§25.5.2 `JSON.stringify` step 12, SerializeJSONProperty step 10/11). The ordinary
pipeline returns the string `"null"`, on both targets.

The cause is the codec's call-site root `__json_stringify_root` (`src/codegen/json-codec-native.ts`, the
`emitJsonStringifyRoot` body near line 1490): it serializes at depth 0 and coalesces a null result to the literal
`"null"`. Its own comment calls this "a documented PR-A limitation". Its result type is `ref $AnyString`, so it cannot
answer `undefined` at all; legacy calls the same root, and so does the IR's `dyn.json_stringify` on the ordinary
pipeline (`src/ir/integration.ts`, `emitJsonStringify`).

Found while planning [#7354](7354-prepared-path-harness-prelude-milestone.md) slice J, which gives the Prepared path
its own `dyn.json_stringify` (result: the dynamic value, so `undefined` is answered). J leaves the ordinary pipeline's
bytes unchanged on purpose; this issue is the ordinary fix.

## Reproduction (2026-11-19, branch `claude/7354-json` on `origin/claude/7354-integration` `9426e5e1c2`)

The program below, compiled with `compile` from `src/index.ts` and run with `buildImports` (default target) or no imports
(standalone).

```ts
function f(v: any): any { return JSON.stringify(v); }
export function test(): number {
  const s = f(undefined);
  return s === undefined ? 1 : s === "null" ? 2 : 3;
}
```

| Target | js2wasm `test()` | node |
| --- | ---: | ---: |
| default (JS environment) | 2 (`"null"`) | 1 (`undefined`) |
| `--target standalone` | 2 (`"null"`) | 1 (`undefined`) |

## Acceptance criteria

- The repro answers 1 on both targets; so do a top-level function value and a symbol operand.
- `JSON.stringify` inside an object or array keeps its current answers (an `undefined` property is omitted, an
  `undefined` element is `"null"`).
- The fix changes the root's result contract (a string or `undefined`), so every caller of `__json_stringify_root`
  (legacy, the IR's ordinary `dyn.json_stringify` lowering, `JSON.stringify` as a value, #2933) is updated together;
  gc output changes only where the answer was wrong.
