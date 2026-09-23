# Historical issue additions from ABI and startup checkpoints

These are archival records, not amendments to the current issue, fresh authority
or evidence that cumulative PR5751 absorbed all prior documentation. Source
heads are the parent's pinned live PR heads and were resolved from local Git
objects against their own first parents, never current main.

For each source, the first block is the exact ordered sequence of added lines
from `git diff --no-ext-diff --unified=0 PARENT HEAD -- PATH`, excluding the
`+++` file header and removing only the leading diff `+`. Blank added lines
are retained. The second block retains the full zero-context patch, including
hunk positions and any removed lines, so additions are not detached from their
original edit. Historical status statements are not current queue decisions.

## PR5739

- Head: `c3afa4389469e55d434c0715698dc59c6caa9120`.
- Own first parent: `36ea5ce9f54190c1f2c7af0466cf768afb453394`.
- Path: `plan/issues/3518-ir-only-default-and-direct-frontend-retirement.md`.
- Parent issue blob: `843d6e21ee98eebccf0b44051f2da003c64df54c`.
- Head issue blob: `9ba323c1dc786c354ad990419a9b73b52170ef25`.
- Nonempty added lines: **8**; all8 are absent as exact lines from
  the issue at cumulative5751 `48fb6d7133aeb360e795826b227d7de4ef09c8e6`.
  This exact-line check is not a claim that all underlying topics are absent.

### Exact added lines

````text
The native Wasm/checker checkpoint is published as ready PR 5735, source commit
`36ea5ce9f54190c1f2c7af0466cf768afb453394`, with 117/117 changed-file tests
and all normal push hooks passing. Its six canonical full/cut witnesses pass
preservation while both unknown imports remain strict failures.
The [ABI integration evidence](../agent-context/3518-program-abi-integration-evidence-2026-09-08.md)
records exact two-fixture artifact equality against clean d71, the isolated ABI
draft and actual N1 composition. The caller gate and ready ABI PR are still
pending; none of this closes an epic acceptance criterion.

````

### Exact zero-context source patch

````diff
diff --git a/plan/issues/3518-ir-only-default-and-direct-frontend-retirement.md b/plan/issues/3518-ir-only-default-and-direct-frontend-retirement.md
index 843d6e21ee..9ba323c1dc 100644
--- a/plan/issues/3518-ir-only-default-and-direct-frontend-retirement.md
+++ b/plan/issues/3518-ir-only-default-and-direct-frontend-retirement.md
@@ -123,0 +124,9 @@ is the next bounded plan, not a competing dispatch or completed dependency split
+The native Wasm/checker checkpoint is published as ready PR 5735, source commit
+`36ea5ce9f54190c1f2c7af0466cf768afb453394`, with 117/117 changed-file tests
+and all normal push hooks passing. Its six canonical full/cut witnesses pass
+preservation while both unknown imports remain strict failures.
+The [ABI integration evidence](../agent-context/3518-program-abi-integration-evidence-2026-09-08.md)
+records exact two-fixture artifact equality against clean d71, the isolated ABI
+draft and actual N1 composition. The caller gate and ready ABI PR are still
+pending; none of this closes an epic acceptance criterion.
+
````

## PR5741

- Head: `7b37b23c72af84a1e336cebce2954942408ecea6`.
- Own first parent: `25b9a41c3828dfb403797003dc6b66c72a2547ba`.
- Path: `plan/issues/3518-ir-only-default-and-direct-frontend-retirement.md`.
- Parent issue blob: `843d6e21ee98eebccf0b44051f2da003c64df54c`.
- Head issue blob: `2c3461121de05b13e3b17b3a4abd6bfc68491261`.
- Nonempty added lines: **111**; all111 are absent as exact lines from
  the issue at cumulative5751 `48fb6d7133aeb360e795826b227d7de4ef09c8e6`.
  This exact-line check is not a claim that all underlying topics are absent.

### Exact added lines

````text
### Startup contract implementation and handoff — 2026-09-08

