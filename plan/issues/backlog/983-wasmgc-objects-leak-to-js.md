---
id: 983
title: "WasmGC objects leak to JS host as opaque values (1,087 FAIL)"
status: ready
created: 2026-04-06
updated: 2026-04-28
priority: high
feasibility: hard
reasoning_effort: high
goal: async-model
test262_fail: 1087
note: "Verified 2026-05-21: _wrapForHost already exists at runtime.ts:1284 (issue's 'add' is now 'verify'); host-import line refs drifted significantly (1169→3495, 1159→3391, 1186→3551). FAIL count likely stale — re-baseline before dispatch."
---
# #983 -- WasmGC objects leak to JS host as opaque values (1,087 FAIL)

## Problem

The latest fully inspectable full test262 JSONL in the checkout
(`benchmarks/results/test262-results-20260403-024807.jsonl`) contains **1,087**
runtime failures with:

```text
WebAssembly objects are opaque
```

This is no longer the narrow `for-in` / `Object.create` subproblem documented in
old issue #853. The current failures span many JS abstract operations that
expect host-visible objects, property reads, or coercion hooks.

## Breakdown

| Category | Count |
|----------|-------|
| built-ins/Object | 510 |
| language/statements | 251 |
| language/expressions | 197 |
| built-ins/Array | 73 |
| built-ins/Promise | 18 |
| built-ins/Proxy | 9 |

## Sample files

- `test/language/expressions/addition/coerce-symbol-to-prim-err.js`
- `test/language/expressions/arrow-function/dstr/ary-ptrn-rest-id-iter-val-err.js`
- `test/language/expressions/async-generator/dstr/dflt-obj-ptrn-id-get-value-err.js`
- `test/language/expressions/class/dstr/async-private-gen-meth-static-obj-ptrn-rest-skip-non-enumerable.js`
- `test/built-ins/Object/create/15.2.3.5-4-308.js`

## Root cause

Compiled WasmGC structs are still crossing into JS-host operations in places
where JavaScript needs an inspectable object, not an opaque Wasm reference.

That shows up in several distinct spec operations:

1. **ToPrimitive / coercion paths**
   - e.g. `coerce-symbol-to-prim-err.js`
   - host-side coercion tries to inspect the object, but sees an opaque Wasm GC value
2. **Destructuring property access / Get**
   - object/array destructuring helper paths route values into host property access
   - nested rest / default-value cases still hand raw WasmGC objects to JS
3. **Property descriptor / enumeration / object built-ins**
   - `Object.create`, `Object.defineProperty`, and related helpers still have
     host-visible edge cases not fully externalized

The existing sidecar / `__extern_get` fixes solved specific subpaths but not the
general boundary rule: if JS host code must observe properties, coercion hooks,
or descriptors, the value must be externalized or mirrored through the sidecar
model first.

## Suggested fix

1. Define a single compiler/runtime rule for **host-observable objects**:
   - before a value crosses into JS operations that need property visibility,
     convert WasmGC structs to a JS-observable representation
2. Audit host-boundary call sites for:
   - ToPrimitive
   - object/array destructuring fallback helpers
   - property-descriptor built-ins
   - iterator/proxy/object helper imports
3. Reuse sidecar/property-model infrastructure instead of one-off `opaque`
   catches in each helper

## Relationship to existing issues

- #853 captured an earlier, much narrower enumeration/descriptors slice
- #856 covers one descriptor-validation subset after externalization
- #983 is the broader follow-up for **remaining opaque-object host escapes**

## Acceptance criteria

- >=500 of 1,087 opaque-object failures move to PASS or to more specific error categories
- host-visible property/coercion operations no longer receive raw opaque WasmGC values
- no regressions in already-fixed `Object.defineProperty` / sidecar paths

## Investigation Notes (dev-983, 2026-04-11)

**The 1,087 figure is stale.** The reference JSONL cited in "Problem" is from
`benchmarks/results/test262-results-20260403-024807.jsonl` (2026-04-03). The
current canonical results file `benchmarks/results/test262-current.jsonl`
(2026-04-11 run) contains only **12** occurrences of the literal substring
`WebAssembly objects are opaque`. The other ~1,075 failures previously
bucketed under this umbrella have either been fixed by intermediate work on
the sidecar / property model or have mutated into different error signatures:

| Current error signature | Count | Relationship |
|---|---|---|
| `WebAssembly objects are opaque` (literal) | 12 | Same root cause, remaining tail |
| `object is not a function` | 643 | Mis-categorized as `wasm_compile`; appears to be a compile-time TS diagnostic on the wrapped test source, unrelated to WasmGC→JS leak |
| `p.then is not a function` | 1,658 | Promise opaque — separate issue |
| `Cannot convert object to primitive value` | 148 | Host-side ToPrimitive on wasmGC struct — related but a different subproblem |
| `Object.defineProperty called on non-object` | 57 | Related to sidecar/defineProperty path |

### The remaining 12 "opaque" failures

All 12 are the same pattern: `Array.prototype.<method>.call(arrayLike, ...)`
where `arrayLike` is a user-defined object literal that the compiler
represents as a WasmGC struct, and `Object.assign(target, ...)` where `target`
is a WasmGC struct:

```
test/built-ins/Array/prototype/pop/clamps-to-integer-limit.js
test/built-ins/Array/prototype/pop/length-near-integer-limit.js
test/built-ins/Array/prototype/push/clamps-to-integer-limit.js
test/built-ins/Array/prototype/push/length-near-integer-limit.js
test/built-ins/Array/prototype/splice/clamps-length-to-integer-limit.js
test/built-ins/Array/prototype/splice/create-non-array.js
test/built-ins/Array/prototype/splice/length-and-deleteCount-exceeding-integer-limit.js
test/built-ins/Array/prototype/splice/length-exceeding-integer-limit-shrink-array.js
test/built-ins/Array/prototype/splice/length-near-integer-limit-grow-array.js
test/built-ins/Array/prototype/splice/set_length_no_args.js
test/built-ins/Array/prototype/unshift/clamps-to-integer-limit.js
test/built-ins/Object/assign/Override.js
```

### Root-cause point in the compiler

The leak is at `src/codegen/expressions/calls.ts:661-663` (verified
2026-05-21 — file/line still exist; line 663 is inside a regex literal
compile path so the actual prototype-method-call site needs re-grep before
editing) — the `Type.prototype.method.call(recv, ...)` lowering compiles
`recv` to an `externref` via `extern.convert_any` and passes the raw
WasmGC handle to the `__proto_method_call` host import in
`src/runtime.ts:3495` (was cited 1169-1176). Inside JS,
`Type.prototype.method.call(receiver, ...)` then tries to read/write
`.length` and numeric indices on an opaque wasm-gc value, which throws.

The symmetric leak is at `Object.assign` (`__object_assign`,
`src/runtime.ts:3551` — verified 2026-05-21, drifted from L1186) and
anywhere else a wasmGC struct crosses into a host import that performs
`Get`/`Set`/`ToPrimitive`.

### Why a naive "convert to plain object" fix is insufficient

Tests in the remaining 12 set rely on **mutation observability**: e.g.
`Array.prototype.pop.call(arrayLike); assert.sameValue(arrayLike.length, …)`.
A one-shot `_wasmToPlain` snapshot at the boundary would let `pop` run
successfully against a copy but the original WasmGC struct would not see the
`length` update, so the subsequent assertion would still fail (just with a
different error signature).

The correct fix is a **live mirror**: wrap the wasmGC struct in a JS `Proxy`
whose `get`/`set`/`has`/`deleteProperty`/`ownKeys` traps route through the
existing sidecar infrastructure (`_sidecarGet` / `_sidecarSet` in
`src/runtime.ts` — verified 2026-05-21, line refs need re-grep; original
L156-167 has drifted) and fall through to `_safeGet`/`_safeSet` for
named struct fields. Because the sidecar already stores dynamic property
writes for WasmGC structs, reads after a mutation observe the new value.

### Minimal implementation sketch

1. **(Verified 2026-05-21 — `_wrapForHost` already exists at
   `src/runtime.ts:1284`.)** Confirm it covers the necessary trap surface
   (get/set/has/deleteProperty/ownKeys/getOwnPropertyDescriptor) — if any
   trap is missing, add it.
