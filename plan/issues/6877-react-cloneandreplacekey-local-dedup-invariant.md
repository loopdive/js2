---
id: 6877
title: "react compiles to a codegen invariant failure on both lanes: `cloneAndReplaceKey` references out-of-range locals after local dedup"
status: ready
created: 2026-10-06
updated: 2026-10-06
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
language_feature: functions
goal: architecture
parent: 6749
related: [5385, 6749, 6876]
---

# #6877 — react's first real compile fails in local dedup

## Problem

With #6876 (in-branch `require` hoist) react is compiled for the first time on
both npm-compat lanes, and both fail at the same place (2026-10-06,
`--only react --perf-only`):

| lane | diagnostic |
| --- | --- |
| `js-host` | `Internal error compiling function 'cloneAndReplaceKey': codegen invariant: 'cloneAndReplaceKey' references out-of-range local(s) 159, 203 after local dedup (params=2, locals=5, before=5)` |
| `js-host-native` | same, locals 155, 199 `(params=2, locals=7, before=7)` |

`cloneAndReplaceKey` is react's `cjs/react.development.js` helper
(`function cloneAndReplaceKey(oldElement, newKey) { … ReactElement(oldElement.type, newKey, undefined, undefined, oldElement._owner, oldElement.props, …) }`
in 19.x). The body references locals 159/203 while the function has 7 — a
local index baked from another function's context (a shared helper emitted
while this function was being compiled, or a late-import index shift of the
#6687 kind), caught by the post-dedup invariant.

## Next step

Reduce from `tests/dogfood/.react/package/cjs/react.development.js`: compile
the file alone with `compileProject({ allowJs: true, platform: "node" })`,
then bisect `cloneAndReplaceKey` and its callees (`ReactElement`,
`hasValidKey`, the dev-only `Object.defineProperty(element, "_store", …)`
block) until the smallest body that still trips the invariant. Record which
emitter wrote the stray index (`allocLocal` caller) — the fix is at that
emitter, not in the dedup pass.

## Acceptance

- [ ] Reduced repro in `tests/issue-6877-*.test.ts` compiles and runs on
      default gc, the native regime and `--target standalone`.
- [ ] react measures on both npm-compat lanes with Node's checksum (the
      #6876 acceptance box this blocks).
