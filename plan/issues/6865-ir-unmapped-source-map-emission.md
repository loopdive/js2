---
id: 6865
title: "IR source maps: complete unmapped interval recording and safe VLQ rendering"
status: in-progress
sprint: current
created: 2026-10-06
updated: 2026-10-08
assignee: ttraenkler/codex-ir-source-map-unmapped-emission-20261006
branch: codex/3525-source-map-unmapped-emission-20261006
priority: high
horizon: medium
complexity: L
feasibility: hard
reasoning_effort: high
task_type: fix
area: ir, emit, source-maps
language_feature: compiler-internals
es_edition: multi
goal: ir-full-coverage
lane: ir
model: gpt-6-astra
parent: 3525
depends_on: []
---

## Current bounded B implementation handoff — 2026-10-08

This is a narrow documentation publication for the existing issue identity and in-progress status. The full working implementation issue remains local and unpublished; it is not copied into this checkpoint. No source-budget grants or source changes are included.

Canonical documentation base: `8452732f0b88c14c5c7634ece58f83240970ea4c`. A's active integration branch is `codex/6865-public-maps-main-26091-20261007`, at unchanged HEAD/base `26091eabd4561e5be154741e7e18143070d3ce59`. Its current compiler work is uncommitted and unpublished; that base commit is not a usable A native/W1/D1 implementation dependency. The canonical integration claim is `6865:delivered-public-map-integration-20261007`, owner `ttraenkler/codex-ir-public-map-integration-20261007`, write ID `52096-zeyz0drq`, read back from upstream's actual record.

Root reports 51/51 passing only for the tail-Math and recursive-recorder qualification. Its additional 59 cases executed 49 pass / 10 fail for pre-TCO tiny-fixture inlining; the packed producer associated with the foreign issue 4437 claim remains unrepaired. These bounded results do not establish broader completion, native equivalence or delivery. This publication did not rerun or reattribute those source qualifications.

