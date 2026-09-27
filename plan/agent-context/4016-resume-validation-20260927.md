# #4016 resumed validation contract — 2026-09-27

## Recovery and ownership

The user selected #4016 for continuation. The saved implementation commit is
`1fb196048b26b9a686eaf5a4719cc646a1d1353a`; upstream main fetched for the merge
is `44c2fb086278cd6d0b24efdaa061112452f901f1`.

The former `/private/tmp/js2-4016-split-coercion-order-20260920` directory no
longer contains its Git link or tracked source. Its `.tmp/4016` directory is
empty. The cause is unverified. Historical receipts quoted in the issue must
not be represented as currently available raw logs or fresh measurements.
The committed implementation, issue narrative, and test fixture survive.

Recovery uses the persistent isolated worktree
`/Users/thomas/Code/js2/.codex-worktrees/codex-4016-resume-20260927`, branch
`codex/4016-resume-20260927`. The old directory and shared dirty main checkout
were not removed, reset, or stashed. Initial merge conflicts were the issue
Markdown, `string-search-value.ts`, and `string-proto-split.ts`.

A separate clean comparison worktree is pinned to that exact upstream commit
at `/Users/thomas/Code/js2/.codex-worktrees/codex-4016-baseline-20260927`.
Creating it is preparation only: no baseline test result is yet claimed.

`4016-split-neighborhood-20260927.txt` freezes 121 existing corpus paths under
the ordinary and Annex B `String/prototype/split` directories. This is an
all-editions collateral cohort, not an ES2015 denominator or a result. It
includes later-edition controls deliberately. Verify runner discovery and
report every excluded path rather than treating manifest length as executed
test count. Add other affected string-method controls when the final diff is
known; this directory cohort alone does not cover the whole coercion engine.

The original implementation agent owns reconciliation and the split fix.
The coordinator owns this validation contract. Other-session IR and Promise
work remains out of scope. Tests, builds, and commit/push hooks require the
coordinated execution slot; dependency provisioning alone is not a test run.

The IR task's completed coordination response subsequently confirmed that
its current assignments do not include `coercion-engine.ts` and its test slot
is free. This is scoped clearance from that task, not a repository-wide claim.
The agreed minimal staged-coercion engine API may proceed in this worktree;
registry, context-layout, and IR ownership restrictions remain unchanged.

## Required evidence before a completed fix

1. Resolve the three-way merge preserving newer upstream semantics, not by
   wholesale replacement with checkpoint files. Record any superseded code.
2. Preserve the old fixture as historical evidence. Correct the invalid
   receiver-order expectation: the old receiver has no `.split` method.
   Independently verify direct, borrowed, nullish, and abrupt-call oracles.
   Do not describe removing an invalid expectation as a conformance gain.
3. Route new coercion through the shared engine. The previous publication
   blocker was five new low-level coercion references; an allowance granted
   only to clear that check is not a fix.
4. Run the same corrected fixture on clean upstream and the reconciled
   candidate, recording exact commit/source hashes, Node version, target,
   compiler settings, discovered test names, and each outcome transition.
5. Validate original corpus rows through the current authoritative whole-
   assembly runner. `tests/test262.test.ts` is a legacy non-failing report;
   a green Vitest exit from it does not establish conformance. A dynamic
   chunk without explicit shard variables is an inert skip, not evidence.
6. Freeze the exact selected corpus paths, including passing controls for
   shared string operations. Verify registered tests, recorded canonical
   verdicts, and started/settled callbacks against the expected set using
   the repository completeness validator. Preserve skips, compile errors,
   infrastructure failures, and newly exposed failures explicitly.
7. Do not alter `registry/imports.ts`, IR, or context layout without renewed
   ownership coordination. Reproduce the historical undefined-index issue
   on current code before assuming that diagnosis still applies.
8. Complete normal quality gates and open the fix against `loopdive/js2`.
   A checkpoint with genuine remaining defects is draft; a completed fix is
   ready. No full ES2015 pass-rate claim follows from a focused split cohort.

