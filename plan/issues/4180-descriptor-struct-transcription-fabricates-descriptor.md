---
id: 4180
title: "Standalone: the #2372 descriptor-struct transcription fabricates a descriptor from a typed struct's INTERNAL wasm fields"
status: done
assignee: ttraenkler/W5-descriptor-residue
sprint: 78
created: 2026-08-06
updated: 2026-08-18
completed: 2026-08-06
priority: high
horizon: m
feasibility: hard
reasoning_effort: max
task_type: bug
area: codegen
language_feature: property descriptors
goal: standalone-gap
related: [2372, 3246, 4008, 4010, 4047, 4055, 4161, 4172, 3251]
loc-budget-allow:
  # +10: the gate must be CONSULTED at the reify decision inside
  # `emitDefinePropertyDescRuntime` (one import + one predicate call), and the
  # decision itself is 7 lines of why-not-a-denylist that a reader hitting the
  # `if` needs. All 58 lines of logic + rationale went to the subsystem module
  # `property-descriptor-shape.ts`, which is the direction the gate encourages;
  # there is no way to consult it from the call site for zero lines.
  - src/codegen/object-ops.ts
---

# Standalone: the #2372 descriptor-struct transcription fabricates a descriptor from a typed struct's INTERNAL wasm fields

## Problem

