---
id: 7275
title: "IR module-init: builtin prototype objects / builtin functions as values (`Object.getOwnPropertyDescriptor(Date.prototype, \"x\")`, `<Ctor>.prototype.<m>.length`, `Object.create(<proto>)`)"
status: blocked
sprint: current
created: 2026-11-06
updated: 2026-11-06
priority: high
horizon: l
feasibility: hard
reasoning_effort: high
task_type: implementation
area: ir
goal: ir-full-coverage
related: [7267, 7253, 7273, 7118, 7127, 7189]
blocked_by: "each shape needs a new IR provider or a change to legacy's prototype-companion seeding (see Findings)"
assignee: "ttraenkler/c-lead"
---

# #7275: builtin objects and functions as IR values in `<module-init>`

## Problem

`ir_only_pass` (standalone test262 passes compiled with zero legacy units,
harness included) is the goal metric. #7267's census found that after
`JSON.parse`, the remaining `expr-ident-not-in-scope(Object|Reflect|Date|String|…)`
refusals in `<module-init>` need a builtin object or function as a value:
`Object.getOwnPropertyDescriptor(<B>.prototype, "k")`,
`<B>.prototype.<m>.length` / `.name`, `Object.create(<proto>)`, and the
harness's `Reflect.construct` / `verifyProperty` chains.

## Measurement (2026-11-06)

Base: #7267's branch (`issue-7267-ir-ambient-global-statics`, PR #7118) merged
with `origin/main` c0e553e4. Wrapped ledger, stride 40, standalone,
`JS2WASM_IR_SHAPE_DIAG=1`
(`npx tsx scripts/ir-claim-ledger.mts --wrapped --stride 40 --target standalone --jobs 3 --files-json …`):
1296 files, 14448 units, 4749 legacy, invariants 0, **33 zero-legacy files**.

119 files have one legacy unit whose first refusal is
`expr-ident-not-in-scope(<Name>)`. Grouped by the shape in the test body:

| shape | sole-blocker files (stride 40) | corpus files (`test262/test`) | lowering that legacy already has on standalone, host-free | what the IR would need |
| --- | ---: | ---: | --- | --- |
| `Object.getOwnPropertyDescriptor(<B>.prototype, <lit>)` | 6 (`Object/getOwnPropertyDescriptor/15.2.3.3-4-{43,80,118,159}`, `RegExp/prototype/{hasIndices,sticky}/this-val-*`) | 359 | **compile-time** synthesis from the `$NativeProto` glue (`call-builtin-static.ts` ~L3420–3500: `resolveBuiltinProtoGopdReceiver` → member CSV → `ensureStandaloneNativeMethodClosure` → `__create_descriptor` / `__create_accessor_descriptor`) | a new provider: one IR-callable entry over that synthesis |
| `Object.create(…)` | 10, **all** `Object.create({}, { <descriptor map> })` | 265 with a descriptor-map literal; 12 are `Object.create(<B>.prototype)` | `tryCompileObjectCreateStaticPrototype`, `compileProtoArg`, a finalize-filled class-instance slot, then a **compile-time** expansion of the descriptor map into `defineProperty` calls (`call-builtin-static.ts` ~L2674–2760) | a new provider, or a lowering of the descriptor map that the IR owns |
| `<B>.prototype.<m>.length` / `.name` | 4 (`Date/prototype/toISOString/15.9.5.43-0-2`, `String/prototype/{localeCompare/S15.5.4.9_A9,slice/S15.5.4.13_A11,toLowerCase/S15.5.4.16_A11}`) | 19 use the bare `assert.sameValue(<B>.prototype.<m>.length, n)` form; most other matches are comments, `delete …length` or string concatenation | a **syntactic** compile-time read of the closure singleton. It does not seed the prototype companion (`isProtoMemberValueUse`, `array-holes.ts`: "object-of-a-member-access ⇒ the syntactic path handles it") | the realm read through `dyn.member_get`, which is exact only once the companion is seeded (below) |
| `Object.getOwnPropertyNames(…)`, `Reflect.construct(…)`, `Object.prototype.toString.call(x)` | 0 at stride 40 | — | — | — |

Only 1 of the 4 `.length` files is the bare form. The other 3 also call
`.hasOwnProperty("length")` on the method value, `delete` its `length`, or
concatenate it into a message. So at stride 40, even a perfect `.length`
admission would make **at most one file** zero-legacy.

### Probes (standalone, IR on vs IR off, against node)