The full goal remains zero failures for the complete authoritative ES2015
standalone suite; this contract defines one implementation's evidence, not a
replacement goal or a reduced final denominator.

## Corrected receiver oracle receipt

Node v24.19.0 independently produced all five expected S2v2 outcomes on
September 27. The original direct object call throws TypeError after argument
evaluation (order `1234`): the receiver has no callable `.split`. The valid
direct call returns `1234672`; the borrowed call returns `12345672`; the
borrowed nullish receiver throws TypeError after one argument call; and the
borrowed abrupt receiver preserves thrown value `29` and order `12345`.
The raw local receipt is
`.tmp/4016/receiver-oracle-s2v2-20260927.node24.log`.
These are reference-runtime oracle checks, not compiler or Test262 passes.
Paired compiler execution remains required before claiming improvement.

## Initial compiler validation, not yet paired

The first focused candidate attempt exhausted Vitest's default 512 MB child
heap before semantic results. `NODE_OPTIONS` alone did not override that
worker setting. Retrying with the maintained
`VITEST_FORK_MAX_OLD_SPACE_SIZE` override at 2 GB produced 61 verdicts:
52 passed and 9 failed across two test files. The receipt is
`.tmp/4016/focused-engine-s2v2-candidate-2gb-20260927.log`.
This combined count includes additional coercion controls; it is not a
61-path Test262 cohort.

Failures include direct-object argument order, borrowed receiver coercion,
borrowed nullish compilation, borrowed abrupt completion, a bare-Symbol
invalid Wasm boundary, the descriptor-before-split host boundary, a new
non-split numeric control, and two existing refusal expectations. No failure
has yet been attributed to the candidate: run the identical fixtures on
pinned upstream before classifying regressions or gains. Keep the original
failed-attempt receipt separately; neither attempt establishes readiness.

The subsequent identical-input upstream run at `44c2fb0862` completed with
45 passed and 16 failed out of the same 61 tests. The candidate comparison
therefore has seven failing-to-passing transitions and zero passing-to-failing
transitions. Baseline receipt:
`.tmp/4016/focused-engine-s2v2-baseline-44c2-2gb-rerun-20260927.log`
in the clean baseline worktree. Both fixtures were copied verbatim for this
comparison. Failing-to-failing changes still require attention: a raw receiver
boundary changes from a null dereference to wrong argument order, and a
Symbol callback boundary changes from a wrong value to invalid Wasm.
The non-split numeric probe fails on both sides; this does not establish its
cause, and its numeric result must be isolated from its descriptor read.
The nine residuals prevent treating this checkpoint as validated completion.

After isolating the numeric controls and correcting only the nullish fixture's
TypeScript overload cast, the S2v3 pair reached 48/62 baseline and 55/62
candidate passes. A subsequent narrow standalone/WASI borrowed-split fix in
`emitReflectiveNativeProtoClosureCall` preserves surplus argument evaluation
before entering the builtin. With a new abrupt-extra control added identically
to both arms, the S2v3b comparison is 48/63 baseline versus 58/63 candidate:
10 failing-to-passing transitions and zero passing-to-failing transitions.
All three borrowed surplus-argument controls now pass. Five failures remain:
two historical refusal pins, the raw direct-object boundary, the host
post-ToPrimitive Symbol invalid-Wasm boundary, and the descriptor host boundary.
These remain focused compiler results, not authoritative Test262 measurements.
The issue file owns exact fixture/log hashes and implementation attribution.

## Authoritative runner preparation

The resumed candidate passes the scoped coercion-site check and TS7 typecheck.
Fresh bundles and official QuickJS provider setup are now available on both
arms. Initial setup exposed network access and the default `clang-18` executable
name, not semantic failures. The supported `CC`, `AR`, `RANLIB`, and `NM`
overrides use existing Homebrew LLVM 18.1.8 tools with one build worker.
No replacement runner or newly installed toolchain was used.

