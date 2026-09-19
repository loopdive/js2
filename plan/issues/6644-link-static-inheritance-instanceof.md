---
id: 6644
title: "standalone: a class extending a LINKED provider class inherits no statics, has no [[Prototype]] link to its parent class object, and `instanceof` across the link answers `false` even for a directly-constructed provider instance"
status: in-progress
sprint: current
priority: high
horizon: l
feasibility: hard
reasoning_effort: max
goal: standalone
parent: 5383
requested_by: ttraenkler/fable-lead
created: 2026-09-19
# (#5383 S66, 2026-09-19) Grants restated HERE rather than left to #5383/#6640:
# CI diffs the MERGE PREVIEW against `main`, where neither grant covers these
# paths (the stranded-grant class). All growth below is this change-set's own,
# measured at the branch base 930ab332f4.
#
# +6 LOC / +5 function LOC in `call-namespace-static.ts` is the ENTIRE
# call-site splice: two lines of code plus their rationale comment. The whole
# mechanism lives in the new leaf `standalone-linked-static-inheritance.ts`;
# what stays in the god-file is the one decision point the new arm must be
# spliced into — the class-static call ladder, which is where §15.7.14 step 6
# has to be answered because that is where an own static is resolved and
# shadowing decided. Splitting `compileNamespaceStaticCall` (3,390 LOC) is a
# refactor of long-standing code this change does not otherwise touch.
#
# +24 LOC in `property-access-dispatch.ts` is the twin splice on the READ side
# (`emitClassStaticMemberRead`'s last arm, before `PA_FALLTHROUGH`) plus its
# rationale; the emission itself is in the leaf.
loc-budget-allow:
  - src/codegen/expressions/call-namespace-static.ts
  - src/codegen/property-access-dispatch.ts
#
# +14 in `collectClassDeclaration` and +11 in `compileStatementInner` are the
# two splice points of the IDENTIFIER-heritage arm, both already reduced to a
# single call into `standalone-dynamic-parent-class.ts`: the heritage-arm
# classification (which must sit in the `extends <Identifier>` ladder, AFTER the
# host-constructible-builtin and extern-class arms decline, or it would change
# `classBuiltinParentMap`'s representation) and the ClassDefinitionEvaluation
# capture (which must sit in the nested-class statement arm, because that is the
# one program point where the parameter the heritage names is in scope).
# Splitting either long-standing function is a refactor this change does not
# otherwise touch.
func-budget-allow:
  - src/codegen/expressions/call-namespace-static.ts::compileNamespaceStaticCall
  - src/codegen/class-bodies.ts::collectClassDeclaration
  - src/codegen/statements.ts::compileStatementInner
---

# #6644 — static inheritance + cross-link `instanceof` through a provider heritage

## Target (S66 dispatch)

The four remaining `subclassing-ignored` rows, all `fail` on the S65 head
(`930ab332f4`):

- `test/built-ins/Temporal/PlainDate/from/subclassing-ignored.js`
- `test/built-ins/Temporal/Duration/from/subclassing-ignored.js`
- `test/built-ins/Temporal/Duration/prototype/abs/subclassing-ignored.js`
- `test/built-ins/Temporal/ZonedDateTime/prototype/add/subclassing-ignored.js`

## Mechanism 3 — cross-link `instanceof` (landed)

### Root cause (reduced, not assumed)

`(new NS.Base(1)) instanceof NS.Base` answered **`false` for a DIRECTLY
constructed provider instance**, which is what #6640 pinned as a control and
#6643 named as the second blocker behind every row (`assertPlainDate` /
`assertDuration` open with `assert(x instanceof Temporal.X)`).

Decomposed against the real two-module fixture on the branch base
(`.tmp/s66/probes/p3.mts`, standalone + `hostBridge: "off"`):

| probe | base |
| --- | --- |
| `typeof T` | `function` |
| `typeof T.prototype` | `object` |
| `Object.getPrototypeOf(V) === T.prototype` | `true` |
| `T.prototype.isPrototypeOf(V)` | `true` |
| `Object.prototype.hasOwnProperty.call(T, 'prototype')` | **`false`** |
| `V instanceof T` | **`false`** |

Every ingredient of §7.3.20 already crossed the seam. The ONE step that missed
was the own-property **gate** in `__instanceof_dynamic`
(`native-dynamic-instanceof.ts`): `hasOwnProperty(T, "prototype")` answers
`false` for a provider-minted class object, because the consumer's own-property
bag is a module-local `ref.test` ladder that a foreign struct matches nowhere.
The helper therefore fell past BOTH `prototype` arms to the closure identity
edge (`__closure_proto_of`, module-local by construction), missed there too, and
returned the documented conservative `false`.

### The fix

A new last-resort arm, `linkedPeerPrototypeArm`, spliced at the tail of both the
callable and the not-callable branches: when the linked provider's
`__js2wasm_link_callable_kind` reports the target as a function object, read
`Get(C, "prototype")` through `__extern_get` (whose peer `memberGet` arm already
answers) and run the existing §7.3.20 steps 3 + 5–7 tail unchanged.

Three properties make the blast radius what it is:

- **Nothing is emitted** unless the module CONSUMES a standalone provider
  (`standaloneLinkBoundaryPeerIndex` returns `undefined` otherwise) — so the
  whole byte corpus, the provider modules themselves, and the entire JS-host
  lane are untouched.
- **Placed LAST**, after every local answer has declined, so it can only replace
  a `false` that was a miss — it can never pre-empt an answer the consumer could
  give itself.
- **`callableKind != 0`, not bit 0 alone.** A provider CLASS publishes
  construct-only under `fillStandaloneLinkBoundaryLateTerminals`' encoding, and
  a class object is precisely the target every `x instanceof Temporal.Foo` names.
  (This is the one place #6643's `linkedForeignCallableBitInstrs` — which masks
  bit 0 for §20.2.3's IsCallable — is the wrong predicate.)

A consumer-owned closure asked about here costs nothing: the peer's
`__extern_get` answers `null` for a value it does not own, so the arm falls
through to the same conservative `0`.
