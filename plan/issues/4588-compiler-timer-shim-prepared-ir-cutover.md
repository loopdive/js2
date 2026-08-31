---
id: 4588
title: "Prepare the compiler timer shim through exact IR ownership"
status: in-progress
created: 2026-08-21
updated: 2026-08-31
priority: critical
feasibility: medium
reasoning_effort: high
task_type: refactor
area: compiler, ir, codegen
language_feature: compiler-internals
goal: ir-full-coverage
sprint: current
parent: 3518
depends_on: [1231, 3521, 3525, 4522, 4573, 4579, 4583, 4584]
related: [1501, 3090, 3518, 3519, 3520, 3525, 3792, 4522, 4573, 4579, 4583, 4584, 5092]
assignee: ttraenkler/codex
files:
  - plan/issues/4522-ir-kill-switch-inventory-r9.md
  - plan/issues/4588-compiler-timer-shim-prepared-ir-cutover.md
  - src/codegen/ir-timer-shim-planning.ts
  - tests/issue-4588-standalone-timer-shim-cutover.test.ts
---
# #4588 — prepare the compiler timer shim through exact IR ownership

## Problem

The exact standalone Async example has five user terminals fully owned by IR,
but import preprocessing also injects an executable `setTimeout` wrapper. Its
compiler provenance is already stable, yet the inventory deliberately records
it as unowned support, so `compileDeclarations` still enters
`compileFunctionBody` and `compileStatement` for that wrapper. Those are the
last two strict physical-body entries in the pinned five-example corpus after
#4584 removed the two residual class-body walker visits.

The shim is injected in both JS-host and standalone compilation. Its identity
must therefore remain target-neutral; a standalone-only inventory exception
would make the same transformed source acquire different semantic owners.

## Scope

- Promote only the compiler-provenanced `timer-shim:set-timeout` function to a
  self-owned `synthetic-support` terminal while preserving its stable UnitId.
- Reuse the checker-backed `isExactInjectedTimerShim` proof. Source spelling,
  comments, or ambient declarations alone never authorize the cutover.
- Plan the exact `env::__timer_set_timeout` call against that terminal and
  lower the wrapper through ordinary AST-to-IR coercion, including callback
  packing, number boxing, and full dynamic `ToNumber` for timer handles.
- Let generic Prepared free-function routing seal and install the exact
  UnitId/Program-ABI callable before either physical body entry can run.
- Keep a default-on kill switch for one release and retain the emitted wrapper;
  defined-function deletion is separate DCE/Program-ABI work.
- Fail closed for user timers, shadows, aliases/escapes, near-miss shims, WASI,
  and multi-source duplicate wrappers.

## Non-goals

- Removing `$setTimeout` from the artifact. Current DCE intentionally roots
  every defined function.
- Broad timer-family migration (`setInterval`, clear functions, scheduler
  intrinsics) or name-based import authorization.
- Treating one clean corpus as proof that `compileDeclarations` or direct
  codegen is globally deletable. #3090 and the optimization-retirement ledger
  remain required.

## Acceptance criteria

- [x] The exact timer shim is a self-owned terminal with stable compiler UnitId
      in both host and standalone inventories.
- [x] Both lanes emit it through IR with zero direct body/statement entries;
      user and near-miss timers retain their established routes.
- [x] A kill-switch control restores both physical entries while producing the
      same valid artifact and runtime behavior.
- [x] The exact five-case physical corpus has no strict body entries and no
      unowned support, with an updated exact manifest/digest.
- [x] Timer, identity, planning, Promise-delay, host/standalone IR-only,
      typecheck, formatting, budget, fallback, and optimization gates pass.

## Completion evidence

The exact five-source manifest now records 47 units: 38 terminals, 9 owned
support units, 0 unowned support units, and 19 derived units. Async remains at
eight total units while moving from 5 terminals / 1 unowned support unit to 6
terminals / 0 unowned support units. The manifest digest is
`sha256:e25d80c90cdd5eb3c6a21672e6d9f3db754ddd4a068d54d5d37b5fee856eb0b7`.
The observed terminal kinds are 26 functions, 2 module initializers, and 10
class members.

