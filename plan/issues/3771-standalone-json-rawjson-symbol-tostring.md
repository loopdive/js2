---
id: 3771
title: "standalone JSON.rawJSON does not throw TypeError for Symbol text"
status: done
sprint: 77
created: 2026-07-28
updated: 2026-07-30
completed: 2026-07-28
priority: medium
horizon: s
feasibility: easy
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: json
goal: es5-conformance
assignee: "ttraenkler/codex-json-rawjson-symbol"
parent: 3176
related: [3176, 3769]
---

# #3771 — JSON.rawJSON Symbol ToString

## Measured residual

Fresh latest-main measurement on `d3bdf7cfc5612e` shows:

- host JSON: 108/165 pass;
- standalone JSON: 85/165 pass;
- host `rawJSON/**`: 7/10 pass;
- standalone `rawJSON/**`: 8/10 pass.

`rawJSON/invalid-JSON-text.js` passes in host mode but fails standalone because
`JSON.rawJSON(Symbol("123"))` does not throw the `TypeError` required by
ECMA-262 §25.5.3 step 1 and §7.1.17.

PR #3767 changes only the static `JSON.stringify(..., space)` resolver and does
not overlap this runtime coercion path. Historical #3176 rawJSON branches carry
no unmerged Symbol-coercion fix.

## Root cause and fix

The pure-Wasm `__json_rawjson` helper performs its own representation-neutral
ToString dispatch. Native `$Symbol` carriers currently fall through to the
generic object string, which is rejected later as invalid JSON. That produces
the wrong exception class and also misses the coercion boundary.

Recognize `$Symbol` in the runtime ToString dispatch and throw the existing
in-module `TypeError` before JSON parsing. Keep the guard inside the runtime
helper so direct Symbols, erased `any` values, and container reads share the
same behavior.

## Validation

Same-SHA local-v-local A/B against `d3bdf7cfc5612e`:

- exact `rawJSON/invalid-JSON-text.js`: host pass → pass; standalone fail → pass;
- complete host JSON cohort: 108/165 → 108/165, zero verdict changes;
- complete standalone JSON cohort: 85/165 → 86/165, with the exact target as
  the sole status change and zero pass → fail transitions;
- `rawJSON/**`: host remains 7/10; standalone moves 8/10 → 9/10;
- excluding the target, standalone status fingerprint
  `a31606c0c15edda7f21ff0e205264ecb6eabd4c32b6492b652382393be927404`
  and raw error fingerprint
  `adb5718a40396e378615b411ed1f868e92b746c7e3dd5b42308ec214b1175856`
  are identical in both arms;
- excluding the target, host status fingerprint
  `80adb41fd2c2489c8fc057d9a6e4d626bd0dc02832c2308343b29d8218f29f74`
  is identical. Ten already-failing host rows differ only by the optional
  runner prefix `strict rerun: `; an independent clean-main A/A rerun
  reproduces that prefix loss. Removing only that verified runner prefix gives
  the identical detailed fingerprint
  `5ca46c567b6772a70e11c51119f513876967961a85154f57aafd46d8aad2bf42`.

Focused and structural validation:

- `tests/issue-3771-json-rawjson-symbol.test.ts`: 3/3 pass, including direct,
  erased-local, erased-array, exact Test262, correct exception identity, and an
  empty WebAssembly import table;
- combined #3771/#3176/#2166 JSON run: 89 pass, 1 skip, 1 failure. The only
  failure (`#2166` replacer returning undefined) reproduces unchanged on clean
  latest main;
- typecheck, Biome lint, and Prettier pass;
- oracle ratchet, coercion-site, LOC, and function budgets pass without
  allowances;
- IR fallback and IR-only hybrid identity/readiness gates pass;
- dead-export, pushRaw, stack-balance, codegen-fallback, AnyValue box-site,
  speculative-rollback, harness compile-work, IR-adoption, and verdict-oracle
  gates pass;
- issue integrity, issue-spec coverage, against-main ID, and against-open-PR ID
  gates pass; #3771 collides with none of the 20 open PRs adding issue files.
