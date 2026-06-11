---
id: 1932
title: "Version the env ABI — no compatibility handshake between compiled binaries and runtime.ts"
status: backlog
sprint: Backlog
created: 2026-06-10
updated: 2026-06-10
priority: high
feasibility: easy
reasoning_effort: medium
task_type: feature
area: runtime
language_feature: compiler-internals
goal: correctness
---
# #1932 — Version the env ABI

## Problem

The `env` ABI between compiled binaries and the JS host runtime — ~200
distinct import names, NaN-as-missing-arg sentinels
(`number_toPrecision`'s isNaN check, `runtime.ts:5092-5096`; the `split`
NaN-limit hack, `:4684-4689`), `__call_fn_N` arity exports, `__sget_*`
naming — has **no version constant and no handshake**. A precompiled `.wasm`
paired with a newer/older `runtime.js` fails only at runtime, by
missing-import LinkError or silent misbehavior.

The team already knows how to do this: `STANDALONE_REGEXP_ABI_VERSION = 1`
exists for the regex engine (`src/codegen/regexp-standalone.ts:51`). It just
isn't applied to the main surface.

## Proposed approach

1. Define `ENV_ABI_VERSION` in one shared module imported by both codegen
   and runtime.
2. Codegen emits it (an exported immutable global `__abi_version`, plus a
   custom section for offline inspection).
3. `buildImports`/instantiation (`runtime.ts:10018`,
   `runtime-instantiate.ts`) reads the export post-instantiation (or the
   custom section pre-instantiation) and throws a clear, actionable error on
   mismatch: expected vs found, with the compiler version that produced the
   binary.
4. Bump policy documented in the allowlist header: any change to an import
   name/signature/sentinel bumps the constant (review checklist line).
5. Tolerate absence (binaries older than this feature) with a one-time
   console warning, for one release window.

## Acceptance criteria

- Mismatched binary/runtime pair produces the structured error (test with a
  doctored global).
- Old binary without the global still instantiates with a warning.
- Docs: `docs/` note on ABI stability for precompiled binaries.

## Source

Compiler quality review 2026-06. Related: host-import allowlist
(`src/codegen/host-import-allowlist.ts`), #1858.