Both bounded IR-only lanes now measure 5/5 successful entries and 38/38
emitted IR bodies, with zero legacy bodies, Unsupported outcomes, or
Invariants. A four-cell basename/full-path × default/explicit-IR probe preserves
the exact timer UnitId and records `terminal-ir` with no physical body entries
in every cell. The exact #4588 suite is 21/21 green; the refreshed #3519 plus
corpus tests are 34/34 green, and both post-timer #4577 census assertions pass.

Prepared-body fallback now restores the original free-function-only retry
contract by exact UnitId. Unsupported class and module owners remain
direct-only, compiler timer terminals are excluded from ordinary retries, and
every owner in a rejected timer-connected component carries the typed
`timer-component-not-isolated` outcome so the component falls back atomically.
The unchanged #3520 node-wrapper source now pins the resulting routes: its
unsupported class method is direct-only, its helper retries after direct
emission, and `main` remains IR-only without an unpatched slot. The focused
#3520 identity and planning suites are 38/38 green.

The required `check:standalone-ir-cutover-corpus` package command is wired into
CI with an exact manifest/digest pass followed by the raw-audit gate
`--require-no-legacy --expect-successful 5 --min-sources 5 --min-units 47`.
Both validations pass on the final checkpoint. The production dependency gap
is closed, and independent final review found no remaining architecture
blocker. The bounded corpus result alone does not establish wider compiler
retirement.

The final nine-file changed-root selection is 127/127 green. The eight ordinary
files are 115/115 in the standard isolated worker run; the #4573, "standalone
native Promise-delay compile-once ownership," file is 12/12 when run in the
thread pool under Node's required `--experimental-wasm-exnref` flag. The two
#3520, "IR-only R1: source-qualified unit identity and whole-program ABI map,"
failures from the earlier control are resolved without changing the valid
node-wrapper fixture: one was a stale 6 → 7 terminal census, while the other
exposed the lost free-function retry contract fixed above. The unrelated #1501,
"browser: setTimeout/setInterval/clearTimeout/clearInterval host imports,"
test is byte-for-byte unchanged from the branch base.

Landing validation also keeps the exact compiler timer support terminal out of
the linear backend's attempt-root, legacy-slot, and rejection telemetry. A
user-authored function named `setTimeout` remains an ordinary attempted owner,
so the exclusion is provenance-bound rather than spelling-bound. The IR-kind
neutrality verdicts and ratchets are unchanged; its baseline refresh records
only current evidence-line locations after the timer-cutover source changes.

## 2026-08-31 Sol implementation plan — retire the timer-shim rollback

### Grounded scope and dependency order

The original planning provenance was historical `main`
`275216c74c7299ea07a72c8d5479f7e1a477000c` (tree
`88cf9443abbb0172e3fd39526d863c5cdd79212a`); it is not the eventual A/B
baseline. On 2026-08-31, current `main` is
`b1085049ed2ed722c33480528b2741369ed73822` (tree
`f1ce66f2f11248b0d29ad7444e17864b99dac2dd`). Its exact tracked stale-key
census is **17 occurrences in 2 files**: the only production reader is one
logical branch in `src/codegen/ir-timer-shim-planning.ts`, expressed as two
comparisons for the historical disabling spellings, and the other 15
references are rollback setup/restore controls in the focused test. The final
candidate must contain zero tracked occurrences.

The resolver feeds nine exact consumer callsites in four production files:
`src/codegen/index.ts` has the resolver, selection option, and four routing
projections; `src/codegen/ir-imported-call-planning.ts` plans the imported
timer call; `src/codegen/ir-overlay-preparation.ts` closes a missing-capability
component; and `src/codegen/ir-prepared-free-functions.ts` certifies the
outside caller. They are read-only controls, not implementation ownership. The
focused file currently contains 11 static `it` blocks. That syntax count is
not a runtime denominator: after all dependencies land, report the exact tests
collected and passed by the final runner instead of carrying forward the old
21/21 or an inferred 22.

The exact-unit routing checkpoint for #3521, “IR-only R2:
prepare-before-emit free-function ownership,” is now on `main` through reviewed
head `f651aa523c33844d6f00cdb85ad36980232e0aeb` and merge
`3241404731471b15ce0d869cecd97815356d313d`. Production work remains blocked
until #3525, “IR-only R5: whole-program single- and multi-source Prepared
ownership,” lands or provides an explicit stable handoff, because its active
publication/session changes must be the authority for post-admission failure
semantics.

