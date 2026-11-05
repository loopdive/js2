---
id: 7149
title: "Native-first: JSON.stringify of a class instance with only private fields returns null instead of {}"
status: done
sprint: current
created: 2026-10-25
updated: 2026-10-25
completed: 2026-10-25
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: builtins
goal: correctness
parent: 6979
related: [6899, 2787, 6708, 7155]
# 2026-10-25: +9 lines in `object-runtime.ts` — the closed-struct shape walk
# now also reports shapes with no enumerable own field, and the finalize-time
# classifier admits them. Both live next to the walk they extend; moving the
# 12k-line file's enumeration finalizer out is out of scope for this bugfix.
loc-budget-allow:
  - src/codegen/object-runtime.ts
---

# #7149 — Native-first: JSON.stringify of a class instance with only private fields returns null instead of {}

Surfaced by PR #6899 (S7-a): the differential-test harness had to drop its
`semanticProviders: "host-assisted"` pin, so `scripts/diff-test.ts` now measures
the default native-first profile and `private-fields/01-fields.js` went `match → mismatch — `JSON.stringify(new C())` where `C` has only `#x` prints `null`; V8 prints `{}``
against the host-lane baseline. Reproduced on `origin/main` (96c5de84be) with the
pin removed: **pre-existing native-first gap, not S7-a code** (diagnosis
2026-10-25, PR #6899 review thread). Hidden since S6 (#6708) because the harness
pinned the host lane (#2787 note: "S7 owns removing or replacing this host-only
evidence").

## Observed

`private-fields/01-fields.js`: mismatch — `JSON.stringify(new C())` where `C` has only `#x` prints `null`; V8 prints `{}`

## Cause (as diagnosed; verify before fixing)

The native `JSON.stringify` classifies an instance whose shape has no public own properties as a non-object (or as an object without a serialisable brand) and emits `null`. Site: the native JSON stringify value-kind dispatch (`src/codegen/` grep `__json_stringify` / `json-runtime`) and how a private-fields-only instance is represented (private slots live outside the public shape).

## Implementation Plan (Fable, 2026-10-25; implement on Opus)

1. Reproduce with `class C { #x = 1 } console.log(JSON.stringify(new C()))` and with a class that has one public and one private field, gc native-first and standalone.
2. In the stringify dispatch, treat any struct with the object brand as an object regardless of its public property count; emit `{}` when the ordered own-enumerable key list is empty. Verify private slots are never enumerated.
3. Equivalence tests: private-only, mixed, nested instance inside an array, `toJSON` on such a class.

Acceptance: `npx tsx scripts/diff-test.ts` row for `private-fields/01-fields.js` is `match` on gc
native-first and standalone; the equivalence suite is byte-identical on every
program that does not reach the changed path (state the byte delta for those
that do, in the PR body); a test under `tests/issue-7149-*.test.ts` pins the
case on standalone and gc.

## Resolution (2026-10-25)

probe/test reference: `tests/issue-7149-json-stringify-private-fields-only-instance.test.ts`
(11 programs × gc native-first + standalone, each compared with V8 output; 16 of
the 22 cases fail on the merge-base).

Cause confirmed, one level below the diagnosis: the codec already treats a
class instance as an object when the finalize-time classifier
`__object_assign_closed_struct_source` admits its struct type. The classifier
was built from the closed-struct enumeration entries, and
`collectClosedStructEnumerationEntries` dropped every shape with no enumerable
own field (`class C { #x = 1 }`, an empty class, a methods-only class). Such an
instance matched no codec arm and serialised as `null`; its `toJSON` was never
looked up either.

Fix (`src/codegen/object-runtime.ts`): the entry walk also reports those shapes,
and the classifier admits the ones that are allocated. The enumeration arms are
unchanged, so `Object.keys` / `for…in` emit the same code, and the codec's
closed-struct arm then finds no keys and answers `{}`. Private slots are still
filtered by `isInternalStructFieldName`, so they are never serialised.

`scripts/diff-test.ts` with the host-assisted pin removed: row
`private-fields/01-fields.js` `mismatch → match`; corpus 111 → 112 matches, no
other row changes.

Left out on purpose:

- `for (k in instance)` lists private names and prototype methods
  (`class C { #x = 1; y = 2; m() {} }` → `#x, y, m`; V8: `y`) on gc
  native-first and standalone, also on the merge-base. The static for-in unroll
  (`src/codegen/statements/for-in-static-unroll.ts`) enumerates the checker's
  property list. Separate path, not JSON.
- Standalone `console.log(n)` with a number argument prints an empty string
  once JSON helpers are linked (`console.log(1); console.log(JSON.stringify({}))`
  → empty first line), also on the merge-base. The test logs `String(n)`.
- #7155 (object spread of an array) is filed separately, not fixed here.
