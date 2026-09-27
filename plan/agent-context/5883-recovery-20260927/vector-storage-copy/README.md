# Dormant cross-instance vector storage copy checkpoint

This is a prerequisite for the existing PR5748 array-property blockers, not a
completed semantic Array copy or production activation. The new builder has no
production caller. Future callers must authenticate resident storage domains and
obtain their private hole tokens; compatible Wasm types alone are insufficient.
Raw presence does not establish descriptors, Get/HasProperty or prototype rules.

The builder validates all ranges before mutation, rejects same-storage copies
with unequal tokens, uses overlap-safe array.copy for equal tokens, and translates
only exact source-hole identity for distinct domains. Other externrefs retain
identity. It does not repair mixed-domain storage or handle f64 sentinel policy.

## Preserved failures

The first run and correction are recorded in first-validation.md, with the first
Wasm and TS7 logs alongside it. Original 27 cases initially had 26 passes and one
opaque-object assertion error; the two supplemental cases had one pass and one
such error. Neither failing case reached its copy operation. Primitive Object.is
assertions retain the identity requirement without inspecting opaque GC objects.
Uint8Array.from fixes only the test's static BufferSource type. No production
builder, fixture population or copy expectation changed for these corrections.

The old worktree retained two missing emission-ownership import diagnostics.
The same three corrected files were therefore transferred via apply_patch into
the clean recovery branch at b6a34655a6308a12320821ba61bdb0ed50e6aefc, which includes
upstream dbba95acb11b525b03b5739469d0c4f132fb0474. All three hashes match the reviewed
and tested files in the originating worktree exactly.

## Current recovery-branch validation

- Canonical pnpm run typecheck: session30373, terminal933967, exit0.
- Full source plus both new tests, same canonical TS7 settings via the scratch
  extending config .tmp/5748-raw-copy-validation.tsconfig.json: session34720,
  terminald36dfa, exit0, no diagnostics.
- Both complete test files with one worker: 29/29 pass, zero skipped; original
  27/27 and supplemental2/2. JSON: .tmp/5748-raw-copy-main-recovery.json.
  This runs the actual emitted Wasm body, not a JavaScript mirror. Cases include
  two instances, cross-domain translation, overlap, prewrite rejection, exact-end
  zero count, opaque lookalikes and identity preservation.

SHA256 subjects:

- Builder: 6ee057d700f7b0a049e5f9b7d8128a4b03459ae8992998d6c9ea2680aa5aa78f
- Structural tests: 14480e3f4f8f5502dc2b616dc25dfc72301d37eba590c3361911efac1f55fb8a
- Wasm tests: c5f4273503e8546b07d6ac057eb7efca5ae603eb622cd8877d2a912129fe56de

No active carrier layout, provider authentication, host import, source lowering,
legacy compiler, baseline or original conformance fixture changed. The full
array-property repair and IR equivalence obligations remain open. These tests
prove only the bounded raw-storage primitive, not end-to-end migration or
permission to retire the old compiler.
