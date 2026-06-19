---
id: 2378
title: "Wasm-native decodeURI / encodeURI / decodeURIComponent / encodeURIComponent (percent-encoding, ~133 test262)"
status: in-progress
assignee: ttraenkler/sd3
sprint: 64
created: 2026-06-19
updated: 2026-06-19
priority: medium
feasibility: medium
reasoning_effort: high
task_type: feature
area: codegen
language_feature: global-functions
goal: standalone-mode
test262_bucket: uri-encoding
test262_count: 133
---

# #2378 — Wasm-native URI percent-encoding

## Problem

`decodeURI` / `decodeURIComponent` / `encodeURI` / `encodeURIComponent` are
dispatched to **host imports** (`env.decodeURI` etc., `calls.ts:8892` +
`declarations.ts:504`). Under `--target standalone`/`wasi` there is no JS host,
so each leaks an unsatisfiable `env.*` import → instantiation failure. ~133
test262 `built-ins/{decodeURI,encodeURI,...}` fail.

Per the dual-mode invariant these need a **pure-Wasm** implementation (no host),
following the #679/#682 native-backend pattern.

## Spec (ECMAScript §19.2.6)

- **Encode** (§19.2.6.5 Encode): for each code point of the input string, if it
  is in the *preserved set* emit it verbatim; otherwise UTF-8-encode it and emit
  `%XX` (uppercase hex) per byte. Unpaired surrogate → **URIError**.
  - `encodeURIComponent` preserved set (`uriUnescaped`):
    `A-Z a-z 0-9 - _ . ! ~ * ' ( )`.
  - `encodeURI` preserved set = `uriUnescaped` ∪ `uriReserved` ∪ `#`:
    adds `; / ? : @ & = + $ , #`.
- **Decode** (§19.2.6.4 Decode): scan; on `%`, read two hex digits → a byte,
  validate UTF-8 multi-byte sequences (leading byte → N continuation `%XX`),
  reassemble the code point; a non-preserved-on-decode reserved char that was
  escaped stays escaped for `decodeURI` (reservedSet) but is unescaped for
  `decodeURIComponent` (empty reserved set). Malformed (`%` not followed by two
  hex digits / bad continuation / overlong / out-of-range) → **URIError**.
  - `decodeURIComponent` reserved set = empty.
  - `decodeURI` reserved set = `; / ? : @ & = + $ , #` (kept escaped).

## Implementation plan

Native string-engine helpers (mirror `__str_to_number` / `emitNativeParseNumber`
in `any-helpers.ts`), registered once and called from the four call sites:

1. **`__uri_encode(str: externref, preservedMask: i32) → externref`** — iterate
   the input's UTF-16 code units, decode surrogate pairs to code points
   (URIError on lone surrogate), UTF-8-encode each code point to 1-4 bytes,
   and for each byte either pass through (if a single-byte ASCII code point in
   the preserved set, keyed by `preservedMask`) or append `%` + 2 uppercase hex
   digits. Build the result as a native string. `preservedMask` distinguishes
   the encodeURI vs encodeURIComponent preserved sets (a small bitset/range
   check helper).
2. **`__uri_decode(str: externref, reservedMask: i32) → externref`** — scan code
   units; on `%`, parse 2 hex digits → byte, determine UTF-8 length from the
   leading byte, parse the continuation `%XX`s, validate + reassemble the code
   point, re-encode to UTF-16 (surrogate pair if > 0xFFFF). A decoded char in
   the reserved set (for decodeURI) is re-emitted as the original `%XX` escape
   verbatim. Malformed → URIError.
3. **URIError** — emit a catchable URIError instance (reuse
   `emitWasiErrorConstructor("URIError", 1)` / the shared brand-throw helper),
   not a trap.
4. **Call sites** (`calls.ts:8892`): when `noJsHost(ctx)` (or always, with the
   host import as the fast path otherwise), route to the native helper with the
   per-function preserved/reserved mask instead of the env import.

### Slices
- S1: `encodeURIComponent` (smallest preserved set, ASCII-only fast path first,
  then full UTF-8 multi-byte). Validate against
  `built-ins/encodeURIComponent/*`.
- S2: `encodeURI` (add the reserved-set passthrough).
- S3: `decodeURIComponent` (the %XX → UTF-8 → code point reassembly + URIError).
- S4: `decodeURI` (reserved-set re-escape).

## Acceptance criteria

- `encodeURIComponent("a b&c") === "a%20b%26c"`; `encodeURI("a b/c") === "a%20b/c"`.
- `decodeURIComponent("a%20b%26c") === "a b&c"`; `decodeURI("a%20b%2Fc") === "a b%2Fc"`.
- Multi-byte: `encodeURIComponent("€") === "%E2%82%AC"`; round-trips.
- Malformed `decodeURIComponent("%")` / `"%E2%28"` throw `URIError`.
- Lone surrogate `encodeURIComponent("\uD800")` throws `URIError`.
- Standalone: no `env.{decode,encode}URI*` host import leaks.

## Source

#2376 jsonl sweep, sd3, 2026-06-19. Routed by tech-lead from the
percent-encoding family (the largest bounded standalone-feature cluster).
