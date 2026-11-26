# Class-B root tests still red after the harness fix (lane S24, 2026-11-26)

These root test files had their raw `instance.exports` harness switched to the
shared `tests/equivalence/helpers.ts` helpers (`instantiateWithRuntime` /
`compileToWasm`), the same change as the class-B PRs (#7456, #7464, #7471,
#7472, #7474, #7479, #7481, #7487, #7492, #7493, #7496). With the harness right,
some tests in each file still fail. Those failures are real bugs or stale
expectations, not class B, so the files cannot go in a class-B PR: `quality`
and the pre-commit hook reject any touched root file that is still red.

The harness edits for all of them are on this branch (`s24-classb-parked`, not
for merge as-is). Whoever fixes a file's remaining failures can take that
file's harness diff from here.

Base: main 1a726b3e (+ #7456's `deps` parameter). Per-test comparison of the
same file on main vs this branch.

Columns:
- **main:** failing/total on main.
- **after:** failing/total with the harness fix.
- **first remaining failure:** the first test still failing after the fix, and its error.

Marked ⚠ = after the fix, a test that passed on main now fails (excluded
from every PR). Rows where main = after gained nothing from the harness
change. They are probably not class B at all.

| file | main | after | first remaining failure |
|---|---|---|---|
| `dom-style-assignment.test.ts` | 1/1 | 1/1 | preserves nested host style property sets :: AssertionError: expected {} to be 'schnucki' // Object.is equality |
| `issue-1310.test.ts` | 3/6 | 3/6 | sandbox-resolved Array is the sandbox's Array, not globalThis.Array :: AssertionError: expected {} to be undefined // Object.is equality |
| `issue-1491.test.ts` | 3/5 | 3/5 | at runtime: readFileSync reads a real file and returns the bytes as a string :: TypeError: Cannot convert object to primitive value |
| `issue-1500.test.ts` | 7/7 | 6/7 | reads .status from awaited Response :: AssertionError: expected NaN to be 200 // Object.is equality |
| `issue-1700.test.ts` | 8/11 | 8/11 | compiles: round-trips Uint8Array through a Uint8Array-typed export :: TypeError: wrapExports: export "echoBytes" expects uint8array for arg #0, got object |
| `issue-1755.test.ts` | 1/5 | 1/5 | erases the generic argument in param, return, variable, and field positions :: TypeError: type incompatibility when transforming from/to JS |
| `issue-1829.test.ts` | 4/4 | 4/4 | Uint16Array values above 255 cross the boundary unmasked :: TypeError: wrapExports: export "echo" expects typed-array for arg #0, got object |
| `issue-1970.test.ts` | 5/6 | 1/6 | destructuring with defaults in a loop re-evaluates per iteration :: Error: compile failed: for-of array destructuring: element is not an array type |
| `issue-2773-oob-length-bound.test.ts` | 8/11 | 1/11 | the reduceRight DOWNWARD tracking pattern (grow-write gap reads undefined) :: AssertionError: expected +0 to be 1 // Object.is equality |
| `issue-2798.test.ts` | 5/22 | 1/22 | OOB element in arithmetic is NaN (undefined → ToNumber) :: AssertionError: expected +0 to be 1 // Object.is equality |
| `issue-2844.test.ts` | 4/11 | 2/11 | for-of: full cluster shape — OOB key binds undefined, length reads vec length :: AssertionError: expected 7893 to be 107893 // Object.is equality |
| `issue-2972.test.ts` | 5/9 | 3/9 | flag ON: a claimed const-string-index function IR-compiles AND runs correctly :: AssertionError: expected [ 'f' ] to not include 'f' |
| `issue-2976.test.ts` | 4/4 | 1/4 | reassigned-after capture: identity fixed; value staleness is a PRE-EXISTING analysis gap :: AssertionError: expected '42\|42\|true' to be '1\|42\|true' // Object.is equality |
| `issue-3053-u2-claim-flip.test.ts` | 4/19 | 1/19 | the real fast+host-js-string compile does NOT claim + emits a valid module :: AssertionError: expected [ 'f' ] to not include 'f' |
| `issue-355.test.ts` | 7/19 | 1/19 | entries work with mixed types :: Error: Compile failed: |
| `issue-3587-async-rejection-delivery.test.ts` | 21/21 | 1/21 | LOUD REFUSAL: a still-declined rejection-observing shape is a compile error, not a silent miscompile :: AssertionError: expected true to be false // Object.is equality |
| `issue-3656.test.ts` | 1/2 | 1/2 | preserves the JSDoc parameter type through planning and runs all branches :: AssertionError: expected 'This feature has been abandoned.' to be 'renamed:stable' // Object.is equality |
| `issue-3903.test.ts` | 8/24 | 3/24 | keeps dynamic string receivers on the live prototype path :: AssertionError: expected 1 to be 42 // Object.is equality |
| `issue-4302-prettier-invalid-binary.test.ts` | 3/8 | 1/8 | keeps nested async-generator captures on their by-value host ABI :: AssertionError: generator-no-host-free-lowering: this async generator has no host-free lowering yet (#7010). Neither the native generator state machine (#680) n |
| `issue-6777-in-array-carrier.test.ts` | 4/39 | 1/39 | delete on an array of objects reaches the host tombstone, not a mirror :: AssertionError: expected 31 to be 19 // Object.is equality |
| `issue-739-s2-descriptor-pin.test.ts` | 12/15 | 1/15 | descriptor returned from a function is still missed (name-based pre-pass) :: AssertionError: expected 'yes' to be 'no' // Object.is equality |
| `iterators.test.ts` | 4/6 | 1/6 | generates iterator imports for string for...of :: AssertionError: expected '(module\n  (type $__vec_base (sub (st…' to contain '__iterator' |
| `json.test.ts` | 5/5 | 2/5 | compiles JSON.stringify to host import call :: AssertionError: expected '(module\n  (type $__vec_base (sub (st…' to contain 'JSON_stringify' |
| `string-enums.test.ts` | 5/5 | 1/5 | string enum in string pool :: AssertionError: expected [ Array(1) ] to include 'RED' |
| `string-literal-cache.test.ts` | 9/9 | 4/9 | string literals use imported string constants (WAT inspection) :: AssertionError: expected '(module\n  (type $__vec_base (sub (st…' to contain 'string_constants' |
| `typeof-expression.test.ts` | 5/5 | 2/5 | compiles typeof for number, string, boolean literals :: AssertionError: expected [ 'TypeError', …(8) ] to include 'number' |
| `issue-1211.test.ts` | 1/3 | 1/3 | recursive function with run_hot wrapper compiles to a valid Wasm binary :: TypeError: type incompatibility when transforming from/to JS |
| `issue-1232.test.ts` | 11/12 | 3/12 | toUpperCase compiles to a `string_toUpperCase` host call :: AssertionError: expected '(module\n  (type $__vec_base (sub (st…' to match /string_toUpperCase/ |
| `issue-1324.test.ts` | 13/13 | 2/13 | undefined → JS undefined (not a string) :: AssertionError: expected 'null' to be '(undefined)' // Object.is equality |
| `issue-1328.test.ts` | 2/4 | 1/4 | String.prototype.matchAll dispatches to a user-supplied @@matchAll :: TypeError: String.prototype.matchAll is not yet implemented in --target standalone |
| `issue-1431.test.ts` | 3/7 | 1/7 | externref destructure: default fires on explicit undefined :: AssertionError: expected 'FAIL: 0' to be 'PASS' // Object.is equality |
| `issue-1564.test.ts` | 25/26 | 1/26 | bitwise \| on Symbol throws TypeError :: AssertionError: expected 'no-throw' to be 'TypeError' // Object.is equality |
| `issue-1735.test.ts` | 6/6 | 1/6 | (123.456).toExponential() (no arg) → '1.23456e+2' (variable digits, unchanged) :: AssertionError: expected '1.234560e+2' to be '1.23456e+2' // Object.is equality |
| `issue-2017.test.ts` | 4/6 | 2/6 | writing a non-writable built-in data property silently no-ops (no throw) :: TypeError: Cannot assign to read only property 'E' of object |
| `issue-2086.test.ts` | 2/5 | 1/5 | Lane B (externref built-in): forwards every arg to the built-in parent :: TypeError: Sub is not a constructor |
| `issue-2122.test.ts` | 2/5 | 2/5 | host fromCharCode(104,105,33) === 'hi!' :: AssertionError: expected {} to be 'hi!' // Object.is equality |
| `issue-3051.test.ts` | 14/16 | 4/16 | reads an overridden exec result array back into wasm (round-trip) :: AssertionError: expected 'x\|undefined\|len=1' to be 'hello\|cap1\|len=2' // Object.is equality |
| `issue-3078-number-undefined-arg.test.ts` | 7/8 | 3/8 | (123.456).toExponential(undefined) → '1.23456e+2' (variable digits, like no-arg) :: AssertionError: expected '1.234560e+2' to be '1.23456e+2' // Object.is equality |
| `issue-3081-number-namespace-const-receiver.test.ts` | 6/6 | 1/6 | Number.MAX_SAFE_INTEGER.toFixed(0) → '9007199254740991' :: AssertionError: expected '9007199254740992' to be '9007199254740991' // Object.is equality |
| `issue-3142.test.ts` | 3/15 | 2/15 | body-shape rejection: a top-level statement kind the IR does not own :: AssertionError: expected null to be 'body-shape-rejected' // Object.is equality |
| `issue-4295-runtime-user-class-method-dispatch.test.ts` | 1/3 | 1/3 | preserves a dynamic spread argument vector for the selected class method :: AssertionError: expected '02' to be 322 // Object.is equality |
| `issue-5208-compiled-date-host-bridge.test.ts` | 14/14 | 11/14 | Intl.DateTimeFormat.formatToParts(new Date(0)) returns parts, not RangeError :: AssertionError: Intl.DateTimeFormat has no native implementation on the native semantic regime: compile with --host-accelerator intl (hostAccelerators: ["intl"] |
| `issue-6780-await-static-suspends.test.ts` | 14/16 | 3/16 | forward references: a caller compiled before its driven callee reads the settled value, not NaN :: AssertionError: expected 'af+1=NaN,real+1=NaN,all=NaN/NaN' to be 'af+1=7,real+1=9,all=2/4' // Object.is equality |
| `issue-6944-proto-chain-fnctor-instance.test.ts` | 12/20 | 4/20 | gc: identity :: AssertionError: expected 'function,false,undefined,false,false,…' to be 'function,true,function,true,true,func…' // Object.is equality |
| `issue-json-stringify-structs.test.ts` | 8/8 | 1/8 | serializes a basic struct :: AssertionError: expected null to deeply equal { x: 1, y: 2 } |
| `issue-1058-closure-rest-host-dispatch.test.ts` | 1/2 | 1/2 | materializes empty and populated rest arrays for plain and method host calls :: AssertionError: expected null to be 10 // Object.is equality |
| `issue-2012.test.ts` | 5/5 | 1/5 | a non-frozen object remains writable (no false positive) :: AssertionError: expected 'false,2,false' to be 'false,1,false' // Object.is equality |
| `issue-5095-array-at-no-argument.test.ts` | 4/13 | 1/13 | gc: at() compiles byte-identically to at(0) and at(undefined) :: AssertionError: expected '5deeb7d301ef990614f685cb3ee15d18f1446…' to be 'f59b4955fc84b0eab00dfa7da60b2b6015bbf…' // Object.is equality |
| ⚠ `issue-5386.test.ts` | 3/8 | 1/8 | preserves a numeric write and reversed addition through a chained alias :: TypeError: type incompatibility when transforming from/to JS |
| `issue-6421-static-builtin-spread-args.test.ts` | 11/28 | 11/28 | literal → "ABC" (parent: "\u0000") :: TypeError: Cannot convert object to primitive value |
