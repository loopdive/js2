---
id: 6665
title: "standalone: String.prototype.replace/split/match/search refuse a RegExp that arrives as a VALUE (parameter, Map entry) — first blocker for lodash, lodash-es and prettier in the npm-compat standalone lane"
status: ready
sprint: Backlog
created: 2026-09-23
updated: 2026-09-23
priority: medium
horizon: l
feasibility: hard
reasoning_effort: high
task_type: feature
area: compiler
goal: standalone
related: [1474, 1539, 1913, 4016, 6661]
---

# #6665 — standalone string methods refuse a RegExp passed as a value

## Problem

Found by [#6661](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6661-npm-compat-opaque-lane-diagnostic),
which made the npm-compat standalone-dynamic lane report its real error. For
three packages the first error is a compile-time refusal in
`src/codegen/string-ops.ts` (the `symbolProtocolArgForm` / `alwaysRegExp`
branch):

```
Codegen error: String.prototype.replace(...) with a RegExp or symbol-protocol search value is not supported in --target standalone (#1474).
```

The standalone engine only handles a **backend-created static RegExp literal**
at the call site. Library code almost never has that shape — the pattern is a
parameter or a table entry:

| package | site (standalone-dynamic lane, 2026-09-23) | shape |
| --- | --- | --- |
| lodash-es 4.18.1 | `replace.js:26` `string.replace(args[1], args[2])` | RegExp parameter |
| lodash-es | `words.js:32` `string.match(pattern)`; `split.js:49`; `truncate.js:89` (`search`) | RegExp parameter |
| lodash-es | `template.js:207` | function replacer (`#1913 follow-up`) |
| lodash 4.18.1 | same functions inside `lodash.js` (replace, split, search, match) | RegExp parameter |
| prettier 3 `standalone.mjs` | `replaceAll` polyfill `e.global?this.replace(e,t):this.split(e).join(t)`; `e.match(po.get(t))` (RegExp from a `Map`) | RegExp parameter / Map value |

Measured with `npx tsx scripts/generate-npm-compat-report.mjs --only <pkg> --no-write --perf-only --lane standalone-dynamic`
(lodash 100 s, lodash-es 304 s, prettier 18 s to the refusal).

## What a fix needs

A runtime dispatch on the search value, in Wasm: if it is a native RegExp
object, run the pure-WasmGC matcher (#1539) with its runtime `source`/`flags`;
otherwise ToString it (the #4016 plain-string path). The refusal becomes the
fallback only for a genuine Symbol.replace/Symbol.split protocol object.

## Acceptance criteria

- A two-file untyped `.js` fixture whose exported function forwards a RegExp
  parameter to `replace`, `split`, `match` and `search` compiles and runs
  under `--target standalone` with results equal to Node.
- The lodash, lodash-es and prettier standalone-dynamic lanes move past this
  refusal (their next error, if any, is recorded here).
