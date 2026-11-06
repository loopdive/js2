---
id: 7273
title: "IR: `new <intrinsic>(…)` in module-init refuses (`expr-new-ctor-unknown` / `expr-new-extern-host-free`) — measured; every shape needs an IR adapter over the legacy provider"
status: blocked
sprint: current
created: 2026-11-06
updated: 2026-11-06
priority: high
horizon: m
feasibility: hard
reasoning_effort: high
task_type: investigation
area: ir
goal: ir-full-coverage
parent: 7106
related: [6981, 4461, 7011, 7268, 7271]
---

# IR: `new <intrinsic>(…)` refusals on standalone

## Problem

`phase1NewExpression` (`src/ir/select.ts`) refuses a `new` of an intrinsic
constructor on the standalone lane in two arms:

- **`expr-new-extern-host-free`** (`host-surface-unavailable`). The
  constructor is a known extern class without a host-free IR arm. The arms
  that exist are `HOST_FREE_EXTERN_CONSTRUCTORS`: `Map`, `RegExp`, `Date`.
  Under `hostExternCapability(…) === "defer"`, the #6981 comment says it
  plainly: there is no `<Class>_new` import to lower to, "and every member use
  on the result is capability-deferred at build".
- **`expr-new-ctor-unknown`** (`constructor-resolution-unsupported`). The name
  is neither a local class nor in `KNOWN_EXTERN_CLASSES`. This covers the
  wrapper constructors `String`/`Number`/`Boolean`/`Object`, plus `Proxy`,
  `DisposableStack`, and function constructors the fnctor admission did not
  take (`Palette`, harness `Test262Error`).

## Measurement (step 1)

**Setup.**

- Base: `origin/main` 9129f7e1.
- Census: wrapped stride-40 standalone, `JS2WASM_IR_SHAPE_DIAG=1`.
- Population: 1118 compiled test262 files.
- Module-init refusals report only the typed reason
  (`<module-init> rejected by IR selection (host-surface-unavailable)`). I
  recovered the arm and node with a temporary `capabilityNo` trace (`.tmp/`,
  reverted).

| Reason (first refusal) | Parts | Files where it is the only legacy unit |
| --- | --: | --: |
| `host-surface-unavailable` | 17 | **16** |
| `constructor-resolution-unsupported` | 26 | **23** |

The lead's 3 + 6 counted the arm names `expr-new-ctor-unknown` /
`expr-new-extern-host-free`. Those names appear in function units' details,
not in module-init rows, so they undercount.

### Sole-blocker files, by the first refused constructor

| Constructor (first arm) | Files | Legacy host-free provider on standalone | Then used through |
| --- | --: | --- | --- |
| `new ArrayBuffer(n[, { maxByteLength }])` | 12 (9 also `new DataView`) | yes: `tryCompileIndexedBuiltinNew` (`src/codegen/expressions/new-indexed.ts`), native i8 vec / `$__resizable_ab`, plus the DataView arm | `.byteLength`, `.maxByteLength`, `.slice`, `.transferToFixedLength`, `DataView#get*/set*` |
| `new SharedArrayBuffer(…)` | 2 | yes: the #7011 native provider (`new-indexed.ts`) | `DataView`, `.length` |
| `new Set([…])` | 1 | yes: legacy native Set (`expressions/extern.ts`, `new-super.ts`) | `.union` |
| `new Promise(function () {})` | 1 | legacy lowering (provider not traced here) | `.finally` via `.call` |
| `new String(s)` | 6 | yes: `tryCompileBuiltinGlobalNew` wrapper arm (`new-builtin-globals.ts`) | `.charCodeAt`, `.concat`, `.split`, `.substring`, `.hasOwnProperty` |
| `new Proxy(t, h)` | 6 | yes: the native proxy expansion (`new-builtin-globals.ts`) | traps, `Object.keys`, `Reflect`/`setPrototypeOf` |
| `new Object(…)` | 3 | yes (`new-builtin-globals.ts`) | identity / `!==`, `toString` |
| `new Number(n)` / `new Boolean(b)` | 2 / 2 | yes: wrapper arm | `JSON.stringify`, `Object.getPrototypeOf`, `RegExp#exec` |
| `new DisposableStack` / `new AsyncDisposableStack` | 1 / 1 | yes, legacy | `.use`, `.move` |
| `new Array(…)` (non-holey shape) | 1 | yes, legacy | `.reduce` |
| `new Palette()` (local function constructor) | 1 | fnctor path | `delete` |