The shared inventory order remains Math-switch retirement → #1231, “perf:
struct field type inference — eliminate boxing in object properties,” rollback
retirement → #4584, “Bypass the legacy class-body walker for exact Prepared
standalone classes,” rollback retirement → this timer rollback. The expected
sequence is 15 → 14 → 13 → 12 only if the exact post-dependency #4522,
“Inventory and retirement plan for IR/direct env kill-switches,” table still
contains the #5092, “IR mixed-primitive conditional-expression ownership,” row
and all three predecessor rows. Recount the live table before editing; never
force those numbers onto a different parent. This plan-only checkpoint may
land now, but Terra must not edit production until the dependencies above are
authoritative. Then freeze and record the exact parent commit and tree, and use
that same parent for every clean baseline root and A/B comparison. If a
predecessor changes timer route, artifact, evidence, or failure semantics,
stop, amend this plan, and obtain a new Sol review before implementation.

### Exact change contract

1. Remove only the two historical environment comparisons from
   `timerShimResolver`. Preserve the `ctx.fast` and
   `resolveModuleBindings === false` exclusions, the checker-backed
   `isPreparedInjectedTimerShimOwner` certification, and the exact
   `certifyExactInjectedTimerShim` result. The change makes an existing default
   route unconditional; it does not admit a user declaration, near miss,
   multi-source duplicate, fast compile, or disabled binding-resolution lane.
2. Keep the complete timer ownership pipeline: the self-owned
   `compiler-unit:timer-shim:set-timeout` terminal, source-qualified UnitId,
   imported-call plan, exact Program ABI slot, late capability preparation,
   component isolation, dynamic ToNumber support, body patch, route audit, and
   terminal outcome. Do not turn the timer into a name-based special case or
   inline its logic into the direct backend.
3. Replace focused rollback assertions with permanent-route assertions.
   Candidate compilation with the former key absent or externally set to
   either historical disabling value must be byte- and evidence-identical.
   Keep a separate public `experimentalIR: false` direct oracle for the same
   exact source; it is observational only and may never become a fallback from
   failed Prepared publication.
4. Draw the ownership boundary explicitly. Fast compilation, disabled binding
   resolution, user or near-miss declarations, and WASI are true exclusions:
   they retain their current direct-owned or typed-safe-reject behavior and
   publish no compiler-timer claim, imported-call plan, or provenance outcome.
   A checker-recognized timer whose component is non-isolated or whose exact
   capability is missing is instead recognized-but-ineligible. Preserve its
   exact typed Unsupported outcome and any internal preflight/imported-call-plan
   evidence needed to diagnose the rejection, while publishing no timer body,
   ABI/import capability, patch, or receipt. Once exact isolation and capability
   admission succeeds, ownership is permanent. A lower, seal/currentness, or
   publication failure after that boundary is a compiler failure or
   invariant—not `late-preparation-unsupported` and not a direct retry—and must
   leave `legacyBodyEmitted=false`, zero physical timer entries, and zero timer
   body/ABI publication prefix.
5. Preserve every stronger negative and failure-isolation control in
   `tests/issue-4588-standalone-timer-shim-cutover.test.ts`: ordinary and
   near-miss declarations, nested shadows, first-class escape, multiple users,
   multi-source same names, callback-aware host multi-source behavior,
   missing-capability closure, timer-connected component rejection, injected
   seal/lower failure isolation, full-path source identity, Node Timeout
   coercion, and numeric handle behavior.
6. Update this issue and the post-dependency #4522 inventory. Remove exactly
   the timer row and record 13 → 12 only when a fresh census proves that is the
   live denominator. Otherwise publish the measured before/after count. Leave
   global IR-first, string-builder, async, mixed-conditional, already-consumed
   object/class predecessors, remaining multi-prepared, module-init, and linear
   readers classified accurately. Do not claim R9 or direct-frontend
   retirement complete.