The [Astra High startup contract plan](../agent-context/3518-startup-contract-plan-2026-09-08.md)
has a four-file Astra Low implementation, composed in
`codex/3518-startup-contract-checkpoint-20260908` from authoritative main
`25b9a41c3828dfb403797003dc6b66c72a2547ba`. This independent checkpoint does
not contain the held lowering or canonical ABI branches. It moves twelve
unchanged data declarations into `src/ir/program/startup.ts`, keeps explicit
old-path type imports/exports, and redirects `PreparedIrProgram.startup` to
that canonical contract. No source population, schema, invocation policy,
builder, observer, validation or emission behavior changes.

The real dependency closure is three modules and two type-only edges:
startup -> shared IR identity -> shared source origin. The original builder
and complete program remain mixed. The required `src/ir/program/index.ts`
schema split remains explicit debt. There is no new public compiler mode,
backend implementation, scalar-only acceptance or retirement claim.

Ownership was revalidated against upstream assignment tip
`4c312f60ad56f6605279c00eefcc3cc1ad5a8001`: exact slice
`3518:startup-contract-separation`, owner
`ttraenkler/codex-astra-startup-contract-20260908`, worker branch
`codex/3518-startup-contract-20260908`. The normal claim push retained all
historical A/integration records. The suspended P draft's ten changed lines
in `program.ts` concern resources and schema v2, not this type import. Its
module-init builder and both corresponding C files are unchanged. Both
drafts and the dirty root remain untouched.

The composed source/test blobs exactly match the frozen worker:

- `src/ir/program/startup.ts`: `fc9c7514c24e61a063fbdb6eb9fa58d3f11c334f`.
- `src/ir/module-init-plan.ts`: `84c96221142a577437d88d30a4d775cb8bf32b05`.
- `src/ir/program.ts`: `721305422adfc6aafb83a15de5e8ee9bd0f10855`.
- `tests/issue-3518-startup-contract.test.ts`: `65031277cfa3561f1f6578f418dbe09d8e6241a7`.

Parent independently compared all twelve declaration/doc texts against the
exact base. TypeScript 5.9.3 transpilation with ESNext target/module,
verbatim module syntax, comments retained and no source map produced identical
complete JavaScript for both existing source files. Module-init output is
20910 bytes / SHA256 `4b017001813ae27b99c93b8498ac5413f7aa4fd6d463a19e1a07eab82f5aec6d`;
program output is 21284 bytes /
`069e6f8619fd3b3942fc90fd43d0c2071545a6bb273ae5a79935a653ad2afd50`.
Aggregate source growth is 32 import/re-export scaffolding lines. No body,
LOC/function baseline, growth allowance or checker was modified.

Actual public standalone WasmGC comparison used Node v22.23.2 + tsx,
unoptimized `compileMulti` and the unchanged source planner. Base was clean
N1 `36ea5ce9f54190c1f2c7af0466cf768afb453394`; its relevant source is
identical to main 25b. Candidate is 25b plus the three source blobs above;
tracked-source diff SHA256
`e60fb9e881a58668133a681cd5700b5466e7ca92afb3c12c6a34b1065e74866d`.
All four original source plans (including type-only and re-export inputs),
one executable startup plan, five outcome rows, full binary/WAT, imports,
exports, pool and execution values match exactly. Both zero-import binaries
validate, instantiate and return `[42,42]`. Size 22231 bytes; SHA256
`6bdc6cb6aca27786b923ba685108edc63ee256579bd74bbaa7578898b7cd29f3`.
This proves this fixture's preservation, not full source coverage or all-IR
execution. Records are `.tmp/startup-paired-{base,candidate}.json` and
`.tmp/startup-erasure.json` in the integration checkout.

Worker validation passed 79/79 (25 new contract, 20 existing planning,
7 ordered census and 27 codec replay) and typecheck. Parent's twelve new
controls exercise the real D0 checker with the actual three-module closure,
then inject old-path type/value/re-export/alias/barrel dependencies, unknown
imports, parse failures and a missing required entry. All 12/12 pass after
correcting the fixture's initially incomplete module-extension configuration;
the production checker was not altered. Final composed validation passed
133/133 across all six files (25 contract, 12 startup-boundary, 42 existing
D0, 20 planning, 7 census and 27 codec), zero failed/pending. Normal typecheck
and scoped formatting passed. The real dead-export command exits 0 only via
explicit N1 preservation mode: 6/6 full and cut witnesses, two unresolved
dynamic imports, strict closure failing and retirement not certified.
Conformance synchronization check reports zero updates and five unchanged.

