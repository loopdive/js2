---
id: 3610
title: "Standalone builtins are missing receiver brand checks — 65-test trap cluster (illegal_cast/null_deref/oob) unmasked by the #3592 de-vacuification"
status: in-progress
assignee: ttraenkler/opus-3610
sprint: current
priority: high
horizon: l
feasibility: hard
goal: standalone-gap
related: [3592, 3596, 3601]
created: 2026-07-25
# The gate's BODY lives in the new subsystem module
# src/codegen/builtin-prototype-brand.ts. What lands in these two files is the
# dispatch WIRING only (+13 / +20 lines, the majority of it the comment
# explaining why the new arm must run BEFORE tryBufferViewAttributeReads /
# before any receiver-name arm can claim the call). Both files ARE the dispatch
# chains — there is nowhere else a new dispatch step can be registered.
loc-budget-allow:
  - src/codegen/property-access.ts
  - src/codegen/expressions/call-receiver-method.ts
# Same +20: the gate must be the FIRST arm of compileReceiverMethodCall (any
# later position lets a receiver-name-keyed arm claim the call first), so the
# registration is necessarily inside this function.
func-budget-allow:
  - src/codegen/expressions/call-receiver-method.ts::compileReceiverMethodCall
---

## Problem

The #3592 RC2 de-vacuification (`__apply_closure` dispatching at
`max(argc, declaredArity)`) made previously-skipped harness callbacks actually
run — and 65 previously-(vacuously)-passing tests now reach **genuine
pre-existing trap defects** in the standalone lane: uncatchable `illegal_cast`
(43), `null_deref` (21), and `oob` (1) where the spec requires a catchable
`TypeError`/abrupt completion.

These are **real bugs that were invisible behind fake passes**. They are
gate-excused on the #3592 landing PR (loopdive/js2#3601) via the named
`standalone-devacuification-allow` trap tier so the honest-floor landing is not
blocked — but the excusal is NOT a fix. This issue tracks the defects.

## Root cause — precisely characterised (measured, not assumed)

**Standalone builtin prototype methods/accessors skip the receiver brand check
and cast unconditionally.** Where the spec says "if `this` does not have
[[TypedArrayName]] / [[DateValue]] / … throw TypeError", the standalone
lowering emits a direct `ref.cast` (→ `illegal_cast` trap) or a null field
access (→ `null_deref` trap). A trap aborts the module and escapes
`try`/`catch`, so `assert.throws(TypeError, …)` can never observe the
expected TypeError.

