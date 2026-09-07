---
id: 5382
title: "Publish Temporal synthetic projects atomically and keep published source trees immutable"
status: ready
sprint: current
created: 2026-09-07
updated: 2026-09-07
priority: high
horizon: s
feasibility: medium
reasoning_effort: low
task_type: bug
area: compiler
language_feature: Temporal
goal: correctness
---

# Publish Temporal synthetic projects atomically and keep published source trees immutable

## Ownership and scope

This is the Astra High repair specification for an Astra Low implementer.
The identifier was reserved by `claim-issue.mjs --allocate --by
ttraenkler/astra-temporal-publication-spec --json`; the allocator reported an
upstream-verified reservation and successful open-PR scan. No implementation
claim is implied. The existing claim on issue 5353, **Wire the SHARDED test262 CI
lane to the compile-once Temporal provider so the published conformance number
includes Temporal**, remains its owner's responsibility.

Source inspected at `6a6eb9a8ac40035cd965ddff48d4fa52d6c2d597` on
`upstream/main`. This specification is an independent documentation change,
not a stack containing either diagnostic snapshot or an implementation.

Own the synthetic source materialization in `src/temporal-provider.ts` and
focused tests in `tests/issue-5382-temporal-project-publication.test.ts` plus
an issue-specific child-process fixture if required. Keep helpers private to
the provider module unless a test seam is demonstrably necessary. Do not edit
the package linker, compiled-provider cache, worker gate, prewarm stamp,
baseline, workflows, runtime Temporal semantics, or another owner's files.
Do not reopen 5353 to hide this separate materialization defect.

## Evidence and limits

Popper's complete evidence is the local report
`/tmp/js2-5683-diagnosis.Vrp0Rw/init-interleaving.qbyW0T/report.md` and its
referenced per-arm logs. The architect read that report; these measurements
are Popper's, not a newly executed architecture-spec test run.

The experiment used saved original bundles, Node 25.9.0 on Darwin arm64,
at most two processes with 768 MB heaps, and warm per-snapshot provider
caches. It rebuilt no bundle and ran no Test262 corpus. Both snapshots were
tested: baseline `24681afc1ee2146e2317f81df2404a710f884e52` and merge-group
candidate `2babfc21ec5b97a54e7f399d5c7ee232e77fdde5`.

Each reader completed all three synthetic writes, then paused before its
first real source read. A second initializer opened either the entry or
polyfill file with `w`, genuinely truncating it, and paused before writing.
The first process resumed and read zero bytes through the production reader.
After it failed, the second process resumed the original write and succeeded.

- Entry truncation: 0 of 121 expected bytes, followed by
  `Temporal provider was not linked separately (plan=none)`.
- Polyfill truncation: 0 of 157546 expected bytes, followed by
  `Temporal provider was not linked separately (plan=bundled, reason=@js-temporal/polyfill does not expose Temporal)`.
- Across both snapshots: sequential and all-writes-complete controls succeeded
  8/8; forced-interleaving readers failed 4/4; resumed writers succeeded 4/4.
  All 16 initializer processes exited normally after reporting their result.
- All 12 successes reported `cacheHit: true` and the same 2,072,630-byte
  provider, SHA-256
  `dc7b1f20d88af74531635c0e793328151130b1d89c88049f4f10bf21995d3630`.

Expected evidence-file SHA-256 values: entry
`e47a1e52f675fd6a8dbbd69944ac941d07a4c424aa50012ae6754e86ddddbdd9`,
polyfill `68b811af28240d9ac917c7c26628d7794190e0e367e791b150b5a527cda9e7be`,
75-byte package metadata
`06282976de72920b850c57b0e444532b4256614a1e56cefb83d4f255dcd38d1d`.

This proves a possible initialization failure mechanism in both snapshots.
It does not establish the cause of the original PR 5683 CI run, attribute
every affected row to the race, or establish a candidate-only regression.
The experiment did not exercise downstream worker error memoization or
ambient fallback. Keep those boundaries in the implementation PR report.

