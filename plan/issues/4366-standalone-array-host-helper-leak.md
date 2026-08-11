---
id: 4366
title: "standalone: array host-helper leak (`__js_array_new`/`__js_array_push`/`__array_concat_any`) — 542 tests, 195 already pass in the host lane"
status: ready
sprint: current
created: 2026-08-11
updated: 2026-08-11
priority: high
horizon: l
feasibility: medium
reasoning_effort: high
task_type: feature
area: codegen
language_feature: array, typed-array
goal: standalone-mode
related: [1781, 2860, 2961, 1472, 1094]
origin: "2026-08-11 /harvest-errors of loopdive/js2wasm-baselines test262-standalone-current.jsonl (run 20260811-103533, gitHash 9268d5a5)"
---

# #4366 — the array runtime still routes through JS host imports in standalone mode

## TL;DR

**542 official failing tests** in the **standalone** lane are refused by the
#2961 strict leak scan because codegen emitted array host imports:

```
standalone target emitted host imports: env::__array_concat_any,
  env::__js_array_new, env::__js_array_push (#2961)
```

**195 of the 542 already pass in the default (JS-host) lane**, so they are
directly recoverable by giving these three helpers a Wasm-native lowering — this
is the largest single recoverable block in the standalone lane.

## Evidence

Source: `test262-standalone-current.jsonl` from `loopdive/js2wasm-baselines`,
run `20260811-103533` (gitHash `9268d5a5`).

Leaked imports across the bucket:

| Import | Records |
|---|---|
| `env::__js_array_new` | 542 |
| `env::__array_concat_any` | 532 |
| `env::__js_array_push` | 530 |
| `env::__tagged_template` | 10 |
| `env::Uint8ClampedArray_{sort,keys,values,entries}` | 19 |

The three core helpers co-occur in almost every record — they are one lowering
path, not three independent gaps.

By directory:

| Directory | Count |
|---|---|
| `built-ins/TypedArray/prototype` | 316 |
| `built-ins/Array/prototype` | 97 |
| `built-ins/TypedArrayConstructors/internals` | 66 |
| `built-ins/TypedArrayConstructors/ctors` + `ctors-bigint` | 20 |
| `language/module-code/top-level-await` | 9 |
| other | 34 |

Cross-lane split:

| | Count |
|---|---|
| Pass in host lane → **recoverable here** | **195** |
| Fail in both lanes (needs a separate semantic fix) | 347 |

Samples:

- `test262/test/built-ins/Array/prototype/find/resizable-buffer.js`
- `test262/test/built-ins/Array/prototype/concat/S15.4.4.4_A1_T1.js`
- `test262/test/built-ins/TypedArray/prototype/reverse/prop-desc.js`
- `test262/test/built-ins/TypedArray/prototype/some/length.js`

## Context

This is the **largest leak family in the standalone lane after generators**. Of
the 2,607 records citing #2961, the array-helper set is 542; the generator
family (`__gen_*`, `__create_generator`, `__create_async_generator`) is the
other large block and is already owned by **#680** / **#2864**.

`__js_array_new` / `__js_array_push` / `__array_concat_any` are the JS-host
fast path from the era of **#1094** (`shrink-runtime-ts-host-boundary`). Per the
project's dual-mode principle, they need a WasmGC-native counterpart selected
under `--target standalone` / `--no-host-imports`.

## Implementation direction

The three helpers are a small, well-defined surface:

- `__js_array_new` — allocate a growable JS-visible array
- `__js_array_push` — append, growing as needed
- `__array_concat_any` — concat with spreadable/any-element handling

A WasmGC-native array object with a backing `(array (ref null any))` plus
length/capacity fields covers all three. The `Uint8ClampedArray_*` and
`__tagged_template` leaks (29 records) ride along in the same tests but are
separate, much smaller gaps — split them out rather than growing this issue.

## Acceptance criteria

- [ ] `--target standalone` emits no `env::__js_array_new`,
      `env::__js_array_push`, or `env::__array_concat_any` import.
- [ ] The #2961 leak scan for this import set reports 0.
- [ ] Standalone pass count rises by roughly the 195 host-lane-passing files;
      report the measured delta (not the estimate).
- [ ] No default-lane regression — the host fast path stays available in JS-host
      mode.
- [ ] The 347 fail-in-both files are re-measured and their residual errors
      bucketed to follow-up issues.

## Notes

Deliberately scoped to the array-helper set only. Do **not** fold in the
generator leak family (#680/#2864), the `SharedArrayBuffer_new` leak (425
records — see #3178/#1354), or the `Promise_*` leaks (#3178); they are separate
lowering problems with separate owners.
