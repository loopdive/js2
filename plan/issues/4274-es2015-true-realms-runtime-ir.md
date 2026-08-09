---
id: 4274
title: "ES2015 true realms: replace `$262.createRealm` pseudo-realm with IR/runtime realm identity (128 files)"
status: ready
sprint: current
created: 2026-08-09
updated: 2026-08-09
priority: high
horizon: xl
feasibility: hard
reasoning_effort: max
model: gpt-5.6-sol
task_type: feature
area: ir, runtime, test-runner
language_feature: cross-realm
es_edition: 2015
goal: es6
parent: 4273
related: [500, 1355, 1523, 2763, 2866, 2940, 2996, 3371]
assignee: "ttraenkler/codex-es6-realms"
test262_count: 128
origin: "2026-08-09 exact-ES2015 cross-realm feature cohort: GC 128/128 non-pass; standalone 121/128 non-pass. The completed $262 harness issue supplies only an empty self-referential object, not a distinct ECMAScript Realm."
---

# #4274 — Give `$262.createRealm()` real realm identity

## Exact impact

Against #4273's pinned exact-ES2015 population, the `cross-realm` feature tag
selects **128 files**. The sorted path list has SHA-256
`abb9905b0a56748eb3be2100d80d7cd408747bc5453ecce61f9885ac1f1d2aff`.

| Lane | Pass | Fail | Compile error | Non-pass |
| --- | ---: | ---: | ---: | ---: |
| GC/host | 0 | 128 | 0 | **128** |
| Standalone | 7 | 92 | 29 | **121** |

The GC failures are unusually concentrated: 112 report `Cannot access property
on null or undefined`, with another five location-decorated forms of the same
error. In standalone, the pseudo-realm fans out into downstream failures:

- 46 `__module_init` null dereferences;
- 21 missing expected TypeErrors;
- 15 values observed as `undefined` instead of the foreign object;
- 14 distinct-NewTarget `Reflect.construct` refusals across three signatures;
- 7 Array harness concat/import leaks; and
- smaller `instanceof`, constructor, and object-carrier failures.

All 128 files call `createRealm()` and read `.global`. Within the same cohort,
58 inspect prototypes, 42 call `Reflect.construct`, 39 exercise Proxy, seven
use `instanceof`, and two exercise `Symbol.for`. The largest path families are
Proxy (36), Array (16), Function (13), Symbol (13), RegExp (8), NativeErrors
(6), and TypedArray constructors (5).

The seven standalone passes are not evidence of real realm support. They pass
despite the stub or through narrow current-realm shortcuts; the cohort-level
identity and intrinsic requirements remain absent.

## Root cause

#1523 correctly made `$262` available, but deliberately implemented
`createRealm()` as an empty object whose `global` points back to itself:

```ts
const realm: any = {};
realm.global = realm;
```

That object has no realm-local Array, Object, Function, Error, Proxy, RegExp,
TypedArray, or other intrinsic constructors and prototypes. Consequently
`$262.createRealm().global.Array` and similar reads are `undefined`, and
prototype/constructor assertions fail before testing the intended operation.

Standalone also contains a narrow property-access shortcut that treats a
binding initialised from `$262.createRealm().global` as the current native
global for a TypedArray constructor-prototype shape. That was useful for
unblocking #3371, but it explicitly collapses the distinction this cohort
tests. Adding more constructor names to the empty object or extending this
shortcut would create more pseudo-passes while preserving the root defect.

An ECMAScript Realm needs distinct intrinsic object identities and its own
global object, while sharing agent-level facilities where the specification
requires it. In particular, constructors and prototypes are realm-local, but
the global Symbol registry used by `Symbol.for`/`Symbol.keyFor` is shared across
realms in the same agent. This cannot be represented faithfully by a plain
empty `$Object` or by aliasing every foreign intrinsic to the current one.

## Required IR/runtime design

This is an IR/runtime substrate, not a test-runner-only shim.

1. Add an explicit realm carrier containing a stable realm identity, realm
   global, and intrinsic constructor/prototype table. `createRealm` allocates a
   new carrier; repeated access to its global and intrinsics is identity-stable.
2. Add prepared IR operations/providers for realm creation, global access, and
   intrinsic lookup. The `$262` preamble may call those providers, but it must
   not embed compiler filename/path knowledge or construct the realm by a
   legacy-only object-literal special case.
3. Represent each foreign constructor as a callable/constructible facade tied
   to its realm carrier. Its `.prototype` is the corresponding foreign
   intrinsic, distinct from the current realm's intrinsic, while its executable
   implementation can share code.
4. Propagate the selected realm through allocation and construction, including
   `Reflect.construct(target, args, newTarget)`. Objects must receive the
   correct foreign prototype, and errors created by realm-defined operations
   must carry the correct foreign Error prototype.
5. Make dynamic property access, Proxy trap calls, `instanceof`,
   `Object.getPrototypeOf`, and constructor/prototype reads understand realm
   facades through normal runtime MOP dispatch. Remove the current-realm
   TypedArray shortcut once the genuine path covers it.
6. Keep well-known symbols and the `Symbol.for` registry in the correct
   agent-wide store so same-key registry Symbols compare equal across realm
   carriers, while ordinary `Symbol()` calls still create unique identities.
7. Preserve host and standalone parity. Host embedding may delegate realm
   execution to a host realm only if values cross the boundary through the same
   explicit carrier/identity contract; standalone must require no `env::`
   imports.

Dynamic source evaluation is not exercised by this exact 128-file cohort, so a
general `evalScript` engine is not required for the first scored slice. It must
remain a separately explicit capability rather than being faked as a no-op.

## Delivery slices

1. **Realm carrier and identity controls:** create two realms; prove distinct
   globals/intrinsics, stable repeated reads, and shared `Symbol.for` registry.
2. **Constructor/prototype allocation:** Array/Object/Function and native Error
   families, then the `proto-from-ctor-realm` tests that do not need Proxy.
3. **Reflect construction and TypedArray facades:** preserve distinct
   NewTarget/prototype semantics without current-realm aliases.
4. **Proxy and error-realm semantics:** route traps, invariant errors, and
   thrown TypeErrors through the correct realm.
5. **Residual built-ins:** RegExp, Date, JSON, Map/Set, Promise, and the small
   language tail; rerank after each exact two-lane measurement.

Each slice must prove prepared IR ownership for its realm operations. A test
that passes only because foreign and current identities were collapsed is a
regression, not a win.

## Acceptance criteria

- [ ] The pinned 128-file list and both-lane baseline above are reproduced
      before implementation; missing rows or a mismatched Test262 gitlink fail
      the measurement loudly.
- [ ] `$262.createRealm()` returns a distinct, identity-stable realm carrier
      with a distinct global and realm-local intrinsic constructor/prototype
      graph.
- [ ] Cross-realm construction, prototype selection, ordinary property access,
      Proxy dispatch, `instanceof`, and Error identity use normal IR/runtime
      semantics rather than Test262-shaped shortcuts.
- [ ] `Symbol.for`/`Symbol.keyFor` use one agent-wide registry across realms;
      ordinary Symbols remain unique.
- [ ] The current-realm TypedArray prototype alias is removed when its genuine
      realm-backed replacement lands.
- [ ] The exact 128-file cohort is rerun in both lanes after every slice, with
      file-level flips and regressions reported. The eventual target is 128/128
      pass in both lanes with zero new `env::` imports in standalone.
- [ ] Targeted realm terminals are owned once by prepared IR; no targeted body
      is also emitted by legacy codegen.