7. The exact retired identifier must have zero tracked occurrences in source,
   tests, scripts, plans, and package/workflow files. Do not hide a reader
   behind string concatenation or an alias. The external A/B launcher may set
   the old key without checking that spelling into the repository.

### Baseline/candidate route and artifact matrix

Use separate clean roots for the final dependency-tip baseline and candidate
bytes, separate archive-backed temporary directories, and a fresh process for
every cell. For each target (`gc`, `standalone`), optimization setting
(`optimize:false`, `optimize:true`), and exact source key (basename `async.ts`,
full path `website/playground/examples/js/async.ts`), collect these four arms:

1. grounded baseline with the key unset: exact Prepared timer route;
2. grounded baseline with the old rollback set to `"0"`: exact direct timer
   route and two physical entries;
3. candidate with the key unset: permanent Prepared timer route; and
4. candidate with the old rollback externally set to `"0"`: the same permanent
   Prepared timer route.

These four arms form 32 primary cells. Candidate arms 3 and 4 must be identical
in binary, normalized WAT, imports, exports, function/type/global/table/memory
counts,
runtime result, source/unit census, terminal disposition, outcome projection,
and route audit. Baseline arm 1 must equal both candidate arms. Baseline arm 2
must also be binary/WAT/public-surface/runtime identical, but its evidence must
remain deliberately different: one exact self-owned terminal is
`legacy-ast-entry`, with exactly one `compileFunctionBody` and one
`compileStatement` entry. No aggregate hash may substitute for these row-level
joins.

Repeat candidate arm 4 with the second former disabling spelling for both
targets, both optimization settings, and both source keys: eight more cells,
for 40. Add eight explicit `experimentalIR:false` direct-oracle cells over the
same target/optimization/source-key product: 48. Add the eight standalone
basename ToNumber cells specified below: 56. Finally, add two basename WASI
candidate cells, one per optimization setting, that prove the timer remains a
pre-admission exclusion: the closed artifact matrix is exactly 58 cells.

The matrix alone cannot prove that its external launcher actually injected
both retired values. Add four fresh-process non-vacuity executions using the
canonical standalone basename fixture at `optimize:false` with the direct timer
body poisoned through the existing exact-name seam
`JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY=setTimeout`: baseline + `"0"`,
candidate + `"0"`, baseline + `"false"`, and candidate + `"false"`. Each
baseline execution must fail with the seam's exact
`injected direct function-body poison: setTimeout` error, proving that the
retired value reached the old branch. Each candidate execution must succeed
without reaching the poison, retain the Prepared outcome, and report zero
physical timer entries. Thus the proof has **58 artifact cells + 4 injection
controls = 62 executions**. Publish separate expected/observed key censuses for
both sets; do not silently add, drop, or merge a cell.

The closed execution census is also exact. All 58 artifact cells must compile
successfully. The 56 non-WASI artifact cells must each execute their runtime
assertion; the two WASI exclusion cells are compile/validation-only and must
retain the exact no-compiler-timer-claim evidence. Of the four poison controls,
the two grounded baselines are the only intentional compile failures and do
not run, while both candidates must compile successfully and execute the same
runtime assertion as their unpoisoned standalone cell. Therefore publish
expected and observed totals of **60 successful compiles, 2 intentional
baseline poison failures, 58 successful runtime assertions, and 2 successful
compile-only WASI exclusions**. Any other failed, skipped, or unexecuted cell
is non-acceptance.

The two source keys remain distinct throughout and may not be normalized into
one another. The timer UnitId must remain exactly
`ir-unit:v1:derived:ir-source%3Av1%3A0000000000000000%3Aentry%3Aasync.ts:`
`compiler-unit%3Atimer-shim%3Aset-timeout:0000000000000000` where the basename
fixture applies.

### Exact evidence and mutations

- In every candidate timer-positive cell, require one and only one matching
  terminal outcome: `kind=emitted`, `unitKind=function`,
  `displayName=setTimeout`, `legacyBodyEmitted=false`,
  `irBodyEmitted=true`, and no post-claim error. Its disposition must be
  `terminal-ir`, terminal/self-owned by the same exact UnitId, and the physical
  timer-entry census must be zero.