One-line repros, arity-clean (NO under-applied call anywhere; verified to
reproduce on a pre-#3592 compiler build, so unambiguously pre-existing):

```ts
// illegal_cast cluster (12x TypedArrayConstructors/*/prototype/not-typedarray-object.js):
const b = Uint8ClampedArray.prototype.buffer; // → wasm trap: cast failure (spec: TypeError)

// null_deref cluster (Date.prototype.* on a non-Date receiver):
const t = Date.prototype.getTime(); // → wasm trap: null reference (spec: TypeError)
```

Discriminator evidence (2026-07-25, #3601 park partition):

- All 65 flips: widening-OFF **pass** (vacuous — callee never ran),
  widening-ON **trap**, innermost wasm frame is the CALLEE
  (`__closure_NN` / `C_method` / `toString` / …), never the dispatcher
  (`__call_fn_method_N`): 0 of 65.
- 20/20 shape-representative correct-arity bypass controls (explicit third
  argument so dispatch is exact-arity, widening DISABLED) trap **identically**
  — same trap class, same innermost frame, same source line. The dispatcher is
  exonerated; the callee code is genuinely defective.
- Full per-file table: `## #3601 park partition` in
  `plan/issues/3592-standalone-vacuous-asserts-arity-and-toplevel-throw.md`.

## Clusters (65 files)

| cluster                                                                                                                                                                                                                                                                                                                                        | count | trap         | shape                                                                                                       |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----: | ------------ | ----------------------------------------------------------------------------------------------------------- |
| `TypedArrayConstructors/*/prototype/not-typedarray-object`                                                                                                                                                                                                                                                                                     |    12 | illegal_cast | prototype accessor (`.buffer` etc.) on the plain prototype object — missing [[TypedArrayName]] brand check  |
| `Array.prototype.{findLast,findLastIndex,find,fill,copyWithin}` return-abrupt                                                                                                                                                                                                                                                                  |    11 | illegal_cast | abrupt completion from poisoned `length`/property — harness `assert.throws` internals cast the thrown value |
| eval-code/direct `*arguments-lex-bind*`                                                                                                                                                                                                                                                                                                        |     6 | illegal_cast | SyntaxError-expectation path                                                                                |
| `Date.prototype.*` non-Date receiver (`no-date-value`, `toString`, `setFullYear`, `Symbol.toPrimitive`)                                                                                                                                                                                                                                        |     5 | null_deref   | missing [[DateValue]] brand check                                                                           |
| `Proxy/getOwnPropertyDescriptor` + `deleteProperty` invariant checks                                                                                                                                                                                                                                                                           |     5 | null_deref   | trap-result invariant violation path                                                                        |
| `TypedArray.prototype.join` return-abrupt-from-separator (+BigInt)                                                                                                                                                                                                                                                                             |     4 | illegal_cast | abrupt separator                                                                                            |
| class/dstr `gen-meth-*-ary-init-iter-get-err-array-prototype`                                                                                                                                                                                                                                                                                  |     4 | illegal_cast | poisoned `Array.prototype[Symbol.iterator]`                                                                 |
| `Function.prototype[Symbol.hasInstance]` poisoned/non-object prototype                                                                                                                                                                                                                                                                         |     3 | null_deref   | OrdinaryHasInstance error paths                                                                             |
| class elements private-field errors (`private-fields-proxy-default-handler-throws`, `privatefieldset-evaluation-order-1`)                                                                                                                                                                                                                      |     2 | mixed        | private-field access on invalid receiver                                                                    |
| `String.prototype.replaceAll` replaceValue-call-abrupt (+tostring)                                                                                                                                                                                                                                                                             |     2 | illegal_cast | abrupt replaceValue                                                                                         |
| `escape`/`unescape` to-primitive-err                                                                                                                                                                                                                                                                                                           |     2 | illegal_cast | abrupt ToPrimitive                                                                                          |
| singles: `Array.prototype.with` (oob), `ArrayBuffer maxByteLength invoked-as-accessor`, `Iterator.concat non-constructible`, `Object.defineProperty 15.2.3.6-4-117`, `String.split valueOf limit`, `Symbol.for to-string-err`, `ThrowTypeError`, `Function/15.3.5.4_2-97gs`, `DisposableStack move`, `derived-class-return-override-with-null` |    10 | mixed        | various error paths                                                                                         |

(Exact 65 paths: the `tests:` list under `standalone-devacuification-allow` in
issue #3592's frontmatter — machine-consumed by `scripts/diff-test262.ts`.)

## Why this matters beyond the 65

A trap is strictly worse than a wrong answer (crash-free goal,
`plan/goals/goal-graph.md`): it aborts the whole module and poisons every
assertion after it. The 65 are only the tests whose FIRST newly-executed
assertion hits the defect.

### The reusable generalisation (read this before writing any receiver-keyed arm)

**This was never a missing runtime check. It was the type system asserting
something false about a specific value, and codegen believing it.**

`lib.d.ts` declares `interface DateConstructor { prototype: Date }` (and the
same shape for every builtin: `Uint8ClampedArrayConstructor.prototype:
Uint8ClampedArray`, …). So `checker.getTypeAtLocation(Date.prototype)` answers
**`Date`** — a true statement about the _declared_ type and a false statement
about the _value_, which is an ordinary object with no `[[DateValue]]` slot.
Any codegen arm that discriminates its receiver by **type name**
(`objType.getSymbol()?.name`, `ctx.oracle.builtinReceiverOf`) therefore emits
the **instance** lowering for a **non-instance** value: an unconditional
`ref.cast` to the backing struct, or a bare `struct.get` on what is actually
null. Both are uncatchable traps.

The invariant to hold: **a `ref.cast` is a claim that the value's runtime
representation is known. A TS type name is not that evidence.** Where the two
can diverge you need either

- a **compile-time** decision, when the divergence is statically decidable and
  the spec's answer is unconditional (this issue: `<Ctor>.prototype.<member>`
  provably lacks the slot, so the TypeError is emitted directly and the check
  costs nothing at runtime); or
- a **runtime** brand test (`receiver-brand.ts`'s `emitReceiverBrandCheck` —
  non-trapping `ref.test` + catchable TypeError on the miss), when it is not.

Never the bare cast.

**Every receiver-name-keyed arm in `src/codegen/` carries this latent shape**
— there are ~68 `getSymbol()?.name` sites. #3062 had already hand-patched two
members (`byteLength`/`byteOffset`) before anyone named the pattern; this
issue generalised it; **#3620 is the same shape again in a different
subsystem** (a generator state field typed from the checker's inferred tuple
type while the runtime value is a plain vec, producing an unconditional
`ref.cast` that traps). Expect more.

## Acceptance criteria

- [ ] Receiver brand checks on standalone builtin prototype methods/accessors
      throw catchable TypeError instead of trapping (start with the two proven
      clusters: TypedArray prototype accessors, Date.prototype methods).
- [ ] The two one-line repros above return 2 (caught TypeError) instead of
      trapping, host-free.
- [ ] The 65 cluster tests flip trap → honest fail or pass; the #3189 trap
      categories shrink accordingly.
- [ ] No `oracle_version` bump needed (codegen change, not verdict logic).

---

## Slice 1 — the STATIC `<Builtin>.prototype.<member>` brand gate (landed)

`src/codegen/builtin-prototype-brand.ts`.

### Root cause (measured, not assumed)

The clusters were assumed to need a _runtime_ brand check. Measurement says the
first and largest slice needs **no runtime check at all** — the receiver is
statically decidable.

Nearly every native builtin arm keys its receiver off the **TypeScript type
name** (`objType.getSymbol()?.name` / `ctx.oracle.builtinReceiverOf`). lib.d.ts
declares `interface DateConstructor { prototype: Date }` and
`interface Uint8ClampedArrayConstructor { prototype: Uint8ClampedArray }` — so
`Uint8ClampedArray.prototype` has TS type `Uint8ClampedArray` and
`Date.prototype` has TS type `Date`. Every such arm therefore treats the
**prototype object** as an **instance** and emits the instance lowering:

- `src/codegen/property-access-dispatch.ts:1003-1013` (`.buffer`) — an
  unconditional `ref.cast` of the receiver to the backing view vec →
  `illegal cast`.
- same file `:688-723` (`.maxByteLength` / `.resizable`) — `ref.cast` to
  `$__vec_i32_byte` → `illegal cast`.
- `src/codegen/expressions/builtins.ts` `compileDateMethodCall` — compiles the
  receiver at `(ref $Date)`, gets a null, then `struct.get` → `null reference`.
- `%TypedArray%.prototype.set([])` did not even produce a **valid module**
  (`array.set[2] expected type …`) — strictly worse than a trap.

`#3062` had already patched exactly two members (`byteLength`/`byteOffset`) by
nulling out `recvName` for a `.prototype` receiver inline; that one-off is what
this slice generalises.

### Why STATIC, not a runtime `ref.test`

Every gated member's spec step 1 is `RequireInternalSlot` /
`ValidateTypedArray` / `thisTimeValue`, and a builtin's `.prototype` is an
ordinary object that **provably never** carries that slot (§23.2.7, §21.4.4,
§25.1.5, …). So `<Ctor>.prototype.<member>` is a compile-time-decidable
unconditional TypeError. Compiling the check away costs nothing on the instance
hot path, which a blanket `ref.test` in `compileDateMethodCall` would not — and
that arm is shared with the JS-host lane, so widening it there was the riskier
design.

The runtime sibling already exists: `receiver-brand.ts`'s
`emitReceiverBrandCheck` (non-trapping `ref.test` → catchable TypeError),
used by the reflective closure bodies. The two are complementary — this gate
covers the syntactic prototype receiver that never reaches a reflective closure.

### Shadow safety

Fires only when the base identifier's own type symbol is the lib
`<Name>Constructor` interface (`ctx.oracle.declaredNameOf(id) === name + "Constructor"`,
i.e. `declare var Date: DateConstructor`). A user `class Date {}` types its
identifier as `typeof Date` (symbol name `Date`) and is never gated — strictly
tighter than the `getSymbol()?.name` test the surrounding arms use, and
answered entirely through `ctx.oracle` (no raw-checker growth).

### Lane scope

`noJsHost || strictNoHostImports` only. In JS-host mode these reads/calls
already route to the host getter and throw a genuine host TypeError; the
JS-host lane is a separate required gate at 30,405 and is not broken here.

### Measured result

Re-ran all 65 `standalone-devacuification-allow` tests before/after on this
branch (`runTest262File(..., "standalone")`):

|                                                      | before |  after |
| ---------------------------------------------------- | -----: | -----: |
| trap-category failures (illegal_cast/null_deref/oob) | **65** | **49** |
| pass                                                 |      0 | **14** |

- **14 trap → pass**: 11 `TypedArrayConstructors/*/prototype/not-typedarray-object.js`,
  `ArrayBuffer/prototype/maxByteLength/invoked-as-accessor.js`,
  `Date/prototype/no-date-value.js`, `Date/prototype/setFullYear/15.9.5.40_1.js`.
- **1 trap → honest non-trap fail**: `Date/prototype/toString/non-date-receiver.js`
  — its first assertion now throws correctly; the remaining
  `Date.prototype.toString.call(<primitive>)` sub-cases are the reflective path
  (Slice 2), so the file still fails, but no longer fatally.
- Direct compile+instantiate probes (independent of the runner's payload
  renderer) confirm each gated form returns `2` = `e instanceof TypeError` was
  observably true **inside** the compiled module.

Additional uncatchable traps fixed that the corpus does not currently exercise
(same defect, verified by probe: all were `illegal cast` before, all are
catchable TypeErrors now):
`%TypedArray%.prototype.{fill,slice,subarray,join,set}`,
`ArrayBuffer.prototype.slice`, `Map.prototype.{get,set}`,
`Set.prototype.{add,has}`, `WeakMap.prototype.get`.

Negative controls: the full positive-control battery (TypedArray/Date/Map/Set
instance accessors + methods, reflective `X.prototype.m.call(realInstance)`,
user-class shadowing) produces **byte-identical output before and after** on
both `standalone` and `gc` targets.

### Honest scope note — this is NOT most of the 753

Census of the standalone baseline JSONL (461 trap rows at the pre-#3592
baseline; 753 post-landing) by innermost frame shows the trap population is
**heterogeneous** and mostly NOT missing receiver brand checks:

| bucket                                                                                                       |                    count | in this lane?    |
| ------------------------------------------------------------------------------------------------------------ | -----------------------: | ---------------- |
| `illegal cast [in __module_init()]`                                                                          |                       79 | no               |
| `illegal cast [in C_method() ← __module_init]` (class-dstr gen-methods)                                      |                    69+19 | no               |
| async continuation `illegal cast` (Promise combinators / for-await dstr)                                     |                      111 | no               |
| `illegal cast [in __closure ← __closure ← __call_fn_method_3 ← __apply_closure]` (abrupt-completion payload) |                       40 | partly (Slice 3) |
| `illegal cast [… ← __call_accessor_get ← __extern_get]` (compound-assign poisoned accessor)                  |                       30 | no               |
| `<Ctor>.prototype.<member>` static receiver                                                                  | 12 baseline + 4 unmasked | **yes — fixed**  |

Do not expect a brand-check mechanism to move the other buckets; they need
their own root-cause work (the class-dstr and async-continuation buckets are
the two big rocks).

## Remaining work (Slice 2+)

1. **Reflective receivers** — `X.prototype.m.call(<non-instance>)` and
   `gOPD(X.prototype, p).get.call(<non-instance>)`. Some families already have
   the runtime check (`receiver-brand.ts`); `Date.prototype.toString.call(0)`
   does not. ~1 test in the 65.
2. **`Function.prototype[Symbol.hasInstance]`** (3 tests, null_deref) —
   OrdinaryHasInstance error paths; not a prototype-receiver shape.
3. **`Proxy` gOPD / deleteProperty invariant checks** (5 tests, null_deref).
4. **`Array.prototype.{fill,copyWithin,find,findLast,findLastIndex}`
   return-abrupt** (11 tests) — the trap is on the _thrown value_, not the
   receiver; despite the issue's original grouping this is an
   abrupt-completion-payload defect, not a brand check.
5. **Non-trap correctness gaps found while measuring** (wrong value, no trap):
   `RegExp.prototype.exec()`, `Symbol.prototype.{toString,valueOf,description}`
   on the prototype return a value instead of throwing.