2. Apply `_wrapForHost` to the receiver and spread args in (line numbers
   verified 2026-05-21):
   - `__proto_method_call` (src/runtime.ts:3495 — drifted from L1169)
   - `__extern_method_call` (src/runtime.ts:3391 — drifted from L1159)
   - `__object_assign` (src/runtime.ts:3551 — drifted from L1186)
   - Any other host import that performs JS `Get`/`Set` on a caller-supplied object (audit needed)
3. Expose compiled module `exports` to these closures via the existing
   `callbackState?.getExports()` hook already used by `_wasmToPlain`.

### Recommendation to team-lead

The issue is correctly diagnosed but the FAIL count is stale. I recommend
**either** rescoping #983 to cover only the 12 remaining opaque cases plus
the related 148 "Cannot convert object to primitive" cases (~160 FAIL
target), **or** splitting into:

- #983a: `_wrapForHost` live-mirror at `__proto_method_call` / `__extern_method_call` / `__object_assign` (targets remaining 12 + any Object.* leaks)
- #983b: ToPrimitive host-side for wasmGC structs (~148 FAIL)
- #983c: `object is not a function` compile-time diagnostics (~643 FAIL, unrelated to opaque leak)

Asking team-lead for guidance before implementing, since a full
`_wrapForHost` rewrite is several days of careful work and the payoff on
current numbers is <200 FAIL, not 500+.

## Implementation Plan

(Author: architect, 2026-05-21. Builds on the verified investigation
notes above. Scope: rescope to #983a — the 12 remaining literal
"opaque" failures plus the 57 `Object.defineProperty` opaque cases
plus any Object.* / Array.prototype.*.call leaks. ToPrimitive and
"object is not a function" are out of scope; file separate issues
when this lands.)

### Root cause (one line)

`__proto_method_call`, `__extern_method_call`, `__object_assign`,
`__object_defineProperty` and similar host imports already wrap their
direct argument(s) with `_wrapForHost`, but **not** every receiver
path; receivers reaching `Array.prototype.<m>.call` via the
`receiver === array-like wasmgc struct` branch can still bypass the
wrap, and Object built-ins (`Object.create`, `Object.getOwnProperty*`,
`Object.keys/values/entries`, `Object.freeze/seal/isFrozen/...`) do
not wrap their first argument at all. Audit + wrap.

### Entry points

1. **Audit pass** — list every `name === "__*"` branch under the
   `imports` callbacks in `src/runtime.ts` (3000-3700). For each
   import that performs any of `Get`, `Set`, `Has`, `OwnPropertyKeys`,
   `DefineOwnProperty`, `Delete`, `ToObject`, `IsExtensible`,
   `PreventExtensions`, `[[Prototype]]` access on a caller-supplied
   value, ensure `_isWasmStruct(arg) ? _wrapForHost(arg, exports) : arg`
   wraps it before the JS-level operation. Use the existing pattern
   from `__proto_method_call` (line ~3505) as the template.

2. **`_wrapForHost` trap surface** (src/runtime.ts:1284) — verify
   traps: `get`, `set`, `has`, `deleteProperty`, `ownKeys`,
   `getOwnPropertyDescriptor`, `defineProperty`, `getPrototypeOf`,
   `setPrototypeOf`, `isExtensible`, `preventExtensions`. Where
   missing, route through `_safeGet`/`_safeSet`/`_sidecarGet`/
   `_sidecarSet` (src/runtime.ts:386-1180) for sidecar parity, and
   reflect-onto-the-real-struct via `exports` for declared fields.

3. **Reverse mapping** — `_hostProxyReverse` (src/runtime.ts:1197) is
   already used by `_callableToPrimitive` (L431) and ToPrimitive
   (L637) to unwrap. Audit every host import that takes a value back
   from JS and writes it onto a wasmgc struct (e.g. callback return
   values, descriptor `value` field); unwrap via
   `_hostProxyReverse.get(x) ?? x` before writing.

### Data structure changes

