---
id: 6672
title: "standalone: RegExp exec reached through an untyped property chain returns null — marked's lexer throws `Infinite loop on byte: 35`"
status: ready
sprint: Backlog
created: 2026-09-24
updated: 2026-09-24
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: standalone
related: [1539, 6662, 6665]
---

# #6672 — `rules.block.heading.exec(src)` answers null in `--target standalone`

## Problem

Found by [#6665](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6665-standalone-string-methods-dynamic-regexp-value),
which moved marked's npm-compat **standalone-dynamic** lane past its last
compile-time refusal. marked now compiles, instantiates and throws at the
checksum call:

```
Error: Infinite loop on byte: 35
```

(the lane itself prints `[object WebAssembly.Exception]` — see the harness note
below). marked's block lexer found no tokenizer rule matching the `#` of
`"# npm-compat\n\nA short paragraph."`: its `heading` rule
`/^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/` is read from the rules table as
`this.rules.block.heading.exec(src)`, and that exec answers `null`.

Minimal repro (untyped `.js`, `target: "standalone"`):

```js
var ye = /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/;
var rules = { block: { heading: ye } };
function head(r, s) { var t = r.block.heading.exec(s); return t ? t[2].length : -1; }
export function test() { return head(rules, "# npm-compat\n\nA short"); } // standalone: -1, Node: 11
```

The same regex called directly (`ye.exec(s)`) answers 11 — only the
receiver-through-`any` path is wrong. A second, related symptom from the same
probe: marked's `k()` pattern builder
(`new RegExp(src.replace(name, re.source), flags)`) throws an unrendered Wasm
exception for `k(/^a(b)c/).replace("b", "x").getRegex().exec("axc")`.

## Harness note

`scripts/generate-npm-compat-report.mjs` renders a checksum-phase throw with
`renderHarnessThrownText(error, compiled.exports)` — it passes the EXPORTS
where the renderer expects the INSTANCE (`instance.exports.__exn_tag`), so the
payload is never decoded and every checksum throw reads
`[object WebAssembly.Exception]`. Rendering with the instance gives the real
text above.

## Acceptance criteria

- The repro answers 11 under `--target standalone`.
- marked's standalone-dynamic lane moves past `Infinite loop on byte: 35`.
