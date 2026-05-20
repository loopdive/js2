---
id: 1535
sprint: 52
title: "research: JS host dependency audit — identify gaps and evaluate standalone Wasm/JS replacements"
status: done
created: 2026-05-20
priority: high
feasibility: medium
reasoning_effort: high
task_type: research
area: runtime
language_feature: host-imports
goal: standalone-wasm
related: [1470, 1471, 1472, 1473, 1474]
---

# #1535 — JS host dependency audit and standalone gap research

## Problem

The compiler currently has two modes: JS-host mode (requires a JS runtime to provide host imports) and standalone Wasm mode (pure Wasm, no JS runtime). The standalone mode is incomplete — many features silently depend on JS host imports that aren't available in standalone contexts (WASI, embedded, edge compute without V8).

Issues #1470–#1474 began work on removing specific host dependencies (string ops, boxing/unboxing, property ops, error/exceptions, regex). But there's no comprehensive map of:
1. What host imports currently exist and which are mandatory vs optional
2. What Wasm-native or self-contained solutions already exist in the ecosystem
3. Which gaps are highest-priority to close

## Goal

Produce a full audit of JS host dependencies and a research report on ecosystem solutions, then file actionable issues for the highest-value standalone replacements.

## Research tasks

### 1. Audit current host imports
- Read `src/runtime.ts` — list every function exported as a host import (search for `__` prefixed exports, `resolveImport`, import registration patterns)
- Read `src/codegen/index.ts` — list every `addUnionImports` or `ensureLateImport` call that binds a JS function
- Categorize by: string ops, number/boxing, regex, collections, error/exception, crypto, I/O, timing, DOM/Web

### 2. Classify by standalone-readiness
For each category, classify:
- **Already standalone**: WasmGC handles it natively (i32, f64 arithmetic, local variables, basic control flow)
- **WasmGC string proposal**: `wasm:js-string` builtins — already in use for fast mode
- **Needs Wasm library**: regex, BigInt, complex string methods (normalize, collation)
- **Needs WASI**: I/O, random, clock, args/env
- **Inherently JS-host**: DOM APIs, fetch, localStorage

### 3. Research ecosystem solutions

For each "Needs Wasm library" gap, research and evaluate:

**Regex:**
- `wasm-re2` — RE2 compiled to Wasm (Google RE2, no backtracking)
- `oniguruma-to-es` — pure JS, no Wasm
- `regexpu-core` — transpiles ES6 regex to ES5, pure JS
- WASI-based regex from Rust `regex` crate
- Evaluate: binary size overhead, API surface, spec compliance (lookahead, named groups, Unicode)

**BigInt:**
- Current: externref to JS BigInt (host-only)
- `wasm-bignum` or similar
- Rust `num-bigint` compiled to Wasm
- Evaluate: arithmetic ops needed (add, sub, mul, div, mod, pow, bitwise, comparison), size

**String methods (normalize, localeCompare, Intl):**
- `icu4x` compiled to Wasm (Mozilla/Unicode) — comprehensive but large (~500KB)
- `full-icu` data + pure JS — too large
- Evaluate which specific methods are most-called in test262 failures

**Number formatting (toFixed, toPrecision, toExponential):**
- Current: likely host `Number.prototype.toFixed` call
- Pure Wasm implementation (Grisu3/Dragon4 algorithm)
- Evaluate: ~5KB implementation, fully standalone

**Object property operations (defineProperty, getOwnPropertyDescriptor):**
- Current: externref host calls
- WasmGC structs with descriptor tables — partial implementation possible
- Evaluate spec-completeness tradeoffs

**Error/exception types:**
- Current: `new Error(msg)` → JS externref
- WasmGC exception handling proposal (`try`/`catch`/`throw` in Wasm)
- Evaluate: Chrome 95+, Firefox 100+ support

### 4. Web search targets
Search for:
- "WebAssembly regex library standalone" 
- "WasmGC string operations without JS host"
- "icu4x wasm size optimization 2024 2025"
- "wasm bigint implementation"
- "wasm exception handling proposal status 2025"
- Current wasm-opt / Binaryen support for exception handling

### 5. File follow-up issues
For each viable solution identified, create a backlog issue covering:
- What gap it fills (which host imports it replaces)
- Which Wasm library/approach to use
- Estimated binary size impact
- Test262 tests it would unlock
- Implementation complexity

