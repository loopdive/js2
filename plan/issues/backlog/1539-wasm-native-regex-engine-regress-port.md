---
id: 1539
sprint: backlog
title: "Opt-in Wasm-native RegExp engine via regress (ES2018 syntax)"
status: backlog
created: 2026-05-20
priority: medium
feasibility: hard
reasoning_effort: max
task_type: feature
area: runtime
language_feature: regex
goal: standalone-wasm
related: [1535]
---

# #1539 — Opt-in Wasm-native RegExp engine (regress)

## Problem
`RegExp_new` and the regex-arg overloads of `string_match`, `string_search`, `string_replace`, `string_replaceAll`, `string_split` all bridge to the JS host. Standalone Wasm has **no regex** at all. RegExp is one of the largest single missing features for WASI / edge / standalone use.

## Proposed solution
Add an opt-in flag `--regex=wasm` (default `host`) that bundles the [`regress`](https://github.com/ridiculousfish/regress) Rust crate compiled to Wasm. `regress` implements the ECMAScript 2018 RegExp grammar including:
- Lookbehind (fixed and variable width)
- Backreferences
- Named capture groups
- Unicode property escapes (`\p{...}`)
- UTF-16 matching (matches our `--nativeStrings` representation natively)

## Library/approach
- Crate: `regress` (Apache-2.0 / MIT, maintained by ridiculousfish, used in Boa, Hermes).
- Build: `cargo build --release --target wasm32-unknown-unknown --no-default-features --features utf16` + `wasm-opt -Os`.
- Embed: ship the resulting `regress.wasm` (or its `.wat` blob) as a side module that js2wasm links into the user's output when `--regex=wasm` is set.
- Bridge: provide thin Wasm shims `RegExp_new(pattern_native_str, flags_native_str) -> $RegExp_ref`, `regexp_exec($RegExp, native_str) -> $MatchArray_or_null`, etc.

## Binary size impact
~250-400 KB compiled Wasm (release profile, no Unicode property escape tables: ~250 KB; with full Unicode tables: ~400 KB). Larger than every other recommendation combined → must be **opt-in**, never default.

## Test262 impact (estimated)
- `built-ins/RegExp/*`: ~1,400 tests
- `language/literals/regexp/*`: ~50 tests
- Many `String.prototype.{match,search,split,replace,replaceAll}` tests
- Estimate **+400-800 passes** in WASI mode when enabled; in JS-host mode the existing host import is already correct so this is purely a standalone unlocker.

## Implementation steps
1. Build script `scripts/build-regress-wasm.sh` that produces a minimal `regress.wasm`.
2. New CLI flag `--regex=host|wasm|none` in `src/cli.ts` → propagated as `ctx.regexBackend`.
3. New file `src/codegen/regex-link.ts` that, when `ctx.regexBackend === "wasm"`, links the regress side module via Wasm imports/exports rather than emitting host `RegExp_new` import.
4. Define WasmGC structs `$RegExp` (holding the regress-internal handle) and `$MatchArray`.
5. Replace `RegExp_new` codegen path in `src/codegen/typeof-delete.ts` to call the side-module's exported `compile(pattern, flags)`.
6. Rewire `string_match`/`split`/`replace`/`replaceAll`/`search` (regex-arg overloads in `STRING_METHODS`) to call the side module.
7. Test against test262 `built-ins/RegExp/*` (gated by `--regex=wasm`).

## Risk
- regress is in Rust → needs a Rust toolchain in the build pipeline. Could pre-build and commit the artifact.
- ~300 KB is large; need to communicate clearly that this is opt-in.
- Some ECMA RegExp features (e.g., `RegExp.prototype.exec` with `lastIndex` mutation, sticky/global state) need careful bridging.

## Alternative considered
- `re2-wasm` (Google) — smaller surface, ReDoS-safe, but **no backreferences and no lookbehind**, so it cannot pass the full test262 RegExp suite.
- `onigasm` — too large (~700 KB) and PCRE-flavoured.

## Implementation Plan (added 2026-05-21)

The existing implementation steps already cover the high-level flow.
Adding entry-point file refs, ABI, and edge cases.

### Entry points

- **CLI**: `src/cli.ts` — add `--regex=host|wasm|none`; default
  `host`.
- **Context**: `src/codegen/index.ts` — add
  `ctx.regexBackend: "host"|"wasm"|"none"`.
- **Side-module linker**: new `src/codegen/regex-link.ts` —
  embed the precompiled `regress.wasm` as a `(data $regress
  "...")` section, then use the existing module-link infrastructure
  to merge it with the user's module via Binaryen `wasmMerge`.
- **Codegen branches**: `src/codegen/typeof-delete.ts` and
  `src/codegen/string-ops.ts` switch on `ctx.regexBackend`.

### ABI (concrete)

```wat
(import "regress" "compile"  (func (param i32 i32 i32) (result i32))) ;; pattern_ptr, pattern_len, flags
(import "regress" "exec"     (func (param i32 i32 i32 i32) (result i32))) ;; re_handle, str_ptr, str_len, start_idx
(import "regress" "group"    (func (param i32 i32) (result i32))) ;; match_handle, group_idx -> packed start<<16|end
(import "regress" "free"     (func (param i32)))
```

Pattern and string are passed as `(ptr, len)` pairs into a shared
linear memory; copy from native-string `(array i16)` into linear
memory at the call boundary.

### Data structures

```wat
(type $RegExp (sub (struct
  (field $tag i32)              ;; REGEXP_TAG (#1325)
  (field $handle (mut i32))     ;; regress engine handle
  (field $source (ref $StringArr))
  (field $flags i32)            ;; bitfield: g=1 i=2 m=4 s=8 u=16 y=32
  (field $lastIndex (mut f64))
)))
(type $MatchArr (struct
  (field $matched (ref $StringArr))
  (field $groups (ref $vec_StringArr))
  (field $index i32)
  (field $input (ref $StringArr))
)))
```

### Edge cases

- **Empty match advance** — when an empty match occurs with the `g`
  flag, `lastIndex` must advance by 1 to avoid infinite loop.
- **`y` sticky + non-zero lastIndex** — only match exactly at
  lastIndex.
- **Unicode property escapes (`\p{Letter}`)** — requires the full
  Unicode-tables build (~400KB). Make this a sub-flag
  `--regex=wasm-full` if size matters.
- **GC of compiled regex** — regress holds memory inside the
  side-module; the WasmGC `$RegExp` struct must trigger
  `regress.free` when collected. Without WasmGC finalizers, leak or
  use the existing dispose-pattern.
- **String backend mismatch**: regress expects UTF-16; copy
  one-shot into linear memory. For `--nativeStrings`, the array is
  already UTF-16, so it's `array.copy` to memory.
- **Cross-realm regexes** — N/A.
- **`RegExp.prototype[Symbol.match]`** — must follow the spec's
  branch on `g` flag. Reuse JS-host implementation but call the
  wasm engine.
- **`RegExp.prototype.flags`** — recompute from bitfield.

### Test262 paths

- `test/built-ins/RegExp/*` (~1400 tests).
- `test/built-ins/String/prototype/{match,replace,replaceAll,search,split}/*`.

Acceptance: ≥80% pass when `--regex=wasm`.

### Dependencies

- Coordinate with **#682** which proposed QuickJS libregexp.
  Project leads must pick ONE; recommend regress (Rust) for its
  modern Unicode support and active maintenance, accept the larger
  size.
- **#1105 Tier 2** — depends.

### Risks

- **Build pipeline**: Rust toolchain required. Mitigate by checking
  in precompiled `vendor/regress.wasm` (~280KB binary) and only
  rebuild when `vendor/regress-version.txt` changes.
- **Size**: 300KB. Opt-in only. Document clearly.
