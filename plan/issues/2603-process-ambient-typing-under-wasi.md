---
id: 2603
title: "`--emulate node` flag: opt-in ambient `process` typing (and warn to add it otherwise)"
status: done
sprint: Backlog
created: 2026-06-22
updated: 2026-06-22
completed: 2026-06-22
priority: medium
feasibility: easy
reasoning_effort: medium
task_type: feature
area: checker
language_feature: node-host-apis
goal: standalone-mode
related: [2523, 2524, 1717, 389]
---

## Problem

Compiling a host that uses the global `process` (e.g. a bundled Native Messaging
host, loopdive/js2#389) emits a TS2580 warning per use:

```
warning: Cannot find name 'process'. Do you need to install type definitions for node? Try `npm i --save-dev @types/node`.
```

`process` has no ambient declaration (we serve only the TS lib files, not
`@types/node`), even though the compiler **already lowers** `process.std{in,out,err}`,
`argv`, `env`, `exit` for WASI (`node-process-api.ts`).

## Fix — an explicit opt-in flag, not a default

Add **`--emulate node`** (CompileOptions `emulateNode`). It is **off by default**.

- **With `--emulate node`**: the checker is served a synthetic ambient `process`
  `.d.ts` (`src/checker/index.ts`, `AnalyzeOptions.emulateNode`) declaring the
  lowered surface, so `process` type-checks and the TS2580 warnings disappear.
  **Dup-safe**: if the user already declares `process` (as the example
  `nm_js2wasm.ts` does), the build detects the duplicate-identifier diagnostic
  and rebuilds without injection — never a hard error.
- **Without the flag**: the TS2580 message is rewritten to **suggest the flag** —
  `Cannot find name 'process'. Add `--emulate node` to enable Node API emulation
  (or install @types/node).` — in both warning-emitting paths (`compiler.ts`,
  `compiler/output.ts`).

CLI: `--emulate <env>` (currently `node`; extensible to deno/etc.). Threaded as
`emulateNode: options.emulateNode`.

**Type-level only** — emitted wasm is byte-identical (md5-verified). Codegen
lowers `process.*` syntactically regardless of this declaration.

## Verification

- Bundled JS host (`esbuild … | --target wasi`, the #389 case): **without**
  `--emulate node` → 5 warnings, each suggesting the flag; **with** it → **0**
  warnings.
- The `.ts` host (declares its own `process`) → no warning, no dup error.
- `tests/issue-2603-process-ambient-typing.test.ts` (6 tests): resolves with
  emulateNode; still flags without it; undefined names still warn; user-declared
  `process` → no dup; the unflagged warning suggests `--emulate node`; the
  flagged compile emits no `process` warning.

## Notes

Stakeholder steer (loopdive/js2#389): node emulation must be an **explicit
`--emulate node` opt-in**, not implied by `--target wasi`, and the unflagged
warning should point at the flag. Pairs with #2523 (web vs node target) and
#2524 (node-io shim). The incremental `IncrementalLanguageService` path
(playground/tests, not the CLI) does not yet inject — follow-up if needed.
Only `process` is declared today; other Node globals (`Buffer`, …) can extend
the ambient surface later.
