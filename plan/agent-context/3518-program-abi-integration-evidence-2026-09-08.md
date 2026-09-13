# Canonical ABI extraction: composed evidence and remaining caller gate

Issue 3518 remains in progress. This checkpoint moves the existing ABI state
machine, structural inventory input and primitive binding-key validation into
three clean modules. It preserves the original inventory object, generic rich
inventory typing, constructor/error identity, all lifecycle rules, three index
spaces and the mixed old-path LegacyAbiAdapter. It neither changes public
compiler dispatch nor creates another planner or physical allocator.

## Source and ownership

Parent composition is `codex/3518-program-abi-checkpoint-20260908`, initially
based on published N1 commit `36ea5ce9f54190c1f2c7af0466cf768afb453394` in
ready PR 5735. Foundation PR 5733 already landed at
`fa9e1ea0c7986b53f290e88822b262ab10ca62f4`. The root checkout and every
preserved P/C/B/D draft remain untouched.

Maxwell's existing Astra Low native context implemented the approved
[seven-file seam](./3518-program-abi-seam-dispatch-2026-09-08.md) at
`d71fab8b9565ad3a2bb567ed82f22e8750e804a4`. Its exact claim
`3518:program-abi-seam` was reconciled before writing. Parent copied all seven
validated files without changes; the original draft remains preserved:

- `src/ir/program/abi-inventory.ts`: `d65caca8c5e4bf9b60b555f68711e3801f30dd9a`.
- `src/ir/program/abi.ts`: `c9240ad8bc83c36774a7def20db27425252f459a`.
- `src/ir/core/binding-key-primitives.ts`: `76364db86fb07972f66a78a886d66197e2355f6a`.
- `src/ir/program-abi.ts`: `35e3849eb8ef955e8944e77d15b284137897a2db`.
- `src/ir/abi-bindings.ts`: `ccc36208e534f572379150dc4e9ebf5a79edace4`.
- `tests/issue-3518-program-abi-seam.test.ts`: `7f96f27ded3b9387ad63c6edee970b47e3430a9f`.
- `tests/issue-3518-program-abi-seam-boundary.test.ts`: `0ac038747f5c5ee50465b759e50fbdb25ca86e28`.

These are Git blob hashes. Independent AST comparison found 16 of 17 moved
class member bodies identical; the sole intentional difference substitutes
the equivalent primitive source-global key builder in inventory validation.
No other algorithmic body difference was accepted.

## Actual standalone artifact comparison

Harness: local Node v22.23.2 + tsx, standalone WasmGC, existing preparation ->
codec -> accepted emission, with no optimization pass. It imports the old
ABI path on all sides and instruments plan/seal/bind/finish in a separate
process. It uses real multi-source analysis, a nonempty semantic program,
validated/instantiated zero-import binaries and explicit expected values.

The complete evidence records are deeply identical across all three trees:

1. Clean d71 foundation, with no source diff or untracked source.
2. d71 plus the seven frozen ABI files, tracked-source diff SHA-256
   `0d73f173d7a8a5aafabde29bdbad4323f874d15a97efe7d1fac626a26d0e5d48`;
   the three untracked source blobs are pinned above.
3. Parent N1 commit 36ea plus the same ABI files, with that same tracked-source
   diff and new-source hashes. This third run validates actual N1 composition.

Equality includes exact encoded program strings, ABI entries, full base64
binary strings, exports, lifecycle call counts and execution values, not just
hash prefixes. Original versus decoded/replayed emission also matches on every
side. Measured fixtures:

- Cross-source callable alias: six ABI entries, two terminal units and two
  emitted bodies; 91-byte binary, result 42. Encoded SHA-256
  `65f6595422d432fbb5b77a0b81cf8d443f899b2056ab96bd98b32f2a19d5cebe`;
  binary `aa4959fd40bf9d2d7ddc1ff5252173678c02f237ed6ec03295d209e082d856b0`.
- Mutable global/startup: seven ABI entries, two terminal units and two bodies;
  159-byte binary, result and exported global both 42. Encoded SHA-256
  `86d2bf3e23bf299f933ba823cf27a7a974b742e885533a44eb2db38e06256a99`;
  binary `e8f0be70a33c9515c75b84564703f39820b519d3cc2ff97cc022b3da89695177`.

