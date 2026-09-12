# Native delay and combinator extraction parent refresh

## 2026-09-12: native delay/combinator extraction queue refresh

Refresh existing PR5759, “refactor(ir): extract native delay and combinator
runtime bodies”, preserving published de2f1072ebb32771272d24a58407814f9d2a5d38
and its signed scoped EH repair 561853c00d76c72eb44dbee14340dc15e9841e41. Merge
signed source-family parent ceda2670821124e09c5a674e01e3632ac52b46b8 in
`codex/5759-queue-drain-20260912`. Publish only to the existing PR, after parent
delivery through the protected queue; no new migration scope is included.

The two conflicts were appended issue history and ir-native-promise-delay.ts.
Both complete history sections remain. The adapter resolves to the exact
extracted checkpoint adapter, without a duplicate inline body or stray EH
import. The signed runtime leaf retains canonical buildStandardTryTable,
tagged externref payload rejection and foreign-exception null sentinel
rejection. Allocation, timer registration, Promise lifecycle and return order
remain unchanged. Runtime leaf SHA256:
e60283bf8303025e4faa430707a9f5651c78db98202feba9aa6ccd285056e29c.

All ten source/test files changed by the repaired checkpoint remain byte-for-
byte identical to 561853. Refreshed parent frame wrapper/engine, frame forward
fixture/test and source-family preparation remain unchanged. The exact policy
composition retains every parent rule, adds delay-bodies.ts and
combinator-bodies.ts to native-runtime, raises its minimum from four to six,
and prepends the corresponding activation record. No allowed edge is widened.
The boundary inventory remains 65 modules and 212 edges (150 type-only +62
runtime); this is not a physical IR retirement claim.

The original thirteen source hashes, thirteen supplemental semantic hashes,
both five-file glue ledgers and all twenty-four declaration records remain
unchanged. Preserve all seventeen forward-EH controls, including whole ordinary
import authentication, attributes/assert/defer refusals, handler order,
payload/tag/target checks and the foreign null sentinel. The old verifier still
rejects the repaired body before its strictly authenticated inverse projection.

Fresh serialized Node25.9.0/macOS ARM64 validation passed **610/610** across
thirteen files, with zero failures or skips: frame ownership 29, frame source
preservation 41, delay admission 41, delay identity 45, vectors 24, extracted
body ownership 33, extracted source preservation 143, family source contract
36, family source identity 55, prepared main 14, semantic/provider boundary
121, native delay 14 and native family 14. The two added native-delay cases
validate a real mixed-EH artifact and actual exported-tag payload identity.

Public current-root preservation passed five frame artifacts / twelve
executions and eleven delay/combinator artifacts / nineteen executions,
including eight native-family scenarios. Both verdicts explicitly record
historicalPair NOT_RUN, physicalAcceptanceCertified false and retirementCertified
false. Do not relabel this fresh current-root evidence as historical byte/WAT
identity against the pre-EH baseline.

Source TS7, explicit-parent LOC/function budgets, coercion, oracle and
preservation-v1 dead-export checks passed; conformance sync changed zero files.
Strict closure remains OPEN at the two existing nonliteral imports. The
independent b363f29d3c43c626dc852744ad64a0b48a003693 corpus verified all 53,933
raw files, exact modes/directories and no extras/shared objects. Corpus manifest
SHA256 fcaaff56a78c134e3875a00b743d5e6435939c38f304eeec1ffb35bc3c611ffb.
Existing corpora and fixtures remain preserved.

The default pre-commit selector sees 37 inherited root test changes against
535ee6b6ba19239394ee50f8235e6c528212688b and its existing >20 lane self-skips.
The 610 tests above ran directly. Normal signed commit/push hooks remain
mandatory, with actual outcomes recorded at publication. Detailed local
receipts are under `.tmp/5759-queue-drain/`; public verdicts are under
`.tmp/frame-body-preservation-HWMbr5/` and
`.tmp/delay-combinator-preservation-ZE3n0z/`. Keep dependency-first delivery
5755→5756→5757→5758→5759→5760; only verified delivery to main counts.