## Existing failure mechanism

`buildTemporalProvider` checks its process-local memory cache, computes
`temporal-project-${key.slice(0, 16)}`, then writes package metadata, polyfill,
and entry directly into that shared directory on every disk-backed call.
Only afterwards does `compileProject` traverse it. A warm binary cache does
not avoid that module-graph read. Another process can truncate a source file
while the first compiler is reading the shared tree.

Writing temporary files and renaming each file individually is insufficient:
the project is the publication unit. `existsSync` followed by the old writes
also races. A process-local pending-promise map cannot serialize independent
workers. None of these is the accepted repair.

## Implementation plan

### Identity, bytes, and migration

Leave `temporalProviderCacheKey`, its length-prefixed hashing, and
`providerOptionFingerprint` unchanged. Preserve every forwarded compile
option and the existing forced `allowJs`, `emitWat`, and semantic-diagnostic
settings. Preserve `packageCacheDir = path.join(cacheDir, "providers")`.
The synthetic layout version must not enter the provider/prewarm identity.

Use a distinct deterministic final path, for example
`temporal-project-v2-${key}` under the same caller-supplied cache directory.
Use the complete existing key. Never reuse the legacy mutable
`temporal-project-${key.slice(0, 16)}` path: a concurrently running old bundle
can continue rewriting it. Do not rename, repair, or delete legacy trees.

Build the expected three-file map once per call from the current inputs:
`__js2wasm_temporal_entry.js`,
`node_modules/@js-temporal/polyfill/package.json`, and
`node_modules/@js-temporal/polyfill/index.js`. Preserve their current exact
UTF-8 bytes, including metadata formatting and the two entry newlines.
Do not normalize source text or add a generated file inside the package
that changes its discovered source set. No source text belongs in errors.

The linker currently computes `packageFileKey` relative to the package root
and hashes those keys with source contents, dependency identities, ABI
versions, and compiler options. Moving the synthetic parent therefore
should not invalidate provider fingerprints. Verify this with the migration
control below; do not alter the linker if that expectation fails without a
new scoped investigation.

### Complete verification and atomic publication

Introduce a private materialization helper returning only a verified final
entry path. It must complete before calling `compileProject`.

1. Ensure only the caller's cache directory exists. If a final project is
   present, verify the directory structure and all three expected files as
   regular files with exactly the expected bytes. Reject symlink substitutions
   for the project, package path, or files. A matching key in a filename,
   entry existence, nonzero length, or a marker alone is insufficient.
   On a valid warm tree, perform no writes to that tree. Missing files within
   an existing tree and byte mismatches are corruption errors, not cache
   misses to repair in place. Other filesystem errors retain their causes.
2. When the final root is absent, allocate a uniquely named private staging
   directory with `mkdtempSync` under that same cache directory, e.g.
   `.temporal-project-v2-${key}.staging-...`. Create and write all three files
   only there. Close writes and verify the complete staged tree. No compiler
   or other initializer may consume this private path.
3. Publish with one directory `renameSync(stagingRoot, finalRoot)`. Never copy
   on `EXDEV`, remove the destination to make rename succeed, or fall back to
   writing destination files. Same-parent staging is required, not an OS
   temporary directory that might reside on another filesystem.
4. A complete published tree is nonempty. Concurrent directory rename cannot
   replace that valid nonempty winner. A losing initializer may reuse the
   winner only after full verification against its own expected bytes.
   Recognize directory-collision errors (`EEXIST`/`ENOTEMPTY`, with a tested
   platform-specific equivalent if necessary); do not catch every filesystem
   exception and report a cache hit. If collision verification fails, reject
   before compilation and preserve useful original error/cause information.
5. After a successful rename, verify the final path as well, then pass only
   its entry path to `compileProject`. The precheck in step 1 is an
   optimization; the rename and winner verification establish correctness.
   There is no exists-before-write window on published source files.

