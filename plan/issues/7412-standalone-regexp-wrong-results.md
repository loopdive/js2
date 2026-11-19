---
id: 7412
title: "Standalone RegExp: `replace` with a global sticky RegExp does not stop at the first failed match"
status: ready
sprint: Backlog
created: 2026-11-19
updated: 2026-11-19
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: compiler
goal: ir-full-coverage
depends_on: []
related: [7369, 1539]
---

# #7412 — standalone RegExp wrong results found in the #7337 review

Both were found by the reviewer of PR #7337 (#7369 R0). They predate it: R0 moves the engine without changing its
output.

## 1. `replace` with `/a/gy` keeps matching after a failed sticky match (reproduced)

With the `y` flag, `RegExp.prototype[@@replace]` with a global RegExp must stop at the first position where the sticky
match fails (§22.2.6.11 / §22.2.7.2: RegExpBuiltinExec fails at `lastIndex`, which ends the global loop).

```ts
export function run(): number { return "aaba".replace(/a/gy, "x") === "xxba" ? 1 : 0; }
```

node: `"aaba".replace(/a/gy, "x")` is `"xxba"`. Compiled `--target standalone` on main `89e47482`, `run()` returns 0:
the sticky failure at index 2 does not end the loop.

## 2. Not a RegExp bug: `String()` of a null `exec` result (moved to #7414 row 16)

The reported `/(a*)*b/.exec` trap is `String(m)` of a null `RegExpExecArray`: `/zzz/.exec("aaaac")` traps the same
way, while `m === null` answers correctly. It is any array-typed null (`"abc".match(/z/)`, a `number[] | null`), so
it is filed as #7414 row 16. The reviewer's case 2 matches item 1 above: `"aaba".replace(/a/gy, "X")` gives
`"XXbX"` on standalone, node `"XXba"`.

## Acceptance

- `"aaba".replace(/a/gy, "x")` answers `"xxba"` on standalone and wasi; pinned against node, with a wrong answer that
  throws.
