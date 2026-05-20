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
