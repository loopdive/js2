# Exclusive two-literal instrumentation result

Handle19078 TERMINAL exit1; compiler slot explicitly RETURNED. Exactly2 selected:
1pass/1fail, 3skipped. Native2/2 expectations, compiled2/2, zero imports both.
Duration13.40s. No kill/restart, no additional run or typecheck.

Current parent integration was copied to /private/tmp/5883-literal-instrument-8yuKQh,
not the old agent tree. Input groups hash-matched before instrumentation.
No early-carrier repair included; only three console logging points.

Measured causal trace for literal18446744073709551617n:
- oracle=bigint, nativeBigIntArg=true, expectedType=externref;
- wide-expression entry base carrier index=-1, wide/limb undefined (JSON omits
  undefined fields; field names are present in instrumentation source);
- constant evaluator retains exact18446744073709551617, overflow=true;
- chosen branch=low64-fallback due to missing carriers;
- actual output="1", raw units=[49], length1; native output full20digits.

Narrow1n: same classification/expectedType/carrier absence, overflow=false and
decline branch. Actual/native both"1". Both binaries and WAT byte-identical;
binary SHA25633c9833f53db002ffe4fd039eb17a8321c1f57d5db084e585209915b6b6631a9.
This proves missing preparation at wide emission, not oracle misclassification
or lost hint. Existing early-carrier patch targets precisely this ordering;
its repaired runtime behavior remains UNRUN, no full-width success claim.

Evidence in own `.tmp/5883-literal-instrument/`:
- manifest.md: source/config/dependency inputs and before/after source hashes.
- instrumentation.patch: complete console-only before/after diff.
- run-01.log: complete stdout/stderr with both full WATs and raw/native outputs.
- receipt.json: source hashes, trace rows, outputs, WAT hashes/body excerpts.
Log SHA2564e9d62f97fb30cc9d5f6a3814d3fcf02c9ecf6a634b06682fd2deb3ba4dac5ea.

Parent and original fixtures untouched; no production integration or commits.
One receipt-extraction script initially had a syntax typo; corrected by reading
the saved log only. This did not execute the compiler or repeat either case.
