---
id: 2884
title: "test262 runner stubs decimalToHexString.js harness incorrectly — false failures across encode/decode-URI"
status: done
sprint: current
priority: high
horizon: s
area: testing
language_feature: global-functions
assignee: ttraenkler/explore6
feasibility: easy
created: 2026-06-30
completed: 2026-06-30
---

## Problem

~37 test262 tests under `built-ins/{decodeURI,decodeURIComponent,encodeURI,encodeURIComponent}/`
and `harness/decimalToHexString.js` fail with a false `#…`-coded failure even
though the underlying `decodeURI`/`encodeURI` runtime behaviour is correct
(verified — those functions throw `URIError` on malformed UTF-8 / unpaired
surrogates, and `e instanceof URIError` is observed correctly through the wasm
boundary).

Root cause is in the **test262 runner harness shim**, not in the compiler or
runtime. The `decimalToHexString.js` harness (`test262/harness/decimalToHexString.js`)
`defines: [decimalToHexString, decimalToPercentHexString]`. The runner's
`buildPreamble` in `tests/test262-runner.ts` injected only a **constant stub**:

```ts
function decimalToHexString(n: number): string { return "0"; }
```

This is wrong in two ways:

1. **`decimalToPercentHexString` was never defined at all.** The encode/decode-URI
   tests build their percent-encoded **test input** with this function
   (e.g. `decodeURI(decimalToPercentHexString(0xC0) + decimalToPercentHexString(0x00))`
   = `decodeURI("%C0%00")`). With the function undefined, the input came out as
   garbage, so the spec-required `URIError` was never triggered, and the test
   recorded a false `result = false` → `errorCount > 0` →
   `throw new Test262Error('#…')`. This affected the entire `A1.*` (decode) and
   `A2.*` (encode) families.

2. **`decimalToHexString` returned a constant `"0"`.** The harness self-test
   `test/harness/decimalToHexString.js` asserts `decimalToHexString(-1) === "FFFFFFFF"`,
   `decimalToHexString(0.5) === "0000"`, `decimalToHexString(65536) === "10000"`,
   etc., which the constant stub failed.

## Spec

ECMA-262 §19.2.6.1 `decodeURI ( encodedURI )` → `Decode(encodedURI, …)`
(§19.2.6.5) throws **URIError** for malformed escape sequences and invalid
UTF-8 continuation bytes. §19.2.6.4 `encodeURI` → `Encode` throws **URIError**
for unpaired surrogate code points. The harness `decimalToHexString.js` helpers
are pure `number → string` formatters used by these tests to construct inputs
and (on failure) error messages.

## Fix

Replace the constant stub in `buildPreamble` (`tests/test262-runner.ts`) with a
faithful TypeScript port of **both** harness functions, and widen the
`needsDecimalToHex` detection to fire when a test references either
`decimalToHexString` **or** `decimalToPercentHexString`:

```ts
function decimalToHexString(n: number): string {
  const hex = "0123456789ABCDEF";
  n = n >>> 0;
  let s = "";
  while (n) { s = hex[n & 0xf] + s; n = n >>> 4; }
  while (s.length < 4) { s = "0" + s; }
  return s;
}
function decimalToPercentHexString(n: number): string {
  const hex = "0123456789ABCDEF";
  return "%" + hex[(n >> 4) & 0xf] + hex[n & 0xf];
}
```

Both compile through the standard codegen path with **no new host imports**
(verified). `decimalToHexString` is only ever called in test error-message
construction (never on the pass path) except in the harness self-test, so making
it real cannot regress a currently-passing test; the only assertion-level
consumer is the self-test, which moves fail → pass.

## Why this is a runner fix, not a compiler fix

`decodeURI`/`encodeURI`/`decodeURIComponent`/`encodeURIComponent` already behave
to spec (host imports delegate to the native global, which throws the native
`URIError`; the wasm `instanceof URIError` check resolves correctly). The sole
blocker was the runner feeding the tests a broken harness shim. No `src/` change
is required.

## Net recovery (fresh single-file processes, mirror of CI worker)

| dir                     | before fail | after fail | recovered |
| ----------------------- | ----------- | ---------- | --------- |
| decodeURI               | 15          | 3          | 12        |
| decodeURIComponent      | 16          | 4          | 12        |
| encodeURI               | 9           | 3          | 6         |
| encodeURIComponent      | 9           | 3          | 6         |
| harness/decimalToHexString | 1        | 0          | 1         |
| **total**               |             |            | **37**    |

Remaining URI failures (`A5.2` missing `.length`, `A5.7` `new X()` should throw
TypeError, `A6_T1` object-ToPrimitive, `throw-URIError` null-deref) are
**separate root causes** outside this cluster — candidate follow-up issues.

## Acceptance criteria

- `built-ins/{decodeURI,decodeURIComponent}/S15.1.3.*_A1.*_T*.js` pass.
- `built-ins/{encodeURI,encodeURIComponent}/S15.1.3.*_A2.*_T*.js` pass.
- `harness/decimalToHexString.js` passes.
- No regression in any test that includes `decimalToHexString.js`.

## Test Results

Verified via fresh single-file worker processes (TEST262_WORKER_RECYCLE_INTERVAL=1,
mirrors `scripts/test262-worker.mjs`):
- 36 URI tests fail → pass.
- `harness/decimalToHexString.js` fail → pass.
- Control `decodeURI/S15.1.3.1_A5.7.js` (separate cause) still fails — confirms
  the fix is scoped to the harness-shim cluster.
- `tests/issue-2884.test.ts` added (compiles the harness shim + exercises the
  decode/encode URIError path).