Actual full inventory comparison against 25b exits 0: 1245 modules,
9751 resolved edges (2487 type-only / 7264 runtime), seven clean modules,
four unknown edges and zero errors. Complete mode exits 1 as required;
architecture completion remains false. Policy SHA256
`a1c1df209c451922e65604eb68d0adb880901a181bb366054ca7f360f8f50951`;
content fingerprint `e6b69f0cf865a4201c9081c8cc2a581ad8b551d05b5f93cfa5700aa7114c01aa`.
The ABI branch's independent activation must be unioned with this startup
entry on composition, never overwritten or treated as already landed.

The [next High core-type plan](../agent-context/3518-core-types-next-plan-2026-09-08.md)
extracts actual type construction/equality and supporting data contracts before
the larger async/dialect node split. It is advisory, requires fresh claim
reconciliation, and grants no deletion or new host/linear implementation.

### Checkpoint CI handoff and Temporal acquisition evidence — 2026-09-08

Lowering [PR 5738](https://github.com/loopdive/js2/pull/5738) at `c257b466`
and ABI [PR 5739](https://github.com/loopdive/js2/pull/5739) at `c3afa438`
are open, non-draft and held. Fresh PR-head checks finished with 29 success
and 13 skipped contexts each, including quality/equivalence/linear. This is
not merge-group conformance. ABI's missing `planningSealed` rooted caller
and requested compatibility decision remain unresolved.

N1 merged through PR 5735 at `b9a67c10b4b06cabcc020e0dea1dfa105267661e`
despite host merge-group run 34167945399 failing twenty previously passing
paths. Lowering PR 5738 records the HEADGREEN cumulative-queue/no-op-check
incident and the original paired diagnostics. No workflow or ruleset change
has been authorized or applied. Keep these checkpoint merge holds intact.

Additional read-only CI evidence: all eighteen Temporal failures belong to
host shard 35/52. Candidate job
[101882850226](https://github.com/loopdive/js2/actions/runs/34167945399/job/101882850226)
logs at 22:54:39.041 UTC a provider-not-linked error: extracting
`jsbi-4.3.0.tgz` failed because `package/dist/jsbi-cjs.js` already existed.
Three other acquisitions report cache hits. Foundation job
[101874696210](https://github.com/loopdive/js2/actions/runs/34165082130/job/101874696210)
reports four successful acquisitions and no such failure. Candidate failures
follow at 22:54:45–22:56:26 UTC. Source acquisition checks existence then
extracts into a shared directory without locking (`setup-temporal-polyfill.mjs`
51–54); worker provider acquisition catches this error and memoizes null
(`test262-worker.mjs` 1201–1243). This supports a concurrent-extraction
mechanism. Missing PID-to-row joins prevent attributing each failure to that
fork; the already byte-identical provider binaries do not establish that each
worker successfully acquired one. No extraction fix or local conformance run
was made in this checkpoint.

The two BigInt rows remain unattributed: `array-arg-src-values-are-not-cached.js`
in shard 31/52 has one retry, without its original reason; the extensibility
row in shard 34/52 lacks worker-generation evidence. OOMs occur in both
candidate and passing foundation logs and therefore do not discriminate.
Provider acquisition must be reproduced with explicit process provenance;
the original CI failures are not waived or declared flaky.

````

### Exact zero-context source patch

````diff
diff --git a/plan/issues/3518-ir-only-default-and-direct-frontend-retirement.md b/plan/issues/3518-ir-only-default-and-direct-frontend-retirement.md
index 843d6e21ee..2c3461121d 100644
--- a/plan/issues/3518-ir-only-default-and-direct-frontend-retirement.md
+++ b/plan/issues/3518-ir-only-default-and-direct-frontend-retirement.md
@@ -123,0 +124,127 @@ is the next bounded plan, not a competing dispatch or completed dependency split
+### Startup contract implementation and handoff — 2026-09-08
+
+The [Astra High startup contract plan](../agent-context/3518-startup-contract-plan-2026-09-08.md)
+has a four-file Astra Low implementation, composed in
+`codex/3518-startup-contract-checkpoint-20260908` from authoritative main
+`25b9a41c3828dfb403797003dc6b66c72a2547ba`. This independent checkpoint does
+not contain the held lowering or canonical ABI branches. It moves twelve
+unchanged data declarations into `src/ir/program/startup.ts`, keeps explicit
+old-path type imports/exports, and redirects `PreparedIrProgram.startup` to
+that canonical contract. No source population, schema, invocation policy,
+builder, observer, validation or emission behavior changes.
+
+The real dependency closure is three modules and two type-only edges:
+startup -> shared IR identity -> shared source origin. The original builder
+and complete program remain mixed. The required `src/ir/program/index.ts`
+schema split remains explicit debt. There is no new public compiler mode,
+backend implementation, scalar-only acceptance or retirement claim.
+
+Ownership was revalidated against upstream assignment tip
+`4c312f60ad56f6605279c00eefcc3cc1ad5a8001`: exact slice
+`3518:startup-contract-separation`, owner
+`ttraenkler/codex-astra-startup-contract-20260908`, worker branch
+`codex/3518-startup-contract-20260908`. The normal claim push retained all
+historical A/integration records. The suspended P draft's ten changed lines
+in `program.ts` concern resources and schema v2, not this type import. Its
+module-init builder and both corresponding C files are unchanged. Both
+drafts and the dirty root remain untouched.
+
+The composed source/test blobs exactly match the frozen worker:
+
+- `src/ir/program/startup.ts`: `fc9c7514c24e61a063fbdb6eb9fa58d3f11c334f`.
+- `src/ir/module-init-plan.ts`: `84c96221142a577437d88d30a4d775cb8bf32b05`.
+- `src/ir/program.ts`: `721305422adfc6aafb83a15de5e8ee9bd0f10855`.
+- `tests/issue-3518-startup-contract.test.ts`: `65031277cfa3561f1f6578f418dbe09d8e6241a7`.
+
+Parent independently compared all twelve declaration/doc texts against the
+exact base. TypeScript 5.9.3 transpilation with ESNext target/module,
+verbatim module syntax, comments retained and no source map produced identical
+complete JavaScript for both existing source files. Module-init output is
+20910 bytes / SHA256 `4b017001813ae27b99c93b8498ac5413f7aa4fd6d463a19e1a07eab82f5aec6d`;
+program output is 21284 bytes /
+`069e6f8619fd3b3942fc90fd43d0c2071545a6bb273ae5a79935a653ad2afd50`.
+Aggregate source growth is 32 import/re-export scaffolding lines. No body,
+LOC/function baseline, growth allowance or checker was modified.
+
+Actual public standalone WasmGC comparison used Node v22.23.2 + tsx,
+unoptimized `compileMulti` and the unchanged source planner. Base was clean
+N1 `36ea5ce9f54190c1f2c7af0466cf768afb453394`; its relevant source is
+identical to main 25b. Candidate is 25b plus the three source blobs above;
+tracked-source diff SHA256
+`e60fb9e881a58668133a681cd5700b5466e7ca92afb3c12c6a34b1065e74866d`.
+All four original source plans (including type-only and re-export inputs),
+one executable startup plan, five outcome rows, full binary/WAT, imports,
+exports, pool and execution values match exactly. Both zero-import binaries
+validate, instantiate and return `[42,42]`. Size 22231 bytes; SHA256
+`6bdc6cb6aca27786b923ba685108edc63ee256579bd74bbaa7578898b7cd29f3`.
+This proves this fixture's preservation, not full source coverage or all-IR
+execution. Records are `.tmp/startup-paired-{base,candidate}.json` and
+`.tmp/startup-erasure.json` in the integration checkout.
+
+Worker validation passed 79/79 (25 new contract, 20 existing planning,
+7 ordered census and 27 codec replay) and typecheck. Parent's twelve new
+controls exercise the real D0 checker with the actual three-module closure,
+then inject old-path type/value/re-export/alias/barrel dependencies, unknown
+imports, parse failures and a missing required entry. All 12/12 pass after
+correcting the fixture's initially incomplete module-extension configuration;
+the production checker was not altered. Final composed validation passed
+133/133 across all six files (25 contract, 12 startup-boundary, 42 existing
+D0, 20 planning, 7 census and 27 codec), zero failed/pending. Normal typecheck
+and scoped formatting passed. The real dead-export command exits 0 only via
+explicit N1 preservation mode: 6/6 full and cut witnesses, two unresolved
+dynamic imports, strict closure failing and retirement not certified.
+Conformance synchronization check reports zero updates and five unchanged.
+
+Actual full inventory comparison against 25b exits 0: 1245 modules,
+9751 resolved edges (2487 type-only / 7264 runtime), seven clean modules,
+four unknown edges and zero errors. Complete mode exits 1 as required;
+architecture completion remains false. Policy SHA256
+`a1c1df209c451922e65604eb68d0adb880901a181bb366054ca7f360f8f50951`;
+content fingerprint `e6b69f0cf865a4201c9081c8cc2a581ad8b551d05b5f93cfa5700aa7114c01aa`.
+The ABI branch's independent activation must be unioned with this startup
+entry on composition, never overwritten or treated as already landed.
+
+The [next High core-type plan](../agent-context/3518-core-types-next-plan-2026-09-08.md)
+extracts actual type construction/equality and supporting data contracts before
+the larger async/dialect node split. It is advisory, requires fresh claim
+reconciliation, and grants no deletion or new host/linear implementation.
+
+### Checkpoint CI handoff and Temporal acquisition evidence — 2026-09-08
+
+Lowering [PR 5738](https://github.com/loopdive/js2/pull/5738) at `c257b466`
+and ABI [PR 5739](https://github.com/loopdive/js2/pull/5739) at `c3afa438`
+are open, non-draft and held. Fresh PR-head checks finished with 29 success
+and 13 skipped contexts each, including quality/equivalence/linear. This is
+not merge-group conformance. ABI's missing `planningSealed` rooted caller
+and requested compatibility decision remain unresolved.
+
+N1 merged through PR 5735 at `b9a67c10b4b06cabcc020e0dea1dfa105267661e`
+despite host merge-group run 34167945399 failing twenty previously passing
+paths. Lowering PR 5738 records the HEADGREEN cumulative-queue/no-op-check
+incident and the original paired diagnostics. No workflow or ruleset change
+has been authorized or applied. Keep these checkpoint merge holds intact.
+
+Additional read-only CI evidence: all eighteen Temporal failures belong to
+host shard 35/52. Candidate job
+[101882850226](https://github.com/loopdive/js2/actions/runs/34167945399/job/101882850226)
+logs at 22:54:39.041 UTC a provider-not-linked error: extracting
+`jsbi-4.3.0.tgz` failed because `package/dist/jsbi-cjs.js` already existed.
+Three other acquisitions report cache hits. Foundation job
+[101874696210](https://github.com/loopdive/js2/actions/runs/34165082130/job/101874696210)
+reports four successful acquisitions and no such failure. Candidate failures
+follow at 22:54:45–22:56:26 UTC. Source acquisition checks existence then
+extracts into a shared directory without locking (`setup-temporal-polyfill.mjs`
+51–54); worker provider acquisition catches this error and memoizes null
+(`test262-worker.mjs` 1201–1243). This supports a concurrent-extraction
+mechanism. Missing PID-to-row joins prevent attributing each failure to that
+fork; the already byte-identical provider binaries do not establish that each
+worker successfully acquired one. No extraction fix or local conformance run
+was made in this checkpoint.
+
+The two BigInt rows remain unattributed: `array-arg-src-values-are-not-cached.js`
+in shard 31/52 has one retry, without its original reason; the extensibility
+row in shard 34/52 lacks worker-generation evidence. OOMs occur in both
+candidate and passing foundation logs and therefore do not discriminate.
+Provider acquisition must be reproduced with explicit process provenance;
+the original CI failures are not waived or declared flaky.
+
````

No source/tests/policy/current issue changes accompany this archive.