## Output format

Update this issue file with:
- `## Host Import Inventory` — complete table of current imports by category
- `## Standalone Readiness Map` — what's ready vs blocked
- `## Ecosystem Research` — findings for each gap with links and size/complexity estimates
- `## Recommendations` — top 3-5 highest-value replacements to implement next

Then create backlog issues for each recommendation.

---

## Host Import Inventory

Source of truth: `src/runtime.ts` (handlers) and `src/codegen/index.ts` + `src/codegen/declarations.ts` (registrations). Names beginning with `__` are codegen-private; the others are JS-library shims. WASI imports (`fd_write`, `fd_read`, `proc_exit`, `random_get`, `path_open`, `fd_close`) are *not* JS-host — they are standalone-friendly when a WASI runtime is present.

### A. Boxing / unboxing (primitive↔externref)
| Import | Mode | Notes |
|---|---|---|
| `__box_number`, `__box_boolean`, `__box_symbol` | host | wrap primitive into JS object reference |
| `__unbox_number`, `__unbox_boolean`, `__unbox_string` | host | strip wrapper |
| `__is_truthy`, `__to_boolean` | host | JS truthiness for externref |
| `__to_primitive` | host | ToPrimitive abstract op |
| `__get_undefined`, `__extern_is_undefined` | host | undefined sentinel |
| `__typeof` (+ `__typeof_*` setup) | host | `typeof` returning a JS string |

### B. String operations
| Import | Mode | Notes |
|---|---|---|
| `string_compare` | host (non-native) | lexicographic compare on JS strings |
| `string_toUpperCase`/`toLowerCase`/`trim*`/`charAt`/`slice`/`substring`/`indexOf`/`lastIndexOf`/`includes`/`startsWith`/`endsWith`/`repeat`/`padStart`/`padEnd`/`replace`/`replaceAll`/`split`/`match`/`search`/`at`/`codePointAt`/`normalize` | host or native | full table in `STRING_METHODS` (`src/codegen/index.ts:3656`). With `--nativeStrings` (WasmGC i16 arrays) most of these are emitted as pure-Wasm helpers; `match`/`search`/regex-arg overloads still need host (regex path) |
| `String_fromCharCode`, `String_fromCodePoint` | host or native | native helper exists for `--nativeStrings` (`fromCodePoint`); `fromCharCode` still host even in native mode |
| `wasm:js-string concat`/`length`/`equals`/`substring`/`charCodeAt` | builtin | **standardised**, Phase-4 WasmGC builtin imports — JS-host but contractually present in any compliant WasmGC runtime |
| `__str_to_mem`, `__str_from_mem`, `__str_extern_len`, `__unbox_string` | host | string<->linear-memory bridges |
| `__concat_*` (variadic concat) | host | dispatched by name |
| `__tagged_template` | host | tagged template literal `raw` array |

### C. Number formatting
| Import | Mode | Notes |
|---|---|---|
| `number_toString` | host | `Number.prototype.toString()` no-arg |
| `number_toString_radix` | host | `(value, radix)` |
| `number_toFixed`, `number_toPrecision`, `number_toExponential` | host | currently no Wasm-native path |

### D. RegExp
| Import | Mode | Notes |
|---|---|---|
| `RegExp_new` | host | `(pattern, flags) -> externref`; emitted by `typeof-delete.ts:300` |
| `string_match`/`search`/`split`/`replace`/`replaceAll` (regex args) | host | even in `--nativeStrings`, regex-arg overloads bail to host |

### E. Math
Wasm-native helpers exist for **almost all** Math methods via `src/codegen/math-helpers.ts` (sin, cos, tan, asin, acos, atan, atan2, log, log2, log10, exp, expm1, log1p, sinh, cosh, tanh, asinh, acosh, atanh, pow, cbrt, hypot, sign, round, trunc, sqrt, fround, clz32, abs, min, max, ceil, floor). Only the **host fall-back** is `Math_random` when not in WASI mode (in WASI we use `random_get`). Math is essentially **already standalone**.

### F. Errors / exceptions
| Import | Mode | Notes |
|---|---|---|
| `__throw_type_error`, `__throw_reference_error` | host | construct + throw JS Error on externref |
| `__get_caught_exception` | host | `try/catch` glue using JS catch |
| `new Error(msg)` (codegen path) | host | constructs JS Error |

