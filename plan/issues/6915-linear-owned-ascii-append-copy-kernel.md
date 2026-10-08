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
