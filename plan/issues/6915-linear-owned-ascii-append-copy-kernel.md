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


### Adopted full A-reviewed archive and approval-successor release — 2026-10-09

A explicitly released the following two disjoint scopes in coordination
comment6076669715 (updated 2026-10-09T07:41:57Z), against B head2f8ae6bd
and source tree2a8c200c. Parent verified the full specification:26593 UTF-8
bytes, SHA256 d6f6f6d4d6962dadc24be72059b10fa6ae3747740c60027cca49c20c51fff88c.
The full text below is adopted unchanged, including its acceptance limits.
Planning claim6915:adopt-reviewed-append-ci-plan-20261009 belongs to
 ttraenkler/codex-linear-b-reviewed-ci-plan-astra-20261009.
Implementation slices are separately reserved for archive transport and finite
source approval; their owners must effect-read canonical claims before editing.
No initializer import/native memory/allocator release follows. Parent reviews
both patches and freezes inputs before the one separately authorized trial.

# B append CI archive transport and current-source approval successor

Issue 6920 — Native Linear numeric-vector shared source handoff and integration plan. Related existing issue 6915 — Linear owned-ASCII append: optimize the existing copy kernel.

Codex GPT-6 Astra High, static review/specification only. ROOT adopts this complete document in issue6920 before any delegated implementation. No claim, branch, workflow, runner, shared source, test or fixture has been edited by this review. No compiler/test child, runner import, embedded self-test, fault window, commit, comment or publication was executed. Network operations only read exact published GitHub objects and already completed job logs.

## Recommendation and boundary

**Recommend releasing the two exact uploader insertions to B as one bounded transport implementation, independent of the runner approval task.** The proposed locations and narrow payload are compatible with the actual workflow and runner. A new uploader cannot recover the old missing CI artifact, prove full witness equality or turn an advisory test failure into a pass. Preserve ordinary required-quality failure and the separate advisory assertion policy.

**Recommend a separate, staged runner approval-successor implementation/qualification release**, limited to one named existing runner file and its embedded controls, with B's parent owning its issue/evidence. Retain the complete historical source approval and all other pins, add exactly the independently frozen current source tree as a qualification target, and require new actual full-witness comparison before accepting/publishing that source epoch. A direct replacement of `PINS.sourceTree`, automatic approval of actual HEAD, or acceptance on the unchanged three source-file hashes is not acceptable.

There is no static basis to declare current-main 36/38 equality yet. The complete tree contains real transitive compiler changes; qualification must be able to fail. The actual required CI failure is an approval refusal before the child, not evidence of a new compiler regression. Existing B/C HOLDs, allocator4540 ownership, native admission and ROOT's integration/protected queue authority remain unchanged.

## Exact inspected authorities

