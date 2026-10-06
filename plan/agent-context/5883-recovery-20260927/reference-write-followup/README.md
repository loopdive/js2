# Native BigInt reference-write preparation

Recovery archive only: this PR does not execute these .ts.txt files or apply
reference-boundary-calls.patch. The patch's reverse applicability was checked
against the measured parent candidate. Restore the two source modules under
src/codegen and the tests under tests with their original issue-5883- prefixes.
The original machine receipt named below is copied here as paired-receipt.json.
Do not apply onto a newer implementation without comparison; no queued PR head
or failing acceptance fixture is replaced by this archive.

Parent integration HEAD18f1bd plus owned dirty changes. This is not a clean-main
result or full closed-field/IR equivalence. All original failures remain.

New reference-storage-operand.ts calls Curie's agreed prepareClosedFieldValue
before one compileExpression for an oracle-proven native BigInt. Other operands
retain their original expected hint; explicit scalar hints remain scalar. It
does not repair already narrowed producer values or change callable ABIs.
Curie's bigint-field-carrier.ts was copied byte-identically at
cf7dd941657d61c4ddbf8be76d2d92111f3d28ee3985a4ef6b6ef0426954c20d.
Its field-layout mapper has no newly integrated callers in this checkpoint.

Five selected reference-boundary sites use the wrapper: dynamic dot RHS,
computed key/RHS, and both Reflect argument emission loops. Existing target/key/
argument order, number fast path, thrown errors and assignment result handling
remain in their original callers. No static global/setter/callable ABI edits.

## Measurements

Helper10/10 and source typecheck passed in66102. Runtime baseline temporarily
restored only those five calls to compileExpression; imports stayed unwired and
all other integration sources stayed unchanged. Candidate calls were restored
after both baseline processes terminated. No user or other-owner changes were
reverted. All fixture sources and native expectations were unchanged.

- New runtime8 baseline32115:5/8, native8/8, compiled8,zeroimports8.
- Original raw5/provider31 baseline64892:23/36.
- Combined candidate87167:29/44, versus combined baseline28/44.
- Exact source SHA equality for all44. Compile/zeroimports44/44 both sides.
- Only changed actual result: dynamic dot write -1 to1. No pass losses.

Machine receipt5883-reference-write-pair-20260927.json retains all44 before/after
records and log hashes. Logs:.tmp/reference-write-baseline.log,
.tmp/reference-write-controls-baseline.log,.tmp/reference-write-candidate.log.
Original31/raw5 tests are untouched. New8 explicitly includes closed direct
field and descriptor cases: both still fail, not narrowed out of acceptance.

## Remaining integration

Curie's coherent field mapping/registration/initializer/spread/default patch
and Mendel's class producers/defaults are not yet integrated. Parameter-property
producer and callable scalar boundaries remain explicit limitations. No claim
that the existing15 failures are fixed, that this is full BigInt support, or
that old code can retire. Required follow-up includes actual route ownership,
no-opt-in parity, initialized/missing fields, aliases/shared layouts, dynamic
runtime values, and full original migration acceptance.
