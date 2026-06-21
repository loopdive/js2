---
id: 2195
title: "Compile .js native-messaging host under --target wasi (any-typed template span + process TS2580)"
status: done
sprint: Backlog
completed: 2026-06-18
feasibility: easy
---

# #2195 — compile the `.js` native-messaging host under `--target wasi`

External bug report: loopdive/js2#389 (comment 4742274344), reported by
guest271314 on 2026-06-18. Compiling the Native Messaging host example as a
**`.js`** file (not the shipped `.ts`) under `--target wasi` failed.

The shipped `.ts` example (`examples/native-messaging/nm_js2wasm.ts`) already
compiles clean — only the `.js`-with-untyped-params path was broken.

## Root cause

Compiling a `.js` file gives untyped params, which the TS checker infers as
`any`. Two consequences under `--target wasi`:

1. **Fatal blocker:** a numeric template-literal substitution on an `any`-typed
   value aborted with `error: Template literal numeric substitution requires
   number_toString` and emitted no wasm. The `primitiveNeeded` pre-pass in
   `src/codegen/declarations.ts` keys on the checker type (`isNumberType()`),
   which is `false` for `any`, so `number_toString` was never registered — but
   codegen independently lowers the value as numeric (f64) and hits the numeric
   substitution branch in `src/codegen/string-ops.ts` (~line 513) with no helper
   to call.

2. **Misleading noise:** `process` raised TS2580 ("Cannot find name 'process'.
   Do you need to install type definitions for node?") at *error* severity, even
   though `process` is supported natively under WASI
   (`src/codegen/node-process-api.ts`). It doesn't block compilation, but it's
   alarming and was shown in the tester's failed-build output. Only plain `2304`
   was in `DOWNGRADE_DIAG_CODES`, not `2580`.

## Fix

- `src/codegen/declarations.ts` — the template-expression `primitiveNeeded`
  pre-pass now also registers `number_toString` when the span type is
  `any`/`unknown` (checker can't narrow but codegen still lowers the value as a
  numeric f64/i32/i64). Harmless when the span turns out non-numeric — codegen
  only calls the helper on the numeric branch.
- `src/compiler/import-manifest.ts` — added `2580` (node type-def hint) and
  `2591` (web-worker type-def hint) to `DOWNGRADE_DIAG_CODES` so globals codegen
  supports natively are downgraded from error to warning.

## Acceptance

`tests/issue-2195-js-mode-template-process.test.ts`:

1. A `.js` file with an untyped numeric template span compiles successfully under
   `--target wasi` (no `number_toString` abort, no `error`-severity diagnostics).
2. The `process` TS2580 diagnostic is present but downgraded to `warning`, not
   `error`.

Both pass. The existing template (`issue-2176`) and native-messaging
(`issue-1530`, incl. the #389 round-trip cases) suites remain green.
