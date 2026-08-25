---
id: 4550
title: "The IR ratchet corpus is 13 files and unrepresentative: measured 0 % linear-lane claim rate on 5 real npm entry modules, with body-shape-rejected dominant despite its bucket reading zero"
status: ready
sprint: Backlog
created: 2026-08-17
updated: 2026-08-25
priority: high
horizon: l
feasibility: medium
model: fable
reasoning_effort: high
task_type: analysis
area: ir
language_feature: compiler-internals
goal: ir-full-coverage
related: [652, 1376, 2855, 2856, 2859, 3341, 4538, 4539, 4541, 4549]
# id 4550 reserved via claim-issue.mjs --allocate --allow-unscanned on
# 2026-08-17 (gh CLI offline in this container; pr_scan=degraded). Equivalent
# open-PR scan via the GitHub MCP at reservation time: sole open PR was 4639
# (ci/npm-compat-refresh, artifact-only), which adds no issue file.
---

# #4550 — The ratchet's zero is corpus-specific, and now measured

## What was measured (2026-08-17)

The #1376 ratchet reports its unintended buckets at zero, and the bucket work
is `done`: **#2856 — "IR: drive body-shape-rejected fallback bucket to zero
(dominant unintended bucket)"** and **#2859 — "IR: drive
param-type-not-resolvable fallback bucket to zero (TypeMap propagation)"**,
under **#2855 — "IR fallback-corpus ratchet: drive unintended function buckets
to zero"**.

Its corpus is **13 files** under `website/playground/examples`.

Compiling five real npm entry modules through `--target linear` and reading
`getLastLinearIrReport()`:

| module | claimed | rejected | claim rate |
| --- | ---: | ---: | ---: |
| `playground/benchmarks.ts` | 3 | 5 | 37.5 % |
| `cookie@2.0.1` | **0** | 9 | **0 %** |
| `clsx@2.1.1` | **0** | 2 | **0 %** |
| `redux@5.0.1` | **0** | 2 | **0 %** |
| `marked@18.0.2` | **0** | 2 | **0 %** |
| `moment@2.30.1` | **0** | 2 | **0 %** |
| **total** | **3** | **22** | **12 %** |

Rejection reasons across all files:

| reason | count |
| --- | ---: |
| `select:body-shape-rejected` | **10** |
| `select:recursive-type-evidence` | 4 |
| `select:logical-value-unsupported` | 3 |
| `select:param-type-not-resolvable` | 2 |
| `select:string-builder-candidate` | 1 |
| `illegal:instr-vec.set_length` | 1 |
| `select:constructor-resolution-unsupported` | 1 |

