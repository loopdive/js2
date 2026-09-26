---
id: 6685
title: "S1: console/print lowers to the platform capability in a JS environment under the native regime"
status: done
completed: 2026-09-26
assignee: ttraenkler/opus-6685
created: 2026-09-26
updated: 2026-09-26
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: refactor
area: codegen, testing
language_feature: host-capabilities
goal: architecture
sprint: current
parent: 5385
depends_on: [5385]
related: [3469, 4397, 4398, 6671]
# 2026-09-26 (#6685): the plan (#5385 v2, "Design rule for every slice") places
# the new `hostFreeEnvironment(ctx)` predicate next to the ctx types in
# context/types.ts; +10 lines (one exported function + its doc comment).
# 2026-09-26 (#6685 S1b): the console capability must marshal a Wasm-owned
# string to a JS string. builtins.ts +10 (bridge export at the externref console
# call + import). The runtime marshal lives in the new
# src/runtime/console-host-marshal.ts with an injected converter; runtime.ts is
# net 0 lines (host-import-policy runtimeTsLines ceiling unchanged).
loc-budget-allow:
  - src/codegen/context/types.ts
  - src/codegen/expressions/builtins.ts
---

# #6685 — S1: console is a capability in a JS environment (native regime)

Slice S1 of the #5385 "Implementation Plan v2". Read that section first; this
file only restates the acceptance bar.

## Problem

With `JS2WASM_NATIVE_REGIME_JS=1` a `semanticProviders: "native-first"` build in
a JavaScript environment mints the host-free `__stdout_acc` sink (#3469) and the
`__stdout_prepare`/`__stdout_char` inspection exports, because those sites are
gated on `ctx.standalone || ctx.wasi`, which now means "native regime", not
"no JS embedder". Consequences: `console.log` never reaches the host console
capability (`tests/issue-4397-native-semantic-js-host.test.ts` "selects native
strings without disabling JS capabilities or their boundary marshal" expects
`env.console_log_string`), and the test262 measurement lane loses 2,121
host-passing rows to `async completion marker not observed` because the worker
drains `__stdout_*` only for `target === "standalone"`
(`scripts/test262-worker.mjs:2473`).

## Change

Introduce `hostFreeEnvironment(ctx)` (≡ `ctx.targetProfile.environment !==
"javascript"`) next to the other predicates in `src/codegen/context/types.ts`
and re-key ONLY environment-shaped console arms to it:

- `src/codegen/declarations/import-collector.ts` ≈ L1565 — where
  `ctx.usesStandaloneConsoleSink` is set.
- `src/codegen/index.ts` ≈ L5636 (mint sink), ≈ L6267 and ≈ L11699
  (`__stdout_prepare`/`__stdout_char` emission).
- `src/codegen/standalone-console-object.ts` (#6671 `console` as a value):
  host-free environments keep it; a JS environment takes the existing
  declared-global capability route.
- Runner twins: `scripts/test262-worker.mjs:2473` and the in-process arm in
  `tests/test262-shared.ts` (≈ L1050) drain `__stdout_*` when the instance
  exports carry it (`typeof exp.__stdout_prepare === "function"`), never by
  target name.

Do NOT touch arms whose question is "which provider" (string engine, number
format, errors, collections); they stay on `ctx.standalone`.

## Acceptance

- [x] `tests/issue-4396-target-profile.test.ts` byte-identity test green: default
      `gc`, `standalone`, `wasi` output unchanged.
- [x] `JS2WASM_NATIVE_REGIME_JS=1 npx vitest run tests/issue-4397-native-semantic-js-host.test.ts`
      — the "selects native strings…" test passes; the other failures do not
      grow (before: 10 red, of which "parse and URI string globals" is
      pre-existing on main).
- [ ] `JS2WASM_NATIVE_REGIME_JS=1 pnpm run check:host-import-policy` green. (Pre-existing red on main, unchanged — S2's callback boundary; see Test Results.)
- [x] 321-row sample (`JS2WASM_EVAL_ENGINE=interpreter TEST262_SEMANTIC_PROVIDERS=native-first TEST262_PATH_FILTER="built-ins/Object/keys/|built-ins/Array/prototype/map/|language/expressions/class/accessor" TEST262_WORKERS=2 pnpm run test:262`)
      ≥ 218 / 321; record the number in the PR.
- [x] A focused test proves a regime JS build of an async test262-shaped
      program (`$DONE` via `console.log("Test262:AsyncTestComplete")`) reports
      the marker through the console capability, and a standalone build still
      reports it through `__stdout_*`.
- [x] Standalone/WASI targets: no import or export change (assert in the
      focused test).

## Test Results (2026-09-26, base = upstream/main @ cb2e265852)

- `tests/issue-4396-target-profile.test.ts` (byte identity: default `gc`,
  `standalone`, `wasi`): green.
- `JS2WASM_NATIVE_REGIME_JS=1 … tests/issue-4397-native-semantic-js-host.test.ts`:
  before 19 red / 11 green (the file has grown to 30 tests since the plan's
  "10 red" count); after 18 red / 12 green. The only flip is "selects native
  strings without disabling JS capabilities or their boundary marshal" → green.
- `JS2WASM_NATIVE_REGIME_JS=1 pnpm run check:host-import-policy`: RED on both
  base and this branch with the identical pre-existing error
  (`__boundary_callback_call_1 must remain an explicit value adapter, got
  missing` — the functionBind probe's callback boundary, an S2 item). Without
  the env var: green.
- 321-row native-first sample: base 219 / 321, after 219 / 321 (base
  re-measured on this main; the plan's 218 predates it).
- New `tests/issue-6685.test.ts` (3 tests) + #3469 and #6671 sink tests: green.

The in-module `__stdout_*` gates in the runner twins (`scripts/test262-worker.mjs`,
`tests/test262-shared.ts`) now feature-detect the exports instead of testing
`target === "standalone"`; `drainAndCaptureNativeStdout` was already
feature-detecting, so this also drains a regime module's native microtask ring.


## Follow-up (S1b, 2026-09-26)

S1 routed console to the `console_log_*` capability, but the test262 harness
`print(x)` is untyped, so under the regime it lowers to `console_log_externref`
and hands the host a Wasm-owned string ("Cannot convert object to primitive
value" — reported by the #6687 lane). Three changes:

1. `hostStringBridgeUsable` (native-strings.ts) asks the environment
   (`!hostFreeEnvironment(ctx) && !ctx.strictNoHostImports`), not the regime.
2. `compileConsoleCall`'s externref arm exports the native-string boundary
   bridge under the regime (`ensureNativeStringBoundaryBridge`).
3. the resolved console capability is wrapped by `wrapConsoleForHost`
   (new `src/runtime/console-host-marshal.ts`, converter injected by runtime.ts,
   no import back into runtime.ts) so a Wasm-owned primitive arrives as its JS
   value (bool variants untouched). runtime.ts is net 0 lines.

Guards (base = upstream/main @ fcb3ed03e7, which already contains S1):

| guard | before | after |
| --- | --- | --- |
| 4396 byte identity | green | green |
| 4397 with `JS2WASM_NATIVE_REGIME_JS=1` | 18 red / 12 green | 4 red / 26 green |
| `JS2WASM_NATIVE_REGIME_JS=1 check:host-import-policy` | red (`__boundary_callback_call_1 … missing`) | red, same error (S2) |
| 321-row sample | 219 / 321 | 219 / 321 |
| `language/statements/async-function/` native-first sample | 31 / 74 | 65 / 74 |
| `tests/issue-6685.test.ts` (+1 `print(any)` test) + #3469/#6671 | — | 26/26 green |
