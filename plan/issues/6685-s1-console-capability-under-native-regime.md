---
id: 6685
title: "S1: console/print lowers to the platform capability in a JS environment under the native regime"
status: in-progress
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

- [ ] `tests/issue-4396-target-profile.test.ts` byte-identity test green: default
      `gc`, `standalone`, `wasi` output unchanged.
- [ ] `JS2WASM_NATIVE_REGIME_JS=1 npx vitest run tests/issue-4397-native-semantic-js-host.test.ts`
      — the "selects native strings…" test passes; the other failures do not
      grow (before: 10 red, of which "parse and URI string globals" is
      pre-existing on main).
- [ ] `JS2WASM_NATIVE_REGIME_JS=1 pnpm run check:host-import-policy` green.
- [ ] 321-row sample (`JS2WASM_EVAL_ENGINE=interpreter TEST262_SEMANTIC_PROVIDERS=native-first TEST262_PATH_FILTER="built-ins/Object/keys/|built-ins/Array/prototype/map/|language/expressions/class/accessor" TEST262_WORKERS=2 pnpm run test:262`)
      ≥ 218 / 321; record the number in the PR.
- [ ] A focused test proves a regime JS build of an async test262-shaped
      program (`$DONE` via `console.log("Test262:AsyncTestComplete")`) reports
      the marker through the console capability, and a standalone build still
      reports it through `__stdout_*`.
- [ ] Standalone/WASI targets: no import or export change (assert in the
      focused test).
