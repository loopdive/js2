---
id: 1674
title: "GetSetRecord set-like consumption: .size NaN, coercion count, has/keys callable checks"
status: blocked
escalation: needs-architect-spec
created: 2026-05-27
updated: 2026-05-27
verified: 2026-05-27
priority: low
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: runtime
language_feature: set
goal: spec-completeness
sprint: Backlog
parent: 1675
---
# #1674 — GetSetRecord set-like consumption residuals

Split from #1675 (built-ins/Set investigation). ~53 fails in `built-ins/Set`,
all in the new Set methods' handling of an arbitrary **set-like argument**
(ES2025 §24.2.5.x `GetSetRecord`).

**Do NOT touch the `intent.className === "Set"` bridge in `src/runtime.ts`
(~line 2952)** — that bridge is correct (#1352/#1646). These residuals are in
the `GetSetRecord` shim that reads `size`/`has`/`keys` off the host argument.

## Buckets (current main 383ec0c6e)

| Cluster | ~count | Symptom | Likely cause |
|---------|--------|---------|--------------|
| `.size property is NaN` | ~17 | `set-like-array`, `set-like-class`, `allows-set-like-class` | the user `size` data-prop/getter isn't read + `ToNumber`-coerced before use |
| coercion count (`size-is-a-number`) | ~6 | `returned 5 @ L54` | `.size` read a wrong number of times; spec requires exactly one `Get(obj,"size")` + one `ToNumber` |
| `has`/`keys` not callable must throw (`has-is-callable`, `keys-is-callable`) | ~9 | `returned 3 @ assert#2 assert.throws(TypeError)` | when `.has`/`.keys` is not callable, GetSetRecord must throw TypeError; we don't |
| `string "has" is not a function` (`set-like-class-mutation`) | ~4 | runtime | method lookup returns a string instead of the function on set-like class instances |
| plain `Set.size` wrong (`returns-count-of-present-values`, `bigint-number-same-value`) | ~4 | `s.size` wrong after mixed inserts | size accounting / bigint-vs-number SameValueZero keying |

Out of scope: `proto-from-ctor-realm.js` (`$262 is not defined` — no realm host),
`is-a-constructor.js`, `prototype-of-set.js`, `prototype/forEach/this-arg-explicit.js`
(separate single-test causes).

## Direction

Implement `GetSetRecord(obj)` per spec: `Get(obj,"size")` once → if undefined
throw TypeError → `ToNumber` (NaN throws) → `Get(obj,"has")` must be callable
(else TypeError) → `Get(obj,"keys")` must be callable (else TypeError). Cache
the three reads in the record; the algorithm reads each exactly once. Then the
union/intersection/etc. drivers consume `record.has`/`record.keys` rather than
re-reading off the live object.

## Acceptance

- `.size NaN`, coercion-count, and has/keys-callable clusters pass.
- `built-ins/Set` pass-rate ≥ 90% (345/383).
- No change to the `intent.className === "Set"` bridge.

## Investigation 2026-05-27 (dev-1604) — real cause is the `_wrapForHost` proxy method/accessor dispatch (shared with #1364b)

The original framing ("implement our own `GetSetRecord`") is slightly off. The
set-method **receiver** (`s1`) is a host-native `Set` (the `Set` ctor + `.union`
are extern imports), so V8's *own* GetSetRecord runs. The bug is that the
set-like **argument** is consumed through `_wrapForHost`, and that proxy does
NOT faithfully expose a wasm **class instance's** accessor / method properties:

- `allows-set-like-class.js` / `set-like-class.js`: `s2 = new class { get size(){return 2} has(){…} *keys(){…} }` compiles to a wasm struct. At `src/runtime.ts:3139` the extern-method path wraps it: `_wrapForHost(s2, exports)`. V8's union then does `Get(proxy,"size")` / `Get(proxy,"has")` / `Get(proxy,"keys")`.
  - `get size` → the proxy `get` trap has no path to invoke the wasm `__sget_size` **accessor** (it only knows data-field `__sget_*`), so `size` comes back `undefined` → `ToNumber` → **NaN** (the `.size NaN` bucket, ~17).
  - `has` / `keys` → the proxy `get` trap returns `_getProtoMethodBridge(...)` (runtime.ts:2049), a placeholder that **throws** `"calling user-class method via JS-side prototype access is not yet supported (#1364b)"`. Hence `"has"/"keys" is not a function` / wrong-callable failures.
- `set-like-array.js`: `s2 = [5,6]` with own `size/has/keys` data props is a plain JS array (not a wasm struct), passes through unwrapped, and V8 handles it — that sub-case is fine; the failures are the **wasm-class-instance** set-likes.

**Conclusion:** the load-bearing fix is making `_wrapForHost`'s `get` trap (a)
invoke wasm **accessor getters** (`get size`) and (b) return a real callable
bridge for wasm **instance methods** (`has`, `keys`) that actually dispatches
into the compiled method — i.e. the deferred **#1364b** "call user-class method
via JS-side proxy" capability. That is a shared proxy-dispatch foundation, not a
localized GetSetRecord shim, and is larger than the `feasibility: medium`
estimate. The `keys()` generator must also return a real iterator the host can
drive (overlaps the iterator-bridge work #1320/#1620).

**Recommendation:** re-scope #1674 to depend on / fold into the #1364b proxy
method+accessor dispatch (and the iterator bridge for `keys`), or route to an
architect for a joint `_wrapForHost`-class-instance spec. The `intent.className
=== "Set"` bridge stays untouched (correct per the issue).

### The clusters split across THREE distinct deep gaps (not one shim)

Verified per-test on main 2026-05-27:

1. **wasm class-instance set-like** (`allows-set-like-class`, `set-like-class`):
   needs `_wrapForHost` to dispatch wasm accessor getters + instance methods →
   **#1364b** proxy method/accessor dispatch + iterator bridge for `keys`.
2. **plain-array set-like** (`set-like-array.js`): `s2 = [5,6]; s2.size=3;
   s2.has=fn; s2.keys=fn` — `.size` reads back **NaN**. The array compiles to a
   wasm `number[]`/array struct that does NOT retain dynamically-added
   non-index properties (`size`/`has`/`keys`), so they're lost. A separate
   **wasm-array-arbitrary-property-retention** gap, not GetSetRecord.
3. **plain-object set-like is already correct** (`allows-set-like-object`,
   `called-with-object`, `has-is-callable`, `keys-is-callable` all PASS) — V8's
   native GetSetRecord runs against the unwrapped plain object fine. So the
   "implement our own GetSetRecord" framing would regress these.

Because the residuals decompose into #1364b (proxy dispatch) + a wasm-array
property-retention gap — two cross-cutting representation features — this is
**not** a single localized runtime fix. Marked `status: blocked`,
`escalation: needs-architect-spec`. No code changed; the `intent.className ===
"Set"` bridge is untouched.

## Re-verification 2026-05-27 (dev-1605)

Independently re-ran the representative union set-like tests through
`runTest262File` on current main. Confirms dev-1604's three-way decomposition
and, crucially, that **implementing our own GetSetRecord would regress
currently-passing tests**:

| test (`union/…`) | result on main | gap |
|------------------|----------------|-----|
| `has-is-callable.js` | **PASS** | plain-object → native V8 GetSetRecord |
| `keys-is-callable.js` | **PASS** | plain-object → native V8 GetSetRecord |
| `allows-set-like-object.js` | **PASS** | plain-object → native V8 GetSetRecord |
| `size-is-a-number.js` | FAIL | `returned 5 \| assert #4 L54: assert.sameValue(coercionCalls, 1)` — asserts #1–#3 (size undefined/NaN/valueOf→NaN all throw TypeError) PASS; the **valueOf coercion-count** sub-assert fails. The `s2.size = {valueOf(){++coercionCalls; return NaN}}` mutation + the `coercionCalls` closure read-back is not observed as exactly 1 — an object-mutation / closure-observation gap, not the GetSetRecord shim |
| `set-like-array.js` | FAIL | plain-array drops dynamically-added `size`/`has`/`keys` props (wasm-array arbitrary-property retention) |
| `allows-set-like-class.js` | FAIL | wasm class-instance accessor/method dispatch through `_wrapForHost` proxy → **#1364b** |

So the has/keys-callable cluster the task summary lists is **already green** via
native V8; the live residuals are (a) #1364b proxy dispatch, (b) wasm-array
property retention, (c) the valueOf-coercion-count observation in
`size-is-a-number`. None is a localized GetSetRecord shim, and adding one risks
regressing the three passing plain-object tests. Confirmed `status: blocked` /
`escalation: needs-architect-spec`; the `intent.className === "Set"` bridge
stays untouched.
