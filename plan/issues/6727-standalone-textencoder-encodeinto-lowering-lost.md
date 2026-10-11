---
id: 6727
title: "standalone/WASI: `TextEncoder#encodeInto` has no native lowering — `written`/`read` read 0 and the destination is untouched (#1780 regressed)"
status: ready
sprint: current
created: 2026-09-28
updated: 2026-09-28
priority: low
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: standalone
requested_by: ttraenkler/sendev-standalone
related: [1780, 3110, 3263, 6714]
---

# #6727 — `TextEncoder#encodeInto` native lowering is gone

## What you will see

`tests/issue-1780.test.ts` fails 8/8 on main (2026-09-28, `2e23e49fb1`), for
both `standalone` and `wasi`:

```js
export function test() {
  const d = new Uint8Array(10);
  const r = new TextEncoder().encodeInto("ABé", d);
  return r.written * 100 + d[2]; // expected 4*100 + 0xc3 = 595, got 0
}
```

The module compiles and validates; `r.written`/`r.read` read the `f64.const 0`
fallback in `property-access-dispatch.ts` (#1780 block, "Receiver didn't lower
to the result struct") and nothing is written into `d`.

## Cause

The `__textencoder_encode_into_<destElemKey>` helper (`ensureEncodeIntoHelper`)
was deleted by #3110's dead-export sweep because it had zero call sites — the
dispatch arm in the call lowering that used to reach it had already been lost.
#3110 recorded that `issue-1780` failed identically before and after, so the
regression predates it. #1780 is still `status: done`.

## Fix direction

Restore a native `encodeInto(str, u8)` arm next to the `encode`/`decode` arms
in `call-receiver-method.ts` (standalone/WASI, `nativeStrings`). Since #6714
the encoder's carrier is `typedArrayVecStorage(ctx, "Uint8Array")`, which is
the packed `$__vec_i8_byte`. Return the `TextEncoderEncodeIntoResult` struct
(`ensureEncodeIntoResultStruct` in `text-encoding-native.ts`, still live). The
deleted helper's body is at `git show b56f0879d5^:src/codegen/native-strings.ts`.
Acceptance: `tests/issue-1780.test.ts` 8/8.