**`body-shape-rejected` is the single most common rejection — the same bucket
the ratchet reads as zero.** `param-type-not-resolvable` appears too. This is
not a ratchet defect; CLAUDE.md already states the hazard (#3341): a bucket
absent from the baseline means *the corpus does not trigger it*, never *the
reason is unreachable*. What is new is that the claim is now measured rather
than cautioned about.

**Validity.** A positive control (a known-claimable non-escaping-object
function) was claimed in the same run, so a 0 % rate means "not claimed", not
"the probe cannot see". A first version of this probe lacked that control and
its output would have been indistinguishable from a broken harness.

## The denominators are truncated — do not quote 12 % as coverage

`moment@2.30.1` is 176 KB and reports **2** functions; `marked@18.0.2` is 42 KB
and reports **2**. Those packages contain hundreds. So the linear IR path is
reporting only a small prefix of each module — plausibly bailing at a
module-level gate (`select:recursive-type-evidence` appears exactly once per
large package) before enumerating the rest.

That means the numbers above **understate the population, not the coverage**:
the true claim rate is no better than 12 % and probably worse, but the honest
statement is that we cannot yet count the denominator. Establishing it is the
first deliverable below.

## Why this matters beyond the ratchet

Every downstream measurement in the current program is gated on this, and each
one hit the same wall this session (recorded in **#652 — "Compile-time ARC:
static lifetime analysis for linear memory mode"**):

- the stack-allocation census returned **0/0** — no allocation sites in claimed
  functions, so no denominator;
- `cookie` yielded no analysable function at all;
- ordinary shapes — *object returned*, *object passed to a local callee*,
  *closure capturing a local* — are rejected outright.

**#4549 — "Shared inter-procedural summary framework…"**, #652's region work,
and #4541's representation slice all consume IR that mostly does not exist for
real code today.

## Deliverables

- [ ] **Establish the real denominator.** Determine why large modules report a
      handful of functions, and report claim rate over *all* functions in a
      module, not the reported prefix. Until this lands, no coverage percentage
      should be quoted.
- [ ] **Widen the measured corpus** beyond the 13 playground files — the
      `tests/dogfood/fixtures/*.tgz` pinned tarballs are already in-tree and
      need no network.
- [ ] **Decide the corpus's relationship to the gate.** Widening the *gating*
      ratchet corpus would fail CI immediately, so this is deliberately two
      decisions: a **reported** wide corpus (informational, tracked over time)
      and, separately, whether/when any of it becomes gating. Do not silently
      widen the gate.
- [ ] **Re-rank the buckets by the wide corpus.** `body-shape-rejected` at 10/22
      suggests the retired bucket work was corpus-fitted; the next bucket
      campaign should be prioritised by real-code frequency.
- [ ] Publish the reasons histogram per corpus so a future reader can see which
      corpus a "zero" refers to.

## Non-goals

- Fixing any individual rejection reason. This issue establishes the honest
  measurement; the bucket campaigns act on it.
- Changing the existing gate's pass/fail behaviour. The 13-file ratchet keeps
  doing its job; it simply must not be read as a coverage statement.

## Repro

Probe used: `.tmp/coverage-census.ts` (gitignored — restated here so it does
not die with the container). For each module: `compile(src, { target: "linear",
allocator: "analysis-stack" })`, then read `getLastLinearIrReport()`'s
`compiled` / `rejected` arrays and histogram `rejected[].reason`. Fixtures
extracted from `tests/dogfood/fixtures/<pkg>-<ver>.tgz`; entry modules taken
from `tests/dogfood/<pkg>-pin.json`'s `entryModule`.

## Current-main implementation plan (2026-08-25)

Current `origin/main` makes the measured denominator less trustworthy than the
original issue text says. `LinearIrResult` is a live single-source lowering
result, `lastReport` is assigned before lowering finishes, and the side channel
is last-write-wins. `generateLinearMultiModule` neither resets nor publishes a
linear-IR report. `scripts/check-linear-ir.ts` catches a compile failure and
then accepts an absent report, so it can silently reuse a prior module's report
or omit the failed module. The repair must first make the measurement
instrument honest; only then may it publish the wider corpus.

Land this issue-plan amendment first, followed by two small ready PRs. The
first PR is a behavior-neutral, opt-in census contract. The second is the
informational pinned-corpus reporter and its first durable snapshot. Do not
combine either checkpoint with a selector/lowerer widening or with a change to
the existing 13-file ratchet thresholds.

### C1. Compile-scoped, fail-closed linear-IR census

The initial implementation boundary is:

- add `src/ir/backend/linear-ir-coverage.ts` for the serializable schema,
  authenticated one-shot transaction, validator, canonical ordering, and
  digest projection;
- extend `src/ir/backend/linear-integration.ts` only to project its existing
  authoritative owner population and `ownerEvidence` into that transaction;
- extend `src/codegen-linear/index.ts` to own single-source and multi-source
  census lifecycles without changing emitted Wasm;
- harden `scripts/check-linear-ir.ts` to consume the new census while retaining
  its exact committed baseline comparison; and
- add `tests/issue-4550-linear-ir-census.test.ts` plus only exact extensions to
  existing linear-report tests that are needed to pin compatibility.

Do not add this telemetry to `CompileResult`, public compiler options, emitted
metadata, or runtime imports. Gate all extra inventory/census work behind the
exact diagnostic switch `JS2WASM_LINEAR_IR_COVERAGE=1`. The existing
`JS2WASM_LINEAR_IR` switch continues to control lowering, not observation. The
coverage predicate is default-off and browser-safe: it returns true only when
`typeof process !== "undefined"` and the environment value is exactly `"1"`.

1. **Separate census from the live lowering result.** Preserve
   `LinearIrResult`, `getLastLinearIrReport()`, its `WasmFunction`/memory-plan
   objects, and every existing benchmark/test consumer. Add a distinct frozen
   `LinearIrCoverageCensusV1` containing only JSON-safe values:

   - `schema: "linear-ir-coverage-census-v1"`;
   - a monotonically increasing in-process generation ordinal;
   - `generationKind: "single-source" | "multi-source"`, exact canonical
     `entrySourceId`/`entrySourceKey`, and canonical source rows containing
     source ID, source key, kind, and order;
   - `status: "complete" | "generation-failed"` and, on failure, a bounded
     stable phase/code/detail projection with no stack or temporary path;
   - canonical owner rows keyed by exact `IrUnitId`, each retaining source ID,
     source key, legacy display name, terminal/observed kind, and exactly one
     outcome: `compiled`, `rejected { reason, detail? }`, or
     `not-attempted { reason }`;
   - exact compiled/rejected/not-attempted/owner/source counts.

   Freeze descriptor-owned arrays/records only. Never freeze AST nodes,
   identity contexts, `WasmFunction`s, modules, maps, allocators, or the live
   `LinearIrResult`. Do not copy the old report's mutable objects into the
   census and do not import Node crypto into compiler code. The Node ratchet
   and reporter compute SHA-256 over the canonical census/evidence projection
   after capture.

   Keep the compiler input name distinct from IR identity. `SourceFile.fileName`
   / `IrSourceRecord.originalFileName` is the exact caller-supplied logical
   filename used to join the AST, while `IrSourceRecord.sourceKey` is the
   canonical program-relative semantic key (a single-source path commonly
   reduces to its basename). Validate that join in memory, but do not serialize
   checkout-absolute `originalFileName` values. Ratchet/reporter rows retain a
   separate stable `logicalFileName`; inventory checks and owner joins compare
   canonical source ID/key, never that logical label.

   Validators require plain records, exact field sets, finite non-negative safe
   integer counts, and no `undefined`, non-finite number, class instance, map,
   or set in a serializable row. Canonical string order uses an explicit
   code-unit comparator (`a < b`, `a > b`), never locale-sensitive
   `localeCompare`. Persistent content digests omit the raw process-global
   generation ordinal. Each consumer instead proves freshness against the
   reset watermark and records a run-relative `generationSequence` (control/file
   1, then 2, and so on) in its evidence wrapper.

2. **Use one authoritative denominator.** Build owner rows from the same
   `buildIrUnitInventory`/`IrPlanningIdentityContext` and
   `indexLinearIrSourceOwners` boundary the single-source overlay already
   trusts. The denominator is every terminal in every requested source whose
   `observedKind` is `function` or `class-member` and which passes the existing
   `isLinearIrAttemptRoot` policy. Module-init rows and the deliberate compiler
   timer shim exclusion are outside this function denominator; do not discover
   a second population by walking syntax in the script.

   For each owner require exact source ID/key, terminal self-ownership,
   declaration↔UnitId round trip, and membership in the exact source file.
   Canonicalize sources by source key and owners by UnitId. Reject duplicate
   source keys/IDs, duplicate UnitIds, a declaration in two sources, missing
   reverse rows, and any owner whose source/terminal/declaration joins drift.
   Legacy-name collisions remain distinct UnitId rows and may never collapse
   the denominator.

3. **Authenticate one generation transaction.** A module-private `WeakMap`
   payload and lifecycle `fresh -> finalized` must authenticate the opaque
   transaction; a TypeScript brand alone is not authority. Beginning a
   diagnostic generation clears both diagnostic side channels before any
   lowering and retains the exact generation kind, entry, sources, and owner
   population. A transaction can finalize exactly once and cannot be reused by
   another module/context/source population. Foreign, forged, double-finalized,
   and out-of-order generations fail closed.

   Keep generation synchronous and last-write-wins for compatibility, but make
   overlap explicit: beginning a second active diagnostic generation is an
   invariant rather than silently interleaving rows. This is an internal
   sequential measurement contract, not a promise of concurrent public
   telemetry.

   Add explicit internal diagnostic accessors rather than making scripts infer
   lifecycle from a nullable report: `resetLastLinearIrReport()` clears the
   compatibility result; `resetLastLinearIrCoverageCensus()` clears the census
   and returns the current generation watermark; and
   `getLastLinearIrCoverageCensus()` reads only the most recently finalized
   census. Resetting either side channel must not rewind the monotonic ordinal.
   Resetting while a transaction is active is an invariant rather than a way
   to discard it. These are test/ratchet imports, not exports from the package
   entry point.

4. **Reconcile every owner exactly once.** For the single-source path, join the
   final `LinearIrResult.ownerEvidence` to the retained population by UnitId.
   A compiled/rejected row must preserve the exact source owner and legacy
   label. Duplicate evidence, unknown owners, one owner in two outcomes, a
   public `compiled`/`rejected` entry without matching structural evidence, or
   evidence-label drift is an invariant. Owners with no result evidence are
   retained as `not-attempted`, never dropped. Use bounded reasons that
   distinguish at least selector omission, overlay disabled, and generation
   abort.

   `lastReport` must no longer be evidence that a generation completed merely
   because `compileLinearIrFunctions` allocated its result. The census is
   published only after reconciliation. If later direct codegen throws,
   finalize with `status: "generation-failed"`, retain all already-known exact
   rows, mark unresolved owners `not-attempted: generation-aborted`, publish the
   failed census, and rethrow the original error.

5. **Report the multi-source truth without widening IR.** Under the diagnostic
   switch, `generateLinearMultiModule` builds one inventory across the exact
   `multiAst.sourceFiles`, with `multiAst.entryFile` as entry and
   `multiAst.checker` as checker. This is the same post-analysis identity
   boundary used by `generateMultiModule`; the multi-source compiler path has
   no pre-transform `irInventoryOptions` to thread, so do not invent one or
   touch `src/compiler.ts` for this checkpoint. The census records every
   authoritative owner as
   `not-attempted: multi-source-overlay-unimplemented`. It must not run
   single-source selection once per file, synthesize rejections, or claim that
   direct compilation is IR compilation. Direct multi-source codegen and Wasm
   bytes remain unchanged. On a later direct-codegen failure, retain the same
   population and publish `generation-failed` before rethrowing.

6. **Make the existing ratchet fail closed without widening it.** Before every
   public `compile()` call, `scripts/check-linear-ir.ts` clears the old result
   and new census, records the stable repo-relative logical filename and
   generation watermark, and then captures the compile result/exception plus
   both side channels immediately. The script reads source bytes by absolute
   path but passes that repo-relative logical filename to `compile()`. It
   separately requires the finalized census's canonical entry source ID/key
   and source rows to match the inventory derived from that logical input. It
   rejects a stale ordinal, wrong source join, malformed schema/counts,
   duplicate/missing owner, or a census borrowed from the previous file.

   Keep the public module result distinct from the completed linear-generation
   transaction. The historical playground corpus deliberately contains
   unresolved imports and unsupported direct-backend surfaces: its linear
   generator can publish a complete current report/census before later
   codegen diagnostics make public `CompileResult.success` false. A returned
   unsuccessful result is therefore not, by itself, an instrumentation
   failure and may contribute to the unchanged ratchet only when that same
   invocation published a fresh `status: "complete"` census, the matching
   compatibility report, and exact source/owner/count joins. Retain
   `success: false`, the exact error count, a bounded canonical error
   projection, and its lowercase SHA-256 in the per-file evidence; never call
   it a successful module compile.

   A thrown compile, a return before generation, a missing report/census, a
   `generation-failed` census, or any stale/malformed/mismatched lifecycle or
   population evidence remains a hard instrumentation failure and contributes
   no rows. None may inherit a previous report. This is a generation-census
   ratchet, not emitted-module acceptance; changing the corpus, resolving its
   dependency graphs, or extracting only successful functions would change
   the measured denominator and is outside C1.

   Early compiler validation may return before either linear generator begins,
   so no compiler-global reset is implied for those paths. The authenticated
   harness sequence is exact and mandatory for every attempt: reset old report,
   reset census and retain its watermark, invoke one public compile, then
   immediately capture result/throw plus both side channels before any next
   compile. An early failure therefore has an explicit missing-census state and
   can never inherit the prior attempt.

   Keep `scripts/linear-ir-baseline.json` byte-identical in this checkpoint.
   Its `compiled` and rejection buckets are still derived from only the same
   sorted `website/playground/examples/**/*.ts` corpus, and the existing
   nondecrease/nonincrease predicates remain exact. Fail-closed instrument
   validation is not permission to add the wide corpus to the gate or to bank
   a new baseline. Preserve `--json`; add explicit `expectedFiles`,
   `observedFiles`, per-file compile/census status, owner outcome counts,
   canonical census SHA-256, and instrumentation failures so a zero has a
   visible denominator.

   Remove the current implicit seed-on-missing behavior. A missing, malformed,
   or schema-invalid committed baseline is a hard failure in every mode except
   an explicit `--update`. `--update` may write the baseline only after every
   expected file has a fresh, complete, validated same-invocation generation,
   matching report, and exact population joins. It applies the same eligibility
   rule as ordinary comparison: a retained post-generation
   `CompileResult.success === false` is allowed and remains explicit evidence,
   while a throw, missing/failed generation, or any instrumentation failure is
   not. `--update` can never waive such a failure. With `--json`, stdout is
   exactly one JSON document and human progress/diagnostics go to stderr. The
   ordinary command retains its current human summary.

7. **Non-vacuous census tests.** The focused suite must include:

   - one exact single-source positive with at least one compiled owner and one
     selector rejection, proving owner count equals compiled + rejected +
     not-attempted;
   - coverage off/on A/B for the same single-source and multi-source programs,
     proving emitted bytes, compile success/errors, exports, and runtime result
     are exact while only the opt-in census appears;
   - an explicit `JS2WASM_LINEAR_IR=0` / `JS2WASM_LINEAR_IR_COVERAGE=1`
     sibling against coverage-off direct mode: every owner is
     `not-attempted: overlay-disabled`, no overlay preparation or linear-IR
     runtime reservation occurs, and bytes/errors/exports/runtime are exact;
   - coverage-predicate controls for absent `process`, a process-like value
     without `env`, missing/wrong switch values, and exact `"1"`; all disabled
     shapes return false without throwing;
   - two files with colliding display names that remain distinct source/UnitId
     rows;
   - a multi-source positive whose complete owner population is present and
     explicitly `multi-source-overlay-unimplemented`;
   - the exact harness sequence reset → watermark → successful compile →
     immediate capture, followed by reset → watermark → pre-generator failing
     compile → immediate capture, proving the second read cannot recover the
     first report or census;
   - a returned `success: false` after a fresh complete generation, proving the
     exact current report/census still contributes while the bounded canonical
     error projection and digest remain visible; sibling throw,
     pre-generation return, and `generation-failed` mutations must contribute
     nothing;
   - a late generation failure that retains prior exact rows and marks every
     unresolved owner rather than truncating the denominator;
   - missing/duplicate/unknown owner evidence, wrong source/entry/kind/ordinal,
     forged/reused transaction, count drift, and malformed rows; and
   - logical-filename/canonical-source-key mismatch plus absolute-path leakage,
     raw-ordinal drift with stable relative sequence, and a canonical reorder
     control proving input iteration and object-property order do not change
     canonical rows or lowercase SHA-256 digests.

   Every mutation changes one fact and retains a positive sibling. Assert exact
   denominators and nonempty positive-control evidence so an empty collector
   cannot pass.

### C2. Informational pinned npm coverage reporter

Begin C2 only after C1 is on `main`. Its implementation boundary is:

- add `scripts/report-linear-ir-coverage.ts`;
- add `tests/issue-4550-linear-ir-coverage-report.test.ts`;
- add `benchmarks/results/linear-ir-coverage/latest.json`; and
- add explicit opt-in `package.json` commands to print, write, and compare the
  snapshot. Do not wire them into `check:linear-ir`, pre-commit, pre-push, or
  required CI in this issue.

1. **Use only committed, verified inputs.** Measure exactly the original five
   real package entries in canonical name order:

   - `clsx@2.1.1` / `package/dist/clsx.mjs`;
   - `cookie@2.0.1` / `package/dist/index.js`;
   - `marked@18.0.2` / `package/lib/marked.esm.js`;
   - `moment@2.30.1` / `package/moment.js`; and
   - `redux@5.0.1` / `package/dist/redux.mjs`.

   Reuse the existing `setupClsx`, `setupCookie`, `setupMarked`, and
   `setupNpmCompatCatalogPackage` pin verifiers with `{ force: true }` on every
   print, write, and check invocation—not only in final validation. Their
   existing SHA-1 check authenticates the committed tarball; the reporter must
   additionally decode the exact `sha512-...` SRI in `pin.integrity`, hash the
   same tarball bytes, and reject a mismatch before compiling. No network
   fallback, package-manager install, unpinned checkout, cached extraction, or
   copied fixture source is allowed. Read and hash the newly extracted exact
   entry bytes only after both tarball checks pass. Pass a stable logical
   filename such as `npm/<name>@<version>/<entryModule>` to the compiler so a
   temporary extraction path cannot enter evidence; retain that filename
   separately from the census's canonical source key and require the in-memory
   `originalFileName` join.

2. **Prove the instrument before measuring.** In the same fresh process, first
   compile one fixed in-memory annotated arithmetic function and require its
   census to contain exactly one owner and one compiled row. A missing or
   rejected positive control is an instrument failure and forbids all coverage
   claims. Compile packages sequentially with both linear-IR and coverage
   diagnostics explicitly enabled and the analysis-stack allocator. Clear the
   side channels before each compile and require a new raw ordinal, the exact
   run-relative generation sequence, the expected logical filename join, and
   the exact canonical entry/source ID-key set afterwards. Pin package
   compilation to
   `allowJs: true` and `skipSemanticDiagnostics: true` in addition to
   `target: "linear"`, the analysis-stack allocator, and the logical file name;
   retain that normalized option set in the evidence document. Do not rely on
   `.js`/`.mjs` suffix inference to select the JavaScript checker mode.

3. **Publish a deterministic evidence schema.** The committed
   `linear-ir-wide-coverage-v1` document contains no wall-clock time, absolute
   path, temporary directory, stack, machine load, or unstable map iteration.
   Retain, per control/package, pin version/shasum/integrity, logical entry, source
   byte count/SHA-256, compile evidence, complete census rows/counts/digests,
   and exact rejection/not-attempted histograms. Sort packages, sources,
   owners, diagnostics, and histogram keys canonically. Publish one digest over
   canonical package rows and one over the complete evidence document.

   Compile evidence is an exact union: either a returned result with `success`
   and a canonical diagnostic array, or a thrown value with bounded stable
   name/message. A diagnostic retains severity, numeric code or null, logical
   source label or null, finite line/column, and bounded message. Map only the
   exact entry filename to its stable logical label; reject unknown absolute or
   temporary file paths, strip stacks, and reject path-bearing/oversized
   messages rather than serializing machine state. A failed result or throw
   outside the census lifecycle still keeps this evidence and marks the census
   absent/incomplete, so two different failures cannot collapse to one row.

   Define canonical JSON recursively: object keys use the explicit code-unit
   comparator, arrays retain their already-validated schema order, and no
   unsupported JSON value is admitted. Digest bytes are UTF-8 of compact
   `JSON.stringify` over that projection; SHA-256 is lowercase hexadecimal with
   no algorithm prefix. Content projections exclude the raw process-global
   generation ordinal and include the validated run-relative sequence instead.
   The pretty committed file uses two-space JSON plus one final newline; that
   presentation newline is not part of the internal evidence digest.

   Aggregate `compiled`, `rejected`, and `notAttempted` only from validated
   census rows. Publish `populationComplete`, the number of valid modules over
   the exact expected module count, and claim rate numerator/denominator. A
   complete module's denominator is its full owner count, including
   `not-attempted` rows; the aggregate numerator is compiled owners and the
   denominator is the sum of complete owner populations. If any expected
   module lacks a valid complete population, set aggregate claim rate to
   `null` and state which modules are incomplete; never divide a known prefix
   and label it coverage. Compile failures remain evidence rows and do not
   disappear from the expected module denominator. Compute the document digest
   over an explicit canonical projection that omits the document's own digest
   field.

4. **Keep reporting distinct from gating.** The print command emits one JSON
   document to stdout and progress to stderr. `--write` atomically replaces only
   the exact snapshot path after every expected row validates. `--check`
   regenerates in memory and compares canonical bytes, reporting the first
   structural difference without rewriting. These commands are manual,
   informational evidence. Promoting any package or threshold into the existing
   ratchet is a later, separately reviewed issue based on the measured rows.

5. **Reporter mutation tests.** Test the pure schema/canonicalization layer and
   one bounded fixture integration. Reject a dropped/duplicate/unknown package
   or owner, wrong SHA-1/SRI/entry/source hash, a corrupted cached extracted
   entry, missing positive control, stale/raw-only ordinal, malformed compile
   evidence, unknown/path-bearing diagnostics, invalid counts/digests, an
   unrecorded compile failure, and a non-null aggregate rate over an incomplete
   population. The cached-entry control must prove that the next ordinary
   print/check/write path force-reextracts authenticated bytes before hashing.
   Prove that reordering input maps/object fields leaves canonical bytes and
   digests unchanged, that two distinct compile failures have distinct rows,
   and that one changed rejection reason changes both the row and document
   digests.

### Validation and landing discipline

The issue-plan amendment, C1 census, and C2 reporter are three separate ready
PRs, each independently reviewed before enqueue. The C1 PR runs the focused
census suite, all existing `getLastLinearIrReport()` consumers affected by the
reset boundary, `pnpm run check:linear-ir` with the committed baseline unchanged,
the process-absent coverage-predicate controls, `pnpm run build:playground`,
TypeScript 7 and 5, Prettier, IR layering/dialect/fallback gates, LOC/function/
oracle/coercion ratchets, and every normal hook. C2 additionally runs the
reporter suite twice—with every invocation itself forcing clean extraction of
every pinned package—in separate fresh Node processes and requires
byte-identical JSON, then runs the same static gates.

Measure source/function growth before adding an exact allowance to this issue's
frontmatter; never modify a LOC baseline or add speculative allowances. Run
`pnpm run check:loc-budget` again immediately before every normally signed
commit. Never skip pre-commit or pre-push hooks. Every heavy command and every
commit/push boundary requires a fresh finite non-negative one-minute load
strictly below `logical cores - 2`. Push normally, open ready PRs, and shepherd
each through actual merge before publishing the next checkpoint.
