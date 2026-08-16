---
id: 3524
title: "String.prototype.toString non-generic receiver: doesn't throw on non-String (generic ToString), plus concat-tail illegal_cast"
status: ready
sprint: current
priority: medium
horizon: m
feasibility: hard
task_type: bug
area: test262-conformance
goal: test262-conformance
created: 2026-07-21
---

## Problem

`test/built-ins/String/prototype/toString/non-generic.js` requires
`String.prototype.toString.call(nonString)` to throw a **catchable TypeError**
(`thisStringValue(this)` throws when `this` is neither a String primitive nor a
String object). The compiler currently does the wrong thing on **two** fronts:

1. **First (reported) failure — no throw at all.** `toString.call(false)` (and
   `1`, `null`, no-arg, `Symbol`, `{toString}`, array) does **not** throw —
   the reflective `String.prototype.toString` closure runs a **generic**
   `ToString(this)` and returns e.g. `"false"`. test262 reports
   *"Expected a TypeError to be thrown but no exception was thrown at all."*
   Verified with per-arg host-lane probes (2026-07-21): every case returns
   caught=`none`.

2. **Tail — shared illegal_cast trap.** The last assertion
   `''.concat({toString: toString})` (where `toString =
   String.prototype.toString`) traps an uncatchable `illegal_cast`, the SAME
   root cause as **#3487**: a reflective builtin proto method stored as an
   object field, invoked through the generic ToPrimitive/`.concat` eqref-closure
   dispatch, hits a `ref.cast` on the receiver instead of the catchable-TypeError
   path direct `.call` takes.

## Relationship to #3487

Split off from #3487 (String.prototype.**valueOf** non-generic) so #3487 stays
scoped to its acceptance (+1 host file, ratchet 80→79). This file (`toString`)
was NOT in #3487's acceptance and needs an **additional** fix beyond the shared
substrate one. Cross-link: **#3487** carries the verified root cause + fix
approach for the shared concat-tail trap (front #2). Both files flip together
once the substrate fix lands AND this file's front #1 is fixed.

## Fixes required

1. **Non-generic `thisStringValue` for the reflective `String.prototype.toString`
   closure** (front #1): the reflective `toString` closure body must check
   `this` is a String primitive / String object and throw a **catchable
   TypeError** otherwise, instead of running generic `ToString(this)`. Host and
   standalone lanes. In standalone this currently routes to
   `emitProtoMemberBodyRefusal` (a catchable TypeError) in
   `emitStringProtoMemberBody` (`src/codegen/array-object-proto.ts` ~L787) — but
   the **host** lane returns a generic string; align both to the non-generic
   throw.

2. **Shared concat-tail illegal_cast** (front #2): fixed by the #3487 substrate
   work (box the receiver to externref before `call_ref`, or route a
   non-matching receiver to a catchable TypeError at the ToPrimitive/`.concat`
   dispatch site). Depends on / shares that fix.

## Acceptance

- `toString.call(nonString)` throws a **catchable TypeError** (host + standalone)
  for all non-String receivers.
- `''.concat({toString: String.prototype.toString})` throws a **catchable
  TypeError** (not `illegal_cast`) — via the #3487 shared fix.
- `test/built-ins/String/prototype/toString/non-generic.js` passes in the host
  lane (+1).

## Notes

The `*-realm.js` variants (`valueOf/non-generic-realm.js`,
`toString/non-generic-realm.js`) fail for a DIFFERENT reason (cross-realm setup
→ `TypeError: Cannot access property on null or undefined`) and need realm
support; they are out of scope here.

## 2026-08-16 re-scope: this issue is also the STANDALONE missing-builtin home

The 2026-08-16 standalone ES5 census (575 nonpasses,
`plan/log/analysis-2026-08-16-es5-standalone-575.md`) shows
`String.prototype.valueOf is not yet implemented in --target standalone`
(harness/deepEqual-primitives.js) and the sibling `…toString` refusals with no
other open owner: #3487 is blocked, and the coverage sweep (2026-08-16) found
the standalone framing had no home. Scope now includes: implement Wasm-native
`String.prototype.valueOf`/`toString` (brand-checked, throws TypeError on
non-String receiver) in `--target standalone`, alongside the original
host-lane non-generic-receiver-throw defect. Boolean.prototype.valueOf is NOT
in scope (landed via #4201/#4482).
