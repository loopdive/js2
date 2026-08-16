# ES5 standalone — the 575 nonpasses (2026-08-16 census)

**Provenance**: CI baseline `test262-standalone-current.jsonl` fetched fresh
2026-08-16 (48,735 entries, loopdive/js2wasm-baselines main). Corpus pinned at
`b363f29d3c43` (matches the es5 goal doc). Classifier:
`scripts/generate-editions.ts` `classifyEdition` (post-#3626 window fix).
Pass definition: host-free (a `pass` with `host_import_leak_class` set is NOT
a pass). Population: the ES5 edition bucket, denominator **9,029**.

**Standalone ES5: 8,454 pass / 575 nonpass (93.6 %).**
The ≤ES3 legacy residue bucket (273 files) is 273/273 in standalone — no work.
The "Unclassified (untagged)" bucket (5,445 files, all carrying `esid:`) is a
different population and NOT part of this goal's denominator (see
`reference_goal_scope_is_not_the_landing_page_es5_bucket`).

**Method**: each nonpass row assigned to exactly ONE cluster by path+signature
rules (first match wins; rules in `.tmp/es5-standalone/report.mjs`). Cluster
sizes are routing labels, not shared-mechanism claims — signature counts inside
each cluster are the floor, the cluster size is the ceiling (#3626 §2.1 method).

| cluster | n | primary owner issue |
|---|---|---|
| language-misc (needs sub-triage) | 110 | (triage task) |
| defineProperty-family | 86 | #2668 / #739 |
| array-prototype | 60 | (see coverage map) |
| function-prototype | 57 | (see coverage map) |
| with-statement | 44 | #671 / #4179 / #4206 |
| string-prototype | 43 | #2742 |
| stmt-function | 33 | (see coverage map) |
| object-misc | 31 | (see coverage map) |
| scope-chain | 27 | (see coverage map) |
| regexp-core | 19 | (see coverage map) |
| error-number-boolean-date | 18 | standalone toString/valueOf gap |
| harness-files | 11 | (see coverage map) |
| annexB-b33-hoisting | 8 | #2200 / #2552 |
| annexB-date | 6 | getYear/setYear/toGMTString |
| residue | 6 | — |
| annexB-other | 5 | — |
| annexB-escape-unescape | 4 | — |
| compile-timeout | 4 | — |
| annexB-regexp | 3 | — |

Full per-cluster signatures and file lists below.

## language-misc — 110
- 5 × `assertion_fail:Test262Error: Expected a TypeError to be thrown but no exception was thrown at all`
- 5 × `assertion_fail:Test262Error: ##: __evaluated === #. Actual: __evaluated ===undefined`
- 3 × `illegal_cast:illegal cast [in __call_fn_method_1() ← __call_accessor_set ← __extern_set ← __module_init]`
- 3 × `type_error:TypeError: Cannot access property on null or undefined at #:#`
- 2 × `assertion_fail:Test262Error: Expected a TypeError but got a Test262Error`
- 2 × `assertion_fail:Test262Error: callee should be an own property`
- 2 × `assertion_fail:Test262Error: Expected true but got false`
- 2 × `assertion_fail:Test262Error: ##: var x = function () { throw "x"; }; var y = function () { throw "y"; }; x() =`
<details>files:
language/expressions/instanceof/S11.8.6_A6_T4.js
language/types/string/S8.4_A12.js
language/expressions/equals/S11.9.1_A7.9.js
language/expressions/addition/S11.6.1_A2.2_T3.js
language/statements/for-in/S12.6.4_A2.js
language/expressions/call/11.2.3-3_8.js
language/expressions/in/S8.12.6_A2_T1.js
language/expressions/prefix-increment/S11.4.4_A2.1_T2.js
language/expressions/call/11.2.3-3_3.js
language/reserved-words/ident-name-reserved-word-literal-accessor.js
language/expressions/assignment/8.12.5-3-b_1.js
language/expressions/instanceof/S11.8.6_A2.4_T4.js
language/expressions/assignment/8.14.4-8-b_2.js
language/statements/variable/S14_A1.js
language/statements/variable/S12.2_A9.js
language/arguments-object/10.6-14-c-1-s.js
language/arguments-object/S10.6_A2.js
language/types/reference/S8.7_A5_T1.js
language/expressions/assignment/S11.13.1_A2.1_T1.js
language/statements/do-while/S12.6.1_A7.js
language/directive-prologue/14.1-4-s.js
language/statements/variable/S12.2_A2.js
language/expressions/assignment/S11.13.1_A6_T2.js
language/expressions/object/S11.1.5_A2.js
language/expressions/equals/S9.1_A1_T3.js
language/statements/try/S12.14_A18_T6.js
language/expressions/in/S11.8.7_A2.4_T1.js
language/expressions/less-than-or-equal/S11.8.3_A3.2_T1.2.js
language/expressions/relational/S9.1_A1_T4.js
language/arguments-object/10.6-13-a-1.js
language/types/reference/8.7.2-1-s.js
language/expressions/does-not-equals/S11.9.2_A7.8.js
language/expressions/property-accessors/S11.2.1_A3_T4.js
language/expressions/strict-equals/S11.9.4_A2.4_T2.js
language/expressions/does-not-equals/S11.9.2_A2.4_T2.js
language/expressions/assignment/8.14.4-8-b_1.js
language/expressions/strict-does-not-equals/S11.9.5_A2.4_T2.js
language/arguments-object/S10.6_A5_T3.js
language/arguments-object/10.6-6-4.js
language/types/string/S8.4_A9_T2.js
language/types/reference/S8.7.2_A3.js
language/expressions/property-accessors/S11.2.1_A3_T2.js
language/expressions/instanceof/S15.3.5.3_A3_T2.js
language/expressions/greater-than/S11.8.2_A3.2_T1.2.js
language/expressions/new/S11.2.2_A4_T5.js
language/expressions/call/11.2.3-3_4.js
language/arguments-object/10.6-13-c-3-s.js
language/expressions/in/S8.12.6_A2_T2.js
language/expressions/property-accessors/S11.2.1_A3_T1.js
language/expressions/property-accessors/S11.2.1_A3_T5.js
language/statements/return/S12.9_A5.js
language/directive-prologue/14.1-5-s.js
language/statements/while/S12.6.2_A5.js
language/statements/labeled/S12.12_A1_T1.js
language/types/undefined/S8.1_A2_T2.js
language/expressions/postfix-decrement/S11.3.2_A2.1_T2.js
language/statements/do-while/S12.6.1_A8.js
language/statements/for-in/S12.6.4_A1.js
language/statements/throw/S12.13_A2_T6.js
language/arguments-object/10.6-14-c-4-s.js
language/expressions/instanceof/S11.8.6_A1.js
language/expressions/assignment/S11.13.1_A6_T1.js
language/arguments-object/10.6-7-1.js
language/expressions/concatenation/S9.8_A5_T2.js
language/statements/switch/S12.11_A1_T3.js
language/expressions/assignment/11.13.1-4-29gs.js
language/expressions/postfix-increment/S11.3.1_A2.1_T1.js
language/expressions/object/11.1.5-0-1.js
language/types/boolean/S8.3_A1_T1.js
language/reserved-words/ident-name-keyword-accessor.js
language/expressions/postfix-decrement/S11.3.2_A2.1_T1.js
language/expressions/instanceof/S11.8.6_A2.1_T3.js
language/statements/do-while/S12.6.1_A3.js
language/expressions/assignment/S8.12.5_A2.js
language/statements/do-while/S12.6.1_A5.js
language/expressions/greater-than-or-equal/S11.8.4_A3.2_T1.2.js
language/expressions/object/11.1.5-0-2.js
language/statements/return/S12.9_A4.js
language/expressions/postfix-increment/S11.3.1_A2.1_T2.js
language/expressions/less-than/S11.8.1_A3.2_T1.2.js
language/expressions/prefix-increment/S11.4.4_A2.1_T1.js
language/expressions/addition/S11.6.1_A2.2_T2.js
language/statements/while/S12.6.2_A7.js
language/expressions/property-accessors/S11.2.1_A4_T2.js
language/expressions/addition/S11.6.1_A3.2_T1.2.js
language/expressions/equals/S11.9.1_A2.4_T2.js
language/expressions/assignment/11.13.1-4-28gs.js
language/arguments-object/S10.6_A5_T4.js
language/statements/variable/S12.2_A11.js
language/arguments-object/S10.1.6_A1_T2.js
language/arguments-object/10.6-6-3.js
language/types/reference/S8.7_A5_T2.js
language/expressions/instanceof/S11.8.6_A2.4_T1.js
language/types/string/S8.4_A9_T1.js
language/types/string/S8.4_A9_T3.js
language/reserved-words/ident-name-global-property-accessor.js
language/expressions/property-accessors/S11.2.1_A4_T6.js
language/statements/try/12.14-7.js
language/expressions/prefix-decrement/S11.4.5_A2.1_T1.js
language/statements/while/S12.6.2_A8.js
language/statements/switch/S12.11_A1_T4.js
language/arguments-object/10.6-13-c-2-s.js
language/expressions/call/S11.2.4_A1.2_T2.js
language/expressions/prefix-decrement/S11.4.5_A2.1_T2.js
language/statements/variable/S12.2_A1.js
language/expressions/assignment/11.13.1-4-6-s.js
language/expressions/call/S11.2.4_A1.1_T2.js
language/statements/try/S12.14_A14.js
language/arguments-object/S10.6_A3_T1.js
language/expressions/instanceof/S11.8.6_A6_T2.js
</details>

## defineProperty-family — 86
- 5 × `assertion_fail:Test262Error: Expected "a === #", actually #`
- 4 × `assertion_fail:Test262Error: result2 !== true`
- 4 × `assertion_fail:Test262Error: foo descriptor value should be undefined; foo value should be undefined`
- 3 × `assertion_fail:Test262Error: arrObj.hasOwnProperty("#") !== true`
- 3 × `assertion_fail:Test262Error: Expected obj[#] to equal #, actually null`
- 3 × `assertion_fail:Test262Error: # descriptor value should be undefined; # value should be undefined`
- 3 × `assertion_fail:Test262Error: arrObj.length Expected SameValue(«#», «#») to be true`
- 3 × `assertion_fail:Test262Error: arr.length Expected SameValue(«#», «#») to be true`
<details>files:
built-ins/Object/defineProperty/15.2.3.6-4-184.js
built-ins/Object/defineProperty/15.2.3.6-4-516.js
built-ins/Object/defineProperty/15.2.3.6-4-243-2.js
built-ins/Object/create/15.2.3.5-4-15.js
built-ins/Object/defineProperty/15.2.3.6-4-207.js
built-ins/Object/freeze/15.2.3.9-2-a-12.js
built-ins/Object/defineProperties/15.2.3.7-6-a-211.js
built-ins/Object/defineProperties/15.2.3.7-6-a-43.js
built-ins/Object/defineProperty/15.2.3.6-4-183.js
built-ins/Object/defineProperty/S15.2.3.6_A1.js
built-ins/Object/defineProperties/15.2.3.7-6-a-151.js
built-ins/Object/preventExtensions/15.2.3.10-3-5.js
built-ins/Object/defineProperty/15.2.3.6-4-574.js
built-ins/Object/defineProperty/15.2.3.6-4-59.js
built-ins/Object/defineProperty/15.2.3.6-4-186.js
built-ins/Object/defineProperties/15.2.3.7-6-a-208.js
built-ins/Object/freeze/15.2.3.9-2-a-11.js
built-ins/Object/keys/15.2.3.14-5-13.js
built-ins/Object/defineProperties/15.2.3.7-6-a-203.js
built-ins/Object/defineProperty/15.2.3.6-4-586.js
built-ins/Object/defineProperty/15.2.3.6-3-123.js
built-ins/Object/defineProperty/15.2.3.6-4-294-1.js
built-ins/Object/defineProperty/15.2.3.6-4-596.js
built-ins/Object/defineProperty/15.2.3.6-4-117.js
built-ins/Object/defineProperty/15.2.3.6-4-498.js
built-ins/Object/defineProperties/15.2.3.7-6-a-74.js
built-ins/Object/getOwnPropertyNames/15.2.3.4-4-1.js
built-ins/Object/defineProperty/15.2.3.6-4-552.js
built-ins/Object/defineProperty/15.2.3.6-4-415.js
built-ins/Object/defineProperty/15.2.3.6-4-622.js
built-ins/Object/defineProperty/15.2.3.6-4-21.js
built-ins/Object/defineProperty/15.2.3.6-4-243-1.js
built-ins/Object/create/15.2.3.5-4-1.js
built-ins/Object/defineProperties/15.2.3.7-6-a-183.js
built-ins/Object/defineProperty/15.2.3.6-4-62.js
built-ins/Object/getOwnPropertyDescriptor/15.2.3.3-4-34.js
built-ins/Object/defineProperty/15.2.3.6-4-625gs.js
built-ins/Object/defineProperty/15.2.3.6-4-296-1.js
built-ins/Object/defineProperty/15.2.3.6-4-216.js
built-ins/Object/defineProperties/15.2.3.7-6-a-113.js
built-ins/Object/preventExtensions/15.2.3.10-2.js
built-ins/Object/defineProperty/15.2.3.6-4-154.js
built-ins/Object/defineProperty/15.2.3.6-4-155.js
built-ins/Object/defineProperties/15.2.3.7-2-16.js
built-ins/Object/defineProperty/15.2.3.6-4-185.js
built-ins/Object/defineProperty/15.2.3.6-4-208.js
built-ins/Object/defineProperty/15.2.3.6-4-116.js
built-ins/Object/getOwnPropertyDescriptor/15.2.3.3-4-4.js
built-ins/Object/defineProperties/15.2.3.7-6-a-204.js
built-ins/Object/getOwnPropertyNames/15.2.3.4-4-44.js
built-ins/Object/defineProperties/15.2.3.7-6-a-206.js
built-ins/Object/defineProperty/15.2.3.6-4-410.js
built-ins/Object/defineProperty/15.2.3.6-4-84.js
built-ins/Object/getOwnPropertyNames/15.2.3.4-4-b-6.js
built-ins/Object/defineProperties/15.2.3.7-6-a-209.js
built-ins/Object/defineProperties/15.2.3.7-5-b-8.js
built-ins/Object/getOwnPropertyDescriptor/15.2.3.3-4-116.js
built-ins/Object/defineProperty/15.2.3.6-4-212.js
built-ins/Object/defineProperty/15.2.3.6-4-570.js
built-ins/Object/getOwnPropertyNames/15.2.3.4-4-b-3.js
built-ins/Object/defineProperty/15.2.3.6-4-408.js
built-ins/Object/defineProperty/15.2.3.6-4-579.js
built-ins/Object/defineProperties/15.2.3.7-6-a-231.js
built-ins/Object/defineProperty/15.2.3.6-4-534.js
built-ins/Object/keys/15.2.3.14-5-a-4.js
built-ins/Object/create/15.2.3.5-4-263.js
built-ins/Object/defineProperties/15.2.3.7-6-a-179.js
built-ins/Object/defineProperties/15.2.3.7-6-a-150.js
built-ins/Object/defineProperty/15.2.3.6-3-138.js
built-ins/Object/defineProperty/15.2.3.6-4-581.js
built-ins/Object/defineProperty/15.2.3.6-4-251.js
built-ins/Object/defineProperty/15.2.3.6-4-195.js
built-ins/Object/defineProperty/15.2.3.6-4-594.js
built-ins/Object/defineProperty/15.2.3.6-4-292-1.js
built-ins/Object/defineProperty/15.2.3.6-4-210.js
built-ins/Object/keys/15.2.3.14-1-3.js
built-ins/Object/create/15.2.3.5-3-1.js
built-ins/Object/defineProperties/15.2.3.7-6-a-198.js
built-ins/Object/defineProperty/15.2.3.6-4-589.js
built-ins/Object/freeze/15.2.3.9-2-a-14.js
built-ins/Object/defineProperty/15.2.3.6-4-312.js
built-ins/Object/defineProperty/15.2.3.6-4-584.js
built-ins/Object/defineProperty/15.2.3.6-4-295-1.js
built-ins/Object/keys/15.2.3.14-6-5.js
built-ins/Object/defineProperty/15.2.3.6-4-293-3.js
built-ins/Object/defineProperty/15.2.3.6-4-293-2.js
</details>

## array-prototype — 60
- 8 × `assertion_fail:Test262Error: newArr.length Expected SameValue(«#», «#») to be true`
- 5 × `type_error:TypeError: Cannot access property on null or undefined`
- 4 × `assertion_fail:Test262Error: Expected a TypeError to be thrown but no exception was thrown at all`
- 4 × `assertion_fail:Test262Error: Expected a Test262Error to be thrown but no exception was thrown at all`
- 3 × `assertion_fail:Test262Error: The value of y[#] is expected to be # Expected SameValue(«undefined», «#») to be `
- 3 × `assertion_fail:Test262Error: x.toString() must return "[object Array]" Expected SameValue(«""», «"[object Arra`
- 2 × `other:requested new array is too large`
- 2 × `assertion_fail:Test262Error: The value of b[#] is expected to equal undefined Expected SameValue(«#», «undefin`
<details>files:
built-ins/Array/prototype/toString/S15.4.4.2_A3_T1.js
built-ins/Array/length/S15.4.2.2_A2.1_T1.js
built-ins/Array/S15.4_A1.1_T8.js
built-ins/Array/isArray/15.4.3.2-1-13.js
built-ins/Array/prototype/concat/S15.4.4.4_A2_T1.js
built-ins/Array/prototype/every/15.4.4.16-4-8.js
built-ins/Array/prototype/forEach/15.4.4.18-4-2.js
built-ins/Array/prototype/toString/S15.4.4.2_A1_T4.js
built-ins/Array/S15.4_A1.1_T7.js
built-ins/Array/prototype/every/15.4.4.16-4-15.js
built-ins/Array/prototype/filter/15.4.4.20-9-b-11.js
built-ins/Array/prototype/forEach/15.4.4.18-4-10.js
built-ins/Array/prototype/filter/15.4.4.20-9-b-3.js
built-ins/Array/isArray/15.4.3.2-1-5.js
built-ins/Array/S15.4_A1.1_T9.js
built-ins/Array/S15.4_A1.1_T4.js
built-ins/Array/isArray/15.4.3.2-1-9.js
built-ins/Array/isArray/15.4.3.2-2-3.js
built-ins/Array/S15.4_A1.1_T6.js
built-ins/Array/prototype/every/15.4.4.16-4-9.js
built-ins/Array/prototype/filter/15.4.4.20-9-b-4.js
built-ins/Array/prototype/forEach/15.4.4.18-3-23.js
built-ins/Array/prototype/forEach/15.4.4.18-4-15.js
built-ins/Array/prototype/toString/S15.4.4.2_A1_T2.js
built-ins/Array/prototype/filter/15.4.4.20-9-b-16.js
built-ins/Array/prototype/toString/S15.4.4.2_A1_T3.js
built-ins/Array/prototype/concat/S15.4.4.4_A3_T3.js
built-ins/Array/prototype/concat/S15.4.4.4_A1_T4.js
built-ins/Array/S15.4.2.1_A1.1_T2.js
built-ins/Array/S15.4.3_A1.1_T2.js
built-ins/Array/prototype/every/15.4.4.16-4-11.js
built-ins/Array/S15.4.3_A1.1_T1.js
built-ins/Array/prototype/concat/S15.4.4.4_A2_T2.js
built-ins/Array/prototype/filter/15.4.4.20-9-b-14.js
built-ins/Array/S15.4_A1.1_T5.js
built-ins/Array/S15.4_A1.1_T10.js
built-ins/Array/prototype/filter/15.4.4.20-5-7.js
built-ins/Array/prototype/toLocaleString/S15.4.4.3_A3_T1.js
built-ins/Array/prototype/concat/S15.4.4.4_A3_T2.js
built-ins/Array/prototype/concat/S15.4.4.4_A1_T2.js
built-ins/Array/prototype/filter/15.4.4.20-9-b-6.js
built-ins/Array/S15.4.1_A1.1_T2.js
built-ins/Array/prototype/filter/15.4.4.20-9-b-8.js
built-ins/Array/prototype/every/15.4.4.16-4-10.js
built-ins/Array/length/15.4.5.1-3.d-3.js
built-ins/Array/S15.4.1_A1.1_T3.js
built-ins/Array/length/S15.4.2.2_A1.1_T3.js
built-ins/Array/prototype/filter/15.4.4.20-9-b-15.js
built-ins/Array/length/S15.4.5.2_A3_T4.js
built-ins/Array/prototype/concat/S15.4.4.4_A3_T1.js
built-ins/Array/prototype/filter/15.4.4.20-9-b-12.js
built-ins/Array/length/S15.4.2.2_A1.1_T2.js
built-ins/Array/S15.4.5.2_A3_T3.js
built-ins/Array/prototype/filter/15.4.4.20-9-b-7.js
built-ins/Array/S15.4.5.2_A1_T1.js
built-ins/Array/prototype/filter/15.4.4.20-9-9.js
built-ins/Array/S15.4.2.1_A1.1_T3.js
built-ins/Array/prototype/filter/15.4.4.20-9-b-2.js
built-ins/Array/prototype/forEach/15.4.4.18-4-11.js
built-ins/Array/prototype/toLocaleString/S15.4.4.3_A1_T1.js
</details>

## function-prototype — 57
- 9 × `other:L#:## Codegen error: '__get_builtin' (dynamic-shape object/property operation) is not yet supported in -`
- 8 × `assertion_fail:Test262Error: Expected a TypeError to be thrown but no exception was thrown at all`
- 4 × `assertion_fail:Test262Error: The value of `typeof obj.touched` is expected to be "undefined" Expected SameValu`
- 3 × `type_error:TypeError: cannot read property 'length' of null`
- 2 × `assertion_fail:Test262Error: The value of this["feat"] is expected to be "kamon beyba" Expected SameValue(«und`
- 2 × `assertion_fail:Test262Error: The result of evaluating (e instanceof TypeError) is expected to be true`
- 2 × `type_error:TypeError: Cannot access property on null or undefined at #:#`
- 2 × `assertion_fail:Test262Error: The value of obj.touched is expected to be true`
<details>files:
built-ins/Function/15.3.5.4_2-20gs.js
built-ins/Function/prototype/call/S15.3.4.4_A6_T5.js
built-ins/Function/15.3.5.4_2-8gs.js
built-ins/Function/15.3.5.4_2-45gs.js
built-ins/Function/prototype/apply/S15.3.4.3_A3_T6.js
built-ins/Function/prototype/call/S15.3.4.4_A6_T6.js
built-ins/Function/prototype/S15.3.5.2_A1_T1.js
built-ins/Function/prototype/call/S15.3.4.4_A6_T9.js
built-ins/Function/15.3.5.4_2-42gs.js
built-ins/Function/prototype/call/S15.3.4.4_A5_T2.js
built-ins/Function/prototype/bind/15.3.4.5-2-7.js
built-ins/Function/prototype/call/S15.3.4.4_A7_T5.js
built-ins/Function/prototype/call/S15.3.4.4_A7_T6.js
built-ins/Function/S15.3_A3_T5.js
built-ins/Function/S15.3.5_A1_T2.js
built-ins/Function/prototype/apply/S15.3.4.3_A5_T8.js
built-ins/Function/prototype/call/S15.3.4.4_A1_T1.js
built-ins/Function/prototype/S15.3.4_A1.js
built-ins/Function/prototype/call/S15.3.4.4_A5_T8.js
built-ins/Function/prototype/toString/S15.3.4.2_A16.js
built-ins/Function/S15.3.5_A1_T1.js
built-ins/Function/S15.3_A3_T3.js
built-ins/Function/S15.3.3_A2_T2.js
built-ins/Function/prototype/apply/S15.3.4.3_A5_T1.js
built-ins/Function/S15.3_A3_T2.js
built-ins/Function/prototype/apply/S15.3.4.3_A1_T1.js
built-ins/Function/prototype/apply/S15.3.4.3_A7_T9.js
built-ins/Function/prototype/apply/S15.3.4.3_A8_T6.js
built-ins/Function/S15.3_A3_T1.js
built-ins/Function/prototype/apply/S15.3.4.3_A8_T5.js
built-ins/Function/prototype/bind/15.3.4.5-2-6.js
built-ins/Function/prototype/apply/S15.3.4.3_A7_T6.js
built-ins/Function/S15.3.2.1_A1_T10.js
built-ins/Function/S15.3.2.1_A3_T3.js
built-ins/Function/prototype/S15.3.3.1_A3.js
built-ins/Function/prototype/apply/S15.3.4.3_A5_T2.js
built-ins/Function/S15.3.2.1_A2_T6.js
built-ins/Function/15.3.5.4_2-96gs.js
built-ins/Function/prototype/call/S15.3.4.4_A1_T2.js
built-ins/Function/S15.3_A3_T4.js
built-ins/Function/prototype/call/S15.3.4.4_A5_T1.js
built-ins/Function/prototype/call/S15.3.4.4_A6_T2.js
built-ins/Function/S15.3_A2_T1.js
built-ins/Function/S15.3.2.1_A3_T15.js
built-ins/Function/S15.3.3_A3.js
built-ins/Function/prototype/call/S15.3.4.4_A6_T1.js
built-ins/Function/15.3.5.4_2-10gs.js
built-ins/Function/prototype/apply/S15.3.4.3_A1_T2.js
built-ins/Function/15.3.5.4_2-95gs.js
built-ins/Function/prototype/apply/S15.3.4.3_A7_T5.js
built-ins/Function/S15.3.3_A1.js
built-ins/Function/prototype/S15.3.4_A3_T1.js
built-ins/Function/S15.3_A2_T2.js
built-ins/Function/S15.3_A3_T6.js
built-ins/Function/prototype/bind/S15.3.4.5_A5.js
built-ins/Function/15.3.5.4_2-97gs.js
built-ins/Function/prototype/call/S15.3.4.4_A3_T6.js
</details>

## with-statement — 44
- 13 × `null_deref:dereferencing a null pointer [in __str_concat() ← __module_init]`
- 10 × `other:L#:## ##: with statement requires a proven closed object-literal shape before codegen; constructible clo`
- 4 × `assertion_fail:Test262Error: ##: result === undefined. Actual: result ===null`
- 3 × `assertion_fail:Test262Error: ##: st_parseInt === parseInt. Actual: st_parseInt ===function () { [native code] `
- 2 × `assertion_fail:Test262Error: ##: theirObj.p1 === "x1". Actual: theirObj.p1 ===true`
- 1 × `assertion_fail:Test262Error: ##: myObj.p1 === "a". Actual: myObj.p1 ===x1`
- 1 × `assertion_fail:Test262Error: ##: p2 === #. Actual: p2 ===x2`
- 1 × `assertion_fail:Test262Error: ##: myObj.p1 === undefined . Actual: myObj.p1 ===[object Object]`
<details>files:
language/statements/with/S12.10_A3.4_T2.js
language/statements/with/S12.10_A3.10_T2.js
language/statements/with/S12.10_A3.5_T5.js
language/statements/with/S12.10_A1.11_T3.js
language/statements/with/S12.10_A1.11_T4.js
language/statements/with/S12.10_A3.8_T4.js
language/statements/with/S12.10_A1.5_T5.js
language/statements/with/S12.10_A3.8_T5.js
language/statements/with/S12.10_A3.2_T4.js
language/statements/with/S12.10_A5_T4.js
language/statements/with/S12.10_A3.1_T3.js
language/statements/with/S12.10_A1.11_T5.js
language/statements/with/S12.10_A3.1_T2.js
language/statements/with/S12.10_A1.12_T3.js
language/statements/with/S12.10_A3.5_T2.js
language/statements/with/S12.10_A5_T5.js
language/statements/with/S12.10_A3.8_T1.js
language/statements/with/S12.10_A3.4_T3.js
language/statements/with/S12.10_A3.7_T5.js
language/statements/with/S12.10_A1.7_T3.js
language/statements/with/S12.10_A3.6_T1.js
language/statements/with/S12.10_A3.10_T3.js
language/statements/with/S12.10_A3.6_T2.js
language/statements/with/S12.10_A1.8_T4.js
language/statements/with/S12.10_A1.8_T5.js
language/statements/with/12.10-0-8.js
language/statements/with/S12.10_A5_T1.js
language/statements/with/S12.10_A3.2_T5.js
language/statements/with/S12.10_A3.8_T2.js
language/statements/with/S12.10_A4_T4.js
language/statements/with/S12.10_A3.7_T4.js
language/statements/with/S12.10_A1.8_T2.js
language/statements/with/S12.10_A1.11_T1.js
language/statements/with/S12.10_A1.8_T3.js
language/statements/with/S12.10_A1.11_T2.js
language/statements/with/S12.10_A3.8_T3.js
language/statements/with/S12.10_A1.8_T1.js
language/statements/with/S12.10_A4_T6.js
language/statements/with/S12.10_A3.3_T4.js
language/statements/with/S12.10_A5_T3.js
language/statements/with/S12.10_A4_T5.js
language/statements/with/S12.10_A3.5_T3.js
language/statements/with/S12.10_A5_T6.js
language/statements/with/S12.10_A5_T2.js
</details>

## string-prototype — 43
- 2 × `other:L#:## Codegen error: String.prototype.replace(...) with a RegExp or symbol-protocol search value is not `
- 2 × `assertion_fail:Test262Error: ##: Exception === 'intostring'. Actual: exception ===[object Object]`
- 2 × `assertion_fail:Test262Error: The value of __split.length is # Expected SameValue(«#», «#») to be true`
- 1 × `assertion_fail:Test262Error: ##: __instance.charCodeAt(eval("#"),true,null,{})=== 0x#. Actual: __instance.char`
- 1 × `assertion_fail:Test262Error: ##: __instance.substring(#, #) === "undefined". Actual: [object Object]`
- 1 × `type_error:TypeError: is not a constructor`
- 1 × `assertion_fail:Test262Error: ##: __str = new String(new Array(#,#,#)); __str =="#,#,#". Actual: __str ==[objec`
- 1 × `assertion_fail:Test262Error: The value of __split[#] is "[object Math]" Expected SameValue(«"[object Object]"»`
<details>files:
built-ins/String/prototype/charCodeAt/S15.5.4.5_A1.1.js
built-ins/String/prototype/substring/S15.5.4.15_A3_T10.js
built-ins/String/prototype/constructor/S15.5.4.1_A1_T2.js
built-ins/String/S15.5.2.1_A1_T19.js
built-ins/String/prototype/split/instance-is-math.js
built-ins/String/prototype/S15.5.4_A3.js
built-ins/String/prototype/replace/S15.5.4.11_A1_T10.js
built-ins/String/prototype/replace/S15.5.4.11_A1_T9.js
built-ins/String/prototype/replace/S15.5.4.11_A1_T5.js
built-ins/String/S15.5.1.1_A1_T8.js
built-ins/String/prototype/trim/15.5.4.20-2-51.js
built-ins/String/prototype/charCodeAt/S15.5.4.5_A4.js
built-ins/String/S15.5.5.1_A3.js
built-ins/String/S15.5.2.1_A1_T11.js
built-ins/String/fromCharCode/S15.5.3.2_A3_T2.js
built-ins/String/S15.5.5.1_A4_T2.js
built-ins/String/prototype/split/instance-is-number-1e21.js
built-ins/String/prototype/slice/S15.5.4.13_A1_T5.js
built-ins/String/prototype/replace/S15.5.4.11_A1_T2.js
built-ins/String/S15.5.2.1_A1_T9.js
built-ins/String/S15.5.5.1_A5.js
built-ins/String/prototype/replace/S15.5.4.11_A1_T6.js
built-ins/String/fromCharCode/S15.5.3.2_A4.js
built-ins/String/prototype/replace/S15.5.4.11_A1_T8.js
built-ins/String/prototype/charAt/S15.5.4.4_A5.js
built-ins/String/prototype/slice/S15.5.4.13_A3_T4.js
built-ins/String/prototype/split/arguments-are-boolean-expression-function-call-and-null-and-instance-is-boolean.js
built-ins/String/prototype/trim/15.5.4.20-2-43.js
built-ins/String/prototype/S15.5.4_A1.js
built-ins/String/prototype/split/separator-regexp-limit-string-via-eval.js
built-ins/String/S15.5.1.1_A1_T6.js
built-ins/String/prototype/split/argument-is-regexp-and-instance-is-number.js
built-ins/String/S15.5.1.1_A1_T9.js
built-ins/String/S15.5.3_A2_T2.js
built-ins/String/prototype/concat/S15.5.4.6_A4_T1.js
built-ins/String/prototype/concat/S15.5.4.6_A1_T10.js
built-ins/String/prototype/concat/S15.5.4.6_A2.js
built-ins/String/prototype/substring/S15.5.4.15_A1_T5.js
built-ins/String/S15.5.2.1_A1_T10.js
built-ins/String/prototype/charAt/S15.5.4.4_A1.1.js
built-ins/String/S15.5.2.1_A2_T1.js
built-ins/String/fromCharCode/S15.5.3.2_A1.js
built-ins/String/S15.5.2.1_A1_T8.js
</details>

## stmt-function — 33
- 2 × `assertion_fail:Test262Error: ##: obj.prop === "A". Actual: obj.prop ===null`
- 2 × `assertion_fail:Test262Error: ##: __PROTO.isPrototypeOf(__monster) must be true`
- 2 × `assertion_fail:Test262Error: ##: callee === #. Actual: callee ===#`
- 2 × `assertion_fail:Test262Error: ##: __instance.first === undefined. Actual: __instance.first ===one`
- 1 × `type_error:TypeError: Cannot destructure 'null' or 'undefined'`
- 1 × `assertion_fail:Test262Error: ##: x === "#". Actual: x ===#`
- 1 × `assertion_fail:Test262Error: ##: __obj__.first === undefined. Actual: __obj__.first===one`
- 1 × `type_error:TypeError: Cannot access property on null or undefined at #:#`
<details>files:
language/statements/function/13.2-18-1.js
language/statements/function/S13.2.2_A15_T2.js
language/statements/function/S13_A2_T2.js
language/statements/function/S13.2.2_A7_T1.js
language/statements/function/S13.2.2_A5_T1.js
language/statements/function/S13.2.1_A5_T2.js
language/statements/function/S13.2.2_A17_T2.js
language/statements/function/S13_A11_T4.js
language/statements/function/13.2-17-1.js
language/statements/function/S13_A15_T3.js
language/statements/function/S13.2.2_A19_T8.js
language/statements/function/S13.2.2_A1_T2.js
language/statements/function/S13.2_A2_T1.js
language/statements/function/S13.2.2_A1_T1.js
language/statements/function/S13.2.2_A15_T3.js
language/statements/function/S13.2.2_A18_T2.js
language/statements/function/S13.2.2_A15_T1.js
language/statements/function/S13.2.2_A19_T7.js
language/statements/function/S13.2_A4_T2.js
language/statements/function/S13.2.2_A17_T3.js
language/statements/function/S13.2.2_A18_T1.js
language/statements/function/S13.2.1_A6_T2.js
language/statements/function/S13.2.2_A2.js
language/statements/function/S13.2.2_A11.js
language/statements/function/S13.2.2_A15_T4.js
language/statements/function/S13.2.2_A8_T3.js
language/statements/function/S13.2.2_A8_T2.js
language/statements/function/S13_A15_T2.js
language/statements/function/S13.2.2_A12.js
language/statements/function/S13_A6_T1.js
language/statements/function/S13.2.2_A4_T2.js
language/statements/function/S13.2.2_A8_T1.js
language/statements/function/S13.2_A2_T2.js
</details>

## object-misc — 31
- 2 × `type_error:TypeError: n_obj is not a function`
- 2 × `assertion_fail:Test262Error: ##: var __map={}; "foo" in __map`
- 2 × `assertion_fail:Test262Error: Expected SameValue(«null», «NaN») to be true`
- 2 × `assertion_fail:Test262Error: Object.isFrozen(child) !== true`
- 2 × `assertion_fail:Test262Error: The value of n_obj.constructor is expected to equal the value of Function Expecte`
- 1 × `assertion_fail:Test262Error: n_obj.getFullYear() must return # Expected SameValue(«undefined», «#») to be true`
- 1 × `assertion_fail:Test262Error: ##: obj_ = {bar:true}; obj_.some = #; obj_.foo = "a"; count=#; for (property in o`
- 1 × `type_error:TypeError: Boolean.prototype.valueOf is not yet implemented in --target standalone`
<details>files:
built-ins/Object/S15.2.2.1_A2_T6.js
language/types/object/S8.6_A3_T2.js
built-ins/Object/S15.2.2.1_A2_T5.js
language/types/object/S8.6_A3_T1.js
language/types/object/S8.6_A4_T1.js
built-ins/Object/S15.2.2.1_A2_T2.js
built-ins/Object/S9.9_A3.js
built-ins/Object/isFrozen/15.2.3.12-2-1.js
language/types/object/S8.6_A2_T1.js
built-ins/Object/isFrozen/15.2.3.12-2-2.js
language/types/object/S8.6_A2_T2.js
language/types/object/S8.6.2_A8.js
built-ins/Object/S9.9_A5.js
built-ins/Object/S15.2.1.1_A2_T11.js
built-ins/Object/S15.2_A1.js
language/types/object/S8.6.2_A5_T4.js
built-ins/Object/prototype/constructor/S15.2.4.1_A1_T2.js
built-ins/Object/S15.2.2.1_A2_T7.js
built-ins/Object/prototype/valueOf/S15.2.4.4_A1_T1.js
built-ins/Object/prototype/S15.2.4_A1_T2.js
built-ins/Object/S9.9_A4.js
language/types/object/S8.6.2_A5_T3.js
language/types/object/S8.6.2_A5_T2.js
language/types/object/S8.6.2_A1.js
language/types/object/S8.6.2_A2.js
built-ins/Object/prototype/valueOf/S15.2.4.4_A14.js
built-ins/Object/prototype/valueOf/S15.2.4.4_A1_T3.js
language/types/object/S8.6.2_A5_T1.js
built-ins/Object/prototype/valueOf/S15.2.4.4_A1_T2.js
built-ins/Object/isFrozen/15.2.3.12-3-28.js
built-ins/Object/isExtensible/15.2.3.13-2-13.js
</details>

## scope-chain — 27
- 6 × `assertion_fail:Test262Error: ##: Scope chain disturbed`
- 3 × `other:'this' had incorrect value!`
- 3 × `assertion_fail:Test262Error: Expected true but got false`
- 2 × `illegal_cast:illegal cast [in __module_init()]`
- 2 × `type_error:TypeError: not a function`
- 1 × `assertion_fail:Test262Error: Expected SameValue(«undefined», «[object Object]») to be true`
- 1 × `assertion_fail:Test262Error: (#).x === #`
- 1 × `other:ReferenceError: y is not defined`
<details>files:
language/function-code/S10.2.1_A4_T2.js
language/function-code/10.4.3-1-82gs.js
language/function-code/10.4.3-1-104.js
language/function-code/10.4.3-1-82-s.js
language/identifier-resolution/S10.2.2_A1_T7.js
language/identifier-resolution/S11.1.2_A1_T1.js
language/identifier-resolution/S10.2.2_A1_T9.js
language/identifier-resolution/S10.2.2_A1_T8.js
language/function-code/10.4.3-1-84gs.js
language/function-code/10.4.3-1-102-s.js
language/function-code/S10.2.1_A4_T1.js
language/function-code/S10.2.1_A1.js
language/function-code/10.4.3-1-64-s.js
language/function-code/10.4.3-1-17-s.js
language/identifier-resolution/S10.2.2_A1_T3.js
language/function-code/10.4.3-1-102gs.js
language/function-code/10.4.3-1-106.js
language/function-code/S10.2.1_A5.2_T1.js
language/function-code/10.4.3-1-20-s.js
language/function-code/S10.2.1_A3.js
language/function-code/10.4.3-1-103.js
language/identifier-resolution/S10.2.2_A1_T6.js
language/function-code/10.4.3-1-83-s.js
language/function-code/10.4.3-1-65-s.js
language/function-code/10.4.3-1-83gs.js
language/identifier-resolution/S10.2.2_A1_T5.js
language/function-code/10.4.3-1-84-s.js
</details>

## regexp-core — 19
- 2 × `type_error:TypeError: Unsupported dynamic regular expression pattern`
- 1 × `assertion_fail:Test262Error: Expected obj[multiline] NOT to be writable, but was.`
- 1 × `other:L#:## Codegen error: RegExp.indicator built-in static property value read is not supported in --target s`
- 1 × `assertion_fail:Test262Error: __re.hasOwnProperty('ignoreCase') must return false Expected SameValue(«true», «f`
- 1 × `assertion_fail:Test262Error: __re.toString() must return "[object "+"RegExp"+"]" Expected SameValue(«"/(?:)/"»`
- 1 × `assertion_fail:Test262Error: ##: XML Shallow Parsing with Regular Expression: [^<]+`
- 1 × `assertion_fail:Test262Error: __re.hasOwnProperty('global') must return false Expected SameValue(«true», «false`
- 1 × `assertion_fail:Test262Error: Expected obj[global] NOT to be writable, but was.`
<details>files:
built-ins/RegExp/S15.10.2.8_A3_T16.js
built-ins/RegExp/prototype/multiline/S15.10.7.4_A10.js
built-ins/RegExp/S15.10.5_A2_T2.js
built-ins/RegExp/prototype/ignoreCase/S15.10.7.3_A9.js
built-ins/RegExp/S15.10.2.8_A3_T15.js
built-ins/RegExp/S15.10.4.1_A6_T1.js
built-ins/RegExp/S15.10.2_A1_T1.js
built-ins/RegExp/prototype/global/S15.10.7.2_A9.js
built-ins/RegExp/prototype/global/S15.10.7.2_A10.js
language/literals/regexp/S7.8.5_A2.4_T2.js
language/literals/regexp/S7.8.5_A1.4_T2.js
built-ins/RegExp/prototype/ignoreCase/S15.10.7.3_A10.js
built-ins/RegExp/prototype/S15.10.6.1_A1_T2.js
language/literals/regexp/S7.8.5_A1.1_T2.js
built-ins/RegExp/prototype/exec/S15.10.6.2_A1_T20.js
built-ins/RegExp/prototype/exec/S15.10.6.2_A4_T11.js
built-ins/RegExp/prototype/multiline/S15.10.7.4_A9.js
built-ins/RegExp/prototype/exec/S15.10.6.2_A4_T7.js
language/literals/regexp/S7.8.5_A2.1_T2.js
</details>

## error-number-boolean-date — 18
- 2 × `type_error:TypeError: Number.prototype.toString is not yet implemented in --target standalone`
- 1 × `assertion_fail:Test262Error: s Expected SameValue(«"[object Object]"», «"[object Number]"») to be true`
- 1 × `assertion_fail:Test262Error: errObj.toString() Expected SameValue(«"Error"», «"ErrorName"») to be true`
- 1 × `assertion_fail:Test262Error: Object.getPrototypeOf("JSON.parse('{"__proto__":[]}')") returns Object.prototype `
- 1 × `type_error:TypeError: Object.prototype.toString is not yet implemented in --target standalone`
- 1 × `assertion_fail:Test262Error: Expected errObj.name to be '', actually Error`
- 1 × `host_import_leak:standalone target emitted host imports: env::Math_random (##)`
- 1 × `type_error:TypeError: called value is not a function`
<details>files:
built-ins/Number/15.7.4-1.js
built-ins/Error/prototype/toString/15.11.4.4-9-1.js
built-ins/Number/prototype/S15.7.3.1_A2_T1.js
built-ins/Number/prototype/S15.7.4_A1.js
built-ins/JSON/parse/S15.12.2_A1.js
built-ins/Number/prototype/S15.7.3.1_A2_T2.js
built-ins/Error/prototype/toString/15.11.4.4-8-2.js
built-ins/Math/random/S15.8.2.14_A1.js
built-ins/Number/S15.7.2.1_A4.js
built-ins/Boolean/prototype/toString/S15.6.4.2_A1_T1.js
built-ins/Error/length.js
built-ins/Boolean/prototype/toString/S15.6.4.2_A1_T2.js
built-ins/Error/prototype/toString/15.11.4.4-8-1.js
built-ins/Error/prototype/toString/15.11.4.4-10-1.js
built-ins/Boolean/prototype/toString/S15.6.4.2_A2_T5.js
built-ins/Error/prototype/constructor/S15.11.4.1_A1_T2.js
built-ins/Number/prototype/toString/S15.7.4.2_A1_T01.js
built-ins/Date/S15.9.2.1_A2.js
</details>

## harness-files — 11
- 3 × `other:Test262:AsyncTestFailure:Test262Error: [object Object]`
- 1 × `assertion_fail:Test262Error: Actual [false, false, false, false, false, false] and expected [true, true, true,`
- 1 × `type_error:TypeError: String.prototype.valueOf is not yet implemented in --target standalone`
- 1 × `assertion_fail:Test262Error: Expected SameValue(«true», «false») to be true`
- 1 × `assertion_fail:Test262Error: Expected Map {} to be structurally equal to Map {}.`
- 1 × `assertion_fail:Test262Error: Expected true but got false`
- 1 × `other:Error: Expected a Test262Error, but a "undefined" was thrown.`
- 1 × `null_deref:dereferencing a null pointer [in __closure_104() ← asyncTest ← __fn_tramp_asyncTest_cached ← __call`
<details>files:
harness/asyncHelpers-asyncTest-return-not-thenable.js
harness/asyncHelpers-asyncTest-returns-undefined.js
harness/deepEqual-primitives.js
harness/asyncHelpers-asyncTest-then-rejects.js
harness/asyncHelpers-asyncTest-then-resolves.js
harness/verifyProperty-restore-accessor.js
harness/deepEqual-mapset.js
harness/wellKnownIntrinsicObjects.js
harness/detachArrayBuffer-host-detachArrayBuffer.js
harness/asyncHelpers-throwsAsync-same-realm.js
harness/assert-throws-same-realm.js
</details>

## annexB-b33-hoisting — 8
- 3 × `type_error:TypeError: f is not a function`
- 3 × `illegal_cast:illegal cast [in f() ← __module_init]`
- 1 × `assertion_fail:Test262Error: Expected a SyntaxError to be thrown but no exception was thrown at all`
- 1 × `other:ReferenceError: arguments is not defined`
<details>files:
annexB/language/global-code/switch-dflt-global-existing-var-update.js
annexB/language/function-code/switch-dflt-func-block-scoping.js
annexB/language/global-code/script-decl-lex-collision.js
annexB/language/global-code/switch-case-global-existing-var-update.js
annexB/language/function-code/block-decl-func-block-scoping.js
annexB/language/function-code/block-decl-func-skip-arguments.js
annexB/language/function-code/switch-case-func-block-scoping.js
annexB/language/global-code/block-decl-global-existing-var-update.js
</details>

## annexB-date — 6
- 1 × `assertion_fail:Test262Error: Expected SameValue(«"undefined"», «"function"») to be true`
- 1 × `assertion_fail:Test262Error: Expected a TypeError to be thrown but no exception was thrown at all`
- 1 × `assertion_fail:Test262Error: Expected SameValue(«undefined», «function () { [native code] }») to be true`
- 1 × `assertion_fail:Test262Error: toGMTString should be an own property`
- 1 × `assertion_fail:Test262Error: setYear should be an own property`
- 1 × `assertion_fail:Test262Error: y = -# Expected SameValue(«#», «#») to be true`
<details>files:
annexB/built-ins/Date/prototype/setYear/this-not-date.js
annexB/built-ins/Date/prototype/setYear/year-to-number-err.js
annexB/built-ins/Date/prototype/toGMTString/value.js
annexB/built-ins/Date/prototype/toGMTString/prop-desc.js
annexB/built-ins/Date/prototype/setYear/B.2.5.js
annexB/built-ins/Date/prototype/setYear/year-number-relative.js
</details>

## residue — 6
- 2 × `assertion_fail:Test262Error: Expected a TypeError to be thrown but no exception was thrown at all`
- 2 × `assertion_fail:Test262Error: ##: encodeURI === null`
- 2 × `assertion_fail:Test262Error: ##: Date === null`
<details>files:
built-ins/global/10.2.1.1.3-4-16-s.js
built-ins/global/S10.2.3_A1.2_T2.js
built-ins/global/S10.2.3_A1.2_T3.js
built-ins/global/S10.2.3_A1.1_T2.js
built-ins/global/S10.2.3_A1.1_T3.js
built-ins/global/10.2.1.1.3-4-18-s.js
</details>

## annexB-other — 5
- 1 × `assertion_fail:Test262Error: Expected SameValue(«#», «#») to be true`
- 1 × `assertion_fail:Test262Error: Expected SameValue(«function () { [native code] }», «#») to be true`
- 1 × `assertion_fail:Test262Error: Expected SameValue(«"initializer in catch"», «"prior to throw"») to be true`
- 1 × `assertion_fail:Test262Error: Expected SameValue(«null», «"prior to throw"») to be true`
- 1 × `assertion_fail:Test262Error: "a".substr(#, NaN) Expected SameValue(«""», «"a"») to be true`
<details>files:
annexB/language/statements/for-in/nonstrict-initializer.js
annexB/language/eval-code/direct/script-decl-lex-no-collision.js
annexB/language/statements/try/catch-redeclared-var-statement.js
annexB/language/statements/try/catch-redeclared-var-statement-captured.js
annexB/built-ins/String/prototype/substr/start-and-length-as-numbers.js
</details>

## annexB-escape-unescape — 4
- 2 × `assertion_fail:Test262Error: Expected SameValue(«null», «"undefined"») to be true`
- 1 × `assertion_fail:Test262Error: unescape should be an own property`
- 1 × `assertion_fail:Test262Error: escape should be an own property`
<details>files:
annexB/built-ins/unescape/argument_types.js
annexB/built-ins/unescape/prop-desc.js
annexB/built-ins/escape/argument_types.js
annexB/built-ins/escape/prop-desc.js
</details>

## compile-timeout — 4
- 4 × `compile_timeout:timeout (10s)`
<details>files:
language/comments/S7.4_A5.js
language/statements/for/S12.6.3_A10.1_T1.js
language/statements/for/S12.6.3_A10_T1.js
language/comments/S7.4_A6.js
</details>

## annexB-regexp — 3
- 1 × `type_error:TypeError: Unsupported dynamic regular expression pattern`
- 1 × `assertion_fail:Test262Error: Code unit: # Expected SameValue(«undefined», «"\\\u0000"») to be true`
- 1 × `assertion_fail:Test262Error: Code unit: # Expected SameValue(«undefined», «"a\\\u0000"») to be true`
<details>files:
annexB/built-ins/RegExp/RegExp-control-escape-russian-letter.js
annexB/built-ins/RegExp/RegExp-leading-escape-BMP.js
annexB/built-ins/RegExp/RegExp-trailing-escape-BMP.js
</details>


## language-misc sub-triage (110 → mechanisms)

First-match path split with dominant signature per bucket (files in the
language-misc list above):

| sub-bucket | n | dominant mechanism hypothesis |
|---|---|---|
| types/object + expressions/in | 15 | `in` operator on plain `{}` (prototype-chain membership, `"valueOf" in __obj` false) |
| expressions/assignment | 10 | compound assignment + descriptor interplay |
| equals/does-not-equals/relational/addition/less-than… | ~12 | ToPrimitive (valueOf/toString) on objects in binary operators; function-to-string in `f1 + ""` |
| expressions/instanceof | 7 | `[[HasInstance]]` on non-Function / Function objects |
| property-accessors + call | 11 | member access on undefined/null must throw TypeError (not Test262Error path); `undefined.toString()` |
| arguments-object | 7 | `callee` own property, strict descriptor, arguments existence in nested scopes |
| statements/variable | 5 | function-vs-var binding shadowing (`__func === undefined`) |
| do-while/while/return/switch | ~11 | completion values / evaluation order (`__evaluated`) |
| prefix/postfix ++/-- + types/reference | ~10 | ReferenceError on unresolvable reference; ToNumber ordering |
| statements/try | 3 | property access on null in catch paths |
| misc singletons | ~19 | individually diffuse |

These are hypotheses from signatures — verify per-file before sizing (the #3626
method warnings apply: signature = where the test stopped, not which defect).

## Coverage map (2026-08-16 sweep vs issue inventory + claim ledger)

Live claims (2026-08-15, DO NOT DISPATCH): `ttraenkler/claude-es5-standalone`
holds #4465/#4479/#4483/#4484/#4485 (String generic-methods, plain-object
descriptor attrs, Function residual, instanceof, builtin-surface smalls);
`claude/es5-team-with` holds #4206 (with). Reserved-only (id taken, nobody
working): #4491, #4492, #4500.

