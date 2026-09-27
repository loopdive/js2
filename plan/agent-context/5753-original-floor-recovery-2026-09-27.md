# PR5753 original standalone-floor recovery

This is landing-blocker work for #1058, not legacy retirement or a new migration
scope. Published candidate b212925eaba4a038e3b422b21232c41000e2b451 includes main
935dab385ba7f21588ea371d052e7f143f894205. Its ordinary CI run 36280469255 finished
SUCCESS. That does not clear the standalone merge-queue floor; keep HOLD.

## Recovered original evidence

`5753-original-status-deltas-20260927.jsonl` preserves the exact 176 historical
changed-path status/error records recovered from retained session output:
137 losses, 31 gains, eight other status changes. SHA-256 is
`5ad595da9901050bb577d35181ace60df3d5e827a21b83d5288bdf132d685452`.
The adjacent provenance JSON records source locations, independent receipts,
and missing full-report caveats. These are NOT the original full report bytes.
GitHub artifact retrieval returned 404 and both runs list zero artifacts;
expiration versus deletion is unknown. No full-report hash was recomputed.

The pre-existing local corpus was 624e68d3fde7f1208c1524963bd556b4b1ff6ae9,
not the required b363f29d3c43c626dc852744ad64a0b48a003693. It was left untouched.
The exact pin was fetched into `/private/tmp/js2-test262-b363-vBCLpp` and all
176 recovered paths were verified present. Both immutable test subjects use
its original test and harness directories, with separate freshly built compiler
and runtime bundles and separately canary-verified QuickJS adapters.

## First paired original-fixture run

`5753-original-floor-pair16-20260927.json` preserves raw rows and completion
manifests for exact main935 and candidateb212. Both used Node22.23.2,
standalone/auto providers, the maintained Vitest dynamic-chunk runner, proposals
included, QuickJS, one worker and identical original fixtures. Both completeness
checks verified 16 unique registered paths, 16 verdicts, zero exclusions.

Main: 15 pass, one fail. Candidate: seven pass, nine fail. Eight regressions:

- Three original class-element own-property tests fail only on the candidate:
  multiple-definitions-private-field-usage, redeclaration, and
  field-definition-accessor-no-line-terminator.
- Four original object-generator tests pass main but fail candidate compilation
  with forbidden host imports: __proto__-permitted-dup, fn-name-gen,
  generator-name-prop-symbol, generator-prop-name-eval-error.
- Error stack setter-non-extensible-receiver passes main but candidate throws
  `hasOwnProperty called on null or undefined`.

Error stack setter-proxy-trap-rejects fails identically on both; no allowance or
expectation was changed. The other seven tests pass both. A passing metadata or
creation-time test does not by itself prove generator invocation correctness.

## Next work and limits

The exact 176-path main control completed: 154 pass, 22 fail, 176 unique verdicts,
176 registered paths, zero exclusions; 507.47 seconds. Candidate176 completed:
38 pass, 138 fail, all 176 unique verdicts and registered paths, zero exclusions;
559.20 seconds. The scoped pair has 129 losses and 13 gains: 124 class-property
failures, four generator host-import refusals, and one Error failure. Full raw
candidate rows and every changed status/error are preserved in
`5753-original-floor-candidate176-20260927.jsonl` and
`5753-original-floor-pair176-20260927.json`. Nonpassing-to-nonpassing differences,
including timeouts, remain visible and are not silently classified as equal.
The paired work uses immutable worktrees
`.codex-worktrees/codex-5753-floor-main-20260927` and
`.codex-worktrees/codex-5753-floor-candidate-20260927`. Per-worktree logs and
timestamped result JSONL are retained; never delete caches, reports or fixtures.
Parent owns the serialized compiler/test slot. Independent agents investigate
the generator admission and class own-property regressions without running tests.
The pre-Function.call c6 checkpoint was also tested on the unchanged Error
setter-non-extensible-receiver fixture: one registered path, one verdict,
same `hasOwnProperty called on null or undefined` failure. Thus the latest
Function.call repair did not introduce this regression. Its raw row and
completion manifest accompany the main176 provenance JSON.

Main176 raw rows are preserved in `5753-original-floor-main176-20260927.jsonl`;
`5753-original-floor-main176-provenance-20260927.json` includes their hash and
completion manifest. Of the historical 137 losses, main now passes136 and
fails only the Proxy-trap case; of 31 historical gains, main passes18; all eight
other historical status-change paths remain nonpassing. These classifications
select historical populations; they do not replace the current paired verdicts.

The 16-case result, and even a complete 176-path rerun, cannot clear the full
48,735-test historical population or certify retirement. Current Node22 also
differs from historical CI Node25. Preserve original failures, all fixture bytes,
legacy paths, and the protected-queue acceptance bar.
