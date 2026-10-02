---
id: 6715
title: "standalone: shift the cached undefined singleton global index after a late host import"
status: in-progress
sprint: current
created: 2026-09-28
updated: 2026-09-28
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: compiler-internals
parent: 4016
assignee: "ttraenkler/codex-undefined-index"
loc-budget-allow:
  - src/codegen/registry/imports.ts
---

# #6715 — Shift the cached undefined singleton global index after a late host import

## Scope and dispatch state

This is the isolated follow-up to [#4016](https://js2wasm.loopdive.com/dashboard/issue.html?slug=4016-standalone-string-search-value-tostring-path). It was reserved atomically on 2026-09-28 through
`claim-issue.mjs --allocate ttraenkler/codex-undefined-index --json`; the authoritative
`upstream/issue-assignments` write succeeded and its open-PR scan reported
`prScan: ok`.

The only production change is in
`src/codegen/registry/imports.ts`, inside `fixupModuleGlobalIndices`. The
focused regression belongs in a new issue-owned test file. Source work proceeds
only in the managed `codex/6715-undefined-global-index` worktree after the
collision/ownership review recorded below.

Out of scope:

- `CodegenContext` shape changes, IR/context/layout changes, and a generic
  global-index relocation rewrite;
- rebuilding helper bodies at finalization or hiding the defect by changing
  source-order/provisioning order;
- unrelated #4016 split coercion residuals.

## Evidence

An earlier private, environment-gated host diagnostic recorded this sequence:

1. Before adding the real host string constant for the `"number"` hint,
   `numImportGlobals` was `0` and `undefinedGlobalIdx` was `11`.
2. Afterwards `numImportGlobals` was `1`, but the cache remained `11`.
3. Absolute global slot `11` then resolved to `__symbol_counter:i32`, rather
   than the anyref-compatible undefined singleton.

That matches the observed invalid-Wasm shape:

```
global.get i32; extern.convert_any
```

The trace did **not** print the final `canonicalUndefinedExternInstrs` body.
It therefore proves the stale-cache mechanism and wrong resolved slot, not that
every invalid-Wasm route uses this exact emitter.

Static source proof narrows the mechanism:

- `ensureAnyValueType` in `src/codegen/any-helpers.ts` caches the singleton's
  absolute index as `ctx.numImportGlobals + ctx.mod.globals.length`.
- `canonicalUndefinedExternInstrs` subsequently emits that cached index as
  `global.get(ctx.undefinedGlobalIdx)` followed by `extern.convert_any`.
- `addHostStringConstantGlobal` inserts an import global in native-string host
  mode, then invokes `fixupModuleGlobalIndices(ctx, oldNumImportGlobals, 1)`.
- `fixupModuleGlobalIndices` already shifts compiled bodies and many cached
  module-global indices, including the adjacent symbol globals, but currently
  omits `ctx.undefinedGlobalIdx`.

## Implementation Plan

1. In `fixupModuleGlobalIndices`, add the same threshold-and-delta adjustment
   used by the nearby scalar cached module-global fields:

   ```ts
   if (ctx.undefinedGlobalIdx !== undefined && ctx.undefinedGlobalIdx >= threshold) {
     ctx.undefinedGlobalIdx += delta;
   }
   ```

   Keep it next to the other singleton/global cache repairs so it follows the
   existing invariant: an import inserted at `threshold` shifts every
   module-defined absolute global at or above that point.
2. Do not alter the instruction walker, deferred string handling, helper-body
   construction, or import order. The existing walker already repairs emitted
   `global.get`/`global.set` instructions; this slice repairs the later cache
   lookup used by newly emitted instructions.
3. Add a focused regression that creates the undefined singleton, inserts a
   late host string global, then emits another canonical undefined conversion.
   Inspect/instantiate the generated module so the assertion proves the final
   read resolves to the undefined singleton rather than an adjacent i32 global
   such as `__symbol_counter`.
4. Re-run the historical host post-`ToPrimitive` Symbol-limit control as a
   consumer regression in a separate #4016-checkpoint integration checkout:
   preserve one `"number"`-hint invocation, require a catchable JavaScript
   `TypeError`, preserve separator non-coercion, and reject invalid Wasm. Keep
   the raw historical diagnostic separate from this new proof. This integration
   evidence must not pull #4016 source changes into the independent #6715 PR.
5. Compare the focused control on a clean base and the candidate with matching
   source/test hashes. Retain existing dynamic-undefined/null and standalone
   native-Symbol controls; report all row transitions rather than relying on a
   single successful instantiation.

## Ownership and collision gate

The #4016 parent worktree must remain unchanged by this slice. An IR task
reported no current assignment for `fixupModuleGlobalIndices` or
`ctx.undefinedGlobalIdx`, but that is task-local information only—not a
repository-wide ownership clearance. Before implementation, this issue requires
the dedicated pre-dispatch gate, an authoritative claim-record read, and a
fresh exact-function overlap check. A separate managed worktree/branch/PR is
required; this issue must not be folded into #4016's draft checkpoint.

### 2026-09-28 implementation-gate receipt

The earlier self-claim was released before the implementation dispatch. A fresh
`pre-dispatch-gate` run for #6715 then returned `CLEAR`, with no blockers or
warnings; its idiom scan was unavailable because this issue had not landed yet.
The issue was then claimed again and verified through the authoritative
`upstream/issue-assignments` record for the
`codex/6715-undefined-global-index` branch. That claim remains held and must
not be released by this slice.

The required exact-function collision review was also completed before source
work. Three preserved historical #5344 worktrees carried the same old
uncommitted `fixupModuleGlobalIndices` hunk, but the #5344 plan is `done` and
its PR #5650 landed. Current upstream is a strict superset of that function:
it contains the historical changes plus deferred-string resolution, the indexed
walker, and the class-static-sidecar cache shift. None of the historical hunks
touches `undefinedGlobalIdx`. The IR task reported no task-local ownership of
this exact function/cache; that information was used only alongside the
authoritative landed-content comparison. The historical worktrees remain
preserved and untouched.

## Acceptance

- [x] A late import shifts `ctx.undefinedGlobalIdx` when its absolute slot is
      at or above the insertion threshold.
- [x] A post-shift canonical undefined conversion reads an anyref-compatible
      undefined singleton, never the neighbouring `__symbol_counter:i32` slot.
- [ ] The focused host Symbol-limit consumer produces a catchable JavaScript
      `TypeError` rather than invalid Wasm, with the recorded evaluation order.
- [x] Matched clean-base/candidate controls report source hashes, command,
      effective heap lane, and every pass/fail transition.
- [ ] Scoped type, coercion, boundary, formatting, and normal commit/push gates
      pass without hook bypasses. The reviewed, issue-scoped LOC allowance below
      is the sole exception; no other allowance is used.

## Independent landability and linked consumer dependency

This patch is independently landable because it restores the local index
relocation invariant: every cached absolute index of a module-defined global
must move by the import-global delta when it lies at or above the insertion
threshold. The focused clean-base/candidate regression proves that invariant,
the final Wasm module shape, and runtime read without importing #4016's staged
split changes.

The [#4016 host Symbol-limit consumer](https://js2wasm.loopdive.com/dashboard/issue.html?slug=4016-standalone-string-search-value-tostring-path)
remains an explicit integration dependency, not a claim that this patch fixes
its semantics. Its frozen pair establishes that this repair removes the
invalid-Wasm blocker while leaving a separate host-bridge runtime result for
its owner. A #6715 PR may describe that linked unresolved consumer and its
evidence, but must not claim the consumer acceptance is complete or fold its
implementation into this registry-only change.

### Reviewed LOC-budget exception

`src/codegen/registry/imports.ts` exceeds its current 2,713-line budget by
exactly the three required cache-repair lines in this issue. The repository
hook requires the PR's own issue frontmatter to name that file, so this plan's
`loc-budget-allow` is intentionally limited to that path. It permits the
reviewed threshold-and-delta invariant repair only; the global budget baseline
and checker remain unchanged. No unrelated lines were removed or compressed to
game the budget, and no other allowance or hook bypass is authorized.

## Scoped independent-landability gates and receipts

No further #4016 bridge diagnostic is planned for this issue. The authorized
scoped execution lease covers only the independently publishable registry repair:

1. Run the focused #6715 regression as a matched clean-base/candidate pair
   with the explicit Node 24.19.0 binary, one Vitest fork, no file parallelism,
   and an effective 4 GiB parent/fork limit. Keep the regression source hash
   fixed between arms and restore the three-line candidate hunk after the
   clean-base arm. The direct command for each arm is:

   ```sh
   VITEST_FORK_MAX_OLD_SPACE_SIZE=4096 NODE_OPTIONS=--max-old-space-size=4096 \
     /Users/thomas/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node \
     --max-old-space-size=4096 node_modules/vitest/dist/cli.js run \
     tests/issue-6715-undefined-global-index-late-import-shift.test.ts \
     --pool=forks --poolOptions.forks.singleFork=true --no-file-parallelism \
     --reporter=verbose
   ```

   Record the resolved Node version, command, source hashes, exit status, and
   complete baseline/candidate row transition. This replaces neither the
   preserved earlier pair nor the frozen #4016 evidence; it supplies the
   missing runtime provenance for the independent regression.
2. Run the two existing `#3933` cases selected from
   `tests/issue-3921-shared-empty-vec.test.ts` with Vitest's `-t '#3933'`
   filter. It is the smallest relevant adjacent control: it covers a different
   cached module-global shifted by a late host string import, while the new
   #6715 test remains the sole undefined-singleton regression. Do not add the
   broader undefined, walker, or #4016 suites.
3. Run the narrow source/plan controls under the same Node 24-prefixed PATH:
   `git diff --check` for the three issue-owned files;
   `pnpm exec prettier --check` for the changed TypeScript and Markdown files;
   `pnpm exec biome lint` for the changed TypeScript files; `pnpm run typecheck`;
   `node scripts/check-compiler-boundaries.mjs --mode inventory --base HEAD`
   (the CI counterpart uses `--base HEAD^1` after commit);
   `pnpm run check:oracle-ratchet`;
   `pnpm run check:coercion-sites`; and `pnpm run check:issues`.
4. Do not treat these scoped checks as a hook bypass. Normal pre-commit and
   pre-push gates still run at commit/publication time without `--no-verify`.
   The focused pair is expected to take roughly two single-test compiler runs;
   the remaining controls are limited to the standard type, formatting,
   boundary, ratchet, and issue-integrity lanes. No broad suite, consumer
   fixture, or #4016 semantic test belongs in this lease.

The #4016 consumer acceptance remains unchecked regardless of these results.
It is a linked integration dependency, not an independent-landability gate for
this three-line cache repair.

The unqualified `pnpm run check:compiler-boundaries` was also observed once
under Node 24.19.0. It reported `errors: []` and
`inventory-valid-architecture-incomplete`, but exits 1 in its deliberate
whole-repository `complete` mode while 1,395 classified files remain unmigrated
(1,311 in `mixed-needs-split`). That completion status is pre-existing
repository migration debt, not a #6715 boundary violation. The CI and scoped
gate contract is inventory mode, which validates the active closures while
reporting that debt.

### Verified Node 24 focused pair and adjacent cache control

The repeated pair used the exact command above with the explicit Node 24.19.0
binary in both arms. It preserved the candidate hunk after the baseline and
used the same test source SHA-256
`04a607ee16b73c519c79c2f6dc5a9d02c9c2ba0b39f106626cb8c464b338dc24`:

| Arm | `imports.ts` SHA-256 | Exit | Result |
| --- | --- | --- | --- |
| Baseline | `39d00e9bc74ce6bbc94e70f06d7421017ef2b5acb6cdc94d50f1c518baefb4e1` | 1 | Expected 1/1 failure: the cache remained `1`, where the shifted singleton index is `2` (22.28 s). |
| Candidate | `8aae5e7a0e233f06ead2bd6900f9b48bff14650ae8ffd2c129e133a05abac1ca` | 0 | 1/1 passed, including validation, compilation, instantiation, and the exported singleton-tag read (17.65 s). |

The durable receipts are
`/private/tmp/js2-6715-node24-baseline.i99C8a/{receipt.txt,vitest.log}` and
`/private/tmp/js2-6715-node24-candidate.O6SXID/{receipt.txt,vitest.log}`.
Each records `v24.19.0`, the exact command, source hashes, base HEAD
`aca46e64cded68942686f67a52c38bb1d3c358ab`, and exit status.

The selected adjacent cached-index control ran with the same Node/fork settings:
`tests/issue-3921-shared-empty-vec.test.ts -t '#3933'` (test SHA-256
`b3f211c2c82fc5f98005227c67b0dbe078ce0d10dfb081ab141fda2bce3409cf`).
It passed both selected #3933 late-host-import cache cases; Vitest explicitly
skipped the three unrelated #3921 cases. Its receipt is
`/private/tmp/js2-6715-node24-cache-control.70Rizi/{receipt.txt,vitest.log}`
(exit 0, 17.92 s). It is a companion control only, not a substitute for the
undefined-singleton fixture.

### Scoped quality-gate receipt

Under the same explicit Node 24.19.0 runtime, `git diff --check`, changed-file
Prettier, changed-file Biome, TypeScript 7 typecheck, oracle ratchet,
coercion-site ratchet, and issue integrity all exited 0. The full durable log
and exit receipt are
`/private/tmp/js2-6715-node24-scoped-gates.iJZdnq/{preflight.log,preflight-receipt.txt,gates.log,gates-receipt.txt}`.
The CI-matching inventory boundary command then exited 0 with
`inventoryValid: true`, `errors: []`, and base `HEAD`; its JSON report and
stderr receipt are in the same directory as
`compiler-boundaries-inventory.json` and
`compiler-boundaries-inventory.stderr`.

## Implementation checkpoint

The dedicated implementation worktree started from
`aca46e64cded68942686f67a52c38bb1d3c358ab`, which exactly matched
`upstream/main` at dispatch (`0 0` ahead/behind). It now contains only these
issue-owned source changes:

- `fixupModuleGlobalIndices` shifts a defined `ctx.undefinedGlobalIdx` when it
  is at or above the import insertion threshold.
- `tests/issue-6715-undefined-global-index-late-import-shift.test.ts` builds a
  module with an adjacent i32 `__symbol_counter`, creates the undefined
  singleton, inserts a host string import, then emits and instantiates a later
  canonical undefined read. The exported read verifies the singleton tag is
  still `1` rather than an incompatible neighbouring global.

The bounded independent regression and the required frozen #4016 integration
pair have completed under scoped execution leases; their matched receipts appear
below. The candidate cache hunk was restored immediately after each baseline
and remains present in this issue worktree. The scoped Node-24 gates above are
now complete; normal commit and publication hooks remain separate pending
steps, with no hook, commit, or push recorded at this checkpoint.

### Aborted first baseline invocation — no verdict

The first leased baseline attempt is explicitly **not** a #6715 test result.
Its source hashes were the matched regression source
`04a607ee16b73c519c79c2f6dc5a9d02c9c2ba0b39f106626cb8c464b338dc24`
and baseline `registry/imports.ts`
`39d00e9bc74ce6bbc94e70f06d7421017ef2b5acb6cdc94d50f1c518baefb4e1`.
The command was incorrectly forwarded as:

```sh
pnpm test -- tests/issue-6715-undefined-global-index-late-import-shift.test.ts
```

The package script expanded it to `vitest run -- <file>`, which began unrelated
suite discovery (including `issue-3518-native-closure-resources`) instead of
selecting the #6715 file. It therefore produced a harness/scope error, not a
compiler failure or baseline verdict. The accidental parent process was PID
`72247`, with only its listed Vitest workers as children. A termination request
was sent without the required user approval; root's immediate execution hold
arrived after `TERM` had already been issued. That authorization failure is
recorded here rather than treated as authorized test control. Root subsequently
confirmed that all accidental worker PIDs were gone.

### Independent baseline/candidate result

The direct-Vitest parent used the same one-fork, no-file-parallelism, 2 GiB
heap command in both arms:

```sh
node --max-old-space-size=2048 node_modules/vitest/dist/cli.js run tests/issue-6715-undefined-global-index-late-import-shift.test.ts --pool=forks --poolOptions.forks.singleFork=true --no-file-parallelism --reporter=verbose
```

Vitest configured the actual fork with its then-default 512 MiB limit because
`VITEST_FORK_MAX_OLD_SPACE_SIZE` was not set. This focused one-test pair stayed
within that limit; the parent/fork distinction is recorded here so the command
is not misreported as an effective 2 GiB fork lane.

| Arm | Test SHA-256 | `imports.ts` SHA-256 | Exit | Result |
| --- | --- | --- | --- | --- |
| Baseline | `04a607ee16b73c519c79c2f6dc5a9d02c9c2ba0b39f106626cb8c464b338dc24` | `39d00e9bc74ce6bbc94e70f06d7421017ef2b5acb6cdc94d50f1c518baefb4e1` | 1 | Expected 1/1 failure: cached index was `1`, expected shifted `2` (35.91 s). |
| Candidate | `04a607ee16b73c519c79c2f6dc5a9d02c9c2ba0b39f106626cb8c464b338dc24` | `8aae5e7a0e233f06ead2bd6900f9b48bff14650ae8ffd2c129e133a05abac1ca` | 0 | 1/1 passed, including Wasm validation, compilation, instantiation, and exported singleton-tag read `1` (39.45 s). |

Durable logs are
`/private/tmp/js2-6715-baseline.Ghz631/vitest.log` and
`/private/tmp/js2-6715-candidate.NIKCzQ/vitest.log`. The candidate's exact
three-line cache hunk was restored after the baseline arm. This proves the
isolated cache repair only; it does not claim that the #4016 host Symbol-limit
consumer is fixed.

### Discarded #4016 integration infrastructure attempts — no fixture verdict

The full frozen fixture needs an explicit Vitest fork heap setting. Two earlier
integration-baseline attempts are retained as infrastructure receipts, not
baseline/candidate verdicts:

- `/private/tmp/js2-6715-integration-baseline.n0qlKF/vitest.log` launched a
  2 GiB parent, but its effective fork was the config default 512 MiB; it
  reached the stale-cache CompileError and then exhausted that fork heap before
  all 47 rows completed.
- `/private/tmp/js2-6715-integration-4g-baseline.GNWyeT/vitest.log` set a 4
  GiB parent and `NODE_OPTIONS`, but omitted
  `VITEST_FORK_MAX_OLD_SPACE_SIZE`; Vitest's `execArgv` therefore still gave the
  fork 512 MiB and it again exhausted the heap before completion.

Neither attempt is used to evaluate #6715 or #4016 behavior. The final pair
below explicitly sets the Vitest fork limit and completed without an OOM.

### Required #4016 integration evidence

The host Symbol-limit consumer is an explicit integration dependency rather
than an upstream-PR test dependency: its staged host split implementation is
owned by #4016 and is absent from the clean #6715 base. Root prepared a separate
unpublished integration checkout at
`/Users/thomas/.codex/worktrees/split-undefined-integration/js2`, baseline HEAD
`47fd894d96cc647cbe637741c98a9a60805eb4ff`. The baseline was preserved before
the candidate received only this cache fix; do not commit or publish that
checkout.

Freeze the historical #4016 source at the exact SHA-256
`92bd8d30a494c17e6d1e04c07c0498a51a61311a619303a48c1f5f2c7fc46efc`
for `tests/issue-4016-standalone-search-value-tostring.test.ts` in both arms.
Do not copy a later #4016 fixture revision into this paired control. The final
pair used this exact command in both arms:

```sh
VITEST_FORK_MAX_OLD_SPACE_SIZE=4096 NODE_OPTIONS=--max-old-space-size=4096 \
  node --max-old-space-size=4096 node_modules/vitest/dist/cli.js run \
  tests/issue-4016-standalone-search-value-tostring.test.ts \
  --pool=forks --poolOptions.forks.singleFork=true --no-file-parallelism \
  --reporter=verbose
```

`VITEST_FORK_MAX_OLD_SPACE_SIZE=4096` is material: `vitest.config.ts` passes
that value through its fork `execArgv`; `NODE_OPTIONS` and the parent flag make
the 4 GiB bound explicit for the parent and inherited environment too.

| Arm | Fixture SHA-256 | `imports.ts` SHA-256 | Exit / rows | Target transition |
| --- | --- | --- | --- | --- |
| Baseline | `92bd8d30a494c17e6d1e04c07c0498a51a61311a619303a48c1f5f2c7fc46efc` | `39d00e9bc74ce6bbc94e70f06d7421017ef2b5acb6cdc94d50f1c518baefb4e1` | 1; 42 passed, 5 failed, 47 total | `WebAssembly.instantiate` rejects before execution: `extern.convert_any` expected `anyref`, received `global.get i32`. |
| Candidate | `92bd8d30a494c17e6d1e04c07c0498a51a61311a619303a48c1f5f2c7fc46efc` | `8aae5e7a0e233f06ead2bd6900f9b48bff14650ae8ffd2c129e133a05abac1ca` | 1; 42 passed, 5 failed, 47 total | Invalid Wasm is eliminated and the function executes, but the `try` completes and returns `0`: no catchable `TypeError` reaches the fixture's one-number-hint assertion. |

The effective-4-GiB logs are
`/private/tmp/js2-6715-integration-effective4g-baseline.zxlkG5/vitest.log`
and
`/private/tmp/js2-6715-integration-effective4g-candidate.6j3eiB/vitest.log`.
The same four unrelated #4016 checkpoint failures remain in both arms: the two
`@@split` refusal rows, the raw-v1 direct-object boundary, and the
descriptor-before-split host boundary. The target stays a fixture failure in
both arms, but changes from an invalid-Wasm compile failure to a wrong runtime
result. The paired accounting is unchanged at 42 pass / 5 fail: zero rows
change from fail to pass and zero from pass to fail; the target changes only
from an instantiation error to a wrong runtime result. This is evidence that
the cache fix removes the stale-global Wasm shape; it is **not** evidence of a
complete #4016 host Symbol/`ToPrimitive` consumer fix. That consumer acceptance
remains unchecked and is an explicit handoff to #4016 rather than a reason to
expand this registry-only fix.

### #4016 handoff — remaining host `ToPrimitive` Symbol path

A source-only trace explains why the candidate reaches the frozen fixture's
`return 0` rather than its `catch` branch. In the host-undefined split arm,
`emitHostStagedSplitLimitFromExternref` emits the host `"number"` hint and
then `__to_primitive` followed by `__unbox_number`. The host runtime's
`_callExoticToPrimitiveSlot` first invokes `__call_fn_method_1` for the
computed `Symbol.toPrimitive` closure.

That closure's `hint: string` is a native-string reference parameter, while
the host call supplies a real JavaScript string. The method dispatcher applies
an `any.convert_extern`/`ref.test` admission gate for non-nullable reference
parameters; a host string cannot satisfy the native `$AnyString` reference
test.

The frozen consumer is *host-assisted*, not a pure standalone dispatch path:
`runNativeStringsHost` compiles with `{ nativeStrings: true }` and supplies the
normal JS host imports. Therefore an unmatched non-null method closure takes
the host-call fallback (`__call_function_1`) rather than proving the
pure-standalone `ref.null.extern` terminal. That bridge wraps the closure and
again must carry the real host `"number"` string across the native-reference
parameter boundary. The observed candidate `return 0` proves only that the
`try` completed without a catchable TypeError; it does not, by itself, prove
whether the callback was skipped, how a fallback value was produced, or that
`null` was the value sent to host numeric conversion. This is a source-level
handoff, not a new compiler-run claim.

The #4016 owner should trace and repair that host-string/native-reference
handoff (and distinguish a dispatcher miss from a valid primitive result if
needed), then verify the callback count, exact `"number"` hint, and TypeError
separately. The closure result's Symbol boxing is not implicated until that
bridge actually dispatches the closure. No such work belongs in this
global-index repair.

### Bounded host-boundary diagnostic — actual runtime evidence

For the remaining handoff question, a temporary ignored file remains only in
the separate integration checkout:
`.tmp/issue-6715-host-toprimitive-diagnostic.test.ts` (SHA-256
`f938edf3d9a9615af1c162cdca63d44d5e2f8cd5af41c4a6359b63ecc555af36`).
It never modified the frozen 47-row #4016 fixture, whose SHA-256 remains
`92bd8d30a494c17e6d1e04c07c0498a51a61311a619303a48c1f5f2c7fc46efc`, and
will never be committed or published by this issue. A byte-identical,
runner-visible copy of the earlier diagnostic SHA
`db5e4bc4318d6fb3ba4112edf067579d1dec702a40b03584b18c50614dddef26` was
removed immediately after its one direct run.

The earlier diagnostic compiled three minimal host-assisted native-string modules with
the candidate cache hunk only, then wrapped the existing `buildImports` runtime
functions `__to_primitive` and `__unbox_number` without changing their
behavior. It records JS input/result tags and thrown error names at the
host-to-Wasm and immediately-before-`Number` boundaries for a bare-Symbol
positive control, a numeric-returning `Symbol.toPrimitive` callback that
encodes callback count/hint/result length, and the frozen Symbol-returning
callback shape.

It ran once with the explicit Node 24.19.0 binary, one Vitest fork, no file
parallelism, and both parent/fork heap limits at 4 GiB. The command, exit
receipt, and full log are:

```sh
VITEST_FORK_MAX_OLD_SPACE_SIZE=4096 NODE_OPTIONS=--max-old-space-size=4096 \
  /Users/thomas/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node \
  --max-old-space-size=4096 node_modules/vitest/dist/cli.js run \
  tests/issue-6715-host-toprimitive-diagnostic.test.ts \
  --pool=forks --poolOptions.forks.singleFork=true --no-file-parallelism \
  --reporter=verbose
```

`/private/tmp/js2-6715-host-toprimitive-node24.pCV6Sx/receipt.txt` records
exit 0; `/private/tmp/js2-6715-host-toprimitive-node24.pCV6Sx/vitest.log`
records 1/1 passing diagnostic test in 35.41 s. The default `node` preflight
was v22.23.2 and deliberately exited before Vitest; it is retained separately
at `/private/tmp/js2-6715-host-toprimitive.SxGbJp/receipt.txt` and is not a
test result.

### Runtime provenance of earlier #6715 runs

The earlier focused baseline/candidate logs retain their source hashes and
outcomes, but their receipts do not record a resolved `node` path or
`node --version`. The earlier full integration logs retain their explicit
parent/fork heap configuration but identify the parent only as
`node --max-old-space-size=4096`, again without a resolved binary or version.
The two discarded OOM attempts have the same omission. Since the current
default `node` is v22.23.2, none of those earlier runs is labelled Node 24
retroactively: their runtime version is **unrecorded**. Their matched
configuration, source hashes, and observed baseline/candidate transitions are
preserved unchanged. At that stage, only the temporary diagnostic above had a
receipt proving the explicit Node 24.19.0 binary. The later verified focused
pair recorded above supplies that provenance for the independent #6715
regression, without retroactively assigning a runtime to the older runs.

The bare-Symbol positive control returned `1`: `__to_primitive` received the
real host `"number"` string and returned a Symbol, then `__unbox_number`
received that Symbol and threw `TypeError`. In contrast, both callback shapes
received the real `"number"` host hint at `__to_primitive`, but it returned a
**string** to `__unbox_number`, which produced a number without throwing. The
numeric-returning callback's encoded result was `0`, reporting a zero callback
count, zero wrong-hint count, and zero resulting split length in that trace;
it is not independent proof that the callback was never invoked. The
Symbol-returning callback likewise completed its `try` with result
`0`; the trace observes a string rather than a Symbol at the number boundary.
This rules out the earlier null-terminal explanation and makes a failed
host-assisted `@@toPrimitive` dispatch the leading diagnosis, but it does not
yet prove non-invocation with certainty: the source-visible captured counter
has not yet been independently demonstrated in that same compiler lane.

The expanded ignored diagnostic added two assertions before the existing
callback observations: a direct compiled `limit[Symbol.toPrimitive]("number")`
control and a host-assisted number-hint `valueOf()` control. Each is designed
to return encoded result `101` (one correct callback plus the expected
split/result observation), and the trace now retains the exact fixed string
returned by `__to_primitive`.

Its one explicit Node-24.19 run is an infrastructure stop, not a semantic
verdict: `/private/tmp/js2-6715-host-toprimitive-expanded-node24.QimnCD/receipt.txt`
records exit 1 and its `vitest.log` records that the shared trace harness
required `imports.env.__to_primitive` before executing the direct compiled
control. That control correctly needs no host `__to_primitive` import, so the
assertion stopped the run before any expanded control produced observations.
The runner-visible copy was removed immediately afterward. No retry is planned
for this registry issue; a future #4016 investigation can make import tracing
optional and use these controls to distinguish ordinary host `ToPrimitive`
fallback from the `@@toPrimitive` bridge. The remaining semantic repair belongs
to #4016, while #6715 stays independently landable on its focused cache
regression.
