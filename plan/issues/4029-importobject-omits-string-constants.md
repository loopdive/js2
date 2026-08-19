---
horizon: s
id: 4029
title: "result.importObject is empty when a module has zero function imports but a non-empty string pool"
status: done
created: 2026-08-01
updated: 2026-08-18
completed: 2026-08-01
assignee: ttraenkler/claude
priority: high
feasibility: easy
reasoning_effort: low
task_type: bug
area: compiler, runtime
language_feature: multi-module-compilation
goal: npm-library-support
sprint: 78
es_edition: n/a
related: [1712, 4001, 4018]
---

# #4029 — `importObject` drops `string_constants` on zero-function-import modules

## Problem

A compiled module cannot be instantiated through the convenience
`result.importObject` path:

```text
TypeError: WebAssembly.instantiate(): Import #0 module="string_constants":
module is not an object or function
```

This is why **`tests/multi-file.test.ts` is 9 failed / 1 passed on a clean
checkout of `main`** — it is not a new regression, and it has been masking that
file's real coverage.

## Root cause

`withImportObject` (`src/index.ts`) short-circuits:

```ts
if (!result.success || result.imports.length === 0) {
  cached = {};
  return cached;
}
```

`result.imports` counts **function** imports only. A module with no host
function imports can still declare **imported string-constant globals**, which
are built from `result.stringPool`. Measured on a two-file graph whose only
content is `add(a, b)`:

```text
success true   imports 0   stringPool 4
importObject keys: []
module declares: [ 'string_constants' ]
string_constants names: [ 'add', '', './math', 'run' ]
```

Zero function imports, four string constants, empty import object — so the
short-circuit's premise ("zero-import output needs no host runtime") is false
whenever the string pool is non-empty.

## Fix

Gate the short-circuit on both: take it only when `result.imports.length === 0`
**and** `result.stringPool.length === 0`. `buildImportsRuntime` already accepts
an empty import list and builds `string_constants` from the pool.

## Acceptance criteria

- A multi-file module with zero function imports and a non-empty string pool
  instantiates directly from `result.importObject`.
- `tests/multi-file.test.ts` stops failing for this reason. Any residual failure
  in that file is a genuine, separately-tracked defect and must be reported as
  such rather than folded in here.
- A module that genuinely needs no imports at all (standalone / WASI) still gets
  the cheap empty object — no host runtime construction on that path.

## Fix (2026-08-01)

The short-circuit now requires `result.imports.length === 0` **and**
`result.stringPool.length === 0`.

`tests/multi-file.test.ts` also stopped hand-rolling `{ env: { console_log_* } }`
and instantiates through `result.importObject`. That hand-rolled object was the
file's own second bug: it declared no `string_constants` namespace, so the rungs
failed at instantiation even after the compiler side was correct. The file now
exercises the real public path.

## Verification

- Two-file `add(a, b)` graph: `importObject` keys go from `[]` to
  `['env', 'wasm:js-string', 'string_constants']`.
- `tests/multi-file.test.ts`: **9 failed / 1 passed -> 10 passed**. These were
  genuinely broken, not vacuous — they asserted real values and never reached
  them.
