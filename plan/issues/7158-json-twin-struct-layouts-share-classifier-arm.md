---
id: 7158
title: "Native-first and standalone: two classes with identical struct layouts share one JSON/assign classifier arm, so a private-only instance serialises its twin's public field"
status: ready
sprint: current
created: 2026-10-25
updated: 2026-10-25
priority: medium
horizon: m
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: classes
goal: correctness
parent: 6979
related: [7149, 7159, 7148]
---

# #7158 — twin struct layouts collapse in the closed-struct classifier

Found by the fresh-context review of PR #6912 (#7149, finding 1). Pre-existing
on `origin/main` before and after #7149, on gc native-first and standalone
(host-assisted prints node's output):

```js
class C { #x = 1 }
class D { y = 2 }
console.log(JSON.stringify(new C()));   // {"y":1}   (node: {})
console.log(JSON.stringify(new D()));   // {"y":2}
```

## Cause (as diagnosed; verify before fixing)

WasmGC canonicalises structurally identical struct types (iso-recursive
typing): `C`'s struct `{i31/f64 #x}` and `D`'s `{f64 y}` are the same type, so
the `ref.test $D` arm emitted by the `__object_assign_closed_struct_source`
classifier (`src/codegen/object-runtime.ts`,
`fillClosedStructEnumerationArms`) matches a `C` instance, and the arm's
key list (`y`) is used for it. Any consumer keyed on `ref.test` of a class
struct (JSON stringify, `Object.assign`/spread source classification,
`__object_keys`) shares the defect; private-vs-public is the visible symptom,
but two public classes with the same field types and different names
(`class A { a = 1 } class B { b = 1 }`) collapse the same way.

## Implementation Plan (Fable, 2026-10-25; implement on Opus)

1. Reproduce the program above plus `class A { a = 1 } class B { b = 1 }`
   (`JSON.stringify(new B())`, `Object.keys({...new B()})`), and a subclass
   pair, on gc native-first and standalone; record which consumers are wrong.
2. Make class struct types distinguishable without changing the host-assisted
   gc bytes: the class-instance struct already carries (or can carry) a brand —
   check how `instanceof` / `__class_brand` is lowered for closed structs
   (`grep -rn brand src/codegen/classes/`) and reuse that identity in the
   classifier arms instead of a bare `ref.test`: test the struct type, then
   compare the brand field against the class's brand constant. If no brand
   field exists on the instance struct, add a `final` empty supertype per class
   (`sub` chains are nominal in WasmGC: `(type $C (sub $C_brand (struct ...)))`
   with a distinct empty `$C_brand` per class) so `ref.test` becomes nominal;
   state the byte delta per lane (native-first and standalone may change; the
   host-assisted lane must not emit the classifier).
3. Tests: `tests/issue-7158-twin-struct-layouts.test.ts` with the programs from
   step 1 on gc native-first and standalone vs node; keep #7149's test green.

Acceptance: a private-only instance serialises as `{}` even when a public twin
layout exists; `JSON.stringify(new B())` prints `{"b":1}`; host-assisted gc
bytes unchanged; equivalence gate reports no new regressions.
