---
id: 7150
title: "Native-first: `#x in v` must throw TypeError when v is not an object"
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
related: [6899, 2787, 6708, 7157, 7159]
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

## Resolution (2026-10-25)

probe/test reference: `tests/issue-7150-private-in-non-object-typeerror.test.ts`
(corpus program + 16 operands + brand-before-throw, each on gc native-first and
standalone, compared with V8; message text on host-assisted, gc native-first
and standalone; 24 of the 39 cases fail on the merge-base).

Cause confirmed: `compileInOperator`'s `#x in` arm (`src/codegen/binary-ops-in.ts`)
asked the host `__extern_is_object` for step 1, gated on `!ctx.standalone &&
!ctx.wasi`. gc native-first compiles with `ctx.standalone` set, so it shared
standalone's gap: a failed brand test answered `false` for `null`, `undefined`
and every primitive.

Fix: on the no-host lanes, a failed brand test now checks Object-ness with the
module's own `typeof` classifiers (`__typeof_object | __typeof_function`, minus
wasm null and the Symbol carrier) and throws the host lane's TypeError text.
The host-assisted arm is untouched (byte-identical). The IR has no private-`in`
arm (`selectorDynamicLaneIn` declines a `PrivateIdentifier` key), so there is no
twin to keep in step.

`scripts/diff-test.ts` with the host-assisted pin removed: row
`private-fields/05-brand-checks.js` `mismatch → match`; corpus 111 → 112
matches, no other row changes.

Left out on purpose:

- `#x in C` (the class constructor itself) answers `true` on every lane,
  host-assisted included (V8: `false`), also on the merge-base — the
  constructor shares the instance struct, the same root as #7159.
- Standalone `console.log(<boolean or number>)` prints an empty line whenever
  the module holds an untyped function (`function f(x){return x===1}
  console.log(f(1)); console.log(1)` → two empty lines), also on the
  merge-base. Broader trigger than #7157 (JSON helpers); the test logs
  `String(v)` on standalone.
- The message text is the host lane's (`… private field in a non-object`), not
  V8's (`… search for '#v' in null`); no lane formats the operand.
- A statically object-typed TS receiver (`o: C | object`) still pays the guard
  (+~26 KB on standalone when the module did not already link the `typeof` and
  error helpers). Not a defect; a static-type skip would need an oracle query
  that proves the receiver can never be a primitive.
