---
id: 7024
title: "standalone: stylelint's standalone-dynamic lane fails Wasm validation in Root_toResult (call[0] expected (ref null N), found ref.null of (ref null 2))"
status: ready
sprint: current
created: 2026-10-16
updated: 2026-10-16
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: npm-compat, standalone, codegen
goal: standalone
requested_by: ttraenkler/wave14-three-stylelint-leaks
related: [6843, 7023, 6746, 7015, 4287]
---

# #7024 — stylelint standalone-dynamic: the blocker after #6843

## Problem

These were measured on 2026-10-16 on upstream/main `ee58c1aa26` plus #6843.

**Lane run.** The command was
`npx tsx scripts/generate-npm-compat-report.mjs --only stylelint --no-write --perf-only --lane standalone-dynamic`.
It runs in-process with no budget. Codegen took 2,186 s at load 160–450 on
8 cores; the timing is not comparable across runs on a box this loaded. The
lane fails with:

```
emitted WebAssembly failed validation — WebAssembly.Module(): Compiling function
"Root_toResult" failed: call[0] expected type (ref null 13), found ref.null of type (ref null 2)
```

The validation error is already on the parent. The parent's lane record shows
the warning `Unsupported new expression for class: String` instead, because
`firstCompileDiagnostic` reported the first diagnostic of any severity; #6843
makes it prefer an error.

**Direct compile.** The same driver compiled directly with `compileProject`
(lane options, at load ~40) took 257 s of codegen. After the validation error
it still retains 25 `env.*` imports, down from 46 on the parent:

| Imports | Tracked by |
| --- | --- |
| 15 `env.__node_*` module objects (`path`, `os`, `process`, `tty`, `util`, `buffer`, `fs`, `crypto`, `events`, `stream`, `child_process`, `url`, `fs/promises`, `assert`, `module`) | #6746 |
| `SubtleCrypto_digest`, `Crypto_get_subtle` | #6746 |
| `AbortController_new`, `AbortController_abort` | #6746 |
| `__js_array_new`, `__js_array_push` | #6746 |
| `__get_process_cwd`, `Promise_all`, `__get_localStorage`, `__get_filename` | #6746 |

### Background: why `Root_toResult` sits behind a declaration face

`Root_toResult` is postcss's `Root.prototype.toResult`:

```js
let lazy = new LazyResult(new Processor(), this, opts)
```

On standalone, postcss's `require('./lazy-result')` and
`require('./processor')` resolve to their `.d.ts` faces (#7023). Since #6843
those classes are no longer extern classes, so this call site constructs from
declaration-only bindings. The `ref.null` of the wrong heap type is probably
how an argument is defaulted when the callee's parameter type is a struct of
another class.

When #7023 lands, the real `lib/*.js` bodies are compiled instead. The
blocker then moves: postcss alone fails with
`LazyResult_async: extern.convert_any[0] expected anyref, found externref`,
which is the same class as three's #7015.

## Implementation Plan

To be written.

- Reproduce on postcss alone, by compiling `postcss.parse(...)` through
  `compileProject` on standalone, and find out which argument emits the
  mistyped `ref.null`.
- Fix the default-argument and coercion path so that a missing or unknown
  argument of a struct-typed parameter is emitted as `ref.null` of that
  parameter's heap type.
