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

1. Replace nonempty growing-prefix byte loop with memory.copy: result+payload
   offset, originalLeft+payload offset, captured leftLength.
2. RHS split: zero bytes performs no payload access; one byte performs one
   unsigned byte load/store; longer RHS uses memory.copy. Destination is
   result+payload offset+captured leftLength; source originalRight+payload
   offset; count captured rightLength.
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
copies only initialized prefix, then RHS. Distinct RHS remains unchanged.
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
growth/no-growth; distinct equal-content carriers; fractional alignment
boundaries; NUL; bounded long payload; real function-import offsets and throwing
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

Status stays BLOCKED on exact ownership confirmation. Source implementation
has not been dispatched. Planning publication does not release this gate.
