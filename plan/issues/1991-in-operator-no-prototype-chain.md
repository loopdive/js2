---
id: 1991
title: "in operator never consults the prototype chain — inherited class methods and Object.prototype members invisible"
status: ready
sprint: 61
created: 2026-06-10
updated: 2026-06-10
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: operators
goal: core-semantics
related: [1971]
origin: "2026-06-10 spec-conformance sweep (equality agent): verified on main"
---

# #1991 — `"m" in instanceOfSubclass` and `"toString" in obj` return false

## Problem

```ts
class P { m() { return 1; } }
class C extends P { own = 1; }
const c: any = new C(); const o: any = { a: 1 };
String("m" in c) + "," + String("toString" in o)
// wasm: "false,false"   node: "true,true"
```

## Root cause

`src/codegen/binary-ops.ts:484-680` static path checks only struct field
names + TS-type props; for `any` receivers it routes to `__extern_has`
(`src/runtime.ts:5296-5327`) which checks own JS keys, the sidecar, and
`__sget_<key>` struct getters. Class methods aren't struct fields, and
HasProperty's `[[Prototype]]` walk (§13.10.1 → §7.3.12 → §10.1.7.1) is
never performed.

## Fix direction

Static path: include inherited methods/accessors from `classParentMap` and
known Object.prototype members. `__extern_has`: walk the compiled class
method registry (and built-in proto members) for struct receivers.

## Acceptance criteria

- Both repros true; own-property and array-index `in` unchanged
- `"missing" in c` stays false

## Dupe check

#110/#166 (`in` basics) done; #1971 item 5 covers `delete`+own-`in` only.
New.

## Partial fix landed (2026-06-11)

PR loopdive#1352 (merged) fixed the Object.prototype-members half
(`"toString" in obj` etc. via _OBJECT_PROTO_KEYS in __extern_has) and all
of #1992. REMAINING for this issue: inherited user-class methods
(`"m" in subclassInstance`) need the per-class method-name registry —
scoped in the sprint-62/63 proposal (analysis program 08-new-issues list).
