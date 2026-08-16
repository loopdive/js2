---
id: 4491
title: "ES5 standalone: Object.defineProperty/defineProperties/create residual (90 tests) — descriptor MOP semantics on the dynamic object runtime"
status: ready
sprint: current
created: 2026-08-15
updated: 2026-08-15
assignee: claude/es6-standalone-session
priority: high
horizon: m
feasibility: medium
task_type: conformance
area: codegen
es_edition: es5
goal: standalone-mode
related: [4444, 3031, 4490]
---

# #4491 — ES5 defineProperty/defineProperties/create MOP residual

## Problem (measured 2026-08-15, `.tmp/es5-standalone-clusters.ts`, fresh baseline)

ES5 standalone stands at 8,386/9,029 (92.9%), 643 non-passing. The single
largest family is the property-descriptor MOP: `built-ins/Object/
defineProperty` (52) + `defineProperties` (26) + `create` (12) = **90 tests**.

Symptom mix (top): silent no-op defines (`result !== true`, `Expected "a ===
10", actually 0`), accessor descriptors not taking effect (`foo value should
be undefined`), index-keyed defines landing wrong (`Expected obj[0] to equal
0, actually null`), `Object.create(proto, props)` second-arg families, 3
`__module_init` null derefs.

## FALSIFIED HYPOTHESIS (kept visible per lane convention)

The plan below was built by mining error TEXT, not by verifying tests. Its
symptom list and its sub-bucket table did **not** survive contact — see
"Measured triage" after it. Kept so the next reader can see what was tried.

## Implementation Plan (fable, 2026-08-15) — triage-first

1. **Sub-bucket by MOP operation before coding** (mandatory table in this
   file): (a) data-descriptor writes on dyn objects, (b) ACCESSOR descriptors
   (get/set installation + invocation), (c) attribute enforcement
   (writable:false silently ignored? configurable transitions?), (d)
   index-keyed properties on vec-backed arrays, (e) `Object.create` props-arg,
   (f) the 3 null-deref crashes (fix first — crashes before semantics).
2. The dynamic object runtime (`src/stdlib/object-runtime.ts`,
   `__defineProperty_value` — note #2175's S3b-1 just touched materialization
   ordering vs `__defineProperty_value`, coordinate with the reflection lane's
   in-flight worktree) already has descriptor machinery; expect the residual
   to be missing arms (accessor install on specific carriers, attribute
   checks on define-over-existing) rather than a missing subsystem.
3. Fix largest bounded sub-buckets first; each with unit tests; A/B file-copy
   baselines; zero pass→non-pass on the scoped filter.

## Measured triage (generators lane, 2026-08-15)

**Source**: the shared full standalone baseline
`.test262-cache/test262-standalone-current.jsonl` (mtime 2026-08-15 20:21Z, 1.2 h
old at extraction), filtered to the plan's own scope. A dedicated scoped run was
started and **abandoned** — at the observed ~60 s/test under three-lane load,
2083 files is hours, and the shared baseline covers the identical file set. The
baseline is one other lane's run against integrated main, which is the right
reference for triage (main's state, not my worktree's).

**Scope totals: 2083 files, 1983 pass, 100 non-passing** (99 fail + 1 CE) —
`defineProperty` 59, `defineProperties` 29, `create` 12. Close to the plan's 90;
the delta is snapshot drift, not a different population.

### Step 0 — the plan's symptoms do not reproduce

One minimal standalone program per sub-bucket in the plan's list. **All ten
pass, host-free, zero imports** — including the two named as top symptoms:

| probe                                             | result |
| ------------------------------------------------- | ------ |
| data define; returns obj; value reads back        | pass   |
| accessor `get` installs **and invokes**           | pass   |
| accessor `set` installs **and invokes**           | pass   |
| `writable:false` blocks a later write             | pass (throws TypeError — correct, see below) |
| `enumerable:false` hidden from `for-in`           | pass   |
| `configurable:false` redefine throws              | pass   |
| index-keyed define on an array (`a[0] === 42`)    | pass   |
| `Object.create(proto, props)`                     | pass   |
| `Object.defineProperties` two data props          | pass   |
| `getOwnPropertyDescriptor` round-trip (all 4 attrs) | pass |

