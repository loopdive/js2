---
id: 2500
title: "Wasm-native decodeURI / encodeURI / decodeURIComponent / encodeURIComponent (percent-encoding, ~133 test262)"
status: done
assignee: ttraenkler/sd5
sprint: 64
created: 2026-06-19
updated: 2026-06-19
completed: 2026-06-19
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

# #2500 — Wasm-native URI percent-encoding

## Problem

`decodeURI` / `decodeURIComponent` / `encodeURI` / `encodeURIComponent` are
dispatched to **host imports** (`env.decodeURI` etc., `calls.ts:8892` +
`declarations.ts:504`). Under `--target standalone`/`wasi` there is no JS host,
so each leaks an unsatisfiable `env.*` import → instantiation failure. ~133
test262 `built-ins/{decodeURI,encodeURI,...}` fail.

Per the dual-mode invariant these need a **pure-Wasm** implementation (no host),
following the #679/#682 native-backend pattern.

**Supersedes #863** (`863-decodeuri-encodeuri-failures-0-0.md`, `status: done`):
that issue tracked the multi-byte UTF-8 handling in the **host-import** decodeURI/
encodeURI path. #2500 is the standalone-native re-implementation (no host) — the
single tracker for the percent-encoding family going forward. (Not renumbered to
#863 to avoid churn; cross-linked instead.)

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

**Infra finding (sd3, verified):** the existing `__str_to_utf8` /
`__str_utf8_to_flat` transcoders are gated on `--utf8-storage` and are NOT
emitted in the default standalone build (the native string is the i16 / UTF-16
`$NativeString`). So `__uri_encode` must do the UTF-16→UTF-8 transcode **inline**
(decode surrogate pairs from the flattened i16 buffer, emit 1-4 UTF-8 bytes per
code point) rather than calling `__str_to_utf8`; `__uri_decode` likewise
reassembles UTF-8 bytes → code point → UTF-16 code unit(s) inline. The reusable
primitives that ARE always present in nativeStrings mode: `__str_flatten` (get
the contiguous i16 data array + len), `__str_concat`, and the string-builder
(`array.new_default` over `nativeStrDataTypeIdx` → wrap in `$NativeString`).
Closest structural template: `parse-number-native.ts` (`emitNativeParseNumber`)
— a two-pass scan over the flattened i16 buffer. **(S1/S2 confirm this: the
shipped `__uri_encode` does exactly the inline UTF-16→UTF-8 transcode from the
`__str_flatten` i16 buffer + `array.new_default` builder — no `__str_to_utf8`.)**

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

## Progress

**ALL SLICES DONE (sd5, 2026-06-19).** S1+S2 (encode) and S3+S4 (decode) ship
together in the `issue-2500-uri-percent-encoding` branch / PR #1743:

- **S1+S2 — `__uri_encode(s, preservedMask)`** (§19.2.6.5 Encode):
  `encodeURIComponent` and `encodeURI` share one helper, differing only by the
  mask (`encodeURIComponent = 0b01`, `encodeURI = 0b11`).
- **S3+S4 — `__uri_decode(s, reservedMask)`** (§19.2.6.4 Decode): `decodeURI`
  and `decodeURIComponent` share one helper, differing only by the reserved mask
  (`decodeURI = 0b1` keeps the `reservedURISet` escaped; `decodeURIComponent =
  0b0` unescapes everything). `%XX` → UTF-8 leading-byte length → continuation
  `%XX` octets → code-point reassembly → UTF-16 re-encode (surrogate pair for
  astral); the decodeURI reserved char re-emits its ORIGINAL source escape
  verbatim; URIError on every malformed class.

All in `src/codegen/uri-encoding-native.ts`; wired at the declarations URI
finalize (`src/codegen/declarations.ts`) under `ctx.wasi || ctx.standalone`,
routed at the call site (`src/codegen/expressions/calls.ts`) with the
per-function mask. Host mode is unchanged (all four still `env.*` imports).

## Test Results

`tests/issue-2500-uri-encoding.test.ts` — both tests green (37 encode+decode
cases). Standalone module compiled with `target: "wasi"`, instantiated with an
**empty import object** (proving no host); exports return numbers
(`.length`/`.charCodeAt`) so results read back without a string-marshaling host.
Verified:

**Encode:**

- ASCII passthrough + percent-encoding (`encodeURIComponent("a b&c")` →
  `a%20b%26c`), all `uriUnescaped` marks + alphanumerics preserved, reserved
  chars escaped by `encodeURIComponent` but preserved by `encodeURI`.
- Multi-byte UTF-8: 2-byte (`©` → `%C2%A9`), 3-byte (`€` → `%E2%82%AC`), 4-byte
  astral (`😀` D83D DE00 → `%F0%9F%98%80`).
- URIError on unpaired surrogates (lone high, lone low, high-then-ASCII).

**Decode:**

- `%XX` unescaping, verbatim non-`%` passthrough, lowercase-hex digits.
- Multi-byte reassembly: 2/3/4-byte → correct code point / surrogate pair.
- decodeURI keeps `reservedURISet` escaped (re-emits the original chars, so
  lowercase `%2f` stays `%2f`); decodeURIComponent unescapes the same.
- Round-trip `decodeURIComponent(encodeURIComponent(x)) === x` (incl. astral).
- URIError on all malformed classes: `%`/`%A`/`%GG` (truncated/non-hex), bad
  continuation (`%E2%28`), missing continuation (`%E2%82`), overlong (`%C0%80`),
  out-of-range leader (`%F5…`), surrogate encoding (`%ED%A0%80`).

Verified char-by-char against host JS `decodeURI`/`decodeURIComponent`.

## Source

#2376 jsonl sweep, sd3, 2026-06-19. Routed by tech-lead from the
percent-encoding family (the largest bounded standalone-feature cluster).
S1/S2 implemented by sd5.
