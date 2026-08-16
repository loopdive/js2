---
id: 1888
title: "standalone open-any method dispatch + built-ins-as-static-globals (prototype vtable)"
status: ready
pr: 1273
created: 2026-06-05
updated: 2026-06-11
priority: high
feasibility: hard
reasoning_effort: high
model: fable
task_type: feat
area: codegen, runtime
language_feature: objects, prototype chain, method dispatch, built-ins
goal: host-independence
sprint: current
related: [1472, 2177, 1629, 1104, 1539, 1103]
parent: 1472
claimed_by: codex-developer
claimed_at: 2026-06-07T10:22:55.064Z
completed: 2026-06-11
loc-budget-allow:
  - src/codegen/array-prototype-borrow.ts
---
# #1888 — Standalone open-any method dispatch + built-ins-as-static-globals

> **2026-08-16 dispatch note**: the `claimed_by: codex-developer` /
> `completed:` frontmatter above is stale debris — the authoritative claim
> ledger (`upstream/issue-assignments`) shows NO live claim, and `status:
> ready` stands. Fresh standalone ES5 census (575 nonpasses,
> `plan/log/analysis-2026-08-16-es5-standalone-575.md`): this issue owns the
> `'X.prototype.Y' is not yet callable as a value in --target standalone` and
> `'__get_builtin' (dynamic-shape…) Phase B` classes, which dominate the
> **function-prototype (57)** and part of the **array-prototype (60)**
> clusters — the second-largest lever in the ES5 standalone gap.

> Architectural sub-issue of **#1472 Phase C**. This is the spec for the
> single layer that unblocks the largest remaining standalone gap. sd-1472c
> implements it as the independent slices below. The runtime types/helpers
> live in `src/codegen/object-runtime.ts`; routing lives in
> `src/codegen/expressions/late-imports.ts`. The conservative dual-mode
> invariant from #1472 holds throughout: **GC/host path unchanged and
> default; standalone is the new native path; any uncertainty ⇒ fail loud
> (`Codegen error:` queued via `reportError*`), never invalid Wasm.**

## Problem (the addressable block)

#1472 Phase B gave standalone a Wasm-native open-`$Object` hash-map for
*property* get/set/delete/enumerate/define-data-descriptor. What it does
**not** have is the *dispatch* layer:

| Refused helper (`STANDALONE_REFUSED_IMPORT`) | Raw rows (2026-06-02 JSONL) | What it does |
| --- | ---: | --- |
| `__get_builtin` | 6,565 | `globalThis[name]` — resolve `Object`/`Array`/`Math`/… as a value |
| `__extern_method_call` | 7,465 | `obj.m(...)` generic dispatch on an `any`/externref receiver |
| `__proto_method_call` | 659 | `Type.prototype.m.call(recv, …)` borrowed-method dispatch |
| `__defineProperty_accessor` | 2,713 | accessor (get/set) descriptors — deferred by S6 (no funcref slots) |
| `__hasOwnProperty` (bare-method form) | 1,416 | `o.hasOwnProperty(k)` reaches dispatch, not the property path |

These converge on **one** missing capability: *invoke a method named by a
string on an open value, resolving the method through the prototype chain,
where the prototype graph for built-ins is shipped as Wasm data, not JS.*
That is ~9k of the ~18.8k standalone #1472 gap (the largest single block
toward the 27.8%→57% target).

The two halves of the capability:

1. **Method resolution** — given `(receiver, "methodName")`, find the
   function value: own property → walk `$Object.$proto` chain (ES §10.1.8.1
   OrdinaryGetPrototypeOf, §10.1.5 [[Get]]). For built-in receivers
   (`[].map`, `Math.max`, `"s".slice`), the prototype is a built-in object
   graph that today only exists in JS (`globalThis`).
2. **Method invocation** — `Call(method, receiver, args)` (§7.3.14). The
   method value is either a user closure (`$Closure`-family wrapper, invoked
   via `call_ref` — already have `__call_fn_N`) or a built-in (compiled
   native helper, e.g. `__str_slice`, `__array_map`).

## Spec references (ECMA-262)

- §10.1 Ordinary Object Internal Methods — [[Get]]/[[Set]]/[[GetPrototypeOf]]
  /[[SetPrototypeOf]]/[[GetOwnProperty]]/[[DefineOwnProperty]].
- §10.1.8.1 OrdinaryGetPrototypeOf, §10.1.2.1 OrdinarySetPrototypeOf
  (the extensibility + cycle checks `setPrototypeOf` must honour).
- §10.1.5.1 OrdinaryGetOwnProperty (accessor vs data descriptor shape).
- §10.1.6.3 ValidateAndApplyPropertyDescriptor (accessor define rules).
- §7.3.14 Call, §6.2.5 Reference Record (the `GetValue` of an accessor get).
- §13.3.5 / §13.3.6 — member-call evaluation order: receiver evaluated
  once, bound as the `this` of the call.

## Architectural decisions

### D1 — Representation: built-ins as a compile-time-resolved static
###      prototype graph, NOT a runtime `globalThis` object.

We do **not** ship a runtime `globalThis` hash-map keyed by `"Array"`,
`"Math"`, … and walk it at runtime. That would require materialising every
built-in object as an `$Object` with every method boxed as a closure — huge
binary bloat and a second method-resolution mechanism. Per
`feedback_compile_away` (resolve JS semantics statically, zero runtime
overhead), the receiver's built-in *kind* is **already known at compile
time** in the overwhelming majority of call sites, because the existing
fast-path dispatchers in `calls.ts` (`tryExternClassMethodOnAny`, the array
/ string / Map / Set method handlers) classify the receiver before falling
through to `__extern_method_call`. The native dispatch layer is a **fallback
for the residual `any` receiver only**, and it splits into two cases:

  - **(a) Statically-classifiable receiver** (`[].map(...)`,
    `"s".slice(...)`, `Math.max(...)`, `Array.isArray(x)`): the existing
    static fast paths already emit the native helper directly with **no host
    import** — these mostly work standalone *today* and are out of scope
    except where a fast path is gated on `!ctx.standalone` or falls through
    incorrectly (audit task, Slice 0).

  - **(b) Genuinely-open receiver** (`const o: any = {...}; o.m(args)` where
    `m` is a user method stored as a function-valued property, or
    `obj[k](args)`): resolve `m` through the `$Object` chain at runtime and
    invoke it via `call_ref`. **This is the new native path.** Built-in
    *instance* methods on a genuinely-open receiver (e.g. an `any` that turns
    out to hold a `$Vec`/`$NativeString` at runtime) route through the
    **runtime brand-dispatch** in D3.

  - **(c) Named built-in constructor/namespace as a value**
    (`__get_builtin("Array")` to read `Array.isArray`, pass `Object` to a
    function, `const C = Array`): these need the constructor/namespace to
    *exist as a value*. Decision: emit a **lazily-constructed singleton
    `$Object`** per named built-in, populated with only the
    statically-referenced own properties (the methods/props actually read in
    the program), each method stored as the corresponding native helper
    wrapped in a `$Closure`. This is the "built-ins as static globals"
    piece — see D4. It is far smaller than a full `globalThis` because it is
    **demand-driven by the program's actual references**.

> **Why this is the right cut:** the 7,465 `__extern_method_call` rows are
> dominated by case (b) (open user objects) and case (a) leakage (a fast
> path that bails to the host shim under standalone). Case (c) (`Array` as a
> first-class value) is the long tail. Slicing (b) first banks the bulk;
> (c) is a later, self-contained slice.

### D2 — `$Object` already carries the dynamic shape. No new container type.

