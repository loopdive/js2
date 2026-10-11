# BigInt String carrier prerequisite

Base: loopdive/js2 main `2a58b9fe9f95dc17bd5d2ba44ecd564b9695356b`.
This is an independent runtime prerequisite for the held IR migration work,
not completion of PR5883, full BigInt support, or old-compiler retirement.

## Implementation

String conversion of an oracle-proven native BigInt must prepare the existing
wide carrier types before compiling its operand with an externref expectation.
Otherwise the literal becomes low64 before later boxing can preserve it.
`string-conversion-argument.ts` owns preparation and the single argument
compilation. Other operand types retain their existing hint behavior.

The comma operator forwards its result expectation only to its right operand.
Left evaluation/drop and void-result handling remain unchanged. Existing
dispatch files do not grow; no budget allowance or gate change is introduced.

## Measurements and boundaries

Main-based inline candidate: handle94997 exit0,26/26; typecheck23230 exit0.
Helper-extracted candidate: handle81862 exit0,26/26. Exact unchanged populations:
String13, new comma8, existing dual-pipeline comma5. All21 standalone native
controls pass with zero imports. The existing five use the host harness and
assert legacy/IR results and actual ownership; they are not zero-import cases.
Full local logs are `.tmp/standalone-checkpoint-26.log` and
`.tmp/standalone-helper-26.log`. Final helper typecheck/budget checks are recorded
separately when terminal; do not infer them from the inline candidate.
Final helper typecheck plus LOC/function checks: handle30218 terminal exit0.
Both size gates pass without allowances or baseline edits.

## CI inventory follow-up

The first PR6182 quality run rejected the new helper because it had no compiler
inventory entry. It is now explicitly classified as unmigrated mixed code with
a backend-wasmgc destination; no activation, allowed edge or gate was relaxed.
The exact failed inventory command completed successfully (handle36778):
1543/1543 modules tracked, no inventory errors. Architecture and graph closure
remain incomplete, with four unknown edges; this is not retirement evidence.

The scoped boundary suite completed at 124/125 (handle18967). Its sole failure
expects the frontend layer to contain only the contracts module, whereas main
already requires three modules. A direct comparison against upstream main
`2a58b9fe9f95dc17bd5d2ba44ecd564b9695356b` verified that both the entire test file
and the asserted frontend layer are identical to main. The original assertion
and failure are preserved; this checkpoint does not claim the suite is green.
Both this branch and the owned IR integration branch were explicitly merged
with that freshly fetched upstream main and were already up to date.

Earlier integration-pair receipts remain preserved in the recovery work:
early-carrier49 improved29→35, comma8 improved5→8, originalString13 improved
12→13, existingcomma5 stayed5/5. Those runs had other integration changes;
the independent main-based26 above establishes this checkpoint's own result.
All original failures and fixtures remain in the integration/recovery records.

Still unresolved: wide values narrowed in closed-object storage, wide valueOf
provider paths, method override/shadowing, full generator/class acceptance,
Object prototype authority and deferred provider activation. No claim that
these scoped passes establish end-to-end IR equivalence or make5883 mergeable.