Be precise about directory rename semantics: some platforms can atomically
replace a concurrently created *empty* destination. Such a directory is not
a valid published winner. This outcome may publish the entire verified tree
atomically; it must never result in partial source reads. An invalid tree
observed during warm verification is rejected. The contract does not claim
that ordinary Node rename provides a general no-replace primitive for every
invalid filesystem object. Test the empty-destination race explicitly; do
not implement locks, lock stealing, or a pointer protocol merely to claim
stronger semantics than this repair requires.

### Errors, lifetime, and cleanup

Only delete the unique staging directory created by the current invocation,
and only if it was not successfully renamed. Track that ownership directly;
do not derive cleanup targets by scanning prefixes. Leave published winners,
legacy paths, another initializer's staging tree, and the provider cache
untouched. An abandoned staging tree after process death is harmless because
no reader discovers it. Automated stale-tree scavenging is out of scope.

Cleanup after write/verification/rename failure must not mask the primary
failure. If cleanup itself fails, preserve that information without treating
the build as successful. Cleanup failure after losing to a valid winner is
still an operational failure; do not silently discard it. A compile failure
after successful publication leaves the complete immutable tree for a retry.

Preserve the existing compilation/link-plan/artifact/getter errors and
successful memory-cache behavior. Do not insert a failed build or partially
constructed provider into memoryCache. No new retries, swallowed errors,
bundled fallback, or change to `cacheHit` semantics: `cacheHit` describes the
compiled provider, not whether synthetic sources already existed.

## Deterministic verification contract

Implement controlled filesystem barriers in a child fixture or an injected
environment filesystem. Use explicit acknowledgements and bounded timeouts,
not timing sleeps or a high-concurrency stress run as the proof. Record
whether each barrier was actually reached; a missing observation must fail.
Keep per-test paths private and avoid running expensive compiler suites in
parallel with another owner's pre-push checks.

- **Cold private writes:** pause initializer A after each of the three
  staging writes, in separate cases. B must publish a complete project and
  proceed; A resumes, verifies that same winner, and proceeds. The compiler
  seam records every consumed path and all three observed file bytes. No
  consumed path contains the staging prefix, and no observed file is partial.
- **Two completed contenders:** pause both after staged verification, allow
  B to rename, then A. Both consume B's complete final tree; only A's private
  stage is cleaned. Repeat with A winning. These are independent processes,
  not calls serialized by one memory cache.
- **Warm reader versus initializer:** publish a valid tree; pause A at the
  real entry/polyfill read, run B's warm initialization, then resume A.
  Instrument write-open/truncate/rename/remove calls on the final tree and
  require zero. Both initializers see the exact original bytes. Cover entry
  and polyfill separately, reproducing the old failing schedule's boundary.
- **Partial/corrupt winner:** independently seed missing entry, missing
  polyfill, truncated entry, truncated polyfill, wrong package metadata,
  same-length wrong content, an empty project root, and a symlink replacement.
  Each observed warm invalid tree is rejected before compile and is preserved.
  For a nonempty invalid tree inserted just before A's rename, collision
  verification must reject and clean only A's stage. Also insert an empty
  destination at that boundary: accept only whole-tree atomic publication
  followed by complete verification, or an explicit failure before compile.
- **Error ownership:** inject staging mkdir/write/read failure, rename
  `EXDEV`/permission failure, verification read failure, and cleanup failure.
  Assert original failure/cause, no compiler call on materialization failure,
  and no deletion outside the invocation's stage. A sibling stage survives.
  Simulated process death during staging leaves a tree that a later process
  ignores while independently publishing successfully.
- **Migration/cache compatibility:** using one pinned source and fixed
  compile options, prewarm with the old layout/bundle, then run the repaired
  initializer against the same `cacheDir`. Require the unchanged
  `temporalProviderCacheKey` and prewarm-stamp key, provider source fingerprint,
  artifact cache key, namespace, export/getter contract, and binary SHA-256;
  require a real provider cache hit. The new project path is versioned and
  the old path's bytes and metadata are untouched. Run an old initializer
  while the new reader is paused to prove the old path cannot truncate the
  new tree. Do not make the historical binary hash above a permanent compiler
  golden; compare baseline and candidate with identical compiler inputs.
