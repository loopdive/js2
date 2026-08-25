---
id: 4248
title: "Standalone: `Number`/`Boolean`/`String`.prototype are not wrapper objects — own members invisible, no [[PrimitiveValue]], default-receiver methods answer null"
status: done
completed: 2026-08-09
sprint: 78
created: 2026-08-08
updated: 2026-08-18
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
es_edition: 5
language_feature: primitive-wrappers, property-model, builtin-prototypes
goal: es5
related: [4234, 4232, 4223, 4230, 2984, 2175, 4176]
loc-budget-allow:
  # +5: the finalize splice call plus the comment saying why it runs AFTER the
  # closed-struct prologue. The arm itself is a satellite module.
  - src/codegen/index.ts
func-budget-allow:
  # The three RC splice calls (hasOwn arms, ToPrimitive arm, method-identity
  # arm) are wired into BOTH module drivers, +11 lines each. The arms live in
  # the satellite modules; only the finalize-ordered call sites are here.
  - src/codegen/index.ts::generateModule
  - src/codegen/index.ts::generateMultiModule
coercion-sites-allow:
  # RC2 answers ToPrimitive for the three wrapper PROTOTYPES via the existing
  # __to_primitive engine entry (one arm spliced onto it) — a routed use of
  # the single coercion engine, not a hand-rolled matrix.
  - src/codegen/native-proto-wrapper-primitive.ts
---

# #4248 — builtin prototypes are wrapper objects, and standalone treats them as bare metadata

**Outcome: +25 measured, 0 regressions** across three independent root causes
(RC1 +16, RC2 +3, RC3 +6). Every number below is a sequential, one-file-per-
process A/B on this branch, not an estimate.

`Number.prototype` in standalone is a `$NativeProto` glue singleton
(native-proto.ts) — a struct holding a brand, a member CSV and a name. ES5 says
it is a **Number object** whose [[PrimitiveValue]] is `+0`, whose methods are
its **own** properties, and whose `valueOf`/`toString` are brand-checked. Four
independent things follow from that gap. Measured on the wave-3 merged base
(`built-ins/Number/prototype` recursive **117/168**, `built-ins/Boolean`
recursive **30/51**).

## RC1 — a `$NativeProto`'s own members are invisible to `hasOwnProperty`

**Root cause.** `__hasOwnProperty` (object-runtime.ts) does
`any.convert_extern(recv)` → `ref.test $Object` → `__obj_find` on the own-props
hash table. A `$NativeProto` is not a `$Object`, so it failed the `ref.test` and
fell out at `bagHasIfAbsent`. The member set it *does* carry lives in the
`$memberCsv` field as a native string, which no table walk can see.

```js
Number.prototype.hasOwnProperty("toString")                      // false, want true
Object.prototype.hasOwnProperty.call(Number.prototype, "valueOf") // false, want true
```

