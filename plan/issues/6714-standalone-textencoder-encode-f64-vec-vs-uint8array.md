---
id: 6714
title: "standalone: `TextEncoder.encode` returns an f64 vec, but `Uint8Array` lowers to the packed-i8 vec — invalid Wasm when the result flows through a typed slot"
status: done
completed: 2026-09-28
sprint: current
created: 2026-09-27
updated: 2026-09-28
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: standalone
requested_by: ttraenkler/sendev-standalone
related: [1032, 1752, 1780, 3150, 5349, 6699, 6727, 6728, 6732]
---

# #6714 — standalone `TextEncoder.encode` result representation mismatch (axios)

## What you will see

After [#6699](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6699-standalone-axios-globalthis-ensure-stack-underflow),
the npm-compat **axios** standalone-dynamic lane
(`npx tsx scripts/generate-npm-compat-report.mjs --only axios --no-write --perf-only --lane standalone-dynamic`,
measured 2026-09-27) stops at `optimization-error`; V8 names the function:

```
WebAssembly.Module(): Compiling function #2104:"__closure_392" failed: type error in fallthru[0] (expected (ref null 1010), got (ref null 4))
```

`__closure_392` is axios `lib/adapters/fetch.js`'s
`((encoder) => (str) => encoder.encode(str))(new TextEncoder())`.

## Minimal repro (standalone, `runtimeEvalProvider: false`)

```js
const enc = new TextEncoder();
const encodeText = (str) => enc.encode(str);
export function test() { return encodeText("abc").length; }
```

→ `__closure_0 failed: type error in fallthru[0] (expected (ref null 45), got (ref null 4))`.

## First reading

- `call-receiver-method.ts` lowers `TextEncoder#encode` to
  `__textencoder_encode` (`text-encoding-native.ts`), which returns
  `(ref null $__vec_f64)` — the pre-#3150 "Uint8Array" representation.
- The arrow's declared result is `resolveWasmType(Uint8Array)`, which is now the
  packed `i8_byte` vec (`getOrRegisterVecType(ctx, "i8_byte", { kind: "i8" })`,
  the backing `new Uint8Array` / `toHex` / `toBase64` use).
- `TextDecoder#decode` has the mirror problem (it expects the f64 vec).

Likely fix: make `__textencoder_encode` produce (and `__textdecoder_decode_u8`
consume) the `i8_byte` vec, so encode/decode agree with every other
`Uint8Array` producer; update #1780's `encodeInto` path if it shares the vec.
Not a one-line coercion at the call site: the two vec types have different
element storage.

## Implementation Plan

1. `text-encoding-native.ts`: derive the carrier from
   `typedArrayVecStorage(ctx, "Uint8Array")` (new `uint8Carrier`). It is not
   hard-wired to `i8_byte`, because `target: "gc"` + `strictNoHostImports`
   also reaches these helpers, and there `Uint8Array` is still `$__vec_f64`.
2. Packed carrier:
   - The encoder stores bytes with a bare `array.set` (packed `i8` truncates
     the value itself).
   - Its scratch buffer is `3 × UTF-16 length`, the worst case (a lone
     surrogate becomes U+FFFD, 3 bytes; a surrogate pair is 4 bytes for 2
     units).
   - The result is trimmed to the exact byte count, as `fromBase64` does, so
     `.buffer.byteLength` matches.
   - The decoder reads with `array.get_u`.
3. The `f64` carrier keeps the pre-#6714 instruction sequence. The
   storage-dependent pieces live in small top-level helpers
   (`byteStoreConversion`, `byteLoad`, `encodeScratchCapacity`,
   `trimEncodeOutput`), so `ensureTextEncodingHelpers` does not grow.
4. The callers (`call-receiver-method.ts` encode/decode arms) already use the
   returned `vecTypeIdx`, so they need no change.

## Resolution

`__textencoder_encode` now returns, and `__textdecoder_decode_u8` now accepts,
whatever `Uint8Array` lowers to. Under standalone/WASI that is the
`final`-branded packed `$__vec_i8_byte`, the same carrier as `new Uint8Array` /
`fromHex` / `fromBase64` / `toHex`. The axios
`((encoder) => (str) => encoder.encode(str))(new TextEncoder())` closure now
validates.

- Regression test: `tests/issue-6714-standalone-textencoder-u8-carrier.test.ts`.
  Parent: 4 fail / 1 pass. Fix: 5/5 pass.
- JS-host and `gc`+`strictNoHostImports`: the TextEncoder/TextDecoder probe is
  byte-identical to parent (sha256 prefixes `4e67baff4bb11af2` /
  `d5b067a7ffa97217`).
- Existing TextEncoder suites: 14 failures, the same set on parent and fix
  (`issue-1780` 8, `issue-1767` 4, `issue-2526` 2).
- axios standalone-dynamic lane:
  - Before: V8 rejects `__closure_392` (`type error in fallthru[0]`).
  - After: the raw module validates in V8 (9,216,193 B). The lane stops at
    `optimization-error`, with first stderr `wasm-opt -O4 failed: unexpected
    expr type … Flatten.cpp:231`. The #4586 `--skip-pass=flatten` retry
    succeeds by hand (valid, 3,820,273 B) but runs well past the optimizer's
    600 s timeout. Next blocker: [#6732](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6732-standalone-axios-o4-no-flatten-retry-exceeds-timeout).

Residuals, filed separately:
- #6727 (pre-existing): `encodeInto` has no native lowering, and #1780's tests
  fail on main.
- #6728 (pre-existing): a subview → vec coercion drops `byteOffset`, so
  `decode(u.subarray(1, 3))` decodes the wrong bytes.
