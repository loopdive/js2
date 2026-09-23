# Native argument-vector integration

Base: bfe31c8bd96d748e867562e3e9b78343b72d1877 (PR #5775).
Worker source base: a6cc59a2cdfad5141d75faadf1530a9de63bebd7.

High review found faithful ObjVec bodies but two integration defects:
foreign matching-index dependency tokens could allocate dependents before
fill rejected them; snippet tests could miss deleted canonical imports or
changed retained adapter code. Worker owns the latter full-file reconstruction
repair and pre-reservation calls in the argument-vector resource owner.

Parent added PhysicalModuleReservations.assertTypeReservation(token): void.
It uses existing reserving-phase/layout validation and private token ownership,
then checks token kind. It allocates nothing, exposes no final index and adds
no alternate registry. Existing failed-state behavior is retained.

Six direct controls passed: positive no-allocation behavior, foreign/copied
matching indices with unchanged types/functions/globals/ordinal populations,
wrong token kind, stale descriptor and wrong phase. TS7 plus the existing
module-reservation suite and these six controls are running in42724; no
terminal result claimed yet. Independent ledger review remains pending.

Worker actual resource tests and full donor reconstruction remain required.
Adopt the exact early argv backing and canonical vector base; retain capacity8,
seven locals and copy/replace/store/length order. Do not duplicate Promise
capture/trampoline ownership. This slice does not implement applyClosure,
full-family execution, prepared replay, IR-only cutover or direct retirement.

High approved ledger blob98a29e4cae2787af9e889d7d9e1de216f1ac86aa and
test blob9d28cec6dc374533370205bf3efd1fd362912cfe. Parent42724 exited0:
TS7 and154/154 tests (148 existing reservations plus6 new ownership controls),
9.58s. Exact ledger amendment copied to worker with its acknowledgement and
hash verified. Worker static repairs are frozen; its exclusive TS7/focused
ObjVec run is now granted. No ObjVec runtime result is claimed yet.

Worker TS7 session62826 exited0. Focused invocation95682 stalled before
collection because a malformed execArgv option was parsed as characters,
leaving workerPID83841 waiting on stdin. No tests ran and no passing count
is claimed. User approval to stop that invocation and rerun was requested;
no process has been stopped by parent.

Parent integrated the exact repaired six-file population. Backend SHA256
4cc8c34393bc28663f5df6436226131e6015219ed061a514e5f169d9ac71153b
authenticates both dependencies before allocating anything. Test SHA256
2bdb45e7e163f7b45f6e0eed862f17285244480fde95feef9e886c82acbbad2e
adds exact complete-file reconstruction and import/retained-code negatives.
Fixture SHA2566c1406df64d99bef6f62ce43d3d98f60a517093244979fb226626043c38851ab
and three extraction-source hashes remain unchanged.

Two new boundary owners are declared; historical activation records and
allowed edges were independently compared to HEAD and remain unchanged.
Regression controls now include deletion, forbidden type dependencies,
unknown imports and unresolved imports for both new modules. The88-module
expected population and edge counts require a fresh runtime measurement;
the inherited313-edge expectation is intentionally not claimed as measured
for this larger graph. Publication remains pending actual validation.

Independent High review approved the repaired six-file population with no
remaining concrete findings. Parent ran only the bounded closure census test,
without touching the stalled ObjVec invocation. Sessions57334 and72914 exited1
and measured the stale expectations:319 total edges,206 type-only,113 runtime.
Source inspection accounts for all six added edges: two type-only imports in
argument-vector-bodies, and one type-only plus three runtime imports in the
resource owner. Expectations now pin these exact measured counts. Session46790
exited0:1/1 selected test passed,212 tests skipped of213 collected,0.790s.
All88 modules were present; unknown, unresolved, forbidden and transitive
violation lists were empty. This is not the full boundary mutation suite or
argument-vector runtime validation. No full-suite success is inferred.

Subsequent complete boundary mutation suite: session76281 exited0,213/213
passed,139.31s, single fork with512MiB parent/worker limits. This covers the
full declared boundary suite, including the two new owners and their
deletion/forbidden/unknown/unresolved controls. It does not execute ObjVec
growth/runtime tests or prove full compiler closure/direct-codegen retirement.

Composed TS7 session33890 exited0 with the six frozen worker files, ledger
amendment, and boundary integration together. Runtime suite remains pending.
Issue3518 now records this exact handoff and does not claim publication-ready.

Parent then ran a separate composed-candidate validation in this integration
checkout (not a restart or termination of the worker invocation). Session26414
exited1:36/38 passed across32 argument-vector and6 ledger-auth tests. Two
failures: assertion-library inspection of an opaque Wasm object for allocation
identity, and a negative expecting a structurally equal cloned field descriptor
to be rejected. The first now compares identity as a boolean; its exact growth
test passed1/1 selected with31 skipped,0.722s. No production change was required.
The second awaits High contract interpretation: current ledger tracks identity
for rec members/subtype payloads, while ordinary fields use content snapshots.
Do not silently weaken an ownership requirement to obtain a passing suite.
Original worker files remain frozen; this parent-only test repair changes the
integrated test hash and requires review. No checkpoint-ready claim yet.

High confirmed the nested-field requirement is unchanged contents, not field
allocation identity. Parent replaced the over-specified clone negative with a
positive reserve/freeze/fill/seal followed by a fresh mutability corruption;
rejection must leave both function objects unfilled and unchanged. Token,
root object, rec-member/subpayload identity controls are unchanged; no ledger
semantics changed. Composed focused session55631 exited0:38/38 passed
(32 argument-vector plus6 reservation-auth),0.859s. Earlier full boundary
213/213 and composed TS7 passed. Original stalled worker invocation untouched.
