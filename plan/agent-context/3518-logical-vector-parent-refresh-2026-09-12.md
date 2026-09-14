# Logical vector and native-main lowering parent refresh

## 2026-09-12: logical vector and native-main lowering queue refresh

Refresh existing PR5757, “feat(ir): lower certified vectors and prepared native
main operations”, from published 1cb0f5c7f36be14d7be7eb4592973aea84a8c4e5 onto
signed local admission parent 1f611285c35c6d1c42f4eff577441c79ee7ec706 in
`codex/5757-queue-drain-20260912`. Publication remains behind confirmed parent
delivery to main; the existing PR remains the only publication target.

The only conflict was appended issue history. Both complete sections remain
preserved. The two production files and two authored tests match the published
head byte-for-byte; the refreshed parent policy, frame engine/wrapper, standard
native-delay EH and all five source-admission implementation files remain
unchanged. This refresh introduces no lowerer edit or new migration scope.

Preserve the console newline correction and ordinary logical-concat positive
when the optional target is absent. Source-bound vector facts must still be
complete and owned by the exact actual expressions. Preserve receiver/length/
effectful-argument/growth/result ordering, actual nullability and out-of-bounds
carriers, and refusals for missing, foreign or physical-layout-bearing facts.
Symbolic prepared-main targets still avoid physical capability lookup. These
controls do not certify the complete async family, providers or physical
whole-program acceptance.

An independent pinned test262 repository at
b363f29d3c43c626dc852744ad64a0b48a003693 passed all 53,933 raw blob comparisons
(53,889 tests and 44 harness files), exact file/directory sets and modes,
with no extras, alternates or shared object hardlinks. Existing corpora remain
preserved. Manifest SHA256:
fcaaff56a78c134e3875a00b743d5e6435939c38f304eeec1ffb35bc3c611ffb.

Fresh serialized Node25.9.0/macOS ARM64 validation measured **213 passed,
zero failed, two existing conditional skips / 215 total** across seven files.
The lowerer/regression group is 100 passed and two skipped; the unchanged
semantic/provider boundary group is 113/113. The skips are the original native
Porffor C ASan/UBSan allocation-growth/alias case and untouched public-source
comparison, selected by their unchanged prerequisite condition. No environment
flag or added skip forced them; native Porffor C execution is not claimed.

Source typechecking, explicit-parent-base LOC/function gates, coercion, oracle
and preservation-v1 dead-export checks passed. Conformance synchronization
changed zero files. Strict graph closure remains OPEN at the two existing
nonliteral imports; preservation witness success is not IR retirement.

The default pre-commit selector sees 32 inherited root test changes against
535ee6b6ba19239394ee50f8235e6c528212688b and self-skips its existing >20 lane. The
215-case cohort was run directly; do not claim this inherited population ran.
Normal signed commit and push hooks remain mandatory; their actual outcomes
and parent delivery belong in the existing PR follow-up. Local evidence is
under `.tmp/5757-queue-drain/`. Keep ordered delivery 5755→5756→5757→5758→5759→5760
and carry the signed standard-EH delay repair into PR5759 with both catch forms.