`writable:false` first looked like a real hit — a wasm exception. That was the
PROBE's fault: it had no `try`/`catch`, and a compiled module is always strict,
where that write MUST throw. With the catch it is a proper catchable TypeError,
matching Node. Recorded so the false positive is not re-derived.

**Consequently the source comment in `src/codegen/object-runtime.ts` calling
`__defineProperty_accessor` / `__getOwnPropertyDescriptor` "RUNTIME-LAYER
GROUNDWORK … not yet reached end-to-end under standalone" is STALE** — both are
reached and both work. Fix that comment in the first slice that touches the file.

### Step 1 — measured sub-buckets (classified from test SOURCE, not error text)

| bucket                                              | n  | status |
| ---------------------------------------------------- | -: | ------ |
| D array index at/above the 2^32 boundary             | 26 | **reproduced** |
| Q `defineProperties` descriptor-map edges            | 18 | unprobed |
| R `Object.create` edges                              | 13 | unprobed |
| B accessor descriptor round-trip (non-trivial)       | 12 | unprobed |
| H still unclassified                                 | 11 | — |
| P1 define ACCESSOR on a **builtin prototype**        |  7 | **reproduced** |
| E symbol-keyed define                                |  5 | unprobed |
| F crash — `__module_init` null deref                 |  3 | fix first |
| P2 define DATA prop on a **builtin prototype**       |  3 | **reproduced** |
| OUT Proxy / TypedArray-RAB / DOM global              |  4 | out of lane |

**The plan had no category for P1/P2 at all**, and they are the cleanest
reproductions:

- **P1** — `Object.defineProperty(Array.prototype, "prop", {get, set})`, then
  `a.prop` reads correctly but `a.prop = v` **does not run the setter**.
- **P2** — `Object.defineProperty(Date.prototype, "prop", {value})`, then
  `d.prop = 1002` reads back 1002 but `d.hasOwnProperty("prop")` is **false**:
  the assignment never created an own property on the instance.
  These overlap #2175's builtin-prototype territory — coordinate before coding.

- **D is NOT "length/index coupling"**, which works: index define extends
  `length` (index 5 → length 6; index 1000 → length 1001), a `length` shrink
  deletes higher indices, and an ACCESSOR at index `"0"` installs and invokes.
  What fails is the **boundary**: at index `4294967294` the property is created
  but `length` does not become `4294967295` and the element does not read back;
  at `4294967295` (not an array index) the ordinary string-keyed property is not
  created. Smells like an i32/u32 truncation in the index path — bounded, and
  the largest single target.

**Recommended order**: F (3 crashes) → D boundary → P1/P2 with #2175 (10).

### Step 2 — F verified: REAL crashes, not failure-path artifacts

Decisive test: strip the asserts. If the crash survives, it is on the success
path. It does.

- `create/15.2.3.5-4-{165,191}.js` — **real, success-path crash**, narrowed to
  `Object.create(proto, { prop: <constructor instance> })`. Controls isolate it
  tightly: the same call with an object-LITERAL descriptor works, and
  `Object.defineProperty(o, "p", <constructor instance>)` works. So it is
  `Object.create`'s props-arg reader, not the descriptor reader, and not the
  instance carrier per se. **2 tests.**
- `defineProperty/15.2.3.6-3-123.js` — does NOT reproduce in a module. The test
  is `{ configurable: this }` in a SLOPPY script, where `this` is the global
  object (truthy); in a module `this` is `undefined` (falsy) and the shape
  passes. Different root cause; needs the sloppy-`this` context to study.
  **1 test.**

### Step 3 — D re-scoped: it is not one 26-test bucket

Extracting the index literals each D test actually uses splits it three ways,
and only one part is a bounded, self-contained fix:

