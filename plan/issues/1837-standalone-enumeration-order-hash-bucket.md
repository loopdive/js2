---
id: 1837
title: "Standalone Object.keys/for-in/JSON enumeration is hash-bucket order, not spec order"
status: ready
created: 2026-06-04
updated: 2026-06-04
priority: medium
feasibility: medium
task_type: bugfix
area: codegen
goal: correctness
sprint: 60
---
# #1837 — standalone enumeration order violates spec

## Symptom
Standalone-mode `Object.keys`/`values`/`entries`/for-in/spread/`JSON.stringify`
emit keys in hash-bucket order. `o.b=1;o.a=2;o["2"]=3;o["1"]=4; Object.keys(o)`
should be `["1","2","b","a"]`. JS-host mode is correct.

## Location
`src/codegen/object-runtime.ts:1097-1202` (`__object_keys`) walks open-hash slots
`0..cap` and pushes in bucket order (comment admits "hash order").

## Spec
ECMAScript §10.1.11.1 OrdinaryOwnPropertyKeys — integer-index keys ascending, then
string keys in insertion order, then symbols.

## Fix
Track an insertion sequence in the prop entry; emit integer keys sorted ascending
first, then remaining string keys in insertion order.