**Why it is worth more than the seven Sputnik files it looks like.** The second
spelling is the FIRST line of `propertyHelper.js`'s `verifyProperty`, so the
whole `built-ins/Number/prototype/<m>/prop-desc.js` family died on it — with the
message `toString should be an own property`, which names the member but not the
receiver kind and reads like a descriptor bug. It is not: the descriptor
synthesis behind it (#2885 Site-2) was already correct on the same build —
`gOPD(Number.prototype, "toString").value === Number.prototype.toString` held.
Anyone chasing the message into the descriptor code finds working code.

**Fix.** `src/codegen/native-proto-own-props.ts` (new) —
`__nproto_hasown(obj, key)` scans the receiver's own `$memberCsv` as a
comma-delimited token list and answers `constructor` from §15.x.4.1. Spliced as
a consult-only prologue onto `__hasOwnProperty` / `__object_hasOwn` /
`__propertyIsEnumerable` at finalize.

- **A CSV scan, not a per-brand `__str_equals` chain**: the arm goes into three
  bodies and `String.prototype` alone advertises 36 members across ~14
  registered brands. The scan is constant-size and brand-agnostic, so a glue
  registered later is covered for free.
- **`constructor` is answered from the SPEC, not from the `$ctor` field.** The
  field is still null in the S1 `$NativeProto` (the `.constructor` VALUE comes
  from a static fold / #4223's carrier), so a `ref.is_null` test on it would
  answer `false` for every prototype in the corpus.
- **`$isClass != 0` declines.** A user class proto is a `$NativeProto` façade
  (#2101) whose own-property question is answered elsewhere.
- **Demand gate**: `ctx.nativeProtoTypeIdx === undefined` ⇒ nothing minted, no
  body touched. Exact rather than heuristic — the struct type is registered by
  the same call that builds the singleton. #4232 §5's lesson is about carriers
  that materialize CLOSURES; this native materializes nothing.

### Measured — +16, 0 regressions

Sequential, one file per process, A/B by file swap of `src/codegen/index.ts`
(the satellite module is inert when unreferenced).

| directory                            | before  | after   | delta |
| ------------------------------------ | ------- | ------- | ----- |
| `built-ins/Number/prototype` (rec)   | 117/168 | 131/168 | **+14** |
| `built-ins/Object/prototype` (rec)   | 121/248 | 123/248 | **+2**  |
| `built-ins/String` (top)             | 74/92   | 74/92   | 0     |
| `built-ins/Boolean` (rec)            | 30/51   | 30/51   | 0     |

Per-file diff: zero lost, zero status changes other than the sixteen gains.
The sixteen are `S15.7.4_A3.{1..7}`, `Number/prototype/constructor.js`, the six
`Number/prototype/{toExponential,toFixed,toLocaleString,toPrecision,toString,
valueOf}/prop-desc.js`, `Object/prototype/hasOwnProperty/S15.2.4.5_A1_T1.js` and
`Object/prototype/toString/prop-desc.js`.

## RC2 — the three wrapper prototypes have no [[PrimitiveValue]]

**Root cause.** §15.7.4 makes `Number.prototype` itself a Number object with
[[PrimitiveValue]] `+0` (§15.5.4 `""`, §15.6.4 `false`), so
`Number.prototype == 0` is true. `__to_primitive` recovers a wrapper's
primitive from the FLAG_INTERNAL own-slot of a `$Object`; a `$NativeProto` has
no own-props table, failed the `ref.test $Object`, and fell into the
"non-`$Object` → return unchanged" arm, so the comparison ran against the
object.

**Fix.** `src/codegen/native-proto-wrapper-primitive.ts` (new) — a three-way
`i32.eq` on `$brand`, spliced at the FRONT of `__to_primitive`. Not modelled by
widening `$NativeProto` with a slot: the value is a per-brand CONSTANT, and a
new externref field would land on every builtin prototype in the module. `+0`
is emitted as the i31 small-int box directly — `__box_number`'s own body routes
`+0` to exactly that shape, and `__to_primitive`'s leading early-out already
names an i31 as already-primitive. A null externref converts to a null anyref
and `ref.test` answers 0, so a null receiver still reaches the original first
instruction.

### Measured — +3, 0 regressions

| directory                          | before  | after   | delta |
| ---------------------------------- | ------- | ------- | ----- |
| `built-ins/Number/prototype` (rec) | 131/168 | 133/168 | **+2** |
| `built-ins/String` (top)           | 74/92   | 75/92   | **+1** |
| `built-ins/Object/prototype` (rec) | 123/248 | 123/248 | 0     |
| `built-ins/Number` (top)           | 106/120 | 106/120 | 0     |
| `built-ins/Boolean` (rec)          | 30/51   | 30/51   | 0     |

The `built-ins/String` gain is `S15.5.2.1_A2_T1`, an "illegal cast" TRAP, not
an equality assertion — the arm's reach is wider than the `==` files that
motivated it.

## RC3 — `(new Number()).toString` is not `Number.prototype.toString`

**Root cause.** The static read resolves to the identity-stable
per-(brand, member) singleton (#2175 V2-S2). The dynamic read off an instance
goes through `__extern_get`, whose proto-walk follows `$Object.$proto`; a
wrapper's [[Prototype]] is a `$NativeProto`, so the walk terminates immediately
and the read answers `undefined`.

**The trap #4234 flagged is real and structural.** Before the fix BOTH sides
of `(new Number()).toString === Number.prototype.toString` could read as
absent, and `undefined === undefined` is `true`. The suite therefore asserts
each side is a real function first and cross-checks that
`n.toString !== Number.prototype.valueOf`.

**Fix.** `src/codegen/native-proto-instance-method-read.ts` (new) — an
`__extern_get` arm answering two receiver shapes: a wrapper `$Object` (brand
recovered from the `[[PrimitiveValue]]` box type, exactly as #4223's
`.constructor` arm does) and the `$NativeProto` itself (the
`var NP = Number.prototype; NP.toString` spelling the static fold cannot see).
`__obj_find` is probed first, so §7.3.2 shadowing holds.

**The demand gate is the closure table itself.** The arm answers only for
(brand, member) pairs the module has ALREADY minted, found by scanning
`ctx.funcMap` for `__proto_method_<brand>_<member>`; nothing new is
materialized. That is the RIGHT gate, not just a cheap one: the identity
question cannot arise unless the module also names the prototype member — you
need both sides to compare them — so the demanded set and the answerable set
coincide. The alternative (mint every member of every present brand) is the
#4232 §5 pull-in: `String.prototype` alone is 36 closures with bodies.

### Measured — +6, 0 regressions

| directory                          | before  | after   | delta |
| ---------------------------------- | ------- | ------- | ----- |
| `built-ins/Number` (top)           | 106/120 | 112/120 | **+6** |
| `built-ins/Number/prototype` (rec) | 133/168 | 133/168 | 0     |
| `built-ins/String` (top)           | 75/92   | 75/92   | 0     |
| `built-ins/Object/prototype` (rec) | 123/248 | 123/248 | 0     |
| `built-ins/Boolean` (rec)          | 30/51   | 30/51   | 0     |

The six are `S15.7.5_A1_T02` … `_T07`.

**Pre-existing, NOT introduced here:** `var n = new Number(5); n.toString()`
(the JS-lane dynamic CALL, as opposed to the value read) throws
`Number.prototype.toString is not yet implemented in --target standalone` — it
resolves to the `refusalBodyFallback` closure. Verified identical on the base
commit before this arm existed. Wiring real native bodies for the
Number/Boolean proto methods is the follow-up that would close it.

## Files

- `src/codegen/native-proto-own-props.ts` — RC1: the own-property native + splice
- `src/codegen/native-proto-wrapper-primitive.ts` — RC2: the ToPrimitive arm
- `src/codegen/native-proto-instance-method-read.ts` — RC3: the `__extern_get` arm
- `src/codegen/index.ts` — the finalize call sites (both single- and multi-module)
- `tests/es5-standalone-wrapper-prototype.test.ts`

## Leftovers, with the mechanism named

Measured and deliberately not taken. Every one was reached and diagnosed, so
the next lane does not re-derive it.

- **`delete <Proto>.toString` then `<Proto>.toString()` → `"[object X]"`**
  (5 files: `Number/prototype/S15.7.3.1_A2_T1`, `S15.7.4_A1`,
  `Boolean/prototype/S15.6.3.1_A1`, `String/prototype/S15.5.4_A1`,
  `S15.5.4_A3`). Needs `delete` on a `$NativeProto` member (the CSV is a
  compile-time constant string, so removal needs a per-proto deleted-set) AND
  an `Object.prototype.toString` fallback that reports the receiver's [[Class]]
  from `$name`. Both halves are required; neither alone flips a file.
- **`Boolean.prototype.toString()` → `"false"`** — RC2 fixed the String
  equivalents for free (`String.prototype.toString()` / `valueOf()` now answer
  `""`), and `Number.prototype.valueOf("argument")` flipped with it, but
  Boolean's `toString` takes a different static arm and still answers null.
- **Brand TypeErrors on a TRANSFERRED method** (~13 files:
  `Number/prototype/{toString,valueOf}/S15.7.4.*_A2_T*`,
  `Boolean/prototype/{toString,valueOf}/S15.6.4.*_A2_T*`). Probed: the
  `s1.valueOf = Number.prototype.valueOf; s1.valueOf()` spelling DOES throw
  TypeError today, but `s2.myValueOf = …; s2.myValueOf()` — the second block of
  every one of those files — does not. So the brand-recovery prologue is
  reached through the same-name transfer and bypassed through the renamed one.
- **`length.js` / `name.js` "descriptor should be configurable"** (~16 across
  Number/Boolean proto method dirs). This is `verifyProperty` on the CLOSURE
  object, not on the prototype — `gOPD(Number.prototype.toString, "length")`
  already reports `configurable: true`, so the failure is in
  `verifyConfigurable`'s delete-and-recheck, a different surface from anything
  here.
- **`built-ins/global` attribute tests** — assessed, and the assessment is that
  #4230's finding still holds: the global object has NO own property records
  for its intrinsics (`gOPD(globalThis,"NaN")` is `undefined`). The 18 failures
  split as 8 eval-gated, 4 needing a bare-identifier carrier for `parseInt` /
  `Date` (`S10.2.3_A1.1_T2`/`_T3`, `A1.2_T2`/`_T3` fail with
  `parseInt === null` — the same #4200/#4223 omission the wrapper ctors had),
  2 strict-assignment TypeErrors, and `global-object.js` / `property-descriptor.js`
  needing the global modelled as an ordinary object. Only the carrier group is
  cheap; the attribute group is structural, as #4230 said.

## Cross-lane and suite verification

- **gc/host lane is byte-identical.** A wrapper-prototype-heavy module compiled
  with the default target hashes to
  `6efc85e9b280ae502185cfc2a4d9207169f0bb7e6aaab9305e3f3c0d32d025a4` (2,886
  bytes) both on `da09229a~1` (pre-#4248) and on the final tree. Every splice
  is `ctx.standalone`-gated, and this is the evidence rather than the claim.
- `tests/equivalence` (214 files) exits 0 on the final tree.
- All 19 `tests/es5-standalone-*.test.ts` suites pass (227 tests), including
  `es5-standalone-ctor-identity` 13/13.

## Local-harness note

The `propertyHelper.js` files need the runtime-eval **refusal provider** built
(`node --import tsx scripts/build-runtime-eval-provider.mjs --refusal-only`).
Without it they fail on `Import #0 module="js2wasm:runtime-eval"` — a local
infra gap, not a compiler result. Every number above was measured WITH it
present on both sides.