- **Identity separation:** changed source and each existing fingerprinted
  option select the corresponding unchanged key and independent new-layout
  path. Unchanged input reuses the immutable tree. Exercise an attached
  provider-memory-cache hit separately from a disk hit in a fresh process.

The cheap barrier tests may stub `compileProject` to inspect consumed bytes,
but report them separately from at least one real linked-provider migration
and interleaving control. That real control must assert a separate link plan,
artifact/getter availability, nonempty binary and exact cache provenance;
process exit zero alone is not success. Reuse existing Temporal test helpers
and pinned source acquisition without adding network access to production.

Run the focused new tests, existing issue-5353 sharded-lane tests, and the
relevant existing Temporal wiring/provider controls plus normal required
hooks. Report exact denominators, compiler/runtime version, input hashes,
baseline/candidate SHAs, and any unexecuted heavy controls. No Test262 score
or resolution of PR 5683 is claimed from these tests alone.

## Acceptance and handoff

The implementation is complete only when no initializer writes published
synthetic source, both cold contenders and warm readers observe complete
trees, corrupt winners fail before compilation, old/new processes use
disjoint synthetic layouts, and compiled-provider identity/cache reuse is
unchanged. The PR must contain only the scoped source/test repair and this
issue's measured completion record, pass normal hooks, and retain other
owners' claims and worktrees. At specification authorship, none of the proposed
repair controls had run; the implementation measurements below supersede that
specification-only state.


## Measured implementation handoff — Astra Low, 2026-09-07

Implementation worktree: `/private/tmp/js2-5382-temporal-publication-impl`.
Branch: `codex/5382-temporal-atomic-publication`.
Fresh upstream baseline verified with `git ls-remote upstream refs/heads/main`:
`ec6d2efc3241e8698b0755983491a85ebcbca5eb`.
The upstream claim for 5382 is verified for
`ttraenkler/astra-low-temporal-publication`; issue 5353 is not claimed or changed.

The source change is confined to `src/temporal-provider.ts`: private complete
staging, full-key versioned publication, directory and exact-byte verification,
collision verification, and invocation-owned cleanup with original error causes.
The provider fingerprint function, compile options, binary-cache location,
linker, worker, prewarm contract, workflows and baselines are unchanged.

Focused tests live in `tests/issue-5382-temporal-project-publication.test.ts`;
the independent-process fixture is
`tests/fixtures/issue-5382-temporal-publication-child.mjs`.
Cheap tests use a stubbed compiler observer, real filesystem operations and at
most two 192 MB children inside one 512 MB Vitest fork. Barriers acknowledge
their arrival and block on parent input with a bounded parent deadline.
These tests do not claim real provider compilation or conformance results.

The initial checkpoint was `8c3629d4f13231ad142958efe062373cb8593432`.
Its Node 22.23.2 run had 50 passes and one required real control skipped; that
was explicitly not acceptance. The parent subsequently released the heavy slot.
The following Node 25.9.0 / Darwin arm64 measurements supersede that skip:

- Publication file: **33/33 pass, none skipped**, including the real linked
  migration and both old/new compiler-read interleavings (32.29 s total).
- Existing controls: **29/29 pass**, comprising issue4628 provider/global
  controls (11), issue5353 sharded-lane controls (14), and issue5248 wiring (4).
  The issue4628 heavy child built a fresh provider (`cacheHit: false`), then
  all **25/25 supported runtime probes** passed. Its three existing known-gap
  observations remain reported, not silently promoted to supported tests.
- Total: **62/62 distinct tests**, none skipped in these verification runs.
  TypeScript compiler dependency 5.9.3; Vitest 3.2.4. One Vitest fork, no file
  parallelism; real initializer heaps 768 MB, at most two initializer processes.
  These are local host-lane checks, not CI or a Test262 corpus measurement.

