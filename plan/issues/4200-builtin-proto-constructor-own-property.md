---
id: 4200
title: "Standalone: `<Builtin>.prototype.constructor` is missing entirely — both the value read and the gOPD descriptor answer undefined"
status: done
assignee: ttraenkler/W18
completed: 2026-08-07
sprint: current
created: 2026-08-07
updated: 2026-08-07
priority: high
horizon: m
feasibility: hard
reasoning_effort: max
task_type: bug
area: codegen
language_feature: builtins, property descriptors, prototypes
goal: standalone-gap
related: [4199, 4176, 3006, 2907, 2984, 2885, 3133, 3251, 3596]
---

# #4200 — `Error.prototype.constructor` reads `undefined` (standalone)

## Symptom

```js
Object.getOwnPropertyDescriptor(Error.prototype, "constructor")  // undefined
Error.prototype.constructor                                      // undefined
```

test262 15.2.3.3-4-27/34/39/62/84/88/116/163/168/170..175 assert the §6.1.7.3
descriptor `{writable:true, enumerable:false, configurable:true}` plus
`desc.value === <C>.prototype.constructor`.

## Root cause: `constructor` is an own property that is not a METHOD

`constructor` is an own data property of every builtin prototype, but the
standalone model advertises a builtin proto's own members through per-brand
**method** tables (`ARRAY_PROTO_METHODS`, `ERROR_PROTO_METHODS`, … in
`array-object-proto.ts`). `constructor` is in none of them, and those tables
gate BOTH consumers:

