# Whole-project quality review — 2026-08-31

Base: `upstream/main` as audited at
`dfd3ae92da8186d1b77c9781cb8bf40c4ef62d0f`, verified as the remote tip when
the review began. Upstream advanced by six commits during final documentation
QA; none touched the audited findings' paths. Before PR publication, a second
preflight at `c39de6dac8c376482b4f2cd628e445c6d8441728` (22 commits beyond the
audit base) rechecked the changed god-file input: the total remained 39, while
`generateModule` grew further as recorded below. The review ran from a clean,
isolated checkout; the user's dirty development tree was not modified.

Model/process: delegated **GPT-5.6 Sol, ultra-effort** lanes audited runtime
correctness, CI/release tooling, test/harness integrity, finding
reproduction/deduplication, and the corrected final patch. The coordinating
lane reconciled their evidence, ran cross-checks, and filed only reproduced
findings or measured stale debt.

## Outcome

Eight new issue records were reserved atomically and filed:

- [#5229 — Published Node 20 support floor has no package-level compatibility proof](issues/5229-node20-supported-runtime-quality-gates.md)
  (**medium**, compatibility/CI).
- [#5230 — `check:issues` reports semantic generated drift but has no freshness verdict](issues/5230-issue-check-generated-drift-fail-open.md)
  (**medium**, planning integrity).
- [#5231 — Instantiation fallback retries modules after start-section failure, replaying initialization](issues/5231-instantiation-fallback-replays-start.md)
  (**high**, runtime correctness).
- [#5232 — Issue-test regression gate lets files and assertions disappear without a verdict](issues/5232-issue-test-gate-population-loss.md)
  (**high**, regression-memory integrity).
- [#5233 — Pages deploy can silently fall back to a checkout Test262 snapshot](issues/5233-test262-report-mirror-missing-lane.md)
  (**medium**, published conformance data).
- [#5234 — Checked-in dashboard issue snapshots are thousands of records stale and no required check notices](issues/5234-dashboard-snapshots-stale-ungated.md)
  (**medium**, dashboard/planning data).
- [#5235 — Required changed-root test gate masks real unhandled rejections](issues/5235-changed-root-masks-unhandled-errors.md)
  (**high**, required-CI false positives).
- [#5236 — JSR tag gate omits `jsr.json` version and can authorize a stale publish](issues/5236-jsr-tag-gate-version-lockstep.md)
  (**high**, release integrity).

Two completed issues were reopened because their own acceptance contracts are
currently violated:

- [#68 — Issue 68: DOM containment — scope wasm module access to a subtree](issues/68-dom-containment-scope-wasm-module.md):
  containment tests are 15/19 and multiple receiver/root cases remain incorrect.
- [#1616 — Flatten issue files into a stable location; sprint membership via frontmatter only](issues/1616-flatten-issue-files-stable-location.md):
  three numbered records remain nested, links break, scanners disagree, and
  dashboard discovery admits non-issues.

Four existing active owners were updated rather than duplicated:

- [#3103 — split the host runtime by concern](issues/3103-split-runtime-ts-host-runtime-by-concern.md):
  `runtime.ts` is now 18,786 lines; instantiation and containment have divergent
  sibling implementations, one unused and one imported by 40 files.
- [#3603 — verifyProperty vacuity on both lanes](issues/3603-verifyproperty-vacuous-both-lanes.md):
  two vector-mirror host-call paths still skip writeback when a callback throws.
- [#3987 — Node-version-bound Test262 baseline](issues/3987-test262-baseline-node-version-bound.md):
  the Node-25 composite default now reaches seven unique workflows.
- [#4063 — `check:godfiles` is red but gates nothing](issues/4063-check-godfiles-red-on-main-gates-nothing.md):
  its stale count of two regressions is now 39, so priority was raised from low
  to medium.

## Highest-risk correctness findings

### Instantiation replays start-time effects — #5231

`src/runtime.ts:18708-18724` catches every failure from a native-options
instantiation and retries with the polyfill imports. A Wasm start section that
calls a host import and then traps therefore executes twice. The streaming path
at lines 18744-18772 can execute it three times. A minimized start-function
probe measured exactly **2** and **3** calls; the duplicate helper in
`src/runtime-instantiate.ts` also measured **2**.

This is not a harmless compatibility retry: start sections and imports can
mutate host state before the error. The fix must distinguish unsupported feature
negotiation before instantiation from compile/link/start/import failures after
execution can begin.

### DOM containment contract has four failing cases — reopened #68

The production wrapper at `src/runtime.ts:17838-17960` treats cross-realm nodes
as non-nodes because it stops at current-realm `instanceof Node`; the structural
fallback is never tried. Method wrappers do not use the resolved function and
invoke `self[member]` directly. Root-relative outward mutation is exempted, and
`getRootNode` is blocked only in property-get form.

The committed suite currently fails four cases: both above-root traversal
checks, outside mutation, and outside property set. Independent cross-realm and
root-removal probes reproduced the same mechanism. This violates the host API's
documented containment/correctness contract; it is not framed as a security
boundary.

### Abrupt host calls lose vector writes — updated #3603

`src/runtime/host-call-abi.ts:43-46` and `src/runtime.ts:14077-14079` reconcile
vector mirrors only after a normal `Reflect.apply` return. If host code mutates
the mirror and then throws, the host view changes while the compiled vector
does not. A sibling path already uses `finally` and documents the required
abrupt-completion behavior, so the inconsistency and direction are concrete.

## Required-gate and regression-memory findings

### The required changed-root gate accepts real async faults — #5235

The workaround for #4003 applies Vitest's
`--dangerouslyIgnoreUnhandledErrors` to every changed root test. A deterministic
fixture with one green assertion plus an unhandled rejected promise exits **1**
under the strict runner and **0** under the required gate's flag. The log still
prints the rejection, but CI receives success.

### Root-test identities can disappear silently — #5232

The post-merge gate stores only known failing assertion IDs. Observed IDs encode
their file and assertion, but there is no expected file/assertion/skip
population or shard identity, and the PR selector excludes deletions. A Vitest
subprocess status is also ignored whenever JSON exists. Deleting, renaming,
skipping, or partially collecting a previously green regression test removes it
from both `passing` and `failing`; absence is accepted. An empty successful
partial set against a one-entry known-failure baseline exited **0** and left the
stale baseline unchanged. Failed matrix jobs remain red through `needs`; the
gap is successful but incomplete/mislabeled artifact population.

### Generated planning drift is observable but unenforced — #5230

`update-issues --check` detects all three generated indexes as different and
prints `would update: true`, then exits 0 because generated drift is not in its
four structural failure classes. The semantic changes include backlog counts
**191/45/71 → 186/41/77** and wont-fix **55 → 58**, not only a date header.
Check mode also reports zero issue-file changes by construction, and broken-link
discovery swallows `git ls-files` failure.

The script calls `--check` an audit-only no-write mode, so #5230 explicitly asks
the project to define separate structural and deterministic-freshness contracts
rather than blindly failing on today's wall-clock-stamped output.

### The god-file ratchet deteriorated while decorative — updated #4063

`profile-godfiles --check` now reports **39** regressions. The largest is
`ensureObjectRuntime`, **4,234 → 5,669 LOC** (+1,435). Other large growth
includes `compileCallExpression` (+496), `emitIteratorMethodExport` (+426),
`generateModule` (+449 at the PR preflight), and `generateMultiModule` (+387).
No GitHub workflow invokes this check. Its original issue documented two
violations; 37 more accumulated while main stayed permanently red and CI
ignored it.

## Release, compatibility, and published-data findings

### JSR tag verification omits the JSR version — #5236

`publish-npm.yml` verifies the tag against root version, proxy version, and
proxy dependency, then authorizes JSR without reading `jsr.json.version`.
Simulating only JSR at 0.69.0 while the other three values and tag are 0.70.0
passes the exact comparisons. #3454 remains correctly done because the normal
release script satisfies its acceptance contract; #5236 owns this independent
tag-gate proof.

### Published Node 20 support is not exercised as a package contract — #5229

The package says Node `>=20`, while required CI uses Node 25 and has no cell that
packs, installs, and smokes the published API/CLI at the floor. Contributor docs
requiring Node 22+ and authoritative conformance using Node 25 are deliberately
separate contracts under #3490/#3746. Repository-only Node 20 failures in the
vacuity checker and unflagged guard corpus therefore motivate careful boundary
selection but do not establish a package defect. #5229 asks for a packed-package
smoke or an honestly raised consumer floor.

### Pages can silently use a checkout Test262 fallback — #5233

The Pages workflow optionally overwrites each external lane, but the checkout
already contains both canonical files. With a fresh external host snapshot and
the standalone download absent, the committed standalone canonical remains;
the synchronizer sees both paths, copies all six targets, and exits 0 without
proving both came from the external baseline materialization. A
deployment-shaped fixture reproduced external-host plus checkout-standalone
provenance. Host and standalone lanes may intentionally advance independently;
the defect is the silent checkout fallback, not unequal lane epochs. Current
checked-in mirrors match their sources, so this is not a claim that today's
numbers are stale.

### Dashboard source and snapshots disagree — #5234 and reopened #1616

Tracked `website/dashboard/data/issues.json` has 2,157 entries; fresh generation
has 4,263, a gross difference of 2,106. Public Pages regenerates and is
mitigated, but required CI never compares or commits tracked output. Separately,
the fresh generator's broad filename predicate admits three non-issue planning
documents, while three real issue files remain in the legacy nested layout.
The freshness problem and canonical-set problem have distinct issue owners.

## Checks and controls

Passing baseline checks on the clean audit checkout included:

- Prettier format checks over `src/**/*.ts`, `tests/**/*.ts`, and
  `scripts/**/*.ts`;
- TypeScript 7 `typecheck`;
- Biome at the configured error threshold;
- the dead-export/legacy-reachability ratchet, IR-retirement, issue-ID, and
  committed-issue-integrity checks;
- IR dialect/kind-neutrality/layering, JsTag seam, pushRaw, LOC budget,
  IR adoption, any-box, rollback, coercion-site, conformance-number, and
  feature-badge checks;
- the complete Node-24 guard manifest: 20 files, 250 passed, 4 skipped;
- 81 focused harness/CI assertions across benchmark lifecycle, Test262 lane
  gating, verdict completeness, report freshness, unexpected-pass protection,
  quality fail-fast, and report building.

Expected red reproductions tied to filed/updated issues:

- `tests/dom-containment.test.ts`: 4 failed / 15 passed (#68);
- `profile-godfiles --check`: 39 regressions (#4063);
- generated issue indexes: all three differ while check exits 0 (#5230).

Ancillary compatibility observations, not treated as published-package
failures, were the official Node-20 vacuity-checker import error and the
unflagged guard manifest's **101 failed / 149 passed / 4 skipped** result. Those
repository-only commands define separate contracts from #5229's proposed
packed-package smoke.

Whole-tree `func-budget --all` and `oracle-ratchet --all` also report old
baseline debt (208 function entries and 97 oracle failures respectively), but
their required CI modes are change-scoped and existing #3400/#3273 already own
the semantics. No duplicate issues were filed from those raw all-tree modes.

## Scope and limitations

The repository contains 11,729 tracked files, including roughly 5,105
TypeScript files, 4,200 files under `tests`, 285 scripts, and 4,260 canonical
issue records. The audit sampled every major source/tooling surface through
parallel sweeps and ran broad static gates, but it is not a mathematical proof
that no other defect exists.

Full Test262 execution was unavailable because the audit checkout's submodules
were intentionally uninitialized (`test262/test` contained no corpus). This is
an environment limitation, not a filed repository defect. Release/registry
behavior was inspected and simulated read-only; no packages were published.
No product-code fix was attempted because the requested deliverable was a
review, summary, and issue records.
