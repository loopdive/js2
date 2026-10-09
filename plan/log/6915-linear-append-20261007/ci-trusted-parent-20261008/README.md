# Trusted append parent: exact qualification, 2026-10-08

Local execution HEAD `0d2dfddb4b1145097210f5398e535e550f945f82`, source tree
`953f74f80cf2f8085b8e1c93489fcdd357929b37`, Node22.23.2. The pending CI-only
patch uses runner SHA256
`a93d01892de5dba5783248b6441fcbf8979a47759bc2236a834b6abefc2e6bfa` and hook
SHA256 `51664c0c2254f929456e219292e4410cccfa43b6146c48c0e02e55972aeacdb4`.
These are the executed bytes; a later evidence/publication commit is not
substituted as the execution HEAD. Original source, tests and fixtures unchanged.

A's adopted Astra High specification is published at
`555af588b3b41dda3b95a3d53468e0f4d55a32c7`. Its independently approved content
pins, strict command and4096-MiB worker flags are in `expected.json.gz`.
`before.json.gz` and `after.json.gz` retain complete equal checkout custody.
Runner self-tests pass54 controls; the final Astra review clears only the
reported parser/receipt obligations, not full IR acceptance.

Actual result:36 passed, zero failed/skipped/todo, strict child exit0,
19,733ms child time,44,273,883 stdout bytes, zero stderr bytes. Full raw streams,
38 graphs, reference-preserving inert decoded records, reporter, diagnostics,
runner-error archive and receipt are preserved as gzip files. Native Error
objects are not assumed lossless under V8 serialization; the runner detaches
its own error descriptors/references first. Unevaluated accessors are marked
incomplete and unsupported diagnostic views fail closed. Raw child graphs are
authoritative.

Offline replay from the repository root:

```text
node plan/log/6915-linear-append-20261007/ci-trusted-parent-20261008/compare.mjs
```

It floors both populations at38 and requires all36 observation graphs plus
the completion graph to equal the archived narrowly repaired-v3 baseline,
without removing any graph fields. Only the deliberately different execution
provenance is separately retained and validated by the trusted parent; it is
not falsely asserted equal. Runtime22 has33 transitions and all eight named
negative controls retain their original/corrupted witnesses. Original failures,
all fixtures and previous repair epochs remain in their existing artifacts.

This repairs the parent-input CI path only. It does not prove native array or
Unicode support, append performance benefit, full IR closure or retirement.
Existing HOLDs and A's final queue ownership remain.
