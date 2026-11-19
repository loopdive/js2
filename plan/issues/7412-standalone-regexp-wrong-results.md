---
id: 7412
title: "Standalone RegExp: `replace` with a global sticky RegExp does not stop at the first failed match; reported `exec` trap on `/(a*)*b/`"
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

## 2. `/(a*)*b/.exec` traps (reported, not yet reproduced)

The reviewer reports that `/(a*)*b/.exec(...)` traps on standalone. These shapes do NOT trap on main `89e47482` and
answer as node does: a typed `run()` over `/(a*)*b/.exec("aaab")` (m[0] `"aaab"`, m[1] `"aaa"`) and over
`.exec("aaa")` (null); a JS script over `.exec("aaab")` and `.exec("b")` (m[1] undefined). The exact failing shape is
still to be recorded from the reviewer before this half is worked on.

## Acceptance

- `"aaba".replace(/a/gy, "x")` answers `"xxba"` on standalone and wasi; pinned against node, with a wrong answer that
  throws.
- The `/(a*)*b/` trap reproduced from the reviewer's shape and fixed (an empty-iteration guard in the VM's star loop is
  the usual cause), or closed as not reproducible with the shapes above recorded.
