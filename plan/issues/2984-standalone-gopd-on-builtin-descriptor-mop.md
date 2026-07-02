---
id: 2984
title: "Standalone gOPD-on-builtin descriptor MOP (~178: getOwnPropertyDescriptor on builtin objects / proto receivers)"
status: ready
sprint: Backlog
priority: high
horizon: l
feasibility: hard
area: codegen, runtime
goal: standalone-mode
related: [2965, 2861, 2863, 2896]
origin: "#2965 descriptor-cluster triage — follow-up class 1"
---

# #2984 — standalone gOPD-on-builtin descriptor MOP

## Problem

Follow-up from #2965 (descriptor cluster). `getOwnPropertyDescriptor` on a
builtin object or builtin-prototype receiver fails on the standalone lane:
~178 tests (60 CE resolving `__get_builtin` + 118 fail). Example:
`Object.getOwnPropertyDescriptor(Array.prototype, "forEach")` must return a
data descriptor whose `.value` is the builtin method value, but the standalone
lane has no builtin-object meta-object protocol to answer it — the dynamic
`__getOwnPropertyDescriptor` native returns `undefined`, so `.value`/attribute
reads throw.

## Scope / mechanism

- gOPD against builtin constructors and their `.prototype` objects (Array,
  Object, String, Function, etc.).
- Descriptor `.value` must be the method's function value; `writable`,
  `enumerable`, `configurable` per spec (builtin methods: `w:true, e:false,
c:true`).
- Overlaps and should extend the `__builtinfn_gopd` machinery introduced by
  #2861/#2863/#2896 rather than build a parallel path.

## Acceptance

- gOPD on builtin/proto receivers returns spec-correct descriptors on the
  standalone lane; host lane unchanged (byte-inert on gc/host).
- Measured flip count on the `built-ins/Object/getOwnPropertyDescriptor`
  standalone subset with zero regressions on a passing-test sweep.
