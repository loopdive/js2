---
id: 6777
title: "codegen: `in` on array carriers — type-confused lowering (invalid module on `any[]`), wrong answers on holes/`delete`, non-boolean result"
status: done
sprint: Backlog
created: 2026-09-30
updated: 2026-10-11
completed: 2026-10-11
assignee: "ttraenkler/pr6383-repair"
branch: "claude/issue-6777-in-array-carrier"
priority: critical
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
language_feature: in-operator
goal: core-semantics
related: [6776, 2130, 2741, 3280, 1991]
requested_by: ttraenkler/claude-review
origin: "2026-09-30 codebase review (plan/agent-context/claude-codebase-review-2026-09-30.md) — C1/H5"
---

# #6777 — `in` on arrays is wrong three ways, and one of them emits an invalid module

## Problem

Probe results (JS-host lane, `compile()` + `buildImports`, diffed against Node):

| source | wasm | JS |
|---|---|---|
| `const arr: any[] = [1,2,3]; arr[5] = 9; [2 in arr]` | **invalid module** (`struct.get[0] expected (ref null 2), found (ref null 4)`) — `success: true` | `[true]` |
| `const arr: number[] = [1,2,3]; delete arr[0]; 1 in arr` | `false` | `true` |
| `const arr: any[] = [1,2,3]; delete arr[0]; 0 in arr` | `true` | `false` |
| `[2 in arr]` on a dense `number[]` | `[1]` / `[0]` (i32, not boolean) | `[true]` / `[false]` |

## Root cause

`src/codegen/binary-ops-in.ts`:

- `:383-394` detects the vec carrier by **struct-name prefix**, then the typed
  arm at `:482` emits `struct.get` against a struct type that does not match the
  local's actual carrier type when the array is `any[]` (the `any` vec and the
  typed vec have different struct indices). That is the invalid module.
