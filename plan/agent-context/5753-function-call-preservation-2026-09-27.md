# PR5753 Function.call preservation repair

Base: published `c6ece2eb0a51686d1a87ea70ebc7583265db05b4`, including upstream
main `935dab385ba7f21588ea371d052e7f143f894205`. CI run36278547692,
quality job108505871570 failed its dead-export gate on
`src/codegen/function-proto-call.ts#emitFunctionProtoCallBody`. The equivalence
shards passed; that did not waive the quality failure or standalone-floor hold.

September19 reconciliation cddba56b76 intentionally retained this older body
while publishing main's linked-aware invoker. This repair keeps the sole public
entry in `function-proto-invokers.ts`, its dependency preparation, and its receiver
guard exactly once. It restores real production use of the retained body rather
than deleting it, adding a dummy reference, or changing an allowance.

## Reviewed implementation

- A non-mutating layout check admits only exact standalone, non-provider,
  unlinked contexts with the canonical externref vector and the complete method
  ABI. It checks the i32 length and externref element representation explicitly.
- The retained body receives prepared helper indices and canonical undefined.
  No helper registration, repeated receiver validation or partial-emission
  fallback occurs inside it. Main's generic body remains live for other cases.
- Initial raw array reads were rejected by review BEFORE publication: variadic
  apply can forward a user-owned vector. Canonical representation is not proof
  of density, backing capacity or absence of accessors/prototype properties.
- Every retained-body element read now uses the semantic indexed reader on the
  ORIGINAL boxed vector. It snapshots length before index zero, preserving
  getter-driven mutations and receiver identity. Null packs stay empty.
- Signed length comparisons preserve the current generic reader's high-bit
  limitation; this patch does not silently substitute an unsigned billion-step
  loop. Neither that limitation nor broader iterator behavior is declared fixed.

## Evidence and limits

The unchanged stored-call, bootstrap and linked-provider suites pass before and
after the initial composition. Including the unchanged IR policy suite yields
25/26 on both: its source-text assertion cannot find
`irFunctionPrototypeCallRequested` in integration.ts. That failure is retained.

Eight reused-array sources were run on the exact published base and semantic-read
candidate with identical native JavaScript controls. All8 outcomes and sources
match exactly. Six agree with JavaScript; two do not:

- inherited index: native10171, base/candidate10101;
- index-zero getter grows array: native11111, base/candidate1000.

Full sources and both expected/observed values are preserved in
`5753-call-reused-arguments-20260927.json`. The additive test explicitly checks
PRESERVATION, not conformance; native mismatches remain visible and unchanged.
Original conformance probe logs remain in `.tmp/function-call-reused-control-20260927.log`
and `.tmp/function-call-reused-candidate-20260927.log` (each6/8 native matches).
These are not new gate allowances or a retirement certificate.

An initial declaration-shaped strict-this probe returns-2 instead of1 on both
base and candidate. Its complete original source and expected value remain in
`5753-call-declaration-probe-20260927.json`. The passing route witness uses the
already-supported function-expression shape; it does not erase this failure.

The route witness now passes2/2. It parses full WAT function/import order, locates
the actual call-glue definition, and checks numeric call targets within THAT
body, rather than matching helper names elsewhere. It proves the retained signed
loop calls semantic get/apply and executes the standalone witness. A linked
consumer proves the generic f64 loop still calls length/get/apply and retains its
provider guard. Linked runtime evidence comes separately from the unchanged
issue-6643 suite. An initial WASI-name probe emitted no named body and was NOT
counted as route evidence; no WASI runtime claim is made.

Final validation: TypeScript7 passes; the EXACT CI dead-export command exits0.
Core-node12/12, core-type10/10 full/cut, preservation6/6 full/cut pass. Strict
graph closure still fails at the two previously accepted nonliteral dynamic
imports, with retirement NOT CERTIFIED. LOC/function budgets pass without new
allowances. The six-file batch passes32/32 in73.08s: twelve pure admission checks,
two route witnesses, eight explicitly labeled preservation rows, and the
unchanged three runtime suites. Do not describe all32 as conformance cases.
Logs: `.tmp/function-call-typecheck-20260927.log`,
`function-call-dead-exports-20260927.log`, `function-call-acceptance-20260927.log`.

The provider-guard witness was tightened to check the actual imported callable-kind
call index, bit-zero mask and disjunction, plus the local callable helper—not
merely an `i32.or` somewhere in the body. The final two-case rerun passes2/2
(`.tmp/function-call-provider-guard-final-20260927.log`).
Parent owns publication and the serialized test slot. No baseline, original
fixture, queue hold or legacy retirement condition was weakened. Original
standalone-floor acceptance remains unresolved.
