---
id: 4518
title: "standalone: reflective String-method arm renders the undefined singleton as '[object Object]' — blocks 3 of #4489's R1 rows"
status: done
completed: 2026-08-23
sprint: current
created: 2026-08-16
updated: 2026-08-23
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
es_edition: 5
language_feature: string
goal: standalone-gap
related: [4489, 4465, 2875, 4619]
origin: "2026-08-16 #4489 verification — pre-existing (absent-argument provenance renders identically on both sides of the seed A/B). Blocks charAt/S15.5.4.4-family rows whose actual strings now carry 'undefined' upstream but '[object Object]' through the reflective arm."
---

# #4518 — reflective String arm renders a nullish value as "[object Object]"

## Problem

The reflective `String.prototype.<m>` bodies' ToString of an `undefined`
value (receiver or argument, incl. the closure ABI's absent-arg pad and the
#4489 tag-1 singleton) terminates in `$__any_to_string`'s unrecognized-ref
arm → literal `"[object Object]"` instead of `"undefined"`. Pre-existing
before #4489 (absent-argument control renders identically on both sides);
the #4489 seed made 3 more test262 rows reach it:
`concat/S15.5.4.6_A2`-family + the 3 unflipped #4489-R1 rows (see #4489's
issue file for the exact list and provenance evidence).

## Plan

Brief: plan/method/es5-standalone-agent-brief.md. Add the tag-1-singleton /
null arm to the shared reflective ToString (`string-proto-tostring.ts`
`emitStringProtoToStringFlat` — same splice point as #4465's
withRegExpReceiverArm) rendering "undefined" per §7.1.17. A/B the
#4489-R1 rows (should flip) + the #4465/#4489 pin suites + a scoped
built-ins/String/prototype sweep, zero regressions.

---

## What re-verification found (2026-08-23) — the problem statement above is half stale

Every number in this section is from a run I executed on this tree
(`issue-4518`, branched from the campaign state `04c0d5d42`).

**The `undefined` half was already closed, by someone else, five days after
this issue was filed.** Commit `0ce3c8f00` — `fix(#2875): an absent toString is
not '[object Object]' — the shared source of three stomped carriers`,
2026-08-21 — names `undefined` explicitly among the carriers whose rendering it
un-stomped, and counts `String/concat/replace/coercion ×4` among its flipped
rows. Measured here with opaque dispatch (the method passed through a function
parameter, so nothing can resolve statically to the direct path): reflective
`indexOf` / `charAt` / `slice` / `toUpperCase` / `concat` / `replace` / `split`
/ `anchor` with an undefined argument, an explicitly-`undefined` argument, a
`#4489` module-var undefined, or a receiver that stringifies to `"undefined"`
**all render `"undefined"` correctly**. No `"[object Object]"` anywhere in that
family.

**The three rows this issue was filed to unblock:**

