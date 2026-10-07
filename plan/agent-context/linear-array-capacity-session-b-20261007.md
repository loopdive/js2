# Session B: checked Linear array allocation sizes

Branch: `codex/6896-linear-array-capacity-20261007`.
Exact diagnostic base: `c0a314636dfcaa437df1468f922bf0d6b0c5bcae`.
Canonical main includes Session A's coordination PR6562; A's published source
packet remains the separate unpublished working capture described there.

Issue6896 was canonically allocated with `prScan: ok`; no GitHub issue writes.
Plan claim `6896:linear-array-capacity-plan-20261007`, unique owner
`ttraenkler/codex-linear-b-array-capacity-astra-20261007`, permits only the
new issue Markdown in its isolated Astra worktree. Evidence claim
`6896:linear-array-capacity-evidence-20261007`, owner
`ttraenkler/codex-linear-b-array-capacity-evidence-20261007`, owns this handoff
and `plan/log/6896-linear-array-capacity-20261007/` only.

The counted open PR inventory has23 entries and zero `runtime.ts` edits.
The canonical ledger has941+ active records; older1804 and2956 fixed-vector
frontend claims remain active, and4540 still owns `addRuntime`/linked arena.
Absence of their published branch refs is not abandonment or a scope release.
Shared IR/frontend/emitter/integration/source-map files remain with A.

## Actual diagnostic observations, not whole-IR acceptance

Real `addRuntime` plus `addArrayRuntime` emits a validated executable module.
`__arr_new(0x20000000)` reserves16 bytes yet records capacity536870912,
which requires4294967312 bytes including the header. Capacity plus one
reserves24 bytes. Signed-1 input records unsigned4294967295 while reserving8.
Growing a valid four-slot array with one initialized element to minimum
capacity0x20000000 similarly reserves16 bytes and writes that huge capacity.
Corrected actual rows are retained in `baseline-provider-probes.jsonl`.

The first diagnostic reporter incorrectly mixed Number and BigInt when
formatting `requiredBytes`. Its five allocation rows therefore reported
`Cannot mix BigInt and other types, use explicit conversions` after the
runtime call. This is an instrument/reporting failure, not a runtime trap;
it cannot establish fail-closed behavior. The corrected run above retains
the same inputs and distinguishes actual runtime results from that error.

A separate actual source-IR control with two runtime numeric inputs is
admitted (`compiled: ["run"]`, no rejections), consumes the canonical f64
vector plan, and returns1.25 for1.5/-2.25. Full source/options/environment,
source hash and plan are in `baseline-ir-control.json`. This proves normal
provider use, not oversized source-IR capacity reachability. A dynamic
`new Array(n)` diagnostic currently fails with unsupported constructor; do
not turn that refusal into an accepted permanent IR limitation.

The upcoming bounded repair must address byte-product and capacity-doubling
wrap before allocation or record mutation. It does not take4540's allocator
OOM/address-endpoint responsibilities. Generic layout authority is consumed,
not duplicated; target instruction construction belongs in a cohesive module.
Legacy and all fixtures/protections stay. A owns final coordinated landing.

## Released implementation scopes

Full Astra specification accepted and committed as
`1294f2110f29c6db6935435c11877b03005e60fb` before writer dispatch.
Canonical effect verification at
`dfe9548d718364d2b7f77a32026b9db741fc2986` found945 active records and four
sole6896 slice owners. K source claim
`6896:linear-array-capacity-source-20261007`, owner
`ttraenkler/codex-linear-b-array-capacity-sol61-20261007`, branch
`codex/6896-linear-array-capacity-source-20261007`, owns only the new
`src/codegen-linear/runtime/array-allocation.ts`, its runtime import, and
`addArrayRuntime`'s new/grow capacity and byte-request regions. T claim
`6896:linear-array-capacity-tests-20261007`, owner
`ttraenkler/codex-linear-b-array-capacity-tests-sol61-20261007`, branch
`codex/6896-linear-array-capacity-tests-20261007`, owns only the new issue test.
Sol6.1 Medium writers author in isolated worktrees and run no heavy checks;
parent freezes and validates their integrated bytes sequentially.