None required at the wasm level — the wasmgc struct layout is
unchanged. Only the JS-side `_wrapForHost` Proxy handler and the
import callback wrappers change.

### Algorithm — for each host-import audit hit

1. Identify the parameter list of the import (e.g.
   `(name, target, key, descriptor)` for `__object_defineProperty`).
2. For each parameter that may be a wasmgc struct receiver:
   - If currently passed raw, wrap with
     `_isWasmStruct(x) ? _wrapForHost(x, exports) : x`.
   - For arrays of params (rest/spread), wrap each element.
3. For values flowing back from JS into the wasm side (return values,
   descriptor `value`/`get`/`set`):
   - Apply `_hostProxyReverse.get(v) ?? v` before re-entering wasm.
4. Add a regression test in `tests/equivalence.test.ts` that exercises
   `Array.prototype.<m>.call(arrayLike, ...)` and asserts mutation
   observability (the live-mirror property).

### Example: extending `__object_defineProperty`

Existing (sketch):

```ts
if (name === "__object_defineProperty")
  return (target: any, key: any, descriptor: any) => {
    Object.defineProperty(target, key, descriptor);
    return target;
  };
```

Required:

```ts
if (name === "__object_defineProperty")
  return (target: any, key: any, descriptor: any) => {
    const wrappedTarget = _isWasmStruct(target)
      ? _wrapForHost(target, exports)
      : target;
    // descriptor.value / .get / .set may carry wasmgc structs that
    // need unwrapping when later read back via Get
    const wrappedDescriptor = _wrapDescriptorForHost(descriptor, exports);
    Object.defineProperty(wrappedTarget, key, wrappedDescriptor);
    return target; // original raw struct, not the proxy
  };
```

Add helper `_wrapDescriptorForHost` near `_wrapForHost`.

### Edge cases

- **null / undefined receiver** — `_isWasmStruct(null)` is false, so
  passthrough; the host JS will throw `TypeError` natively (correct).
- **Symbol-keyed access through the proxy** — `_safeGet`/`_safeSet`
  already handle symbol keys via the sidecar (L1014-1180). Verify
  `get` trap forwards symbols (not stringified).
- **BigInt values in descriptors** — store directly via sidecar; do
  not coerce.
- **Numeric index access on a non-array struct** — the proxy `get`
  trap with a numeric key should fall through to sidecar
  (`arrayLike[3]` works because the test material writes index
  properties through the sidecar). The `length` field must be
  reflected from the underlying struct or sidecar; precedence: real
  field > sidecar > undefined.
- **Already-wrapped values entering twice** — `_wrapForHost` must be
  idempotent; check `_hostProxyReverse.has(x)` at entry and return
  `x` unchanged when already a proxy.
- **`Object.create(null)` style prototype-less objects** — the wrap
  must not assume `Object.prototype` traps; use a null-prototype
  handler.
- **Frozen / sealed semantics** — set/delete traps must respect any
  prior `Object.freeze` / `Object.seal` recorded in the sidecar
  metadata.

### Test262 paths to watch

- `test/built-ins/Array/prototype/{pop,push,splice,unshift}/clamps-*`
- `test/built-ins/Array/prototype/splice/length-*`
- `test/built-ins/Object/assign/Override.js`
- `test/built-ins/Object/defineProperty/15.2.3.6-*`
- `test/built-ins/Object/create/15.2.3.5-4-*`

Acceptance: literal `WebAssembly objects are opaque` failures → 0,
and the `Object.defineProperty called on non-object` bucket (57)
reduces by ≥40.

### Dependencies

- None blocking. Independent of #1552 (tagged unions) and #746
  (property tables) — wrap layer is purely JS-side.
- After landing, file follow-ups for ToPrimitive (#983b sketched
  above) and the "object is not a function" compile-time diagnostics
  (#983c).

### Risk

- `_wrapForHost` performance — every cross-boundary call now allocates
  a Proxy. Mitigate by caching: `WeakMap<wasmstruct, Proxy>` so
  repeated wraps return the same proxy (also gives `===` identity on
  the JS side).
- Proxy traps that throw can mask real test failures — keep traps
  thin; any non-trap exception should re-throw, never swallow.

