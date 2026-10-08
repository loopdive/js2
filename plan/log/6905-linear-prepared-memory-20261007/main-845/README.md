# Current-main composition, 2026-10-08

Canonical production baseline: `8452732f0b88c14c5c7634ece58f83240970ea4c`.
Baseline test-only execution: `3fee634ae67f23f57085ce6b792e584cd78e85ac`.
Candidate execution: `14aa145dd9ca39bff986dd1626e78f6e12e8da6d`.
Both use identical frozen V3 test SHA256
`0afcb36a4cb3e783a06191bfe6356d568d96791d7aeca8249bfcdd580eac8d77` and the
unchanged seventeen-case scalar control SHA256
`8c3787b33a1d38dd42a261a1d8f40fdea10053a37816bef38c064f761387fd3d`.

Both runs exit1: **24 pass / 1 fail / 25, zero pending**. The seventeen original
controls pass in each arm. New requirements: seven pass, one fails; the ordinary
shared-allocation positive remains rejected during preparation. All eight
complete rows compare exactly, including ownership, memory observations and
failure messages. All five complete unit binary witnesses validate and compare
exactly. Source artifact rows retain hashes/lengths, not complete source binaries;
memory rows retain hashes/headers/neighbor observations, not full memory images.
The complete raw failure sections are exactly equal (1,561 characters), with
no path normalization or omissions. Historical V1/V2/V3 evidence stays unchanged.

Replay the saved reports, provenance receipts, rows, binaries and full failure:
`node plan/log/6905-linear-prepared-memory-20261007/main-845/compare-population.mjs`.
The historical comparator's two-log mode also passed for these executions; its
four-log historical omission mode was not used. The frozen test's hard-coded
`baseline:609286...` field remains historical metadata, not current provenance;
actual execution HEADs are authenticated by saved before/after receipts and rows.

Strict test-inclusive TS7 exits0 with zero diagnostics; the configuration and
empty raw log are retained. The real unmodified compiler-boundary inventory
exits1 on the missing runtime README and vector-initializer module/target entries;
its complete report and diagnostic log are retained without exemptions.

This refresh authored no production edits and is limited preservation evidence.
It does not implement shared allocation, native target-policy admission or
source-free memory replay, and does not authorize host IR support or retirement
of legacy code. Session A owns shared contracts, registry and final integration.
The positive requirement and real boundary-inventory failures must be resolved
before this HOLD PR may land. See the issue plan for exact dependencies.