The official artifact build completed and its adapter canary passed. Artifact
key: `2e2d7736713beeda`; artifact SHA256:
`e9f8d30bc347dbc56f31b3389f7696eb6dedc9f05ea729781fc412f09a3e6b17`.
The candidate adapter key is `e06931058693cbff`, while the separately built
baseline adapter key is `6dfa2dab8d8bfa0d`. Do not confuse those compiler-keyed
adapters with the shared underlying artifact. The exact 121-path paired run
uses the maintained dynamic chunk runner with explicit shard `0/1`, standalone
target, one worker, and the tracked manifest; completion validation is required
before interpreting its results.

Both authoritative 121-path runs completed with 121 registered tests, 121
canonical verdicts, all callbacks settled, and zero exclusions. Baseline:
119 pass / 2 fail; candidate: 120 pass / 1 fail. The sole gain is
`test/built-ins/String/prototype/split/separator-undef-limit-zero.js`, which
the frozen edition index labels Unclassified (untagged). The remaining
`test/annexB/built-ins/String/prototype/split/custom-splitter-emulates-undefined.js`
failure is labelled ES2027. The exact ES2015 intersection contains 12 paths,
all passing on both revisions. Therefore this measurement proves one broader
split conformance gain and ES2015 preservation, **zero measured ES2015 gains**.
It does not satisfy or reduce the full 11,778-path goal.

Candidate raw results:
`benchmarks/results/issue4016-split121-candidate-results-4016split121candidate20260927a.jsonl`.
Baseline raw results (baseline worktree):
`benchmarks/results/issue4016-split121-baseline-results-4016split121base20260927a.jsonl`.
Each worktree retains its `.tmp/4016/test262-split121-*-completeness.log`.
The candidate edition comparison also confirms no pass-to-nonpass transitions;
its default 11,704 ES2015 denominator is not the full-goal scope authority.

## Full-goal discovery warning

The independent read-only audit of pinned upstream `44c2fb0862` identifies
the 74-row difference between 11,778 and 11,704 as ES2015-labelled
`test/intl402/**` paths: the default runner category list omits that tree,
while the edition index retains those rows. No exclusion policy has yet been
established by this audit. Keep the original goal population intact and record
these rows as unmeasured until authoritative discovery/execution accounts for
them. A full pass of the 11,704-row default cohort alone cannot establish the
requested 100% goal. This warning is independent of the focused #4016 cohort.

The audit subsequently reconstructed the sorted, newline-terminated ES2015
edition-index paths (without the `test/` prefix). Their SHA256 is exactly the
historical frozen manifest hash
`f2fdd4e4544a44608f0b53d89d343526cfa9c9044ca263e860da949dc1a2f59f`.
The pinned corpus remains `b363f29d3c43c626dc852744ad64a0b48a003693`.
This establishes set identity, not merely equal counts. The authoritative
runner's discovery must account for the 74 `intl402` rows before full-goal
completion can be established; no test result for those rows is claimed here.

The exact omitted paths are preserved in
`4016-es2015-undiscovered-intl402-20260927.txt`. They are ES2015-labelled by
the repository's edition index; this does not assert that every named Intl
API was introduced in ES2015. Source evidence at the pinned main:
`tests/test262-runner.ts` (`TEST_CATEGORIES`, `findTestFiles`),
`tests/test262-shared.ts` (category-driven registration), and
`scripts/validate-test262-completeness.mjs` (expected-path comparison).
Issue #4444 already records this discovery gap; the audit confirms it remains.
The edition ratchet's 11,704 total cannot detect the omitted paths.

A future scope fix must use the exact manifest, not simply add bare `intl402`
to the category list: doing the latter discovers 3,357 non-fixture Intl tests
across many editions. A path filter only narrows discovered files and cannot
restore undiscovered paths. Keep that runner change separate from #4016's
coercion implementation and test its discovery/completeness contract directly.

## Post-checkpoint registry follow-up: transferred to dedicated #6715

The next concrete semantic candidate is the host post-`ToPrimitive` Symbol
invalid-Wasm boundary, not either stale `@@split` refusal pin. A historical
environment-gated trace observed a late real host `"number"` string import
change `numImportGlobals` from `0` to `1` while cached
`ctx.undefinedGlobalIdx` remained `11`; after the insertion that slot resolved
to `__symbol_counter:i32`. This matches the observed
`global.get i32; extern.convert_any` validation failure. The trace did not
identify the final canonical-undefined emitter, so it is evidence of the
stale cache mechanism, not a complete emitted-route proof.

