---
id: 4248
title: "Standalone: `Number`/`Boolean`/`String`.prototype are not wrapper objects — own members invisible, no [[PrimitiveValue]], default-receiver methods answer null"
status: in-progress
sprint: current
created: 2026-08-08
updated: 2026-08-08
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
---

# #4248 — builtin prototypes are wrapper objects, and standalone treats them as bare metadata

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

## Files

- `src/codegen/native-proto-own-props.ts` — the native + finalize splice
- `src/codegen/index.ts` — the two finalize call sites
- `tests/es5-standalone-wrapper-prototype.test.ts`

## Local-harness note

The `propertyHelper.js` files need the runtime-eval **refusal provider** built
(`node --import tsx scripts/build-runtime-eval-provider.mjs --refusal-only`).
Without it they fail on `Import #0 module="js2wasm:runtime-eval"` — a local
infra gap, not a compiler result. Every number above was measured WITH it
present on both sides.
