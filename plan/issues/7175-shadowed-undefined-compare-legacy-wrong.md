---
id: 7175
title: "A shadowed `let undefined` compares as the undefined value in the legacy path"
status: ready
sprint: Backlog
created: 2026-10-26
updated: 2026-10-27
priority: low
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: undefined
goal: correctness
related: [7144]
---

# #7175 — A shadowed `let undefined` compares as the undefined value in the legacy path

Found in the round-3 review of PR #6927 (#7144), NIT 2. The bug is already on main, and the base and head bytes are identical.

```ts
function f(x: any) {
  let undefined = 5;
  return x === undefined ? 1 : 2;
}
// f(5) → node 1, f(void 0) → node 2
```

Results on gc native-first (legacy path):

| Call | node | gc native-first |
|---|---|---|
| `f(5)` | 1 | 2 |
| `f(void 0)` | 2 | 1 |

The probe printed `21` where node prints `12`. (2026-10-27, #6834 round-11 review G) The same miscompile reproduces on standalone and wasi; base and head bytes are identical there too. The legacy compiler treats the identifier `undefined` as the undefined value even when a local binding shadows it.

The IR path is correct here. `isUndefinedCompareOperand` checks `cx.scope` before treating `undefined` as the undefined value.

## Implementation Plan

1. **Find the site.** It is in the legacy undefined-compare / identifier lowering: grep `src/codegen/` for the `"undefined"` identifier fast path in equality lowering and in `compileIdentifier`. Resolve the symbol with `ctx.oracle`, not the raw checker. Take the fast path only when the symbol is the global `undefined`, not a local or parameter binding.
2. **Check every lane.** Run the probe on standalone and wasi too, and fix any other path that shares the shortcut.
3. **Tests.** Add `tests/equivalence/issue-7175-*.test.ts` covering:
   - `let undefined` shadowing;
   - a parameter named `undefined`;
   - a `var undefined` inside a function.

   Check `===`, `!==`, `==` and `typeof undefined`.
4. **Bytes.** Output changes only for functions that shadow `undefined`. Byte-sample the playground and equivalence programs to confirm.
