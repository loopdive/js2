# Native primitive-value integration

Base: PR #5770, edfb6f4b6bf884cc69eceddb8713eab04370b2c9.
Branch: codex/3518-native-value-integration-20260908.

Six production files from the native-value worker retain their frozen blobs.
Canonical AnyValue, undefined, boxed-number/boolean layouts and numeric bodies
are consumed by both existing legacy callers and same-ledger resource fills.
Legacy registration/cache/import reconciliation remains at its original sites.
The checked planNativeValueResources entry validates the whole program and
current selected projection before deriving requirements. Pure derivation
alone is not whole-program admission.

Worker repair preserved all60 cases and four original receipt hashes. An
additional complete comment collector visits punctuation-attached trivia;
this fixes the retained failing mutation without weakening its assertion.
Original run79553 passed59/60; repaired run14552 passed60/60 in19.53s.
Repaired test blob: fbeb86a33bee4f3c789d65cd783ac51c6a806037.
Parent independently verified all seven worker blobs after recovery.

Integration TS7 session77587 exited0. Focused session57269 exited0 with70/70
tests (60 resource/preservation plus10 checked-entry controls),20.27s.
Tests cover genuine and serialized/decoded typed input, unsealed programs,
detached/foreign projections, backend/target mismatch, altered selected
instructions with retained owner IDs, missing ABI and missing unit receipts.
Decoded input is not a fresh-process frontend-import-denial witness.

Boundary activation adds four files across ir-program, native-runtime and
backend-wasmgc. All historical activation records and allowed edges remain
unchanged. The fixed population now contains86 modules. Focused probes44529
and67210 exited1 only on stale edge counts; observed313 edges comprise203
type-only and110 runtime, with no unknown/unresolved/forbidden/transitive
violations. Expectations now reflect those measured counts. Full205-test
boundary suite86860 is running; no terminal success claimed yet.

Final boundary terminal86860 exited0:205/205 tests passed in132.76s.
This supersedes the preceding running status. All four new modules retain
deletion, frontend-type, unknown-import and unresolved-import controls.
Parent copied the full historical High implementation plan into this PR's
handoff population so subsequent work does not depend on an uncommitted
worker-only document.

Pre-publication formatting of both parent boundary files reported unchanged;
scoped diff whitespace check passed. Budget session36024 exited0: file and
function gates passed against the upstream merge base across163 changed
source files, with existing inherited grants and no new allowances.

Final High review approved all nine implementation/test files, including
checked wrapper a2af438b, admission controls ded53f69 and repaired receipt
fbeb86a3. No remaining scoped findings. Scanner/full-family/retirement
remain unproved; normal publication hooks are the next step.

High review of the checked entry and repaired comment receipt remains pending.
Normal commit/push hooks and checkpoint PR remain pending.

## Remaining implementation

Native-string selection still requires the actual scanner and flattening,
exponent and power-table resource producers. Signature/name/nonempty-body
checks do not certify scanner implementation. Primitive-only absence is a
bounded scalar-leaf proof, not the final migration state. Closure/argument
vectors, object/callable joins, full Promise/frame/timer execution, prepared
replay, IR-only cutover, strict closure and direct retirement remain open.
