---
id: 5162
title: "A prototype method called from its own constructor traps at runtime — plain numeric callee, all five boolean-ABI lanes, pre-existing"
status: ready
sprint: current
created: 2026-08-28
updated: 2026-08-28
blocked_by: [4405]
priority: medium
horizon: s
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
goal: core-semantics
related: [4406, 4405]
---

# Constructor → own prototype method call traps

Found as a control during #4406 Phase 4 (PR #5171) and verified **unrelated to
that issue**: the failing callee is a plain numeric method, and the trap
reproduces identically on base in all five boolean-ABI lanes
(`JS2WASM_RET_UNBOX_ABI` on/off, `NUMERIC_TWINS=0`, `DIRECT_CALLS=0`,
`NUMERIC_OPERANDS=0`), so no #4406 switch reaches it.

Shape (from the Phase 4 probe set):

```js
function PP(x) { this.v = this.twice(x); }   // calls own prototype method
PP.prototype.twice = function (x) { return x + x; };
new PP(5);                                    // traps at runtime
```

The likely mechanism (unverified — the dispatched fix must establish it): at
the point the constructor body compiles, the prototype assignment has not been
processed, so the method-call lowering resolves against an incomplete
class/prototype view — the same family as #5096's scope-blind `ctx.classSet`,
but for compile-order rather than scope.

First step is a minimal repro matrix: method defined before vs after the
constructor in source order, `class` syntax vs prototype-assignment syntax,
gc vs standalone. That decides whether this is an ordering bug (fixable) or a
structural gap in the fnctor model (then route to the #3521/codex lane and
record — check the ledger before dispatch).

## Acceptance criteria

- The repro matrix measured and recorded; the shape above returns `10` via
  `new PP(5).v`, or the structural verdict is recorded with the owning issue
  cited.
- Byte-identity for constructors that do not call own prototype methods.
- Pinned tests red on base; equivalence shards clean by name.

---

## Repro matrix & verdict — 2026-08-28 (ttraenkler/opus-5162)

**Verdict: (b) structural gap in the fnctor model. NOT an ordering bug — the
filed hypothesis is refuted by measurement.** No source change made; the fix
belongs to the claim point's owner, [#4405](https://js2wasm.loopdive.com/dashboard/issue.html?slug=4405-receiver-type-specialisation),
claimed by `ttraenkler/senior-dev` on `impl-4405-receiver-spec` (read
`origin/issue-assignments` @ `03c23cee3f`, record `4405.json`, `status:
in-progress` since 2026-08-14). Routing is the orchestrator's call.

Everything below is **measured** on base `origin/main` @ `02b050f8f0` unless a
line says *reasoned*.

### The matrix (measured)

All cells run the shape and report `test()`'s value or the throw. Lanes are
`compile(src, {})` (gc / JS host) and `compile(src, { target: "standalone" })`.

| shape | gc `.mjs` | standalone `.mjs` | gc `.ts` | standalone `.ts` |
| --- | --- | --- | --- | --- |
| `PP.prototype.twice =`, method **after** ctor, `new PP(5).v` | 10 | **THROWS** | 10 | **THROWS** |
| `PP.prototype.twice =`, method after ctor, **two-step** | 10 | **THROWS** | 10 | **THROWS** |
| `PP.prototype.twice =`, assignment **before** ctor decl | 10 | **THROWS** | 10 | **THROWS** |
| `var pp = PP.prototype; pp.twice =` (write-once fnctor idiom), after | 10 | **THROWS** | 10 | **THROWS** |
| …same, two-step | 10 | **THROWS** | 10 | **THROWS** |
| …same, before | 10 | **THROWS** | 10 | **THROWS** |
| `class PP { constructor(){…} twice(){…} }`, after | 10 | 10 | 10 | 10 |
| `class PP`, two-step | 10 | 10 | 10 | 10 |
| `class PP`, method before ctor | 10 | 10 | 10 | 10 |
| CONTROL — ctor with **no** own-method call | 10 | 10 | 10 | 10 |
| CONTROL — the call made **outside** any ctor | 10 | 10 | 10 | 10 |

**What the matrix decides.** Three of the four filed axes are inert:

- **source order** — method before vs after the ctor: identical in both lanes.
- **direct vs two-step** — `new PP(5).v` vs `var p = new PP(5); p.v`: identical.
- **`.mjs` vs `.ts`** (added axis, since the fnctor path keys on the JS spelling):
  identical.

The two axes that decide are **lane** (gc always correct, standalone always
throws) and **syntax** (`class` always correct, prototype-assignment throws).
A compile-order defect cannot produce a result that is order-insensitive and
lane-sensitive, so the filed hypothesis is refuted rather than merely unproven.

### The failure is a thrown TypeError, not a wasm trap (measured)

The thrown value is a null-prototype wasm payload that `String()` refuses, which
is why the #4406 record read it as "a thrown `undefined`". Recovered from
**inside** the guest with `try { new PP(5) } catch (e) { return e.message.length }`
and then char-by-char:

    standalone: len=30  msg="called value is not a function"
    gc:         no throw (returns -1, the no-throw sentinel)

