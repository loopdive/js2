---
id: 7170
title: "Native lanes: array holes are not represented consistently (new Array(n), elision, hasOwnProperty, map, delete read, gap fill)"
status: ready
sprint: current
created: 2026-10-26
updated: 2026-10-26
priority: high
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

# #7170 — hole representation on the native lanes

Found by the round-2 review of PR #6918 (#7151). All pre-existing on `origin/main`, gc native-first and standalone (wasi: see #7171).

```js
const a: any[] = new Array(3); a[0] = "b"; console.log(2 in a);             // true   (node false)
const b: any[] = ["b", , "a"]; console.log(1 in b, b.hasOwnProperty(1));   // true true (node false false)
console.log(["b", , "a", undefined].map(v => typeof v).join());            // "string,undefined,..." (node "string,,...") — all lanes, host included
const c: any[] = []; c.push("c"); c.push("a"); c.push("b"); delete c[2]; String(c[2]); // native-first traps, standalone "null"
const d: any[] = []; d.push("b"); d[4] = "a"; console.log(2 in d);          // true   (node false) — cf. #7164
```

## Implementation Plan (2026-10-26; implement on Opus)

1. Inventory every producer of an array slot on the native lanes (literal elision, `new Array(n)`, `Array(n)`, `length` growth (#7164), index store past length, `delete`) and every consumer that must distinguish a hole (`in`, `hasOwnProperty`, `Object.keys`, `forEach`/`map`/`filter`/`some`/`every`/`reduce` skip, `join`, `sort`, element read → `undefined`).
2. Unify on the one `$Hole` sentinel the externref vec already uses (and the typed-vec hole encoding for numeric vecs): every producer writes it, every consumer tests it through one shared helper (the `externUndefinedTest`-style helper #7151 introduced; extend it with a hole test), so element reads return `undefined` and iteration methods skip holes per spec.
3. Tests: `tests/issue-7170-native-holes.test.ts` with the five programs plus `forEach`/`filter`/`Object.keys` rows on gc native-first and standalone vs node; keep #7151 and #7164 tests green.

Acceptance: node output on both lanes; host-assisted gc bytes unchanged; equivalence gate no new regressions.
