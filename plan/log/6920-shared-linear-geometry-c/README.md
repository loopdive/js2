# #6920 shared Linear geometry — Session C qualification

Session C landed Session A's reviewed geometry packet (A's packet commit
`7974cae44741a4473d78107ad96ebe7afa1341c5`) as source, then measured it against its base.

- **Base:** `8452732f0b88c14c5c7634ece58f83240970ea4c`, which was also `origin/main` at fetch time.
- **Patches:** `source.patch` (SHA256 `759889320f82a2761961b9af3d74a9c7d840e909c4292826863ce15a5abf4901`) and `tests.patch` (`edcea62258f8f16712b6f826dfc3c695ce46cf6289568e1858435bd6c5e2117e`).
- **How they were applied:** POSIX `patch --batch -p1`. `boundaries.patch` was **not** applied.
- **Hashes:** all four resulting files byte-match the manifest's `frozenOperands` SHA256s.
- **A/B method:** file-copy swaps of the three source files plus the new test, never `git stash`.

## Results (base -> candidate)

| Check | Base | Candidate |
| --- | --- | --- |
| `tests/issue-6865-linear-layout-contract.test.ts` (G24) | absent | 24/24 pass; names and order equal manifest `G24ExpectedNames` |
| 39 compatibility suites (every `tests/*.test.ts` that references linear-memory-plan/-layout or the IR relocation/authority helpers, plus issue-3298 and cross-backend-diff) | 690 pass / 3005 fail / 4 skip | 793 pass / 2902 fail / 4 skip (excluding G24) |
| New failures (per test id) | — | **0**; 0 missing tests |
| `cross-backend-diff.test.ts` | 33/33 | 33/33 |
| `node scripts/equivalence-gate.mjs` | 1748 pass, 22 known failures, exit 0 | identical failing set, exit 0 |
| `npm run -s typecheck` (TS7) | exit 0 | exit 0 |
| `check:import-cycles` | OK: 1892 files, 10497 value edges | OK: 1893 files, 10498 value edges; largest SCC 699 on both |
| `check:compiler-boundaries` | exit 1 `inventory-valid-architecture-incomplete` (pre-existing) | exit 1 `invalid-inventory`; see below |
| LOC / function budget (merge-base and `LOC_GATE_BASE=8452732f0b`) | — | OK, net +78 LOC, no allowance needed |
| `check-coercion-sites`, `check:oracle-ratchet` | — | OK |
| `check:dead-exports` | exit 0 | exit 0, output byte-identical to base (graph OPEN, strict modeled closure FAIL, preservation 6/6) |

### Pre-existing failures

The 2902 to 3005 failures are historical byte-pin and proof suites (issue-3518-*, issue-3525-*, issue-3528). They already fail on base.

The +103 "new passes" are all in `issue-3518-c1-current-source.test.ts`, and they are incidental:

- On base, 156 tests fail on a stale pin of `src/ir/analysis/contracts/linear-memory-layout.ts` (`lowering analysis relocation: full pin changed`).
- On the candidate, the first pin mismatch is `src/ir/analysis/linear-memory-plan.ts` (`C1 current source: full pin mismatch`).
- That message happens to satisfy 103 `toThrow(/full pin mismatch/)` assertions. This is not real progress on that suite.

### Boundary diagnostics (candidate only)

All ten diagnostics are about the unregistered new shared leaf:

```
unclassified-module: src/shared/contracts/linear-memory-layout.ts
unclean-active-layer: src/shared/contracts/linear-memory-layout.ts
unclassified-target: src/shared/contracts/linear-memory-layout.ts   (x6)
forbidden-transitive-path: src/ir/analysis/contracts/linear-memory-layout.ts -> ../../../shared/contracts/linear-memory-layout.js   (x2)
```

The fix is A/root's planned follow-up: register the leaf in `foundation` and add the inventory files row in `scripts/compiler-boundaries.json`. This session deliberately did not edit that file.

## Files

- `*-suites-status.txt`: per-test status lists.
- `suites-base-vs-candidate.txt`: the per-test diff.
- `*-suites-console.txt`: vitest console output.
- `*-compiler-boundaries-diagnostics.txt`: the verdict lines only.
  - The raw JSON reports are about 11 MB each and were not committed.
  - SHA256 of the base raw report: `3c721828b8a483abbce2d30edc3f99c82be6a70190aef73e77407be654303772`.
  - SHA256 of the candidate raw report: `2d7665e8fe3991204f7f958fd8f1ec1562c7e823b6c2b8ca7bd82b26876dce2b`.
- Remaining `base-*.txt` and `candidate-*.txt` files: raw gate output.
- The two raw vitest JSON files (about 5 MB each) were not committed either.
  - SHA256 of the base file: `af0cb909…5dd5`.
  - SHA256 of the candidate file: `9f1a3a26…dce2b`.
