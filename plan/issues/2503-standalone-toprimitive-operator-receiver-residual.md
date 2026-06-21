---
id: 2503
title: "standalone ToPrimitive residual (successor to #1910): 2,835 `Cannot convert object to primitive value` on ==/+/array-literal/destructuring receivers"
status: ready
sprint: Backlog
created: 2026-06-19
updated: 2026-06-19
priority: critical
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: codegen, runtime
language_feature: to-primitive, operators, destructuring
goal: standalone-mode
parent: 1781
related: [1910, 1525, 1525b, 1716, 1806, 1090, 1253, 1319, 1781]
test262_bucket: standalone-object-to-primitive
test262_count: 2835
origin: "2026-06-19 /harvest-errors on run e9579720 (2026-06-18): the standalone `Cannot convert object to primitive value` bucket grew 784 (#1910) / 1,292 (2026-06-10 gap review) -> 2,835, and is now the single largest standalone runtime-failure bucket. Every historical owner (#1090, #1253, #1319, #1525, #1525b, #1716, #1806, #1910) is `done`, so the residual is currently untracked by any open issue."
---

# #2503 — Standalone ToPrimitive residual on operator / destructuring receivers

## Problem

In the standalone lane (`--target standalone --no-host-imports`,
`nativeStrings`), **2,835** official test262 records fail at runtime with
`Cannot convert object to primitive value` — the single largest standalone
runtime-failure bucket as of run `e9579720` (2026-06-18):

| signature | records |
|---|---|
| `runtime_error: Cannot convert object to primitive value` | 1,612 |
| `runtime_error: L#:## Cannot convert object to primitive value` | 1,223 |
| **total** | **2,835** |

This is a genuine runtime throw produced by the emitted Wasm (not a classifier
over-match, and not the eager-throw *spec* behaviour #1525 implemented): the
standalone native `ToPrimitive` path is not wired for ordinary-object receivers
reached through core operators and binding forms. Default (JS-host) lane is
healthy here — only **48** records — so the host import is masking the gap.

## Why this is untracked

All historical owners are `done`:

- `#1525` / `#1525b` — eager-throw on object args + method trampoline / step-6.
- `#1806` / `#1900` — standalone native ToPrimitive slices.
- `#1716` — residual object property-key coercion.
- `#1090` / `#1253` / `#1319` — ToPrimitive / OrdinaryToPrimitive / Symbol.toPrimitive.
- `#1910` — "standalone ToPrimitive residual bucket after #1900/#1525b"
  (recorded count `784`; the 2026-06-10 gap review measured `1,292`).

The bucket has since **grown to 2,835** with no open owner. This issue is the
current successor (the same way #1910 succeeded #1900/#1525b).

## Sample failures (core paths, not edge cases)

```
test/language/expressions/equals/S11.9.1_A7.7.js                       # ==  (abstract equality)
test/language/expressions/addition/order-of-evaluation.js              # +   (ToPrimitive order)
test/language/expressions/array/S11.1.4_A1.4.js                        # array literal element coercion
test/language/expressions/arrow-function/dstr/ary-ptrn-elem-ary-empty-init.js   # destructuring default init
test/language/expressions/object/dstr/gen-meth-dflt-obj-ptrn-rest-skip-non-enumerable.js
```

The clustering on `==`, `+`, array-literal evaluation, and destructuring
defaults points at the operator/binding lowering invoking `ToPrimitive` on an
object receiver without routing through the standalone native
`OrdinaryToPrimitive` (valueOf / toString / @@toPrimitive) closure.

## Suggested approach

1. Reproduce a minimal case per cluster (`({}) == 1`, `({}) + ""`,
   `[{}]`-with-default-dstr) under `--target standalone` and capture which
   lowering site emits the throwing path.
2. Confirm whether the native `ToPrimitive` trampoline (#1525b) is reachable
   from the operator/dstr paths, or whether those paths short-circuit to a
   generic "not a primitive → throw" before consulting valueOf/toString.
3. Wire the missing call sites to the existing native ToPrimitive closure;
   add scoped equivalence tests for ==, +, array-literal, and destructuring
   defaults over object receivers in standalone mode.
4. Re-measure the bucket; split any genuinely-distinct residual (Date,
   template, RegExp coercion) into separate child records if it does not fall
   to ~0.

## Acceptance criteria

- The standalone `Cannot convert object to primitive value` bucket drops
  substantially from 2,835 (target: operator/dstr clusters → ~0).
- Scoped standalone equivalence tests cover `==`, `+`, array-literal, and
  destructuring-default object receivers.
- Default (JS-host) lane unchanged (no regression from the 48 baseline).
