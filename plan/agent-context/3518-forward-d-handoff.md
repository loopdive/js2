# 3518 isolated forward D continuation

## Authority and isolation

The lead explicitly authorized ISOLATED FORWARD CONTINUATION under the user's
resume-killed-session/fanout request. This is not replacement or overwrite of
the unknown original D/evidence work. No claim was released, reclaimed, or
force-acquired. Original worktrees and branches remain intact.

- Worktree: `/Users/thomas/Code/js2/.codex-worktrees/codex-3518-forward-d-20260907`
- Branch: `codex/3518-forward-d-20260907`
- Recovered base: `651034e4fd295e826d73a769200279210b2b35e7`
- High specification: `9afe370642b2475434a21f68e73ce6af1e66c8a7`, last continuation
  section of the 3518 epic and the public-driver matrix in 3525.
- Stack dependency: [PR 5692](https://github.com/loopdive/js2/pull/5692), package C
  codec, consumer, physical planning and fresh-process replay. Its later
  published head `62285503f25059e7f5266cea46eec01defa82155` was reported to the
  lead before integration; D has NOT merged it. The parent composes the stack.

Read-only checks against `upstream/issue-assignments` returned both original
slice owners still CLAIMED (exit 3): `3518:application-evidence` by
`ttraenkler/luna-ir-evidence-d-20260905`, and `3518:evidence-runner-acceptance`
by `ttraenkler/astra-evidence-acceptance-b-20260906`. Bare 3518 was released,
which does not override either slice claim. The current open-PR list and C's
published file list had no duplicate D gate files.

Only these paths are owned:

- `scripts/check-ir-retirement.ts`
- `tests/issue-3518-public-retirement-gate.test.ts`
- `tests/fixtures/ir-retirement/manifest.json` and fixtures underneath
- this handoff

Compiler/observation authority, `check-ir-only`, CI, baselines, codec, consumer,
physical plans, replay, and B's async extraction were read only. No root
working-copy files were edited. Instructions were read from this repository;
the historical memory path in AGENTS.md is not the active checkout.

## What the checkpoint measures

The manifest pins seven fixtures and exactly 49 fixture/API/profile triples.
The scalar control covers compile, synchronous compileSourceSync, compileMulti,
compileFiles, compileProject, compileToObject and compileToWat. Profiles are gc,
gc-fast, standalone, standalone-fast, linear and WASI; compileToWat has its
actual source-only signature and therefore only the gc row. Namespace,
class/closure, dynamic code, CommonJS, scalar graph and separate async graph
each retain host and standalone obligations.

Fixture contents and an independently authored JavaScript oracle are hashed.
The oracle is executed and checked against pinned numeric expectations. The
input inventory is reconstructed independently of compiler outcomes and checked
against pinned source/kind/name/ordinal descriptors; the gate then compares
structural source/unit/owner identities to the actual public observations.
Every original source and terminal remains in the denominator on refusal.
Support and derived units are checked separately through original ownership.

Production phases come only from recovered `subscribePreparedIrProgram`.
Physical direct entry counts come from `irBodyRouteAudit.legacyEntries`, not
`legacyBodyEmitted`; discarded discovery passes remain counted. Missing
observation APIs, missing process output and malformed evidence fail closed.
The collector does not call preparation or emission to manufacture public
evidence. A/C-only dependency controls are labeled separately in the tests.

Each complete public entry runs in a fresh child process with a 55-second
deadline and explicit timeout evidence, bounding synchronous Wasm loops as
well as pending promises. Runtime execution uses `buildCompiledImports`,
`setInstance`, and `wrapCompiledExports`; live global reads use the real Wasm
global rather than a wrapper snapshot. Non-finite/undefined values retain
explicit JSON tags. Source, gate and corpus hashes accompany the report.

If a genuine public prepared snapshot becomes available, the unchanged C
fresh-process runner receives that exact snapshot for both backends at the
requested runtime target. It must return matching digests, nonempty execution
and receipt evidence, and a clean runtime import census. Global reads require
an actual global ABI target; C's existing compareExports reads Wasm globals
with empty arguments. Async scheduling is not supported by that synchronous
replay oracle and is reported as a precise adapter dependency.

## Validation and mutation controls

Before controls, executed on recovered base 651034e4fd:

- `node --import tsx scripts/check-ir-only.ts --policy=ir-only`: READY; each of
  two lanes has 5/5 entries, 41 terminals, 38 IR bodies, 3 non-executable rows,
  zero unsupported/invariant/legacy-final-body rows. This is the small existing
  corpus only.
- The public scalar control executes `calculate(5) = 17` and
  `calculate(-2) = -4` while recording direct declaration entry and no prepared
  program phase. A working binary is not retirement evidence.
- The namespace direct-route control executes `6` and `-1` and observes the
  actual direct module-init root.
- Final three-file single-fork suite: 39/39 tests (16 new gate tests, 14 existing
  IR-only gate tests, 9 existing whole-program route-audit tests).
- Focused formatting and Biome checks passed. The earlier repository TS5
  `--noEmit` source check passed. After the lead explicitly released A's slot,
  `pnpm run typecheck` passed; D reported that slot released immediately.
  A custom file-rooted TS7 invocation exposed
  its missing ambient augmentation/lib context; it is not a full-project result.

The complete collector now retains an explicit unavailable row on timeout,
malformed output, or any other per-entry process failure. A collection-only
control fails all 49 entries (no invented successes), proves all 49 were visited,
and checks that the last row survives earlier timeout/malformed children.

Mutations reject deleted/duplicate terminal rows, exchanged same-name source
identities, physical direct receipts beside false final-body booleans,
reordered/missing phases, skipped entries, zero corpus, duplicate triples under
new IDs, missing profiles, wrong source hashes, missing runtime rows,
always-green summaries, publication after failure, missing/malformed/nonzero
process output, non-resolving promises and synchronous looping Wasm. Real C
decode rejects removal of an actual runtime-manifest provider and a donor
runtime projection. The scalar control stays independently executable.

Real A/C dependency controls also execute both backends, run unchanged C replay
in a fresh process with an exported scalar global, reject a requested missing
standalone projection, and retain a located typed async refusal with the full
one-unit denominator and only a real prepared event (no accepted/emitted event).
No synthetic fixture or mocked collector is counted as public production proof.

## Remaining production requirements

Final measured command (same recovered compiler, new uncommitted D instrument):
`node --import tsx scripts/check-ir-retirement.ts` returned exit 1, `incomplete`.
The full per-entry/per-unit report is retained locally at
`.tmp/3518-forward-d/public-report-verified.json` and is reproducible with that
command. Its recorded compiler HEAD/base is 651034e4fd; no compiler change is
being attributed to D. Exact instrument provenance:

- Corpus SHA-256: `c42a1ab11113481f6a43c566cdd0c5be2bea750cf3249a9743670aee81c0a39b`
- Gate source SHA-256: `aaf698d54e6210d7f6aa3525df9bef7e0d625d4d75fe5071e328c504e03ecc5d`
- Entries: 49 expected, 49 accounted, 49 complete child-process results;
  39 compiler successes, 9 failures, 1 unavailable WAT success status.
- Original input denominator across those entries: 63 source instances,
  77 unit instances, 73 terminal instances. Observed terminal rows: 52/73.
- Physical direct dispatch: 158 entries across 32/49 available audits;
  unavailable audits are not counted as zero. Whole-program phases: 0 events
  across all 49 public entries. No public snapshot was available for C replay.
- Runtime: 84/116 expected call rows returned, 63/116 matched, and 30/49 entries
  had a complete matching runtime vector. Missing calls remain failures.
- The complete report has 280 located/structural failure reasons and no
  cross-process gate-hash mismatch.

Namespace returns 6/-1 on both targets with direct receipts. Class/closure
returns NaN on both targets. The host scalar graph exposes `__module_init`
(returns 102) but its re-exported state/helper/mutator are unavailable. The
standalone scalar graph fails direct-body certification at
`src/codegen/multi-prepared-scalar-leaf.ts:363`. Both async graph targets return
13 from `twoAwait(4)` while the re-exported graph surface is unavailable;
that single async value cannot erase the original graph denominator.

The completion command is expected to exit 1 and report **incomplete** on this
checkpoint. Do not wire it into required CI yet and do not describe a new
typed refusal as replacing supported direct behavior successfully.

Required follow-up remains with the existing owners: public production driver
cutover; complete prepared source population; authenticated runtime/provider
and layout coverage; exact all-target route telemetry; public typed refusal
and prepublication evidence; linked object and WAT execution/audit adapters;
startup-order, throw-payload and async-scheduling evidence over the complete
application graph; C fresh replay for each target; full conformance and final
reachability/deletion audits. In the source-mode Node ESM harness, compileFiles
currently reaches `src/checker/index.ts::analyzeFiles`'s `require("node:path")`
and throws `ReferenceError: require is not defined`; this is a located runner
dependency, not a measured migration regression.

Runtime mismatches in the larger graph/class rows are reported as observations,
not automatically attributed to a compiler regression. Parent shepherding and
integration with C's later head remain explicit. No merge, main push, baseline
change, force push, signing override, hook bypass, or manual stash operation
was performed by this continuation.