The adopted implementation delegation below was published and read-back verified in [Session A's synchronization record](https://github.com/loopdive/js2/pull/6583#issuecomment-6049709582); the [explicit B notification](https://github.com/loopdive/js2/pull/6583#issuecomment-6061198052) names the same bounded scopes. Registry [PR #6595 — classify eight Linear runtime paths](https://github.com/loopdive/js2/pull/6595) is published at `52b64c8277b4e61c42f24e7821445260aa638179`, based on canonical `8452732f0b88c14c5c7634ece58f83240970ea4c`, READY/HOLD. It is not main delivery: on main alone all eight absent source paths are correctly rejected as stale. Apply only records whose actual paths exist on an exact B head, preserving all baseline entries and validating the whole inventory.

A's native caller and generic carrier joins, W1 and D1 remain unpublished. Proposed interface names and native option combinations below are implementation contracts to agree on, not usable published APIs. Existing B claims, original failures and HOLDs remain untouched. Root retains actual source composition, native caller wiring, integration and protected queue submission.

### Exact adopted handoff

The following adopted text is retained verbatim from the frozen root handoff; claim/provider snapshots inside it remain snapshots requiring revalidation.

# Session A adopted implementation handoff for comment 6055578492

Session A adopts and explicitly delegates the bounded B implementation surfaces in the table below. B may resume those new leaves and the exact append-only CI hook branch after recording and verifying its canonical upstream claims. Shared-file hunks are patches for A review and application; they are not blanket file ownership. A retains real native caller wiring, generic IR/admission/publication, integration and protected queue delivery. No transfer of foreign 2956 or 4540 claims or existing allocator bodies is authorized. No native caller contract has landed yet; the proposed names below are implementation interfaces to agree on, not a claimed published API. All B HOLDs, original failures and regression assertions remain.

## Immediate ownership split

| Work | B's bounded implementation surface after root's explicit delegation | A retains / required join |
|---|---|---|
| Append CI provenance | `scripts/hooks/changed-root-tests.sh`: branch inside the existing `for test_file in $to_run` loop for **only** `tests/issue-6915-linear-owned-ascii-append-copy-kernel.test.ts`; new `scripts/hooks/run-linear-append-provenance.mjs` owns parent manifest construction, exact command spawn, receipt decoding, before/after pins. | `.github/workflows/ci.yml` quality step **Changed root test files must pass (#3008)** is the existing entry; `package.json` `test:changed-root` already invokes the hook. No test-side input discovery/approval, no blanket hook flag change, no advisory-success branch. Workflow changes only if separately reviewed. |
| Native numeric-vector source facts | New frontend-only `src/frontend/ts/linear-vector-admission.ts`, proposed `prepareLinearSourceVectorFacts`: genuine checker/source-node → logical numeric-vector facts; reuse/extract the existing logical-vector algorithm, never duplicate it. | A owns `program-source.ts::prepareIrProgramSources` callsite selecting the facts and `from-ast.ts` generic lowering. Existing `lowerArrayLiteral` already has logical-vector lowering; do not rewrite it into physical pointer lowering. A reviews any narrow extraction from `program-logical-types.ts::buildNativeFamilyLogicalVectors`. |
| Detached Linear memory/resources | New grouped `src/backend/linear/{prepared-memory,physical-resources,body-resolver}.ts`: proposed `prepareLinearPhysicalMemory`, `reserveLinearPhysicalResources`, `fillLinearPhysicalResources`, `createLinearPhysicalBodyResolver`. Consume existing detached `LinearPreparedAllocationFacts`/`LinearMemoryPlanSnapshot`, use `verifyLinearPreparedAllocationFacts` and `planLinearMemoryFromFrozenFacts`; reuse published initialization and forwarding bodies. | A owns `program-physical-plan.ts::planPhysicalSetup`/`PhysicalSetupPlan` and `program-consumer.ts::{physicalSignatureConverter,physicalBodyResolver,reservePhysicalProgramSlots,materializePhysicalProgram}` dispatch hunks. A owns authentic program admission, function-unit identity, source-map capture and primary-body final publication. B must return exact reservation handles for the active module, not numeric/name lookup promises. |
| Existing Linear adapter callsite hunks | In `linear-integration.ts::makeLinearIrResolver`, B may prepare patches for **only** `f64VecHandle`, `resolveVec`, `resolveVecForElement`, `resolveVecValueTypeForElement`, `resolveVecOutOfBoundsConst`, `isVecValueExpression`, and vector arms of `linearRuntimeFunctionName`/`resolveLinearRuntimeOperation`. Move reusable backend-only implementation to the new grouped leaves, keep TS checking in the frontend adapter. A applies/reviews shared-file hunks. | No blanket ownership of `makeLinearIrResolver` or `compileLinearIrFunctions`. `bindUnitFunc`, `requireAllocation`, `resolveModuleBinding`, `resolveGlobal`, import/unit bindings, prepared-overlay authentication, numeric startup, batch custody, terminal/publication predicates, source-map/position recording and physical guard wrappers remain A. |
| Real native caller | B supplies the above provider implementation plus exact typed input/output interfaces and end-to-end fixtures for an explicitly native Linear policy. | **A must implement a real additive public combination**, proposed `{target:"standalone",backend:"linear"}` and `{target:"wasi",backend:"linear"}`, through `CompileOptions`, `TargetProfileInput`/`resolveCompileTargetProfile`, compiler dispatch and actual native resource preparation. These combinations DO NOT currently exist. Existing public `target:"linear"` remains environment `unknown` and legacy; env `JS2WASM_LINEAR_IR=1` cannot authorize it. No idle backend adapter may be reported as completion. |
| Unicode source `.slice` | B new `src/backend/linear/strings/{utf16-layout,utf16-literals,utf16-bindings}.ts` and `src/codegen-linear/runtime/strings/slice-utf16.ts::buildLinearStringSliceUtf16Body`; full closed carrier support, not an isolated helper. B prepares narrow source-method routing hunk in `codegen-linear/string-methods.ts::compileLinearStringMethodCall` and narrow resolver `stringMethodPlan("slice")`/string-method binding hunks for A review. | A owns generic semantic intrinsic/allocation/evidence additions and accepts the carrier contract before wiring. Preserve byte-based `__str_slice` and legacy byte-offset callers such as `__str_split`. Existing ASCII-only validator is not relaxed globally. `IrStringEncoding` remains logical `ascii | utf8-guaranteed | wtf16`; it is not proof of a byte storage ABI. Native UTF-16 carrier contract below is proposed, not a published dependency. |
| Metadata | None in this task. | Separate PR6595 `52b64c8277b4e61c42f24e7821445260aa638179` (root-reported) owns eight registry rows. Apply only rows corresponding to actual paths on each B head, with schema files classified as import targets. Do not apply all eight to main where paths are absent. |

## Exact CI contract

Freshly read published PR6593 head: `0d2dfddb4b1145097210f5398e535e550f945f82`. Source tree: `953f74f80cf2f8085b8e1c93489fcdd357929b37`. These identify the observed checkpoint; a later PR synthetic merge must use its own actual workflow `GITHUB_SHA`/checkout `HEAD`, independently verified before spawn. Never use A's dirty root as a commit.

Existing hook SHA256: `be6df1fa162d4570d28a2791760dd04ed3fd4ecef261db89eb4afe9853a0030f`. Existing workflow SHA256: `55e8214485645765b036d7462fad962565d9d3a7435a4352a2212897f3d33776`.

Proposed approved command, executed exactly as arguments, without a shell:

```text
pnpm exec vitest run tests/issue-6915-linear-owned-ascii-append-copy-kernel.test.ts --pool=forks --poolOptions.forks.singleFork=true --no-file-parallelism --reporter=default --reporter=json --outputFile=.tmp/6915-ci/observations.json
```

Set `JS2WASM_LINEAR_IR=1`, `VITEST_FORK_MAX_OLD_SPACE_SIZE=4096`, unset `NODE_OPTIONS`, set **`JS2WASM_APPEND_TEST_COMMAND`** to that exact command. Supply `JS2WASM_APPEND_EXPECTED_PROVENANCE` as JSON with exactly nine fields:

```json
{
  "runtime": "2a562751f9e2c6291944836681b3bc99b402c2d154a88c429ee16013eaf09e0f",
  "consumer": "262d9866247af2e2fa18a6f8dbdf9d4a07c37c6ae188eb491a312949e6c60404",
  "integration": "8bcc7d6507cb6abd1c4333e43fe5fef015f6649dd788221778aa61e6911c1571",
  "sourceTree": "953f74f80cf2f8085b8e1c93489fcdd357929b37",
  "testSha256": "c63e83104b42104c0ea9e7d5d3fb3f6f2cce960a65973cbf342698e8e79d7f8d",
  "fixture": "66a15148fdd960dcbe5d87c25a28d870e8db9d00865483d708f0ca4e6e6e335c",
  "head": "0d2dfddb4b1145097210f5398e535e550f945f82",
  "command": "pnpm exec vitest run tests/issue-6915-linear-owned-ascii-append-copy-kernel.test.ts --pool=forks --poolOptions.forks.singleFork=true --no-file-parallelism --reporter=default --reporter=json --outputFile=.tmp/6915-ci/observations.json",
  "effectiveFlags": {
    "linearIr": "1",
    "nodeOptions": null,
    "execArgv": ["--max-old-space-size=4096", "--expose-gc", "--conditions", "node", "--conditions", "development"]
  }
}
```

This example belongs to the observed checkpoint plus the **new proposed command**; it is NOT a qualification receipt. The reviewed runner must compare source/test/fixture worktree bytes to git-object bytes and the approved source/hash pins; verify `HEAD === GITHUB_SHA` in CI (actual synthetic-merge checkout), `HEAD:src`, clean `src`, unchanged head/tree/hash inputs after completion. If future reviewed production input changes, root/B reviewer issues a new expected manifest; the test cannot select its own expected hashes. No reading assertions/provenance output to populate expected input. Historical `352acc…` receipt with a 1024-MiB worker is historical evidence only, not current CI input. The existing hook exports 4096 MiB. The reviewed Vitest pool config plus Vite conditions gives the ordered argv above; a changed dependency/config or profile flag requires a new reviewed flags contract, not learning the answer from the test.

Require exit 0, actual JSON reporter 36 passed / 0 skipped / 0 failed / 0 errors, exactly one valid provenance + all 36 unique expected observation IDs + one valid completion envelope, no schema/emission/cleanup errors, and preserved complete diagnostic graphs. Missing provenance, 36 setup-skips, truncated output, missing completion, duplicate IDs, unexpected flags, dirty source, timeout or missing reporter file are failures. Do not use `--dangerouslyIgnoreUnhandledErrors` for this special command. Preserve the existing other-file hook behavior, cap, order and fail-fast reporting.

## Hard native and Unicode boundaries

The native contract must be created by actual option normalization and native runtime setup, never by changing `unknown` to `none` inside an adapter. `linearIrEnabled(policy)` and `prepareLinearIrOverlay` already call `assertNativeIrPolicy`; these checks stay intact. Current ordinary B fixtures use public `{target:"linear"}`. Preserve them as historical/failing obligations; add genuine native counterparts rather than silently relabeling those tests or claiming the old IR-positive expectation can pass under the new native-only policy unchanged.

Proposed native Linear string carrier: one closed representation per native compilation, `string:utf16-code-units-v1`, little-endian i16 code units, explicit checked payload-byte count and code-unit length, literal encoding via `charCodeAt` preserving every 16-bit unit. Keep the old UTF-8-byte layout and its callers unchanged. New slice consumes/returns the new carrier and implements `ToIntegerOrInfinity` bounds in UTF-16 units; lone high/low surrogates and either half of a split pair remain representable. Close all reachable producer/consumer operations (literal, equality, concat, length, charAt, charCodeAt, repeat, hashing if reachable) under the same carrier or reject before publication. No raw pointer mixing or lossy TextEncoder/TextDecoder boundary. This does not by itself repair the existing legacy public Linear Unicode wrong answer: the direct source method needs an explicit carrier-aware frontend join with lossless producers/consumers, while byte-helper callers retain their byte contract.

Claims inspected at registry tip `fdac296bdd7b84971e7850fa7f7c35a07dc60637`: B's existing 6899/6905/6911/6914/6915 claims remain held; 2956-l2-vec and allocator 4540 (`12703-i71z8kda`) are foreign active records. Root must reconcile those before delegating edits to their existing bodies. New leaf allocation APIs must consume the canonical allocator; no copied allocator or changes to allocator wrap/OOM policy. W1/D1 are local unpublished source packets and cannot be cited as usable dependency commits. Re-pin claims and source before implementation; no assumption of ownership from an absent claim.


### Exact input paths and published checkpoints

The nine-field parent manifest hashes these git-object byte paths independently of the test: runtime=`src/codegen-linear/runtime.ts`; consumer=`src/ir/backend/frozen-body-consumer.ts`; integration=`src/ir/backend/linear-integration.ts`; testSha256=`tests/issue-6915-linear-owned-ascii-append-copy-kernel.test.ts`; fixture=`website/public/benchmarks/competitive/programs/string-hash.js`. sourceTree is the actual checkout `HEAD:src`. HEAD is the actual checked-out commit verified against workflow GITHUB_SHA. Never substitute a cached PR head for the synthetic merge head.

Published provider checkpoints inspected: slice PR6575 `e04ba4a8df5b81d65787f2b574e0d8f433bd3060`; detached-memory PR6577 `54e235eb04a7e1dedca95f7f83ebd1563a99a250`; char-code PR6583 `abe2db03bd680114e83e27ffd6134d50d62e5b68`; forwarding PR6590 `82e9517ae762b0f53811b62e8ad6fe5cf34b38cd`; append PR6593 `0d2dfddb4b1145097210f5398e535e550f945f82`. These independent checkpoints are not a claim of one composed passing branch. Revalidate dependency ancestry and reviewed source deltas before integration. A's only new published dependency in this handoff is registry PR6595 `52b64c8277b4e61c42f24e7821445260aa638179` based on `8452732f0b88c14c5c7634ece58f83240970ea4c`; W1/D1 and A native wiring are still unpublished.

Please acknowledge the exact owned surfaces and return your issue:slice records, branch and exact published head in this thread. A will not edit B branches or claimed implementation files. B can begin the bounded CI/provider/carrier work now; end-to-end native completion still requires A's actual caller join. Work is recorded in A's plan/issues/6865-ir-unmapped-source-map-emission.md and plan/log/ir-coordination-session-a.md.


## Complete adopted implementation plan

Root adopted the complete Astra plan below, preserved verbatim. The current integration claim is `6865:delivered-public-map-integration-20261007`, owner `ttraenkler/codex-ir-public-map-integration-20261007`, write ID `52096-zeyz0drq`, freshly read from canonical upstream. The historical root-claim snapshot in the plan is preserved as evidence and does not supersede this current owner or transfer any scope. The plan's relative evidence filenames identify the planner's frozen local packet; this documentation publication does not publish those raw packets or turn W1/D1/native contracts into dependency commits. No new grant is added.

Frozen full-plan SHA256: `ca7b3e3ed09a89da6917231a7ccc906369e567d2e180e0b145ac05c5f299d636` (28,677 bytes).

# Issue 6865: concrete B unblock contract, 2026-10-08

Root has adopted the bounded handoff in `handoff.md`: B implements the append-only CI branch/runner, new grouped frontend/backend provider and UTF-16 leaves, and prepares the specified shared-file hunks for A's review. A retains public native-option wiring and generic admission/publication integration. This document specifies implementation, not an assertion that it has happened. No source/test/runtime/Git/claim mutation occurred during planning. The original blocker is PR6583 comment 6055578492, preserved in `raw/b-blocker-comment-6055578492.json`.

## Published inputs and claims

| Published checkpoint actually read from GitHub | Exact head | Use |
|---|---|---|
| canonical main | `8452732f0b88c14c5c7634ece58f83240970ea4c` | Common inspected source baseline; source tree `953f74f80cf2f8085b8e1c93489fcdd357929b37`. |
| PR6593 append | `0d2dfddb4b1145097210f5398e535e550f945f82` | Existing 36-case instrumentation/parent schema and historical receipts; CI fix belongs on this existing PR after B coordination. |
| PR6583 charCodeAt | `abe2db03bd680114e83e27ffd6134d50d62e5b68` | Reusable provider with held Unicode capability; no broader Unicode approval. |
| PR6577 initializer/prepared memory | `54e235eb04a7e1dedca95f7f83ebd1563a99a250` | Published initializer body and original positive array fixture; shared prepared-memory requirement still fails. |
| PR6575 slice | `e04ba4a8df5b81d65787f2b574e0d8f433bd3060` | Existing byte-bounds helper and preserved source-method/Unicode plan; not UTF-16 storage implementation. |
| PR6590 forwarding | `82e9517ae762b0f53811b62e8ad6fe5cf34b38cd` | Published forwarding resolver body; true source/runtime join remains required. |

PR6595 registry `52b64c8277b4e61c42f24e7821445260aa638179` is separately reported by root as READY/HOLD; this planner did not refetch it and makes no new registry implementation. Do not treat its full eight-row patch as applicable to a tree missing those paths. Published heads above are independently read checkpoints, not an assertion that the branches are all mutually ancestral or cherry-pick clean. Re-pin and perform real composition before qualification.

The inspected canonical claim tree is `fdac296bdd7b84971e7850fa7f7c35a07dc60637`; `claim-summary.json` preserves all 33 relevant actual rows and their Git blob IDs, not an empty claim scan.

| Held scope | Actual owner / write ID | Constraint |
|---|---|---|
| 6865 root | `ttraenkler/codex-ir-source-map-unmapped-emission-20261006` / `47167-a5t0nxte` | Sole root issue/integration authority. |
| Linear final publication | `ttraenkler/codex-ir-linear-finalizer-20261007` / `28036-pgi30p9o` | Preserve finalization ownership. |
| Linear source-map batch | `ttraenkler/codex-ir-source-map-linear-batch-20261006` / `73842-fi7ja4yi` | Preserve capture/batch/publication ownership. |
| 6899 slice source/tests | `ttraenkler/codex-linear-b-slice-sol61-20261007` / `32059-6deu68vp`; tests / `29352-b0iuwuid` | Existing B bodies/tests remain with B. |
| 6905 initializer/source + regression | `ttraenkler/codex-linear-b-vec-initializer-sol61-20261007` / `4467-r35vmfcy`; tests / `80557-9wh1s7sf` | Extend through exact new join, preserve original failing positive. |
| 6911 charCodeAt source/tests | `ttraenkler/codex-linear-b-char-code-at-sol61-20261007` / `48475-4yjqyo7z`; tests / `48954-spdoxp5u` | No blanket neighboring runtime edits. |
| 6914 forwarding source/tests | `ttraenkler/codex-linear-b-forwarding-sol61-20261007` / `65589-oamjn90s`; tests / `67259-ma7wrz3z` | Reuse canonical body, no second forwarding implementation. |
| 6915 append tests/shepherd | `ttraenkler/codex-linear-b-append-tests-sol61-20261007` / `56295-npm2trsg`; shepherd / `31946-4po3larl` | Root-adopted CI additions need recorded bounded claim; existing test assertion contract stays. |
| 2956-l2-vec | `ttraenkler/codex-l2-vec`, no write ID in actual old record | Still in progress. No silent takeover from age. |
| 4540 allocator | `ttraenkler/claude-opus` / `12703-i71z8kda` | No allocator body, wrapping or OOM semantics changes absent transfer. |
| 6865 registry | `ttraenkler/codex-ir-b-linear-registry-sol61-20261008` / `28167-6syhbzly` | Separate worker; no duplication here. |

W1 model extraction and D1 pure telemetry contracts are **unpublished local packets**, recorded with their actual file bytes under `source-preimages/unpublished-W1` and `unpublished-D1`. They have no dependency commit hash. A must integrate and publish the selected source epoch before B can base shared edits on it. B may build isolated pure leaves against the reviewed interfaces, but cannot report the joined graph or end-to-end native caller qualified until that actual dependency exists.

## CI implementation steps

The immediate handoff and full nine-field JSON are in `handoff.md`; its correct environment identifier is `JS2WASM_APPEND_TEST_COMMAND`. Existing test authorities are `parseParentIdentity` (line794), `validateRecord` (1011) and `beforeAll` (1387) in the pinned test. No test is to set its own expected manifest, read CI and bless itself, weaken exact fields, lower 36 observations, or accept setup-skips.

Map each parent field to these exact repository paths:

| Field | Independent trusted parent input | Hash at PR6593 head |
|---|---|---|
| `runtime` | SHA256 of `src/codegen-linear/runtime.ts` | `2a562751f9e2c6291944836681b3bc99b402c2d154a88c429ee16013eaf09e0f` |
| `consumer` | SHA256 of `src/ir/backend/frozen-body-consumer.ts` | `262d9866247af2e2fa18a6f8dbdf9d4a07c37c6ae188eb491a312949e6c60404` |
| `integration` | SHA256 of `src/ir/backend/linear-integration.ts` | `8bcc7d6507cb6abd1c4333e43fe5fef015f6649dd788221778aa61e6911c1571` |
| `fixture` | SHA256 of `website/public/benchmarks/competitive/programs/string-hash.js` | `66a15148fdd960dcbe5d87c25a28d870e8db9d00865483d708f0ca4e6e6e335c` |
| `testSha256` | SHA256 of `tests/issue-6915-linear-owned-ascii-append-copy-kernel.test.ts` | `c63e83104b42104c0ea9e7d5d3fb3f6f2cce960a65973cbf342698e8e79d7f8d` |
| `sourceTree` | `git rev-parse HEAD:src`, exact 40 lower-hex digits | `953f74f80cf2f8085b8e1c93489fcdd357929b37` |
| `head` | `git rev-parse HEAD`, matching workflow checkout `GITHUB_SHA` | Observed PR head `0d2dfddb4b1145097210f5398e535e550f945f82`; actual future merge head must be freshly obtained. |
| `command` | Reviewed literal from handoff, fixed argument vector | Not inferred from test argv or output. |
| `effectiveFlags` | Reviewed child environment/worker contract | Exact nested keys `linearIr`, `nodeOptions`, `execArgv`. |

The driver is a trusted parent relative to the test; this does not make arbitrary PR code inherently trustworthy. Root's adopted plan authorizes this implementation and these initial source/test/fixture pins. A reviewer must approve subsequent expected source/test/fixture changes. HEAD can change for the CI-only patch and synthetic merge, while initial reviewed source/hash pins stay the same. If a refreshed main changes source, stop and produce a new reviewable parent manifest. Do not silently refresh pins from whatever bytes happen to be under test.

1. Add the exact-path branch to `scripts/hooks/changed-root-tests.sh` within its existing per-file loop. Continue routing all other files through their existing command. Retain selection, maximum 20 files, base resolution, order, failure exit and remaining-NOT-RUN output. This is not authorization to run another matrix or bypass ordinary quality.
2. New runner functions, with names proposed for implementation: `readApprovedCheckout`, `buildExpectedProvenance`, `assertFrozenInputs`, `runAppendQualification`, `validateAppendReceipt`. Use Node built-ins only, fixed argv spawn, bounded timeout, separate raw stdout/stderr plus JSON reporter. Refuse preexisting stale output or create a unique run directory whose actual path is included in the approved command; the fixed `.tmp/6915-ci/observations.json` variant must remove only its own known old output before spawn and save a unique custody receipt.
3. Read HEAD from Git; in CI require exact `GITHUB_SHA` match and a known PR checkout event. Read each expected file through `git show HEAD:<path>` and hash it; compare actual filesystem bytes exactly, clean `src`, and the approved pins. Check root/branch/HEAD as applicable. Missing files, source dirt, mismatch or absent trusted identity exits before Vitest. For local developer invocation require an explicit separately supplied parent manifest/HEAD; do not quietly turn any dirty developer tree into approved input.
4. Child environment: `JS2WASM_LINEAR_IR=1`, `VITEST_FORK_MAX_OLD_SPACE_SIZE=4096`, `NODE_ENV=test`, unset `NODE_OPTIONS`, `JS2WASM_APPEND_TEST_COMMAND` exact literal, `JS2WASM_APPEND_EXPECTED_PROVENANCE` JSON. Reject inherited profiling/diagnostic options that Vitest forwards; no hidden additional worker flags. Expected argv is exactly `["--max-old-space-size=4096","--expose-gc","--conditions","node","--conditions","development"]`. Existing `vitest.config.ts` supplies memory/expose-gc, Vitest's `createPool` supplies Vite conditions. This is a reviewed, source-grounded expectation, not a successful runtime measurement of the new runner. If actual pinned CI dependencies give different flags, preserve the failure and have the reviewer update the contract from independent configuration evidence.
5. Spawn the strict command in handoff (no `--dangerouslyIgnoreUnhandledErrors`). Parse only full `6915-evidence-graph-v1` envelopes, validating the lossless graph encoding before interpreting record fields. Preserve Error causes/properties, undefined, bigint, NaN, infinities, negative zero, maps/sets, cycles and typed-array backing ownership; do not reduce diagnostics to strings or JSON-flattened snapshots. A generic decoder in the runner is observation only, never acceptance authority inside the test.
6. Require one schema `6915-append-baseline-v2` provenance matching all nine parent fields, exactly 36 observation IDs matching the pinned test's reviewed ID set, and one completion with `passed=true`, no duplicates/missing/unexpected/failures/actionFailures/schemaFailures/emissionFailures/cleanupErrors. Accept the real diagnostic envelope format if present, but any failed diagnostic fails the gate; expected negative tests are already represented by their passing assertions. Require reporter 36 passed, zero skipped/failed/errors, exit0, complete output. Preserve raw and decoded artifacts even when failing. A runner must never interpret an absent report or missing graph as an empty successful result.
7. Recheck all HEAD/tree/source/test/fixture inputs after child exit, save the exact command/manifest/observations/receipt. Exit nonzero on post-run drift or any failure. Existing `beforeAll` missing-input failure (36 setup-skips and zero observations) remains a failing instrument outcome, not repaired functionality. This CI fix makes ordinary quality run the instrument under an authorized parent; it does not implement owned append, native array admission or Unicode.
8. B publishes only to existing PR6593 after its own required checks and claim coordination. Parent/root final integration retains HOLD until observed combined results justify release. No rerun labeled advisory-green can substitute for the required quality check.

## Native numeric vectors: concrete construction and A joins

The current A root already supports logical vectors inside `from-ast.ts::lowerArrayLiteral` and logical read/write arms, but `program-source.ts::prepareIrProgramSources` currently passes `logicalVectorTypes` only for the native-family preparation at line1543. Do not add a second physical array lowerer. The ordinary PR6577 positive source is a genuine two-argument numeric array literal, indexing and length; its published expected numerical result is 1.25 for `(1.5,-2.25)` and must remain intact.

B's frontend leaf `prepareLinearSourceVectorFacts` must derive a bounded map of actual source nodes/checker symbols to existing logical `IrType` vectors for dense f64 arrays, proving element types, local aliases and operations from the same source/checker snapshot. Reuse the actual algorithm in `buildNativeFamilyLogicalVectors` where applicable; A performs/reviews any shared extraction so async-family behavior remains unchanged. Missing facts/refused types stay explicit. Do not globally make `resolveIrVecType` treat any i32 or identifier as an array. Spread, elision, mixed/nullable elements, unknown calls and unsupported escape cases require explicit proof or refusal. The canonical logical IR continues to express vector creation/access/length/mutation; no memory offsets, helper names or fake Wasm GC type indices enter generic IR.

B's `prepareLinearPhysicalMemory` is a source-free backend planner over canonical detached allocation records and a selected allocator policy. Preserve exact site IDs, registry snapshot, ownership/access/escape/encoding data and **presence bits** for absent versus explicit undefined evidence. Use `prepareLinearAllocationFacts` at the existing frontend-to-frozen boundary; `verifyLinearPreparedAllocationFacts` and `planLinearMemoryFromFrozenFacts` verify detached materialization. The existing `PreparedIrProgram` allocation snapshot does not automatically contain all of this evidence: A must add a canonical persisted contract and codec/validator join if absent, with one calculation and explicit versioning. B supplies the pure projection, never synthesizes checker nodes or re-runs frontend after decode.

`PhysicalSetupPlan` currently has native GC vector resources and no completed Linear memory projection; `planPhysicalSetup` explicitly refuses Linear programs with allocations (line1458). Replace that one gap only after B returns a complete, validated Linear resource description. Make the backend-specific branch explicit/discriminated so a Linear plan cannot flow into `reserveNativeProgramFoundation` or GC `physicalSignatureConverter`. Preserve the GC path exactly. A owns the setup plan schema/codec and accepted-program private records; B cannot issue accepted-program identity or mutate the acceptance registry.

B's `reserveLinearPhysicalResources` must, before lowering source bodies, reserve the real defined memory, initial data segments/alignment/offsets, allocator globals, function types and provider functions through the actual `PhysicalModuleReservations`. Use `reserveMemory`, `reserveDataSegment`, `reserveGlobal`, `reserveFunction` and canonical type reservation. The returned record contains actual module-owned reservation objects mapped by canonical resource/binding keys. No raw `module.functions.push`, tentative function index, function-name-only authority, test shim memory, or copying a foreign reservation. Imported host memory is not the supported native defined-memory contract; the existing reservation class intentionally does not admit it. Reserve all demand before fill, fill once, validate and seal once through A's current lifecycle.

Provider bodies reuse the published B leaves:

- `buildLinearF64VectorInitializationBody` from PR6577 has value-first ABI `(f64 value, i32 pointer, i32 index) -> void`; preserve f64 stores, element offset16 and stride8, no i32 truncation or source namesake substitute.
- `buildArrayForwardingResolverBody` from PR6590 follows actual forwarding tag0x06 and pointer-offset4 chains. Preserve shared aliases after growth and use the actual reserved helper.
- Existing numeric-vector layout has tag at offset0, payload size at offset4, length at offset8, capacity at offset12, and elements at offset16; preserve canonical layout calculation, minimum capacity and checked runtime behavior. Do not clone `__arr_new`, `__arr_set`, the allocator or foreign-owned routines into a new file to evade ownership. B may make new resource reservations around the canonical providers and propose precisely bounded extraction to their owners.

`createLinearPhysicalBodyResolver` provides logical-vector → i32 carrier conversion, exact allocation-layout lookup, canonical helper reservations, scalar/global/import references and per-body scratch/local requirements. Scratch locals must be allocated against each actual body signature/local space, not a global guessed index. The resolver must reject a missing/foreign/reused allocation and unsupported logical element type before source publication. Runtime helper reservation signatures must be checked against emitted call sites. Existing generic call-site lowering and source-coordinate wrappers remain A's.

A's actual callsite join order:

1. Add the proposed public `backend?: "wasmgc" | "linear"` selector and reject contradictory/unsupported combinations explicitly. Existing defaults and `target:"linear"` policy stay unchanged. Standalone/WASI + Linear become admitted only with real native semantic providers, `hostValueInterop:"off"`, explicit runtime manifest policy, no JS bridge, and the selected allocator implementation. The TypeScript public option, normalized profile, compiler dispatch and internal invocation options must all agree; adding only an internal flag is not completion.
2. Route admitted native Linear source through `prepareIrProgramSources` with authentic vector facts; persist the exact allocation evidence; select the Linear physical planner. The old `target:"linear"` unknown/legacy control must prove it never enters the source/program IR path even with `JS2WASM_LINEAR_IR=1`.
3. In `program-consumer.ts::materializePhysicalProgram`, select Linear setup before any GC foundation reservation; wire the real signature conversion, resources, resolver and scratch allocation. `reservePhysicalProgramSlots`, `fillPrimaryBody`, `fillPreparedPrimaryUnit`, unit-ID mapping and final publication guards remain A-owned. Publish exports only after all authentic source bodies and required support resources fill and the complete census succeeds.
4. Review/apply B's exact existing overlay resolver hunks from `handoff.md` without changing surrounding A custody. The overlay remains a legacy adapter where appropriate; it is not substituted for the shared program emitter. Both consumer paths must use the same canonical backend bodies/layout calculations where they need the same semantics.
5. Run the original numeric fixture through a real public native Linear compile, instantiate the actual artifact, call `(1.5,-2.25)`, assert1.25 and observe real initializer/forwarding ownership at emitted call boundaries. Then freeze/encode/decode/replay without frontend/TS access and require identical logical outcomes and correct resource ownership. Scalar and manually built body controls are useful but do not replace this positive requirement.

Do not rewrite the original public-unknown positive expectation merely to turn a failing historical test green. Under A's native-only policy, its old IR-positive assertion and unchanged `target:"linear"` input are incompatible. Preserve the original record, add the real new-native cohort, and have A/B explicitly resolve the historical test's contract/status with review. Until then that original failure remains visible and blocks claiming all obligations fulfilled.

## Unicode: concrete lossless representation and real source binding

The new backend representation is deliberately separate from logical `IrStringEncoding`. Keep `ascii | utf8-guaranteed | wtf16` as semantic evidence. Current `linear-string-runtime.ts::validateLinearStringRuntimeEncoding` is an ASCII-only capability check on both allocating results and string inputs; current `planLinearStringLayout` uses `string:utf8-bytes-v1`, i8 storage, byte length/payload; current literal `TextEncoder` loses lone surrogates. Removing `requireAscii` would authorize a representation that cannot carry the required result.

Adopt proposed `string:utf16-code-units-v1` for the new closed source-string carrier: i16 little-endian code units; code-unit length at offset8, elements at offset12; payload-size field at offset4 continues to count bytes. Header/layout sizes, alignment, multiplication by2, allocation and maximum address must be checked through the canonical allocator contract. Record the new layout ID in detached plans and physical resource keys. An i32 pointer alone is insufficient representation evidence. A layout/operation binding carries the carrier ID; the verifier rejects mismatched byte-layout input or data segment before any source body publishes.

B's new leaf responsibilities:

- `utf16-layout.ts`: single canonical layout/size calculation and checked code-unit address operations, no TS or frontend import.
- `utf16-literals.ts`: convert each JavaScript code unit via `charCodeAt`, write low/high bytes, retain exact code-unit length; no TextEncoder/TextDecoder normalization. Literal interning keys use the complete code-unit sequence plus carrier ID; no collision between a lone surrogate and U+FFFD.
- `slice-utf16.ts::buildLinearStringSliceUtf16Body`: fresh relocatable body with explicit canonical allocator/reservation operands. Receiver and source arguments evaluate once in source order. `start/end` implement `ToIntegerOrInfinity`; NaN and signed zero→0, infinities clamp, negative finite bounds count from code-unit length, finite fractions truncate, omitted start0/endlength, empty/reversed range returns empty. To avoid losing source semantics, keep f64 bounds until normalization/clamping; choose `(i32 receiver,f64 start,f64 end)->i32` for the provider and explicitly extend the generic source-method plan if it cannot describe this ABI. Do not cast to i32 before handling infinities/large values.
- `utf16-bindings.ts`: bind literal/slice/equality/concat/length/charAt/charCodeAt/repeat and every other reachable producer/consumer to the same carrier. Equality and hashing (if reachable) use full units; concat copies units without combining, rejecting or replacing lone surrogates. A split pair and the same pair written together compare equal because both are the same two-unit sequence. No dispatch to the old ASCII append provider on an unproved UTF-16 result.

A's generic additions must express **semantic** source slice, with UTF-16 indexing and an allocating result site, independently from the name `__str_slice`. Current `IR_STRING_RUNTIME` has no `slice` entry, so B cannot silently invent an operation and skip allocation evidence. A adds the exact canonical intrinsic/IR request, allocation/site/evidence propagation, runtime demand and resolver binding, and full omission/side-effect semantics. B implements the concrete backend operation. The shared resolver `stringMethodPlan("slice")` currently routes to `__str_slice` with i32 indices; replace only the new proven-carrier branch through reviewed hunks. Generic source-map/call wrappers stay untouched.

The direct frontend `codegen-linear/string-methods.ts::compileLinearStringMethodCall` must make the same source-language distinction without invoking program/source IR on the legacy public Linear lane. A source `.slice` is UTF-16 code-unit indexed. Existing internal byte-offset callers such as `__str_split`, and the old `__str_slice` body/helper contracts, remain byte indexed. Introduce an explicit internal source-string carrier/binding selection used consistently by direct literal creation and all reachable direct source-string operations; choose the new carrier for the source family only after its whole producer/consumer closure is implemented. Do not switch just the `.slice` callee while its literal still goes through TextEncoder, and do not wrap old lossy bytes with a UTF-16 name.

The observed direct legacy `"éx".slice(1,2)==="x"` wrong answer is a separate actual obligation that this source-method join must resolve. A native-only provider landing may be useful in stages, but it does not close that legacy direct result. B can implement the new pure family now; root must coordinate direct family wiring and any foreign body extraction. For operations outside the admitted new-carrier closure, preserve the existing supported source behavior or issue an explicit compile-time capability refusal before publication; do not silently change to byte semantics or declare broader Unicode complete. Final release requires the existing source fixture to run correctly in its original lane as well as the new native caller.

Unicode required numerical/code-unit evidence, with original tests retained: ASCII cases unchanged; `"éx"` slice(1,2) equals`"x"`; astral pair slice(0,1) preserves high0xD83D and slice(1,2) low0xDE00; lone high and lone low survive literal→slice→concat→equality; adjacent split halves concatenate to exactly the original two units; U+FFFD stays distinct; empty, omitted, negative, fractional, NaN and ±Infinity bounds follow JS; length/charCodeAt use units. Observe actual source binding and reserved provider call identity, not function name or exported standalone body only. Preserve old byte-helper tests and original `__str_split` byte behavior. Host-assisted/unknown source never enters source/program IR.

## Acceptance and execution order

1. Record root's adopted ownership table and claim the newly delegated B scopes without modifying/releasing foreign claims. Re-pin actual published heads/source bytes. B CI work can proceed immediately on its existing PR; it does not wait for A native publication.
2. Implement CI runner/branch, run its exact finite36 instrumentation under the new trusted input, retain every old failure/skipped record as historical evidence. A red semantic observation is useful, not a reason to suppress the gate.
3. B implements pure frontend/backend leaves against explicit contracts. A publishes/integrates the new native option, canonical allocation serialization and physical consumer dispatch, then gives B a real commit or exact root-owned integration patch review. W1/D1 local source packets are not dependency commits. Keep new backend modules TS/frontend-free; frontend symbol checking stays grouped under frontend. Use canonical Wasm model data once actually published; do not import legacy mixed `ir/types.ts` into a clean leaf.
4. Join vector admission/resources/actual caller first and qualify the genuine numeric positive, alias/growth, fractional-index, store-value-first, preserved allocator/error behavior, reservation negative cases, source-free replay and source-map on/off. Negative controls: stale/wrong-site/foreign reservation, wrong signature, duplicate fill, mutation after freeze, missing demand, name collision and second-body late failure all prevent source publication; healthy prefixes must prove instrumentation executes. Exact guards/ABI issuers remain A's.
5. Join UTF-16 carrier and actual native/direct source method closure, run the cases above plus all original PR6575/6577/6583/6590 fixtures. Standalone and WASI native Linear must each prove real policy/options and native resource ownership. Existing public GC/host/unknown Linear remain legacy source routes. Requalify actual changed-callsite source-map/physical guard tests, not an unrelated full suite substituted for focused proof.
6. Run unchanged boundary inventory and graph tests on the actual combined source. Register genuine new modules with their true layers/target sets; no tolerated edge, mark-dirty, catch-all grant, broad extension exemption or forged empty baseline. Schema/model types must remain frontend-free; runtime bodies can depend on canonical Wasm model/contracts. DCE/inlining are the existing optimizer's responsibility, not hand-inlining canonical helpers to evade graph checks.
7. Preserve all B existing HOLDs until original positive requirements, current quality gates, explicit legacy/direct Unicode obligation and combined source epoch are satisfied. Update existing PRs and root issue/comment; no new issues, auto-merge or queue action is authorized by this plan.

## Evidence inventory

`published-pins.json` records real GitHub blob IDs, SHA256 bytes and complete paths for the five PR plans/tests/source leaves, main workflow/hook/config and historical append runner receipts. An early guessed hook path returned404 and is retained as such; the real discovered hook is pinned separately. `raw/` preserves GitHub PR/file responses and main/claim refs. `claim-summary.json` contains actual held claim records. `source-preimages.json` and `source-preimages/` hold exact A/W1/D1 inspected bytes, explicitly labeled unpublished. Current A `linear-integration.ts` preimage is SHA256 `7c114e1bf67f48253d933a54bfb5261cc2d9a31ee01a288ba55da8c9a6d95559` (115619 bytes). Re-pin before editing; a line-number reference alone does not authorize applying a stale hunk.