### G. Object / property
| Import | Mode | Notes |
|---|---|---|
| `__object_create`, `__new_plain_object`, `__object_freeze`, `__object_seal`, `__object_preventExtensions`, `__object_isFrozen`, `__object_isSealed`, `__object_isExtensible`, `__object_keys`, `__object_values`, `__object_entries`, `__object_assign`, `__object_fromEntries`, `__object_getOwnPropertyDescriptors`, `__object_groupBy`, `__object_hasOwn`, `__object_is` | host | externref reflection — `Object.*` static methods |
| `__defineProperty_value`, `__defineProperty_accessor`, `__defineProperty_desc`, `__defineProperties`, `__getOwnPropertyDescriptor`, `__getOwnPropertyNames`, `__getOwnPropertySymbols`, `__getPrototypeOf`, `__isPrototypeOf`, `__hasOwnProperty`, `__propertyIsEnumerable`, `__create_descriptor` | host | property-descriptor machinery |
| `__register_prototype`, `__register_class_object`, `__tag_user_class` | host | side-table linking WasmGC structs to JS prototypes for `instanceof` |
| `__extern_get`, `__extern_set`, `__extern_get_idx`, `__extern_has_idx`, `__extern_length`, `__extern_slice`, `__extern_rest_object`, `__extern_method_call`, `__extern_toString`, `__extern_toLocaleString`, `__proto_method_call`, `__delete_property` | host | generic property dispatch on externref |
| `__get_builtin` | host | `globalThis[name]` |
| `__instanceof`, `__symbol_for`, `__symbol_keyFor`, `__proxy_revocable` | host | spec helpers backed by JS |

### H. Iterators / generators
| Import | Mode | Notes |
|---|---|---|
| `__iterator`, `__iterator_next`, `__iterator_value`, `__iterator_done`, `__iterator_return`, `__make_iterable`, `__async_iterator` | host | for-of/for-await-of glue |
| `__gen_create_buffer`, `__gen_push_f64`/`_i32`/`_ref`, `__gen_yield_star`, `__create_generator`, `__create_async_generator`, `__gen_next`, `__gen_return`, `__gen_throw`, `__gen_result_value`/`_f64`/`_done` | host | generator state-machine backed by JS |
| `__for_in_get`, `__for_in_keys`, `__for_in_len` | host | `for-in` enumeration |
| `__array_from`, `__array_from_iter`, `__array_of`, `__array_concat_any`, `__array_entries`, `__array_keys`, `__array_values`, `__array_flat`, `__array_flatMap`, `__array_join_any`, `__js_array_new`, `__js_array_push` | host | array reflection — note arrays-of-known-type are pure WasmGC |

### I. Console / I/O
| Import | Mode | Notes |
|---|---|---|
| `console_log_*`, `console_warn_*`, `console_error_*` (number/bool/string/externref) | host | direct JS console call |
| `wasi_snapshot_preview1.fd_write`/`fd_read`/`fd_close`/`proc_exit`/`path_open`/`random_get` | WASI | not JS-host; standalone-OK with any WASI runtime |