- **gOPD over a builtin prototype read as a value.** Legacy itself, with the
  receiver as a dynamic value (`var p = globalThis.Date.prototype;
  Object.getOwnPropertyDescriptor(p, "getTime")`), does not produce a descriptor: the
  first check (`d !== undefined`) already fails, and the script throws. node passes.
  The dynamic `__getOwnPropertyDescriptor` walks `$Object` only. The right
  answer exists only in the syntactic `<B>.prototype` arm. So routing the IR
  through the dynamic provider would give a wrong answer, not a slower one.
- **`<B>.prototype.<m>.length` / `.name` through the IR's realm read.** Measured
  with a scratch admission (allow one `.length`/`.name` read after #7127's
  `<B>.prototype.<m>`; any method; `Date` added as a receiver):
  - with the companion seeded (`Object.getPrototypeOf([])` elsewhere in the
    module): `Date.prototype.toISOString.length`, `String.prototype.at.length`,
    `Date.prototype.getTime.name`, `Array.prototype.includes.length` and
    `String.prototype.slice.length` all answer as node, and the unit takes the
    IR body;
  - **without the seed, every one of them throws** in the IR body, while legacy
    passes. The wrapped test262 file `Date/prototype/toISOString/15.9.5.43-0-2.js`
    fails with `TypeError: Cannot convert undefined or null to object`. That is
    the realm read answering `undefined`.

  The bare `.length` shape never seeds the companion. #7127 already gates its
  `.prototype.<m>` admission on `builtinProtoCompanionSeeded` for this reason,
  so the `.length` extension inherits the gate, and in the measured files the
  gate is closed.
- Legacy itself answers `String.prototype.padStart.length` wrongly (≠ 2) on
  standalone, so any `.length` table needs its own per-method measurement, as
  #7127 / #7189 did.

### Expected zero-legacy delta

0 at stride 40 for every shape that can ship without a new provider. That is
why this slice ships no code: the brief's stop rule ("if a shape needs a new IR
value kind or provider, stop at that shape") applies to all three shapes.

## Findings: what each shape needs

1. **`<B>.prototype.<m>.length|name`**: needs the prototype companion seeded
   whenever the IR claims the read. The two options both change legacy output,
   so each needs its own reviewed change:
   - arm `protoMemberDirty` in the `array-holes.ts` pre-pass for this shape.
     That changes the module on every lane, including lanes where the unit
     stays legacy, so it breaks "gc byte-identical where not claimed" unless
     it is gated on the claim;
   - or give the IR its own companion seed for the brands it reads.

   After that, a measured method table (`.length` and `.name` against node)
   and #7127's measured value positions, extended with call-argument position
   (`assert.sameValue(X, n)`). The admission belongs in
   `src/shared/ambient-intrinsics.ts` (`isExactProtoMethodValueRead`), not in
   `ir/ambient-global-function-call.ts`: it is a member read, not a call.
2. **`Object.getOwnPropertyDescriptor(<B>.prototype, <lit>)`**: needs a provider
   that exposes legacy's glue-driven descriptor synthesis as one call keyed by
   (brand, member), so that the IR and legacy share it. With that provider it
   becomes a row in `ir/ambient-global-function-call.ts` (receiver family
   "builtin prototype literal", key family "string literal").
3. **`Object.create({}, {…})`**: needs the descriptor-map expansion to become a
   callable helper, or an IR lowering of its own. #7189 measured legacy's
   `Object.create` as wrong in places, so the reference is node, not legacy.
4. **Harness `Reflect.construct` / `Function.prototype.call.bind`**: first-class
   builtin function values (fnctor ABI). This is unchanged from #7267's "Left"
   section.

## Implementation Plan (for the follow-up, once a provider exists)

- **Module.**
  - Shape 1: `src/shared/ambient-intrinsics.ts`, extending
    `isExactProtoMethodValueRead` with one optional `.length`/`.name` step and a
    measured `(receiver, method)` table. No new predicate.
  - Shape 2: one row in `src/ir/ambient-global-function-call.ts`.
- **Reuse.** #7127's seed gate, #7267's shared admission and its
  `isUnshadowedLibGlobal` binding test.
- **Code-quality criterion.**
  - The selector and from-ast read the same predicate.
  - No second seed flag.
  - No compile-time constant folding of `.length`: the test may `delete` or
    redefine it (S15.5.4.9_A9 does), so a folded constant is unsound.

## Result

No code in this slice: measurement only. Scratch probes are reproducible from
the shapes above. The experimental admission was reverted and is not
committed.
