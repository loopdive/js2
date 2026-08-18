---
id: 4085
title: "JSON.stringify emits the literal `null` for every non-empty array, class instance and object-holding-an-array in standalone — silently corrupt output"
status: done
sprint: 78
created: 2026-08-02
updated: 2026-08-18
completed: 2026-08-02
assignee: ttraenkler/L-enum
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: standalone
language_feature: json
goal: standalone-mode
related: [4071, 4080, 2166]
# The arm must live in the emitter that builds `__json_stringify_value`, beside
# the `$Object` / `$ObjVec` / `$AnyString` arms it is one more case of, and it
# re-points the shared `L_ANY` local so the existing `$ObjVec` arm runs. Hoisting
# it to another module would separate a switch case from its switch. The
# alternative — duplicating the ~120-instruction array arm — is the duplication
# habit that produced this whole defect family.
loc-budget-allow:
  - src/codegen/json-codec-native.ts
# Same rationale: the normalisation is one more case in this function's own
# receiver-type ladder and re-points its `L_ANY` local.
func-budget-allow:
  - src/codegen/json-codec-native.ts::emitJsonStringifyValue
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

---

## Test Results (2026-08-02, `ttraenkler/L-enum`)

### Fix

Normalise a `$__vec_base` receiver into a `$ObjVec` (elements read via
`__extern_get_idx`, already vec-aware since #2190), then fall into the
**existing, untouched** `$ObjVec` array arm. This reuses ~120 instructions of
element / replacer / indent / toJSON logic instead of duplicating it into a
second copy that would have to be kept in sync — the duplication habit is what
produced this family of defects in the first place.

Inserted AFTER the `$Object` test and BEFORE the `$ObjVec` test; a `__vec_<k>`
struct is not a `$Object`, so the earlier arm cannot claim it.

### Per-shape before/after (in-Wasm comparison against the spec-correct literal)

| input | expected | gc | standalone BEFORE | standalone AFTER |
| --- | --- | --- | --- | --- |
| `[10,20,30]` | `[10,20,30]` | ok | **`null`** | **ok** |
| `[[1],[2]]` | `[[1],[2]]` | ok | wrong | **ok** |
| `["a","b"]` | `["a","b"]` | ok | wrong | **ok** |
| `{a:[1,2]}` | `{"a":[1,2]}` | ok | wrong | **ok** |
| `[true,false,null]` | `[true,false,null]` | ok | wrong | **ok** |
| `[]` | `[]` | ok | ok | ok (no regression) |
| `{a:1,b:2}` | `{"a":1,"b":2}` | ok | ok | ok (no regression) |
| `new C()` (class inst.) | `{"a":1,"b":2}` | ok | wrong | **still wrong** |
| `o={}; o.p=1; o.q=2` | `{"p":1,"q":2}` | ok | wrong | **still wrong** |

### test262 flips: **NET ZERO** — stated plainly, not buried

| stage | count |
| --- | --- |
| 1 population (corpus mentions `JSON.stringify`) | 155 |
| 2a present in standalone baseline | 84 (unopenable / absent: 71) |
| 2b not passing today | 62 |
| 3 swept before + after (force-refreshed baseline) | **84** |
| 4 **flips** | **+0 / −0 = net 0** |

Before-state of the 84 swept: 22 `pass`, 32 `fail`, 20 `compile_error`, 10 `skip`.

**This is a real result, not a broken instrument.** Positive control: the *same*
sweep harness and code path measured +3/−2 on the `Object.keys` population for
#4071, so it demonstrably detects flips. The 52 non-passing files here fail for
reasons this fix does not touch — 20 of them do not even compile.

So: a genuine silent-corruption fix for ordinary user code that moves the
conformance number by **zero**. Shipped on correctness grounds, with the number
reported as-is rather than dressed up. Also worth noting the inverse of the usual
worry — **zero regressions**, including both shapes that already worked.

### Deliberately NOT shipped

**The closed-struct half** (class instances, assignment-built objects). Same
carrier class whose closed-struct arms leak BUILTIN internals — see #4086, where
extending exactly that mechanism made `Object.keys(/ab/)` report 7 internal
RegExp fields. A JSON closed-struct arm would serialise those same internals into
user-visible output. It needs #4086's user-declared-vs-builtin struct predicate
first.

### Known deviation

Inside the array arm, `holder` passed to a function `replacer` is the normalised
`$ObjVec` rather than the original array object. Observable only via `this` in a
replacer over an array; the entire value previously serialised as `null`, so this
is strictly an improvement.