- `:482-490` answers `idx < length` for the dense case — a hole created by
  `delete` (#2130 made `delete arr[i]` work) still reads as present, and the
  comparison result is left as i32 instead of going through the boolean box.
- The comment at `:490` already names the `__extern_has_idx` chokepoint that
  handles holes correctly; the typed fast path bypasses it.

## Correction

1. Route every `in` whose RHS is an array carrier (typed vec, `any` vec,
   sparse-capable vec) through one helper that consults the carrier's hole
   representation (whatever `delete arr[i]` writes) and returns a proper
   boolean.
2. Keep a fast path only where the carrier is statically known dense AND the
   key is a statically-in-range integer; otherwise call the helper.
3. Resolve the carrier struct type from the compiled receiver's `ValType`,
   never from a name prefix.

## Acceptance

- All four rows above match Node.
- Regression file `tests/issue-6777-in-array-carrier.test.ts` covering `any[]`,
  `number[]`, `string[]`, holes via `delete`, out-of-range index, negative
  index, string keys (`"length" in arr`, `"0" in arr`), and the result being a
  real boolean (`=== true`).
- With #6776 landed, the first row is a compile error until fixed; after this
  issue it is `[true]`.

## Implementation Plan

1. New module `src/codegen/in-array-carrier.ts` owns every `in` whose RHS
   is an array carrier:
   - `isPlainArrayCarrierType` replaces the `__vec_` name-prefix test with a
     structural one (`$__vec_base`, or a `$__vec_base` subtype that is exactly
     `{ length, data: array }`), so subviews / TypedArray views / the RegExp
     match vector keep their own arms as before.
   - `compileArrayCarrierIn(ctx, fctx, expr, constantKey)`:
     - constant key `"length"` → evaluate both operands, `true`;
     - constant key that is a canonical array index (`String(n) === key`,
       `0 ≤ n ≤ 2^32−2`) → `emitConstantIndexIn`;
     - any other constant key → declined, so `"push" in arr` / bag expandos
       keep the named-property fold;
     - no constant key → `emitKeyFirstExternHas(…, rawReceiver = true)`.
   - `emitConstantIndexIn` keeps the inline `index < length` compare only when
     `arrayCarriersStaticallyDense(ctx)` (none of `usesArrayHoles`,
     `vecIndexDeleteDirty`, `vecAccessorDescriptorDirty`, `protoIndexDirty`,
     `dynamicCodeDirty`) AND the receiver compiled to a `$__vec_base` subtype;
     the `struct.get` type index comes from that compiled ValType. Otherwise
     it calls the lane's presence chokepoint: native lanes
     `__extern_has_idx(vec, f64)`, js-host `__extern_has(vec, boxed index)`
     (the host `__extern_has_idx` has no vec arm — it answered 0 for every
     index, which is what made row 2 false).
   - The receiver is handed over as the vec itself (`extern.convert_any`, and
     compiled without an externref hint): `coerceType` / the hint route a vec
     through `__make_iterable`, whose detached JS mirror ignores the host
     delete tombstone (`delete a[2]` on an array of objects still answered
     present).
   - Every arm returns `{ kind: "i32", boolean: true }`.
2. `src/codegen/binary-ops-in.ts`: detection uses `isPlainArrayCarrierType`;
   the old vec block (the `:482-550` arm the review pinned) is replaced by one
   call; `leftType` is hoisted once and reused (net −1 `getTypeAtLocation`,
   −1 `ctx.checker`); `emitRuntimeExternHas` keeps its #5358/#5383 records and
   delegates its body to the shared `emitKeyFirstExternHas` (byte-identical
   for non-array receivers); the now-unused `vecCarrierElementIsF64` and the
   `f64HolesActive` / `overlayRouteActive` / `getArrTypeIdxFromVec` imports are
   gone.

## Resolution

Probe harness `.tmp/6777/probe.mts` (compile + run, diffed against node on the
type-stripped source), 43 shapes / 79 lane runs (`.tmp/6777/cases*.json`),
base = `5a001e24`:

| shape | lane | before | after | node |
|---|---|---|---|---|
| row 1 `any[]` + `arr[5] = 9`, `[2 in arr]` | host | **invalid module** | `[true]` | `[true]` |
| row 1, bitmask | standalone | **invalid module** | correct | — |
| row 2 `number[]`, `delete arr[0]`, `1 in arr` | host | `false` | `true` | `true` |
| row 3 `any[]`, `delete arr[0]`, `0 in arr` | host | `true` | `false` | `false` |
| `string[]` after delete | host | wrong | correct | — |
| dynamic `i in arr` (any key) | both | always `false` | correct | — |
| elisions `[1, , 3]` | host (number), both (`any[]`) | wrong | correct | — |
| literal-typed keys (`const k = 1`) | both | wrong | correct | — |
| `delete` on an array of objects | host | wrong | correct | — |
| §13.10.1 key-before-receiver order | host | `false` answer | correct | — |

Row 4 (`[2 in arr]` → `[1]`) does not reproduce on current main:
`JSON.stringify([2 in arr])` already prints `[true,false]`. The `1`/`0` shape
does reproduce through `unknown[].push(2 in arr)` and a raw `boolean` export
return — but identically for `a < 2`, `a === 1`, `!a` and `delete o.x`, so it
is a general boolean-boxing defect at those sinks, not an `in` defect, and is
left for its own issue. The `in` arms now return a boolean-branded i32
regardless.

Totals: **42 divergences before → 9 after**. The nine: the gap index of row 1
on both lanes (below), the raw `boolean` export return (above), and six runs
(five causes) that also diverge on the base, outside the `in` site:

- standalone `(string | undefined)[]` elision: `hasOwnProperty(1)` is also
  true — the native-string carrier stores no hole (store side);
- standalone `delete` on an array of objects: `arr[2]` still reads the object
  and `Object.keys` still lists it — the delete never reaches the carrier;
- standalone non-canonical numeric STRING keys (`"01" in arr`, `"1.0" in arr`):
  native `__extern_has` parses the key with `__str_to_number` and never checks
  `ToString(n) === key` (object-runtime.ts numeric arm);
- js-host `Array.prototype[1] = …` over a hole: host `__extern_has` vec arm
  does not consult the Array prototype;
- js-host named expando through a CONSTANT key (`'foo' in arr` after
  `arr.foo = 1`): the #4062 bag route is standalone-only by design
  (`vecNamedKeyNeedsRuntime`); the dynamic-key spelling is now correct.

Also out of scope, documented in `in-array-carrier.ts`: an f64 grow gap
(`a[4]` after `a[5] = 9`) in a module with no hole source holds the T8-A
`UNDEF_F64_BITS` marker, indistinguishable from a stored `undefined`
(`vec-f64-hole-presence.ts` "Demand gate"); no `in` lowering can recover it.

Tests: `tests/issue-6777-in-array-carrier.test.ts` — 16 sources on both lanes
plus 4 js-host-only, every binary `WebAssembly.validate`d, standalone modules
asserted import-free. Base: 27/36 fail; fix: 36/36 pass.

Gates (exit codes): `check-loc-budget` 0, `check-func-budget` 0 (also with
`LOC_GATE_BASE=origin/main`), `check-coercion-sites` 0, `check:oracle-ratchet`
0 (net `getTypeAtLocation` −1, `ctx.checker` −1), `check:dead-exports` 0,
`typecheck` 0, `format:check` 0. `test:guard`: 254/255 — the one miss is
`issue-3613-vacuity-machinery` "repo is clean" timing out at 35 s with load
average ~20 on 4 cores; alone it passes 28/28 in 24 s. Related suites
(`in-operator-*`, equivalence `in-operator-edge-cases`, #1444, #2130, #2617,
#2741, #2856, #3920, #4062, #4369, #4491-wave4, #4515, #6485, #6670, #2001-s1,
#6482-r7, es5 holes): 12 failures, the identical 12 on the base (file-copy
revert, same box) — none touched by this change.

## PR repair (2026-10-11)

The user explicitly authorized transfer of the original claim and the finite
PR 6383 conflict/inventory repair. The transferred claim is held by
`ttraenkler/pr6383-repair`; the isolated repair checkout is
`.claude/worktrees/codex-6777-pr6383-repair-20261011`.

Current canonical main is `324df7ca23c734d8acb3aa46b14a60e202f56d98`;
PR head is `ee3eaeb5035eb6a23f7f2f7f2f96fc64e460cd7b`. Preserve
main's `vecStaticIndexPresenceInstrs` path for standalone externref `$Hole`
slots using the receiver's compiled type. Keep deletion, accessor, inherited
index and dynamic-code cases on their presence-helper routes: physical
backing presence alone cannot answer those cases. Keep the PR's key-first
evaluation and boolean result. Registry inventory entry awaits coordinator
ACK; no policy/edge allowances or gate changes are authorized. The source
repair is validated locally but is not ready for queue admission.

Two exploratory write-after-`Array(n)` probes still return 7 instead of 2
and 6 instead of 2 with canonical main's exact `binary-ops-in.ts`, and
with the repair. Those store/representation defects are outside this finite
conflict repair; the retained composition controls separate an untouched
length-created hole from a stored `undefined`, and check deletion on an
ordinary array in a module that also contains `Array(n)`.

### Repair validation and publication state

Source composition is main `324df7ca23c734d8acb3aa46b14a60e202f56d98`
plus PR head `ee3eaeb5035eb6a23f7f2f7f2f96fc64e460cd7b`, with the
static `$Hole` check restored in `in-array-carrier.ts`. Both operands still
run key-first; the static check consumes exactly one receiver and leaves
one boolean-branded i32. No deletion/accessor/prototype/dynamic-code route
is bypassed.

- Node 25.9.0, normal Vitest configuration, one worker: **92/92** scoped
  tests pass across five files: issue-6777 (**39/39**, original 36 plus three
  composition controls), issue-6771 (**29/29**), issue-2741 (**10/10**),
  in-operator-edge-cases (**9/9**), in-operator-prototype-methods (**5/5**).
- Required `test:guard`, unchanged manifest/configuration, Node 25.9.0:
  **261/261** tests pass across 21 files.
- The adjacent issue-2130-delete-in-presence suite passes **4/7**. Its same
  three failures reproduce using canonical main's exact binary-ops-in.ts:
  sibling property after delete, object-rest presence, and delete/re-add.
  This is a measured main control, not a new failure attributed to the repair.
- Type checking, LOC/function budgets against the canonical main SHA,
  coercion-site ratchet, oracle ratchet and dead-export check all exit **0**.
- Inventory mode exits **1**, only `unclassified-module` and
  `unclassified-target` for `src/codegen/in-array-carrier.ts`. The registry
  has not been edited while its shared owner acknowledgment is pending.

Logs are worktree-local `.tmp/node25-scoped.log`, `.tmp/guard-suite.log`,
`.tmp/main-2130.log`, `.tmp/typecheck.log` and
`.tmp/boundaries-before-ack.log`. Earlier Node 24.4.1 runs required the
Vitest worker argument `--poolOptions.forks.execArgv=--experimental-wasm-exnref`
(the parent-node flag did not reach configured forks). Final Node 25 evidence
uses neither that flag nor modified test expectations.

**Not published or queued.** Before publication: receive the coordinator's
ACK for the single unmigrated inventory row, add that row without policy
relaxations, integrate fresh canonical main, rerun relevant required gates,
verify the PR head/ancestry and push normally. Keep this claim active until
that finite pending work is complete or explicitly handed off.

### Additional blockers discovered after source validation

The normal checkpoint commit ran lint-staged and both unconditional budget
hooks successfully, then failed with exit 128 because the configured SSH
signing key `/Users/thomas/.ssh/id_ed25519` is encrypted and no authentication
agent is connected (`ssh-add -l`: could not open a connection). Signing and
hooks were not bypassed. HEAD remains the original PR SHA; the resolved merge
with main 324df7 is staged and its MERGE_HEAD is retained.

Two newer required source gates also reject the original PR's new module:
`check-import-cycles` against main 324df7 reports largest SCC 703 → 704,
and `check-flat-dir-budget` against the same base rejects the new top-level
`src/codegen/in-array-carrier.ts` entry. No allowance, baseline or gate was
changed. These are additional blockers beyond the original two handoff items.
A source-scope decision is needed for a genuine fix, for example relocating
the new module into the existing array directory and cutting its runtime
import cycle by explicit dependency injection; the registry proposal would
then need the corresponding exact destination path and owner approval.

Portable patches remain in `.tmp/pr6383-source-on-main-324df7.patch`
(source/tests against canonical main) and
`.tmp/pr6383-incremental-source-repair.patch` (new source/test changes relative
to the original PR). The pending single-row inventory proposal is
`.tmp/pr6383-inventory-row-proposal.patch`, with its full proposed config in
`.tmp/compiler-boundaries-pr6383-proposed.json`. The ordinary detector accepts
that alternate proposed config (`inventoryValid: true`, exit 0); this is
proposal validation only, and the tracked registry remains unchanged/red.
Additional logs: `.tmp/source-checkpoint-commit.log`,
`.tmp/import-cycles-main-base.log`, `.tmp/flat-dir-budget-main-base.log` and
`.tmp/proposed-inventory-validation.log`. No PR push or queue request occurred.

### Current finite CI remedy (2026-10-11; supersedes the two source-gate blockers)

Within the user-authorized finite PR repair, the new helper now lives at
`src/codegen/array/in-array-carrier.ts`. It has only type imports. Its existing
`binary-ops-in.ts` caller supplies the same concrete codegen operations through
an `ArrayCarrierInDependencies` object: no runtime registry, facade, new
semantic behavior, budget allowance or gate relaxation. The shared delegates
are ordinary exported wrapper functions, so passing those functions retains
late registration rather than capturing their private implementations.

The compiled-type `$Hole` check and its overlay exclusions remain unchanged.
The existing codegen caller owns dependency construction; the array leaf owns
the actual emission algorithm. No foreign IR source or claim was touched.

On canonical main 324df7, after this refactor:

- `check-import-cycles`: **exit 0**, largest SCC remains **703**, 4 nontrivial
  SCCs and 10 two-way directory pairs. The added helper is outside the SCC.
- `check-flat-dir-budget`: **exit 0**, `src/codegen/*.ts` remains **830**.
- LOC/function budgets: **exit 0**, no allowance added.
- Type checking: **exit 0**.
- Node 25.9.0, unchanged Vitest expectations/configuration, one worker:
  **92/92** across the same five scoped suites pass again.

Current registry proposal supersedes the earlier top-level-path proposal:
`src/codegen/array/in-array-carrier.ts`, state `unmigrated`, layer
`mixed-needs-split`, destination `backend-wasmgc`, owner `3518-coordinator`,
next boundary "Separate AST/context-driven generation, physical resources
and generated native runtime." It adds only that row next to existing array
records and preserves all existing bytes/order/metadata. Ordinary inventory
validation against the proposed config exits **0**; the tracked registry is
still unchanged and requires scope approval.

Original proposal and source logs are retained. Current logs use the
`.tmp/relocated-*` prefix. The active proposal/portable patch paths retain
their names and now describe the relocated helper. Commit signing remains
blocked as described above; no unsigned exception is assumed and no push
or queue operation has occurred.

Final relocated-source validation also passes the required unchanged guard
manifest again (**261/261**, 21 files), coercion and oracle ratchets (no
vocabulary growth, checker calls **−1**), dead-export check and scoped
Prettier formatting (all exit **0**). Source/test patches are staged and
saved. Tracked shared policy has not been altered; signing/one-row inventory
approval and a fresh-main integration still precede any publication.

### Explicit publication authorizations (2026-10-11)

The human explicitly authorized **this one inventory entry** for
`src/codegen/array/in-array-carrier.ts` without waiting for the coordinator
ACK, and separately authorized **unsigned commits here for PR 6383 only**.
Both are bounded exceptions for this repair. Every existing registry row,
ordering, history, top-level metadata, edge policy and baseline stays intact.
No foreign claim is transferred. The unsigned exception uses only per-command
`git -c commit.gpgsign=false`; configured signing and all normal hooks remain
in place. Original failed signing/proposal logs are preserved.

The validated eight-line inventory proposal is now applied to the tracked
registry. Source, inventory and merge validation are in progress; the issue
is not marked complete and no queue action has been taken by this agent.

The full precommit slow hook on the pending merge selected 20 inherited-main
root tests because HEAD still had the old PR ancestry. It stopped at
`issue-3518-c1-current-source`: **265 failed / 90 passed**, first error
`runtime program relocation: length/SHA256: src/ir/program/data.ts`.
A separate untouched detached main 324df7 checkout, Node 25.9.0, reproduces
**the same 265 failure names and 90 passes**. Its tracked state stayed clean.
The candidate's data.ts and that inherited test were byte-identical to main.
This repair does not change those source fixtures or their certificates.

The repository-sanctioned `SKIP_SLOW_PRECOMMIT=1` variant may finalize this
pending merge with its unconditional normal fast hooks, supported by the
manual scoped **39/39** changed-root suite, **92/92** related suites,
**261/261** guards and oracle/source/inventory checks. After the merge commit
exists, rerun the ordinary full changed-root hook with correct ancestry;
no hook/script/baseline/expectation is weakened. Logs and exact failure-name
comparison are `.tmp/publication-commit.log`, `.tmp/main-c1-control.log` and
`.tmp/precommit-main-control-comparison.json`.

### Merge-ready implementation diff (2026-10-11)

The source reconciliation is committed as
`726af5cae2b57e2c711ec951aa39d274dd338ed1`, preserving both original PR
`ee3eaeb5035eb6a23f7f2f7f2f96fc64e460cd7b` and canonical main 324df7 as
parents. The ordinary full changed-root hook, rerun with the corrected
ancestry and no skip option, now selects only the actual PR regression file
and passes **39/39**; the ordinary oracle ratchet also passes. The authorized
tracked inventory and its guard suite pass (**261/261**). Both newer source
gates remain unchanged: largest SCC **703**, top-level codegen files **830**.

Fresh canonical main is `74949505ddda90b7dba112197a9c7880cf002e3d`.
Its incoming changes are README and benchmark artifacts only; the ordinary
catch-up merge retains that history and the same validated compiler source.
The original four reviewed observable rows are covered by the retained
regressions. The previously recorded general raw-boolean export/grow-gap
and carrier-store limitations remain explicitly outside this finite repair.

Per the implementation-PR lifecycle rule this merge-ready diff carries
`status: done` and `completed: 2026-10-11`. It does **not** claim that the
change has landed on main: publication, CI and protected queue/merge are
owned by the parent shepherd. The source and final catch-up commits use the
human's PR-specific unsigned exception; normal hooks and all required gates
stay active. Earlier failed-hook/signing/main-control logs are preserved.
