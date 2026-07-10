---
id: 3031
title: "architect spec: dynamic MOP extensions — Proxy trap dispatch, mutable [[Prototype]] chains, `with` scope objects (umbrella over the #2175 substrate)"
status: ready
sprint: Backlog
created: 2026-07-04
updated: 2026-07-09
assignee: ttraenkler/fable-3031 (apply slice only — released on merge; umbrella stays open)
priority: high
horizon: xl
feasibility: hard
reasoning_effort: max
task_type: analysis
area: codegen, runtime
language_feature: proxy, prototype-chain, with-statement, dynamic-scope
goal: spec-completeness
related: [2175, 1355, 2618, 2585, 2626, 3013, 3025, 3027, 2929, 2964, 2580, 2949, 56]
origin: "2026-07-04 — architect umbrella spec layering the three dynamic-MOP capabilities over the merged #2175 static-MOP substrate (PR #2616)"
---

# #3031 — Dynamic MOP extensions: Proxy · mutable [[Prototype]] · `with`

> **Tier marking (implementation model, per lead ruling):**
> **[FABLE]** = design/keystone slices requiring the strongest model
> (trap-dispatch core, chain-representation, cross-cutting contracts).
> **[OPUS]** = mechanical/executable slices (individual traps, wiring,
> per-member glue) implementable from this spec without further design.
> Every slice below carries a tier tag.

## Scope and relationship to #2175

The #2175 spec (merged PR #2616) defines the **static** MOP substrate:
`$NativeProto` (one shared heap type, brand-discriminated), the
`BUILTIN_BRAND_TABLE`, the brand-keyed native-method-closure factory
(`ensureStandaloneNativeMethodClosure`), and the brand-recovery prologue.
Contracts C1–C3 there cover _reading_ prototype objects and _dispatching_
members on dynamic receivers when the chain is the **default, immutable**
one.

This spec layers the three capabilities that make the MOP **programmable
and mutable**:

1. **Proxy** — user-defined internal methods (§10.5), both lanes.
2. **Dynamic prototype chains** — mutable `[[Prototype]]`
   (`Object.setPrototypeOf`, `__proto__`, `Object.create(p|null)`),
   with mutation _visibility_ in subsequent lookups.
3. **`with`** — the scope-object form of the same ladder
   (HasBinding/Get/Set are literally MOP operations, §9.1.1.2).

All three converge on **one dispatch spine** (Part 0). Individual traps,
per-builtin glue, and wiring are Opus-executable once the spine and the
three keystones ([FABLE] slices K1–K3) exist.

---

## Part 0 — The unified dispatch spine

### 0.1 Receiver-classification ladder — normative order **[FABLE — this ruling; enforcement is per-site OPUS]**

Every dynamic MOP entry point (get / set / has / deleteProperty / ownKeys /
getOwnPropertyDescriptor / defineProperty / getPrototypeOf /
setPrototypeOf / apply / construct / with-HasBinding) classifies its
receiver in this order:

| #   | Test                                     | Route                                                                                                                                 |
| --- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `ref.test $Proxy`                        | trap dispatch (`__proxy_*_dispatch`) — **always first**; a Proxy must intercept everything, including chain walks and `with` bindings |
| 2   | `ref.test $Object`                       | own `$PropEntry` props → miss → chain walk via `$proto` (field 0), §0.2                                                               |
| 3   | `ref.test $NativeProto`                  | brand → #2175 member-closure table → miss → `$parent` chain walk                                                                      |
| 4   | closed WasmGC struct (typed user object) | shape-table reader (the #3027 substrate direction; until it lands, refusal/fallthrough per current behavior)                          |
| 5   | host externref (js-host lane only)       | host-import boundary (`__extern_*`) — the host runs its own MOP incl. host Proxies                                                    |
| 6   | primitive box                            | wrapper-prototype route per #2175                                                                                                     |

**Mechanism ruling:** the existing **front-guard pattern** — `ref.test
$Proxy` prepended to the shared native helpers (`__extern_get/set/has`,
`__delete_property`, `__object_keys`, `__getOwnPropertyNames`,
`__getOwnPropertyDescriptor`, `__getPrototypeOf`, `__object_setPrototypeOf`,
`__obj_define_from_desc`; #1100 + #1355 slices A–F) — is **the** ladder-step-1
implementation. It is ratified: **new MOP entry points MUST route through
those helpers**, never re-implement receiver classification inline. This is
what makes Proxy-as-`with`-target and Proxy-in-a-proto-chain fall out for
free (§1.7, §3.4).

### 0.2 `__chain_lookup` — the one prototype-chain walker **[FABLE design; refactors OPUS]**

One shared loop helper (standalone; the host lane's chain walk is the
host's):

```
__chain_lookup(recv externref, key externref) -> externref  ;; value or sentinel-miss
loop (bounded, depth guard ~128 → TypeError "cyclic prototype chain"):
  1. ref.test $Proxy       → return __proxy_get_dispatch(cur, key, recv)   ;; §10.5.8 receiver threading
  2. ref.test $Object      → own props hit? return; else cur := struct.get $Object 0 ($proto)
  3. ref.test $NativeProto → brand member hit? return closure/getter-call(recv); else cur := $parent
  4. null                  → return miss-sentinel (undefined)
  5. otherwise (host externref / unmodeled) → lane-specific fallback (__extern_get in host lane; miss standalone until #3027)
```

- The **original receiver** is threaded through the whole walk (spec `Receiver`
  in OrdinaryGet §10.1.8.1) so accessor getters and Proxy `get` traps see the
  right `this`.
- `has`/`in`/with-HasBinding use the same loop with a boolean result and the
  Proxy arm calling the `has` trap (§10.5.7 walks to the target's proto when
  the trap is absent — the forward already does this).
- **Existing walkers refactor onto this helper [OPUS]:** the #2964 for-in
  proto-chain enumerator, `__getPrototypeOf`'s read, and the `in` operator's
  lookup. One walker = one place mutation visibility and the Proxy arm are
  correct.

### 0.3 Static-dispatch soundness under mutation — the per-brand dirty rule **[FABLE]**

#2175's value: static call sites (`re.test(s)`, instance `o.m()`)
**never walk the chain** — they bind by brand at compile time. A mutable
chain breaks that assumption only if the program actually mutates the
relevant chain. Ruling (compile-away philosophy — pay only when used):

- Maintain a compile-time **`ctx.mopDirtyBrands: Set<brand> | "all"`**.
  Syntactic detection marks it:
  - `<Builtin>.prototype.<m> = …` / `Object.defineProperty(<Builtin>.prototype, …)`
    → that builtin's brand is dirty for member `<m>` (member-granular where
    the key is a literal; whole-brand otherwise).
  - `Object.setPrototypeOf(x, …)` / `x.__proto__ = …` where `x`'s static
    type maps to a brand → that brand dirty; receiver un-typeable → `"all"`.
- A **dirty** `(brand, member)` demotes the static fast path _for that
  member_ to a `__chain_lookup` dynamic read. Clean programs (the
  overwhelming majority) stay **byte-identical** — this is the same S0
  acceptance discipline as #2175.
- `Proxy` never enters the static path at all: a `new Proxy(...)` value has
  no TS-type brand (memory `project_proxy_no_ts_type_brand`) — detection is
  **syntactic** (the #2615/#2618 `receiverMayBeProxy` pattern), and
  proxy-typed values are storage-typed externref, so they classify at
  ladder step 1/5.

---

## Part 1 — Proxy: trap-dispatch completion

### 1.1 Current state (verified against upstream/main `8e8eb9832`, 2026-07-04)

| Lane       | Done                                                                                                                                                                                                        | Missing                                                                                                                                                                                                                                                                                           |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| standalone | `$Proxy`/`$ProxyTraps` (12 fields) + dispatch for get/set/has/apply-base, deleteProperty, gOPD, getPrototypeOf, setPrototypeOf, isExtensible, preventExtensions, ownKeys, defineProperty (#1100, #1355 A–F) | **construct** trap; **revocable** synthesis; **Reflect.\*** wiring (setPrototypeOf/defineProperty/construct/getPrototypeOf/apply/isExtensible/preventExtensions CE before any trap runs); **§10.5 result-invariants** (slice G); present-but-non-callable-trap TypeError; trap-abrupt propagation |
| host (gc)  | #2615 (externref slot type), #2616 (non-callable trap TypeError), #2617 (boundary propagation), #2618 Slice 1 (lazy bridge + callable-target wrap, PR #1984)                                                | apply rows (`p.call(a,b)`, `p(args)` with struct-typed trap params) + construct rows — **all bottlenecked on one keystone**, K1 below                                                                                                                                                             |

**Stale-doc note:** `built-ins/Proxy` is **already run** by the test262
harness (`TEST_CATEGORIES`, `tests/test262-runner.ts:2753`; blanket skip
filters were removed in #494 — `shouldSkip` has no Proxy entry). The
CLAUDE.md "Skip filters: … Proxy …" line is stale documentation, not a
runner gate. **There is no skip-list entry to remove; the unblocking work
is pass-rate work** (host 115/311 → target 60–70% via K1; standalone ~11%
→ via slices P2–P5). What remains genuinely deferred: `*-realm.js`
(~38–48, needs `$262.createRealm`) and `*-using-with.js` (~10 — unblocked
by Part 3, §3.4).

### 1.2 K1 — the inbound-marshalling keystone (== 2623-A) **[FABLE]**

The single root cause blocking every remaining host apply/construct row
(WAT-proven in #2618's handoff): the inbound host→wasm dispatcher
`__call_fn_method_N` (`emitClosureCallExportN` → `buildArgConversion` →
`externToClosureParamRef`, `src/codegen/index.ts:3356-3378`, `:3659-3690`)
**unconditionally `ref.cast`s** each host-supplied callback arg to the
closure's declared struct param type. A trap param typed `any[]` lowers to
`(ref null $vec)`; the host passes a real JS array → `illegal cast`.

**Spec:**

- For each param whose declared type is a concrete GC struct/vec ref, emit
  a **guarded conversion** instead of the blind cast:
  ```
  any.convert_extern(arg)
  ref.test <declared>   → ref.cast <declared>            ;; today's fast path, unchanged bytes when it matches
  else, declared is $vec<T> → call __marshal_extern_to_vec_T(arg)
  else                     → catchable TypeError ("cannot convert argument"), NOT a trap
  ```
- `__marshal_extern_to_vec_T(externref) -> (ref $vec)`: host lane reads
  `__extern_length` + `__extern_get_idx` in a loop, coercing each element
  via `coerceType(externref → T)`; one helper per element ValType actually
  demanded (lazy, `ctx.funcMap`-keyed `__marshal_vec_<T>`).
- **Blast radius:** this is the hot inbound callback path (every
  `.map`/`.forEach`/Promise-executor/await continuation). The `ref.test`
  fast path keeps matching args byte-equivalent; only currently-**trapping**
  shapes take the marshal arm. Full merge_group gate mandatory
  (`project_broad_impact_validate_full_ci`); this is NOT a scoped-sweep PR.
- **Composes with (lands immediately after, [OPUS], already prototyped in
  #2618):** (a) the `compileNewExpression` syntactic-Proxy guard routing
  `new p(...)` through `__construct_closure`/host `Reflect.construct` and
  **using the trap result** (§10.5.13); (b) `_proxyTargetFor`'s
  constructable-forwarder for callable targets — with the refinement that
  constructability should be plumbed from the source function kind through
  `callback_maker` (arrow ⇒ non-constructable) rather than wrapping
  unconditionally, preserving the §10.5.13 "constructable iff target is"
  invariant.
- **Coordination:** this is the #56 call/construct-dispatch zone (sd-1838).
  Check #56's branch state before starting; if #56's rework has landed, the
  locus may have moved — re-grep `buildArgConversion`.

### 1.3 K2 — standalone `construct` + dynamic-new dispatch (slice H core) **[FABLE]**

`apply` dispatch exists since #1100 (TRAP_APPLY, field 3). `construct` has
no trap field and — more fundamentally — standalone has **no dynamic-new
path** for an externref constructor. Spec:

- `$ProxyTraps` **+field 13 `construct`** (append-only, per the #1355
  discipline); `__proxy_create` reads it off the handler.
- New `__construct_dispatch(ctor externref, argVec externref, newTarget externref) -> externref`:
  1. `ref.test $Proxy` → revoked? throw; `construct` trap present →
     `trap(target, argArray, newTarget)` via `__apply_closure`; result must
     be an Object (reuse the ownKeys-slice "is Object" complement check)
     else TypeError (§10.5.13 step 12); trap absent → target must have
     [[Construct]] (else TypeError) → recurse on target.
  2. closure-backed ctor (`ref.test` the closure wrapper) → allocate a
     fresh `$Object` whose `$proto` = ctor's `.prototype` object
     (Part 2 chain contract), call with `this` = the fresh object, return
     the object unless the body returned an object (§10.2.2).
  3. otherwise → catchable TypeError "not a constructor".
- Wire `compileNewExpression` (`new-super.ts`): when the callee is
  syntactically Proxy-bound or its storage type is externref/`any`, route
  through `__construct_dispatch` instead of the static class arm (this is
  the standalone twin of K1's host construct guard).
- Test gate: `built-ins/Proxy/construct/*` (non-realm) standalone;
  `apply/*` via the existing TRAP_APPLY once `p(...)`/`p.call(...)`
  call sites select the dynamic path for externref callees.

### 1.4 Revocable (Stage S0) **[OPUS]**

`$Proxy`'s revoked arm (`throwRevoked`) already exists in every dispatch.
Remaining work is synthesis: `Proxy.revocable(t, h)` returns a two-field
object `{ proxy, revoke }` where `revoke` is a closure nulling the
`$Proxy`'s (mut) target+handler fields and setting the revoked bit;
second call is a no-op (§28.2.2.1). ~14 standalone `revocable/**` CEs.
Bounded; no design questions.

### 1.5 Standalone `Reflect.*` wiring (Stage S1) **[OPUS]**

Route `Reflect.setPrototypeOf / defineProperty / construct /
getPrototypeOf / apply / isExtensible / preventExtensions` (calls.ts
standalone arm) through the **same front-guarded native helpers** of §0.1
instead of CE-ing. Biggest standalone Proxy/Reflect CE bucket (#1355
RE-MEASURE: ~40 CEs). `Reflect.construct` consumes K2's
`__construct_dispatch` (with explicit `newTarget`). Mechanical —
every helper already exists.

### 1.6 §10.5 result-invariants (slice G) — sequenced behind descriptor bits **[FABLE for the attribute-bit model ruling; per-trap predicates OPUS]**

The invariants (non-configurable consistency, non-extensible key-set
equality, ownKeys per-element String|Symbol + no-dups, defineProperty
reconciliation) need the standalone descriptor-attribute model
(`$PropEntry` + configurable/writable/enumerable bits — #797/#1460/#1462).
**Ruling:** extend `$PropEntry` with a packed i32 attribute-bits field
(append-only), default `writable|enumerable|configurable` for plain
assignment — decide the exact bit layout jointly with the #1460/#1462
owner; do NOT invent a parallel descriptor struct (same discipline as
#2175's "no parallel descriptor struct"). Once bits exist, each per-trap
invariant predicate is mechanical from fetched §10.5 text
(`feedback_spec_first_fixes` — cite the step in each helper). Keep
predicates + trap-name list in `src/codegen/registry/proxy.ts` as the
single source of truth. Includes the two deferred cross-cutting behaviors:
present-but-non-callable trap → TypeError (GetMethod), and trap-abrupt
propagation through `__apply_closure` (the standalone twin of host #2617).

### 1.7 Proxy as receiver in every MOP consumer (the convergence payoff)

Because §0.1 front-guards live in the shared helpers:

- **`with (proxy) { … }`** — Tier-2 `with` (§3) gates bindings on
  `__extern_has` and reads via the dynamic getter; both carry `$Proxy`
  front-guards, so the `has`/`get`/`set` traps fire per §9.1.1.2.1
  HasBinding / §9.1.1.2.6 GetBindingValue with **zero Proxy-specific code
  in with-scope.ts**. Unblocks the ~10 `*-using-with.js` host deferrals
  and the standalone twins.
- **Proxy in a prototype chain** — `__chain_lookup`'s step-1 arm invokes
  the `get`/`has` trap mid-walk with the original receiver (§10.5.8), and
  the `getPrototypeOf` trap governs the next link (already front-guarded on
  `__getPrototypeOf`).
- **for-in over a Proxy / a chain containing one** — the #2964 enumerator,
  once refactored onto `__chain_lookup` (§0.2), gets the `ownKeys` +
  `getOwnPropertyDescriptor` (enumerability filter, post-1.6) traps.

---

## Part 2 — Dynamic prototype chains

### 2.1 Representation ruling — where the mutable slot lives **[FABLE]**

| Value kind                                      | [[Prototype]] slot                                                                      | Mutable?                                                                                                                                                                 |
| ----------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| dynamic object (`$Object`)                      | `$proto` (field 0, already `mut`)                                                       | yes — `__object_setPrototypeOf` writes it (exists, round-trips host-free; verified in #3013)                                                                             |
| builtin/class prototype object (`$NativeProto`) | `$parent` (already `mut externref`)                                                     | yes — `Object.setPrototypeOf(RegExp.prototype, x)` is legal (§10.1.2); setPrototypeOf on a `$NativeProto` receiver writes `$parent` **and marks the brand dirty** (§0.3) |
| closed WasmGC struct instance                   | none — its [[Prototype]] is its class's `__proto_<Name>` singleton, _by representation_ | **not directly.** Ruling below                                                                                                                                           |
| `Proxy`                                         | via `getPrototypeOf`/`setPrototypeOf` traps                                             | trap-governed                                                                                                                                                            |
| host externref (gc lane)                        | host object                                                                             | host-governed                                                                                                                                                            |

**Closed-struct ruling:** a closed struct has no proto slot; full per-object
mutability requires the object to be **represented dynamically**. The
correct lever is representation demotion — if the program applies
`Object.setPrototypeOf`/`__proto__`-write to values of a closed-struct
type, that type's allocations demote to `$Object`-backed dynamic
representation. That is exactly the **#2949 IR dynamic-value-representation
lever** (and the #2580 value-rep substrate) — do NOT build a side-table
hack here. Sequencing: until #2949's demotion exists, `setPrototypeOf` on a
provably-closed-struct receiver keeps current behavior (host lane: works —
host object; standalone: routes to `__object_setPrototypeOf`, which
requires `$Object` and misses). This spec defines the **target contract**;
the closed-struct arm is marked _sequenced-behind-#2949_, not a slice here.

**Identity (#2585):** the chain representation is identity-correct —
`$proto` holds the same GC ref, `__getPrototypeOf` returns it. What loses
identity is the tag-5 `===` classifier, folded into **#2626** behind the
value-rep substrate. **Do not re-attempt inside this umbrella** (it ejected
the merge_group once, −162). Pointer only.

### 2.2 Distinct native prototype for externref-backed builtin subclasses (#3013 Cluster B) **[FABLE design ratified here; execution OPUS]**

The banked #3013-B finding: `emitSetSubclassProto`
(`class-bodies.ts:418`) is a standalone **no-op** (needs the
`__set_subclass_proto` host import), and an externref-backed
`class X extends Object/Error/…` has **no distinct prototype object** —
`X.prototype`, `Object.prototype`, and `getPrototypeOf(new X())` all
collapse. Spec (the follow-up #3013 asked for):

- Per externref-backed subclass `X`, lazily materialize a singleton
  **`__proto_obj_X`**: a plain `$Object` (via `__new_plain_object`) whose
  own `$proto` = the parent's prototype object — the parent builtin's
  `$NativeProto` singleton (#2175 `emitLazyNativeProtoGet(parentBrand)`)
  or `%Object.prototype%`'s singleton for `extends Object`. Same
  lazy-global pattern as #3006 `emitBuiltinConstructorIdentity` / #2175
  `__native_proto_<Brand>`.
- **Three consumers, one singleton** (the #3013 unification requirement):
  1. `X.prototype` value-read → `__proto_obj_X`;
  2. construction: replace the `emitSetSubclassProto` standalone no-op
     with native `__object_setPrototypeOf(self, __proto_obj_X)` (and for
     `extends Object`, route `super()` from the `__new_Object` host import
     to `__new_plain_object` — §20.1.1.1, NewTarget ≠ Object ignores args);
  3. `Object.getPrototypeOf(instance)` → reads `$Object.$proto` (already
     native) → gets the same singleton.
- This flips the 5 `__new_Object` leaky passes host-free **without**
  regressing `regular-subclassing.js` (the exact regression that blocked
  the naive fix). Cross-subclass risk: `emitSetSubclassProto` is shared by
  `extends Error/DataView/…` — validate the whole subclass-of-builtin
  matrix; full merge_group gate.
- `$NativeProto.$ctor`/`$parent` population (null-init in #2175 S1) lands
  with this slice for the brands it touches: `.constructor` identity and
  `getPrototypeOf(<builtin>.prototype)` chain-walk termination at
  `%Object.prototype%`.

### 2.3 `__proto__` + `Object.create` wiring **[OPUS]**

Per Annex B §B.2.2.1 + §20.1.2.2, standalone lane (host lane defers to the
host):

- **Literal `{ __proto__: p }`** — [[Prototype]] at creation: after the
  object-or-null filter, write `$proto` directly in the literal's
  `struct.new $Object` / post-alloc set. NOT a dirty-flag trigger (creation,
  not mutation) and NOT an own-property define. (`{ ["__proto__"]: p }`
  computed form IS an own define — keep the distinction.)
- **Read `o.__proto__`** → `__getPrototypeOf(o)` (getter semantics).
- **Write `o.__proto__ = p`** → `__object_setPrototypeOf` with the
  object-or-null filter: primitive `p` → silently return (the setter's
  early return, NOT a throw); non-object receiver → per §B.2.2.1
  ToObject/TypeError shape. Marks dirty per §0.3.
- **`Object.create(p)`** exists (`__object_create`); confirm
  `Object.create(null)` yields `$proto = null` and that `__chain_lookup`
  / `in` / for-in terminate on the null link **without** consulting
  `%Object.prototype%` (a null-proto object has no `toString`, no
  `hasOwnProperty` — add equivalence tests for miss-on-null-proto).
- **Mutation visibility** — no caching layer exists on the dynamic read
  path today, and §0.2 keeps it that way: every dynamic lookup re-walks
  from the receiver, so `setPrototypeOf` is visible on the next lookup by
  construction. The only visibility hazard is the _static_ fast path,
  handled by §0.3's dirty demotion.

---

## Part 3 — `with`: scope objects over the same ladder

### 3.1 State (from #3025's banked measure-first, re-confirmed)

- **Tier-1 static** (`proveObjectLiteralWithTarget` →
  `compileClosedObjectLiteralTarget`, `src/codegen/with-scope.ts`): works
  for proven object-literal targets. The closed-shape **CE is already
  resolved** (#2663 Tier-2 routes non-proven targets dynamically; 0 CEs on
  current main across all 181 `language/statements/with` files).
- **Tier-2 dynamic** (`compileDynamicWithStatement`, `with-scope.ts:244`;
  HasBinding via `__extern_has` + `emitDynamicWithGet`): correct for host
  objects / `$Object`s, but **fails on WasmGC-struct targets** — a struct
  wrapped `extern.convert_any` is opaque to host `in`/get reflection, so
  every own field misses → bare-global fallback → ReferenceError. ~55-file
  dominant bucket; same struct-visibility family as #3027.

### 3.2 Ruling on the two banked fix directions: **both, ordered, different owners** **[FABLE ruling]**

1. **Primary near-term [OPUS]: extend Tier-1 to closed-struct-typed
   targets.** When the `with` target's static type `resolveStructName`s to
   a provably-closed struct, compile the target into a struct-typed local
   and push a `static` `WithScope` (direct struct get/set), exactly as the
   literal path does. Soundness gates (all → fall through to Tier-2, never
   CE): (a) the body references an identifier that is not a struct field
   but IS an inherited `Object.prototype` key (`toString`, `valueOf`,
   `hasOwnProperty`, `constructor`, …) — the static scope can't see
   inherited bindings; (b) the static type is a widened supertype whose
   runtime value may carry extra own fields; (c) the type is `any`/union/
   Proxy-shaped. Touch points: `proveObjectLiteralWithTarget` /
   `compileWithStatement` / `compileClosedObjectLiteralTarget`. Bounded,
   no substrate dependency, ~55 files.
2. **Substrate [owned by #3027, NOT here]: teach the dynamic reader to see
   closed-struct fields.** The Tier-2 gap is _exactly_ #3027's
   `$Object`-dynamic-reader gap (and #2580's family). Ruling: **no
   with-local struct-reflection hack** — when the #3027 shape-table reader
   lands, Tier-2 inherits it for free because it already routes through
   `__extern_has`/the dynamic getter. `with` is a _consumer_ of that
   substrate, never a second implementation.

**Which wins at a given site:** Tier-1 whenever provable (faster,
substrate-free); Tier-2 is the semantic backstop and the only correct
route for `any`-typed, host, Proxy, mutated-chain, or unprovable targets.
The Tier-1 gates must be conservative — a wrong static claim is a
soundness bug; a fall-through is only a perf/coverage loss.

### 3.3 Unscopables + error-propagation tail **[OPUS]**

- `Symbol.unscopables` (§9.1.1.2.1 HasBinding steps 4–6) belongs in the
  **shared HasBinding surface**, not per-tier: after the `has` gate
  succeeds, read `Get(obj, @@unscopables)`; if it is an object and
  `ToBoolean(Get(unscopables, name))` is true, the binding is skipped.
  Implement once where `__with_has_binding`/`__extern_has` is consumed by
  the with path (both tiers route through it — Tier-1 targets are proven
  literal/closed shapes, which cannot carry `@@unscopables`, so Tier-1 may
  statically skip the check when no symbol-keyed member exists — document
  that proof).
- Abrupt completions from the `has`/`get` steps (`unscopables-prop-get-err
.js`, `has-property-err.js`) must **propagate**, not be swallowed into
  the miss arm — audit `emitDynamicWithGet`'s fallback select for a
  catch-all that eats throws.

### 3.4 Compile-path / interpreter-path split (coordination contract with #2929 / the fable-interp-spec peer) **[FABLE ruling — reconcile with the peer's spec when it lands]**

#2929 §2 claims `with` as an interpreter object-environment-record and says
"this is where it exits the IR deferred bucket". #3025's measurement shows
the **compile path already handles most of the `with` lane**. Ruling:

- **The compile path owns `with` occurring in compiled TS source.**
  Tier-1 + Tier-2 as above. `with` does NOT demote a compiled function to
  the interpreter — demotion would regress the majority of the lane that
  already passes and couple `with` to the interpreter's (XL-horizon)
  delivery.
- **The interpreter owns `with` occurring inside interpreted code** —
  direct-eval bodies, `Function`-constructor bodies (#2929 §1/§2's
  object-environment-record on the reified `$EnvRecord` chain). That is
  its natural, unavoidable scope: compiled code cannot see into eval text.
- **The shared piece is the MOP surface, and it is single-sourced:** the
  interpreter's object-environment-record HasBinding/Get/Set and the
  compile path's Tier-2 both call the §0.1 front-guarded helpers (this is
  precisely #2929 §3's "reusable `$Object`-level MOP primitives" — that
  section already mandates convergence with #1355; this spec is the
  compile-path counterpart). The @@unscopables filter (§3.3) lives in that
  shared surface so both consumers inherit it.
- **IR note:** `with` stays in the IR `deferred-feature` bucket for the IR
  _front-end_ (the direct-AST path owns it) — the bucket exit #2929
  mentions applies to interpreted code, not to a claim over compiled
  `with`. If the peer's interpreter spec rules otherwise, reconcile before
  either implements: one owner per execution context, one MOP surface.

---

## Slice table (dispatchable units, tier + sequencing)

| Slice                                                                        | Tier                                                              | Depends on                                          | Files (primary)                                                                        | Gate                                                                                    |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------- | --------------------------------------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| **K1** inbound arg-marshalling keystone (2623-A)                             | FABLE                                                             | check #56 state first                               | `src/codegen/index.ts` (buildArgConversion, externToClosureParamRef), `src/runtime.ts` | full merge_group; host `Proxy/{apply,construct}` rows; hot-callback no-regression       |
| K1b host construct guard + constructable-forwarder (prototyped in #2618)     | OPUS                                                              | K1                                                  | `new-super.ts`, `calls.ts`, `runtime.ts`                                               | host `construct/*` non-realm                                                            |
| **K2** standalone `__construct_dispatch` + construct trap                    | FABLE                                                             | — (composes with K1 conceptually, independent code) | `object-runtime.ts`, `new-super.ts`                                                    | standalone `Proxy/construct/*`; `apply/*` via TRAP_APPLY                                |
| P3 `Proxy.revocable` standalone (S0)                                         | OPUS                                                              | —                                                   | `object-runtime.ts`, `calls.ts`                                                        | `revocable/**` (~14 CEs)                                                                |
| P4 standalone `Reflect.*` wiring (S1)                                        | OPUS                                                              | K2 for `Reflect.construct`; else —                  | `calls.ts`                                                                             | `built-ins/Reflect` standalone CE bucket                                                |
| P5 §10.5 invariants + descriptor bits (G)                                    | FABLE (bit-model ruling w/ #1460/#1462 owner) + OPUS (predicates) | #797/#1460/#1462 coordination                       | `object-runtime.ts`, `registry/proxy.ts`                                               | `Proxy/**` invariant rows                                                               |
| **C1** `__chain_lookup` walker + refactor for-in/`in`/getPrototypeOf onto it | FABLE (contract) / OPUS (refactor)                                | —                                                   | `object-runtime.ts`                                                                    | miss-through-chain, null-proto, Proxy-in-chain equivalence tests                        |
| C2 per-brand MOP-dirty demotion (§0.3)                                       | FABLE                                                             | C1, #2175 S1                                        | `property-access.ts`, `native-proto.ts`                                                | builtin-proto-member-overwrite tests; clean programs byte-identical                     |
| C3 distinct native proto per externref subclass (#3013-B)                    | OPUS (design ratified in §2.2)                                    | #2175 S1; C1 helpful                                | `class-bodies.ts`, `array-object-proto.ts` pattern                                     | `regular-subclassing.js` + `__new_Object` cluster host-free; subclass-of-builtin matrix |
| C4 `__proto__` literal/read/write + `Object.create(null)` termination        | OPUS                                                              | C1                                                  | `property-access.ts`, `object-runtime.ts`, `expressions.ts`                            | annexB `__proto__` + `Object/create` rows                                               |
| **W1** Tier-1 `with` over closed-struct targets                              | OPUS                                                              | —                                                   | `with-scope.ts`                                                                        | ~55-file struct-target bucket in `language/statements/with`; soundness fall-throughs    |
| W2 @@unscopables + abrupt propagation in shared HasBinding                   | OPUS                                                              | —                                                   | `with-scope.ts`, `object-runtime.ts`                                                   | `unscopables-*`, `has-property-err.js`                                                  |
| W3 `with (proxy)` verification (should be free)                              | OPUS                                                              | K2/P-slices as they land                            | tests only                                                                             | `*-using-with.js` twins                                                                 |
| — closed-struct setPrototypeOf demotion                                      | (sequenced behind **#2949**; not a slice here)                    | #2949/#2580                                         | —                                                                                      | —                                                                                       |
| — tag-5 identity                                                             | (owned by **#2626**; do not touch)                                | value-rep substrate                                 | —                                                                                      | —                                                                                       |

**Suggested order:** K1 → K1b (host Proxy lane closes) ∥ W1+W2 (independent,
bounded) ∥ C1 → {C3, C4, K2} → P3/P4 → C2 → P5. K1 and C1 are the two
schedule-critical Fable slices; everything else fans out.

## Conflict / risk notes

- **#56 (sd-1838 call/construct rework)** overlaps K1/K1b/K2 loci
  (`calls.ts`, `new-super.ts`, `index.ts` dispatchers). Claim-check and
  coordinate before starting K1; if #56 landed, re-ground line anchors.
- **#2580/#2949 value-rep** owns representation demotion; this spec
  deliberately defers the closed-struct mutable-proto arm to it.
- **`$ProxyTraps` field order is append-only** (12 fields today;
  `construct` = 13). Never renumber.
- **Byte-identical discipline** (from #2175 S0): every slice must keep the
  static fast path and existing front-guarded helpers byte-identical for
  programs that don't use the new capability; C2's dirty demotion must be
  provably inert on clean programs.
- The host lane gets §10.5 invariants free from the engine; every
  standalone invariant slice must be `ctx.standalone`-gated so gc stays
  byte-inert (the #1355 slice-F pattern).

## Re-verification (fable-arch, 2026-07-09 @ origin/main 928c85179)

State advances since this spec was written — re-ground before dispatching:

1. **P5's descriptor-bit dependency is SATISFIED.** `$PropEntry.$flags`
   (writable/enumerable/configurable bits + internal-slot marker) exists
   (`object-runtime.ts:90`), and native defineProperty already enforces the
   non-configurable redefine TypeErrors (`object-runtime.ts:4988-5035`).
   The §10.5 result-invariant predicates (P5) are now executable without
   waiting on #797/#1460/#1462 — coordinate only with #2042's in-progress
   descriptor work.
2. **NEW GATE ahead of every P-slice: #3099.** Probe-verified: standalone
   Proxy traps written in **method-shorthand** style (`{ get(t,k){…} }`,
   test262's dominant shape) silently forward — the any-context object
   literal never materializes shorthand methods as runtime own properties
   on `$Object`, so `__proxy_create`'s trap read misses. Arrow-property
   handlers fire correctly. Land #3099 FIRST, then re-measure standalone
   Proxy before scoping K2/P3/P4/P5 — current standalone Proxy numbers
   understate the substrate.
3. Confirmed still open: `$ProxyTraps` has 12 fields, no `construct` (K2);
   `Proxy.revocable` standalone is a CE (P3); `Reflect.construct`/
   `Reflect.getPrototypeOf`-on-proxy standalone CE/trap (P4). K1's locus
   (inbound arg-marshalling) is adjacent to the in-flight #3087 (dynamic
   `new` on the gc lane) — claim-check #3087's branch before starting K1.

## Apply slice — LANDED (fable-3031, 2026-07-09)

**Scope**: the standalone `apply`-trap / dynamic-apply slice (the #3099
follow-up: the 12th dark trap). K1 (host lane), K2 (construct), P3/P4/P5 and
Parts 2–3 remain open — this umbrella issue stays `ready`.

### What was actually broken (verify-first findings — the spec's "K1/K2" framing was partly off for this lane)

The standalone `p(...)`-on-`any`-callee path (`tryEmitInlineDynamicCall`,
`src/codegen/expressions/calls.ts`) had **three stacked defects**, only the
third of which is the trap-dispatch gap the spec describes:

1. **Stale captured helper indices → invalid Wasm** (why BOTH handler shapes
   "emit invalid Wasm" per #3099's handoff): `__box_number`/`__unbox_number`
   funcIdx were captured BEFORE `ensureLateImport("__get_undefined")` inserted
   a real import; `flushLateImportShifts` repaired `funcMap` + emitted bodies
   but NOT the captured locals, so every dispatch arm baked `call <box−1>` —
   which lands on `__str_to_number` — and the module failed validation
   (`call[0] expected externref, found call_ref of type f64`). The
   stack-balance repair pass then *appended* a real `call __box_number` to fix
   the arm's block-result type, masking the shape further. **Fix**: capture
   AFTER the flush. (Host lane was immune: box/unbox are imports there, and
   import indices don't shift on later import appends.)
2. **`env.__get_undefined` host-import leak**: the arity-pad path called
   `ensureLateImport` directly, bypassing `ensureGetUndefined`'s
   `nativeStrings` gate — every padded standalone module demanded an env
   import and was un-instantiable host-free. **Fix**: resolve the pad exactly
   like `emitUndefined` (host import on host lane; #2106 S1 singleton or
   `ref.null.extern` standalone).
3. **No Proxy arm anywhere on the [[Call]] surface.** Fixed per the §0.1
   front-guard ruling, three pieces:
   - `__proxy_apply_dispatch(proxy, thisArg, argsVec)` native
     (`object-runtime.ts`, §10.5.12): revoked → TypeError; `apply` trap
     (field 3, wired at `__proxy_create` since #1100 but never dispatched) →
     `Call(trap, handler, «target, thisArgument, argArray»)` via the new
     reserved `__proxy_call_apply` driver (filled at FINALIZE →
     `__call_fn_method_3`, same reserve-then-fill as the other 11); trap
     absent → forward `Call(target, thisArg, args)` through `__apply_closure`.
   - **$Proxy front-guard on `__apply_closure`** (fillApplyClosure) — the
     bridge is a MOP entry point ([[Call]]), so EVERY consumer (method calls
     on open receivers, a proxy installed as another proxy's trap,
     groupBy/accessor drivers) intercepts proxy callees for free, and
     proxy-of-proxy chains unwrap one guard hop at a time (no self-recursion
     needed in the dispatch).
   - **OUTERMOST `ref.test $Proxy` arm** at the inline dynamic-call site,
     gated `ctx.standalone` AND (funcMap has `__proxy_create` OR a per-file
     syntactic `new Proxy`/`Proxy.revocable` scan — the funcMap check alone
     misses same-file call-before-creation compile order, the #2754 class).
     Proxy-free programs never grow the arm.

### Validation (PR #2815 — branch `issue-3031-proxy-apply-trap`)

- **12/12 method-shorthand handler traps fire** (was 11/12 after #3099);
  arrow-property parity too.
- Trap semantics probed: argArray `.length`/indexing, target-callable-in-trap,
  thisArg === undefined, absent-trap forward, proxy-of-proxy, proxy-as-method
  (`o.m(…)` where `m` is a proxy — the front-guard path). All pass;
  `tests/issue-3031-proxy-apply.test.ts` (11 cases) pins them.
- **prove-emit-identity**: gc lane byte-identical across the whole corpus
  (33/39 identical); 6 standalone/wasi drifts are the additive
  `__proxy_apply_dispatch` + driver + front-guard growth in modules already
  carrying the (unconditionally-registered) proxy runtime — same import sets,
  all valid, consistent with how `__extern_get`'s guards keep the other 11
  dispatchers live.
- **Scoped test262 `built-ins/Proxy` standalone**: 67 pass / 53 CE → 67 pass /
  50 CE, **zero pass→fail regressions**; the 3 flips are `*-realm.js` CE→fail
  (the documented `$262.createRealm` deferral — now they compile).

### Boundary — measured next levers for the dynamic-apply surface

- **`.call`/`.apply` on ANY dynamic callable** — `f.call(...)` on a bare
  `any`-typed closure silently returns undefined on main (pre-existing,
  NOT proxy-specific; `__extern_method_call` answers only `$Object`
  receivers and no Function.prototype MOP exists for callable values).
  8 of the 14 `built-ins/Proxy/apply/*` rows hinge on exactly this. This is
  the highest-leverage NEXT sub-slice of the dynamic-apply surface — fix it
  generally (Function.prototype.call/apply/bind on the callable-classifier
  arm, cf. #3098's spine), not proxy-only.
- **Dynamic-call result → declared-`string` coercion** — pre-existing
  ("Cannot convert object to primitive value" for bare closures too); the
  trap's string RESULT is fine when consumed as `any`.
- **Present-but-non-callable trap TypeError** (`trap-is-not-callable.js`) —
  slice G / §1.6, unchanged.
- **`*-realm.js`** — `$262.createRealm`, deferred as documented.
- K1 (host-lane inbound marshalling), K2 (`construct` + `$ProxyTraps` field
  13), P3 (revocable — still CE "#1472 Phase C"), P4 (Reflect.*), P5
  (invariants): open, unchanged by this slice.
