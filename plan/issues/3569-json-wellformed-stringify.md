---
id: 3569
title: "Standalone JSON.stringify: well-formed surrogate escaping (lone surrogate → \\uXXXX)"
status: done
assignee: ttraenkler/agent-json-object-reflect
sprint: 76
created: 2026-07-24
updated: 2026-07-24
completed: 2026-07-24
priority: low
feasibility: easy
task_type: conformance
area: standalone
language_feature: json
goal: standalone
horizon: s
related: [1599, 2166, 2933]
---

# Standalone JSON.stringify: well-formed surrogate escaping

## Problem

Measured on the standalone lane (`run-test262-fyi.mjs --target standalone`),
`built-ins/JSON/stringify/value-string-escape-unicode.js` failed: the host-free
native codec (`__json_quote_string`, `src/codegen/json-runtime.ts`) copied every
UTF-16 code unit ≥ 0x20 verbatim, so a **lone** surrogate leaked through
unescaped.

ES2019 §25.5.4.3 `QuoteJSONString` (feature `well-formed-json-stringify`)
requires:
- a lone (unpaired) surrogate code unit U+D800–U+DFFF → escaped as `\uXXXX`;
- the two code units of a valid high+low pair → copied through verbatim.

Host (WasmGC/JS) mode delegates to the JS host `JSON.stringify` (V8 already does
this), so this only affected `--target standalone` / `--target wasi`.

## Fix

`emitJsonQuoteString` in `src/codegen/json-runtime.ts`:
- Added an `escapeSurr` predicate that classifies the code unit at `data[i]` as a
  lone surrogate (escape) vs. part of a valid pair (verbatim), using
  immediate-neighbour lookahead/lookbehind (`data[i+1]` for a high, `data[i-1]`
  for a low) bounded by the string's `[off, end)`. Both the sizing pass and the
  fill pass call it, so widths and emitted bytes stay in lock-step.
- Generalised the `\uXXXX` emitter to write all four hex nibbles with the full
  `0-9`/`a-f` mapping (the prior control-char path emitted only `\u00XX`; the top
  two nibbles are still 0 for control chars, so that output is byte-identical).

No new host imports; the fix stays entirely on the pure-Wasm codec.

## Acceptance criteria

- [x] `built-ins/JSON/stringify/value-string-escape-unicode.js` passes under
      `--target standalone`.
- [x] No standalone regression across `built-ins/JSON` (diff: exactly one
      FAIL→PASS flip, zero PASS→FAIL).
- [x] Host lane unaffected (native codec is standalone/wasi-only).
- [x] Repro added as `tests/issue-3569.test.ts`.

## Test Results

Harness: `node scripts/run-test262-fyi.mjs --target standalone` (authoritative
`test262-worker.mjs`, standalone target).

- `built-ins/JSON` standalone: **129/165 → 130/165** (+1).
- Before/after per-file diff: **1 flip, FAIL→PASS**
  (`value-string-escape-unicode.js`), **0 regressions**.
- Host lane `built-ins/JSON` (gc): 117/165 (unchanged — native codec not on the
  host path).
- `tests/issue-3569.test.ts`: 5/5 pass (lone high, lone low, valid pair verbatim,
  mixed, control-char + pair regression guard).
- `tsc --noEmit`: clean.

Note: `tests/issue-1599-runtime.test.ts > parses true and false` fails on
`origin/main` independently of this change (a JSON.**parse** boolean-unbox
value-rep gap, not touched here) — verified by reverting `json-runtime.ts` to
`origin/main` and re-running.