The old builder was read directly from git blob
`ec6d2efc3241e8698b0755983491a85ebcbca5eb:src/temporal-provider.ts`, source SHA-256
`674d7c12e519d92c802362cc722cb7559ada3b8e575fd02def780f0df17f6fea`.
Every other compiler source and dependency was identical to the implementation
worktree. The test bundles use the same esbuild options, environment exports,
and require shim; no historical compiler revision was mixed into this A/B.
The preserved original bundle (`4ba1c719…`) had a duplicate `createRequire`
banner declaration and could not load. The corrected old bundle is
`.tmp/issue5382-baseline-provider-v2.mjs`, SHA-256
`bfdf8cfa2b093579285367f43661c299850853b3c81f4161160816af8375104e`.
The first executable run also correctly refused acceptance when a noncanonical
macOS temporary path prevented its compiler-read barrier from being reached.
Canonicalizing the test root fixed the instrumentation, not production code.

Exact real-control provenance:

- Polyfill source: 157546 bytes, SHA-256
  `68b811af28240d9ac917c7c26628d7794190e0e367e791b150b5a527cda9e7be`.
- Unchanged provider/prewarm input key:
  `372a41be9bdeb22ade63a811b4b26afce75694ee0d9b7cf928c24ddad739020b`.
- Unchanged linker source fingerprint:
  `3fac10330db10667fdc54b9f775538cf546827af564bb6efea22e05b2f377ceb`.
- Provider: **2090802 bytes**, binary SHA-256 and artifact cache key
  `2d1e8f3deda3fbdab06bcdf204113dc99793d3abeec27507723c23aa25cf5e37`.
- Namespace: `js2wasm:npm:@js-temporal/polyfill:2d1e8f3deda3fbda`;
  getter: `__js2wasm_get_Temporal_ba822575`; 901 binary exports agree exactly.
- Old cold build: cache miss. Repaired migration: real cache hit. Both resumed
  repaired readers and both old warm initializers: real cache hits. All six
  builds succeeded with the same artifact identity.
- Entry and polyfill compiler-read barriers were both acknowledged. Each
  repaired reader recorded 10 actual reads, all matching complete expected
  bytes (entry 121, package metadata 75, polyfill 157546). Old initializers
  performed their production legacy writes while each new reader was paused.
  New readers performed zero mutations of the published tree. Initial
  migration preserved all legacy file bytes, inode/mtime/ctime, provider ref
  contents and prewarm stamp bytes.

Reproduction: set `ISSUE5382_BASELINE_BUNDLE` to that exact old bundle and
`ISSUE5382_REPORT` to a private report path, then run the focused publication
file under Node 25.9.0 with `VITEST_MAX_FORKS=1`,
`VITEST_FORK_MAX_OLD_SPACE_SIZE=512` and `--no-file-parallelism`.
The report is `.tmp/issue5382-real-migration.json`; the existing end-to-end
report is `tests/dogfood/report/temporal-global.json`. They are local evidence,
not committed generated artifacts. Default CI invocation leaves the explicitly
opt-in migration test skipped; the manual required acceptance run above did not.

Normal checkpoint hooks passed: prettier, lint, LOC/function budgets,
changed-root publication tests and oracle ratchet. The first commit-message
attempt rejected shorthand `Model: Astra Low`; inspecting its rule and using
`Model: Codex Astra Low` passed without bypass. Full `pnpm run typecheck`
(the repository's TypeScript 7 lane) exited 0. Full `pnpm run lint` exited 0
at its configured error threshold. `pnpm run sync:conformance:check` passed
with 0 updates / 5 unchanged files. Normal pre-push/publication results remain
to be reported; no hook bypass or signing-configuration change is authorized.

Original issue5683 diagnostic snapshots and reports remain untouched. Neither
this implementation nor the prior forced schedule proves the original CI cause.
The initial fresh checkout reported an unrelated Acorn LFS-pointer anomaly at
`website/public/acorn/acorn.wasm`; it is not part of this change.