## Integration packet

Plan commit: `1294f2110f29c6db6935435c11877b03005e60fb` (Astra High).
Implementation: `b749becb4b4e44c5722b742de0dfd83cf7f0a04e` (Sol6.1 Medium).
Final regression instrument: `f221a809902cf630c1df433298e59ecc85c492ff`
(Sol6.1 Medium), SHA256
`17ae9008f80f9ea969afa5aa9e0305f57ef6fc47ad2936613446f2d65b71bc3f`.
Its baseline copy is byte-identical. Fresh canonical publication verification
read tip `dfe9548d718364d2b7f77a32026b9db741fc2986`, 945 active claims,
exactly the four unique 6896 slice owners above. No shared-file handoff inferred.

The runtime consumes `planLinearVectorLayout(f64)` through the new target-local
instruction helper. Maximum unsigned capacity is536870909; doubling first
requires old capacity at most268435454. Oversized/negative unsigned requests
trap before malloc or header/copy/forwarding effects. Representable normal
requests retain `max(2*old,min,4)` policy. No new module functions, imports,
types, globals or locals; inspection confirms only __arr_new and __arr_grow
bodies change. Ten other runtime bodies remain exactly equal.

V1 instrument (SHA91570a7ade0ab0dc2a4ecf9a8f1243d7e01643587adb9ab0b6c7dd90d92ba5ac)
was uncommitted beside committed source b749: baseline10pass11fail/21,
candidate21pass/21. Both full logs and instrument bytes are retained.
Normal precommit rejected manual environment deletion (noDelete), then a
malformed abbreviated model trailer. Neither was bypassed. V2 uses stubEnv /
unstubAllEnvs, changes no fixtures/assertions, and passed normal commit hooks.

Unchanged controls (1938,1977,ir-vec-two-backend) on c0 and b749 each have
37pass2fail/39. Existing1977 scalar growth results24vs69 and16vs40 are
preserved, not repaired by this leaf. Their emitter functions belong to A.

No dependency on B's arena/repeat/C-ABI branches. Integrate onto c0 or a newer
main after reviewing any runtime changes and rechecking controls. A owns queue
submission; B does not enqueue. This is bounded provider arithmetic, not
malloc endpoint/OOM/linked-chunk safety, public constructor admission, or
whole source-IR equality. Preserve legacy. F32 admission is a separate blocked
plan in PR6570, not a dependency or implementation in this packet.

Final V2 sequential runs: baseline c0 exit1, 10pass11fail/21; candidate
f221a809 exit0, 21pass/21. Each emits23 actual rows. `compare.mjs` asserts
positive row counts, byte-identical instruments and exact equality of eleven
unchanged control observations. Only the three emitted/returned binary
digests are excluded because guard insertion changes code bytes. All other
actual fields, including memory hashes, source/options, route/owner evidence,
canonical memory plan, bound handles, result1.25 and usage144, match exactly.
The real rejected requests prove unchanged full memory, heap and usage;
nonallocating boundary units prove rejection before observer invocation.
Full V1/V2 failing and passing logs, initial reporting failure, instrumentV1
and replayable V2 comparison are retained under the issue evidence directory.

Reproduce sequentially with `JS2WASM_LINEAR_IR=1 node
node_modules/vitest/dist/cli.js run
tests/issue-6896-linear-array-allocation-size.test.ts
--no-file-parallelism --maxWorkers=1 --reporter=default`; use c0 source plus
the identical final test for baseline, f221a809 for candidate. Controls use
the same command with tests/issue-1938-number-array-f64.test.ts,
tests/issue-1977.test.ts and tests/ir-vec-two-backend.test.ts.
