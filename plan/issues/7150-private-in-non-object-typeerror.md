---
id: 7150
title: "Native-first: `#x in v` must throw TypeError when v is not an object"
status: ready
sprint: current
created: 2026-10-25
updated: 2026-10-25
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: builtins
goal: correctness
parent: 6979
related: [6899, 2787, 6708]
---

# #7150 — Native-first: `#x in v` must throw TypeError when v is not an object

Surfaced by PR #6899 (S7-a): the differential-test harness had to drop its
`semanticProviders: "host-assisted"` pin, so `scripts/diff-test.ts` now measures
the default native-first profile and `private-fields/05-brand-checks.js` went `match → mismatch — `try { #v in null } catch (e) { console.log(e instanceof TypeError) }` prints nothing; V8 prints `true``
against the host-lane baseline. Reproduced on `origin/main` (96c5de84be) with the
pin removed: **pre-existing native-first gap, not S7-a code** (diagnosis
2026-10-25, PR #6899 review thread). Hidden since S6 (#6708) because the harness
pinned the host lane (#2787 note: "S7 owns removing or replacing this host-only
evidence").

## Observed

`private-fields/05-brand-checks.js`: mismatch — `try { #v in null } catch (e) { console.log(e instanceof TypeError) }` prints nothing; V8 prints `true`

## Cause (as diagnosed; verify before fixing)

The private brand check lowers `#x in v` as a brand test on the value without the spec's step 1 (`If v is not an Object, throw a TypeError`). Site: the `PrivateIdentifier in` arm of the binary-expression lowering (grep `isPrivateIdentifier` near the `InKeyword` handling in `src/codegen/` and `src/ir/from-ast.ts`).

## Implementation Plan (Fable, 2026-10-25; implement on Opus)

1. Reproduce with `class C { #v; static has(o) { return #v in o; } }` called with `null`, `1`, `"s"`, `{}`, `new C()` on gc native-first and standalone.
2. In the `#x in` lowering, add the object-type guard before the brand test: non-object → the native TypeError throw path (`__throw_type_error`, the same used by `in` on a primitive RHS). Keep the IR arm and the legacy twin behaviour-identical (both lanes).
3. Equivalence tests for the five operands above, inside `try/catch` asserting `instanceof TypeError`.

Acceptance: `npx tsx scripts/diff-test.ts` row for `private-fields/05-brand-checks.js` is `match` on gc
native-first and standalone; the equivalence suite is byte-identical on every
program that does not reach the changed path (state the byte delta for those
that do, in the PR body); a test under `tests/issue-7150-*.test.ts` pins the
case on standalone and gc.