| consumer | site | behaviour for an unadvertised member |
| --- | --- | --- |
| VALUE read `<B>.prototype.<m>` | `builtin-value-read.ts` → `resolveStandaloneProtoMemberValueClosure` | tier 3 → `null` → dynamic → `undefined` |
| gOPD descriptor (#2885 Site-2) | `expressions/call-builtin-static.ts` | CSV miss → falls through → `undefined` |

**Adding `"constructor"` to those CSVs would be wrong**: the shared consumer
mints a brand-keyed *method closure* per CSV member, so the read would become a
callable refusal stub instead of the constructor object. It needs its own arm.

## Measured — instrument recovered two-sided BEFORE any edit

Base `origin/main` `56a1fcadfd`. Driver: `runTest262File(…, "standalone")` with
the `js2wasm:runtime-eval` namespace shimmed in by wrapping
`WebAssembly.instantiate` (#4163 unlanded). The refusal provider was rebuilt
after the `src/` edit (cache MISS confirmed) and is **byte-identical at 106,154
bytes** in both arms, so it is not a confound.

| measurement | before | after |
| --- | ---: | ---: |
| 558-file ES5 descriptor lever | **178** (reproduces the recorded `origin/main` base exactly) | **188** (**FIXED 10, BROKE 0**) |
| the 15 `<C>.prototype.constructor` files | 0 | 10 |

The 5 not fixed are the builtins with no carrier (below), which the arm
deliberately declines.

## Which carrier — reuse, don't mint a third

The value must be the SAME object the bare `<Builtin>` identifier reads, so
`Error.prototype.constructor === Error` is a genuine `ref.eq`. Standalone
already has exactly two such carriers and this arm dispatches between them:

| carrier | builtins |
| --- | --- |
| `__builtin_ctor_<N>` (#3006) | Set, Map, Weak*, **RegExp**, FinalizationRegistry, Disposable*, SuppressedError |
| `__builtin_<N>` namespace (#2907) | **Object**, **Array**, Math, JSON, Reflect, **Error family** |

`Date`, `String`, `Number`, `Boolean`, `Function` have NEITHER and are
**declined** — they keep today's `undefined`. Minting a carrier for them means
changing what the BARE identifier reads (a strictly wider blast radius than
this arm), so it is left to a follow-up that can measure the bare-value change
on its own. `Function` must stay out regardless: its bare value is the
realm-owned `%Function%` intrinsic in runtime-eval builds, not a plain carrier.

## Implementation

`src/codegen/builtin-proto-constructor.ts` (new) holds the carrier dispatch and
the descriptor synthesis. It is ONE module rather than two call-site patches
precisely because `desc.value === p.constructor` is an assertion in the corpus:
the two arms cannot drift while both call the same emitter. `tryEmit*` returns
`false` having pushed NOTHING when it declines, and resolves
`__create_descriptor` + flushes shifts BEFORE emitting the value, so a late
import registered by the carrier's own lowering cannot invalidate the captured
funcIdx.

Wired at two sites, both already `ctx.standalone`-gated; host/gc bytes are
untouched (they keep the genuine `Object_get_constructor` read).

## Verification

`tests/issue-4200.test.ts` — 31 cases. The 20 descriptor/identity cases are RED
on the unpatched base and green on this branch. Green on **both** sides, and
load-bearing:

- `new Error().constructor === Error` — already worked, which is what makes
  this a builtin-PROTOTYPE member gap rather than a missing-carrier bug. A
  fixture built only on the instance form would have passed on unpatched main.
- `gOPD(Array.prototype,"indexOf")` keeps its #2885 method descriptor.
- `Error.prototype.constructor !== TypeError` and
  `Object.prototype.constructor !== Array` — distinct singletons, so the
  identity is not a `null === null` tautology.
- The five declined builtins still answer `undefined`.
- A user `var Error = {...}` shadow keeps its own `constructor`.

## Findings for the next lane — the rest of M4, re-bucketed by TRUE root cause

W17's census called M4 "41 files, one mechanism (attributes of a builtin's own
property)". Measured per-file, it is **four** mechanisms, and only the first is
what this issue fixes:

| n | mechanism | state |
| ---: | --- | --- |
| 15 | `<Ctor>.prototype.constructor` | **10 fixed here**; 5 need a bare-value carrier for Date/String/Number/Boolean |
| 14 | `verifyProperty` on a builtin proto | **NOT a descriptor bug** — see below |
| 11 | global-object receiver (`var global = this`) | needs a §15.1 own-property table |
| 1 | `f.length` on a user function | unexamined |

**The 14 `verifyProperty` files are NOT a gOPD defect and must not be filed as
one.** Their error is `"<m> should be an own property"`, which is
`hasOwnProperty`, not `gOPD`. Measured directly:
`gOPD(Array.prototype,"every")` returns a **correct** `{w:true,e:false,c:true}`
descriptor — but only when the receiver is written as a **direct syntactic**
`<Builtin>.prototype`. Bind it first (`var o = Array.prototype`) and it returns
`undefined`, because the whole mechanism is compile-time synthesis. Since
`verifyProperty(obj, …)` takes the receiver as a **parameter**, no static
synthesis can ever fire there. These need the native proto to become a
runtime-queryable object — the #3251/#3596 substrate, not a table extension.

**The 11 global-object files have a working mechanism that is gated one step
too tightly.** `emitGlobalThisGopdFold` (`dyn-read.ts`) already synthesizes the
§19.1 descriptor for `NaN`/`Infinity`/`undefined`, but its gate is
`arg0.kind === ts.SyntaxKind.ThisKeyword` — a *direct* `this` — while every one
of the 11 fixtures writes `var global = this;` first. `builtin-static-gopd.ts`
already contains exactly the alias-following resolver this needs
(`resolveBuiltinReceiverName`, #2984 bucket-1). Extending the fold to (a) trace
the one-level alias and (b) cover the §15.1 function properties
(`eval`/`parseInt`/`parseFloat`/`isNaN`/`isFinite`/`decodeURI(Component)`/
`encodeURIComponent`, `{w:true,e:false,c:true}`) looks like the next-largest
tractable slice in this family. Note `isScriptGlobalThisReceiver`
(`call-builtin-static.ts`) is explicitly `!ctx.standalone`, so there is no
reified global object to fall back on.

**`undefined.writable` does not throw** (carried over from #4199). It is why
all 41 report `desc.writable Expected SameValue(«undefined», …)` rather than a
TypeError — the descriptor really is `undefined` and the member read silently
succeeds, so the failure surfaces one assertion later than it should. The
signature you would histogram on is not the real defect. Still open.
