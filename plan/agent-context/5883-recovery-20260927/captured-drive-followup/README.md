# Captured-drive immediate extraction checkpoint

2026-09-27. Held recovery data, not production acceptance or retirement proof.

The authoritative integration tree remains
`/private/tmp/js2-5883-main-6eac-20260927`, HEAD
`fda4b498696f395889e199756c6b8c27a629387c` plus preserved repairs. The increment
here applies after the `main-fa6b-resume.md` state; reverse-applicability against
the actual integrated files passes. Do not apply it twice.

`extraction-increment.patch.txt` SHA-256:
`20f1f751b83500302a3cf4fcdaeb31251143ffa6826405fe4b30d08cf6f80c55`.
It changes only `promise-combinator-drive.ts` and adds
`issue-5883-captured-drive-extraction.test.ts`. Parent formatting is included.

## Actual change and remaining boundary

The existing ordered registration, attached effectful prologue and iteration
tail are separate immediate functions. Private owner records authenticate
resources and frame use. The old algorithm, options validation, argument
evaluation, flush points and legacy callers remain. The tail still allocates
locals and materializes fixed short string globals. All-completion retains its
late async preparation and local allocation at the historical checkpoint.

This is NOT an allocation-free detached renderer, canonical provider receipt,
pending-operation integration or complete IR program. Constructor preparation
and full provider/binding ownership remain required. No fixture, expected
failure, acceptance floor or allowance was changed.

## Measured validation

- Nine new orchestration tests: **9/9 pass**, first execution; mocks do not prove
  real constructor/provider closure. Report `.tmp/captured-extraction-unit.json`,
  SHA-256 `a847c2baaab092303d47519f595dd06e06af85e1de5411dc26b022c64a0c0410`.
- All four unchanged runtime suites: **113/136 pass, 23/136 fail**, before and
  after. Compared all 136 unique full test names, statuses and failure-message
  arrays in the SAME worktree; zero differences, no normalization. Four null
  failure details remain in each arm and do not prove unknown exception values.
  Baseline `.tmp/main-fa6b-runtime-baseline.json` SHA-256
  `f864e833d19d5460a9143d38357f581d1486e0e3a2a0a29dfc6950e2387a62a1`;
  candidate `.tmp/captured-extraction-runtime-after.json` SHA-256
  `35003fbc16bdc3148911b845427c39cabef50ef5ebec396a09a57a3b7e881455`.
  Original raw reports and fixture files remain in the integration worktree.
- Source TypeScript 7 plus the nine ownership/editor/conversion/extraction test
  files: exit 0, `.tmp/captured-extraction-typecheck.log`.
- File/function size checks and diff whitespace check pass; no new grants.

A real-emitter paired observer now passes on all six routes: all/race crossed
with captured observable, legacy observable and legacy plain. Both arms compile
and execute all six unchanged sources successfully, with zero Wasm imports.
Full entry-before/entry-after module/caller snapshots, WAT and binaries match
exactly. Native and Wasm results match (all=12, race=1). See
`drive-comparison.json`, `drive-observer.test.ts.txt` and
`drive-comparator.mjs.txt`. No dependency was replaced with a mock; one
pass-through spy calls the actual drive once per route. Internal loop-only
registration remains UNKNOWN; this proves whole-entry preservation, not an
allocation-free tail. Observer neutrality against an unobserved compile was
not independently measured.

Both arms used the SAME fa6b tree and original constructor wrapper, changing
only the drive file. Sessions 99919 and 29788 both exited 0. Raw artifacts are
retained in `.tmp/drive-real-before` and `.tmp/drive-real-after` (do not print
full snapshots/WAT). The manual observer was moved out of automatic test
discovery afterward into `.tmp`; its exact executed version is archived here.
Every original fixture is retained. Candidate drive and constructor wrapper
were restored and their hashes checked after these comparisons.

## Independent work in progress

Mendel's constructor single-construction/transfer patch was integrated and
validated SEPARATELY, not mixed into the drive comparison. Hume source review
found no immediate-scope blocker. All eight additive tests pass, including
exact operands, nested retention and nonempty-destination exception cleanup.
It fixes deletion of borrowed `liveBodies` membership; it does not provide a
delayed lifetime or new ownership arena. The actual seed implementation stays
unchanged, and constructor publication remains before seeding.

`constructor-increment.patch.txt` SHA-256
`a079498917c0bd33bbd0ee31d8be4124cf1c3424164e1c4652bda739bb421b58` includes the
two production files, eight-case test and explicitly unmigrated inventory
entry. Reverse-applicability passes. Parent's unchanged real-constructor
observer compares 24 records (six builtins, cold/reserved, first/repeated):
complete module, caller and ordered-map hashes match exactly. Both JSON files
hash to `d28810b33883cf4f0336f22df4845abcd37212f56de31c8069cf1e82198a9ef7`.
See `constructor-observer.mts.txt`, `constructor-before.json` and
`constructor-after.json`. This is not arbitrary relocation or runtime proof.

Existing constructor suites 2984 and 3006: 24/25 pass, one failure, on both
candidate and same-main baseline. All 25 recorded names/status/failure arrays
match. The dynamic non-writable-property test remains failing, with null error
detail on both arms. Candidate-first report `.tmp/constructor-legacy-first.json`
and baseline `.tmp/constructor-legacy-baseline.json` are retained. The baseline
temporarily restored only the original constructor wrapper; candidate was
restored afterward. Source plus ten focused test files typecheck successfully.
Inventory is valid with zero errors but architecture incomplete; size checks
pass without new allowances. No compiler retirement is justified.

Fresh production reachability audit still fails with the same two nonliteral
dynamic-import targets and 16 newly unreferenced functions (mostly unwired
staging helpers). Core-node observations pass 12/12 with dispatch-cut UNKNOWN;
core-type references pass 10/10 on both views. No baseline was refreshed and
no dummy production references were added. Full log:
`.tmp/captured-constructor-reachability.log`. Conversion/checker ratchets pass.

Russell established PR 6154's old CI failure exhausted a 512 MB worker before
assertion results. Main already contains the 1024 MB job setting from PR 6161.
An isolated merge-tree of PR head `1b919ba1bb1afe079101320d3d25aac21bde0901`
with pinned main `46c10411d69c8e18b6e36c2ff09bbe08069f0711` is conflict-free.
Russell completed isolated merge `c8b56c0215ea383ecdf6798037449386454009d4` and
the exact 16 pinned files: 278 rows, 276 passed, 0 failed, 2 existing skips.
Both merge and test processes are terminal; compiler slot returned. Source and
fixture hashes before/after are identical. Local Node 22/macOS differs from CI
Node 25/Linux, so this is not CI proof or a heap-only causal comparison. No
original author branch, PR config, queue state or ownership was changed. Parent
asked whether the original Claude owner remains active before branch adoption.

The old compiler remains until the new IR path is fully implemented and proven
equivalent. All broader closure, original-failure and retirement gates remain.
