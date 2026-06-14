---
id: 2024
title: "class accessor override with partial pair: get-only override silently drops writes (should TypeError); set-only override reads NaN (should undefined)"
status: done
sprint: 63
created: 2026-06-10
updated: 2026-06-13
completed: 2026-06-13
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: classes
goal: core-semantics
related: [1456, 1364, 2017]
origin: "2026-06-10 spec-conformance sweep (classes agent): verified on main"
---

# #2024 — accessor write falls through to silent struct-field path

## Problem

```ts
class A { _v = 1; get v(): number { return this._v; } set v(x: number) { this._v = x * 2; } }
class B extends A { get v(): number { return this._v + 100; } }
const b = new B();
try { b.v = 7; } catch (e) { return -1; }
return b._v;
// wasm: 1 (write silently dropped)   node: -1 (TypeError)
```

Per spec, B's own get-only accessor shadows A's setter — strict-mode write
throws TypeError; A's setter must NOT run. Mirror case: set-only override
reading `b.v` gives NaN instead of undefined.

## Root cause

`src/codegen/expressions/assignment.ts:2379-2431` — accessor write path
requires `${typeName}_set_${fieldName}` in funcMap; when the overriding
class is get-only the lookup misses and control falls to the struct-field
path, which finds no field named `v` and silently returns (no strict-mode
TypeError emission).

## Fix direction

When the receiver's class declares a get-only accessor for the prop, emit
TypeError on write (don't walk to the parent's setter); set-only read →
undefined.

## Acceptance criteria

- Repro returns -1; set-only read yields undefined
- Full-pair accessors and inherited accessors unchanged

## Dupe check

#1456 covers private readonly accessor TypeError; #1364 is descriptor
shape. New. Object-literal sibling: #2017.

## Resolution (2026-06-13)

Fixed the **get-only override drops writes** half in
`compileAssignmentToAccessor` (`src/codegen/expressions/assignment.ts`, the
`classAccessorSet.has(accessorKey)` block). Root cause confirmed: class-bodies
adds the accessor key to `classAccessorSet` for BOTH getters and setters, so a
get-only override (`class B extends A { get v() {…} }` over a parent with
`set v`) entered the accessor-write block, found no `<type>_set_<field>`
function, and fell through to the struct-field path which silently dropped the
write. Added: when the setter funcIdx is undefined AND the class has an own
getter (`funcMap.has(`<type>_get_<field>`)`), evaluate+drop the RHS (spec:
GetValue before [[Set]]) and `emitThrowTypeError` — the own get-only accessor
SHADOWS the inherited setter (§10.1.5.3), so the parent setter must NOT run.

Set-only-read mirror (`b.v` on a set-only override → `undefined`) already
behaves correctly on current main (verified — `typeof` returns "undefined"); no
change needed there.

## Test Results

`tests/issue-2024.test.ts` — 5/5 pass (`assertEquivalent`, wasm vs Node):
- subclass get-only override write throws (returns -1, was silently 1);
- the parent setter side effect never fires (threw=1, `_v` unchanged);
- single-class get-only write throws;
- full accessor-pair override still writes (unchanged);
- inherited setter (subclass adds no accessor) still writes (unchanged).

Note: the get-only write cases use `// @ts-ignore` since TS rejects assigning to
a read-only accessor — the assignment is valid (throwing) JS, which is what
test262 exercises; the compiler infers `new B()` as `B`, so the write takes the
typed struct-accessor path fixed here.

Class/accessor equivalence suites (`accessor-side-effects`,
`computed-setter-class`, `super-property-access`, `private-class-members`,
`ir-slice4-classes` — 23 tests) unchanged. The one `object-literal-getters-
setters > setter stores value` failure is **pre-existing on clean origin/main**
(unrelated). IR fallback gate OK; `biome lint`, `tsc --noEmit`,
`prettier --check` clean.
