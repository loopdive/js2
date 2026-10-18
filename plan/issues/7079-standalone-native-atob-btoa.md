---
id: 7079
title: "standalone: `atob` / `btoa` are retained as `env.atob` / `env.btoa` host imports — every module that reaches hono `utils/encode` is not instantiable"
status: done
sprint: current
created: 2026-10-18
updated: 2026-10-18
completed: 2026-10-18
assignee: ttraenkler/wave17-hono-residual
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: compiler
goal: standalone-gap
language_feature: web-apis, strings
related: [7013, 3064]
loc-budget-allow:
  # 2026-10-18 (#7079) import-collector.ts +7 and extern-declarations.ts +4: the
  #   two names join the existing escape/unescape native family (collect + skip the
  #   ambient stub); the helpers themselves live in the new helpers/base64-native.ts.
  - src/codegen/declarations/import-collector.ts
  - src/codegen/extern-declarations.ts
func-budget-allow:
  # 2026-10-18 (#7079) collect (+6) and finalize (+2) arms of the escape family.
  - src/codegen/declarations/import-collector.ts::unifiedVisitNode
  - src/codegen/declarations/import-collector.ts::finalizeUnifiedCollector
---

# Host-free `atob` / `btoa`

hono `utils/encode` (44 tests), `utils/basic-auth` (6) and the cookie/testing
files retained `env.atob`/`env.btoa` (the ambient lib declarations become host
imports once a lib global drags the names into the referenced set), so the
standalone binaries failed to instantiate.

## Implementation Plan

Mirror Annex B `escape`/`unescape` (#3064):
- `helpers/base64-native.ts`: `__btoa` / `__atob` as defined Wasm functions over
  native strings. `btoa`: reject a code unit > 0xFF, standard alphabet + `=`
  padding. `atob`: WHATWG forgiving-base64 decode in one pass (whitespace
  removed, `=` only as 1–2 trailing units completing a multiple of 4, length ≡
  1 mod 4 rejected, bit accumulator yields ⌊6m/8⌋ bytes). Rejection answers
  `null`; no late imports or string constants inside the helpers (they are
  emitted from the import-collector finalize).
- `import-collector.ts`: collect the two names into `escapeNeeded` on
  standalone/wasi only; finalize emits the helpers.
- `extern-declarations.ts`: skip the ambient stub on standalone/wasi.
- `annexb-escape-call.ts`: route the calls (ToString of the argument, Symbol
  TypeError) and turn a `null` result into the throw (`InvalidCharacterError`);
  zero arguments is the WebIDL TypeError.

## Resolution

Implemented. The JS-host lane is unchanged (both new names are gated on
standalone/wasi). hono `utils/encode` now instantiates (0/44 → 2/44); its
remaining 42 are TypedArray representation gaps (`view.buffer` of a native
TypedArray is a zero-filled copy, a function returning a buffer-backed view
through a `Uint8Array`-typed slot loses its contents) — recorded as residuals.