| part | n | what it needs |
| ---- | -: | ------------- |
| **D-a** non-index key ≥ 2^32-1 on an ARRAY via `defineProperty` | 8 | self-contained, no representation change |
| **D-b** index in `[2^31, 2^32-2]` | 7 | widen `__obj_index_of_key` i32 → u32 — see below |
| mis-bucketed by my own heuristic | 11 | re-triage |

**D-b is a DOCUMENTED, deliberate approximation, not an unnoticed truncation.**
`vec-index-domain.ts` §1 (#4434) states it outright: "The ceiling stays 2^31-1
rather than the spec's 2^32-2 … the result doubles as a SIGNED sort key for
OrdinaryOwnPropertyKeys ordering. Keys in `[2^31, 2^32-2]` are therefore treated
as ordinary string keys." So the i32/u32 smell is real and the mechanism is
right, but the fix is a representation change with a named downstream consumer —
not a one-line boundary correction. Do not start it as if it were.

**D-a is the bounded slice.** Isolated with four probes:

| probe | result |
| ----- | ------ |
| `defineProperty(arr, "4294967295", …)` | `length` right; `hasOwnProperty` **false**; value unreadable |
| `arr["4294967295"] = 7` (plain assignment) | `length` right; value **readable**; `hasOwnProperty` **false** |
| `defineProperty(arr, "foo", …)` | fully correct |
| `defineProperty(plainObj, "4294967295", …)` | fully correct |

So: ordinary names on arrays work, the same key on a plain object works — only
**array × numeric-non-index via `defineProperty`** fails. A second, adjacent
defect shows up in the assignment control: `hasOwnProperty` does not see the
#4247 expando-bag entry even when the value reads back, which likely accounts
for part of the 8 on its own.

### Step 4 — D-a is THREE defects, not one (key-domain sweep)

Sweeping `Object.defineProperty(a, K, {value:7,…})` over key spellings, then
checking `a.length`, `a.hasOwnProperty(K)` and `a[K]`, separates them. (Earlier
probes used DOT access `a.foo` / a NUMERIC literal `a[5]`, which is why this
only surfaced on the sweep — the read spelling matters.)

| key | length | hasOwnProperty | `a[K]` reads back |
| --- | ------ | -------------- | ----------------- |
| `"foo"`, `"-1"`, `"1.5"`, `"4294967295x"`, `"2147483648"` | ok | ok | **NO** |
| `"4294967295"`, `4294967295`, `"4294967296"` | ok | **NO** | **NO** |
| `"99"` (ordinary index) | ok | ok | **NO** |
| `"2147483647"` (= 2^31-1, a legal index) | — | — | **TRAPS**: "array element access out of bounds" |

1. **Read-path**: a COMPUTED STRING key on an array (`a["foo"]`) does not find
   the property, while DOT access (`a.foo`) does — and the same holds for
   elements (`a["99"]` misses where `a[99]` hits). This gates almost every case
   in the table, including ones whose store already works, so it is the
   load-bearing half of the "visibility" family.
2. **Store-path**: `defineProperty` with a numeric non-index key `>= 2^32-1`
   creates no named property at all (`hasOwnProperty` false).
3. **Trap**: defining a legal but huge index (`2^31-1`) tries to grow the
   backing array to ~2 billion elements and aborts — an uncatchable trap, the
   #4222/#4247 family, still reachable through `defineProperty`.

(3) is a new component, not in the original D-a scope, and it is a hard abort
rather than a wrong answer — split out as **#4498** (allocation policy, blast
radius over every array grow path).

### Step 6 — CORRECTION: the store is NOT lost. Step 5 below was wrong.

Step 5 (kept underneath, struck through in effect) concluded the numeric
non-index define never lands. **Measured, that is false** — the store works and
only READS are blind. On `var a = []; Object.defineProperty(a, "4294967295",
{value:7,w/e/c:true})`:

| query | answer | |
| ----- | ------ | - |
| `Object.getOwnPropertyDescriptor(a, K)` | `{value: 7, …}` | ✅ stored |
| `Object.getOwnPropertyNames(a)` | includes `"4294967295"` | ✅ |
| `"4294967295" in a` | `true` | ✅ |
| `Object.hasOwn(a, K)` | `true` | ✅ |
| `a.hasOwnProperty(K)` | **`false`** | ❌ |
| `Object.prototype.hasOwnProperty.call(a, K)` | **`false`** | ❌ |
| `a[4294967295]` / `a["4294967295"]` | **miss** | ❌ |
| same key on a PLAIN OBJECT | both correct | ✅ control |
| `a.hasOwnProperty("foo")` (ordinary name, array) | `true` | ✅ control |

So the defect is **entirely read-side, and specific to a NUMERIC-LIKE key on a
vec receiver**: ordinary names on the same receiver are fine, the same key on a
plain object is fine, and `Object.hasOwn` — a different native — already answers
correctly on the very receiver `__hasOwnProperty` gets wrong.

**Single target.** A numeric-like key on a vec routes into the INDEXED lane
(that is what `markNumericLikeNamedKey`, #4434, arms it for). For a key that is
canonical-numeric but NOT an array index the parsed index is `-1`, the indexed
lane has nothing, and `__hasOwnProperty` + the element read answer "absent"
instead of falling through to the companion/bag. `Object.hasOwn`, `gOPD` and
`getOwnPropertyNames` already have that fall-through; `__hasOwnProperty` and the
element read do not. Fix = give those two the same fall-through, which is a
strictly narrower change than the store-side one Step 5 proposed.

Corollary for the slice's original framing: component **(2) "the ≥2^32-1 store
path" does not exist as a defect**. The whole D-a slice is component (1).

### Step 5 — where the D-a store is lost (SUPERSEDED by Step 6 above)

The substrate is NOT missing: #3251 built a full standalone array-descriptor
OVERLAY (`vec-overlay.ts`) — each vec receiver targeted by a descriptor op gets
a companion `$Object` that the hard parts delegate to. `defineProperty(arr,
"foo", …)` works through it today.

The define arm (`vec-overlay.ts` ~L1440) does `parseIndex(1, 7)` →
`i = __obj_index_of_key(key)`, then branches on `i >= 0`. A non-index key gets
`-1` and should fall through to the companion's named define — which is exactly
what `"foo"` does. `"4294967295"` also parses to `-1`, yet does **not** land.
The divergence to inspect first is the #4434 note at ~L1682, "canonical-numeric
named key → arm the indexed-lane flag": a numeric-SPELLED key that is not an
array index is steered into the indexed lane, where a key `>= 2^32-1` has no
slot and is dropped. That is the site to fix, not `__obj_index_of_key` (whose
`-1` answer is already correct here — contrast #4497, which is about the
range it answers `-1` for *wrongly*).

**Deliberately OUT of scope for this slice** (recorded, not fixed): a computed
STRING-NAME read on an array, `a["foo"]`, misses the bag while `a.foo` finds it,
because `nonArrayIndexNumericKey` admits only numeric/boolean SPELLINGS. Widening
it to arbitrary names means owning a reserved-name exclusion list — `arr["length"]`,
`arr["push"]`, `arr["constructor"]` must NOT route to the bag, and an incomplete
list silently breaks every borrowed prototype method. The 8 D-a tests do not need
it: they read back with a NUMERIC key (`arrObj[4294967295]`), which the existing
numeric arm already routes. Fixing it blind, unprompted by a test, is how that
hazard would land.

### F residual — module-goal-unreachable

`defineProperty/15.2.3.6-3-123.js` (`{ configurable: this }`) cannot be
reproduced or fixed under the module goal: it depends on SLOPPY-script `this`
being the global object (truthy). Compiled modules are always strict, where
`this` is `undefined` (falsy) and the shape already passes. Not a defect in the
MOP; parked here so it is not re-triaged as one.

## Validation

`TEST262_TARGET=standalone TEST262_PATH_FILTER="built-ins/Object/defineProperty|built-ins/Object/defineProperties|built-ins/Object/create" pnpm run test:262`
— baseline 90 non-pass. gc-lane control on the same filter. Equivalence guard.
