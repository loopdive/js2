---
id: 6464
title: "standalone: an `Object.create(C.prototype)` instance handed across the module link answers `null` for every accessor and method read — the Temporal polyfill builds every `X.from(…)` result this way, so all five `from` constructors return objects whose `.day`/`.equals`/`String()` are `null`"
status: in-progress
assignee: ttraenkler/dev-5383-s13
sprint: current
priority: high
horizon: m
parent: 5383
goal: standalone
reasoning_effort: high
requested_by: ttraenkler/fable-lead
created: 2026-09-13
loc-budget-allow:
  # 2026-09-13 (S13) — the standalone `Object.create(<value>.prototype)`
  # dispatcher. The mechanism itself is the NEW module
  # `src/codegen/standalone-object-create-class-instance.ts`; what lands in
  # these two god-files is only the wiring, and neither line can move:
  #   expressions/call-builtin-static.ts  +15  the reserve + the branch, inside
  #     the ONE `Object.create` arm, immediately after
  #     `tryCompileObjectCreateStaticPrototype` declines. It has to sit exactly
  #     there because the decision this slice makes IS "the syntactic fast path
  #     missed" — recorded anywhere else, the two spellings of the same call
  #     drift apart silently, which is how the dynamic one went unserved for a
  #     whole lane. Most of the growth is the note that the reserve happens here
  #     while the BODY is filled at finalize, which is the non-obvious half.
  #   index.ts  +6  the fill at BOTH finalize sites (`generateModule` and
  #     `generateMultiModule`), positioned next to `fillClassPrototypeReadArm`
  #     because the body reads `ctx.protoGlobals` and nothing earlier has it
  #     complete. A minted-but-never-pushed handle throws at resolution, so
  #     missing either site is a hard failure, not a silent miss — the comment
  #     saying so is what stops a reader from "simplifying" it to one call.
  - src/codegen/expressions/call-builtin-static.ts
  - src/codegen/index.ts
  # STRANDED GRANTS restated (#3102). `new-super.ts` (+19) and
  # `fnctor-constructor-identity.ts` (+12) are grown by PR #5909 (S12), which
  # this branch is stacked on; against `origin/main`'s baseline CI sees that
  # growth in this PR's merge preview. Restated here so the allowance travels
  # with the diff that carries it.
  - src/codegen/expressions/new-super.ts
  - src/codegen/fnctor-constructor-identity.ts
---

# standalone: `Object.create(proto)` instances do not survive the module link

## Problem

