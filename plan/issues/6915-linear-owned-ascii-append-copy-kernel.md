---
id: 6915
title: "Linear owned-ASCII append: optimize the existing copy kernel"
status: blocked
created: 2026-10-07
updated: 2026-10-08
sprint: current
priority: high
task_type: performance
area: ir, codegen-linear
goal: ir-full-coverage
model: gpt-6-astra
reasoning_effort: high
related: [3502, 3518, 3744, 4540, 6892, 6911]
---

## Objective and authority

### Released trusted append CI implementation — 2026-10-08

Human-approved bounded task `6915:trusted-append-ci-20261008`, owner
`ttraenkler/codex-linear-b-append-ci-sol61-20261008`, write ID
`61584-ct2bbtgm`, is implemented as Sol6.1 Medium in the existing isolated
`codex/6915-linear-append-plan-20261007` checkout at
`0d2dfddb4b1145097210f5398e535e550f945f82`. Authority is the full adopted Astra
plan at `555af588b3b41dda3b95a3d53468e0f4d55a32c7`,
[A's exact published implementation-plan commit](https://github.com/loopdive/js2/commit/555af588b3b41dda3b95a3d53468e0f4d55a32c7),
handoff6063855828. That separate dependency document is not a local file on this branch.
This task releases only this issue specification, the exact append-test branch
inside `scripts/hooks/changed-root-tests.sh`, and new
`scripts/hooks/run-linear-append-provenance.mjs`. No test, fixture, workflow,
source, dependency or other shared hook behavior is released.

The parent runner must independently enforce the approved production/test/
fixture/source-tree pins, verify git objects against worktree bytes, and use
actual CI `GITHUB_SHA` equal to checkout HEAD for a known checkout event.
Local invocation requires an explicit parent-supplied nine-field manifest
(`JS2WASM_APPEND_PARENT_MANIFEST`, absolute JSON file path). Its HEAD must be
the actual committed HEAD; pending edits are allowed only in these three
released CI/spec paths, never in source, test, fixture or execution config.
This permits legitimate pre-commit verification without approving dirty source.
The manifest cannot refresh approved content pins or learn expectations from
test output. Subsequent source/test epochs require independent review.

Execute the adopted fixed pnpm argv with 4096-MiB forks, Linear IR enabled,
NODE_ENV=test, NODE_OPTIONS absent and strict unhandled-error handling. Keep
the existing 36 fixtures, assertions, order and test caps untouched. Require
38 complete lossless evidence graphs, the independently reviewed 36-ID set,
exact provenance/completion and passing action/schema/emission channels, plus
reporter36 passed/zero skipped/failed/todo and strict process exit0. Retain raw
streams, graphs, decoded reference-preserving observations, reporter and before/
after custody even on failure. Missing/truncated/duplicate evidence, flags or
input drift fail closed. A finite runner timeout is not a test timeout override.
Only syntax/shell checks and embedded lightweight runner self-tests are
authorized now; parent owns serialized real-suite validation, review, commits
and publication. This task does not accept the instrument, deliver a native
caller, retire legacy behavior or release existing HOLDs.

Read-only parent/Astra review identified four receipt-gate obligations before
real execution: arrays need explicit valid lengths without truncated indexed
references; backing buffers/views must still match after property hydration;
IDs must bind runtime/source/import cohorts, 33 Runtime22 transitions, eight
reviewed negative mutation identities and authentic positive consumer/helper/
call joins; reporter assertion titles must join the same exact 36 IDs.
The runner must retain raw native-error accessor markers/descriptors without
invoking them. Historical 38-graph decoding is a positive instrument control,
not current CI qualification. Config pins are frozen byte hashes obtained from
the published approval object now, avoiding a historical-object dependency in
fetch-depth2 CI. Stream I/O and cleanup failures aggregate with original child,
decode and post-run drift failures, never replacing or suppressing them.

Bounded implementation checks: Node syntax, shell syntax, scoped runner
formatting and whitespace diff checks pass; embedded self-tests pass54 controls
including a complete synthetic receipt and the four reviewed negative families.
Read-only historical composed-main log replay (44,273,901 bytes) decodes38
complete graphs with zero decoder errors and preserves36 full witnesses;
the current CI contract correctly rejects that historical1024-MiB receipt.
These are parser/instrument controls only. No actual36-suite execution, heavy
compiler job, commit, push or publication occurred. Parent review and real
serialized qualification remain required; approved test bytes stayc63e83104b.

Parent measured native V8 Error serialization losing AggregateError members
and custom cause details. The runner must not claim native Error losslessness:
it archives detached plain reference-preserving error data and a descriptor
sidecar, including aggregate members, causes, custom properties, collections,
undefined and shared buffer/view data. Observed accessors are recorded, never
invoked; raw child graph descriptors remain authoritative. A native-loss
negative control and detached serialize/deserialize positive control verify
this distinction before real execution.

### Actual trusted-parent qualification — 2026-10-08

Parent independently supplied the nine-field manifest from A's published
`555af588b3b41dda3b95a3d53468e0f4d55a32c7` handoff, not from test output.
Execution HEAD `0d2dfddb4b1145097210f5398e535e550f945f82`, source tree
`953f74f80cf2f8085b8e1c93489fcdd357929b37`, frozen test SHA256
`c63e83104b42104c0ea9e7d5d3fb3f6f2cce960a65973cbf342698e8e79d7f8d`.
The working runner and exact hook branch were reviewed before execution; only
the three released CI/spec paths were pending edits. This is not a claimed
execution at the subsequent publication commit.

Runner SHA256 `a93d01892de5dba5783248b6441fcbf8979a47759bc2236a834b6abefc2e6bfa`;
hook SHA256 `51664c0c2254f929456e219292e4410cccfa43b6146c48c0e02e55972aeacdb4`.
Astra High's final read-only review found no remaining blocker in the four
reported receipt-gate families against this exact runner hash. Parent verified
all nine baked configuration hashes against the published approval git objects.
The final worker qualification has **54 embedded controls**, including detached
AggregateError/cause/custom-property round trips; raw child graphs remain the
authority, with unsupported diagnostic views rejected and unevaluated accessors
explicitly marked incomplete rather than blessed as empty.

Actual local invocation uses the explicit parent manifest, Node22.23.2,
Linear IR=1, NODE_OPTIONS absent, NODE_ENV=test, and the exact approved strict
Vitest command with4096-MiB forks. **36pass/0fail/0skip/0todo**, one test file,
strict process exit0; child elapsed19,733ms. Actual complete output is44,273,883
bytes, with38 valid envelopes: one provenance,36 unique observations and one
completion. Runtime22 retains33 transitions and all eight named negative
controls retain their full witnesses and rejection evidence. No reported
diagnostic, decoding, emission, cleanup, child, signal or timeout failure.

An independent parent replay requires **exact equality of all36 complete
observation graphs and the completion graph** against archived repaired-v3,
without filtering any graph field or changing any fixture. Execution provenance
is intentionally different and is separately validated/retained, not included
in a fabricated same-epoch equality claim. Full before/after HEAD, source tree,
source/test/fixture/configuration/runner/hook/spec hash custody is equal.
Original28pass/8fail, failed repairs, historical1024-MiB runs and every fixture
remain untouched. The actual runner invocation is retained separately under
`plan/log/6915-linear-append-20261007/ci-trusted-parent-20261008/` with a strict
offline comparison replay, raw streams, graphs, reporter and custody receipts.

This closes the measured missing-parent-input CI implementation gap locally.
It is the existing public Linear overlay instrument, not A's unpublished native
caller. It supplies no append performance acceptance, native array/Unicode
completion, original-failure erasure, legacy retirement, main delivery or HOLD
release. A retains reviewed composition and protected queue delivery. Normal
commit/push gates and newly triggered real CI still apply.

The first normal pre-push invocation passed type/lint/format and numeric18/18,
then correctly refused publication because the issue named A's separate plan
as a local repository path. The document exists only at its published dependency
commit. A direct blob URL still exposes that raw path to the existing link
detector, as the separate issue check demonstrated, so the reference links the
immutable plan-publication commit instead. No donor
issue is copied and no integrity gate is relaxed. The runner, test, source and
recorded qualification bytes remain unchanged; a second normal push is required.

Astra High authored the implementation specification; parent preserves it here.
Improve executed Linear runtime code consumed by existing source-derived IR,
without changing ownership, allocation, representation or admission contracts.
This is not another extraction, new frontend capability, complete PreparedIR
materialization, or permission to retire legacy paths.

Canonical allocation6915: owner
`ttraenkler/codex-linear-b-append-scope-plan-20261007`, pr_scan=ok.
Exact planning-only claim `6915:linear-append-astra-plan-20261007`, owner
`ttraenkler/codex-linear-b-append-astra-plan-20261007`, branch
`codex/6915-linear-append-plan-20261007`, verified on upstream/issue-assignments.
Planning base: `fefc9c0e79f4fbf70191f69ab0fdd76a07cc1206`.
This blocked proposal grants no source implementation authority.

## Blocking ownership gate

Request: https://github.com/loopdive/js2/pull/6582#issuecomment-6045965410.
No acknowledgment or source handoff has been received.

Published disjoint scopes:3518:bench-string-c2 (d8b20b5d44, Prepared orchestration
under src/codegen and tests);3518:provider-verification-ownership (twelve src/ir
paths plus its test);3518:provider-current-reader-blocker-20261001 (issue3518
limits changes to tests/issue-3518-provider-verification-ownership.test.ts).

Active claims whose exact exclusion remains unresolved:

- 3518:generic-concat-callable-admission,
  ttraenkler/codex-generic-concat-callable-admission. Recoverable c2e2fa87ea
  does not establish subsequent authorized write scope.
- 3518:host-js-string-provider,
  ttraenkler/astra-reference-error-runtime-20260906. Runtime-host boundary
  is recorded, but an exhaustive exclusion of this callback was not recovered.
- 3518:semantic-provider-source-acceptance,
  ttraenkler/codex-astra-semantic-provider-source-acceptance-20260908.
  Published coordination describes three source-evidence files; exact
  claim-linked manifest was not recovered.

Issue3502 is done;3744 remains reserved. Neither transfers ownership. Age,
missing publication and absence of matching PR changes are not abandonment.
Before implementation dispatch, obtain recorded exclusion or explicit handoff
for the precise regions below, refresh PR/function overlaps, then acquire fresh
unique source/test slice claims through CLAIM_ASSIGN_REMOTE=upstream.

## Exact conditional scopes

Production: ONLY the two copy loops and associated cursor-local use inside
`src/codegen-linear/runtime.ts::addLinearIrStringRuntime`'s registration
callback for `LINEAR_IR_STRING_APPEND_ASCII_FN` / __linear_ir_str_append_ascii.
Regions: growing-carrier initialized-prefix copy; RHS append copy.

Preserve signature, registration guard/order, helper lookup, local count,
capacity calculation, malloc call, payload-size store and final length update.
New test: tests/issue-6915-linear-owned-ascii-append-copy-kernel.test.ts only.
Parent owns issue/evidence. No new production facade/module or duplicated
orchestration is required for this bounded kernel replacement.

Exclude all A-owned producer/selector/preparation/provenance/integration,
physical emitters, source maps, compiler entry and registry files; allocator
work4540; array growth, vec initializer, slice, charCodeAt, forwarding and
repeat kernels; shared layouts/ABI, admission, optimization passes and retirement.

## Real consumption and opportunity

Existing source-derived string.concat with concatMode owned-append and ASCII
evidence -> linear-integration.ts::emitStringConcat -> defined append helper.
Existing issue3502 test uses untouched competitive/programs/string-hash.js,
three owned-append operations and native results. This is existing overlay
consumption, not new source-free PreparedIR materialization.
Current provider byte-copies growing prefixes and every RHS, including one
byte. No speedup or regression has been measured.

## Conditional implementation plan

After ownership and baseline gates:

1. Replace nonempty growing-prefix byte loop with memory.copy, with stack
   operands in destination/source/byte-count order: result+12,
   originalLeft+12, captured leftLength. The payload address offset is12;
   LINEAR_STRING_PAYLOAD_PREFIX_BYTES is4 and is NOT the address offset.
2. RHS split: zero bytes performs no payload access; one byte performs one
   unsigned byte load/store; longer RHS uses memory.copy. Destination is
   result+12+captured leftLength; source originalRight+12;
   count captured rightLength, in that exact stack operand order.
3. Keep allocation/capacity/address/header/length ordering outside these
   regions unchanged. Preserve local allocation/count and fresh instruction
   trees; no cached mutable bodies or alternate compiler/provider API.
4. Verify actual canonical memory.copy operands and supported target feature
   policy before editing. Node support alone is insufficient. If a required
   configuration forbids it, stop for a bounded decision; do not change policy.
5. Zero/one/many follows payload size, not a benchmark threshold. No threshold
   sweep or growth-policy change to manufacture gains.

Capture both original lengths before writes. No-growth returns same left
pointer, preserves capacity/allocation, changes only appended payload and final
length. Growth preserves allocation size/count/capacity and prior allocations,
copies only initialized prefix, then RHS. A growing result keeps the header
initialized by the allocator and the existing new-capacity store; do not copy
the old header/cache into the fresh allocation. No-growth retains existing
header/cache bits. Header preservation means equality to baseline behavior,
not copying headers between allocations. Distinct RHS remains unchanged.
Self-append uses captured original lengths: duplicate exact bytes with spare
capacity and growth; this runtime control does not imply frontend admission.
Preserve empty-input pointer/header behavior, ASCII NUL, cache/header bits,
payload prefix and alignment. Zero copies add no read/allocation/early-return
change. Overflow, OOM, malformed pointers/capacities and fabricated partial
overlaps are separate defects, not this task's authorized scope.

## Baseline and regression qualification

Parent serializes heavy work. Freeze full production/test commits, options,
bytes, environment and toolchain. Compile exact existing string-hash source
with existing Linear/bump/file identity. Node inputs0,1,100,20000 expect
0,96500,36729899,862771296.
Require joined real defined-helper registration, actual prepared/frozen owner,
consumer invocation, physical call, final valid artifact and native result;
a global report getter alone is insufficient. Observers preserve receiver,
arguments, returns, failures and artifacts. If baseline no longer admits/calls
helper, retain failure and stop: no fixture rewrite, hand-authored IR, fallback
switch or shared admission widening.

Freeze finite new-test population before coding: empty+empty/one/long;
nonempty+empty; one/long RHS with spare capacity and growth; exact-capacity and
first-byte-over boundaries; repeated multiple-growth appends; self-append
growth/no-growth; distinct equal-content carriers; integer payload lengths7/8/9
and15/16/17 around8-byte boundaries, with actual allocated addresses recorded;
NUL; bounded long payload; real function-import offsets and throwing
host namesake/decoy. Use genuine runtime allocation, not fabricated headers;
bind exports with actual import count and validate bounds before host views.

Record complete before/after memory, payload/header, pointer identities,
capacity, allocator usage and host-call counts. Baseline/candidate semantic
and allocation equality must be exact. Optimized binaries differ legitimately;
explain only authorized kernel differences, never normalize artifact equality.
Retain existing fixtures/assertions/optional-tool statuses/failures. No skips
added, it.fails, unsupported-as-green or expectation changes. Keep source
controls separate from runtime alias controls.
Negative controls: wrong result/byte, missing owner/consumer/helper evidence,
altered allocation/header/memory witness, and wrong import binding must fail.
Instrument controls do not authorize shared production mutation.

## Bounded performance acceptance and delivery

After correctness/custody/typing pass, measure authenticated source-compiled
artifacts with identical options. Include original one-byte-heavy source;
long-RHS source only if genuine owned-append admission is proved unchanged.
Predeclare inputs, warmup, repetitions, batch calls, memory/allocation caps,
timeout and decision rule BEFORE candidate timings. Identical fresh-instance
bounded batches, deterministic paired ABBA/BAAB order, no reset/pre-growth or
route differences. Preserve all samples, short cases, failures and witnesses;
check outputs/memory/allocations outside timing. Default engine is primary.
No unmeasured tiering explanation, instruction-count gain, slow-case dropping
or post-result threshold/budget relaxation.

Accept performance only with reproducible relevant-workload benefit and no
unresolved systematic control regression. Noise/opposing-order results leave
performance unresolved and change held; correctness alone is insufficient.
Reuse suitable paired-artifact instruments; any finite issue-local extension
needs separate review, not a general benchmark registry.

Require strict new-test-inclusive typing, scoped format/lint, normal build,
architecture checks and actual file/function budgets. Runtime.ts is over-limit;
replacement should shrink it. No borrowed allowance or gate/config weakening.
Preserve exact heads/hashes/options/flags/commands/deadlines, collected/completed
counts, full diagnostics and unsuccessful epochs. A retains final integration
and protected queue. Legacy remains until full IR equality.

## Fresh unchanged-source check

Parent ran original issue3502 test on this frozen main: exit0,2 passed and1
existing optional Porffor skip out of3. Full log/JSON preserved under
plan/log/6915-linear-append-20261007. This confirms existing source controls,
NOT all four lanes, new full owner/consumer attribution, kernel equality or
performance. Launch first failed because ignored .tmp output directory was
absent; created it and ran once. No test/source changes or hidden test retry.

Source status stays BLOCKED on exact ownership confirmation. Source
implementation has not been dispatched. Planning publication does not release
this gate. The independent test-only phase below has separate exact ownership.

## Astra High review

Independent read-only review atd8e154d4ce found no copy-replacement correctness
blocker and requested the three precision fixes now above: exact12-byte payload
address/stack order, baseline-relative fresh-header behavior, and integer
alignment cases. Self-append captured lengths and final length-store ordering
were reviewed as sound; feature-policy stop and performance hold remain.

## Astra High amendment: independently owned baseline tests

Only NEW `tests/issue-6915-linear-owned-ascii-append-copy-kernel.test.ts`
is eligible for Sol6.1 Medium dispatch after publishing this amendment and
verifying its fresh unique upstream test-only claim. No release of the append
callback or transfer of any older claim is inferred. No runtime, compiler,
registry, fixture, configuration or shared-test edits. No timing implementation
or performance conclusion in this phase. The earlier ownership gate applies
to SOURCE dispatch; this explicitly bounded new test path is independent.

Canonical production baseline: `c41bca2bc07e9d8fddbb38ca77904dd1f0cac438`;
parent merge `66407da1bf7644417f38ac6d949145662d8e304f`, source tree
`68296a0d34ceea94dbc9ca9398f71bc8a1b742b8`. Prior fefc measurements retain
their original heads. Freeze relevant production/fixture hashes before dispatch.
Identical test bytes/options/assertions/observation code must qualify any later
authorized candidate; record differing production/artifact hashes honestly,
never regenerate expectations from candidate output.

### Genuine construction and frozen population

Use actual addRuntime, addStringRuntime, addLinearIrStringRuntime and emitBinary.
Test-local exports expose EXISTING functions and actual __heap_ptr, with genuine
function-import counting. Do not replace or instrument production bodies.
Define C(bytes): allocate raw input using real __malloc, write only input bytes,
then invoke real __str_from_data. Define S(bytes): actual append C(bytes) to
C(empty); lengths1..16 produce capacity16. Finish all construction before
operation snapshots. Never manufacture headers, lengths, capacity or alias
pointers; cached cases invoke actual __str_is_ascii before snapshots.
Header+0, payload-size+4, length+8, bytes+12; prefix4 is NOT data offset12.

Freeze exactly36 observation IDs before coding:

- Runtime01..04: C(0)+C(0), C(0)+C(1), C(0)+C(17), C(3)+C(0).
- Runtime05..08: S(3)+C(1), C(3)+C(1), S(3)+C(4), C(3)+C(4).
- Runtime09..14: S(6)+C(1), S(7)+C(1), S(8)+C(1), S(14)+C(1),
  S(15)+C(1), S(15)+C(2).
- Runtime15..19: self S(4), self C(9), distinct equal-content S(4)/C(4),
  S("A\0")+C("\0B"), C(4096)+C(4097).
- Runtime20..21: cached S(4)+C(1), cached C(4)+C(1).
- Runtime22:33 one-byte appends from C(empty); assert and record ALL33
  transitions, including capacity16/32/64. Other rows use distinct ASCII
  patterns except intentional equality/self/NUL cases.
- Source01..04: unchanged string-hash fixture inputs0/1/100/20000 and
  expected0/96500/36729899/862771296. Original file identity and Linear/bump
  options stay unchanged.
- Import01..02: genuine runtime with throwing unrelated and append-namesake
  function imports plus a non-function import; exercise no-growth and growth
  separately. Both host counters remain zero.
- Negative01..08: independently corrupt result/payload, owner identity,
  consumer completion, helper binding, heap delta, header bytes, otherwise
  untouched memory and import binding. SAME positive-evidence validator must
  reject each; unrelated deliberately false assertions are not controls.

### Exact memory/allocation oracle

For each transition copy complete before/after memory, size, heap pointer,
operand/result pointers, headers, capacities and payload. Reacquire and
bounds-check views after calls. No growth: same left pointer/capacity, heap
delta0; only appended bytes and final length may change. Growth: capacity
max(2*oldCapacity,16,totalLength), result equals pre-call heap pointer, heap
delta align8(12+newCapacity). Preserve old allocations/distinct RHS and all
other memory bytes. Fresh growth header remains allocator-initialized zero;
never copy cached old header. No-growth preserves existing header/cache.
Self-append concatenates PRE-CALL payload with itself; do not assert unchanged
RHS on an alias of the changed left object.

Baseline/future-candidate semantics and memory/allocation witnesses compare
exactly; differing artifacts stay visible. Heap delta measures allocation
usage, NOT dynamic call counts. Establish expected zero/one allocation count
separately from the installed helper's single growth-branch allocator call;
never label inferred counts as measured.

### Mandatory actual source/consumer/helper join

Follow transparent6914 call-through observers, adapting runtime registration
to addLinearIrStringRuntime. Preserve receiver/args/returns/thrown errors.
Require unchanged source/options, genuine owned-append ASCII IR nodes, exact
frozen batch and completed Linear consumer, exact module-session identity,
run owner-unit joined to consumed output, installed physical body identity,
actual layout-resolved call to DEFINED append helper, valid final compiled
artifact and expected native result. A global report getter alone is insufficient.
Runtime exports prove kernel behavior, not source admission. Missing admission
or joins fail the positive source requirement: no altered fixture, manual IR,
disabled flag, skip or unsupported-as-green. Input0 does not establish dynamic
append execution; keep compile-time ownership and native call evidence distinct.

### Records, fail-closed typing and delivery

Strict discriminated records: provenance (schema/issue/source/test/fixture
hashes, options, Node/V8, flags, command, exact36-ID manifest); runtime
(construction, substeps, installed helper, artifact, full witnesses and import
counters); source (input/result/artifact/complete joins); negative (mutation
and rejection); completion (exact IDs, duplicates/missing/failures).
Reject absent/ill-typed fields, duplicate/missing IDs, invalid artifacts and
incompatible provenance. No broad Function, unchecked export casts or
permissive index-signature evidence bags. Restore observers/environment in
finally. Parent alone runs heavy qualification, including new-file-inclusive
strict typing and existing protections without configuration weakening.
Source/performance acceptance and A's final integration authority stay gated.

### Original regression qualification — 2026-10-07

Sol6.1 Medium delivered the isolated test file with SHA-256
`669d8dfb5150a6574eaef1bb0436884aad18cdf60fab87745cb41418f8571f84`,
on publication base `ea9c2eced70508dbb130dacf52f80de531f1fd3c`.
Production and fixtures remain unchanged from canonical main
`c41bca2bc07e9d8fddbb38ca77904dd1f0cac438`.

Parent's original new-file Vitest run exited1: **28pass/8fail/36, zero skips**.
All36 case IDs were attempted. Runtime16 (canonical self-append with growth)
fails the instrument's construction-count floor, which incorrectly requires
two records although genuine self-aliasing constructs one string. All four
source cases and three source-based negative controls fail while serializing
BigInt evidence in observation's finally block. The emitted completion reports
only Runtime16 as an action failure, so it does NOT accurately represent the
eight test failures and is not accepted as a successful evidence population.
Do not infer that the source joins are fully qualified from that completion.

Original test bytes, full13MiB stdout/stderr and JSON reporter output are
retained in the isolated worker's `.tmp/6915-validation/`; an Astra High review
and exact instrument-repair specification are pending. No source fix, skip,
fixture change or weakened semantic assertion is authorized by these findings.
The original unchanged3502 control suite at this fresh c41 epoch separately
exited0: **2pass/1existing optional Porffor skip/3**. Its raw log and JSON remain
in the planning worktree's `.tmp/`; this does not establish four-lane equality.
New-test-inclusive strict TS7 terminated exit0, zero diagnostics. The attempted `pnpm exec tsgo` was
unavailable (exit254); the actual repository lane uses
`node node_modules/typescript7/lib/tsc.js --noEmit -p
.tmp/6915-validation/tsconfig.test-inclusive.json`. No typing result is claimed
from the unavailable-command attempt. Original test commit
`276b10a1a7e16a521ed599d240ec3c5286c5aec2` was explicitly handed off by Sol and
integrated as `27c2ecb0e6`; original test bytes remain identical. Full raw
qualification is preserved in `plan/log/6915-linear-append-20261007/`.
Full publication and acceptance remain pending.

### Astra High instrument-repair plan — owner handoff

Review of original28pass/8fail identifies infrastructure defects, not a
demonstrated append-runtime bug. Sol owns ONLY the existing new test file.
Preserve original commits/logs/JSON and all36 observations,33 transitions,
inputs, expected outputs, complete memory bytes and functional assertions.

1. Replace the false construction-count floor with genuine operand custody:
   every initial distinct operand pointer comes from a recorded real
   construction; self-alias uses one carrier. Subsequent repeated-append left
   pointers equal the preceding result, with the original constructed RHS.
   Validate construction field types/recipes. Do not add dummy allocations,
   unexplained count weakening or alter the self-append population.
2. Add an explicit lossless test-local graph encoder: BigInt tagged canonical
   decimal (never Number); separate tags for NaN/infinities/negative zero and
   undefined; native AND frozen Map/Set actual entries; typed-array bytes and
   unchanged artifact/memory base64. Preserve graph nodes through explicit
   object IDs/references for repeats/cycles, with every node's contents.
   Reject unsupported values. No omitted fields, truncated bodies, summary
   substitution or '[Circular]'. Actual identity assertions retain original
   compiler-owned objects. No fixture cycle was demonstrated; BigInt failure
   and frozen-collection information loss are confirmed.
3. Track action and emission outcomes separately. Emission failure marks the
   observation/completion failed. If both fail, preserve both errors/stacks;
   finally must not overwrite the original action error. Emit a primitive-only
   incomplete-evidence diagnostic when full emission fails, then fail. Require
   zero action/schema/emission failures plus exact IDs/counts for completion.
4. Validate records before writing: required fields/discriminants/scalar types,
   construction and collection populations, graph reference integrity, finite
   integral bounded pointer/length/heap fields, exact approved production and
   fixture identities and parent-supplied test digest. Record effective flags;
   reject incompatible incoming Linear IR settings rather than silently
   overriding them. Require parent command/provenance fields. Parameterize
   approved baseline/candidate identity so future paired runs use IDENTICAL
   repaired test bytes, not baseline-specific edits.
5. Bounded encoder/schema self-checks (no new observation IDs): large signed
   BigInts, frozen collections, repeated/cyclic references, malformed/missing
   fields and incompatible provenance. Keep eight same-positive-validator
   negative controls unchanged. Preserve source owner/batch/completed-consumer/
   module-session/body/layout-resolved defined-helper joins in full.

Parent reruns test-inclusive strict typing and qualification after repair;
original and repaired epochs remain separate. Seven original source actions
reaching emission do not recover their missing complete records or establish
passing tests. No production edit, source ownership release, performance
acceptance or retirement follows from this instrument repair.

### Parent original-record population audit

Reading the actual preserved original raw log yields31 JSON records:
one provenance,29 observation records and one completion. Of29 observations,
28 report action success and Runtime16 reports its construction-floor failure.
The seven absent observation records are exactly Source01–04 and Negative02–04;
their JSON reporter failures are retained and cannot be credited from the
completion's attempted-ID list. Runtime22's actual surviving record contains
all33 transitions. These counts are raw-record custody, not a passing new
qualification or a recovered source witness. Repaired qualification must
retain the surviving full memory/artifact observations while supplying genuine
complete records for the previously missing source/negative observations.

### First frozen repair qualification — incomplete, retained

Sol handed off uncommitted snapshot SHA-256
`7145be7f67a51d6817bc90117ebecc39cc9a7db6d0e84e16840d8015cebc4b32`.
Actual worker execution HEAD is original test commit
`276b10a1a7e16a521ed599d240ec3c5286c5aec2`; production/fixture hashes remain
the pinned c41 epoch. Parent retained the complete frozen test copy and exact
parent identity input/receipt separately from original qualification.

New-test-inclusive strict TS7 exits1 with one TS2345 at line362:
`Reflect.get(prototype, "constructor")` receives an unknown prototype not
narrowed to object. No cast, suppression or source diagnostic is inferred.
The qualified runtime command exits1 before observations in the encoder's
self-check: native Error.stack is an accessor rejected as unsupported.
Vitest reports36 suite-skipped tests (zero executed observations), not an
intentional skip waiver or passing population; completion lists all36 missing
and records a provenance/schema failure. No repaired runtime result is accepted.

Parent's same-toolchain descriptor probe verifies Error and AggregateError
stack are own native getter/setter properties; two fresh Error instances share
the getter/setter identities. Message and AggregateError.errors are data
properties. Preserve all error contents/stacks; do not remove that self-check
or permit arbitrary accessors. Astra's next exact owner-handed repair is pending.
The frozen test, raw stdout/stderr, JSON, strict diagnostics and parent input/
receipt are retained in worker `.tmp/6915-validation/repaired-v1*` and
`strict-repaired-v1.log`; publication of this epoch remains pending.

### Astra High exact second repair — same test owner

Both first-repair checks are terminal. Sol may now change ONLY the owned new
test, preserving frozen7145 bytes and the original epoch separately:

1. Keep prototype typed unknown. Handle null separately; otherwise assert
   `typeof prototype === "object" && prototype !== null` on that SAME variable
   before Reflect.get. No cast, suppression, exclusion or permissive typing.
2. Allow ONLY native Error's own stack accessor whose getter AND setter
   identities match independently captured fresh-native-Error references.
   Retain stack text and an explicit accessor representation (native getter/
   setter markers, enumerable false, configurable true). Never invent a
   writable data descriptor. Retain message, aggregate errors, causes, other
   data properties and graph-reference identity. Reject arbitrary accessors
   without invoking them, no catch-and-ignore. Keep Error self-checks. The
   probe establishes this accessor mechanism, not absence of other unsupported
   properties; any further actual failure remains visible and separately held.
3. Capture source action outcome, attempt each cleanup independently, and
   retain original plus every cleanup error. Protect final restorers and
   diagnostic emission similarly. Any cleanup failure prevents successful
   completion. Preserve error stacks/causes, never replace primary failure
   with finally's last exception.
4. Remove redundant vi.stubEnv(Linear IR,1); assert the actual incoming value
   immediately before compile. Startup already requires1, so no changed
   source/runtime behavior is attributed to this removal. Detect later drift
   instead of silently resetting it.

Finish scoped formatting/light checks, freeze and hand back exact SHA/schema.
Parent alone runs strict typing and original-population qualification with
new separately retained identity/receipt/logs. Do not change36IDs/33transitions,
eight same-validator negatives, source owner joins, fixture/options/native
values, allocator/memory expectations, source code or acceptance boundaries.

### Second frozen repair qualification — runtime passes, review held

Snapshot SHA-256 `b5bbd82d37305a43691ad8197374bc79b2f681d2f8e0879502d97def3865b669`
is uncommitted on worker HEAD276b10a1; production/fixtures remain pinned c41.
Parent strict test-inclusive TS7 exits0/zero diagnostics. Configured Vitest
exits0:36pass/0fail/0skip. Actual raw log contains38 graph envelopes:
one provenance,36 unique observations,one completion;87,692 total graph nodes.
Previously missing seven source/negative records are NEW observations, never
retrospective recovery of original records. All frozen bytes and raw output,
parent identity/receipt and exact runner are retained separately as repaired-v2
artifacts. Full original-survivor witness comparison is running independently.

Astra read all2,091 lines and demonstrated a remaining diagnostic boundary
defect: approved native stack materialization can invoke an arbitrary message
getter before later descriptor rejection; errorText reads stack directly; and
Reflect.get can invoke a prototype constructor getter. Therefore runtime green
does not release review/acceptance. Preserve this positive epoch unchanged.

### Astra High exact third repair — finite descriptor boundary

Existing owned test ONLY; no new top-level functions/observation IDs, proxy or
security framework, callback-policy work, fixtures or production edits:

1. In encodeGraph, preflight ALL own descriptors before encoding values or
   materializing a native stack. Reject symbols/accessors except the exact
   approved native stack getter AND setter with original flags. Resolve
   effective name/message/prototype constructor by finite bounded descriptor
   walks, without invoking getters. Require name/message strings before stack
   materialization. Read constructor metadata including its name via data
   descriptors; remove Reflect.get. Retain every original data property and
   reference; never mutate errors or synthesize properties on them. Keep
   truthful native-error-stack representation, no writable accessor metadata.
2. errorText uses the SAME preflight/stack restriction. No direct stack/name/
   message read, String(object) or arbitrary coercion. Unsupported diagnostics
   emit an explicit primitive incomplete-evidence marker, while original thrown
   value remains in existing failure aggregation; marker cannot qualify
   evidence or permit success. Keep primary/all-cleanup retention intact.
3. Extend existing self-checks, no observation IDs: own message getter with
   approved stack; inherited name getter; prototype constructor getter;
   arbitrary stack getter in diagnostic path. Rejection/incomplete diagnostic
   must leave ALL counters zero. Reject non-string data name/message before
   materialization. Preserve native Error/AggregateError positive checks,
   three stack texts, truthful descriptors, aggregate contents and identity.

Parent publishes this specification and verifies survivor equality before
same-owner release. New bytes receive a new immutable epoch and independent
strict/runtime qualification;36/33/8, source joins, semantic assertions,
artifacts and complete memory/allocation witnesses remain unchanged.

### Demonstrated CI integration dependency — owner wiring required

The required changed-root gate in `.github/workflows/ci.yml` lines607–635 runs
`pnpm run test:changed-root` with only its existing eval-engine environment.
`scripts/hooks/changed-root-tests.sh` runs the newly changed root test without
the required parent identity/command/Linear-IR inputs and uses its EXISTING
4096MiB fork policy. Thus configured local36/36 is not a default-CI pass; the
current instrument intentionally rejects absent parent inputs. Do not waive,
skip, exclude or silently approve inside the instrument. No shared hook/workflow
has been edited or claimed by B.

Astra's exact designated-owner request: A must explicitly delegate the hook's
invocation branch for this EXACT test path, plus only prerequisite preparation
in the named CI step that A separately authorizes. Preserve all other test
invocations, selection, cap, failure propagation and not-run reporting. The
trusted parent supplies EXPECTED_PROVENANCE, matching TEST_COMMAND and
Linear IR=1 scoped to this invocation. Actual execution HEAD/source tree and
runtime/consumer/integration/test/fixture hashes come from the actual checkout,
not PR-head assumptions or local historical pins. Approve actual WORKER flags;
hook4096MiB differs from local1024MiB, launcher execArgv is insufficient.
Missing identity, incompatible flags, changed inputs during execution or
incomplete qualification must fail. No self-approval or missing-input skip.

Parent must verify the ordinary changed-root route executes all36 and
propagates failures while retaining enforcement of every otherwise selected
file. Archive this separately as CI integration qualification, not frozen
paired/performance evidence. No actual wiring delegation, CI pass, protected
queue acceptance or completed integration is claimed.

### Third repair qualified and integrated — 2026-10-08

Frozen SHA-256 `c63e83104b42104c0ea9e7d5d3fb3f6f2cce960a65973cbf342698e8e79d7f8d`
passes new-test-inclusive strict TS7 exit0/zero diagnostics and configured
Vitest36pass/0fail/0skip. Actual38 envelopes contain all36 observations plus
provenance/completion;87,692 nodes. Parent compared ALL36 complete observation
graphs and completion against the b5 repaired epoch with strict deep equality:
no field filtering or normalization. Provenance is separately retained with
new test SHA and command. Astra read all2,227 lines and found no demonstrated
breach of the exact finite third-repair criteria. This clears that SOURCE
REVIEW only, not ordinary CI, source-loop ownership or full IR acceptance.

Independent Sol survivor audit compares29 original records/34 proof objects:
binary artifacts, append-kernel bodies, complete memory/payload/header/heap,
host/import custody match. Additional canonicalPointer recipe independently
verified. Strict decoded equality against original lossy JSON does NOT hold:
three charCodeAt NaN values were originalnull; four empty Map/Set collections
were originalarrays per proof. All differences remain explicit. Original JSON
cannot establish retrospective reference identity. Parent's separately retained
original-codec projection audit agrees29/29, includes unchanged rejection
strings, and explicitly labels codec losses; it is NOT strict decoded equality.
All33 transitions, four source result/owner/batch/consumer/module/physical-call
joins and eight same-validator negatives are present. Seven originally missing
records remain missing in the original epoch and receive no retroactive credit.

Sol's actual commit `0a9122245c93625f6212160fc46dae218efb8b17` contains ONLY the
owned new test and preserves c63 bytes after normal fast hooks. Explicitly
handed off and integrated as `d2741617beca680cedef63f3e12feb4aa03548ee`.
Qualification execution HEAD stays276b10a1 with the frozen working test, not
relabeled as either later commit. Raw final test/log/JSON/strict/input/receipt/
runner artifacts are retained under repaired-v3 in the evidence directory.
Default changed-root CI wiring remains a genuine designated-owner dependency;
the configured instrument success is not a default-CI or merge acceptance.

### Observed advisory CI failure — 2026-10-08

GitHub run37694677932 on published HEAD
`f99e37a1f9496d21a129e7c98ff087119bcba94c`, changed-test job113044032212,
reports job SUCCESS but its actual test invocation fails setup with
`JS2WASM_APPEND_EXPECTED_PROVENANCE is required`: one failed test file,
36 suite-skipped cases, zero completed observations. The wrapper explicitly
reports the failure as advisory. This is not a passing regression or an
intentional waiver. Full raw job log is retained as
`plan/log/6915-linear-append-20261007/ci-changed-job-113044032212.log.gz`.

The separately required quality job113043352038 was still running at this
inspection; no conclusion or downstream changed-root execution is inferred
from the advisory job. Designated-owner wiring remains required as specified
above; B has not modified shared hooks, workflows or their failure policy.
Preserve the existing run before batching a subsequent branch refresh.

Canonical main now resolves to8452732f0b88c14c5c7634ece58f83240970ea4c.
Its delta from frozen c41 includes compiler source changes, not only baseline
reports. Historical c41 qualifications remain frozen and cannot be relabeled
as qualification of the new composition. Refresh and scoped requalification
were pending at that inspection; this observation changes no production ownership.

### Local main composition and independent review — 2026-10-08

Canonical main8452732f was merged without conflicts into local composition
HEAD `352accfce5618a44edc4e2f659dcb38c4b7a5d93`, source tree
`953f74f80cf2f8085b8e1c93489fcdd357929b37`. The regression remains byte-identical
at c63; neither the merge nor this review is qualification. Remote PR6593
still points to f99 while its original CI run remains live.

Astra read-only review found the changed constructor/NewTarget paths belong
to WasmGC/standalone emission, not the Linear generator selected by this
regression. The source evidence uses ONE unchanged string-hash fixture at
four inputs. Linear runtime, IR, consumer, integration and fixture files are
unchanged. Node-native Error self-checks do not exercise compiled constructors.
These facts support expected invariance, not measured equality. Require a new
actual-HEAD/source-tree provenance epoch, unchanged c63 bytes, all36 observations,
33 transitions/eight negatives, strict typing and complete evidence comparison.
Retain old execution identities and investigate rather than normalize changes.

Independent Sol review found main's registry delta adds only three WasmGC
constructor-related classifications. It still omits forwarding6590's README
nonModule and forwarding-resolver.ts legacy-linear entries. No incompatible
policy change was found, but A must compose the existing proposal with main's
new entries and qualify canonical policy. Old temporary-policy replay does
not prove that composition. No source/registry ownership release is inferred.

### Composition qualification and required CI failure — 2026-10-08

Execution HEAD352accfce5618a44edc4e2f659dcb38c4b7a5d93, source tree953f74f8,
unchanged c63 test: configured regression exit0,36pass/0fail/0skip. Strict TS7
including the new test exits0/zero diagnostics. Raw38 graph envelopes retain
all36 observations and completion. ALL36 complete observation graphs and the
completion graph are strictly equal to repaired-v3 with NO filtered fields or
normalization. Only the separately retained provenance epoch differs. Raw log,
reporter JSON, parent inputs/receipt, runner, strict output and exact comparison
script/result are archived as composed-main artifacts. No timing acceptance,
new source implementation, default-CI pass or full-IR completion follows.

Required quality job113043352038 on published f99 has now finished FAILURE.
Its changed-root invocation fails with missing EXPECTED_PROVENANCE, one failed
test file and36 setup-skipped cases; full raw output is retained in
ci-quality-job-113043352038.log.gz. Unlike the separate advisory job, this gate
propagates failure. Preserve both job records. The containing run37694677932
still has live jobs; the local refresh has not restarted or cancelled them.
Designated-owner parent-input wiring remains an actual landing blocker.

### Dedicated Linear PR shepherd — 2026-10-08

User explicitly requested a shepherd subagent. Parent reserved and freshly
effect-verified `6915:linear-pr-shepherd-20261008`, owner
`ttraenkler/codex-linear-b-pr-shepherd-sol61-20261008`, branch
`codex/6915-linear-pr-shepherd-20261008`, ledger tip
`7c09197b155d47ed34f9036934c701d48a46f353`. Isolated checkout:
`/private/tmp/js2-linear-pr-shepherd-20261008`, canonical main845 production.

Sol6.1 Medium will shepherd B's actual open PRs6563,6570,6572,6575,6577,6583,
6590 and6593 using conflict → unresolved review → real CI failure ordering.
Its initial exact write scope is only
`plan/log/linear-pr-shepherd-20261008.md` plus worktree-local generated evidence.
No author branch, production/test file, shared registry/hook/workflow or A-owned
source edits are released by this task. Concrete B-owned fixes require their
own explicit file/function partition and isolated author-head checkout before
editing. Parent owns this issue update and publication into existing PRs.

Agent must record exact PR heads, verified main ancestry, genuine failing job
diagnostics, necessary ownership/dependency requests, and a dependency-first
landing order. Passing advisory stubs do not establish acceptance. No merges,
auto-merge, queue submission, hold removal or protection weakening; A remains
integration owner. Existing positive failures and all historical evidence stay.
The shepherd task does not authorize new implementation scope or claim delivery.

### Shepherd findings — 2026-10-08

Dalton completed the bounded first pass and wrote
`plan/log/linear-pr-shepherd-20261008.md`; parent reviewed/integrated the full
report. Eight actual open PRs have no merge conflicts and zero review threads,
but none is declared merge-ready. Only three contain canonical main845. Five
current real quality jobs fail on eight unique missing normal registry paths
(five runtime modules, three README files). All are A-owned registry changes.
The prior append quality job failed with missing trusted provenance and zero
completed observations; new docs-head CI was still running at the snapshot.
Advisory SUCCESS jobs with failed/skipped test populations are not credited.

The report preserves exact heads, server-side ancestry, failed-job diagnostics,
historical pairing denominators and a dependency-first landing proposal. It
found no independently fixable B-owned blocker and changed no author source,
tests or GitHub state. Parent will send A the consolidated exact registry and
trusted-input requests. No queue/hold release, acceptance waiver or completed
IR migration is inferred. Further concrete source repairs need a new explicit
file/function release, not generic ownership of this shepherd task.

### Published hook qualification and next owner dependency — 2026-10-08

The actual changed-root hook ran at published HEAD
`0d210cfa5f9a214309681ef1b8ecf2a6c260c6d7`, selecting exactly the frozen
append test and invoking the trusted parent.36 passed; zero failed/skipped/todo;
strict exit0; before/after custody equal. All36 complete observation graphs
and completion exactly equal repaired-v3 without filtering any graph fields.
Full raw evidence and offline replay live in
`plan/log/6915-linear-append-20261007/ci-hook-parent-20261008/`.
First execution archive, original failures, fixtures and repairs are preserved.
This qualifies hook routing, not native array/Unicode support or retirement.

Matching-path registry repairs are published on existing PRs6583/6577/6572/
6575/6590. Fresh shepherd checks found all five mergeable with zero unresolved
review threads and passing registry inventories. Real quality jobs113423217195
(6572),113421304177(6577),113419277902(6583) fail the unchanged import-cycle
guard: Linear-to-IR value edges9→11,9→10,9→10 respectively. Later job steps
were not run. Quality jobs113425657909(6575),113426640536(6590) succeeded;
other checks were still running, so no full-green or landing claim follows.

Astra's read-only attribution identifies actual value dependencies on the IR
memory planner: array size/capacity uses planLinearVectorLayout and irVal;
vector initialization uses LINEAR_VECTOR_ELEMENTS_OFFSET; char-code-at uses
the string length/elements offsets. Type-only instruction provenance removes
none of these edges. Request A's canonical Linear layout VALUE contract outside
IR analysis, consumed by the existing planner as the same authority. After A
publishes tested exact source commits and explicit file/function scope, B can
retarget its three leaf import hunks and run unchanged architecture/regression
gates. No copied constants, hardcoded enums, barrel camouflage or budget
allowance is authorized. Wasm-model publication alone does not unblock this.

A retains shared compiler/preparation/codec/consumer wiring and final queue
delivery. Foreign allocator4540 and shared3518 ownership claims are untouched.
No legacy removal, HOLD release, merge or new checkpoint PR was performed.

### Finite repair: CI-generated boundary-report custody — 2026-10-08

Parent reports a new real failure at PR6593 HEAD
`7be295c0d8611882ec09492af8d29c229bb4bfba`, run37815701912,
quality job113443658866, step48: `assertFrozenInputs` rejects the untracked
`compiler-boundaries-report.json` produced by the earlier unchanged inventory
step. Parent retains the actual failing log; this specification does not claim
an independently rerun failure or a passing repaired epoch. Source inspection
confirms the incompatibility: ci.yml lines168–180 writes that root file, while
the runner's porcelain loop admits only the three existing local EDITABLE paths.

This is generated-output custody, not source approval or append implementation.
Parent confirms the implementation slice `6915:ci-generated-report-custody-20261008`,
owner `ttraenkler/codex-linear-b-generated-report-sol61-20261008`, effect-verified
held at ledger `364bba862f`, write ID `4156-17hxbrq8`. This appendix authorizes
no claim mutation. All source, fixture, dependency, workflow and original test
pins, existing HOLDs, and foreign4540/3518 ownership remain unchanged.

Parent's independent CI-faithful reproduction produced a10,924,371-byte report
with status `inventory-valid-architecture-incomplete` and sourceRevision7be295.
The unchanged runner exited1 before spawning the child. Preserve its archive
`.tmp/6915-ci/run-H4QDf9` and original real-CI log
`.tmp/6915-custody-repair/failed-job-113443658866.log`. Parent's independently
authored manifest is `.tmp/6915-approved-parent-7be295.json`. These are measured
parent observations, not architect-run tests. The deliberately retained untracked
root report is the positive reproduction input: do not edit or delete it.
Its status does not approve source or establish architecture completion. The
64MiB bound below exceeds this actual10,924,371-byte population.

#### Exact worker partition

Only `scripts/hooks/run-linear-append-provenance.mjs` needs implementation:

- `assertFrozenInputs` (line290 at the reported HEAD): exact generated-path
  classification and inclusion of its detached custody metadata in the returned
  snapshot. Preserve every existing source/config/git-object check.
- One narrowly scoped report snapshot helper, proposed
  `snapshotGeneratedBoundaryReport`, plus literal path/byte-cap constants.
  Reuse the existing regular-file checks and SHA256 implementation; no generic
  artifact allowlist, approval resolver, registry or workflow framework.
- `runAppendQualification` (line998): archive the helper's exact captured bytes
  before spawn and after child termination, and retain before/after metadata
  through the existing finally/error aggregation path.
- `selfTest` (line1179): embedded finite controls of those same production
  predicates/snapshot comparison. Small isolated temporary filesystem/Git
  fixtures are permitted for controls; no compiler, Vitest or real suite in
  self-test mode, and no mutation of the user's checkout or shared refs.

No changes to `changed-root-tests.sh`, ci.yml, the frozen36-case test, fixtures,
runtime, shared compiler, registry, CONFIG_PINS, parent manifest schema or child
provenance schema. Parent owns subsequent issue/evidence integration and commits.

#### Exact admissibility and data contract

1. The only additional pathname is repository-root
   `compiler-boundaries-report.json`, matched exactly, with status exactly `??`
   when present in porcelain. Renames, copies, staged additions and tracked
   modifications are not this exception. Require independently that neither
   frozen HEAD nor the current Git index tracks this pathname, even if Git
   reports no dirt. A failure to inspect Git is an error, not absence.
2. Check this exact path independently of porcelain so an ignored file or a
   dangling symlink cannot evade custody. Absence is allowed and recorded;
   presence must be a regular, non-symlink, non-executable data file. Reuse path
   component checks; directories, FIFOs and symlinks (including dangling links)
   fail without reading their contents. This does not authorize any other
   ignored-path exception or change existing handling of unrelated paths.
3. Use a fixed maximum of64MiB (the existing MAX_BYTES bound); no environment
   override. Enforce the bound before and during capture, so a changing size
   cannot cause an unbounded read. Capture through one validated file handle,
   preserving all bytes without JSON parsing, normalization, truncation or
   reserialization. Read/stat/archive failures fail qualification. Do not import,
   evaluate or execute the report, nor trust any reported green verdict, hashes,
   source list or configuration as approval.
4. Return metadata separately from approved `files`, for example one fixed
   `generatedBoundaryReport` discriminant: `{path, present:false}` or
   `{path, present:true, byteLength, sha256}`. Keep raw bytes transiently alongside
   the snapshot for archival, not in the parent expected-provenance manifest.
   The bytes hashed must be the same captured bytes saved. Presence, length and
   digest form the before/after equality contract; timestamps/inodes are not
   compiler inputs and do not replace content equality.
5. Archive present pre-spawn bytes as `boundary-report-before.raw` and present
   post-child bytes as `boundary-report-after.raw` inside the existing unique run
   archive. `before.json`/`after.json` retain their presence/digest/length metadata.
   No placeholder raw file for absence. Record the after snapshot and any safe
   bounded after bytes before comparing snapshots, so a drift failure preserves
   its evidence. Changed bytes (including same-length changes), disappearance
   or appearance after an absent baseline all fail. If after capture itself is
   invalid, retain the original snapshot/raw bytes and existing after-failure
   diagnostic; do not follow a symlink or read oversized data to obtain evidence.
6. Keep the existing deep before/after comparison and primary/cleanup error
   aggregation. Report capture/archive/drift errors prevent success; no failure
   replaces the primary child error. Never delete or rewrite the producer's root
   file. Permit this same exact output under either already-approved CI identity
   or explicit local parent identity, allowing CI-faithful local reproduction
   without inferring CI identity from the report. The three EDITABLE local paths
   retain precisely their existing rules; every other unknown untracked or
   tracked edit still fails. No `*.json`, directory or status-class exemption.

#### Finite implementation controls and parent qualification

Add embedded positives for absent output and unchanged present output, verifying
exact raw-byte/hash equality; opaque bytes must not need a JSON/green verdict.
Exercise both existing identity modes without modifying their approval rules.
Preserve the complete healthy38-record/36-ID, Runtime22/33-transition and eight
negative witness controls and all prior decoder/receipt failures.

Negatives must exercise the real checks: dirty source, fixture and execution
config; another unknown root file; tracked report (clean in HEAD as well as
newly staged); report symlink and dangling symlink; nonregular/executable report;
oversized output; same-length byte drift; presence-to-absence and
absence-to-presence drift. Archive-write/capture failure must remain a failing
qualification through the existing aggregation path. Do not duplicate the
decision logic in a self-test-only validator or relax pins to create positives.
Report the actual collected control count only after execution, not a predicted
new total. Parent serializes any real test runs.

Parent's required production reproduction uses the unchanged CI producer:

```sh
node --max-old-space-size=2048 scripts/check-compiler-boundaries.mjs \
  --mode inventory --base HEAD^1 > compiler-boundaries-report.json
```

Use the actual frozen CI-faithful checkout/base and preserve the producer's exit
status and raw stderr/output; no synthetic report substituted for this run.
Then run the existing changed-root/parent path with independently authored
identity and unchanged source/test/fixture/config pins. Require strict exit0,
reporter36 passed/zero failed/skipped/todo, all38 complete envelopes (provenance,
36 unique observations, completion), Runtime22's33 transitions, all eight
same-validator negatives and genuine source joins. Require identical before/after
generated-report custody. Compare all36 observation graphs and completion to the
retained qualified baseline without filtering semantic fields; provenance/run
identity and the new parent-only artifact metadata are separately recorded.

Retain the first step48 failure and every old archive unchanged. A successful
local reproduction is not a default-CI pass; actual repaired CI remains required.
No performance, native caller/admission, full IR delivery, legacy retirement or
HOLD-release claim follows from this repair. No signing setup work is requested.

#### Implementation and measured qualification

Sol6.1 Medium implemented only the finite runner seam;89 embedded controls
passed in worker and parent runs. Astra High's final read-only review cleared
the actual diff against this plan at runner SHA256
`ba0dd8a0ef4d036f70f730a31202af1879a27e273f7c3eea0e0521818de737d7`.
Parent executed the real changed-root hook at HEAD7be295/source tree953f74f8
with the pending patch and unchanged independently approved pins.36 passed,
zero failed/skipped/todo, strict exit0; all38 full envelopes retained.
All36 complete observation graphs and completion exactly equal repaired-v3,
without filtering graph fields. The real10,924,371-byte producer report is
identical before/after, separately retained as opaque output, never approval.

The original real-CI failure, strict local failed reproduction, repaired raw
streams/graphs/decoded records, executed runner bytes and offline replay are
published in `plan/log/6915-linear-append-20261007/ci-report-custody-20261008/`.
Prior failures/fixtures/epochs remain unchanged. A publication commit must not
replace7be295 as execution identity. Actual repaired CI is still required;
later gates and native implementation are not qualified by this bounded repair.
No hook/workflow/source/config/fixture or protection changes were made.

### Owner-review proposal: advisory selected append caller — 2026-10-08

Planning-only slice `6915:advisory-parent-caller-plan-20261008`, owner
`ttraenkler/codex-linear-b-advisory-caller-astra-20261008`, is parent-confirmed
effect-verified at ledger `4b08ba71eb`, write ID `42447-taxim1on`. Its sole write
scope is this appendix. No workflow or runner implementation, foreign claim
transfer, commit, push, queue action or HOLD release is authorized. A/root must
review and explicitly release the exact implementation hunk before any edit.
Synchronization comment6066046970 requests review; it is not an ownership release.

Inspected checkout is `6900bb7c35d00702c5cf7ca5379c863e22866b1d`, which already
publishes the required-quality generated-report custody repair. A's earlier
review referred to7be295; do not attribute that repaired blocker to the new head.
The separate advisory job113445120654 used direct Vitest. Parent's retained raw
log `.tmp/6915-custody-repair/advisory-job-113445120654.log` records36 setup-skips,
zero observations and missing `JS2WASM_APPEND_EXPECTED_PROVENANCE`.
`steps.tests.outcome` was `failure` despite overall job success. That is an
unqualified instrument run, not36 passing tests. This appendix records parent
evidence; the architect did not rerun or refresh the CI job.

#### Proposed exact command-only partition

At the inspected head, `.github/workflows/ci.yml:896` defines
`issue-tests-changed`. The candidate implementation hunk is only the shell body
of `Run changed issue test file (advisory)`, `id: tests`, lines935–939. Proposed
dispatch after the existing selected-file manifest validation:

```sh
if [ "$ISSUE_TEST_FILE" = "tests/issue-6915-linear-owned-ascii-append-copy-kernel.test.ts" ]; then
  node scripts/hooks/run-linear-append-provenance.mjs
else
  pnpm exec vitest run "$ISSUE_TEST_FILE" \
    --pool=forks --poolOptions.forks.singleFork=false \
    --poolOptions.forks.maxForks=1 --no-file-parallelism
fi
```

This is a proposed owner-reviewed branch, not permission to apply it. Invoke the
already published parent directly for exactly that selected file. Do not call
`changed-root-tests.sh`, repeat selection, run additional files, duplicate the
parent, synthesize parent expectations in YAML, or introduce a second receipt
validator. `scripts/select-changed-issue-tests.mjs` and its tests are read-only
dependencies, not implementation targets.

Keep `continue-on-error: true` at line932, `id: tests`, the existing environment,
the one-file-per-runner matrix, max15 selection, manifest/ordinal validation,
all pinned tests and every other lane unchanged. Keep outcome reporting at
lines941–952 and the existing aggregate issue-test policy unchanged. The direct
Vitest else arm retains every existing flag. The append parent uses its own
already-approved strict command and single-fork flags; do not force the direct
arm's flags onto it or suppress its unhandled-error channel.

The parent process must be the branch's exit status: no trailing success command,
`|| true`, direct-Vitest retry, green fallback or catch-and-pass. GitHub's existing
advisory policy may transform the step conclusion/job result, but the raw step
outcome must remain failure on nonzero parent exit and the existing warning
must report it. This proposal neither makes the advisory job required nor changes
required-quality enforcement. A job-level green alone cannot qualify append.

#### Identity, immutable pins and the explicit push-event gap

The current runner's `readApprovedCheckout`/`assertIdentity` obtains actual Git
HEAD and requires `GITHUB_ACTIONS=true`, matching `GITHUB_SHA`, no local-manifest
override, and event `pull_request` or `merge_group`. Continue using those genuine
CI values, not a frozen historical HEAD or an event invented by the workflow.
The parent independently checks source tree, production/test/fixture bytes and
CONFIG_PINS, then supplies the child command/provenance/flags. No test-side
approval or updated pins learned from test output are allowed.

The changed-file job's default shallow checkout at line908 is sufficient for
this existing parent: current HEAD/tree/blob/index reads do not require the
historical APPROVAL_COMMIT object or a merge-base selection in this runner.
Selection already occurred in the separate full-history selector job. Do not
add a history fetch as a substitute for failed identity or changed content pins.
A committed command-only workflow edit can satisfy the existing pins because
ci.yml is not in CONFIG_PINS and does not alter the source/test/fixture hashes.
An uncommitted workflow edit remains outside the three local EDITABLE paths and
must fail; do not add it to that local exception. A composed main changing any
pinned input still requires separate independent review, not automatic repinning.

**Unresolved owner decision:** ci.yml also runs on `push` to main. The current
parent intentionally rejects `GITHUB_EVENT_NAME=push`. The current selector
normally finds an empty push/main diff when origin/main contains HEAD, but its
HEAD^ fallback can select this append test if that base is unavailable. The
command-only branch would
therefore fail closed on that event. Neither this appendix nor the branch makes
push a supported identity. Do not add an event skip, spoof PR/merge-group values,
run direct Vitest instead, or silently widen `assertIdentity`.

A/root must explicitly choose and record whether the existing push refusal is
retained as a known limitation of the bounded caller repair, or whether genuine
push/main qualification is also required. The latter needs a separately reviewed
exact parent identity contract and function-scope release (including positive
and negative controls); no concrete push approval predicate is authorized here.
Until then do not claim all-event CI compatibility. Any release must name both
the command hunk and any actually necessary additional identity scope, rather
than hiding that dependency inside the workflow edit.

#### Output custody and finite verification

Reuse the parent's unique `.tmp/6915-ci/run-*` archives, strict exit receipt,
raw streams,38 graphs, decoded witnesses, reporter, command, expected inputs
and before/after custody. The independent advisory runner does not execute the
quality job's boundary-report producer: absent generated output is valid and
recorded by the published custody repair; do not fabricate/copy a quality report.
If present, the same exact-path64MiB opaque-data rules apply. Never treat an
inventory verdict as source approval.

The command-only hunk adds no artifact uploader. Evidence must be inspected and
retained by parent during qualification before the runner is discarded. If A
requires durable Actions artifact retention for future advisory executions, it
must explicitly release a separate exact append-only upload step; no general
workflow/artifact framework or unrelated lane change is implied here. Do not
claim an ephemeral archive is a published durable CI artifact.

Before release, owner review must verify the actual YAML diff changes only the
named command hunk (plus separately released scope, if any). After release,
finite lightweight dispatch controls must show the exact append filename calls
the existing parent once, another selected file receives the byte-equivalent
old Vitest argv, and injected parent nonzero status propagates to step failure.
Use isolated controls, never substitute a stub for production qualification.
Retain the existing selector/manifest assertions and parent control population.
Missing/mismatched CI identity, unexpected pins/flags, absent/malformed receipts,
failed diagnostics and child errors must remain failures. Explicitly preserve
the push-event rejection control until a separate contract changes it.

Parent owns the serialized real selected-file execution on the committed
candidate/actual supported CI event. Require36 passed/zero failed/skipped/todo,
38 complete envelopes (one provenance,36 unique observations, one completion),
Runtime22's33 transitions, all eight same-validator negatives, genuine source
owner/consumer/helper joins, strict parent exit0 and equal before/after custody.
Compare complete36 observation graphs and completion with the preserved qualified
baseline; record actual new provenance separately, without relabeling old runs.
Keep the original advisory36-skips/zero-observations log and all prior epochs.
Advisory success does not replace required-quality evidence or prove runtime
source correctness, native admission, performance, full IR completion or legacy
retirement. A remains final integration/queue owner.

Parent observed required-quality job113462828513 live at step14, then step17,
while this proposal was written. Do not interrupt/restart it or push a new revision before
parent settles that run. No signing setup work is requested.

### Finite repair: colorless parent-to-child evidence transport — 2026-10-08

Parent releases this specification appendix only under
`6915:colorless-parent-transport-20261008`, owner
`ttraenkler/codex-linear-b-colorless-transport-sol61-20261008`, effect-verified
ledger `11ab00c4b2`, write ID `44852-vup6elq0`. Parent must review the complete
appendix before releasing the worker's sole runner-file implementation. No
workflow, runtime, fixture, frozen test, dependency, CONFIG_PINS, manifest schema,
command/worker flags or shared ownership changes are authorized. The advisory
workflow caller proposal above remains unreleased. No signing work is requested.

#### Recorded failure and countercontrol

Required-quality job113462828513 failed at step48 after the generated-report
repair. Preserve `.tmp/6915-custody-repair/failed-job-113462828513.log`; its repeated
`prefixed/truncated evidence envelope` assertions establish a parent transport
failure, not a newly observed runtime semantic failure. That job log contains
no raw envelope lines, so the actual prefix bytes come from the controlled
local reproduction, not an inference about missing CI bytes.

Both terminal local experiments executed unchanged runner SHA256
`ba0dd8a0ef4d036f70f730a31202af1879a27e273f7c3eea0e0521818de737d7`
at HEAD `1a0584f07f69914482c91e9a82e00ac54aada092`, with the same approved source,
test, fixture and manifest pins. Keep that execution identity even after a later
specification or implementation publication.

- Plain countercontrol `.tmp/6915-ci/run-enYXb9`: parent supplied FORCE_COLOR=1
  while NO_COLOR=1 remained inherited. Parent reports terminal exit0. Read-only
  archive inspection found38 raw envelopes with empty prefixes,38 accepted graph
  lines, child exit0, no receipt failures, and reporter36 passed/0 failed/0 pending.
  This is a passing countercontrol, not a failed forced-color experiment.
- Colored reproduction `.tmp/6915-ci/run-dA6Luk`: parent removed NO_COLOR and
  supplied FORCE_COLOR=1. Parent reports terminal exit1. Read-only inspection
  found38 raw envelopes, each prefixed with hex `1b5b32326d1b5b33396d`
  (`ESC[22m ESC[39m`), zero accepted graph lines, child exit0, one aggregate
  receipt failure, and reporter36 passed/0 failed/0 pending. Child test success
  does not override the correctly failing parent receipt.

All original archives, raw colored/plain bytes, previous-reporter files and
diagnostics remain immutable. Do not rewrite the colored archive into a green
receipt or credit it as an accepted36-observation qualification.

Parent's completed attribution is retained in
`.tmp/6915-custody-repair/color-framing-attribution.json`, with raw archives in
`.tmp/6915-color-transport-evidence`. The failing input has38 parser errors,
one for each measured prefix. Diagnostic-only JSON recovery removing exactly
that observed transport prefix yields all36 complete observation graphs and
completion exactly equal to plain control run-enYXb9, with no graph-field
filtering. This comparison localizes the observed difference to transport; it
is not an accepted receipt or permission to normalize production parser input.
The original failed bytes remain rejected and retained. Original CI child raw
streams were not uploaded/retrieved: keep the public job log and installed-source
attribution distinct from this complete local controlled experiment.

#### Source-derived mechanism and minimal implementation

Installed Vitest `dist/chunks/index.VByaPkjc.js::onUserConsoleLog`, line369,
writes `c.gray(log.type + c.dim(headerWithNewline)) + log.content`. With color
enabled, closing dim/gray sequences occur after the header newline and before
the JSON. Installed tinyrainbow2.0.0 `dist/chunk-BVHSVHOK.js::C` checks the
presence of NO_COLOR before considering FORCE_COLOR, CI and terminal detection.
Setting FORCE_COLOR to the string `"0"` is NOT sufficient: its mere presence
enables the installed formatter in the absence of NO_COLOR. These installed
files are evidence only and must not be edited or replaced.

Exact proposed worker scope: `scripts/hooks/run-linear-append-provenance.mjs`,
the child environment construction inside `runAppendQualification` (line1169
at1a0584) and the existing embedded `selfTest`. Set child `NO_COLOR` to `"1"`
and delete child `FORCE_COLOR` after cloning the incoming environment. Apply
this before spawning pnpm so pnpm, Vitest and its fork inherit the same policy.
Deletion also avoids the contradictory FORCE_COLOR/NO_COLOR warning; it is not
warning suppression. Do not mutate `process.env` or the caller-supplied object.

If needed to test the actual production predicate without invoking the suite,
factor only this child-color policy into one small pure helper used by the
production spawn path and embedded controls. Preserve all existing child
environment construction, NODE_OPTIONS/local-manifest handling and expected
provenance logic; do not create a second environment builder in the tests.
CI identity validation still consumes genuine parent inputs unchanged.

No changes to `readRecords`, `decodeGraph`, receipt validators, strict prefix/
newline/truncation checks, approved command, execArgv or worker flags. Do not
strip ANSI, trim arbitrary prefixes, search past junk for a JSON opener, use
`--no-warnings`, suppress stderr, ignore unhandled errors or accept reporter
success in place of complete evidence. This is one formatter policy for this
child, not a global shell/workflow environment change. Source and semantic
test assertions remain byte-identical.

#### Finite controls and parent acceptance

Preserve all existing89 embedded controls. Add finite controls invoking the
same production color-policy helper, if extracted: missing color variables;
inherited FORCE_COLOR values `"0"` and `"1"`; inherited NO_COLOR values `""`
and `"1"`; CI present/absent; FORCE_TTY present/absent. A bounded representative
matrix is enough; do not introduce a generalized environment framework.
Every result must have own NO_COLOR=`"1"`, no own FORCE_COLOR, and otherwise
preserve input keys/values exactly, including CI/GITHUB identity, FORCE_TTY,
diagnostic/warning controls and unrelated sentinels. Input objects and actual
parent process.env must remain unchanged. Existing production rules governing
other variables are unchanged, not bypassed by this helper.

Exercise the unchanged real `readRecords` with a healthy complete envelope
control and rejecting variants: the measured `ESC[22m ESC[39m` prefix,
ordinary text prefix, and a truncated/unterminated envelope. Check its returned
errors and accepted population, not only whether it throws. Never normalize
the malformed test input before invoking the parser. Retain prior graph,
receipt, child-error and cleanup controls. Record actual new control counts
only after execution; this specification does not predict a passing total.

Parent serializes syntax/format/lightweight controls and real qualification.
Rerun the same genuine hook/parent path on the immutable candidate under the
previously failing incoming environment (`env -u NO_COLOR FORCE_COLOR=1`),
without changing approved source/test/fixture/config pins. Preserve exact outer
environment, executed runner bytes, HEAD and command as parent evidence. Require
strict parent exit0, child exit0, reporter36 passed/zero failed/skipped/todo,
38 complete unprefixed envelopes,36 unique passing observation records and
passing completion, Runtime22's33 transitions, all eight same-validator
negatives, genuine source joins and equal before/after custody. All36 full
observation graphs and completion must equal the retained qualified baseline
without filtering semantic/proof fields; actual provenance is recorded
separately. Preserve generated-report byte/hash custody unchanged.

The successful prior NO_COLOR=1 countercontrol remains separately retained;
it is not relabeled as candidate evidence. Preserve the failing colored run and
original required-CI failure. A successful local repair does not establish
required-CI success: parent must observe the subsequent actual required job.
No native admission, runtime performance, full IR acceptance, legacy retirement,
HOLD release or advisory-workflow release follows. Parent owns commits/pushes
and A retains final integration/queue authority.

#### Implemented transport policy and measured candidate

Sol6.1 Medium implemented only the child-color policy and its production
predicate controls. Parent reviewed the complete diff: readRecords/decoder/
receipt validators, CI identity, approved commands/worker flags and all input
pins remain unchanged.104 controls passed in worker and parent runs; malformed
prefixes, truncation and missing newlines remain rejected, not normalized.
Executed runner SHA256 is
`3a154510e5f1280cb7dc71f2a89bae77386ba109990fecb71d586531d9c75e54`.

Actual formerly failing invocation `env -u NO_COLOR FORCE_COLOR=1` plus the
independent parent manifest ran the unchanged changed-root hook at execution
HEAD1a0584/source tree953f74f8 with the pending runner patch. Parent and child
exit0; reporter36pass/0fail/0skip/0todo. All38 complete envelopes are unprefixed;
all36 complete observation graphs and completion exactly equal repaired-v3,
without filtering graph fields. Full input and generated-report custody is
equal before/after. This does not reclassify the original colored failure.

Raw countercontrol/failure/candidate streams, reporters, receipts, full graph
records, executed runner and offline replay are retained in
`plan/log/6915-linear-append-20261007/colorless-transport-20261008/`. The public
failed CI job log is separate from the locally observed colored raw input.
Subsequent actual required CI remains mandatory. The advisory caller's workflow
scope is still unreleased and no workflow/source/test/fixture edits were made.

### Adopted advisory command-only implementation release — 2026-10-08

The preceding historical unreleased records remain unchanged. A/root explicitly
released the command body in coordination comment6067224039 and reaffirmed
exclusive B editing in comment6068998929. Adopt in full the existing Astra High
"Owner-review proposal: advisory selected append caller" above, with this
explicit decision: retain the intentional push-event identity refusal. This
increment repairs supported PR/merge-group execution only; all-event acceptance
and durable CI archive upload remain unimplemented, unreleased dependencies.

Exact implementation claim `6915:advisory-parent-command-20261008`, owner
`ttraenkler/codex-linear-b-advisory-command-sol61-20261008`, write80796-adzysol8,
was effect-read at upstream ledger e4e7086b45. Branch is
`codex/6915-linear-append-plan-20261007`, starting at published
`9222d9a0342ea2828d3448e3d8828c5b329c293c`. Parent owns this issue/evidence;
Sol6.1 Medium owns ONLY `.github/workflows/ci.yml`, shell body of
`Run changed issue test file (advisory)`, id tests. No other workflow, selector,
runner, configuration, production, test or fixture edit is released.

The full prior run37826025179 is terminal SUCCESS. Actual quality job113478995304
and changed-root step48 passed; original failed jobs and all local epochs stay
preserved. At release readback #6593 remains HOLD, no auto-merge, mergeable/CLEAN,
with no merge-queue entry or unresolved review threads. No CI graph archive was
published, so terminal CI success is not separately inspected graph equality.

Current workflow bytes match canonical main845 before this edit. The held
`3518:runtime-preparation-ci-file-shards-20261002` record remains untouched;
the exact A-delegated command is not a release of shard, selector, manifest,
worker-budget or aggregate-policy custody. A expressly will not edit this
command concurrently; no other shared claim is transferred or completed.

Dispatch exactly the append filename to the existing parent once. Preserve the
complete original Vitest else argv, id/env/continue-on-error, manifest/ordinal
checks, cap15, pinned population, selector and raw outcome reporting. Parent
nonzero must remain the shell/step failure: no retry, spoof, skip, catch-and-pass
or successful trailing command. No new receipt validator or artifact uploader.

Before publication, static review must prove every byte outside the released
shell body is unchanged. Isolated lightweight controls must exercise the actual
extracted body: exact append, another file, near-match filenames and parent
nonzero, with exact command counts/argv/exit status. These are dispatch controls,
not production qualification. Retain all104 existing parent controls. Production
qualification uses the committed candidate and actual supported CI identities;
require the existing36-ID/38-envelope receipt, zero skip/fail/todo and unchanged
input custody. No input pin or local-edit exception is broadened. Parent reviews
and publishes through normal hooks; A retains integration/queue and HOLDs.

### Astra archive-transport plan and main-composition barrier — 2026-10-09

A's coordination comment6074098309 requests this specification and a normal
main merge, not permission to insert shared workflow uploaders or change runner
approval pins. Planning-only claim `6915:ci-archive-upload-plan-20261009` belongs
to `ttraenkler/codex-linear-b-archive-plan-astra-20261009`. Astra High specifies;
Sol6.1 at appropriate effort may implement only after explicit owner release.
Existing implementation claims and HOLDs remain unchanged.

The published predecessor is `6871907a4dbbe168512b7b9ce33500a61430e36c`.
Canonical main was freshly verified and fetched at
`616da017ca11cefa61f3f8d71a1c7ac18773491c`. Normal composition preserves both
histories. Its source tree is `2a8c200cbb4862b6ffdd5952be7f6fa8f9ce1e63`, whereas
the unchanged strict runner approves `953f74f80cf2f8085b8e1c93489fcdd357929b37`.
`assertFrozenInputs` therefore refuses the composed source tree before starting
the child. This is an approval barrier, not a measured compiler regression or
a completed 36-observation/38-envelope qualification. Do not repin automatically.
The directly pinned runtime/consumer/integration, test, fixture and execution
configurations remain unchanged; transitive allocation validation, analyses,
program DATA and inliner/effects changed. Unchanged leaf hashes do not prove
unchanged compiler observations. Preserve every original baseline and failure.

Proposed implementation scope is precisely two inserted steps in
`.github/workflows/ci.yml`: quality, immediately after the complete changed-root
test step and before required guards; advisory, immediately after `id: tests`
and before outcome reporting. Use existing `actions/upload-artifact@v6`, with
`always()` plus a nonempty `hashFiles('.tmp/6915-ci/run-*/**')` condition; advisory
also requires the exact append-test matrix filename. Upload only
`.tmp/6915-ci/run-*/`, with `include-hidden-files: true`,
`if-no-files-found: error`, `overwrite: false` and default retention. Names must
distinguish quality/advisory, run ID, attempt, and advisory matrix ordinal.
Preserve each run directory identity and partial failed archives. Never upload
the whole workspace, unrelated `.tmp` siblings, credentials or unrelated reports.
Missing archives remain unqualified and pre-archive failures retain job logs.

No commands, runner, permissions, selector, matrix, worker budget, assertions,
continue-on-error, reporting or guard changes belong to this upload slice.
Static review must show only those two insertions. Test exact action path
selection with healthy/partial failures, multiple run directories, hidden files
and unrelated siblings. Inspect downloaded actual CI bytes, not upload success:
retain expected.json, command.json, before.json, after.json, stdout.log,
stderr.log, reporter.json, graphs.ndjson, decoded.v8, diagnostics.json,
runner-errors.v8 and receipt.json, plus applicable boundary raw reports, previous
reporters and failure diagnostics. Do not discard extras to enforce twelve files.
Verify all 36 ordered complete graphs, 38 envelopes, Runtime22's 33 transitions,
eight same-validator negatives, reporter/completion and actual head/input custody.
Independently compare complete witnesses with the approved baseline, without
filtering changed proof fields. Seed archive transport alone is not equality.
The missing historical CI archive cannot be reconstructed or credited later.

Before composed-main child qualification, A must separately release a reviewed
source-compatible runner approval successor and its exact owned edit scope.
Preserve historical manifests unchanged; attribute any actual graph differences
before accepting a successor baseline. This plan grants neither native memory
admission, allocator/caller/resource ownership, performance acceptance, legacy
retirement nor queue submission. A retains shared integration and protected queue.