Outside the sole-blocker files:

- 14 parts are `new Array()` in the Intl.ListFormat prelude
  (`__js2wasm_lf_localeList`, `__js2wasm_lf_strings`).
- 16 parts are `throw new Test262Error(…)` in propertyHelper's `verify*`.
- 3 parts are `CreateResizableArrayBuffer`'s
  `new ArrayBuffer(n, { maxByteLength })`.
- None of these is the only blocker in its file.

### Why no bounded admission exists

**A legacy provider is not an IR lowering.**

- The IR has no generic route to a legacy AST provider. Each host-free
  construction the IR admits has its own IR-callable adapter:
  - `ir-native-map.ts` (#4461): `__ir_map_new` / `__ir_map_get_num` /
    `__ir_map_set_num`, over the same helpers legacy calls;
  - an IR type for the result;
  - selector + from-ast arms for each member use, with a proof that the
    adapter surface equals the claim surface.
- `ArrayBuffer`, `DataView`, `SharedArrayBuffer`, `Set`, `Promise`, the
  wrapper constructors and `Proxy` have none of the three.

**The constructor alone wins nothing.** In every sole-blocker file the
constructed value is used through members, and #6981 defers each of those
uses at build. Admitting only the `new` would turn a selection refusal into a
claim-then-withdraw. The quality rule forbids that, and it moves no file to
zero-legacy.

**The wrapper constructors also need representation.** `String`, `Number`,
`Boolean` and `Object` need an object-identity carrier for wrapper objects
(`new Object() !== new Object()`, own `length`/index properties on
`new String`). The IR has no such carrier.

**Bounded zero-legacy yield: 0.** Per the dispatch's stop rule, no code
lands.

## Next pieces, by sole-blocker yield

1. **Native ArrayBuffer + DataView adapter family** (12 files, plus 2 more
   with `SharedArrayBuffer` on the same vec carrier):
   - one `ir-native-arraybuffer.ts` in the shape of `ir-native-map.ts`, over
     `new-indexed.ts`'s helpers;
   - an IR type for the native buffer;
   - selector proofs for `byteLength`/`maxByteLength`/`slice`/`resize`/
     `transferToFixedLength` and the `DataView` get/set family.

   This is the largest single win and should be its own issue with an
   adapter-ABI plan.
2. **`new String(s)` wrapper** (6 files). This needs a wrapper-object
   carrier first; the method surface follows.
3. **Proxy** (6 files). This needs the native proxy lowered from the IR;
   heavy.
4. **The rest are 1–3 files each**: `Object`, `Number`/`Boolean`, `Set`,
   `Promise`, `DisposableStack`, `Array`, `Palette`.

## Acceptance (for the follow-ups)

- **Correctness.** Each adapter family names its sole-blocker files and makes
  them zero-legacy on the stride, with no post-claim withdrawals. IR = legacy
  = node on those files and on adversarial probes (resizable bounds,
  detached buffers, out-of-range DataView offsets).
- **No duplicated implementation.** Adapters call the same helpers the legacy
  provider uses; there is no second implementation, and no new host imports.
- **Byte-identity.** gc and typed-corpus output are byte-identical.
- **One admission.** The selector and from-ast share one predicate per
  constructor, the same rule as `nativeMapStorageType`.