| row | measured now |
| --- | --- |
| `built-ins/String/prototype/replace/S15.5.4.11_A1_T10.js` | **pass** |
| `built-ins/String/prototype/concat/S15.5.4.6_A1_T10.js` | **pass** |
| `built-ins/String/prototype/replace/S15.5.4.11_A1_T9.js` | fail, but **not on this defect** — it fails `Actual: NaN` inside the function-replacer arm (#4620-adjacent) |

The `concat/S15.5.4.6_A2` family named in the problem statement is the
**128-argument** test, whose blocker is the 4-slot `STRING_PROTO_METHOD_PARAM_SLOTS.concat`
cap — a documented residual of #4426, unrelated to ToString.

**But the symptom is real at exactly the splice point the plan names — for
`null`, not for `undefined`.** §7.1.17 step 3 says `ToString(null)` is
`"null"`, and the shared helper had no arm for it:

| shape (standalone, before the fix) | rendered | spec |
| --- | --- | --- |
| `String.prototype.replace.call("axb", "x", null)` | `"a[object Object]b"` | `"anullb"` |
| `String.prototype.replace.call("anullb", null, "Z")` | `"anullb"` (no match) | `"aZb"` |
| `String.prototype.indexOf.call("anullb", null)` | `-1` | `1` |
| `String.prototype.lastIndexOf.call("anullnullb", null)` | `-1` | `5` |
| DIRECT `"axb".replace("x", null)` (control) | `"anullb"` | `"anullb"` |

The direct paths were already right, so the two lowerings disagreed about one
of §7.1.17's seven cases.

## Root cause

`emitStringProtoToStringFlat`'s generic sequence is
`local.get param; __to_primitive(…,"string"); any.convert_extern;
$__any_to_string; __str_flatten`. `__to_primitive` returns a null externref
unchanged (its `returnIfPrimitive` early-outs on `ref.is_null`), so a null
anyref reaches `$__any_to_string`. There it matches neither the `$AnyString`
test nor the `$AnyValue` test, falls into the residual arm, misses
`$__box_number_struct` / i31 / `$__box_boolean_struct` in turn, and lands on the
terminal literal `"[object Object]"`.

The `$AnyValue` tag dispatch does have a tag-1 → `"undefined"` arm, which is why
the undefined singleton renders correctly once #2875 stopped
`__class_to_primitive` from stomping it on the way in. `null` has no
corresponding arm anywhere on the path.

## Fix

`src/codegen/string-proto-tostring.ts` — `withNullExternArm`, wrapping #4465's
`withRegExpReceiverArm` at the same splice point: `ref.is_null` on the param
selects a flat `"null"` literal, otherwise the existing sequence runs
unchanged. Emitted only when the module carries the flat native-string type, so
a host/gc-lowered module is byte-identical.

### The forced choice, and how it was measured

A null externref at this splice point is genuinely ambiguous, because the
reflective ABI ALSO uses `ref.null.extern` as its omitted-argument pad
(`closures/transferred-native-proto.ts:170`). The two readings have different
spec answers — the JS value `null` wants `"null"`, an omitted argument wants
`ToString(undefined)` = `"undefined"` — and the helper cannot tell them apart.

The plan above prescribed `"undefined"`. I built the arm with a distinctive
sentinel literal to see which shapes actually reach it. In the **TS lane** only
an explicit `null` does: `replace` / `indexOf` / `split` / `anchor` / `concat`
with a short argument list all still rendered `"undefined"` with the sentinel in
place, because `.call` pads absent args with the #2106 `$undefined` singleton
(`expressions/calls.ts`, `undefinedSingletonPad`).

That would have settled it for `"null"` — except the **JS lane behaves
differently, and the JS lane is the one test262 compiles in.** Base-copy A/B,
same file, both sides run by me:

| JS lane, `String.prototype.replace.call("axb", "x", …)` | base | with the arm | spec |
| --- | --- | --- | --- |
| replaceValue OMITTED | `"a[object Object]b"` | `"anullb"` | `"aundefinedb"` |
| replaceValue `null` | `"a[object Object]b"` | `"anullb"` | `"anullb"` |
| replaceValue `undefined` | `"aundefinedb"` | `"aundefinedb"` | `"aundefinedb"` |

So the arm can fix exactly one of the two readings. I chose `"null"`:

- it is the answer §7.1.17 gives for the value the arm can actually name;
- both alternatives are **wrong → differently-wrong, never right → wrong** —
  the base renders `"[object Object]"` for both readings, so neither choice
  trades away a correct answer (the brief's absent-not-wrong rule does not
  discriminate here);
- the corpus does not discriminate either: all 15 `String.prototype.<m>.call(…null…)`
  occurrences under `built-ins/String/prototype` are null **receivers**
  (`this-value-not-obj-coercible` rows), which `RequireObjectCoercible` throws on
  before ToString runs.

The cost is pinned as an executable `it.fails` in `tests/issue-4518.test.ts`
rather than left in a commit message. **Flipping the decision is a one-line
literal change** if the sweep evidence ever favours the other reading.

The real repair for the ambiguity is unifying the omitted-arg pad onto the
#2106 singleton in the callable-value dispatch — which is `expressions/calls.ts`,
**#4619's territory**, and carries every `ref.is_null`-means-absent member body
with it (`string-proto-concat.ts` step 3, `string-proto-html.ts`'s attribute
arm, `lastIndexOf`'s from-end sentinel). Stopped there per the lane
coordination note rather than chasing it.

## Test Results

Every figure is a run I executed on this box, on branch `issue-4518`
(parent `04c0d5d42`). The A/B instrument throughout is the base-copy pattern:
`git show HEAD:src/codegen/string-proto-tostring.ts > .tmp/base-…`, captured at
the first edit, so each "before" is a run rather than an inherited number.

### Scoped standalone sweep — `built-ins/String/prototype`, 1073 files

Full directory, both sides, `lstat`-based walk (the self-referential
`test262/test/test` symlink is skipped rather than followed):

| transition | rows |
| --- | --- |
| pass → pass | 919 |
| fail → fail | 136 |
| compile_error → compile_error | 18 |
| **any flip** | **0** |

Rows floored 1073/1073 on both sides, no timeouts, no `THREW`.

**Zero regressions — and zero fixes. State that plainly rather than dressing
it up:** this change flips no test262 row in the directory it targets. The
reason is visible in the corpus and was predicted before the sweep ran: all 15
`String.prototype.<m>.call(…null…)` occurrences under `built-ins/String/prototype`
pass `null` as the **receiver**, where `RequireObjectCoercible` throws before
ToString runs. No row passes an explicit `null` ARGUMENT through a reflective
shape. What the change buys is the removal of a measured §7.1.17 violation on
which the reflective and direct lowerings disagreed, at zero corpus cost, now
pinned — not a pass-rate movement.

It also means the sweep did **not** discriminate between the `"null"` and
`"undefined"` readings of the forced choice above; the §7.1.17 argument is
carrying that decision on its own.

### Environment note (this cost real time — worth recording)

The fresh worktree's `test262/` was the documented symlink-farm trap: a
directory of symlinks pointing into `agent-a7e3cb3fae8a40155`'s worktree, whose
own `test262/` is EMPTY. It resolves and lists, so it fails silently — relinked
to `/home/user/js2wasm/test262` (1073 files) before any sweep. `.test262-cache`
was absent and was linked to the main checkout's.

### Behavioural A/B (standalone, opaque dispatch)

Method passed through a function parameter so nothing resolves statically to
the direct path:

| shape | base | after | spec |
| --- | --- | --- | --- |
| `replace.call("axb","x",null)` | `"a[object Object]b"` | `"anullb"` | `"anullb"` |
| `replace.call("anullb",null,"Z")` | `"anullb"` | `"aZb"` | `"aZb"` |
| `indexOf.call("anullb",null)` | `-1` | `1` | `1` |
| `lastIndexOf.call("anullnullb",null)` | `-1` | `5` | `5` |
| `replace.call("axb","x",undefined)` | `"aundefinedb"` | `"aundefinedb"` | `"aundefinedb"` |
| `anchor.call("R", 42/true/{toString}/[]/regexp/error)` | unchanged | unchanged | — |
| `slice.call(new String/Number/Boolean/…, 0)` | unchanged | unchanged | — |

### Lane byte-identity — verified, not asserted

sha256 of the emitted binary for four reflective-String modules
(`replace`, `indexOf`, borrowed `toUpperCase`, `anchor`), base copy vs fix:

| lane | result |
| --- | --- |
| host/gc (default) | **identical, all four** |
| `nativeStrings` | **identical, all four** |
| `standalone` | all four differ (the intended change) |

### Pin suites

| suite | result |
| --- | --- |
| `tests/issue-4518.test.ts` (new) | **21/21** — 5 null-arm, 4 undefined-regression, 8 unmoved-carrier, 4 `it.fails` residuals |
| `tests/issue-4465.test.ts` + `tests/issue-4489.test.ts` | **35/35** |
| `es5-standalone-replace-fn` + `-wrapper-exotics-replace` + `-callable-tostring` | **34/34** |
| `es5-standalone-with` + `-with-carrier` + `-this-and-construct` + `-wrapper-prototype` | 59 pass, **1 pre-existing fail** |
| `issue-2742` + `issue-2875` + `issue-4439` + `issue-1470` + `es5-standalone-split` | 56 pass, **3 pre-existing fails** |

The four failures are NOT regressions — each was re-run with the base copy in
place and fails identically there: `#2742` group (c) and (d), `#2875` slice 1
`at.call('abc', 9)`, and `#4248` wrapper-prototype `[[PrimitiveValue]]`.

### Gates

`npm run typecheck`, `biome lint`, `prettier --check`, `check:loc-budget`,
`check:func-budget`, `check:stack-balance` — all clean. **No budget grant
needed**: +66 LOC in one file, under the gate, and no fixup-bucket increases.

## Residuals

Each is `it.fails`-pinned in `tests/issue-4518.test.ts`, so the pin fails the
day the cause is fixed.

1. **An omitted trailing argument renders `"null"`, not `"undefined"`** (JS
   lane). The cost of the choice above; base rendered `"[object Object]"`.
   Fix belongs in the callable-value dispatch's arg pad — #4619-adjacent.
2. **`anchor(null)` renders the name as `"undefined"`.** `string-proto-html.ts`
   maps a `ref.is_null` attribute slot to the literal `"undefined"` BEFORE the
   shared helper runs (CreateHTML step 4.b coerces an absent value regardless),
   so an explicit `null` name is caught there and never reaches §7.1.17 step 3.
3. **`split(null)` does not split on `"null"`.** The reflective `split`
   short-circuits a nullish separator to "no separator" ahead of the shared
   ToString, returning one part; the direct `"anullb".split(null)` correctly
   returns two. Its borrowed-receiver spelling additionally **traps**
   (`RuntimeError: dereferencing a null pointer`) for both a null and an omitted
   separator — an uncatchable crash, worth its own issue.
4. **`concat(null)` drops the argument.** `string-proto-concat.ts` step 3 tests
   `ref.is_null` on each padded arg slot to mean "argument not passed" and skips
   it, so a genuine `null` is dropped instead of appended (`"x"` rather than
   `"xnull"`). Same root as residual 1.
5. **Not mine, observed here.** `String.prototype.replace` borrowed onto a
   `new String("axb")` receiver renders the WHOLE result `"[object Object]"`
   regardless of its arguments — a receiver-ToString failure on the borrowed
   path, independent of this arm. And `includes` / `startsWith` / `endsWith` /
   `codePointAt` (the `SUPERSEDED_BY_BORROWED_PATH` carve-out) throw
   `"… is not yet implemented in --target standalone"` for a fully opaque
   `f.call(…)`, argument-independently — a control with a proper string
   argument refuses identically.
