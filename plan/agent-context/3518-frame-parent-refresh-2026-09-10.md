# Frame extraction parent refresh

Refresh PR5755 from `9505d0860529cf6bedf887d68c2670130d8422b3` onto its
immediate parent PR5754 at `e72b5acfcb02852f356a814497a6d2d06dd6e3d0`.
Merge preview: `7e57cdc2e0581825d685e9b2e9bf3f56711859b4`.
Only appended issue3518 history conflicted; both complete sections remain.
All nine PR-owned source/test files match the original head exactly. The
native-delay standard-EH repair matches the parent byte-for-byte.

The three-file frame ownership, source-preservation and semantic-provider
boundary run completed EXIT0 on Node25.9.0/macOS ARM64. Full test receipt:
`/private/tmp/js2-5755-parent-refresh-tests-20260910.json`.
No fixture or expected outcome was changed. This is current execution evidence,
not historical byte equality: the historical frame comparator still requires
its original baseline and complete five-artifact/twelve-execution population.
All original failure and three-arm evidence remains preserved.

Keep the conformance hold. Continue parent-first through PR5756, PR5757,
PR5758 and PR5759. At PR5759, deliberately carry the standard-EH repair into
the extracted runtime delay body, preserving both tagged and foreign catches;
do not restore its legacy try or reseed original preservation receipts.
