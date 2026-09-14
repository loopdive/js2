---
id: 4274
title: "ES2015 true realms: replace `$262.createRealm` pseudo-realm with IR/runtime realm identity (128 files)"
status: ready
sprint: current
created: 2026-08-09
updated: 2026-09-13
priority: high
horizon: xl
feasibility: hard
reasoning_effort: max
model: gpt-5.6-terra
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

## 2026-09-13 redispatch plan

**Coordination hold:** the user identified a parallel IR-migration session.
Do not claim or start this prepared-IR/runtime implementation until its active
owner agrees on boundaries and landing order. The older app task titled
`IR migration` confirmed it has handed off and cannot certify its successor's
reservations. This is queued design work, not an active implementation claim.

The canonical standalone baseline produced at
`e0023dbbe6c37e15c1f56ed0c8bc8d15d0afbac3` (JSONL SHA-256
`07c89a5c2626f3312ff611f008a69ed6d8826e9802da024df39726ddabc1e9ba`)
contains 129 official ES2015 files whose original source calls
`$262.createRealm`: 25 pass, 103 fail, and one compile error. This source-call
selection has been reconciled against the historical 128-file feature cohort.
The tagged cohort retains exactly the historical manifest hash below and now
has 25 pass, 102 fail, and one compile error. The sole additional source-call
file is `test/built-ins/Proxy/revocable/tco-fn-realm.js` (fail). The sorted
129-path source-call manifest, using `test/` prefixes and a final newline, has
SHA-256 `6fd14b2192e62853ae0c039b2efdd9e72c23c2e7bf43a917f4e7677f89e4b7a6`.
Retain both exact manifests; do not silently change the acceptance population.
The 104 nonpasses include 24 Proxy, 13 Function, 13 Symbol, ten Array, eight
RegExp, and six NativeErrors rows. These are overlapping family symptoms;
they do not establish that one realm change fixes all 104.

The existing claim was released; the 2026-09-13 live check found no active
owner. Keep the issue ready until a worker claims the first implementation
slice. Implement with Terra Max in an isolated worktree per user routing.

The next predispatch read at upstream
`e06f76745bb0008550d17df3c0c0dae35bed6c01` again found no active claim
(the old claim remains released) and no open PR matching issue 4274.
PR #5841 is open at `4a0f8a92c279a903e15762a77c9cc23cd5211c23` and
PR #5847 is open at `c0ca1a551012bc78ff491dae66068227e82c1bde`.
They own current-global/provider outlining and accessor population, not
distinct foreign-realm identity. Both touch context, index, registry, and
link-boundary modules; #5847 adds `native-globalthis-outline.ts`. Coordinate
those shared integration seams and keep the realm carrier in a separate
owner module. This read is not a claim or authorization to overwrite either
PR's implementation; recheck ownership when a worker actually starts.

Before implementing, reproduce two realm-identity failures and passing
controls using the maintained runner. Re-ground the explicit realm-carrier
and prepared-IR design below against current compiler/runtime ownership.
Deliver the carrier and identity controls first, then independently measured
constructor/prototype and shared-Symbol-registry behavior. Do not replace
foreign intrinsics with current-realm aliases or weaken the harness oracle.
Audit open global-realm/Temporal seed PRs #5847 and #5841 for ownership overlap;
their provider initialization work is not this separate cross-realm identity
implementation. Each finished slice needs an upstream PR and recorded exact
before/after rows, while the full issue remains open until all criteria pass.

Source ownership was rechecked at the pinned baseline before redispatch:
`tests/test262-runner.ts` still emits an empty self-referential realm global.
`src/codegen/property-access-dispatch.ts::tryConstructorPrototypeIdentity`
still aliases the foreign TypedArray prototype shape to current-realm
singletons. Also audit
`src/codegen/proxy-value-provenance.ts::isRealmGlobalExpression`: it treats a
`.global` read from a method named `createRealm` as native Proxy provenance.
This additional shortcut means a passing Proxy construction row does not
prove foreign constructor or error-realm identity. Preserve its ordinary
Proxy behavior when replacing the alias with real realm provenance; include
an unrelated user-defined `createRealm` method as a negative provenance
control. Existing canonical-global plumbing serves the current realm and
must not be mistaken for a multi-realm carrier merely because its name
contains `realm`.

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