- Require the exact imported capability `env::__timer_set_timeout` with the
  established two-externref-to-externref ABI. Wrong module/name/type, missing
  import, duplicate preparation result, wrong declaration mapping, unsafe
  UnitId, non-self terminal owner, wrong synthetic role, or a second source
  must fail closed before any body patch is published.
- Preserve the four ToNumber configurations (`FUSED_TONUMBER` ×
  `SMI_FASTPATH`) under both optimization settings in standalone. Each of the
  eight candidate cells must match its grounded default-route artifact and
  retain exact dynamic timer-handle coercion. A provider returning `73` must
  schedule the requested delay once and return 73; a real Node Timeout object
  must coerce to a finite positive number.
- Explicitly mutate the retained `ctx.fast` and
  `resolveModuleBindings === false` gates. Neither may acquire a timer claim,
  imported-call plan, terminal patch, or compiler-provenance outcome merely
  because the rollback branch disappeared.
- Preserve exact typed Unsupported evidence for recognized-but-ineligible
  connected-component (`timer-component-not-isolated`) and missing-capability
  cases, including their internal preflight evidence, while requiring zero
  timer body/ABI/import capability, patch, or receipt publication. For injected
  `lower`, `seal`, currentness, and publication failures after permanent
  admission, require a fatal compilation failure or invariant,
  `legacyBodyEmitted=false`, zero physical timer entries, and zero timer
  body/ABI/import publication prefix; the timer may not be reclassified as
  `late-preparation-unsupported` or retried by the direct backend. Preserve
  exact non-timer evidence outside the failed component. Missing/duplicate/
  foreign timer outcomes, physical entries, terminal dispositions, or import
  rows are failures; sorted summaries alone are not acceptance evidence.
- Run the four external poison executions above for both retired values. A
  failing baseline is the positive control that proves injection reached the
  old branch; the matching successful candidate proves that value cannot
  resurrect the direct path. The poison is a test seam, not a production
  branch.

### Ownership and parallel-work lock

Production ownership is exactly
`src/codegen/ir-timer-shim-planning.ts`. After the final dependency rebase,
verify that the settled #3525 publication path already enforces permanent
post-admission failure. If it does not, stop before production edits and amend
this plan; this checkpoint does not pre-authorize any change to
`src/ir/compiler-timer-shim-preparation.ts`, `src/ir/integration.ts`, or a
generic fallback/publication rule. Focused test ownership is exactly
`tests/issue-4588-standalone-timer-shim-cutover.test.ts`; Sol-owned record
updates are exactly this issue and
`plan/issues/4522-ir-kill-switch-inventory-r9.md`. The A/B harness remains
external so no tracked helper can retain or reconstruct the retired key. Do
not edit the four consumer files, ProgramABI, prepared component
publication/sealing, #3525 orchestration, module-init, class cutover,
object-shape inference, #5092 selection/lowering, or Math selection files. If
a predecessor changed the exact seam, stop and amend this plan before widening
ownership.

### Validation and landing

Run the full current #4588 focused suite plus its new retirement cells and the
named #3519/#3520 identity/planning, #4573 Promise-delay, #4577 calendar/DOM,
standalone cutover corpus, IR-only, and linear timer-exclusion controls already
recorded above. Report exact files/tests passed over total. Remeasure the final
five-source source/unit/terminal/owned-support/unowned-support/derived census
and digest on the exact dependency parent and require the candidate to preserve
it; the historical 47/38/9/0/19 snapshot is provenance, not a substitute for a
fresh denominator. Run TS7 and TS5 typechecks, targeted and repository
lint/Prettier, diff check, IR layering/fallback/kind-neutrality/IR-only,
host-import policy, Wasm validity, and the relevant optimization/equivalence
gates.

Every heavy command must sample a finite, non-negative one-minute load
strictly below logical cores minus two immediately before launch and use an
archive-backed `TMPDIR`. Immediately before committing, run both LOC and
function-growth ratchets. Keep every precommit and prepush hook enabled, sign
the Thomas Tränkler-authored commit, and push normally. Terra implements only
after the dependency lock above; a fresh independent Sol reviewer must approve
the exact pushed SHA before the regular PR is marked ready or enqueued. Use the
protected merge queue with no admin or direct-merge bypass.
