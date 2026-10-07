---
id: 6915
title: "Linear owned-ASCII append: optimize the existing copy kernel"
status: blocked
created: 2026-10-07
updated: 2026-10-07
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