The Phase-B `$Object { proto, props, count, tombstones, flags }` +
`$PropMap`/`$PropEntry` already *is* the open-any dynamic-shape carrier.
Method dispatch on an open object is just **`__extern_get(o, "m")` then
`Call`**. So case (b) needs **no new representation** — it reuses
`__extern_get` (which already walks the proto chain, Phase B Slice 1) to
fetch the method value, then invokes it. The only genuinely new types are
for the accessor-descriptor extension (D5) and the built-in singleton
registry (D4).

### D3 — Invocation mechanism: `call_ref` for user closures; brand-switch
###      to native helpers for built-in instance methods. NO call_indirect
###      table.

We deliberately avoid a `call_indirect` dispatch table keyed by a runtime
method-id. Reasons:

  - The method value fetched from `$Object.props` is an `anyref`. If it
    holds a user function it is a `$Closure`-family wrapper struct — the
    existing `__call_fn_N(externref recv-or-args…) -> externref` exports
    (`emitClosureCallExport`/`…1`/`…2`/…, index.ts:2316+) already do
    `ref.test`→`ref.cast`→`struct.get $func`→`call_ref` for arities 0–4.
    **Reuse them.** A function-valued property invocation is:
    `box receiver+args → call __call_fn_N`.
  - If the fetched value is **not** a callable (`ref.is_null` or
    `ref.test $Closure*` fails), throw TypeError "`m` is not a function"
    (§7.3.14 step 2 / the host shim's `Cannot read properties of null`).
  - Built-in *instance* methods on a genuinely-open receiver are reached via
    a **runtime brand switch** helper `__extern_method_call` (native impl,
    D6): `ref.test $Vec` → array-method dispatch; `ref.test $NativeString`
    (after `any.convert_extern`) → string-method dispatch; `ref.test
    $Object` → own/proto user-method lookup → `call_ref`; else TypeError.
    Each brand arm calls the **already-existing native helper** for that
    method name (e.g. `__array_includes`, `__str_indexOf`), selected by a
    compile-time `methodName`→helper map. A `call_indirect` table buys
    nothing here because the method name is a *compile-time string constant*
    at every call site — the arm selection is static.

### D4 — Built-in singleton registry (case (c)): demand-driven lazy globals.

`__get_builtin("Array")` and friends, when the result is used as a *value*
(not immediately `.m()`-called — that's case (a)/(b)), lower to a
per-name **lazily-initialised global** holding a `$Object` singleton:

  - One nullable global `$__builtin_<Name>` per referenced built-in.
  - First read runs an init: `struct.new $Object`, then for each own
    property the program statically references on that built-in, insert a
    `$PropEntry` whose value is the native helper wrapped in a `$Closure`
    (static-method props like `Array.isArray`, `Object.keys`) or a nested
    built-in singleton (`Array.prototype`).
  - The set of own properties to materialise is computed at compile time by
    the existing reference scan (mirror `sourceHasMethodReassignment`'s
    SourceFile walk): collect every `Builtin.prop` / `Builtin[prop]` /
    `Builtin.prototype.m` referenced, materialise exactly those.
  - **Conservative fail-loud:** if a referenced built-in property has no
    native helper yet, emit `Codegen error: <Name>.<prop> not yet available
    in standalone (#1888)` rather than a null slot that traps at runtime.

This keeps the registry proportional to what the program uses, not to the
full built-in surface. It is the smallest piece and ships last.

### D5 — Accessor descriptors (`__defineProperty_accessor`): extend
###      `$PropEntry` with two funcref slots, gated by the `ACCESSOR` flag.

S6 deferred accessors because `$PropEntry` has only `{key, value, flags}`.
Extend it (this is a **type-layout change** — see migration note R3):

```
(type $PropEntry (struct
  (field $key    (ref $AnyString))   ;; immutable
  (field $value  (mut anyref))       ;; data value | null when accessor
  (field $flags  (mut i32))          ;; +bit 6 = FLAG_ACCESSOR (0x20 free; see below)
  (field $get    (mut (ref null $Closure0)))   ;; getter closure | null
  (field $set    (mut (ref null $Closure1))))) ;; setter closure | null
```

  - `FLAG_ACCESSOR` bit: pick an unused bit. Current bits:
    `WRITABLE 0x01, ENUMERABLE 0x02, CONFIGURABLE 0x04, TOMBSTONE 0x80`.
    Use **`0x08`** for `FLAG_ACCESSOR` (0x10/0x20/0x40 remain free).
  - `$Closure0`/`$Closure1`: reuse the existing zero-arg / one-arg
    `$Closure` wrapper base types the `__call_fn_0` / `__call_fn_1`
    dispatch already targets. Getter = arity-0 (`this` is the self field of
    the wrapper); setter = arity-1 (the new value). If the program defines
    no accessor, these two fields are always null — zero behavioural change
    for the data-only path (S1–S3 tests must stay green).
  - `__extern_get`: after locating the entry, if `flags & FLAG_ACCESSOR`,
    invoke `$get` via `__call_fn_0(self)` (§6.2.5.5 GetValue of an accessor
    Reference) instead of returning `$value`. Null getter ⇒ return
    `undefined` (§10.1.5.1).
  - `__extern_set`: if `flags & FLAG_ACCESSOR`, invoke `$set` via
    `__call_fn_1(self, newValue)`; null setter ⇒ no-op in sloppy mode
    (strict-mode throw deferred to the #1473 error machinery, same posture
    as the freeze-write refusal).
  - `__defineProperty_accessor`: native impl — find-or-insert the entry, set
    `FLAG_ACCESSOR`, store the getter/setter closures, clear `$value`.

### D6 — `__extern_method_call` / `__proto_method_call` native impls.

Both are added to `OBJECT_RUNTIME_HELPER_NAMES` with the **exact host
signatures** so every existing call site auto-routes with zero retargeting
(the Slice-1 invariant):

```
__extern_method_call (externref recv, externref name, externref args) -> externref
__proto_method_call  (externref typeName, externref methodName,
                      externref recv, externref args) -> externref
```

`__extern_method_call` native algorithm (case (b) + runtime brand fallback):

```
any = any.convert_extern(recv)
if any is null            -> throw TypeError (Call on null/undefined)   ;; §7.3.14
if ref.test $Object(any):
    m = __extern_get(recv, name)          ;; own + proto walk, accessor-aware (D5)
    if m is null / not $Closure*          -> throw TypeError "<name> is not a function"
    return __apply_closure(m, recv, args) ;; D7 — arity-dispatched call_ref
if ref.test $Vec(any):    return <array-method brand arm>(any, name, args)
if string-branded:        return <string-method brand arm>(any, name, args)
... (Map/Set/etc. brand arms reuse existing native helpers) ...
else                      -> throw TypeError
```

`__proto_method_call(typeName, methodName, recv, args)` is the
borrowed-method form (`Array.prototype.map.call(arrayLike, cb)`). It
ignores `recv`'s own shape and dispatches `methodName` against the
*named type's* prototype semantics — i.e. it routes straight to the
`typeName`-specific native helper for `methodName` applied to `recv` (the
brand arm for `typeName`, bypassing the own-property lookup). For
`typeName === "Object"` the receiver is coerced via ToObject and the
`$Object` user-method path is used. This is the same arm table as
`__extern_method_call`, keyed by `typeName` instead of the runtime brand.

### D7 — `__apply_closure(method, recv, args)`: the arity bridge.

The existing `__call_fn_N` exports take *positional* externref params, but
the dispatch call site has `args` as a `$ObjVec`/JS-array externref of
unknown length. Add a native bridge:

```
__apply_closure (externref fn, externref recv, externref args) -> externref
```

that reads `__extern_length(args)`, and dispatches to `__call_fn_0..4`
(reading `__extern_get_idx(args, k)` for each positional) for the common
arities, with a refuse-loud fallback (`Codegen error: dynamic method arity
>4 not yet supported in standalone (#1888)`) above arity 4 — matching the
existing `emitClosureCallExport{,1,2,3,4}` ceiling. (Raising the ceiling is
a mechanical follow-up: add `__call_fn_5+`.) The `recv` is threaded as the
closure self/`this` (the wrapper's self field), per §7.3.14.

## INDEPENDENT SLICES (for sd-1472c)

Each slice is a reviewable PR. They share the `object-runtime.ts` tail +
`tests/issue-1472.test.ts` region (mechanical merge, as in S1–S3). **Order
matters only where noted**; (b)-path slices are the high-value core.

### Slice 0 — Fast-path audit (NO new runtime; small, do first)
- Grep every `ensureLateImport(ctx, "__extern_method_call" | "__get_builtin"
  | "__proto_method_call", …)` call site and every `!ctx.standalone`-gated
  static method fast path in `calls.ts` / `array-methods.ts` /
  `property-access.ts`.
- For each, classify: does a statically-classifiable receiver (case (a))
  already have a native helper that the standalone path *should* reach but
  currently bails to the host shim? Fix those to route to the existing
  native helper (no new runtime). Document the residual that genuinely needs
  (b)/(c).
- **Deliverable:** a short audit table in the issue file + any trivial
  fast-path re-routes. This de-risks the later slices by shrinking their
  scope to true open-receiver cases.

### Slice 1 — `__apply_closure` arity bridge (D7) [foundation]
- Native helper bridging a fetched closure + `$ObjVec`/array args to
  `__call_fn_0..4` via `__extern_length` + `__extern_get_idx`. Refuse-loud
  above arity 4.
- Test: a user closure stored in a local, invoked through the bridge with
  0/1/2 args, instantiate-and-run under Node WasmGC, zero host imports.

### Slice 2 — `__extern_method_call` for the **open `$Object` user-method**
###            path (case (b)) [the big lever — depends on Slice 1]
- Native `__extern_method_call`: `any.convert_extern` → null-check
  (TypeError) → `ref.test $Object` → `__extern_get(recv, name)` →
  not-a-function check (TypeError) → `__apply_closure`. Non-`$Object`
  brands fall through to a refuse-loud `Codegen error` *for now* (brand arms
  are Slice 4).
- Add `__extern_method_call` to `OBJECT_RUNTIME_HELPER_NAMES`.
- Tests (computed-key to force the open path, as in S3): `o.m()` /
  `o.m(a,b)` on an open `any` object whose `m` is a stored arrow; method
  reads/writes `this.x` through the open object; `o.notAFn()` throws
  TypeError; `o` null throws TypeError. Instantiate-and-run, zero host
  imports.
- **Also unblocks the bare-method presence forms** sd-1472c's earlier
  slices punted (`o.hasOwnProperty(k)`, `o.isPrototypeOf(x)`): once the open
  `$Object` user-method path lives, route those bare-method names to the
  native `__hasOwnProperty`/`__object_hasOwn`/`__isPrototypeOf` helpers from
  the brand-arm table instead of the falsy no-op (the call-site dispatch gap
  flagged in S2's "Deferred" note).

### Slice 3 — `__proto_method_call` native (D6 borrowed-method form)
###            [depends on Slice 2 brand table skeleton]
- Native `__proto_method_call(typeName, methodName, recv, args)`: arm table
  keyed by `typeName` string; `"Object"` → ToObject + user-method path;
  other type names route to that type's native method helper. Refuse-loud
  for any `(typeName, methodName)` with no native helper.
- Tests: `Object.prototype.hasOwnProperty.call(o, k)`, a borrowed array
  method on an array-like, refuse path for an unsupported pair.

### Slice 4 — Runtime brand arms in `__extern_method_call` (case (a)
###            fallthrough for genuinely-`any` receivers)
- Extend `__extern_method_call` with `ref.test $Vec` / string-brand /
  Map / Set arms, each routing `methodName` to the existing native helper.
  This is additive over Slice 2's `$Object`-only body.
- Coordinate with **#2177** (receiver-element-retrieval for
  `Array.proto.<m>.call($Vec/open-obj)`) — that spec is the element-read
  side of the same brand-dispatch; reuse its helper, don't duplicate.
- Tests: `(x as any).push(1)` where `x` is a `$Vec` at runtime; string
  method on an `any`-typed string.

### Slice 5 — Accessor descriptors (D5) [type-layout change — see R3]
- Extend `$PropEntry` with `$get`/`$set` funcref slots + `FLAG_ACCESSOR`
  (0x08). Make `__extern_get`/`__extern_set` accessor-aware. Native
  `__defineProperty_accessor`. Add to `OBJECT_RUNTIME_HELPER_NAMES` and
  remove `__defineProperty_accessor` from the refusal set.
- **Regression gate:** every S1–S3 data-descriptor test must stay green
  (the two new fields are null on the data path).
- Tests: `Object.defineProperty(o, "x", { get(){...}, set(v){...} })` then
  read/write `o.x` invokes getter/setter; enumerable/configurable flags
  honoured; getter-only write is a sloppy no-op.

### Slice 6 — Built-in singleton registry (D4, case (c)) [self-contained,
###            ships last]
- Per-referenced-built-in lazy `$Object` singleton global, demand-populated
  from the compile-time reference scan. `__get_builtin` native routes to the
  singleton. Refuse-loud for any referenced built-in prop with no native
  helper.
- Tests: `const C = Array; C.isArray([])`; `Object.keys` read as a value
  then applied; refuse path for an unsupported built-in prop.

#### S6-b residual map + tight-first-slice (sd-s2 recon, 2026-06-05) — BANKED, build after #124

The wrappable surface is gated by whether the method's **call-impl already
exists natively** (you can only box a `$Closure` value around a helper that can
actually run). Probed each static method as a DIRECT call under `--target
standalone`:

- **Wrappable now** (native call-impl exists → box as `$Closure` value):
  `Array.isArray`, `JSON.stringify`, `String.fromCharCode`, `Math.*`
  (max/min/abs/…), `Number.*` (isInteger/…). These are the **first-slice set**.
- **Refuses even when called** (S6-b CANNOT wrap; leave refusing, fail-loud):
  `Reflect.has` + the rest of Reflect (#1472 Phase-blocked).
- **Call-OK but returns wrong value — NOT S6-b, separate finding** (see below):
  `Object.keys({a:1}).length`→0 (should be 1), `Object.assign({},{a:1}).a`→0.
  These are `$Object` **enumeration / own-prop** gaps, independent of dispatch.

**First slice (tight, fail-loud):** build the D4 registry machinery + the
compile-time reference scan, materialize ONLY the wrappable set above, and emit
`Codegen error: <Name>.<prop> not yet available in standalone (#1888)` for
everything else (Reflect, Object.keys-as-value, any prop whose call-impl
refuses). Every gap stays a clean refuse — NEVER invalid Wasm. Later slices add
methods as their native call-impls land. Symbol well-knowns: only register them
once a real native Symbol-value emitter exists (the i32-symbol-id does not
compose as a JS value — see S6-c note; keep refusing until then).

**Per-name guardrail (same as S6-c):** for every (Name, prop) the reference scan
materializes, confirm the underlying native call-impl actually emits a value
under standalone before wrapping — a wrapped-but-non-emitting helper would turn a
clean refuse into a stack-underflow / invalid Wasm.

#### Sibling finding (SEPARATE issue, not S6-b, not #124)

`Object.keys(o).length` → 0 and `Object.assign({},{src}).prop` → 0 under
standalone: the `$Object` **enumeration count / own-prop materialization** is
wrong (likely in `__object_keys` / `__object_assign` struct ops — possibly shares
root with the #1901 `$Object` read gap). It is NOT a dispatch problem. File as
its own finding/issue; do not fold into S6-b.

### Slice 7 — `Object.setPrototypeOf` dual-mode (small, independent)
- `calls.ts` ~L3857 currently stubs `setPrototypeOf` (drops proto) in ALL
  modes. Make it a dual-mode call-site change: standalone writes
  `$Object.$proto` (field 0) after the §10.1.2.1 OrdinarySetPrototypeOf
  checks (non-extensible target ⇒ refuse-or-throw; cycle check by walking
  the candidate proto chain for identity with the target). GC/host keeps the
  existing host path. Independent of the dispatch slices.

## Edge cases (must handle)

- **Null/undefined receiver** in `obj.m()` ⇒ TypeError before method
  lookup (§7.3.14; the host shim's "Cannot read properties of null"). In
  standalone, conflate undefined≡null (`ref.is_null`), as elsewhere in the
  runtime.
- **Method value present but not callable** ⇒ TypeError "`m` is not a
  function" (don't `call_ref` a non-`$Closure`).
- **Accessor getter throws / setter throws** ⇒ propagate (it's a `call_ref`
  into user code; exceptions flow through the existing try/throw machinery —
  no special handling).
- **Getter-only property written / setter-only read** ⇒ §10.1.5.1: read of
  setter-only returns undefined; write of getter-only is sloppy no-op.
- **Prototype chain walk for method resolution** reuses `__extern_get`'s
  existing proto walk — accessor-aware after Slice 5.
- **`setPrototypeOf` cycle** (`o.__proto__ = o` transitively) ⇒
  OrdinarySetPrototypeOf returns false / refuse-loud; never build a cyclic
  `$proto` chain (a later proto walk would infinite-loop).
- **`setPrototypeOf` on non-extensible** target with a *different* proto ⇒
  false/refuse (§10.1.2.1 step 4).
- **Proxy interaction:** out of scope — Proxy already refuses in standalone
  (#1472 Phase C, new-super.ts / calls.ts). The dispatch layer never sees a
  Proxy because construction refused upstream. Do not add Proxy handling.
- **Symbol-keyed methods** (`obj[Symbol.iterator]()`): the `$Object` runtime
  keys only string keys (consistent standalone approximation, per the
  Reflect.ownKeys note in #1472). Symbol-keyed dispatch stays refused-loud;
  well-known-symbol protocols (iterator) have their own native paths
  (#1320/#1665) — do not entangle.
- **Method reassignment** (`o.toString = fn`): naturally handled — the open
  `$Object` stores the reassigned function as an own prop, so `__extern_get`
  finds it before the proto chain. No special wrapper-reassignment scan
  needed on the open path (that scan is a JS-host-mode wrapper concern).

## Risks / coordination

- **R1 — call-site convergence with sd-1472c's in-flight slices.** #1472
  Phase C PRs #1194/#1195/#1196 (is-undefined / has-hasOwn / proto-ops) edit
  the same `OBJECT_RUNTIME_HELPER_NAMES` tail + `tests/issue-1472.test.ts`.
  Land this issue's slices *after* those merge, or expect a ~3-line helper-
  names merge per slice (test additions at distinct anchors). Mechanical;
  senior-dev resolves any `[CONFLICT]`.
- **R2 — fast-path leakage hides the win.** Many `obj.m()` sites are
  case (a) (statically classifiable) and *should* already be native. If
  Slice 0 isn't done first, Slice 2's tests may not exercise the new path
  (TS narrows a local `{}` to a closed struct — use computed keys + `any`
  function params to force the open path, exactly as S3 did). **Do Slice 0
  first.**
- **R3 — `$PropEntry` layout change (Slice 5) is the one non-additive
  change.** Adding two fields shifts nothing in funcMap (helpers are looked
  up by name) but every `struct.new $PropEntry` / `struct.get $PropEntry`
  site in `object-runtime.ts` must pass/skip the two new fields. Keep them
  **last** in the struct so existing field indices (0/1/2) are unchanged;
  `struct.new` must still supply all 5 operands (push two `ref.null` for the
  data path). Audit every `$PropEntry` constructor in the file. This is why
  Slice 5 is sequenced after the dispatch core — it touches shared
  read/write helpers and needs the S1–S3 regression gate green.
- **R4 — binary size of the built-in registry (Slice 6).** Demand-driven
  materialisation keeps it bounded, but a program that reads many built-in
  props pays per-prop. Acceptable: it's strictly better than refusing, and
  real standalone programs reference a small built-in surface.
- **R5 — `__call_fn_N` ceiling (arity 4).** `__apply_closure` refuses
  >4-arg dynamic calls loud. If test262 shows meaningful arity-5+ dynamic
  method traffic, raise the ceiling as a mechanical follow-up
  (`emitClosureCallExportN`). Not a blocker for the bulk.

## Conservative dual-mode invariant (restate)

- Every new behaviour is `ctx.standalone`-gated or lives inside
  `ensureObjectRuntime` (standalone-only). GC/host (`__extern_method_call`
  etc. host imports) is **byte-for-byte unchanged** — verify with the
  default-`gc` regression guards in `tests/issue-1472.test.ts`.
- Native helpers carry the **exact host name + signature** so call sites
  auto-route (no per-site `if (ctx.standalone)` except the genuinely
  call-site-shaped changes: Slice 0 fast-path re-routes, Slice 7
  setPrototypeOf).
- Any unsupported `(receiver kind, method)` / `(builtin, prop)` /
  arity pair ⇒ `Codegen error:`-prefixed hard fail (compiler.ts emits
  `success:false`, empty module). **Never** a null slot that traps or a
  leaked `env::*` import. This converts gaps into trackable compile errors,
  the #1472 posture.

## Acceptance criteria

- [ ] `--target standalone` emits zero `env::__extern_method_call`,
      `env::__proto_method_call`, `env::__get_builtin`,
      `env::__defineProperty_accessor` imports for the covered cases.
- [ ] `o.m(args)` on an open `any` object (user-stored method) runs under
      Node WasmGC / wasmtime with zero host imports (Slice 2).
- [ ] `Object.defineProperty(o, k, {get,set})` getter/setter invoked on
      read/write (Slice 5); data-descriptor tests stay green.
- [ ] `Object.setPrototypeOf` writes `$proto` standalone; cycle +
      non-extensible refused (Slice 7).
- [ ] No regression in default-`gc` mode (issue-1472 gc guards green).
- [ ] Unsupported pairs refuse-loud with a `#1888` cite; no leaked imports.

## Implementation pointers (file:line)

- Routing: `src/codegen/expressions/late-imports.ts` —
  `OBJECT_RUNTIME_HELPER_NAMES` check (L308) runs *before*
  `refuseStandaloneObjectImport` (L317); add new helper names to the set so
  they route native instead of refusing.
- Runtime types/helpers: `src/codegen/object-runtime.ts` —
  `ensureObjectRuntime` (L114), `$PropEntry` (L126), `$Object` (L145),
  `FLAG_*` (L68), `OBJ_FLAG_*` (L82), `OBJECT_RUNTIME_HELPER_NAMES` (L2042),
  `ensureObjVecBuilders`, `__extern_get`/`__extern_set` accessor hook
  points.
- Closure invocation precedent: `src/codegen/index.ts` —
  `emitClosureCallExport{,1,2,3,4}` (L2316+), `closureInfoByTypeIdx`,
  `$call_fn_N` func types. `__apply_closure` bridges to these.
- Open-object method-dispatch call sites (where the host shim is requested
  today): `src/codegen/expressions/calls.ts` L1072 (wrapper-reassign),
  L7321–7405 (generic `obj.m()` + `__get_builtin` receiver),
  `src/codegen/expressions/new-super.ts` L150/L187 (super.method),
  `src/codegen/property-access.ts` L1452 (`Builtin.prop` read).
- `setPrototypeOf` stub: `src/codegen/expressions/calls.ts` ~L3857.
- Brand-arm element read shared with #2177 receiver-element-retrieval spec.

## Slice 0 — fast-path audit (sd-1472c-recover, 2026-06-05)

Read-only audit of every dispatch-helper call site + the standalone refusal
gate, before any runtime is added. No code change in this audit; it scopes
Slices 1–7 to the true open-receiver residual.

### Current standalone gate
`STANDALONE_REFUSED_IMPORT` (`src/codegen/expressions/late-imports.ts:52`)
refuses-loud, under `ctx.standalone`, any name matching
`__extern_*` / `__object_*` / `__defineProperty*` / `__getOwn*` /
`__getPrototypeOf` / `__proto_method_call` / `__get_builtin` / `__proxy_*`
(plus the explicit `__new_plain_object` / `__delete_property` /
`__hasOwnProperty` / `__propertyIsEnumerable` / `__isPrototypeOf` /
`__object_hasOwn`). The check at L308 runs **before** the refusal at L317, so
adding a name to `OBJECT_RUNTIME_HELPER_NAMES` flips it from refuse → native
route. So all three dispatch helpers (`__extern_method_call`,
`__get_builtin`, `__proto_method_call`) currently **refuse-loud** standalone —
no leaked imports today; the gap is "compiles to a #1472-Phase-B refusal",
not "invalid Wasm".

### Dispatch-helper call sites (the host shim is requested here)
| Site | Helper | Case (D1) | Notes |
| --- | --- | --- | --- |
| `calls.ts:7327-7392` (generic `obj.m(args)`) | `__extern_method_call` (+`__js_array_new`/`__js_array_push` for args, +`__get_builtin` when receiver is a `BUILTIN_CLASS_NAMES` identifier) | (b) open user object + (c) named builtin receiver | **The big lever.** Args list built with the JS-host array builders — Slice 2 branches this on `ctx.standalone` to `ensureObjVecBuilders` (native `$ObjVec`, exactly the Object.assign Slice-3 pattern), then calls native `__extern_method_call`. `__apply_closure` (Slice 1) reads the `$ObjVec` via `__extern_length`/`__extern_get_idx` (both already native). |
| `calls.ts:1072` | `__extern_method_call` | (b) | wrapper-reassignment dispatch (`o.toString = fn; o.toString()`). Naturally handled once the open `$Object` user-method path lives (the reassigned fn is an own prop). |
| `calls.ts:4460-4466` | `__get_builtin` | (c) | builtin-as-value inside a call arg. Slice 6. |
| `calls.ts:2820-2944` | `__proto_method_call` | borrowed-method | `Array.prototype.m.call(recv, …)`. Slice 3. |
| `property-access.ts:1407-1468` | `__get_builtin` (+`__extern_get`) | (c) | `Builtin.prop` read as a value. Slice 6. |
| `new-super.ts:129-192` | `__extern_method_call` | (b)/super | `super.method(args)`. Routes through the same native path once Slice 2 lands; super-receiver threading already correct. |

### Statically-classifiable fast paths (case (a)) — NOT gated against standalone
Audited the array/string/Map/Set method handlers and `tryExternClassMethodOnAny`
in `calls.ts` / `array-methods.ts` / `property-access.ts`: the case-(a) static
fast paths emit their native helpers directly and are **not** blanket-gated on
`!ctx.standalone` — they already work standalone for a statically-typed
receiver (`[].map`, `"s".slice`, `Math.max`). No Slice-0 re-route needed; the
residual is genuinely the open-`any` receiver (case b) + named-builtin-as-value
(case c). This confirms the spec's R2: Slice 2 tests MUST use computed-key
writes + `any` function params to force the open path (TS narrows a literal
`{}` to a closed struct that bypasses the runtime), exactly as S3 did.

### Conclusion / sequencing confirmed
- Slice 1 (`__apply_closure`) + Slice 2 (`__extern_method_call` open-`$Object`
  path) are the high-value core and unblock the bare-method presence forms
  (`o.hasOwnProperty(k)` etc.) the earlier Phase C slices punted.
- Per **R1**, land Slices 1+ only **after** #1194/#1195/#1196 merge (they share
  the `OBJECT_RUNTIME_HELPER_NAMES` tail + `tests/issue-1472.test.ts`). As of
  this audit #1195/#1196 are CI-green + enqueued in the merge queue (behind
  #1205); start Slice 1 once they land to avoid a shared-file re-conflict.

## Slices 1+2 — WIRED (sd-s2, 2026-06-05, branch issue-1888-s2-wire)

The high-value `~7.5k` open-`any` method-dispatch lever is implemented and
gated **on** (`S2_OPENANY_DISPATCH_WIRED = true`). Combines Slice 1
(`__apply_closure` arity bridge) + Slice 2 (`__extern_method_call` open-`$Object`
user-method path), built on the parked machinery from `issue-1888-s1-apply-closure`.

**What landed:**
- `object-runtime.ts`: `reserveApplyClosure`/`fillApplyClosure` (reserve-then-fill
  at finalize, mirroring `__drive_proto_iterator`); the `__extern_method_call`
  native arm (`any.convert_extern` → null-guard → `ref.test $Object` →
  `__extern_get` own+proto walk → `__apply_closure`); `"__extern_method_call"`
  added to `OBJECT_RUNTIME_HELPER_NAMES`.
- `index.ts`: `emitClosureMethodCallExportN(3,4)` (arity extension to 4) +
  `fillApplyClosure(ctx)` at finalize after `__call_fn_method_0..4` register.
- `context/types.ts`: `applyClosureReserved` flag.
- `calls.ts`: generic `obj.m()` dispatch site (#965 path) + the
  wrapper-reassign `emitWrapperDynamicMethodCall` both route the args list
  through native `$ObjVec` builders (`ensureObjVecBuilders`) under
  `ctx.standalone`, so `__extern_method_call` reads args via
  `__extern_length`/`__extern_get_idx` instead of host `__js_array_*`.
- `tests/issue-1472.test.ts`: `#1888 Slice 2` describe block (arity 0–4,
  this-threading, gc-mode regression guard) — instantiate-and-run, zero env imports.

**Closure round-trip prereq:** satisfied by #1226 (typeof-closure recognition)
+ the existing `closureInfoByTypeIdx` self-registration of every compiled
fn-expr (`closures.ts:2322`), so `__call_fn_method_N` emits a matching
`ref.test` arm for an open-stored method. No extra registration needed.

**#1899 decider:** did NOT trip — un-parking `__apply_closure`'s baked
`call __call_fn_method_N` validated clean; no reconcile off-by-one. The
finalize funcIdx-authority refactor is not on S2's critical path.

**Merge-defect caught + fixed (downstream effect):** the parked S1 branch
predates Slice 7, so its `calls.ts` carried the pre-Slice-7 `Object.setPrototypeOf`
**stub** (drop proto). A naive `git apply --3way` of the parked branch silently
clobbered main's newer Slice-7 standalone `__object_setPrototypeOf` branch,
regressing proto-chain inherited reads (2 Slice-7 tests failed). Fixed by
re-applying only the S2 hunks onto main's current `calls.ts` (which keeps
Slice 7). Lesson for the remaining slices: re-base parked machinery onto
**current main per-hunk**, never bulk-apply a stale full-file diff.

## S5c Representation — struct-accessor closure-capture (arch spec for sd-1888)

> Cross-refs: **#1629 S3** (the bug surfaces as a #1629 S3 correctness defect),
> **#1888 S5b** (the open-`$Object` `$PropEntry.$get/$set` accessor repr this
> reconciles with), **#1636-S1** (`__call_fn_method_N` + `__current_this`),
> **#1896** (closure-callable contract). This section is the *representation
> agreement* sd-1888 reviews before implementing. **Spec only — no code here.**

### Root cause (verified, sd-1888 + arch read of current main + worktree)

The **static-struct accessor path** in `object-ops.ts` (the
`Object.defineProperty(o, "p", {get/set})` arm when `o` resolves to a struct
type) at `src/codegen/object-ops.ts:954-1171` compiles each getter/setter as a
**bare Wasm function** `${structName}_get_${prop}` / `${structName}_set_${prop}`
with signature `(this: ref null $struct[, value]) -> result` and **no
closure-capture environment**. The body is compiled into a fresh
`FunctionContext` whose `localMap` contains only `this` (+ setter value) — so
any identifier that refers to an enclosing-scope variable resolves to nothing
and falls through to a 0/undefined default. Verified standalone failures:
`let n=5; ({get v(){return n+37}}).v` → 37 not 42; `let k=42; get(){return k}` →
0; capturing setter `set(nv){b=nv*2}` → 0. Only pure-`this`/constant-body
accessors work.

Crucially, the **object-literal accessor path** (`literals.ts:1411/1495/1679`)
and the class-member / nested-decl paths *do* call
`promoteAccessorCapturesToGlobals` (`closures.ts:277`), which snapshots each
captured local into a fresh `__captured_<name>` Wasm global. The
`Object.defineProperty` struct arm at `object-ops.ts:954-1171` **never calls
it** — that asymmetry is the localized defect.

Two further facts shape the design:

1. **`promoteAccessorCapturesToGlobals` is a snapshot, not a live capture.** It
   copies the *current* local value into a module global at define time. That is
   wrong for closures that must observe later outer-scope mutation, and it is
   not per-instance (two objects sharing the same `${structName}_get_${prop}`
   function would share one global). It is a stopgap that happens to pass the
   simple objlit tests; it is **not** the representation S5c should generalize.
2. **LATENT in GC mode.** GC routes most accessor-bearing `any` receivers
   through `__make_getter_callback` (`declarations.ts:1255`,
   `closures.ts:2704`), which builds a real capturing callback (cbId + captures
   externref). That masks the bare-fn defect for the host path. The struct fast
   path (`property-access.ts:870-882`, `assignment.ts:2332-2375`) has the same
   bare-fn defect in *both* modes, but GC programs rarely hit it because the
   struct fast path requires a statically-resolved `structName`.

### Decision (option B): re-represent the struct accessor as a host-free capturing closure stored in a per-(struct,prop) global, invoked via `call_ref` with `this` threaded through `__current_this`.

This is the S5b representation, lifted out of the `$Object` runtime so the
static-struct fast path and the open-`$Object` path share **one** accessor
representation and **one** invocation primitive (`__call_fn_method_N`).

#### Q1 — Storage: a per-(struct,prop) nullable Wasm global holding a boxed `$Closure`.

- For each `(structName, prop)` accessor, allocate **two** nullable Wasm globals
  (lazy — only when a getter/setter exists):
  `$__acc_get_<structName>_<prop> : (ref null $any)` and
  `$__acc_set_<structName>_<prop> : (ref null $any)` (type `anyref`; a getter-
  or setter-only accessor leaves the other null).
- The global holds the **boxed closure wrapper** produced by
  `compileArrowAsClosure` (`closures.ts:1247`) for the getter/setter
  function-expression — i.e. a `$Closure`-family subtype struct whose field 0 is
  the funcref and fields 1..N are the captured outer values (ref-celled when
  mutable, per the standard closure machinery). This is **identical in shape** to
  what S5b stores in `$PropEntry.$get/$set` (an `anyref` holding a boxed
  closure), so the two paths converge on the same boxed-closure contract and the
  same `__call_fn_method_N` invoker.
- **Why a global, not a struct slot:** the static-struct receiver is a *closed*
  WasmGC struct (`$struct`) whose field layout is fixed at type-creation time and
  is shared by every instance — we cannot add per-instance get/set funcref slots
  without changing the closed-struct layout (which would regress the #1472 R2
  closed-struct fast path and every `struct.get`/`struct.set` site). A
  getter/setter installed via `Object.defineProperty(o, "p", …)` on a
  struct-typed receiver is, in practice, a *per-(type,property)* construct in
  this compiler (the read/write sites already key off `${structName}_${prop}`
  via `ctx.classAccessorSet`), so a module-level global keyed by the same string
  is the minimal, layout-stable carrier. **Per-instance accessors with distinct
  captures on the same property are out of scope** (refuse-loud — see Q5/edge
  cases); they require the open-`$Object` runtime path (S5b), which already
  stores per-instance `$PropEntry.$get/$set`.
- Register the closure-bearing pair in a new `ctx` side table
  `structAccessorClosure: Map<string, {getGlobalIdx?: number; setGlobalIdx?: number}>`
  keyed by `${structName}_${prop}`, set alongside the existing
  `ctx.classAccessorSet.add(accessorKey)`. The read/write sites consult it to
  decide closure-invoke vs. (legacy) bare-fn call.

#### Q2 — Invocation + capture-env threading (the crux sd-1888 flagged).

Reuse the **#1636-S1** mechanism end-to-end — do **not** invent a new call path:

- **Capture-env reaches the body via the `$Closure` wrapper's `$self`**, exactly
  as `compileArrowAsClosure` already arranges: the lifted body's param 0 is
  `__self` (the wrapper struct), and outer-var reads inside the body
  `ref.cast`-down to the capture subtype and `struct.get` the capture field
  (`closures.ts:1694-1781`). So **there is no separate "capture env" to thread at
  the call site** — it is baked into the boxed closure value sitting in the
  global. This is the seam that was missing: the bare-fn form had no `$self`, so
  no capture field existed to read.
- **`this` is threaded via `__current_this`**, not via a closure param.
  `__call_fn_method_<arity>` (`index.ts:3052`, emitted for N=0..2 today, extended
  to 4 by S2's `emitClosureMethodCallExportN(3,4)`) installs its `thisVal` arg
  into the `__current_this` global before the inner `call_ref` and restores it
  after (`index.ts:3125-3260`). Inside the getter/setter body, `this` resolves to
  `global.get __current_this` (the #1636-S1 read-drive). So:
  - **Getter read** (`property-access.ts:870-882`): replace the bare
    `call ${getterName}` with: box the receiver `$struct` → externref; then
    `__call_fn_method_0(boxedClosure, thisExtern)` (arity 0 = no user args). The
    result externref is unboxed/coerced to the getter's declared return type.
  - **Setter write** (`assignment.ts:2332-2375`): replace the bare
    `call ${setterName}` with: box receiver + box the new value;
    `__call_fn_method_1(boxedClosure, thisExtern, valueExtern)`; the `=`
    expression still yields the RHS (unchanged), per current behavior.
- **`this` inside the body** must read `__current_this` and `ref.cast` it back to
  `$struct` for `this.field` reads/writes. The getter/setter body is compiled
  with the standard closure-body machinery (`compileArrowAsClosure`), which
  already supports `this` capture for arrow/method bodies via the existing
  `this`-tracking (`closures.ts:190-201`); the implementer threads the receiver
  through `__current_this` rather than as the old explicit struct param 0.
- **#1896 contract:** the boxed value MUST be a `$Closure`-family wrapper that
  `__call_fn_method_N`'s `ref.test`→`ref.cast`→`struct.get $func`→`call_ref`
  dispatch recognizes. `compileArrowAsClosure` self-registers each compiled
  fn-expr in `closureInfoByTypeIdx` (`closures.ts`, the same mechanism S2 relied
  on), so the method-call export emits a matching arm with no extra registration.
  Under `--nativeStrings`/standalone, honor the #1896-prereq ref-arg coercion
  (externref→anyref) already landed in task #332.

#### Q3 — Compile-site change at `object-ops.ts:954-1171`.

Replace the two bare-fn emission blocks (getter at 996-1086, setter at
1089-1166) with a shared helper, e.g.
`emitStructAccessorClosure(ctx, fctx, structName, prop, node, kind)` that:

1. Calls `compileArrowAsClosure(ctx, fctx, <getter/setter as FunctionExpression>)`
   to produce a boxed `$Closure` value on the stack (this performs the capture
   analysis + ref-cell packing the bare path skipped). The getter is arity-0,
   the setter arity-1 (the value param); `this` is *not* a closure param (it
   comes via `__current_this`).
2. `extern.convert_any` (or store as `anyref`) and `global.set` into the lazily
   created `$__acc_get_…` / `$__acc_set_…` global; record in
   `ctx.structAccessorClosure`.
3. Still `ctx.classAccessorSet.add(accessorKey)` so the read/write dispatch
   sites fire (they gate on it today).

**Factor the helper so the open-`$Object` arm (S5b) can call the same closure
builder** — i.e. the closure-construction (steps 1) is shared; only the
*storage target* differs (global for the closed-struct path; `$PropEntry.$get`
/`$set` field for the open-`$Object` path). Put the shared builder in
`closures.ts` next to `compileArrowAsClosure`; the two storage sites
(`object-ops.ts` struct arm and `object-runtime.ts` `__defineProperty_accessor`)
each consume its result.

#### Q4 — Object-literal `{get x(){}}` standalone u32 -1.

The objlit path (`compileObjectLiteralWithAccessors`, `literals.ts:250-520`)
routes accessors through `compileArrowAsCallback` + `__defineProperty_accessor`.
Under standalone this currently fails because the callback-lift assumes the
host `__make_getter_callback` import (a JS callback table), which has no
standalone backing — the lift emits an unresolved index (the "u32 -1"). **Fix on
the same S5c representation:** under `ctx.standalone`, the objlit accessor arm
must build the getter/setter via the **shared closure builder** (Q3 step 1),
box it, and pass it as the `getterCb`/`setterCb` argument to the native
`__defineProperty_accessor` (which S5b/main already routes to the
`$PropEntry.$get/$set` store via `OBJECT_RUNTIME_HELPER_NAMES`). So the objlit
path stops calling `__make_getter_callback` standalone and instead hands a real
boxed `$Closure` to the native descriptor-store, exactly the value S5b's
`__extern_get`/`__extern_set` already `call_ref` via `__call_fn_method_N`. GC
mode keeps the `__make_getter_callback` host path unchanged.

#### Q5 — Dual-mode safety / regression surface (load-bearing).

The change is **standalone-gated and additive** wherever it touches shared
read/write/dispatch:

- **GC/host struct accessors:** keep the **bare-fn `call ${getterName}`** path
  (`property-access.ts:874`, `assignment.ts`'s `call finalSetterIdx`) **for GC
  mode** OR adopt the closure path in both — *decision: adopt the closure path in
  both modes for the struct arm*, because the bare-fn path is simply buggy
  (drops captures) in GC too, and the closure path is host-free. BUT this is the
  **biggest regression surface** — every existing class-accessor test
  (`#459` suite, `#1680`/`#1681` private accessors, `#1605`/`#1117` accessor-only
  ctor) currently relies on the bare-fn `call`. The implementer MUST keep the
  read/write dispatch **keyed on `ctx.structAccessorClosure.has(key)`**: only
  accessors *defined via the S5c closure builder* use `call_ref`; class-declared
  accessors compiled elsewhere (class-bodies.ts, literals.ts class path) keep
  their existing bare-fn `call` until/unless migrated. **Do not migrate the
  class-accessor emission in this issue** — scope S5c to the
  `Object.defineProperty` struct arm + the objlit standalone arm. This keeps the
  `#459`/`#1680` suites on their proven path.
- **Closed-struct fast path (#1472 R2):** untouched — no struct-layout change
  (storage is a module global, not a struct field). Verify the closed-struct
  data-field `struct.get`/`struct.set` sites are byte-for-byte unchanged.
- **S5b open-`$Object` accessors:** unchanged representation
  (`$PropEntry.$get/$set` `anyref` + `FLAG_ACCESSOR=0x08`); S5c only *shares the
  closure builder* with it, it does not alter the `$PropEntry` layout or the
  `__extern_get`/`__extern_set` accessor arms.
- **Refuse-loud** (per the #1888 conservative invariant): per-instance accessors
  with distinct captures on the same `(struct,prop)` (two `defineProperty` calls
  on different instances installing different closures) ⇒ the global is
  single-valued, so the *second* install would clobber the first. The struct
  fast path is type-keyed, so this is inherently a per-type construct; if the
  implementer detects two installs on the same key with materially different
  capture sets, emit `Codegen error: per-instance struct accessor with distinct
  captures not supported in standalone (#1888 S5c)` rather than silently sharing.
  (In practice test262/real programs install one accessor per type-property.)
- Arity ceiling: getters are arity 0, setters arity 1 — both well within the
  `__call_fn_method_0..4` range (S2 extended to 4), so no ceiling concern.

### Slice breakdown (reviewable PRs for sd-1888)

Each slice is independently verifiable, instantiate-and-run under Node WasmGC,
zero `env::` imports for the standalone cases. Gate the whole feature behind a
`S5C_STRUCT_ACCESSOR_CLOSURE` boolean (mirroring S2's `S2_OPENANY_DISPATCH_WIRED`)
so it can land dark and flip on after the regression gate is green.

- **Slice C1 — shared closure builder + storage globals (foundation).**
  Factor `buildAccessorClosure(ctx, fctx, fnExprNode, arity)` in `closures.ts`
  from `compileArrowAsClosure` (it IS `compileArrowAsClosure` specialized to
  arity-0 getter / arity-1 setter with `this`-via-`__current_this`). Add the
  `ctx.structAccessorClosure` side table + lazy per-(struct,prop) globals.
  No read/write wiring yet. Unit test: builder produces a valid boxed `$Closure`
  for a capturing getter; module validates.
- **Slice C2 — define-site rewrite (`object-ops.ts:954-1171`).** Replace the two
  bare-fn blocks with `buildAccessorClosure` + `global.set`. Behind the flag,
  keep the bare-fn path when the flag is off. Test: compile-only — verify the
  globals are populated and `ctx.structAccessorClosure` is keyed.
- **Slice C3 — read-path (`property-access.ts:870-882`).** When
  `ctx.structAccessorClosure.has(key)` and a getter global exists: box receiver,
  `__call_fn_method_0(getterClosure, thisExtern)`, unbox to declared return type;
  else fall through to the existing bare-fn `call`. Tests (the verified repros):
  `let n=5; ...{get v(){return n+37}}...v` → 42; `let k=42; get(){return k}` →
  42; getter reading `this.x` AND an outer capture together.
- **Slice C4 — write-path (`assignment.ts:2332-2375`).** Symmetric:
  `__call_fn_method_1(setterClosure, thisExtern, valueExtern)`; `=` yields RHS.
  Tests: capturing setter `set(nv){ b = nv*2 }` writes outer `b`; setter writing
  `this.x` from the value; setter-only property read returns undefined;
  getter-only property write is a sloppy no-op.
- **Slice C5 — objlit `{get x(){}}` standalone (`literals.ts:250-520`).** Under
  `ctx.standalone`, build getter/setter via `buildAccessorClosure`, pass the
  boxed closures to native `__defineProperty_accessor` (S5b store). Stop emitting
  `__make_getter_callback` standalone. Tests: `const o = { get x(){ return cap },
  set x(v){ cap = v } }` under `--target standalone` — read/write observe the
  capture; zero `env::` imports; GC-mode objlit accessor regression guard.

### Acceptance (S5c)

- [ ] Capturing struct getter/setter (`Object.defineProperty` + struct receiver)
      observes outer-scope captures, standalone + GC, zero host imports.
- [ ] Objlit `{get x(){}}` with captures compiles + runs standalone (no
      `__make_getter_callback`, no unresolved-index serializer failure).
- [ ] `#459`/`#1680`/`#1681`/`#1605` class-accessor suites stay green (class
      accessors are NOT migrated; bare-fn path preserved behind the key gate).
- [ ] Closed-struct fast-path (#1472 R2) byte-for-byte unchanged.
- [ ] S5b open-`$Object` `$PropEntry.$get/$set` representation unchanged; only
      the closure *builder* is shared.
- [ ] Per-instance distinct-capture accessor on one `(struct,prop)` refuses-loud
      with a `#1888 S5c` cite.

## S5c — IMPLEMENTED (sd-1888, 2026-06-05, branch issue-1888-s5c-struct-closure)

All 7 acceptance tests green (`tests/issue-1472.test.ts`), tsc clean, GC-mode
byte-identical, `#1629` accessor suite 21 pass. Slices as-built:

- **C1** `src/codegen/struct-accessor-closure.ts` (new): `buildAccessorClosure`
  (lifts a getter/setter via `compileArrowAsClosure` → externref; shared with the
  S5b open-`$Object` arm), `ensureStructAccessorGlobal` (idempotent per-(struct,prop)
  nullable `(mut externref)` module global; returns the **absolute** Wasm global
  index `numImportGlobals + mod.globals.length` — relative-index would mis-address
  if any host global were imported). `ctx.structAccessorClosure: Map<string,
  {getGlobal?; setGlobal?}>` added to context/types.ts + create-context.ts. Master
  gate `S5C_STRUCT_ACCESSOR_CLOSURE` (now `true`).
- **C2** define-site (object-ops.ts struct-accessor arm): under
  `S5C_STRUCT_ACCESSOR_CLOSURE && ctx.standalone`, lift each getter/setter +
  `global.set` into its slot (the proven S5b `as unknown as ts.FunctionExpression`
  cast for MethodDeclaration/Get-SetAccessorDeclaration node shapes).
- **C3** read (property-access.ts primary instance read ~2426 + optional-chain ~870):
  gate on `structAccessorClosure.get(key)?.getGlobal`; box recv→externref,
  `global.get` the get-slot, `call __call_accessor_get(recv, getter)` (reserve via
  `reserveAccessorGetDriver`), result externref. Class accessors (no
  structAccessorClosure entry) keep the bare-fn path.
- **C4** write (expressions/assignment.ts ~2334): box recv→externref, `global.get`
  set-slot, tee the RHS (natural type) for the assignment result, box→externref,
  `call __call_accessor_set(recv, setter, value)` (driver discards setter return
  per §10.1.5.3); `=` evaluates to the RHS.
- **C5** objlit: the objlit accessor path already routed standalone through
  `emitObjectLiteralAccessorFn` → `compileArrowAsClosure` →
  `__defineProperty_accessor` (S5b — correct). The remaining standalone `-1`
  serializer failure was the accessor-KEY emission using the `-1` string-constant
  sentinel via `global.get`; fixed by materializing the key with
  `stringConstantExternrefInstrs` (native-string inline under standalone;
  `global.get` under GC). The objlit getter/setter store arms in
  `compileObjectLiteralForStruct`'s accessor loop are additive (typed-objlit
  struct path).

**Divergence from spec Q5 (signed off by tech-lead):** kept the struct arm
**standalone-only** (`ctx.standalone`-gated), NOT "both modes". GC already handles
captures via `__make_getter_callback`; migrating it buys zero standalone-goal value
while taking on the full class-accessor regression surface (#459/#1680/#1681/#1605).
GC-struct-arm migration is explicitly NOT a follow-up unless a real GC-mode
capturing-accessor bug surfaces.

**Sibling sites (carved as #129, NOT in this PR):** the same `-1`-sentinel
`global.get` pattern exists at the objlit string-data-prop key (literals.ts ~399)
and the Symbol-keyed-method fallback key (literals.ts ~461) — confirmed buggy under
standalone, same `stringConstantExternrefInstrs` fix; separate small PR after S5c.

## S6 static globals — IMPLEMENTED (codex attempt 22, 2026-06-07)

Implemented the first demand-driven built-ins-as-static-globals surface for
standalone: `Array` and `Object` now materialize as lazy open-`$Object`
singletons when read as values, populated only with supported static method
closures. The initial supported properties are `Array.isArray` and
`Object.keys`, both backed by existing native standalone behavior rather than a
runtime `globalThis` map.

What changed:
- New `src/codegen/builtin-static-globals.ts`: emits cached closure values for
  `Array.isArray` and `Object.keys`; emits lazy `$Object` singleton globals for
  bare `Array` / `Object` value reads.
- `identifiers.ts`: standalone bare `Array` / `Object` resolve to the singleton
  before ambient lib declarations can route them to host globals.
- `property-access.ts` direct `Builtin.prop` value reads are handled by the
  merged #1907 static-method closure path; this branch keeps the complementary
  namespace-object value path for `const C = Array` / `const O = Object`.
- `calls.ts`: for aliases initialized from supported built-in namespaces, skip
  the legacy any-receiver extern-class heuristic so `const O = Object; O.keys(o)`
  reaches the open-object method dispatcher instead of importing a typed-array
  `keys` method.
- Tests live in `tests/issue-1888.test.ts`; the stale S6-c guardrail in
  `tests/issue-1888-s6c.test.ts` now asserts `Array.isArray` value reads are
  native.

Validation:
- `pnpm exec tsc --noEmit`
- `pnpm exec vitest run tests/issue-1888.test.ts tests/issue-1888-s6c.test.ts tests/issue-1907.test.ts`
- `pnpm exec biome lint src/codegen/builtin-static-globals.ts src/codegen/expressions/identifiers.ts src/codegen/property-access.ts src/codegen/expressions/calls.ts tests/issue-1888.test.ts tests/issue-1888-s6c.test.ts tests/issue-1907.test.ts --diagnostic-level=error --max-diagnostics=50`

## Attempt 30 bridge follow-up (codex, 2026-06-07)

Resolved the extra scoped Slice-2 failures observed after S6: standalone
open-`any` method closures with 2/3/4 numeric `any` args were returning `NaN`
because the standalone dispatch boundary boxed arguments as native externref
carriers, while the any-typed closure body expected `$AnyValue`, then returned
that `$AnyValue` back through raw `extern.convert_any`.

What changed:
- Added standalone-only `$AnyValue` bridge helpers:
  `__any_from_extern` converts native boxed number/boolean externrefs into
  `$AnyValue`; `__any_to_extern` converts `$AnyValue` numeric/boolean/string/ref
  results back across the standalone externref boundary.
- Recorded native boxed carrier type indices in `CodegenContext` when union
  helpers are emitted, so the bridge can recognize `__box_number_struct` and
  `__box_boolean_struct` without host imports.
- Wired both `coerceType` and `coercionInstrs`; the latter is required for
  expression-bodied closure returns, which was the actual Slice-2 NaN path.
- Kept the closure dispatcher result bridge for direct `$AnyValue` return arms
  and added the issue-local regression in `tests/issue-1888.test.ts`.

Validation:
- `pnpm exec vitest run tests/issue-1888.test.ts tests/issue-1888-s6c.test.ts tests/issue-1907.test.ts`
- `pnpm exec vitest run tests/issue-1472.test.ts -t "#1888 Slice 2"`
- `pnpm exec tsc --noEmit`
- `pnpm exec biome lint src/codegen/any-helpers.ts src/codegen/type-coercion.ts src/codegen/index.ts src/codegen/context/types.ts src/codegen/context/create-context.ts src/codegen/builtin-static-globals.ts src/codegen/expressions/identifiers.ts src/codegen/expressions/calls.ts tests/issue-1888.test.ts tests/issue-1888-s6c.test.ts tests/issue-1907.test.ts --diagnostic-level=error --max-diagnostics=50`

PR #1273 remains the review vehicle; status stays `in-review` until the PR
status poller marks it done after merge.

## Reopened 2026-07-20 (stale false-done review)

Marked `done` but live test262 shows: BigUint64Array built-in static property value read still unsupported (standalone). Reopened as `ready`. See #3474 (done-status integrity).