So `this.twice` evaluates to a non-callable, i.e. the *lookup* fails; the call
site is fine.

### Five boolean-ABI lanes (measured) — confirms the filed "no #4406 switch reaches it"

Re-measured on base, both lanes, one subprocess per env:

| lane | gc | standalone |
| --- | --- | --- |
| default (Phase 4 on) | 10 | THROWS |
| `JS2WASM_RET_UNBOX_ABI=1` | 10 | THROWS |
| `JS2WASM_RET_UNBOX_ABI=0` | 10 | THROWS |
| `JS2WASM_NUMERIC_TWINS=0` | 10 | THROWS |
| `JS2WASM_NUMERIC_OPERANDS=0` | 10 | THROWS |
| `JS2WASM_DIRECT_CALLS=0` | 10 | THROWS |

`DIRECT_CALLS=0` is the addition: it disables the whole #3683 S3
devirtualization slice, and the failure survives it. So the gap is not the
devirtualizer mis-binding — it is that **nothing else can answer**.

### Root cause (measured, then confirmed against the source)

The decisive measurement is an identity pair — **one program, one runtime
object, two bindings**:

```js
var seen = null;
function PP(x) { seen = this; this.v = 1; }
PP.prototype.twice = function (x) { return x + x; };
// p === seen  → 1 in BOTH lanes (the ctor's `this` IS the constructed object)
// typeof p.twice    === "function" → 1 in gc, 1 in standalone
// typeof seen.twice === "function" → 1 in gc, 0 in STANDALONE
```

Same object. `p` is statically the fnctor shape, so `p.twice` resolves; `seen`
is untyped, so the identical property on the identical object does not. **A
runtime prototype would answer both.** Resolution is therefore static-only.

That matches the source exactly:

1. `resolveTypedThisField` (`src/codegen/typed-this.ts` ~L426) declines with the
   `not-in-twin` census bucket for "a function that has no typed twin — **a
   constructor**, or a method with no write-once verdict" — #4405 Phase 0's own
   instrumentation, and its largest bucket. A constructor has no typed twin **by
   design**, so `this.m()` in a ctor always declines.
2. On decline the call falls through to the dynamic `__call_m_<name>_<argc>` →
   `__extern_method_call` path. Confirmed in the emitted WAT: `$test` inlines
   `$__fnctor_PP_new`, the receiver reaching `$__call_m_twice_1` is the freshly
   `struct.new`'d instance and is non-null, and the helper does a fully dynamic
   member lookup.
3. In **standalone** that dynamic lookup has nothing to find. A `$__fnctor_F`
   instance is a CLOSED WasmGC struct — `deriveFnctorFields` fixes the field
   list and the expando sidecar is host-mode-only ("Host mode already has its
   fnctor sidecar for expando properties… the native shape growth is the
   host-free standalone replacement only", `fnctor-escape-gate.ts`). Prototype
   methods have **no runtime existence** in that lane.

**The load-bearing consequence.** The design note above `resolveTypedThisField`
states that a decline's "failure mode is only ever 'miss a devirtualization'".
That holds in gc, where the host sidecar still answers. In standalone it is
false: for a `this.m()` receiver the decline is a **hard runtime failure**, not
a slow path. Fixing this issue means either giving constructors a typed-`this`
twin (the #4405 mechanism, extended to the allocation site — where `this` is
already provably `(ref $__fnctor_F)`; the specialized `__fnctor_PP_new` holds it
in `local $__self`), or giving standalone fnctor instances a real prototype
link. Both are inside the fnctor model, which is why this is routed rather than
patched here. *(Reasoned, not measured: which of the two is cheaper.)*

### A second, independent hole found while measuring

`this.twice.call(this, x)` inside the constructor throws in **both** lanes —
gc included, where the plain `this.twice(x)` call succeeds. The gc failure is
`TypeError: Cannot read properties of null (reading 'call')`, raised in
`src/runtime.ts`'s `__extern_method_call` because the receiver `this.twice`
came back null. Different lane, different mechanism, so closing the standalone
gap above will **not** close this one. Pinned as an XFAIL so it is not
re-discovered as a duplicate of this issue.

### What ships in this PR

- `tests/issue-5162-ctor-own-prototype-method.test.ts` — 18 cases. The gc cases
  and the working standalone shapes are ordinary correctness pins (they also
  guard the diagnosis: if `class` syntax or the no-self-call ctor ever starts
  throwing in standalone, the gap is wider than recorded here). The failing
  shapes are **XFAIL pins** that assert the throw, so whoever closes the gap
  sees them go red and tightens them to `10`.
- **Non-vacuity, measured**: flipping every XFAIL pin to its spec-correct
  expectation turns **6 of 18 red** on base. The pins are measurements, not
  tautologies.
- **No `src/` change**, so byte-identity for constructors that do not call own
  prototype methods holds by construction — there is no lowering to differ.
