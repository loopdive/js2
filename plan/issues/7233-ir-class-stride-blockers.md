---
id: 7233
title: "IR class members: static private fields and shape-less JS classes block every stride class unit"
status: ready
sprint: current
created: 2026-11-04
updated: 2026-11-04
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: implementation
area: ir
goal: ir-full-coverage
related: [7227, 7223, 2949, 6583]
assignee: "ttraenkler/c-lead"
---

# #7233: the class-member gaps that keep the stride ledger flat

## Problem

#7227 (PR #7054) moved 143 class units onto the IR in a 1524-file class
sample. The stride-40 ledger, however, stayed at **20 class-member IR units**
(standalone). Every remaining stride unit in the class buckets is blocked by
one of the gaps that #7227 listed (see "Remaining gaps" in
`plan/issues/7227-ir-class-sync-member-gaps.md`). Two of those gaps are local
to the class lane and cover ~32 stride units:

| Gap | Stride units | Example |
|---|---|---|
| static private **fields**, plus `this.<field>` in a static body | ~12 | `static #x(v) { this.#xVal = v; return this.#xVal; }` |
| shape-less JS classes: one unprojectable instance method drops the whole class in `buildIrClassShapes` | ~20 | a class with one `async m()`, a destructured-param method or `extends Iterator` |

## Implementation Plan (C lead, 2026-11-04; implement on Opus)

Stack the work on #7227 (branch `issue-7227-ir-class-sync-member-gaps`, PR
#7054). Merge `origin/main` once #7054 lands.

1. **Measure and attribute first.** Build a throwaway copy of the per-reason
   probe (as in #7227; never commit it) and confirm the two buckets on the
   stride. Then list, for each stride unit, the first refusal that would
   remain after this issue's two fixes. That list goes in the PR body.
2. **Static private fields in IR static bodies.**
   - Find how legacy stores a static field (`C.a`, `C.#a`): module global,
     static struct, or something else, and under which mangled name.
     `privateMemberMangledName` / `resolveClassMemberName` from #3522 W1-A
     give the private mangling.
   - Admit reads and writes of that storage from an IR static body when the
     receiver is `this` or the owner class name. Reuse the IR's existing
     module-global load/store, the one module `let` bindings use; do not add
     a new global-access node if one exists.
   - Compound assignment (`this.#a += 1`) only if it falls out of the same
     lowering; otherwise refuse it and list it.
   - Anything the legacy static-field ABI cannot represent stays on legacy:
     accessor-backed statics, static fields with an initialiser that reads
     `this`, `static {}` blocks.
   - `this` in a static body is the class constructor. A subclass receiver
     (`D.sm()` where `sm` writes `this.#a`) must give legacy's answer.
     Legacy does no brand check, so equal to base is required. Probe it.
3. **Best-effort instance-method projection, JS sources only.**
   - In the `buildIrClassShapes` instance-method loop, for `.js` sources
     (`NodeFlags.JavaScriptFile`, the same switch #7227 uses), skip an
     unprojectable instance method instead of dropping the class. The
     skipped method stays a legacy body behind the existing slot ABI.
   - TS sources keep the all-or-nothing rule, so typed-corpus bytes stay
     identical.
   - The skipped method must still be reachable through every legacy path:
     vtable/slot, `super.m()`, method-as-value, and `Object.keys` /
     `hasOwnProperty` on the prototype. Check that the #1370 class-method
     ABI parity guard still holds when IR and legacy bodies sit in one
     class.
4. **Do not touch:**
   - async or generator bodies, which belong to other lanes;
   - `dynamicUsesAreMoveOnly` (#2949 / #7106; coordinate on #6583 first);
   - the untyped `#x(42)` dynamic-parameter bucket, which needs boxing with
     a Program-ABI symbolic ref; #7227 tried it and reverted;
   - the TS-annotated IR getter foreign-receiver trap. That one changes
     every IR instance body and gets its own issue.
5. **Never worse than legacy.** Every newly IR-claimed unit must give the
   legacy-observable result on gc, standalone and wasi. Probes must include
   foreign and subclass receivers, `.call({})`, `Reflect.apply`, detached
   calls, exceptions, `+` and comparisons on field values, and mixed IR and
   legacy methods in one class.

## Acceptance criteria

- Ledger A/B (stride 40, standalone) in the PR body: **class-member IR units
  rise above 20**; `class-member-unsupported` falls; 0 invariants;
  `compileOk` not lower.
- Typed playground, benchmark and equivalence corpus is byte-identical on gc,
  standalone and wasi, or every changed binary is explained and correct.
- A test262 A/B on the route-changed class files plus a sample: no test that
  passes on base fails on head (standalone).
- Test: `tests/equivalence/issue-7233-ir-class-stride-blockers.test.ts`,
  covering per bucket the IR route (`trackIrOutcomes`), the stays-legacy
  routes and the node or base result on all 3 lanes.
