---
id: 1541
title: "Opt-in icu_normalizer (icu4x) for String.prototype.normalize"
status: backlog
created: 2026-05-20
updated: 2026-05-20
priority: low
feasibility: medium
reasoning_effort: medium
task_type: feature
area: runtime
language_feature: string
goal: standalone-wasm
sprint: Backlog
related: [1535]
---
# #1541 — Opt-in icu_normalizer for String.prototype.normalize

## Problem
`String.prototype.normalize(form)` for NFC/NFD/NFKC/NFKD requires Unicode normalization tables (~30 KB minimal data). The host currently does this via `string_normalize`. Standalone Wasm has no normalization.

## Proposed solution
Bundle the `icu_normalizer` crate from [icu4x 2.0](http://blog.unicode.org/2025/05/icu4x-20-released.html) (Apache-2.0) compiled to Wasm and exposed behind a `--intl=normalize` opt-in flag.

icu4x is the Mozilla/Unicode upstream and is already used in Firefox.

## Library/approach
- Crate: `icu_normalizer` with the `compiled_data` feature (~30-50 KB data baked in).
- Build: `cargo build --release --target wasm32-unknown-unknown -p icu_normalizer --no-default-features --features compiled_data`.
- Wasm-opt with `-Oz`.
- Link as a side module similar to #1539 (regex).

## Binary size impact
~80-120 KB total (code ~50 KB + data ~50 KB) for all four normalization forms.

## Test262 impact (estimated)
- `built-ins/String/prototype/normalize/*`: ~30 tests
- Indirect: a handful of regex / collation tests use normalize internally.
- Estimate **+30-50 passes** in standalone mode when enabled.

## Implementation steps
1. Build script `scripts/build-icu-normalizer-wasm.sh`.
2. CLI flag `--intl=none|normalize|all` (only `normalize` implemented here; `all` reserved for future).
3. Replace `string_normalize` host import path in `src/codegen/index.ts` (`STRING_METHODS.normalize`) with side-module call when flag is set.
4. Document: `localeCompare`, `Intl.*`, full collator remain host-only — they cost too much (collator alone is ~500 KB minimum).

## Risk
Low — `icu_normalizer` is well-bounded and the data tables are static.

## Out of scope
- `Intl.Collator`, `Intl.NumberFormat`, `Intl.DateTimeFormat` — too large; remain host-only.
- `String.prototype.localeCompare` — depends on collator; remains host-only.

## Current standalone behaviour (verified 2026-06-18, #40 probe)
Standalone `String.prototype.normalize(form)` is a **no-op stub** today: it
returns the input string UNCHANGED for every form (`NFC`/`NFD`/`NFKC`/`NFKD`).
Verified by probe: `"é".normalize("NFC")` returns `"é"` (should be
`"é"`), `"é".normalize("NFD")` returns `"é"` (should be
`"é"`), `"ﬁ".normalize("NFKC")` returns `"ﬁ"` (should be `"fi"`).
A plain ASCII string (already normalised) round-trips correctly only because the
input already equals the output. This issue (icu4x opt-in, or a pure-Wasm
canonical decomposition/composition + compatibility-mapping table + the
recombination algorithm) is the path to real normalization. The #40
case-conversion work deliberately did NOT touch normalize — it is a separate,
larger Unicode-data effort, correctly tracked here.