Preparation and codec validation each execute plan/seal (6/1 or 7/1 calls).
Accepted emission executes plan/seal/bind/finish (6/1/2/1 or 7/1/4/1).
These are internal prepared-route measurements, not new public roots or proof
of public IR-only execution. They do not cover full conformance or optimization.

Retained worker records: `.tmp/abi-before.json`, `.tmp/abi-after.json`,
`.tmp/abi-pair-provenance.json` and the exact `.tmp/abi-candidate.patch` in its
preserved checkout. Parent retains `.tmp/abi-composed.json`. Harness SHA-256:
`ee8bd6f8fb865b4be7d09ac3478a5d95f644986af799d2c545f117484621d49b`.
Permanent tests use current fixtures, never historical Git objects in CI.

## Boundary and test evidence

The isolated draft passed **59/59** tests: nine ABI seam, eleven boundary and
39 existing lifecycle/provenance controls; normal typecheck also passed.
The actual parent N1+ABI composition then passed **101/101** tests with zero
pending/failed cases: those same 59 plus all 42 D0 detector controls. The
seven-file result is retained as `.tmp/abi-composed-controls.json`; execution
used the normal pinned Vitest with one fork and a 2 GiB heap, not a broad
local Test262 campaign. Composed normal typecheck and scoped seven-file lint
also passed; full boundary mode returned 1 with a valid but incomplete inventory.

Parent's actual composed inventory check, compared with N1 commit 36ea, exited
0: **1247 modules** (1244 tracked + three new), **9756 resolved edges**
(2489 type-only + 7267 runtime), four unknown edges, zero inventory errors.
Nine modules are clean: the six existing F0/N1 leaves plus the three ABI leaves.
Policy SHA-256 `c8de1fc3eecd8e93131967fc5dc0dec4a9302462bc70f61192a832c3cf01b21f`;
content fingerprint `da50b018bfb44110cb07f18d016df7ea6aece3f69f0a0be75c8c77c6b6c60bec`.
The report is `.tmp/abi-composed-boundaries.json` in the parent checkout.

Core minimum one and program minimum two are activated with monotonic history.
The required future `src/ir/core/nodes.ts` and `src/ir/program/index.ts` work is
explicit debt, not silently completed by these small leaves. Both old modules
remain mixed; the old name adapter belongs to the future legacy IR bridge.
All previous activations, thirteen overrides and held B findings remain.
The architecture is still incomplete.

## Pending acceptance and publication

The moved-constructor/method caller gate is still required. An imported class
or traversal of all class bodies is not proof that every method has a real
consumer. The existing Astra High native context is specifying the exact
constructor specialization, accessor/private-method/source-reference handling,
fixed denominators and removal controls for the existing auditor. Parent will
review before assigning the bounded implementation to an existing Astra Low
context. The new source exports and internal prepared driver are not public
roots. N1's 39 strict plus 66 approval controls remain unchanged.

Full and dispatch-cut evidence stay distinct. The user-approved extraction
preservation verdict does not resolve either dynamic-import hook or certify
closure/retirement. No missing ABI consumer may be excused by that approval.
The ABI checkpoint is not yet published or accepted; normal hooks, final
composed gate/policy validation and a ready loopdive/js2 PR remain mandatory.

### Additional acceptance decision requested

The High source-binding projection found 29/30 public full/cut witnesses and
26/30 internal-driver witnesses. These are preliminary source-reference
measurements, not a finished gate result; the complete
[30-target implementation spec](./3518-program-abi-reachability-plan-2026-09-08.md)
is retained alongside this evidence. `ProgramAbiMap.planningSealed` is read
by `PreparedIrCandidateProgramBuilder` at `src/ir/prepare.ts:122`; source review
found no production consumer of that builder. Constructor/class-wide traversal
would falsely hide this missing rooted getter witness. The two-hook approval
does not cover it, and the fixed denominator must not be reduced.

Parent asked the user whether this already-unrooted accessor may be preserved
unchanged as an explicit compatibility obligation while retaining incomplete
public-caller proof and blocking retirement. The answer is pending here. No
production caller is fabricated, getter is deleted or ABI gate is weakened.
Parent accepted the narrowly proposed additional package-command wiring in
principle, but activation/implementation awaits the acceptance decision. The
source/validation checkpoint remains useful and preserved meanwhile.