On `--target standalone` with the compiled `@js-temporal/polyfill` linked in as a
provider module (#5383), every `Temporal.X.from(…)` hands back an object whose
accessor and method reads answer `null`:

```js
Temporal.PlainDate.from("1976-11-18").day        // null   (expected 18)
String(Temporal.PlainDate.from("1976-11-18"))    // null
Temporal.ZonedDateTime.from(…).equals            // undefined
```

while the control built with `new` answers correctly:

```js
new Temporal.PlainDate(1976, 11, 18).day         // 18
```

The polyfill does not use `new` for `from`: it builds results with
`Object.create(intrinsic.prototype)` plus WeakMap slot writes (bundle symbol
`pn`, ~L1946 of `linkPolyfillSource(setupTemporalPolyfill()).source`).

S12 measured the same shape **inside one module** and it answers correctly, so
this is a cross-module (link-boundary) defect, not a module-local one.

S12 attributed ~40 of the 360 rows in the three-family sample to this residual.

## Census (2026-09-13) — the hand-off attribution was wrong for the FIFTH slice running

The brief called this "boundary identity": a provider-created
`Object.create(proto)` object read through the link. **It is not a link defect at
all.** It reproduces in ONE standalone module with no provider, no package edge
and no linker, and it is not about `Object.create` in general either — it is
about the *spelling* of the prototype argument.

### Harness note that changes what a census MEANS here

The first two probe sets put every probe in one module and disagreed with each
other over the SAME provider (`NS.num()` answered `18` in one set and `null` in
another). Module CONTENT decides the answer — the #6432 action-at-a-distance
hazard — so a shared-module census is unattributable. Every number below comes
from `.tmp/s13/pair2.mjs`, which builds the provider once and compiles **one
probe per consumer module**. The earlier one-module-per-set harness
(`.tmp/s13/pair.mjs`) is kept only as the record of why.

### Attribution table

`--target standalone`. "single" = one module, `compileMulti`, no link. "linked" =
provider compiled as an npm package + standalone consumer (the #6432 seam).

| probe (reduction) | single | linked | root cause | terminal |
| --- | --- | --- | --- | --- |
| `Object.create(K.prototype).day`, `K` a VALUE | **−1** | **null** | `emitObjectCreateClassInstanceExport` is `return`-gated on `ctx.standalone` — the #5239 mechanism has **no standalone twin** | `__object_create` (native) |
| `Object.create(K.prototype).self() === o` | **false** | — | same | same |
| `typeof Object.create(K.prototype).calendarId` | **number(−1)** | **"object"** | same | same |
| `Object.create(C.prototype).day`, `C` a class IDENTIFIER | 18 | 18 | — (already lowered to `struct.new $C`) | — |
| `new C().day` | 18 | 18 | — | — |
| `String(instance)` | `D18` | `[object Object]` | link `toStringTag`/ToPrimitive | `__js2wasm_link_to_string_tag` |
| `instance instanceof C` | true | **false** | link prototype identity | `__js2wasm_link_member_get` (`prototype`) |
| `getPrototypeOf(new C()) === C.prototype` | true | **false** | same | same |
| `"prototype" in C` | true | **false** | same | same |
| `getOwnPropertyNames(C.prototype)` | TRAP | TRAP | pre-existing, both lanes | `__getOwnPropertyNames` |

The first four rows are the slice. The link-only rows are real and are written
down below as the residual, but they are a *smaller* attributed row count and
they are downstream of nothing this slice touches.

### The same measurement against the REAL linked Temporal provider

`.tmp/s13/t1.out`, provider `js2wasm:npm:@js-temporal/polyfill:2c0506a30fe8f23d`,
`cacheHit=true`:

| probe | answer |
| --- | --- |
| `PlainDate.from("1976-11-18").day` | `null` |
| `PlainDate.from("1976-11-18").calendarId` | `null` |
| `typeof PlainDate.from(…).calendarId` | **`"object"`** |
| `new Temporal.PlainDate(1976,11,18).day` | `18` |
| `new Temporal.PlainDate(1976,11,18).calendarId` | `"iso8601"` (`typeof` `"string"`) |
| `PlainTime.from("12:30").hour` | `null` |
| `Instant.from(…).epochNanoseconds` | `null` |
| `Duration.from({years:1}).years` | `1` (Duration does not use this path) |

`typeof … .calendarId` answering **`"object"`** is the signature that closes the
attribution: the reduction answers `"object"` across the link and a number
locally, for the same reason, and nothing else in the census produces it.
`calendar must be string in canonicalizeCalendarEra` — the 20-row PlainDate
bucket — is `assert.sameValue(typeof calendarId, "string", …)` in
`test262/harness/temporalHelpers.js:137`, i.e. exactly this.

And the polyfill really does emit that spelling, seven times:

```js
function pn(e,t){ const n = ce("%Temporal.PlainDate%");
                  const r = Object.create(n.prototype); return yn(r,e,t), r; }
```

(`Object.create(<var>.prototype)` ×7 — PlainDate, PlainDateTime, PlainMonthDay,
PlainTime, PlainYearMonth, Instant, ZonedDateTime; `Object.create(null)` ×14,
untouched by this slice. No `Object.create(<ClassIdentifier>.prototype)` at all.)

### Why the receiver is wrong, concretely

`Object.create(K.prototype)` with a dynamic `K` falls through to the native
`__object_create`, which returns a plain `$Object` whose `[[Prototype]]` link
points at the class's prototype `$Object`. A later `o.day` finds the accessor on
that prototype, but a compiled accessor takes its receiver as a concrete
`(ref $C)`, which a plain `$Object` can never satisfy — so `selectBridgeReceiver`
binds the PROTOTYPE as `this`. Measured directly (`.tmp/s13/c7.out`):

| | `o.self() === o` | `o.day` |
| --- | --- | --- |
| `Object.create(K.prototype)` (dynamic) | **false** | −1 |
| `Object.create(C.prototype)` (static) | true | 18 |
| `new C()` | true | 18 |

A polyfill that keeps its state in a WeakMap keyed by the object it created
(`re(this, SLOT)`) therefore misses every slot. That is the whole of the
symptom, and it is the failure mode `object-create-class-instance.ts`'s own
header predicted — for the lane it does not run in.

## Implementation Plan

Give `--target standalone` the twin of #5239's host mechanism, as a NATIVE
dispatcher rather than a host-called export.

1. **New module** `src/codegen/standalone-object-create-class-instance.ts`
   (classified in `scripts/compiler-boundaries.json`).
   - `STANDALONE_OBJECT_CREATE_CLASS_INSTANCE = "__standalone_object_create_class_instance"`,
     signature `(externref) -> externref`.
   - `reserveStandaloneObjectCreateClassInstance(ctx)` — **resolve-or-reserve**:
     returns the handle from `ctx.funcMap` if present, else `mintDefinedFunc`
     (a STABLE handle, immune to late-import shifts) and records it under the
     name. Call sites need the index while bodies are still compiling; the body
     needs `ctx.protoGlobals`, which is only complete at finalize.
   - `fillStandaloneObjectCreateClassInstance(ctx)` — at finalize, push the body
     for the reserved handle. A minted-but-never-pushed handle throws at
     resolution, so the fill pushes **unconditionally** once reserved; with no
     admissible class it pushes the refusal body `ref.null.extern`, which is
     byte-for-byte the pre-slice behaviour at every call site.
   - Body: one `ref.test eq` guard on the argument, then per class an identity
     compare `ref.eq` against `global.get __proto_<C>`, and on a hit
     `struct.new $C` with defaulted fields and `__tag` set exactly as a
     `new`-built instance has it, `extern.convert_any`, `return`.
   - **Identity, not `ref.test`.** `Object.create(someInstance)` must keep
     meaning "a plain object inheriting from that instance", and under WasmGC a
     class object, its instances and its prototype are not separable by
     `ref.test` (structural canonicalisation, #5195 F1). The `eq`-based compare
     also avoids #5239's `ref.test $C` on the prototype, which is sound on the
     host lane (the prototype IS a `$C` struct there) and is **not** sound under
     standalone, where #3976 builds the prototype as an `$Object`.
   - **A lazy prototype global reads as "no match", and that is correct.**
     `__proto_<C>` is null until something materialises it; nothing can be
     holding that prototype as a value before then, so a null global cannot
     produce a false negative. The S11 dynamic-`prototype` arm
     (`standalone-class-prototype-read.ts`) force-builds through
     `__class_proto_build_<C>` before it answers, so by the time
     `Object.create(K.prototype)` runs the global holds the singleton the
     argument IS.

2. **Call site**, `src/codegen/expressions/call-builtin-static.ts`, inside the
   one `Object.create` branch, after `tryCompileObjectCreateStaticPrototype`
   declines and only when `ctx.standalone && ctx.classSet.size > 0` and the
   argument is not the `null` keyword: compile the proto once into a local, try
   the dispatcher, and fall back to `__object_create` on a null answer. The
   descriptor-expansion code that follows is untouched — it reads the created
   object off the stack exactly as before.

3. **Finalize**, `src/codegen/index.ts`: call the fill next to
   `fillClassPrototypeReadArm` in both `generateModule` and
   `generateMultiModule` (the two finalize sites), i.e. after `ctx.protoGlobals`
   is complete.

### Order preservation

- `gc` lane: every entry point returns before emitting under
  `!ctx.standalone`, so the lane is byte-identical by construction.
- standalone modules with no class (`ctx.classSet.size === 0`) or no dynamic
  `Object.create`: nothing is reserved, nothing is filled, no call site changes.
- standalone modules that DO have both: the call site gains a null-test branch
  and the module gains one function. That is the intended change and is listed
  in the byte A/B.

### Acceptance criteria

1. `Object.create(K.prototype).day` answers the instance's own slot under
   `--target standalone`, single-module and linked, with `K` a value.
2. `o.self() === o` for the dynamic shape.
3. The three linked Temporal families do not regress; 0 `pass→fail`.
4. `built-ins/Object/create/**` and `built-ins/Object/**` do not move.
5. Every `gc` artifact in the byte A/B corpus is sha256-identical.

### Residual, measured and deliberately not started

Link-boundary **prototype identity** — `instance instanceof C`,
`getPrototypeOf(instance) === C.prototype` and `"prototype" in C` all answer
`false` across the link while answering `true` in one module, for `new`-built
and `Object.create`-built instances alike (so it is not an `Object.create`
question). Reduction: `.tmp/s13/c1.mjs`, probes `oc instanceof C`,
`protoOf(new)===C.proto`, `'prototype' in C`. Related and upstream of the
ZonedDateTime `reading 'equals'` bucket:
`Object.getOwnPropertyNames(C.prototype)` **traps** (`illegal cast`) in BOTH
lanes — a separate, pre-existing defect the census pinned but did not attribute.