`ensureAnyValueType` stores the absolute `__undefined` global index, while
`canonicalUndefinedExternInstrs` later emits it. The established
`fixupModuleGlobalIndices` path shifts body instructions and many comparable
cached indices after a late import global, but not this cache. The proposed
narrow repair is therefore a threshold/delta update for
`ctx.undefinedGlobalIdx` in that existing function, with no IR, context-layout,
body-rebuild, or general relocation rewrite.

This work is now tracked by
[#6715 — standalone: shift the cached undefined singleton global index after a late host import](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6715-standalone-undefined-global-index-late-import-shift),
not by #4016. Its planning reservation was released after the dedicated
pre-dispatch check and re-claimed for a separate managed worktree/branch. The
new owner must still prove the late-import/canonical-undefined case directly
and pair the existing host post-`ToPrimitive` Symbol-limit fixture (including
construction, hint, and separator-abruptness controls) against the same base.
The #4016 draft retains this evidence as provenance but makes no registry-fix
claim.

## 2026-09-28 quality handoff: compiler-boundary inventory

The draft PR's completed `quality` job reports an actual compiler-boundary
inventory failure, not an allowance issue: `string-split-coercion.ts` has one
unclassified module boundary and two unclassified target boundaries. The
relevant artifact is `compiler-boundaries-36355885419-1` (artifact id
`10944515410`). Lint, format, and typecheck completed successfully; the
aggregate log's omitted Biome diagnostics are not a separate failure. Classify
or register the new split-coercion boundary through the repository's existing
boundary mechanism; do not add an allowance or weaken the inventory. The
source-only correction registers `src/codegen/string-split-coercion.ts` as
`unmigrated` `mixed-needs-split` debt with `backend-wasmgc` as its eventual
destination. That is the correct layer because the helper combines legacy
codegen context/local/helper provisioning with Wasm instruction and native
runtime emission—not merely because its two importers carry that label. The
record resolves the missing module and its two target records without adding a
layer, changing an allowed edge, or claiming a completed quality run. Tests,
hooks, and registry edits were not part of that source-only correction. The
scoped inventory check exited 0 with `errors: []`, zero untracked modules, and
the expected `inventory-valid-architecture-incomplete` status; it is the only
local validation required before normal commit/push hooks. Registry work is
separately owned by #6715.

## Next ES2015 candidate: ownership unresolved

The current #6651 SN1 receipt recommends a separate OrdinaryToPrimitive slice
for `String.prototype.indexOf/{position-tointeger-errors,
position-tointeger-toprimitive,searchstring-tostring-toprimitive}.js`.
Those historical failures still require fresh reproduction; no new gain or
implementation is claimed. The previously clean audit checkout was prepared
at verified upstream `359c2d63b6753e0c540b8761d13647b00e24a9a4` on branch
`codex/6651-indexof-coercion-20260927` without source changes.

The authoritative claim check returned exit 3: #6651 is claimed by
`ttraenkler/project-thread-yhj9pp` since 2026-09-24. The user was asked whether
this exact indexOf slice is already active. Do not steal that claim or edit
its source/issue record before ownership is resolved. This holds only the
next slice; #4016 validation/publication can continue independently.

On September 28 the same audit checkout was reassigned to separately scoped
runner-discovery issue 6712 (`test262-exact-manifest-discovery`) on parallel
branch `codex/6712-exact-manifest-discovery-20260928`. Its dedicated pre-dispatch gate
returned CLEAR and its claim was verified upstream. The broad umbrella gate
had flagged active compiler subissues, so no implementation proceeded under
that STOP; the superseded `4444:manifest-discovery` claim was released after
the dedicated claim succeeded. The indexOf branch still exists but is not the
active checkout and has no implementation. Do not switch this occupied
worktree back to it while the discovery worker is active.
