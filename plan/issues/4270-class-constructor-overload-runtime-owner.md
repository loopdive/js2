---
id: 4270
title: "codegen: bind class constructor overloads to the body-bearing implementation"
status: done
sprint: 78
created: 2026-08-09
updated: 2026-08-18
priority: high
horizon: s
feasibility: low
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: constructor-overloads
goal: dogfood
related: [3520, 4267, 4268]
assignee: "ttraenkler/typescript-upstream-source-build"
---

# codegen: bind class constructor overloads to the body-bearing implementation

## Problem

The class-body pipeline selects a class constructor with
`members.find(isConstructorDeclaration)`. In TypeScript, overload signatures
precede the one body-bearing implementation, so this selects a type-only
declaration. Direct codegen registers its allocator against that declaration,
while the Program ABI inventory correctly owns only the executable constructor,
and compilation aborts:

```text
class callable Version_new has no consistent exact class-constructor inventory owner
```

Constructor overload signatures describe calls; they are not separate runtime
constructors. Struct-field discovery, allocator ABI registration, body emission,
and inherited-constructor parameter discovery must all use the implementation.

## TypeScript package impact

With #4267 and #4268 applied, the exact 280-file TypeScript v5.9.3 source graph
passes the top-level `every` and `some` overloads. It reaches
`src/compiler/semver.ts::Version`, whose two constructor signatures precede the
implementation, then fails during class callable registration after 8.25
seconds (7.15 seconds in codegen, 977.1 MB peak heap).

## Acceptance criteria

- [x] A class with constructor overload signatures compiles, validates, and an
      exported caller returns `42` from the body-bearing constructor in Wasm.
- [x] Exactly one executable class-constructor IR outcome is inventoried.
- [x] Constructor field discovery, ABI registration, body emission, and
      inherited-constructor forwarding select the same exact implementation.
- [x] Existing class-constructor and source-callable ABI regressions remain
      green.
- [x] The exact TypeScript v5.9.3 source probe advances beyond `Version_new` and
      records the next honest frontier without claiming a binary prematurely.

## Scope

Fix the direct class-body constructor selector generically. Do not special-case
`Version`, TypeScript, or constructor parameter types, and do not weaken the
Program ABI ownership invariant.

## Result

The class-body pipeline now selects only a body-bearing constructor for field
discovery, ABI registration, body emission, and inherited explicit-constructor
forwarding. Bodyless overload signatures remain type-only and can no longer own
or shadow the allocator slot.

The focused regression reproduces the former `Counter_new` ownership failure,
then instantiates the overloaded class in Wasm, returns `42`, and observes one
constructor IR outcome.

The exact 280-file TypeScript v5.9.3 source graph passes `Version_new` and
reaches the next independent overload-owner frontier after 11.62 seconds
(10.38 seconds in codegen, 1.33 seconds collecting declarations, 1040.6 MB peak
heap):

```text
Codegen error: class callable ScriptInfo_lineOffsetToPosition has no consistent
exact class-instance-method inventory owner
(at src/codegen/program-abi-class-callable-planning.ts:181:13)
```

No binary is claimed from this probe.
