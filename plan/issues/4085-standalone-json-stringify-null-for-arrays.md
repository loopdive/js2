---
id: 4085
title: "JSON.stringify emits the literal `null` for every non-empty array, class instance and object-holding-an-array in standalone — silently corrupt output"
status: ready
sprint: current
created: 2026-08-02
updated: 2026-08-02
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: standalone
language_feature: json
goal: standalone-mode
related: [4071, 4080, 2166]
---

# `JSON.stringify` returns `"null"` for ordinary arrays in standalone

Found while working #4071 (own-property enumeration). **Distinct defect, distinct
helper** — it did NOT move when `__object_keys` was fixed, which refutes the
premise that these surfaces share one substrate.

## Defect

Measured in `--target standalone`, scored **inside Wasm** against the
spec-correct literal (so no native-string boundary artifact), with the compiler's
`gc` lane as a control:

| input | expected | gc | standalone |
| --- | --- | --- | --- |
| `JSON.stringify([10,20,30])` | `[10,20,30]` | correct | **`null`** |
| `JSON.stringify([[1],[2]])` | `[[1],[2]]` | correct | **wrong** |
| `JSON.stringify(["a","b"])` | `["a","b"]` | correct | **wrong** |
| `JSON.stringify({a:[1,2]})` | `{"a":[1,2]}` | correct | **wrong** |
| `JSON.stringify(new C())` (class inst.) | `{"a":1,"b":2}` | correct | **wrong** |
| `JSON.stringify(o)` where `o={}; o.p=1; o.q=2` | `{"p":1,"q":2}` | correct | **wrong** |
| `JSON.stringify([])` | `[]` | correct | correct |
| `JSON.stringify({a:1,b:2})` (literal) | `{"a":1,"b":2}` | correct | correct |

This is **silently corrupt output for ordinary user code**, not a spec-corner
failure and not a refusal: no compile error, no host-import leak, nothing
downstream can detect it. Only an *empty* array and a *literal* plain object
survive — i.e. exactly the shapes a smoke test is most likely to try.

## Root cause (identified, not yet fixed)

`src/codegen/json-codec-native.ts` dispatches on `ref.test` against
`objectTypeIdx` (`$Object`), `objVecTypeIdx` (`$ObjVec`), `anyStrTypeIdx`,
`boxNumTypeIdx`, `boxBoolTypeIdx` and `anyValueTypeIdx`. It **never tests
`$__vec_base`** — the file does not import `getOrRegisterVecBaseType` at all.

A real standalone JS array is a `__vec_<elemKind>` struct subtyping
`$__vec_base` (#2186); `$ObjVec` is the **enumeration-result** vector, a
different type. So a user array matches no arm, falls through to the
"unsupported ref ⇒ undefined serialisation" path, and the root arm renders the
JSON literal `null`. Class instances and widened plain objects are closed
nominal structs and miss for the same reason.

Note the array-serialisation logic **already exists** and is correct — it is
written against `$ObjVec` (json-codec-native.ts ~L453-459). The user-array
carrier was simply never wired to it.

## Why this is filed separately

Same *pattern* as #4071 but a different helper, different file, and its own blast
radius (every `JSON.stringify` call site). #4071 shipped a measured
`__object_keys` fix; bolting this on unmeasured would have violated the
blast-radius discipline that issue was filed with.

## Pattern note

This is another instance of the family #4080 tracks: **a correct implementation
exists nearby and one consumer was never wired to it** (cf. #3989, #4077, #4079,
#4081, #4071). Worth noting for #4080's framing: a `malformed_wasm`-style
invariant would NOT catch this — the emitted Wasm is perfectly valid and simply
returns the wrong string. Catching it needs a **value-level** differential
oracle (gc lane vs standalone lane on the same input), not a validity check.

## Acceptance criteria

1. `JSON.stringify([10,20,30])` returns `[10,20,30]` in standalone.
2. Nested arrays, arrays of strings, and objects holding arrays round-trip.
3. Class instances and assignment-built objects serialise their own enumerable
   string keys.
4. Per-surface before/after flip counts against a force-refreshed standalone
   baseline, denominator stated. Report flips, not file counts.
5. Empty array / literal plain object (the two shapes that work today) must not
   regress.
