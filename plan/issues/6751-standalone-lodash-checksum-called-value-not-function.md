---
id: 6751
title: "standalone lodash: after module init, the perf checksum (`words(text).length + kebabCase(text).length`) throws `called value is not a function`"
status: ready
sprint: current
created: 2026-09-29
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: standalone
requested_by: ttraenkler/sendev-standalone
related: [6736, 6713, 6732, 4586]
---

# #6751: lodash standalone-dynamic fails in the checksum phase

## Problem

After [#6736](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6736-standalone-fnctor-prototype-length-reads-number),
lodash 4.18.1's `runInContext` module init completes in `--target standalone`
with 0 imports. The first call to the perf export then throws:

```
checksum THROW: TypeError: called value is not a function
```

Measured 2026-09-29 on `0aeb5733bb` + #6736. The steps:

1. Build the unoptimized binary:
   `npx tsx scripts/generate-npm-compat-report.mjs --only lodash --no-write --perf-only --lane standalone-dynamic --inspect-binary .tmp/lodash.wasm`
2. Instantiate it with `{}`.
3. Call `__module_init()`, which returns normally.
4. Call `__npmCompatStandaloneDynamic(1, 4381)`, which throws the error above.

The sample op is `words(text).length + kebabCase(text).length`.

The lane itself still reports `optimization-error`. That is the O4
`Flatten.cpp:231` abort, followed by the `--skip-pass=flatten` retry, and it is
tracked separately in
[#6732](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6732-standalone-axios-o4-no-flatten-retry-exceeds-timeout).
This issue covers only the runtime link, which the unoptimized binary
exposes.

## Direction

`words` → `asciiWords` / `unicodeWords` use `string.match(reAsciiWord)`, and
`kebabCase` → `createCompounder` → `arrayReduce(words(deburr(string).replace(reApos, '')), callback, '')`.
Either the match of a realm-aliased `RegExp` (#6713 carriers) or a callback
reached through `arrayReduce` is the likely non-callable. Bisect with
`globalThis.__probeStep` markers inside the two entry points, then reduce.
