---
id: 1538
sprint: backlog
title: "Wasm-native JSON.parse and JSON.stringify (standalone, no host)"
status: backlog
created: 2026-05-20
priority: medium
feasibility: medium
reasoning_effort: high
task_type: feature
area: runtime
language_feature: json
goal: standalone-wasm
related: [1535, 1537]
---

# #1538 — Wasm-native JSON.parse / JSON.stringify

## Problem
`JSON_parse` and `JSON_stringify` are host imports that delegate to the JS engine. In WASI/standalone mode, applications that read JSON config or emit JSON results cannot do so without a JS runtime — yet JSON is one of the most common standalone use cases (edge functions, CLI tools, config parsing).

## Proposed solution
Implement a pure-Wasm JSON encoder and decoder operating on the existing `--nativeStrings` (i16 WasmGC array) and the union value representation.

- **Parser**: recursive-descent over the input string buffer; standard JSON grammar (RFC 8259). Output: a tagged union value (object → `Map`-style struct, array → WasmGC array, string → i16-array, number → f64, true/false/null → sentinels).
- **Stringifier**: walks the union value; emits to a growable i16-array buffer. Supports the `replacer` arg only for the function form (host-friendly subset) and indent arg.
- **Number formatting**: depends on #1537 (Ryū) for `Number → string` inside stringify.
- **String escapes**: `\u{...}`, `\\`, `\"`, control-char escapes per spec.

## Library/approach
Reference implementations to study (license-compatible):
- **jsmn** (MIT, ~1 KB, parser-only) — too minimal but useful as skeleton.
- **QuickJS** (MIT) — high-quality C reference for both parse and stringify.
- **Duktape** (MIT) — clean C reference.
Re-implement from spec; no FFI.

## Binary size impact
~15-20 KB Wasm: parser ~6 KB, stringifier ~8 KB, escape tables ~2 KB.

## Test262 impact (estimated)
- `built-ins/JSON/parse/*`: ~80 tests
- `built-ins/JSON/stringify/*`: ~120 tests
- Many feature tests use `JSON.stringify` as their oracle; fixing those raises secondary passes too.
- Estimate **+150-300 passes** in standalone mode.

## Implementation steps
1. Define a uniform "JS value" union representation (depends on #1540 if not already present, or use the current `externref`-or-typed pattern).
2. Add `src/codegen/json-helpers.ts` with `__json_parse`, `__json_stringify` Wasm functions.
3. Register them via `addImport`-equivalent for defined functions; remove `JSON_parse`/`JSON_stringify` host import calls in `src/codegen/index.ts:4772,4776`.
4. Provide a host-mode fallback for non-`nativeStrings` builds.
5. Test against test262 `built-ins/JSON/*`.

## Risk
The recursive parser is straightforward; the stringifier is harder because of `toJSON` invocation, replacer-function semantics, and cyclic-object detection (spec §25.5.2). Cyclic detection needs a side-set of "seen" object refs (~256-entry hash set, ~1 KB extra).
