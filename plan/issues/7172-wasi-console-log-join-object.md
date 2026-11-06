---
id: 7172
title: "WASI: console.log(s.join()) prints [object] unless the value is first bound to a const"
status: ready
sprint: current
created: 2026-10-26
updated: 2026-10-26
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: arrays
goal: correctness
parent: 6979
related: [7151, 7164, 7166]
---

# #7172 — wasi `console.log` of a call result prints `[object]`

Found by PR #6918 (#7151) and its round-2 review; related to #7157 (standalone `console.log(number)`). Pre-existing on `origin/main`, `--target wasi`:

```js
const s: any[] = ["b", "a"];
console.log(s.join());        // "[object]"   (node "b,a")
const t = s.join(); console.log(t);   // "b,a"
```

Also `console.log(e.message)` in a catch prints `[object]` on wasi (seen while fixing #7168).

## Implementation Plan (2026-10-26; implement on Opus)

1. Dump the wasi WAT for both forms and name the difference: the direct call result is probably typed as an anyref/externref string that the wasi `console.log` lowering formats through the generic object path instead of the string path.
2. Fix the wasi `console.log` argument lowering (`compileConsoleCall`, `src/codegen/expressions/builtins.ts`, wasi branch) to classify the runtime value (native string → string write) rather than its static carrier type; share the classification with the #7157 standalone fix if that has landed.
3. Tests: `tests/issue-7172-wasi-console-log-strings.test.ts` with `join()`, `toString()`, `e.message`, template literals and a const-bound control, on wasi vs node.

Acceptance: node output on wasi; other lanes byte-identical; equivalence gate no new regressions.
