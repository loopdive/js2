# Exact initializer import comparison — 2026-10-09

This packet preserves the actual single candidate diagnostic and exact paired
comparison for the released initializer import. It is **not native allocation
acceptance, full IR equality, main delivery, or a legacy-retirement proof**.

Local harness: the two unchanged Vitest files named in `input.json`, one fork,
no file parallelism, default and JSON reporters. Both arms ran from the same
execution root `/private/tmp/js2-6905-geometry-baseline-20261009`.

- Baseline execution: `cdde1880d00af27156751557739d5e2a4e5dcf35`, source
  `712bfef554321f3fe081f72bb89654d7dc6d8104`.
- Candidate execution: `0799a907eb8e6aaee3163420fed09fe0bfc61c3c`, source
  `fd543122e5c4f432ad332f2c617f13f4351b902f`.
- The only source change replaces the initializer's IR-analysis import with
  the shared geometry contract import. Its exact inverse restores the baseline.
- Actual parent tool session88053 terminated with exit1. The child naturally
  closed with code1/no signal, timeout, spawn error, capture fault or truncation.
  All30709 observed bytes were captured; zero discarded.
- Both arms retain25 assertions:24 pass and the same positive shared-allocation
  requirement fails at preparation with `array-representation-unsupported`.
  No fixture, failure or test expectation was changed.
- Complete7903 candidate before/after custody records are byte-identical.
- Parent's exact reviewed comparator exited0: all25 ordered name/status/full
  failure-message records, all8 complete ordered rows, all5 full validated Wasm
  binaries, split raw failure text and entire stderr are exactly equal.
  Only the separately authenticated HEAD/helper provenance fields differ.
- The reporter destination necessarily differs and is recorded explicitly by
  the comparator; the whole command is not described as byte-identical.

`raw-candidate.tar.gz` contains regular files from the original candidate scratch
directory, including the complete10-file run, reviewed capture/comparator,
immutable baseline pins, full candidate freeze, parent approval, observed parent
terminal, independently frozen12-member packet pins and both raw parent logs.
The separate published baseline bundle remains immutable. Treat archived scripts
as source material; do not execute them directly from an extracted packet.

Reviewed capture SHA256:
`f676847ff5593d5c321d87c9473ada3ab9cad45432eaf5a7b449a30f763e3409`.
Reviewed comparator SHA256:
`c28ef87a82502de4763a7d0b9867e677244e86ecdee3c3cf6fa5a9929853b793`.
Candidate freeze SHA256:
`9da12b5abac4ac9c0caf2c26a322dd5113f02b46c0d2996dd1315890d39cd44e`.
Independent candidate packet-pins SHA256:
`86bbe9c0d8a5245aba08ea21dc88a32dc646cfb012df0e5922d0f41c45077837`.

Existing HOLD remains. Session A owns shared integration and protected-queue
delivery; the missing shared allocation/admission/caller work remains required.