| cluster | owner issue(s) | dispatchable now |
|---|---|---|
| with-statement (44) | #4206 (live claim), #671, #4231 | route around |
| defineProperty-family (86) | #4479 (live), #4491 (reserved), **#2668 (unclaimed)**, #3475 (stale) | #2668 |
| array-prototype (60) | fragmented: #4119 (stale), #4492 (reserved), #4366/#3531 (near-dups), #4160, #2036, #3446 (array-too-large) | consolidate first — no owner |
| function-prototype (57) | #4483 (live), #4043, #3544 (stale), #4196 (stale), #4265; substrate: **#1888 (unclaimed)** | #1888 substrate; avoid #4483's ~30-file bucket |
| string-prototype (43) | #4465 (live), **#4056 (unclaimed)**, #4095 (easy/S, unclaimed), #4005 | #4056/#4095 with care vs #4465 |
| annexB-b33 (8) | #2552/#2200 (June claims, stale; #2552 carries a −1180 regression warning — re-ground before touching) | cautious |
| toString/valueOf standalone (≈18) | Number: **#3175 (unclaimed)**; Object: #4119; String: **#3524 (re-scoped today)** | #3175, #3524 |
| scope-chain (27) | #4206 + #4232 (folded into with/10.4.3 lanes) | route around |
| harness-files (11) | #4251 (standalone cohort, in-progress) — asyncHelpers + verifyProperty-restore-accessor added to its scope via #4516 note | extend #4251 |
| annexB date/escape/unescape (10) | #4485 §C (live) owns getYear/setYear; escape/unescape had NO open issue → #4516 | #4516 (escape/unescape only) |

Duplicates cleaned this pass: #4168 → wont-fix (≡ #4025, done);
#4171 → wont-fix (≡ #4021). Both edits in this PR.