The requested coordination comment is [6076210344 on existing PR6583](https://github.com/loopdive/js2/pull/6583#issuecomment-6076210344), independently read with actual `updated_at` **2026-10-09T07:17:16Z**. It requests review/release; it does not itself transfer shared ownership.

Exact B PR6593 head: `2f8ae6bde384d9f182981c11b94f7230988caa42`. Git API commit data confirms parents `6871907a4dbbe168512b7b9ce33500a61430e36c` and canonical `616da017ca11cefa61f3f8d71a1c7ac18773491c`; full tree `5e727a2558ba73abca12ab0b28e15a3cc59a1f72`. Both B and canonical tree entries name complete `src` tree `2a8c200cbb4862b6ffdd5952be7f6fa8f9ce1e63`.

Read at that exact B head, independently Git-blob-hashed after retrieving full bytes:

| Path | Bytes | SHA256 | Git blob |
| --- | ---: | --- | --- |
| `plan/issues/6915-linear-owned-ascii-append-copy-kernel.md` | 88430 | `daf4fe258f6f3a1ebdf95b08e5b31406cc9de91a5346865857964a2426cb5d34` | `330c1a2cede32bdc18d38c16582b41a7a925b01c` |
| `.github/workflows/ci.yml` | 67634 | `7ca805dddf26b1312bd669abd4948715da65e1706afb41b1ee0dd5137d678bcf` | `5397cc513cf47858106f2365f25ed6203bcb0b22` |
| `scripts/hooks/run-linear-append-provenance.mjs` | 76845 | `3a154510e5f1280cb7dc71f2a89bae77386ba109990fecb71d586531d9c75e54` | `3a3e323c4d4d41f5761f4db8ed074d931e1e481d` |

The issue's final archive-transport section at lines1354–1410 is a planning proposal; its preceding exact releases matter. The existing advisory delegation covers only the shell body of `Run changed issue test file (advisory)`, not arbitrary additions to the job. The previous trusted-parent, generated-report and color-transport repairs retain their original release limits and all failed epochs.

Fresh read-only claim records:

| Record | Actual owner | State/write ID | Consequence |
| --- | --- | --- | --- |
| `6915` | `ttraenkler/codex-linear-b-append-scope-plan-20261007` | in-progress, `86113-5mk75ms4` | B parent allocation; not blanket shared-workflow authority |
| `6915:trusted-append-ci-20261008` | `ttraenkler/codex-linear-b-append-ci-sol61-20261008` | done, `96415-pkpzp33k` | old implementation claim is completed, not a fresh runner release |
| `6915:ci-archive-upload-plan-20261009` | `ttraenkler/codex-linear-b-archive-plan-astra-20261009` | done, `32285-cei5dhpe` | completed planning only |
| `6915:advisory-parent-command-20261008` | `ttraenkler/codex-linear-b-advisory-command-sol61-20261008` | in-progress, `80796-adzysol8` | existing exact advisory command remains reserved |
| `3518:runtime-preparation-ci-file-shards-20261002` | `ttraenkler/codex-runtime-preparation-ci-file-shards-20261002` | in-progress, `10279-io1vbvdv` | shared scheduling/shard/aggregate custody remains foreign |

ROOT retains claim60335 integration and final queue review. Before editing, B must publish and effect-read a fresh unique implementation slice and its named Sol owner for each of the following two disjoint scopes; this document does not allocate or complete a claim. ROOT's release must explicitly reserve the two inserted step regions and promise no concurrent edits there, while excluding the existing advisory shell and shared scheduling controls. A common workflow filename does not transfer either existing claim. The runner task likewise needs a fresh bounded runner owner, rather than reopening completed61584 work by inference. B parent retains issue6915 and evidence publication; ROOT retains issue6920 adoption/review. No old owner record is rewritten.

## Part A — exactly two inserted upload steps

Only file `.github/workflows/ci.yml` is implementation scope. Exact anchors at the inspected head:

1. Job `quality`: insert immediately after the entire `Changed root test files must pass (#3008)` step (lines617–636), and before `Required guard suite (#3552)` (line638). Do not edit the changed-root shell, its PR condition, eval environment, history fetch, test command or any required guard.
2. Job `issue-tests-changed`: insert immediately after the entire `Run changed issue test file (advisory)` step, `id: tests` (lines930–943), and before `Report changed issue-test outcome` (line945). Do not edit its `continue-on-error`, filename dispatch/else argv, matrix/ordinal validation, outcome reporting, aggregate policy or selector.

Concrete inserted steps:

```yaml
      - name: Archive Linear append parent evidence (quality)
        if: always() && hashFiles('.tmp/6915-ci/run-*/**') != ''
        uses: actions/upload-artifact@v6
        with:
          name: linear-append-quality-${{ github.run_id }}-${{ github.run_attempt }}
          path: .tmp/6915-ci/run-*/
          include-hidden-files: true
          if-no-files-found: error
          overwrite: false
```

```yaml
      - name: Archive Linear append parent evidence (advisory)
        if: always() && matrix.file == 'tests/issue-6915-linear-owned-ascii-append-copy-kernel.test.ts' && hashFiles('.tmp/6915-ci/run-*/**') != ''
        uses: actions/upload-artifact@v6
        with:
          name: linear-append-advisory-${{ github.run_id }}-${{ github.run_attempt }}-${{ matrix.ordinal }}
          path: .tmp/6915-ci/run-*/
          include-hidden-files: true
          if-no-files-found: error
          overwrite: false
```

Omit `retention-days`: use repository-configured default retention, exactly as the published proposal requires. This is expiring Actions storage; parent must inspect/download and retain needed complete evidence before its reported expiration, not describe the default as permanent custody. Record actual artifact ID, name, archive digest, run ID/attempt, job identity, exact checkout SHA and expiration at retrieval. Different job/name/attempt/ordinal identities prevent quality/advisory and rerun collisions; overwrite remains prohibited. No new job, permission, output, environment, compression policy, broad path or workflow framework is needed.

The [upload-artifact action documentation](https://github.com/actions/upload-artifact/tree/v6) establishes hidden-file opt-in, repository-default retention and preservation of the hierarchy after the first wildcard. The `run-*` directory identities must survive download. [GitHub's `hashFiles` documentation](https://docs.github.com/en/actions/reference/workflows-and-actions/expressions#hashfiles) establishes that unmatched files produce an empty string. The condition is only a presence trigger, not evidence authentication. Verify the actual action's path layout in the implementation controls; do not flatten multiple archives into one set of filenames.

Failure and custody behavior:

- The action is eligible after a failed test step because of `always()`, including partial archives. Do not require `success()`, `steps.tests.outcome == 'success'`, a `receipt.json` success marker or all twelve healthy files. Those filters would discard the failure evidence this change is intended to retain.
- Actual runner code creates a unique `run-*` directory, writes `expected.json` and `command.json`, then calls `assertFrozenInputs` before opening streams/spawning the child. The witnessed current-source refusal therefore can leave a meaningful partial archive containing expected/command, after-failure/errors/receipt, without reporter/graphs/stdout. Upload that directory intact. It is not a complete qualification.
- `readApprovedCheckout`, artifact setup or earlier job failures may occur before any archive exists. An empty glob makes the new step skip; the original failure and job logs remain authoritative and the missing archive stays unqualified. Do not manufacture empty healthy files or infer success from the skipped upload. Abrupt cancellation/runner loss can still prevent upload; `always()` is not a recovery guarantee.
- If the trigger observes files but the action subsequently finds none, `if-no-files-found: error` fails. Upload failure itself is an infrastructure failure; do not add `continue-on-error` or a trailing success command. Required-quality failure remains failure. The existing advisory *test* policy stays advisory, while inability to retain a requested existing artifact remains visible. The original outcome reporter still reports `steps.tests.outcome`.
- Upload only `.tmp/6915-ci/run-*/` descendants, including hidden descendants. Do not upload `.tmp/6915-ci/observations.json`, `runner.lock`, other `.tmp` siblings, the workspace, credentials or unrelated reports. The runner already keeps a prior reporter inside its own archive when appropriate; retain it there. Do not delete, rename, rewrite, reserialize or normalize archive payloads to make the upload succeed.
- For a completed healthy run retain expected/command/before/after, stdout/stderr, reporter, `graphs.ndjson`, `decoded.v8`, diagnostics, detached `runner-errors.v8` and receipt. Retain additional `previous-reporter.json`, boundary-report raw bytes and `after-failure.json` whenever present. Twelve healthy filenames are not an exact-membership rule that deletes legitimate additional failure/custody records.

Post-release finite transport controls must inspect the actual action-compatible selection/layout with a healthy archive, a partial failure archive, two distinct run directories, a hidden descendant, an unrelated sibling and an empty/no-archive case. Keep these inert temporary data fixtures out of the source/worktree/real evidence. A mock uploader or set of expected filenames alone is not evidence of downloaded action bytes. After the exact two-insertion diff is reviewed, a real future CI artifact must be downloaded and checked against its parent archive records. Do not rerun or rewrite the old completed CI job to pretend its missing artifact was recovered. No source qualification is needed merely to demonstrate preservation of a new truthful failed archive.

## Part B — finite source-compatible runner successor

### Actual blocker and complete source delta

The actual required job113711412922 at run37897284301 names the append test, prints `evidence retained at .../.tmp/6915-ci/run-4imC7Q`, then fails at `assertFrozenInputs`, runner line422, `6915 parent: unapproved source tree`. Both pre-run and finally custody checks retain that error, and changed-root exits1. I read the raw job log, not only the coordination summary. The inspected code places this check before child spawn. The advisory outcome remains separate; its reported green job is not a source-qualified child run.

Current runner constants pin the historical source tree `953f74f80cf2f8085b8e1c93489fcdd357929b37`, not current main. The complete recursively read trees are nontruncated: **1894 historical source blobs and1900 current source blobs**. There are exactly fifteen changed paths (nine modifications, six additions), not an unrestricted source difference:

```text
src/ir/analysis/alloc-verification.ts
src/ir/analysis/allocation-evidence/census.ts
src/ir/analysis/allocation-evidence/contracts.ts
src/ir/analysis/allocation-evidence/effect-rules.ts
src/ir/analysis/allocation-evidence/metadata.ts
src/ir/analysis/allocation-evidence/verify.ts
src/ir/analysis/contracts/allocations.ts
src/ir/analysis/effects.ts
src/ir/analysis/encoding.ts
src/ir/analysis/escape.ts
src/ir/analysis/ownership.ts
src/ir/passes/inline-small.ts
src/ir/program/allocation-body-validation.ts
src/ir/program/allocations.ts
src/ir/program/data.ts
```

The actual patches include allocation lookup/type contract reuse, extracted body/state validation, canonical vector ownership/escape/encoding rule calls, descriptor-only recursive-class screening, effect classification for dynamic ToNumber/loose equality, and slot remapping plus stricter attached-callee guards in the inliner. These are reached through transitive compiler behavior; unchanged runtime/consumer/integration bytes cannot prove all complete observations invariant. Neither this spec nor delivered main correctness establishes append witness equality.

Independent full-byte reads at B head match **all fourteen existing fixed inputs**: runtime, frozen-body consumer, Linear integration, c63 test, original string-hash fixture and all nine `CONFIG_PINS`. The complete source tree, not a manually narrowed dependency list or generated inventory verdict, supplies the transitive source boundary. Preserve the complete config-population equality check, all1900 current source Git-object/worktree comparisons, regular-file/symlink checks, source/test/fixture dirt refusal, exact generated-report exception and before/after snapshot equality. Do not approve only the fifteen changed files while ceasing to observe the other1885 current files.

### Implementation file/function scope

Only `scripts/hooks/run-linear-append-provenance.mjs` may change for this successor. Allow the literal approval section, `buildExpectedProvenance`, `assertIdentity`, `readApprovedCheckout`, the source-tree membership check in `assertFrozenInputs`, and narrowly related existing `selfTest` cases. B parent appends the adopted plan and subsequent evidence to existing issue6915; ROOT owns adoption in issue6920. No hook/YAML/test/fixture/source/decoder/witness validator/command/flag/config changes belong to this runner scope.

Keep the existing `APPROVAL_COMMIT` and entire `PINS` object as the historical immutable contract. Do not replace or rename the old source value into a supposedly current baseline. Add one explicit fixed successor record naming canonical commit `616da017ca11cefa61f3f8d71a1c7ac18773491c` and source tree `2a8c200cbb4862b6ffdd5952be7f6fa8f9ce1e63`, with this adopted review as its authority. The record is a finite execution-qualification target until the later acceptance steps complete. It is not a general registry, environment override, branch-name rule, ancestry wildcard or permission to accept future main trees.

The runtime acceptance predicate is exactly:

```text
actual committed HEAD:src is historical953f74 OR fixed current2a8c200c;
expected.sourceTree equals that actual committed tree;
all common runtime/test/fixture/config pins and the complete source population
still match committed Git objects and physical bytes, before AND after.
```

Unknown trees refuse before spawning the child. Missing Git objects/inspection failures refuse; never infer an empty or matching tree. A known HEAD descendant with the same complete source/test/fixture/config inputs may use the matching source contract, preserving the existing source-compatible behavior of docs-only publications and genuine PR/merge-group checkout commits. Do not require a synthetic PR-head identity instead of actual `GITHUB_SHA == HEAD`.

Use one shared narrow membership predicate, invoked by the real `assertFrozenInputs` path and the embedded controls. Change the signature to `buildExpectedProvenance(head, sourceTree = PINS.sourceTree)`, retaining the historical default only for existing historical controls. It emits the **same nine-field manifest** with unchanged common pins/command/flags and that observed source tree. Extend `assertIdentity` with the same final source-tree argument so its local exact-object comparison calls that one provenance builder; existing historical controls retain their default argument. `readApprovedCheckout` obtains actual HEAD and `HEAD:src` itself and passes both explicitly to identity validation and provenance construction. Neither `JS2WASM_APPEND_PARENT_MANIFEST`, child evidence, generated boundary report, branch name nor a command-line option selects/authorizes the source epoch. The local manifest is compared to the independently built exact nine-field expectation. Preserve the original local/CI identity modes, PR/merge-group-only rule, push refusal and rejection of local override in CI.

Keep actual approval enforcement at the original pre-spawn `assertFrozenInputs` barrier and preserve its archive/error path: build/archive the observed expected provenance, then independently require closed membership and equality there, before any source acceptance or spawn. Immediately before the existing actual-tree/equality check, invoke the membership predicate on `expected.sourceTree`. Merely including an observed unknown tree in an `expected.json` diagnostic does not authorize it; that independent fixed-membership guard rejects it while retaining the existing partial archive and finally diagnostics. There must be no code path that substitutes an arbitrary observed tree for approval and relies only on comparing it to itself. A wrong local manifest still fails the existing earlier identity comparison, just as before; it cannot override the fixed membership check in CI or local mode.

`assertFrozenInputs` still re-reads `HEAD:src` before and after the child and compares to the frozen expectation; it must not choose another allowed epoch at the after-snapshot. An old→new or new→old change mid-run is drift even though both are independently known targets. Keep every other custody predicate and all local `EDITABLE` paths byte-equivalent. In particular, a pending `.github/workflows/ci.yml` edit remains unauthorized for local qualification: isolate the runner-only trial or first commit the independently reviewed uploader. Do not add workflows or evidence directories to `EDITABLE` to make a combined dirty checkout pass.

Retain historical provenance inside `validateAppendReceipt`: original baseline commit `c41bca2bc07e9d8fddbb38ca77904dd1f0cac438` and baseline source `68296a0d34ceea94dbc9ca9398f71bc8a1b742b8` do not change. Actual current `head/sourceTree` fields will reflect the new epoch; historical baseline fields remain historical. The fixed c63 test is already parameterized for independently parent-supplied epochs; no test edit is needed. Preserve all104 old embedded controls and add finite controls of this exact production selection/membership path, without invoking the compiler in self-test mode.

Required new controls: accepted historical and exact current tree; unknown shape-valid tree; same direct-file pins with an unknown full tree; a local manifest swapping old/current source against actual checkout; missing/mismatched HEAD; CI local override; retained push refusal; and after-snapshot source switching between the two admitted trees. Retain source/config/test/fixture dirt, symlink, untracked/opaque-report, parser/descriptor/error/losslessness, color-transport and complete38/36 receipt controls. Controls must invoke the real predicates; do not duplicate approval logic inside a test-only mock. Report the actual new count only after execution. No old control is removed or relabeled.

### Original receipts and full-witness acceptance

The original archived `ci-trusted-parent-20261008/expected.json.gz` was read as data. It binds execution HEAD `0d2dfddb4b1145097210f5398e535e550f945f82`, historical tree953f74, all common pins and the exact4096-MiB strict pnpm argv. `receipt.json.gz` records code0, no signal/kill/spawn error/failures,44273883 output bytes,19733ms. Complete `before.json.gz` and `after.json.gz` are identical, with1908 observed files, Nodev22.23.2 and V8 `12.4.254.21-node.56`. These are original recorded results, not new executions.

I independently downloaded and Git-blob-verified the complete archived graph bytes, decoded **only inert JSON**, and compared them with the published repaired-v3 raw log. Both have38 envelopes. All36 ordered complete observation envelopes/graphs and the completion envelope/graph match exactly; only the separate execution-provenance record differs. No graph field was filtered. Trusted graph gzip blob `57d3060ac69f5fbd60d51916b8a94d179f16aa10` expands to44267645 bytes/SHA256 `bb1f7239ff371e6f373d3b45450a458f88c319a2d47b397b080681ce1d8f2b3e`. Repaired-v3 log gzip blob `c364eb251b5d3cdcf7bf63fab5cbc433484ab551` expands to44274012 bytes/SHA256 `e6f7eae8281d208da3e529ba6bcf19c5d9ad8b1853134edf498df198d2a51cb5`. This validates the retained comparison baseline's data identity, not the current compiler.

Before publication of the runner successor, ROOT/B parent must review the exact private diff and independently freeze the new execution manifest, all current source/config/test/fixture hashes and toolchain. Only then separately release one serialized current-main trial under the existing parent/changed-root route. No runtime is released by this specification itself. Use actual committed HEAD for the local manifest, current2a8 tree, the unchanged c63 test and genuine fixture, existing4096 worker flags and strict exit handling. Retain frozen candidate runner bytes separately from later publication commit identity.

Require all36 exact IDs, Runtime22's33 transitions, eight named same-positive-validator mutations with original/corrupted full evidence, source ownership/batch/completed consumer/module/body/defined-helper/call joins, complete artifact and memory bytes, all action/schema/emission channels passed, reporter36pass/0fail/0skip/0todo,38 complete envelopes, passing completion, strict parent and child exit0, and equal full before/after custody. Preserve Node/V8, actual command/flags, dependency lock/config population and complete transitive source files. Any toolchain difference from the old archive is explicitly recorded; it is not a license to erase graph differences.

Independently compare every complete new observation graph and completion graph against the fixed archived baseline. Keep provenance separate and validate its actual epoch/inputs. Do not strip source sites, metadata, body/slot tables, module identities, allocation evidence, error descriptors, undefined/NaN tags, Map/Set contents, buffer/view references, final binaries or negative-witness fields to manufacture equality. Do not replace a baseline with the new output merely because the36 tests passed. The ordinary runner's passing receipt is not itself this cross-epoch equality check; the separately reviewed comparison is mandatory before acceptance/publication.

If any full graph differs, preserve both complete values, exact graph/ID/path and the originating source delta. Stop the source-compatible acceptance. Distinguish an intended, independently reviewable changed compiler observation from a regression or a broken instrument; obtain a separate bounded plan if a successor baseline is actually necessary. This specification authorizes neither a new accepted baseline nor modification of the original instrument to hide a difference. If the trial fails before the child, record zero child observations rather than36 failures or36 passes; keep the new partial archive. Do not automatically retry or broaden the source contract.

After the full comparison and normal checks pass, publish only through the existing B PR6593 with ordinary hooks and reviewed scopes. Actual required-quality and advisory CI under supported identities must then run and their new uploaded archives must be retrieved, joined to exact checkout/run/job/attempt identity and inspected. Compare complete witnesses and receipts from downloaded bytes, not workflow conclusions. Push-event rejection remains an intentional documented boundary. No uploader or source selector change implies hold removal, native admission, append performance acceptance, old-failure erasure, full IR equality or queue submission.

## Review evidence and next ownership step

The reviewer-owned `.tmp/astra-6915-archive-review-data.json` is8078 bytes/SHA256 `a6954478c6202ad9b7ed17fcabd91584900fdd2c296d37b0e30fc9d1b93e0d68`. It catalogs the exact nontruncated old/current trees and fifteen-path delta, fourteen freshly verified current fixed pins, actual required-job log, original compressed receipts and full archived graph comparison. Files live only under this review lane's `.tmp/b-archive-review-data/`; they are read-only copies/evidence, not implementation or new baseline authorities.

ROOT can adopt/release PartA now as the named two-insertion proposal, with fresh claim/owner acknowledgment and postimplementation review. PartB can be separately released for private runner implementation and later serialized qualification, with acceptance explicitly held on new actual full-witness results. Neither completed archive-plan claim nor the pre-existing advisory-shell claim substitutes for that release. All original missing archives and failed CI epochs remain missing/failed in their historical records. All B/shared source files and claims remain untouched by this review.

### B implementation checkpoint — 2026-10-09

The full normative contract is now published in A's PR #6602 at exact commit
`89c5974b0f435cf0212fe0af65cc2750b68cd225`; its SHA256 is the unchanged
`d6f6f6d4d6962dadc24be72059b10fa6ae3747740c60027cca49c20c51fff88c`.
B adopted it at `5bbbabe13d077a2a2b4fbb0891da7674bfc37203` before source
authoring. Fresh canonical upstream slice claims separate the two writers:
`6915:archive-transport-implementation-20261009` (Sol 6.1 Medium) and
`6915:finite-source-approval-successor-20261009` (Sol 6.1 High).

The private runner commit is `c06afb13f9e62a2b091236bc5698ee925f43c9e5`,
based on that adoption commit, with the runner as its sole tracked edit.
Its 128 embedded controls passed in both the implementer's execution and
the parent repetition: all original 104 remain, with 24 added. Normal fast
commit hooks, syntax and formatting passed. The private candidate runner is
83848 bytes/SHA256 `b6106b0ef3b686bb67d713cf6133d3235a5c4c29666fa889680b531193263e77`.
The implementer's exact reverse-edit proof recovers the original 76845-byte
runner/SHA256 `3a154510e5f1280cb7dc71f2a89bae77386ba109990fecb71d586531d9c75e54`.
Independent Astra diff review remains required before integration or trial.

The uploader is separately implemented but not yet committed or accepted.
Its finite selection/layout controls must use the official action rather
than a mock. An isolated download into the writer's own ignored `.tmp` is
authorized; shared dependencies, package files and locks remain unchanged.
Actual uploaded CI archives remain unexecuted and must subsequently be
retrieved and inspected, including partial-failure archives.

The parent full-evidence comparator now has 62 passing noncompiler controls.
It retains exact comparison of every complete observation/completion graph,
independently validates provenance against the parent freeze and all fourteen
fixed paths, joins recovered raw-stream envelopes to archived graph bytes,
and uses the existing reviewed decoder/receipt validator only after verifying
the imported runner's byte hash. Historical/current provenance substitution,
nested graph mutations, altered worker flags, missing/mismatched configuration
pins and prefixed/raw-graph disagreement are rejected. Astra identified the
raw-stream, complete-freeze and parent-versus-child-exit gaps; these have been
addressed locally and await final independent review. A child receipt alone
never proves parent exit success; the actual parent terminal status must be
retained separately.

No compiler trial, accepted current-source equality, push, CI rerun, hold
removal, native admission, performance acceptance or migration completion is
claimed by this checkpoint. C's geometry PR #6600 is verified merged on main
as `2d0c31a3e2dbe0a4a46d123226fa1d62f7d4c7aa`; that delivery does not broaden
the finite 616da source approval or release additional shared ownership.

### Reviewed single-trial result — 2026-10-09

Both private implementations are integrated, preserving their original commits:
runner `c06afb13f9e62a2b091236bc5698ee925f43c9e5`, uploader
`a8441b41d534596e96df3c7c2b51582dc042a1c9`. Astra independently cleared
the runner's bounded diff and the strengthened full comparison. Parent repeated
all six official uploader selection/layout controls and all128 runner controls.
The committed execution head is `a7a337714c77f7b5779e028055feb220adaf7c24`;
source2a8c200c and all fixed pins remain unchanged.

After freezing 1900 source files and all additional inputs, parent released
exactly one serialized trial. Actual parent terminal exit0; child exit0, no
signal/kill/spawn error/failures, 16614ms. Reporter36pass/0fail/0pending/0todo.
The independent comparator exited0: all36 complete ordered observation graphs
plus completion exactly equal the original trusted archive,38 envelopes, no
filtered fields, all provenance/raw-stream/input joins validated, and complete
before/after custody equal. Full witnesses, failures, original archives and
baseline remain intact. No retry or successor baseline was used.

Raw evidence, independent freeze and terminal record are retained in
`plan/log/6915-linear-append-20261007/current-source-20261009/`. This is bounded
append source-successor qualification, not native completion or performance
acceptance. New required-quality/advisory CI artifacts must still be retrieved
and inspected after normal publication through existing PR6593. HOLD remains;
A retains final integration and queue. No other source approval is implied.

### Actual downloaded CI archives: geometry source refusal — 2026-10-09

Run37904506861/attempt1 on published a672175bea executed actual synthetic
checkout `340fcf4da0bad7ca8ff02132a638f98685dfcf3a`. Its parents independently
match canonical b47c6e4 and B a672175; source tree is
`171606514a3cf6733e82eb11549a659856d68c1a`, outside the deliberately finite
approved set. Both required-quality113734609514 and selected-advisory113735341401
preserve parent refusal before spawn, zero child observations. Quality failed;
advisory wrapper green is not acceptance. No automatic repin or rerun occurred.

Both new uploader steps succeeded. Actual artifacts11603409132/11603983003 were
downloaded; each2754-byte ZIP digest matches GitHub and parent rehash. Five
partial files retain their distinct run-hdoGoC/run-8EvXZ2 paths. Full metadata,
ZIPs, raw logs and extracted evidence are retained under
`plan/log/6915-linear-append-20261007/ci-current-geometry-20261009/`.
Expiry is2027-01-07T08:22:00Z, not permanent retention. This proves actual
partial-failure archive transport, not full passing CI receipt equality.

The next dependency is A's separately reviewed exact geometry-source approval
contract and bounded qualification authority. Original failed CI epochs remain
failed; the tested local2a8 result is not relabeled as newer-main equivalence.
HOLD, native/performance/equivalence limitations and A queue ownership remain.

## Adopted A third-source implementation contract — 2026-10-09
### Pre-trial termination blocker and proposed Astra release plan

Independent Astra High review found no explicit test-termination authority in
either adopted normative contract. The unchanged `runAppendQualification`
handler sends SIGKILL on timeout, output fault/cap and forwarded signals.
Preserving the handler is an edit restriction, not termination permission.
The geometry diff remains cleared, but its runtime trial is held. No handler
edit is authorized by the geometry release; request this narrow scope from A.

Proposed implementation plan, not yet released:

- Original authenticated runner owner alone may change
  `runAppendQualification` termination/fault handling and corresponding inert
  `selfTest` controls, after A releases that exact scope and a fresh serialized
  continuation claim is effect-read. No competing writer or takeover.
- Replace automatic child/group termination with a monotonic infrastructure
  failure latch and immediate parent notification. Timeout must keep capturing
  and draining until actual closure, without automatically killing the child.
- On cap/write failure, retain captured bytes, explicitly record incomplete
  capture, and continue draining without unbounded buffering.
- Do not forward SIGINT/SIGTERM as child termination without explicit user
  authority. Retain lock and open captures until closure; no early finalization
  or automatic retry. A latched fault prevents success even after child exit0.
- Keep `killed` truthful and preserve primary/subsequent errors. All source and
  config pins, identities, command/worker flags, parser, witness validators and
  complete original baseline bytes remain fixed.
- Finite inert controls must exercise normal completion, timeout, cap, write
  failure, signal notification, continued draining, refusal to finalize a live
  child, secondary-error retention and zero termination calls.
- After released implementation and exact review, freeze the new runner hash
  and explicitly update the comparator binding; parent separately authorizes
  one trial. No trial or source qualification follows from this proposal.

The geometry comparator is separately cleared: only three literal changes
from the published current-source instrument, one runner hash and two source
tree literals. SHA256
`03a5a9752ce408297adc87581dae6a2955755e8d901ccd29703f4692ace2bfcc`.
Parent and Astra independently ran62/62 inert controls, exit0. Reversing these
substitutions restores all predecessor bytes; complete graphs1–37 remain
unfiltered, with full graph0, raw-stream and custody validation.
Normal main composition `55ac3dfef2402390e3fd844b18237c4eb582a879`
has exactly released source `171606514a3cf6733e82eb11549a659856d68c1a`.
No third-target child has run, and failed CI epochs are unchanged.

Private implementation checkpoint:
`e33560ce57c5912fd75cc36c7156b1037828416e`, original authenticated Sol6.1
runner owner, continuation write `33193-a04x7qa7`. Sole runner change is87264
bytes, SHA256
`aefbb190424ca7d9b22ebf11640662f63ff5917bd16553f6a909fcccda65cf3d`.
Independent Astra High static review cleared the exact bounded diff. Parent
repeated159/159 inert controls (128 retained,31 added), exit0, and independently
recovered every predecessor byte with SHA256
`b6106b0ef3b686bb67d713cf6133d3235a5c4c29666fa889680b531193263e77`.
The patch is privately integrated; no third-target compiler child has run.
Committed composition, independent complete input freeze, separate one-trial
authorization and full original-baseline comparison remain outstanding.
This review is not runtime equality, source admission, CI or main delivery.


Session A release6077817777 and publication6077956780 were independently
verified against PR6603 HEAD `1cb483b27c7dc2361871939ecf64218cccfb9a86`.
The complete normative specification below is31726 UTF-8 bytes, SHA256
`aa04bdb08792e0dc6db4007462bf982456335068b9dcb75e5f668402af511c58`.
Its historical review snapshots are not current PR-head claims. This adoption
permits only the released private implementation after original-writer
acknowledgement and a fresh effect-read continuation claim. No trial, baseline
replacement, initializer takeover, HOLD removal or queue action is authorized.

# B append qualification: one additional fixed geometry source target

Issue 6920 — Native Linear numeric-vector shared source handoff and integration plan. Related issue 6915 — Linear owned-ASCII append: optimize the existing copy kernel. This is an independent static review and complete bounded implementation proposal for ROOT adoption. It is not a release, source qualification, permission to execute a child, or permission to remove a hold.

## Decision

Recommend that ROOT separately release private implementation of one additional literal source target in the existing append provenance runner, followed by exact patch review, independent committed-input freezing, and then a separately authorized single serialized qualification. The new target is the delivered geometry source tree `171606514a3cf6733e82eb11549a659856d68c1a`, anchored to canonical geometry merge `2d0c31a3e2dbe0a4a46d123226fa1d62f7d4c7aa`. Preserve historical tree `953f74f80cf2f8085b8e1c93489fcdd357929b37`, the existing fixed successor `2a8c200cbb4862b6ffdd5952be7f6fa8f9ce1e63`, every fixed pin and the original complete baseline.

There is now actual evidence of the third-tree CI refusal, not merely a prediction. Both newly downloaded Actions archives retain the intended pre-child failure. Archive transport is demonstrated for these two partial runs. Neither run contains any child observation or qualifies the third source tree. Required quality remains failed; the advisory job's success is a job policy outcome and does not make the failed test command successful.

Static evidence supports this narrowly staged implementation: the complete source delta is exactly the three geometry paths, with the allocation/facts body unchanged and the moved geometry functions preserved. It does not prove the 36 complete append graphs remain equal under the changed module graph. Acceptance must remain held until that exact comparison is measured. ROOT owns integration and queue; B parent owns append implementation and evidence. All previous missing/failed epochs and B holds remain.

## Inspected authorities and exact identities

The preceding complete normative contract was retrieved from Git blob `70fdc325dbae097c6f6091dc116410efbb4db1e6` at canonical `bb58c562545e4bd08310ab2bfc41bbd88679d958`, path `plan/log/6920-b-ci-contract-release-20261009.spec.txt`: 26,593 bytes, SHA256 `d6f6f6d4d6962dadc24be72059b10fa6ae3747740c60027cca49c20c51fff88c`. This document adds a bounded third target to that contract; it does not supersede its custody, transport or full-witness requirements.

ROOT release comment `6076669715` and B checkpoint comment `6077251918` were read from existing PR6583. The latter was actually updated at `2026-10-09T08:23:16Z`. B PR6593, **fix(ci): preserve trusted Linear append regression custody**, remains open on exact head `a672175beaa11520bc953d844648ecf6e53475c4`, with `hold`. Its full tree is `7962fee876df69522826b1940f1a5f942d2876af`; source tree remains the released 2a8 target. Its parent is trial/evidence execution checkpoint `a7a337714c77f7b5779e028055feb220adaf7c24`.

At the canonical-main read, `main` was `bb58c562545e4bd08310ab2bfc41bbd88679d958`, full tree `289da1e9d5e8dfc6ae6a2942e44c106e6bfb4b0e`, source 1716. The geometry merge `2d0c31a3e2dbe0a4a46d123226fa1d62f7d4c7aa` has parents `616da017ca11cefa61f3f8d71a1c7ac18773491c` and reviewed C head `e8f56680589752d67c83ce80cbb43b1bebf1f056`; its full tree `e9fdf1f42f3b88377cf0565f5ed06554916c4e37` is exactly the C head's full tree. The server-side comparison from geometry merge to inspected main is ahead 5, behind 0. Current main and geometry merge both name source 1716. These are actual tree/ancestry reads, not inference from a PR title.

Actual B CI checkout is synthetic PR commit `340fcf4da0bad7ca8ff02132a638f98685dfcf3a`, full tree `8fa98936536171e64c8013fe09baa9de360ed308`, parents `b47c6e4b9d64ce848407a80a03a063fb102ffe8b` and B head `a672175beaa11520bc953d844648ecf6e53475c4`. Its complete source tree is 1716. Both job logs show that exact fetch/checkout, both archives independently name it, and Git API commit/tree reads agree. Do not substitute the B branch head for this executed checkout.

## Complete source boundary and semantic review

Both recursively retrieved source trees explicitly report `truncated: false`. Independently reconstructing all 59 directory-tree objects from Git's tree encoding reproduces both complete source tree IDs. Old tree has 1,900 regular source blobs; new tree has 1,901. Exactly two modifications and one addition exist; all other 1,898 source blob identities and modes are unchanged.

| Path | Old Git blob | New Git blob |
| --- | --- | --- |
| `src/ir/analysis/linear-memory-plan.ts` | `a44148b86cf60d75a8ebcd9decd2f0fc3a5aad1c` | `3db990eb21e3ed216cd798548af6d076e32ed9e1` |
| `src/ir/analysis/contracts/linear-memory-layout.ts` | `280a72ab47f43584f93efb664e3e64b55dc896b5` | `0dd2108962236a64e2b96479309b5b1e9735c90e` |
| `src/shared/contracts/linear-memory-layout.ts` | absent | `59450b9ad09d7ebf16af04a8a1ab655a5c81b0ee` |

The exact complete bytes of all five old/new blobs were downloaded and Git-blob-hashed. New planner: 45,359 bytes, SHA256 `08f844117ef1b6e0eb17a87555d00db5be89257e5817ad76322320fa837ae7fc`; new IR contracts: 3,161 bytes, SHA256 `83e6b8a07bdc8e8b93fed590bc0aed5c5f779bde98466e9cbbe3feb7a825cb91`; new neutral shared contract: 7,580 bytes, SHA256 `08c85d9e8c9891a74b9c0c02a1310b67b16832980849dc0e7b6d511d91350937`.

This is a source-function review, not a constants-only argument:

1. `storageBytes`, `storageAlignment`, `planLinearRecordLayout`, `linearStringLayoutId`, and `planLinearStringLayout` are byte-identical function declarations moved from the old planner into the shared owner. The eight storage widths remain 1/2/4/8/4/8/16/4 for i8/i16/i32/i64/f32/f64/bytes16/pointer. Records keep ordered eight-byte slots, fixed-pointer offsets in field order, alignment 8 and header 8; notably the pre-existing bytes16 field still occupies an eight-byte slot while its own alignment is 16. This review does not silently “repair” that existing contract. String layout keeps UTF-8 identity, no pointers, length 8/elements 12, payload prefix 4 and fresh returned objects.
2. `planLinearVectorLayout` still calls unchanged `linearStorageForIrType(element)` first. For `kind === "val"`, new `planLinearScalarVectorLayout(storage)` delegates to `planLinearVectorStorageLayout(linearScalarStorageKey(storage), storage)`. That key is exactly the old `scalar:${storage}`. For non-val types, it passes the unchanged `linearIrTypeKey(element)` to the shared storage-level constructor. The latter reproduces the complete old vector object: identity `vector:${elementKey}`, maximum record/storage alignment, element-sized plan with base 16 and minimum 16, length/capacity/elements 8/12/16, matching stride and pointer classification, and fresh `fixedOffsets` array. There is no caching or freezing of returned layouts.
3. `linearVectorLayoutId` wraps the same IR semantic key with the extracted `vector:${elementKey}` helper. `linearIrTypeKey` changes only its val branch to the same extracted `scalar:${storage}` helper. Its support-ref refusal, string/nested-vector nullability/object field order/nominal class/boxed/dynamic/closure identities remain intact. Non-val pointer types are not collapsed into `vector:scalar:pointer`. Support refs still throw before any vector result.
4. All 36 other planner function declarations compare byte-for-byte, including `prepareLinearAllocationFacts`, `verifyLinearPreparedAllocationFacts`, `planLinearMemoryFromFrozenFacts`, `planLinearMemory`, `verifyRegistrySnapshot`, allocation-size/layout selection, canonical site/index checks, metadata access, detached equality, interning, module collection, global storage, lifetime and allocator selection. The continuous region from `export interface LinearOpaqueLayoutPlan` through the complete allocation/facts/planning body before the extracted geometry functions also compares byte-for-byte. Allocation policy objects and frozen-facts validation were not rewritten.
5. IR contract changes move/re-export the storage/layout types through type-only imports/exports. Allocation ownership/escape/encoding and runtime-operation contracts remain in IR. The new shared source has no value or type imports. Planner compatibility exports preserve the five actual shared function bindings and the one frozen forwarding object, with the same forwarding tag/header/pointer fields. The import graph changes, so unchanged function bytes remain a bounded static compatibility argument, not runtime proof.

The delivered G24 test source was read completely from Git blob `8a2cf8e0e411b19cbcfcf2b2350e7cada559092d`. Its 24 cases use independent ABI literals, cover all scalar storages, string/nested/object/class/boxed/dynamic/closure identities and support refusal, empty/mixed/wide records, string geometry, public compatibility binding identity, fresh mutable nested layouts, the one frozen forwarding object with physical bytes, genuine nonempty source ownership/delegation, and parser-positive forbidden value/type imports. These are materially stronger than checking the constants. This review did not execute G24. ROOT's delivered-C record of G24 and the merge-group gates is supporting prior evidence, not a newly claimed run, and cannot replace the append trial.

The out-of-src boundary-policy delta was independently downloaded and read: `scripts/compiler-boundaries.json` adds the single shared leaf to foundation membership, advances that layer's minModules 9→10, and adds its one clean/foundation inventory row. No other policy delta appears between B's old canonical composition and the geometry delivery. That file is not one of the runner's nine execution config pins. Do not add it as an excuse to broaden accepted source/config populations, change a generated-report exception, or grant arbitrary policy trust. The existing policy-gate and generated-report custody contracts remain separate.

## Fixed inputs and population custody

All fourteen fixed inputs were independently fetched as complete Git blobs from the **actual synthetic checkout**, with both Git blob and SHA256 verified against published runner constants. Nine of the fourteen are `CONFIG_PINS`; they are not nine extra paths beyond fourteen.

- Runtime `src/codegen-linear/runtime.ts`: `2a562751f9e2c6291944836681b3bc99b402c2d154a88c429ee16013eaf09e0f`.
- Frozen consumer `src/ir/backend/frozen-body-consumer.ts`: `262d9866247af2e2fa18a6f8dbdf9d4a07c37c6ae188eb491a312949e6c60404`.
- Integration `src/ir/backend/linear-integration.ts`: `8bcc7d6507cb6abd1c4333e43fe5fef015f6649dd788221778aa61e6911c1571`.
- Unchanged append test: `c63e83104b42104c0ea9e7d5d3fb3f6f2cce960a65973cbf342698e8e79d7f8d`.
- Genuine string-hash fixture: `66a15148fdd960dcbe5d87c25a28d870e8db9d00865483d708f0ca4e6e6e335c`.
- `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `scripts/test262-concurrency.mjs`, `tsconfig.json`, `tsconfig.ts7.json`, `vite.config.lib.ts`, `vite.config.ts`, `vitest.config.ts`: all nine exact existing CONFIG_PINS, fully enumerated with hashes and Git blobs in the attached review data.

All fourteen match B head and synthetic CI checkout. The other thirteen also match the geometry merge and inspected canonical main. The append test itself is present only on B and the synthetic composition, not yet canonical main. Do not describe the missing canonical test as a pin match or try to qualify a bare canonical checkout that lacks it. The qualification checkout must contain B's published frozen test and runner composed with the delivered source 1716.

The runtime custody loop must keep every one of the 1,901 committed source files, verifying physical regular files against committed Git bytes before and after. The shared leaf is added to the observed source population automatically by the existing complete `ls-tree` loop. Do not replace that loop with three path checks, a dependency guess, a count-only guard or a hand-maintained geometry inventory. Preserve source symlink/mode refusal, source/test/fixture dirt checks, complete execution-config population equality, local edit allowlist, generated-report exception and exact before/after equality. Every new freeze must print actual denominator and file inventory. The previous 1,900-source trial recorded 1,914 custody paths; with identical additional-path population, the third target has 1,915. Counts support the complete path-set check; do not hardcode 1,915 while dropping a different input.

## Actual archive evidence and current blocker

Run `37904506861`, attempt 1, event pull_request, B head a672175. Job log and downloaded archive identities are joined to synthetic checkout340fc and source1716:

| Scope | Job ID/outcome | Artifact ID/name | ZIP SHA256 |
| --- | --- | --- | --- |
| Required quality | `113734609514`, failure | `11603409132`, `linear-append-quality-37904506861-1` | `c2c3e4971d36cda51bc55bca1a7c872f7f9009d1d2874fa5e6c606608d0d40aa` |
| Advisory ordinal 1 append test | `113735341401`, success job / exit1 test step | `11603983003`, `linear-append-advisory-37904506861-1-1` | `7eb9c3922ab6a31d3b0eb31f9f3e82ed6f491d980ea9535199a32d1e4cdb3c7e` |

Both actual ZIPs are 2,754 bytes and match GitHub's archive digest. They were downloaded and inspected without extracting or executing embedded code. Quality retains directory `run-hdoGoC`; advisory retains `run-8EvXZ2`. Each contains exactly five actual files: `command.json`, `expected.json`, `after-failure.json`, `receipt.json`, `runner-errors.v8`. The v8 file was hashed and retained as opaque bytes, never deserialized. There is no stdout, stderr, reporter, graph, decoded witness or complete before snapshot in either archive.

Both expected records have the unchanged nine-field manifest with source1716 and actual340fc HEAD. Both receipts have code null, signal null, killed false, bytes0, elapsedMs0, spawnError null, and two retained errors: original pre-spawn membership refusal and the finally custody refusal. `after-failure.json` also names `unapproved source tree`. The exact published runner places `assertApprovedSourceTree` before physical source checks and child spawn. **Measured third-target results: zero child observations, zero envelopes; not 36 failed tests and not 36 passing tests.** Required changed-root command exited1. Advisory command exited1 under existing continue-on-error behavior, then its uploader succeeded.

Quality artifact created `2026-10-09T08:32:56Z`; advisory created `2026-10-09T08:24:47Z`. Both reported expiration `2027-01-07T08:22:00Z`. Record these expiring-storage identities and retain the downloaded raw bytes with failure history. Do not rerun either historical job to replace it, flatten the run directories, rewrite expected/receipt records or manufacture missing healthy files. This review's copies are under the private review directory; B parent should publish its own custody adoption in the existing evidence area.

At the run snapshot several unrelated test shards were still running. This report does not claim overall run completion. The two named jobs and their specific upload steps were completed and their logs/artifact bytes were available. No polling loop, rerun, cancellation, queue action or status mutation was performed.

## Independent check of the already qualified two-tree epoch

The published current-source archive and fixed older baseline were downloaded as Git blobs. Original trusted graph stream expands to 44,267,645 bytes, SHA256 `bb1f7239ff371e6f373d3b45450a458f88c319a2d47b397b080681ce1d8f2b3e`; the 2a8 current-source stream expands to the same byte count, SHA256 `4ee28d5503aebb5fa83afe0e1d9a792f86c0f81cdefcbe74e50caa1bba4cd094`.

Both contain exactly 38 complete envelopes. The complete ordered 36 observation envelopes and completion envelope are byte-identical line by line, and complete JSON comparison agrees. No graph field, descriptor, metadata, buffer, witness or binary was removed. Only graph0 provenance differs. Its inert JSON descriptor records were joined to actual expected/freeze/before/after head a7a337, source2a8, Node `v22.23.2`, V8 `12.4.254.21-node.56`, common fixed inputs, command, effective flags, fixed 36-ID population and historical baseline/source. All38 complete envelopes recovered independently from raw stdout/stderr equal the archived graph stream. Before/after complete bytes match, both file maps equal the independent freeze's 1,914 paths, and all fourteen fixed input hashes join.

Published receipt records actual child exit0, no signal/kill/spawn error/failures, 44,273,881 output bytes and elapsed16,614ms. Reporter is36 total/36 passed/0 failed/0 pending/0 todo. Separate published parent-terminal record names parent exit0 and the one actual trial. Frozen runner bytes match published a672 runner exactly: SHA256 `b6106b0ef3b686bb67d713cf6133d3235a5c4c29666fa889680b531193263e77`, Git blob `18a055272a34195e091a601ce6fe003f9c072c61`. The current comparator was read as source only; this review did not import it or the runner or deserialize any v8 payload. These independent archived-data checks establish the retained two-tree epoch's full-data equality. They give **no third-tree runtime credit**.

## Ownership and implementation scope

Fresh canonical claim-tree read was nontruncated. Relevant actual records:

| Slice | Actual owner | State/write ID |
| --- | --- | --- |
| `6915` | `ttraenkler/codex-linear-b-append-scope-plan-20261007` | in-progress / `86113-5mk75ms4` |
| `6915:finite-source-approval-successor-20261009` | `ttraenkler/codex-linear-b-source-approval-sol61-20261009` | in-progress / `62837-vw2me2ho` |
| `6915:archive-transport-implementation-20261009` | `ttraenkler/codex-linear-b-archive-transport-sol61-20261009` | in-progress / `62946-3169olpj` |
| `6915:advisory-parent-command-20261008` | `ttraenkler/codex-linear-b-advisory-command-sol61-20261008` | in-progress / `80796-adzysol8` |
| `6915:adopt-reviewed-append-ci-plan-20261009` | `ttraenkler/codex-linear-b-reviewed-ci-plan-astra-20261009` | in-progress / `62842-atpyalla` |
| `6915:trusted-append-ci-20261008` | `ttraenkler/codex-linear-b-append-ci-sol61-20261008` | done / `96415-pkpzp33k` |

Prefer continuation by the **same existing Sol6.1 runner owner**, preserving its context. The current claim alone covers the earlier released successor; it is not self-authorization for a third source. Before edits, ROOT adopts this full plan in issue6920 and explicitly releases its exact scope; B parent adopts the full plan in issue6915, obtains the existing runner owner's acknowledgement, and publishes/effect-reads a fresh unique continuation slice such as `6915:geometry-source-approval-20261009` with that same named Sol owner. This does not permit two simultaneous runner writers merely because the slice keys differ. B parent must serialize the old and continuation scopes. Do not force, release or complete any foreign/old claim. If the existing owner is unavailable, ROOT/B must reconcile the owner explicitly before choosing a replacement; a new claim is not a collision bypass.

Only implementation file: `scripts/hooks/run-linear-append-provenance.mjs`. Permitted edit regions are the literal approval definitions, `assertApprovedSourceTree`, and directly corresponding cases inside `selfTest`. The earlier implementation already parameterizes `buildExpectedProvenance`, `assertIdentity` and `readApprovedCheckout` correctly and already calls the membership predicate in `assertFrozenInputs`; those functions need **no change** for the third target. Their exact existing behavior must be reviewed/preserved, not gratuitously refactored. No decoder, receipt validator, source, test, fixture, config, workflow, changed-root hook, uploader, reporter parser, command/flags, `EDITABLE`, archival code or generated-report handling edits belong to this release.

B parent owns appended issue6915 adoption/evidence; ROOT owns issue6920 adoption and final review. The prior uploader and advisory-shell owners retain their regions. Native facts, source caller, initializer import, allocator4540 and ROOT's canonical C1 loader/cold-capture work remain wholly outside this task. This review has written only its fresh private review directory and has not mutated any source, repository worktree, claim, branch, PR, hold, comment or queue.

## Exact finite implementation contract

Keep `APPROVAL_COMMIT`, every key/value of `PINS`, and the complete `SOURCE_APPROVAL_SUCCESSOR` record unchanged. Add one separate explicit literal record, recommended spelling:

```js
// ROOT-reviewed geometry extraction; a finite qualification target only.
const SOURCE_APPROVAL_GEOMETRY = {
  commit: "2d0c31a3e2dbe0a4a46d123226fa1d62f7d4c7aa",
  sourceTree: "171606514a3cf6733e82eb11549a659856d68c1a",
};
```

The record's commit is provenance for the independently reviewed source, not a requirement to execute that exact historical commit. Actual execution is on an independently frozen committed composition containing B's frozen test. Extend the existing production predicate by exactly one disjunction:

```js
sourceTree === PINS.sourceTree ||
sourceTree === SOURCE_APPROVAL_SUCCESSOR.sourceTree ||
sourceTree === SOURCE_APPROVAL_GEOMETRY.sourceTree
```

Keep the same `unapproved source tree` failure and barrier location. Three literal trees are the entire allowed domain. No table populated from files, environment, branch, manifest, current main, ancestry, output or generated inventory; no `.includes(actualTree)` construction that implicitly learns the current tree. No replacement of old constants, registry abstraction, runtime override, source path exceptions or automatic future-main admission.

`readApprovedCheckout` must still obtain actual HEAD and `HEAD:src` from Git. Local exact nine-field manifest is only an independently checked assertion of that actual checkout; it cannot authorize an unknown tree. CI still accepts only real GitHub pull_request/merge_group identities, requires actual HEAD equal GITHUB_SHA and rejects any local override. Push and generic CI remain refused. Unknown source can appear in archived `expected.json` for diagnostics but independently fails the fixed-membership predicate before child execution.

`assertFrozenInputs` must still pin the original actual HEAD and expected source at the start and re-read both after the child. Moving among any two of the three admitted trees mid-run is drift, not permission to reselect a target. All snapshots, full source observations, pins and Git-object/physical-byte checks remain. Missing objects, missing HEAD/src, unknown trees and inspection failures fail closed. A docs-only or synthetic descendant with exactly one approved source tree and all common inputs may retain current source-compatible execution behavior, but ancestry alone authorizes nothing.

Historical baseline inside `validateAppendReceipt` remains `c41bca2bc07e9d8fddbb38ca77904dd1f0cac438`, source `68296a0d34ceea94dbc9ca9398f71bc8a1b742b8`. The separate trusted full-graph baseline remains the original 953f execution stream identified above. The proposed third record is an execution-qualification target pending proof, not a new baseline and not native admission.

## Embedded controls and static acceptance of the patch

Retain all128 existing controls; the earlier104-control population remains inside those128. Add only finite third-target controls through the actual production functions. Do not execute the compiler/test child in self-test mode. Preserve the current private inert Git fixture approach and environment cleanup; no new source imports are necessary.

Required additions:

1. Third tree accepted by the actual membership predicate, with original two positive controls retained. Unknown shape-valid tree still rejected, including an expectation with all direct pins matching.
2. `buildExpectedProvenance` called with the third tree yields exactly the same nine keys, old common pins/command/flags and the actual third-target HEAD/source. Historical default remains old PINS. Exact local-manifest identity accepts the third target.
3. Both genuine supported CI event modes accept third-target identity; missing/mismatching GITHUB_SHA, missing/malformed HEAD, local override in CI, push, generic/unsupported CI and missing local manifest retain fail-closed behavior. Existing controls remain; add third-specific exercises where the branch is newly traversed.
4. Source-substitution pairs third→historical, historical→third, third→successor, successor→third fail exact local identity. Retain the two old pair controls; do not replace them with only new pairs.
5. Add the third literal to the existing self-test inert source fixture set and accepted checkout-reader loop. Use the actual `readApprovedCheckout`, provenance builder and membership predicate. Missing source objects in these inert fixtures are intentional and are never described as a full custody success or child qualification.
6. Retain the unknown checkout's archivable expected record and refusal by actual `assertFrozenInputs` before any child. Preserve missing HEAD/src controls and source/config/regular-file/symlink/opaque-report controls.
7. Exercise all six directed before→after pairs among the three admitted trees: the existing two plus four new pairs. For each use real `assertFrozenInputs` HEAD-drift rejection, isolate its source-equality barrier with the same existing fixture technique, verify the frozen expected source was not reselected, and reject changed complete snapshot source using actual `compareFrozenInputs`. Neither acceptance of both endpoints nor a valid after-source is a pass.

Report the actual control count only after execution; do not estimate it as a measured result. Before parent approval, provide the complete diff and exact runner bytes. Static review must establish that only the two literal/predicate regions and narrowly related selfTest changes occurred; every unowned production function and all old constants/pins/allowlists remain byte-equivalent. Preserve all prior controls rather than replacing their intent with a weaker mock. ROOT/B parent reviews the exact candidate implementation before any runtime authorization.

## One serialized third-target trial and complete acceptance

Implementation release is not trial release. After exact patch review, B parent independently freezes a **committed** execution checkout whose source is exactly1716 and which contains the unchanged c63 append test, genuine fixture, common pins and nine-config population. Do not execute a dirty shared primary checkout or ROOT's ongoing integration checkout. Compose delivered geometry using normal ownership-approved Git integration; do not borrow mutable files from another lane. Freeze actual HEAD/full tree/source tree, Node/V8/pnpm, complete dependency/config population, all1,901 source Git identities and physical hashes, fixture/test, runner/hook/issue custody inputs, command and4096-MiB flags, exact comparator bytes and baseline graph hashes. Preserve the frozen candidate runner bytes separately from later publication identity.

Only after that freeze is reviewed may B parent separately authorize **one** serialized third-target trial under the existing parent route. This document authorizes no new runtime itself. No concurrent trial, hidden retry, fault window, archived-runner execution, baseline replacement or new test case is allowed. Current failed CI archives remain intact. Before-spawn failure means zero child observations; after-spawn failure reports actual counts and preserves partial data.

Healthy acceptance requires strict parent and child exit0, no signal/kill/spawn failure, unchanged full before/after custody, all38 complete envelopes, the exact36 ordered IDs, reporter36pass/0fail/0pending/0todo, completion passed with no missing/duplicate IDs, action/schema/emission channels passing, Runtime22's33 transitions, and all eight named negative same-validator mutations with complete original/corrupted witnesses. Preserve source ownership/batch/consumer completion/module/body/defined-helper/call joins, actual artifact/binary bytes and full memory before/after evidence. Do not infer these from an exit code or status summary.

The separately reviewed comparator must compare **every field of every one of the36 complete ordered observation graphs and the complete completion graph** with the retained original baseline. Graph0 stays separate but must be fully validated against the new frozen epoch and raw streams, not ignored as a wildcard. Join full stdout/stderr to all38 archived envelopes; preserve complete descriptors/undefined/NaN/Map/Set/buffer references, source sites, metadata, body/slot/allocation tables, module identity, error descriptors, negative witnesses and final binaries. No normalization or filtering is permitted to manufacture equality. Record Node/V8 changes explicitly; they do not license deleting differences.

If any graph differs, record exact ID/envelope/graph path with both complete values, originating source delta and raw custody. Stop compatibility acceptance and report the actual result. Distinguish an intended changed observation from a regression or instrument issue only in a separate bounded follow-up. No retry, rebaseline, repin, comparator relaxation or substitution of passing summaries is authorized by this plan. A static expectation of byte equivalence does not overrule a measured difference.

After the one trial and full comparison pass, use existing B PR6593 and ordinary signed hooks for publication in the approved scopes. No direct-main push, hold removal or queue submission is implied. New supported-identity required-quality and advisory CI must then produce actual downloadable archives; independently verify their artifact IDs/names/digests, run/job/attempt, exact executed checkout/source, terminal outcomes, full custody and complete witnesses. A changed synthetic checkout with an unknown fourth tree still refuses and its failure archive must be retained. Existing uploaders already suffice; this release does not modify workflow transport to make a run green. If no archive is produced, report the missing artifact and actual logs without success credit.

## Review artifact and limits

Reviewer data is `.tmp/independent-review-data.json`, 31,170 bytes, SHA256 `5592d0b3da474c50afa8701e296e5d54e5fa587a730df9c9f729d5937526da7b`. It includes exact three-path delta, reconstructed source identities, complete fixed-pin table, preserved function lists, independent full-graph/raw-stream/custody comparison, actual downloaded CI archive metadata and per-file raw hashes, and all published blob download identities. Exact ancestry JSON, job logs, claims, blobs and ZIPs are alongside it. The inert inspection script `.tmp/review-data.py` is review tooling only and is not proposed repository production/test code.

The original specification was full-text read; complete G24 source, all changed source bytes, complete 2a8 and baseline graphs, both actual CI partial archives and relevant production runner sections were independently inspected. No archived JavaScript was executed, no runner/compiler/test imported, no v8 payload deserialized, no runtime child spawned, no production fault mutation performed. This review cannot claim third-target36/38 equality, native completion, JS-host IR/native-array admission, performance, full IR equivalence, allocator ownership, legacy retirement or release of B holds. ROOT must adopt/release the bounded plan; B parent must review/freeze/authorize the single trial; final integration and queue remain ROOT's.