Under `--target standalone`,
`emitDescriptorStructReify` (`src/codegen/object-ops.ts`, #2372) turns a typed
WasmGC descriptor struct into a fresh `$Object` by copying the struct's **wasm
fields** and handing that to `__obj_define_from_desc`. It fires for **any**
descriptor argument that compiled to a named struct with ≥ 1 field.

That is correct for the case it was written for — a descriptor object literal
(`var d = {value: 1}`) that the checker closed into a struct whose fields *are*
the descriptor's own properties. It is silently wrong for every other struct,
because it transcribes the **internal representation** and throws away the
object's real own properties.

Measured `--target standalone`, 2026-08-06:

```js
var arrObj = [];
arrObj.enumerable = true;          // lands in the #3537 vec bag
arrObj.value = 42;
Object.defineProperty(obj, "property", arrObj);
obj.property;                      // => undefined   (spec: 42)
```

The emitted `__module_init` literally does

```wat
call $__new_plain_object          ;; descObj
__extern_set(descObj, "length", arrObj.length)
__extern_set(descObj, "data",   arrObj.data)
call $__obj_define_from_desc
```

ToPropertyDescriptor finds no `value` / `enumerable`, and
CompletePropertyDescriptor fills in `undefined` + all-false. No refusal, no
diagnostic. Same for `new Date()` (`{timestamp}`), subviews
(`{length, data, byteOffset}`) and any other closed representation.

This is the *same* failure class `descriptor-shape.ts`'s header describes for
the **static expansion**, one layer down — and it survived that fix because
this path is the *dynamic* one the static path is supposed to delegate to.

## Why this refutes the lever's framing

The lever this came from (`W5-descriptor-family`, 558 files) was framed as
descriptor-*reader* gaps: ToPropertyDescriptor not seeing the carrier bag,
§8.12.9-step-1 redefine, missing TypeError arms. The reader is **fine**. The
same array whose descriptor read as empty reports its expando correctly through
`Object.getOwnPropertyNames`, `Object.keys` **and**
`Object.getOwnPropertyDescriptor`:

```
read=101  gopn=zz  keys=zz  gopd=101/true      own=false  in=false  forin=(empty)
```

So the bag is populated and three of the four reflective surfaces already see
it. The descriptor path never asked them — it had substituted its own answer at
**compile time**. A carrier-bag arm in `__desc_has_own` (the obvious fix from
the reader framing) would have measured **+0** for exactly this reason.

The discriminating probe is cheap and worth reusing: make the same value reach
the call site as an **externref** instead of a typed struct
(`var c = esc([]); c.value = 3; Object.defineProperty(o, "p", c)`) — it works.
If a value behaves differently depending only on its static representation, the
defect is in the static lane, not the runtime.

### Carrier matrix, straight-line module-global shape (the real test262 spelling)

| carrier | store+read | `hasOwn` | `in` | `defineProperty` before | after |
| --- | :-: | :-: | :-: | :-: | :-: |
| plain object | ✓ | ✓ | ✓ | ✓ | ✓ |
| function | ✓ | ✓ | ✓ | ✓ | ✓ |
| RegExp / wrappers / Arguments | ✓ | ✓ | ✓ | ✓ | ✓ |
| **Array** | ✓ | ✗ | ✗ | **✗** | **✓** |
| **Date** | ✓ | ✗ | ✗ | **✗** | **✓** |
| Error | ✗ | ✗ | ✗ | ✗ | ✗ (no expando storage — #4098) |
| Math / JSON | ✗ (compile refusal) | — | — | ✗ | ✗ (#1907 / #1888 S6-b) |

`hasOwnProperty` / `in` / `for-in` staying blind on a *statically typed* array is
a **separate** defect (the static lane never reaches `__hasOwnProperty` /
`__extern_has`, which do consult the bag — probe 5 case C). Deliberately not
fixed here; see "Left undone".

## Fix

`isDescriptorTranscribableStruct` (`src/codegen/property-descriptor-shape.ts`)
gates the transcription:

- object-literal structs (`__anon_*`) always transcribe — their fields are their
  own properties by construction, including `{foo: 1}`, which must yield an
  empty-but-valid descriptor rather than a TypeError;
- any other struct transcribes only if it carries at least one of the six
  §6.2.5.6 field names (a fnctor instance with `this.value = …` is a real
  carrier, unchanged);
- everything else passes through as an externref, so the runtime applier runs
  ToPropertyDescriptor over the actual object.

A **plausible-descriptor** test rather than a builtin-representation denylist:
a denylist must track every struct the compiler mints and fails *open* when it
falls behind — the wrong direction for a helper whose failure mode is a silent
wrong answer.

Pass-through is safe on both gates it must clear: `__obj_define_from_desc`'s
Type check has been `typeof === "object" || "function"` since #3246 (not a
`ref.test $Object`), and `__typeof_object` answers 1 for any non-null
non-primitive. It is also strictly safer on a **null** struct ref: the
transcription read each field under `ref.as_non_null` and would trap, whereas
the applier treats a null descriptor as a lenient empty-descriptor no-op.

## Measured

Instrument: L2's CI-aligned scoped runner with the `js2wasm:runtime-eval`
provider shim (#4162 — `tests/test262-runner.ts` does not supply the namespace
that `scripts/test262-worker.mjs` does, and without the shim every
`propertyHelper.js` test dies at instantiate). 558-file lever list
`.tmp/levers/W5-descriptor-family.txt`, `--target standalone`.

| | pass |
| --- | ---: |
| base | **92 / 558** |
| this branch | **104 / 558** |

**+12, 0 regressions on the list.** All twelve are
`built-ins/Object/defineProperty/15.2.3.6-3-{34,39,87,92,140,145,166,171,219,224,249,254}.js`
— the Array and Date `'Attributes'` carriers.

Instrument responsiveness verified in **both** directions: with
`object-ops.ts` + `property-descriptor-shape.ts` swapped back to their
`origin/main` copies (file-copy A/B, never `git stash`) those twelve score
**0 / 12**; restored, **12 / 12**.

Sizing honesty: the lever list was cut as 558 *failures*, but 92 of them
already pass on current main — six PRs landed between the cut and this
measurement. The real residue is 466, and this closes 12 of it. The larger
value of this slice is the refutation above, which re-aims the rest.

## Left undone (deliberate)

- **`hasOwnProperty` / `in` / `for-in` on a statically typed array** still
  bypass the runtime helpers that already consult the bag. Real, separate, and
  adjacent to #4159; not folded in because it is a *static lane* routing
  question with a different blast radius.
- **Error as a descriptor carrier** (~27 lever files) — `new Error(); e.zz = 1`
  does not store at all. #4008's note explains why `$Error_struct` was left out
  of the #3468 bag (it owns a `$props` side-slot); #4098 territory.
- **Math / JSON as a descriptor carrier** (~46 lever files) — an expando write
  to a builtin namespace is a *compile-time refusal*
  (`Math.zz … is not supported in --target standalone (#1907 / #1888 S6-b)`),
  so it needs a namespace-object substrate, not a descriptor fix.
- **The `-1` "of prototype object" variants** (44 lever files, measured:
  Object 12, and 4 each for Function / RegExp / Array / Number / Boolean /
  Date / Error / String). `RegExp.prototype.value = "RegExp"; new RegExp()` and
  `Object.prototype.zz = 1; ({}).zz` both read `undefined`. The nearest
  substrate is #4160's `proto-index-store.ts`, whose companions are gated to
  **canonical non-negative integer keys** and to only two prototypes
  (`%Object.prototype%`, `%Array.prototype%`). Widening it to named keys is not
  a one-line gate removal: `protoIndexDirty` (array-holes.ts) is a PRE-SCAN
  flag whose whole purpose is to keep the substrate — and its read-fallback
  splices in `__extern_get`/`__extern_has`/the vec and closed-struct arms —
  **out of clean modules**. Widening the pre-scan turns it on for far more
  modules, which is precisely the unscoped-widening shape that cost #2660 S2 a
  measured −40 on the standalone floor. Worth doing, worth measuring
  separately, not worth folding into this PR.
- **The 13 `[SITE-PROPS-BAG-NOT-AUTHORITATIVE]` refusals** in the plural
  `Object.defineProperties` / `Object.create` path. The obvious move — give
  `closurePropertiesBagArm` a vec arm — is the arm **#4047 measured at +6 and
  reverted**: resolving a `Properties` MAP through a bag needs a COMPLETE
  own-key source and a bag is not one. 13 files does not justify re-litigating
  that.