### J. JSON / Promise / misc
| Import | Mode | Notes |
|---|---|---|
| `JSON_stringify`, `JSON_parse` | host | full JS-engine implementations |
| `Promise_new`, `Promise_resolve`, `Promise_reject`, `Promise_all`, `Promise_race`, `Promise_allSettled`, `Promise_any`, `Promise_then`, `Promise_then2`, `Promise_catch`, `Promise_finally`, `__make_callback`, `__make_getter_callback` | host | needs JS event loop |
| `__extern_eval`, `__assert_count`, `__fail` | host | dev/test only |
| `__toUint32` | host or native | helper emitted as Wasm function (#1094) |
| `__dv_register_view` | host | DataView ↔ ArrayBuffer linking |

**Total distinct host import names today: ~150** (incl. families like `string_*`, `console_*`, `Math_*` expanded). The lion's share of those — Math, simple string ops, arithmetic — are **already** routed through pure-Wasm helpers; only the externref-tagged subset truly requires a JS runtime.

---

## Standalone Readiness Map

### Already standalone / WasmGC-native
- **All arithmetic** (i32/f64) — produced inline as Wasm ops.
- **Most `Math.*` methods** — `src/codegen/math-helpers.ts` emits pure-Wasm sin/cos/log/exp/pow/atan*/sinh/cosh/asinh/cbrt/sqrt/etc.
- **`Math.random`** — pure-Wasm wrapper around WASI `random_get` in WASI mode (#1322).
- **String literals & low-level string ops** — with `--nativeStrings`, strings are WasmGC i16 arrays; `__str_*` helpers in linear memory handle copy, compare, concat.
- **`String.prototype.{charAt,substring,slice,at,indexOf,lastIndexOf,includes,startsWith,endsWith,trim*,repeat,padStart,padEnd,toLowerCase,toUpperCase,replace,replaceAll,split,codePointAt,normalize}` and `String.fromCodePoint`** — emitted as Wasm helpers in `--nativeStrings` mode (no host call) **provided** the arg is not a RegExp.
- **Arrays of known element type** — pure WasmGC arrays, no host calls.
- **WASI I/O** — `fd_*`, `proc_exit`, `random_get`, `path_open` — standalone (no JS needed).

### Closeable with a small Wasm helper (low binary cost)
- **`new Error(msg)` / throw / try / catch** — Wasm 3.0 exception handling (`try_table` + `exnref` + `throw_ref`) is now in all major browsers and Wasm 3.0; can replace `__throw_*` / `__get_caught_exception` with a WasmGC `$Error` struct + Wasm `throw`. (#1470 already started this.) See **Recommendation #1**.
- **`Number.prototype.toString[(radix)]`, `toFixed`, `toPrecision`, `toExponential`** — Ryū / Dragonbox ports (Rust `ryu` crate is ~10KB compiled to Wasm); radix conversion 2..36 is ~1KB hand-written. See **Recommendation #2**.
- **`JSON.parse` / `JSON.stringify`** — pure Wasm; well-tread territory (Duktape, QuickJS ports). ~10-20KB. See **Recommendation #4**.
- **`typeof` / `__to_boolean` / `__to_primitive` for tagged-union values** — `typeof` over a tagged WasmGC union is just a switch on the discriminator + a string-literal table; no host needed once we commit to a uniform tagged value. (#1471 in flight.) See **Recommendation #5**.
- **`String.prototype.normalize` (NFC/NFD/NFKC/NFKD)** — `icu_normalizer` slice from icu4x: ~50-150 KB depending on which forms you ship and locale coverage. Optional, gated behind a `--intl` flag.

### Closeable but expensive (opt-in)
- **`RegExp`** — `regress` (Rust, ES2018-compliant, supports lookbehind + backrefs + named groups) compiled to Wasm is ~200-500 KB. RE2 (`re2-wasm`) is comparable but lacks backreferences. See **Recommendation #3**. Either is much larger than every other recommendation combined; should be **opt-in**.
- **`Intl.*` / `localeCompare` / Unicode collation** — `icu_collator` adds 0.5-1 MB once data is included. Almost certainly not worth bundling; recommend keeping as host import and document the gap.

### Inherently JS-host (keep as host import)
- **DOM**, **fetch**, **localStorage**, **eval**, **`Function(string)` constructor**, **Proxy** — out of scope for standalone; document as JS-only features.
- **JS-BigInt-Integration (i64↔BigInt at the JS boundary)** — this is a JS-API concern, not a runtime concern; in standalone mode there is no JS, so the boundary doesn't exist. Inside Wasm we already use `i64`. The only reason BigInt currently bridges through JS is to materialise an `externref` for *interop*. For pure-Wasm we can implement an `i64`-arithmetic + linear-memory-buffer `BigInt` struct (à la `num-bigint`); ~5-10 KB; **future work**.
- **Arbitrary `globalThis[name]`** (`__get_builtin`) — by definition needs a host name table; in standalone mode we'd freeze the table at compile time and synthesise a Wasm switch.

---

## Ecosystem Research

### Regex

**Candidates:**
| Library | Lang | Size (wasm) | ES syntax coverage | Notes |
|---|---|---|---|---|
| [`regress`](https://github.com/ridiculousfish/regress) | Rust | ~200-400 KB (release `opt-level="z"`) | ES2018 incl. lookbehind, backrefs, named groups, Unicode property escapes (utf16 feature) | Used by Boa / Hermes; closest fit to ECMA-262 |
| [`re2-wasm`](https://www.npmjs.com/package/re2-wasm) | C++ | ~500 KB | RE2 subset — **no backrefs**, no lookaround | Linear time, ReDoS-safe |
| [`onigasm`](https://www.npmjs.com/package/onigasm) | C | ~700 KB | Oniguruma syntax (PCRE-ish), more than ES needs | Heavy data tables |
| Pure-JS [`regexpu-core`](https://www.npmjs.com/package/regexpu-core) | JS | — | Transpiles ES regex to ES5; not a runtime | Not useful for standalone Wasm |
| Hand-rolled NFA | — | ~10-20 KB | minimal | Would need years of work to match ES2018 |

**Recommendation**: `regress` — best ES coverage, mature, ridiculousfish maintains it for Hermes. Cost: ~300 KB optional binary; gate behind `--regex=wasm` (default keeps host import). See `wasm-opt` / Binaryen pass to dead-code-eliminate unused parts.

### BigInt
- Wasm has full `i64` — the gap is **arbitrary-precision**, not 64-bit.
- Rust `num-bigint` → Wasm: ~30-40 KB optimised. Provides add/sub/mul/div/mod/pow/bitwise/comparison.
- Alternative: hand-rolled limb-based big-int over WasmGC `array i64` ~ 5-8 KB for the operations test262 actually exercises.
- **Note**: the WebAssembly **JS-BigInt-Integration** proposal is *only* about i64 <-> BigInt at the JS API boundary — irrelevant to standalone mode. There is no canonical "standalone Wasm BigInt" library yet; we'd need to port one.

### String methods (normalize, collation, Intl)
- **`icu4x` 2.0 (May 2025)** — the only credible Unicode library. Sizes from the Mozilla / Unicode blog and dotnet experiments:
  - Code: ~130 KB (was 2 MB for ICU4C)
  - DateTimeFormat: ~215 KB
  - Collator: ~6 MB with full locale data; 200-500 KB with single-locale or `compiled_data` minimal feature
  - Normalizer NFC/NFD: ~50 KB code + 30-50 KB data
- Mozilla/Firefox already ships icu4x for Intl; it is the upstream of choice.
- **Recommendation**: ship `icu_normalizer` only (~100 KB) behind `--intl`; document `Intl.*` and `localeCompare` as host-only.

### Number formatting
- **Ryū** (`dtolnay/ryu`) — 2-5× faster than libstd, Rust crate, ~10-15 KB compiled to Wasm; produces shortest-roundtrip string. Variants: `ryu-ecmascript` (ES-spec output).
- **Dragonbox** — V8 switched from Grisu3 to Dragonbox in 2025; faster than Ryū. C++; would need port.
- **toFixed/toPrecision/toExponential** — derive from Ryū output + tiny formatter (~1 KB hand-written).
- **Number.prototype.toString(radix)** — pure-Wasm in ~1 KB (digit table + division loop for ints; double-radix conversion for fractions). Spec: ECMA-262 §6.1.6.1.13.
- **Recommendation**: port `ryu_ecmascript`'s algorithm directly into `math-helpers.ts`-style emitters. Total cost ~5-10 KB Wasm. Eliminates 4 host imports outright.

### Exception handling
- **Status (Nov 2025)**: Wasm 3.0 shipped Sept 2025 with **exception handling included**; live in Chrome 95+, Firefox 100+, Safari 18.4 (mid-2025). New `exnref` value type, `try_table` + `throw_ref` instructions.
- **Binaryen / wasm-opt**: supports legacy EH; `exnref` support is partial (block-parameter limitation noted in issue #3114, but functional for the basic try/catch pattern js2wasm needs).
- **Already in flight in js2wasm**: #1470 began removing host error/throw glue. Recommend completing that with WasmGC `$Error`/`$TypeError`/`$ReferenceError` structs (extending an `$ErrorBase`) and Wasm `throw` / `try_table` / `catch_ref` instructions.

### wasm:js-string builtins (already in use)
- Phase-4 proposal, live in Chrome 131, Safari, behind a flag in Firefox (about to ship). js2wasm already imports `concat`, `length`, `equals`, `substring`, `charCodeAt` from `wasm:js-string`. These are **standardised** so they don't count as JS-host in the same way — any compliant WasmGC runtime must supply them. They give us "JS strings without JS glue", which is why fast mode looks so clean.
- Adding to the imported set would close more of the gap: the proposal also defines `intoCharCodeArray`, `fromCharCodeArray`, `codePointAt`, `compare`, `test` (string-prefix), `substring`, `length` — all already used; we could opt into `compare` to retire `string_compare`.

---

## Recommendations (priority order)

Each recommendation cites a backlog issue ID created from this audit.

### 1. Wasm-native exception types (`$Error` struct + `throw`/`try_table`) — **HIGH**
- **Replaces**: `__throw_type_error`, `__throw_reference_error`, `__get_caught_exception`, `new Error(msg)` glue (≈ 3 host imports + every JS Error construction).
- **Cost**: ~2-3 KB Wasm (a WasmGC struct definition + 3 helpers). No external library.
- **Unlocks**: standalone error handling in WASI; cleans up #1470/#1471/#1472/#1473.
- **Risk**: Binaryen `exnref` codegen has rough edges (issue #3114) — may need to use legacy EH first, migrate to `exnref` later.
- **Backlog**: **#1536**.

### 2. Wasm-native number formatting (Ryū port) — **HIGH**
- **Replaces**: `number_toString`, `number_toString_radix`, `number_toFixed`, `number_toPrecision`, `number_toExponential` (5 host imports).
- **Cost**: ~8-12 KB compiled Wasm (port of `ryu-ecmascript`).
- **Unlocks**: WASI numeric I/O without JS, removes the worst remaining "small but everywhere" host-call set. Estimated +200-400 test262 passes (number-stringification appears in ~5% of failing tests).
- **Backlog**: **#1537**.

### 3. Wasm-native JSON (parse + stringify) — **MEDIUM-HIGH**
- **Replaces**: `JSON_stringify`, `JSON_parse`.
- **Cost**: ~15-20 KB Wasm. Reference implementations: Duktape, QuickJS, jsmn (parse only, 1 KB but no stringify).
- **Unlocks**: standalone JSON for WASI/edge use; configuration-driven workloads.
- **Backlog**: **#1538**.

### 4. `regress` RegExp engine (opt-in) — **MEDIUM** (size cost)
- **Replaces**: `RegExp_new` + all regex-arg `string_*` overloads.
- **Cost**: ~300 KB Wasm (large but isolated, gated by `--regex=wasm` flag).
- **Unlocks**: standalone regex — unblocks `String.prototype.match/search/replace` (RegExp arg) in WASI, plus all regex literals.
- **Backlog**: **#1539**.

### 5. Tagged-union value representation to retire `__typeof` and small box/unbox imports — **MEDIUM**
- **Replaces**: `__typeof`, `__typeof_*`, `__box_*`, `__unbox_*`, `__is_truthy`, `__to_boolean`, `__get_undefined`, `__extern_is_undefined`.
- **Cost**: invasive but no library — change in codegen IR for union values; emits a WasmGC `(struct (field $tag i32) (field $f64) (field $ref))` or similar.
- **Unlocks**: most "small" host imports in one stroke; required to retire the externref boxing pipeline. Builds on #1471.
- **Backlog**: **#1540**.

### 6. (Stretch) `icu_normalizer` for `String.prototype.normalize` — **LOW**
- Only via `--intl` opt-in; ~100 KB.
- Document `localeCompare`, `Intl.*` as remaining host-only (not worth a 6 MB collator).
- Filed as: **#1541** (backlog, low priority).

---

## Out-of-scope / keep-as-host

- DOM, fetch, localStorage, eval, Function constructor, Proxy.
- Full Intl (Collator, NumberFormat, DateTimeFormat).
- Real Promise scheduling (needs an event loop — in standalone-WASI, Promise is degenerate; can be polyfilled but doesn't add value without async I/O).

## Summary table — host-import retirement potential

| Bucket | Host imports today | After Recs 1-5 | Library |
|---|---|---|---|
| Errors | 3 | 0 | none |
| Number format | 5 | 0 | Ryū port |
| JSON | 2 | 0 | hand-written |
| RegExp (opt-in) | 1 + 5 overloads | 0 (with `--regex=wasm`) | regress |
| Boxing/typeof | ~10 | 0 | none |
| Other small | ~30 | ~5-10 | mixed |
| **Total** | **~150** | **~30-40** (and most of those are deferred-feature glue: generators, iterators, Symbol) | — |

That's roughly **a 70-80% reduction** in JS-host surface area achievable without any major external dependency apart from optional regex.

