# Wide observation failure — source-only discrimination

Parent candidate83829 terminal1:63=48pass15fail. Read candidate log rows:
original20=17/20, diagnostics12/12, provider31=19/31. Nine provider wide rows
return -2 after typeof check; method-free String(wide) control returns -1.
Override/shadow return -1. Baseline31 handle25925 parent-owned at dispatch.
Provider, dynamic routing and all original fixtures remain frozen.

## Method-free String literal source path

Parent expressions/call-identifier.ts String(x) compiles strArg0 with an
externref expected type ONLY when usesHostBigIntCarrier is true; native lane
passes undefined (around1429). bigint-wide.ts tryFoldBigIntConstant checks
expectedType for externref/anyref; absent that, emits i64.const of
BigInt.asIntN(64,value) (around357). The exact literal 18446744073709551617n
therefore has low64 value1 on this branch. emitI64ToStringCall uses native
bigint_toString; its recovery emitNarrowedCarrierToString only intercepts a
trailing __to_bigint call, not an already-emitted i64.const. Source predicts
String control emits "1", not the full decimal. Runtime log only records -1;
"1" is a source-derived prediction, not captured runtime output/IR proof.

Do not extrapolate this literal path to every String(valueOfResult): externref
inputs enter emitToString, and __any_to_string has a wide-carrier formatting
arm. Each result may have been narrowed earlier in variable/call lowering.
Provider body itself contains no i64 conversion, but end-to-end full-width
preservation remains UNPROVEN. Existing Object.is wide pass is insufficient:
reviewed SameValue BigInt arm compares through i64 conversion.

## Independent proposed batch

`5883-bigint-width-discriminators-20260927.json` contains six source-only
high-bit/low-bit checks, no String or Object.is. Use Reflect.get from an object
property for a reference-carrier input to reduce constant-folded comparisons.
Method-free wide and narrow controls must both pass before interpreting direct,
extracted, runtime-wrapper and static-wrapper results. Wide operations can
themselves have bugs; a failed positive control INVALIDATES attribution rather
than proving provider narrowing. Static Object(wide) has an independently
documented i64 construction boundary and must remain a separate row.

No native/compiler/Wasm/typecheck execution. Exact original31 and20 unchanged.
No format/runtime repairs proposed for integration in this review.
