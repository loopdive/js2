---
id: 4200
title: "Standalone: `<Builtin>.prototype.constructor` is missing entirely — both the value read and the gOPD descriptor answer undefined"
status: done
assignee: ttraenkler/W18
completed: 2026-08-07
sprint: 78
created: 2026-08-07
updated: 2026-08-18
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

`tests/issue-4200.test.ts` — 31 cases. A/B'd by file copy against
`git show origin/main:<path>` (never `git stash`), then restored byte-identical
to the commit: **18 fail on the unpatched base, 31 pass on this branch.**

The 18 RED are all 10 gOPD descriptor cases, the 7 Error-family value reads, and
the enumerable check. The 13 green on BOTH are load-bearing, not filler:

- `new Error().constructor === Error` — already worked, which is what makes
  this a builtin-PROTOTYPE member gap rather than a missing-carrier bug. A
  fixture built only on the instance form would have passed on unpatched main.
- `gOPD(Array.prototype,"indexOf")` keeps its #2885 method descriptor.
- `Object`/`Array`/`RegExp`'s VALUE read already resolved before this change
  (#3133/#3006) — only their gOPD arm was missing. Those three value-read cases
  are green on both sides, which is why the count is 18 RED and not 20.
- The five declined builtins still answer `undefined`.
- A user `var Error = {...}` shadow keeps its own `constructor`.

The two cross-checks (`Error.prototype.constructor !== TypeError`,
`Object.prototype.constructor !== Array`) also pass on both sides — on base
vacuously, since the left side is `undefined`. They are not evidence on their
own; paired with the `=== <Ctor>` cases passing on the branch they establish
that the branch's identity is a genuine `ref.eq` over two DISTINCT live
singletons rather than a `null === null` tautology.

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

### The 11 global-object files — DO NOT take this as an alias-gate fix

An earlier revision of this file claimed these were "one mechanism gated one
step too tightly": `emitGlobalThisGopdFold` (`dyn-read.ts`) gates on
`arg0.kind === ts.SyntaxKind.ThisKeyword` while the fixtures write
`var global = this;` first, so relax the gate with the alias resolver that
already exists. **That was measured and is WRONG.** Recording it because the
wrong version is the attractive one and someone will re-derive it.

Three files (15.2.3.3-4-178/179/180) use a **direct `this`**, not an alias — so
the alias gate was never their blocker. And in **module** goal the existing fold
already answers all five of their assertions **strictly correctly**
(`writable`/`enumerable`/`configurable` all strictly `false`,
`hasOwnProperty("get"/"set")` strictly `false`). They still fail.

The actual blocker, isolated with two hand-written fixtures run through
`runTest262File(…, "standalone")`:

| fixture | goal | receiver | result |
| --- | --- | --- | --- |
| `gOPD(this,"NaN")` | **script** | direct `this` | `desc === undefined` |
| `var g=this; gOPD(g,"NaN")` | **script** | alias | `desc === undefined` |
| same, with `export` | module | direct `this` | correct descriptor |

So the discriminator is **script vs module goal**, not direct vs aliased
receiver. In script goal top-level `this` is the realm global object (§10.4.1.1)
and standalone has no reified one — `isScriptGlobalThisReceiver`
(`call-builtin-static.ts`) is explicitly `!ctx.standalone`, and its own comment
defers general script-`this` lowering to **#3365**. All 11 sit behind that.

The 8 function-property files need three further things on top, none of which
exist: a §15.1 function-property table, an identity-stable carrier per global
function, and the `global.<fn>` VALUE read — measured, `typeof g.parseInt` is
not `"function"` today, so `desc.value === global.parseInt` cannot hold even
with a correct descriptor. That is the same two-arm carrier problem this issue
solved for `constructor`, but ×8 with no carriers to reuse.

**Verdict: this slice fragments — a substrate dependency (#3365) plus 8 files of
new-carrier work. It is not a cheap follow-up and should not be scoped as one.**

**`undefined.writable` does not throw** (carried over from #4199). It is why
all 41 report `desc.writable Expected SameValue(«undefined», …)` rather than a
TypeError — the descriptor really is `undefined` and the member read silently
succeeds, so the failure surfaces one assertion later than it should. The
signature you would histogram on is not the real defect. Still open.
