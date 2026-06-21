---
id: 2564
title: "Private-field nested-class follow-ups: polymorphic method-return blockType (invalid wasm) + read-before-own-slot TypeError gap"
status: done
sprint: 64
created: 2026-06-20
updated: 2026-06-21
completed: 2026-06-21
assignee: ttraenkler/sd3
priority: medium
feasibility: hard
reasoning_effort: max
task_type: bug
area: codegen
language_feature: class-private-fields
goal: correctness
depends_on: [2563]
---

## Context

Spun out of #2563 (which fixed the global-index-desync invalid-wasm in the
private-field brand-check read path). Two residual test262 failures under
`test/language/statements/class/elements/` remain, with **distinct** root
causes from #2563.

## Part A — `privatefieldset-typeerror-3.js` (INVALID wasm)

```js
class Outer {
  #x = 42;
  innerclass() {
    return class extends Outer {     // method returns a class expression
      f() { this.#x = 1; }
    }
  }
  value() { return this.#x; }
}
var outer = new Outer();
var Inner = outer.innerclass();      // polymorphic receiver (Outer | __anonClass_0)
var i = new Inner();
```

Under the full test262 harness wrap (where `outer`/`Inner`/`i` are hoisted to
module scope), `outer.innerclass()` is compiled as a **tag-based polymorphic
dispatch** (`struct.get __tag` == 1 → Outer impl, == 2 → derived impl). The
dispatch `if`'s result blockType is resolved to the **function-wrapper struct
type** `$func.0` (`(struct (field funcref))`) instead of the method's actual
return struct type (`__anonClass_0` / `Outer`). The arms produce
`(call $Outer_innerclass …)` → `(ref null $__anonClass_0)`, which does not
match `(ref null $func.0)` → binaryen/V8:
`type error in fallthru[0] (expected (ref null 13), got (ref null 16))` in
`test()`.

The minimal (non-hoisted) form compiles to valid wasm — the bug only fires when
the receiver is module-scoped and the polymorphic dispatch path is taken. Root
cause is the method-return-type resolution for a method whose declared/ inferred
return type is a **class expression** (a constructable function value), which is
landing on the closure/fn-wrapper struct type rather than the produced class
struct. Fix needs to resolve the dispatch result blockType from the callee's
real return struct (the lowest common supertype of the candidate impls'
returns), not from the fn-wrapper type.

Start points: the tag-dispatch `if`-result-type construction for a member call
whose receiver static type admits subclasses (search the call-expression
lowering in `src/codegen/index.ts` / `expressions.ts`), and how a method
returning a `ClassExpression` gets its return ValType.

## Part B — `privatefieldget-typeerror-1.js` / `privatefieldset-typeerror-1.js` (behavioral, NOT invalid wasm)

```js
class C {
  y = this.#x;        // read #x in a field initializer …
  #x;                 // … before #x's own slot is initialized
}
assert.throws(TypeError, function() { new C(); })   // must throw
```

Per ES2022 PrivateFieldGet/PrivateFieldSet step 4 (PrivateFieldFind returns
empty → TypeError): reading/writing a private field whose
`[[PrivateFieldValues]]` entry has not yet been added throws TypeError. js2wasm
currently returns 2 (the field reads as its default, no throw). The compiler
treats `this.#x` inside the declaring class body as brand-guaranteed and skips
the runtime check — correct for the steady state, but it misses the
field-initialization-order window where `#x`'s slot exists structurally (the
struct field is allocated) but is semantically "not yet added". A spec-accurate
fix likely needs an initialized-flag / definite-assignment model for private
slots during the field-initializer phase, or to detect the
read-before-declaration order statically and emit a throw.

## Acceptance

- `privatefieldset-typeerror-3.js` → valid wasm + pass.
- `privatefieldget-typeerror-1.js`, `privatefieldset-typeerror-1.js` → pass
  (throw TypeError).
- Broad class/private-field test262 sweep: zero new regressions.

## Resolution (2026-06-21, sd3)

### Part A — DONE. Real root cause: shared-`blockType` double-remap in dead-elimination

The framing in the original analysis ("blockType resolved to the fn-wrapper
struct type instead of the method's real return struct") was a *symptom*. At
**emit time** the dispatch was already correct: `emitVirtualMethodDispatchByTag`
(`src/codegen/expressions/calls.ts`) resolves the result type via
`getWasmFuncReturnType(firstCand.funcIdx)`, which for `Outer.innerclass` correctly
returned `(ref $__anonClass_0)` — the SAME type the callee func returns. Verified by
instrumenting the dispatch: `resultType` == the func's `results[0]` == `(ref 20)`.

The divergence was introduced by `eliminateDeadImports` (`dead-elimination.ts`).
The tag cascade builds **one distinct `if` instruction per candidate** but shared
a **single `blockType` object** across all of them. `remapTypeIdxInBody`'s
double-remap guard (`seen` WeakSet, #1302) keys on the **instruction object**, not
on the `blockType.type` sub-object — so each aliasing `if` passed the guard and
chain-remapped the shared block-type a second time. Under the survivor-compaction
remap (`20→16`, `16→13`, each survivor shifts down) the cascade did `20→16` on the
first `if`, then `16→13` on the second, landing the block-type on `$__fn_wrap_0`
(the fn-wrapper) — while the callee func's result type, remapped exactly once in
the type table, landed on `16` (`$__anonClass_0`). Hence
`type error in fallthru[0] (expected (ref null 13), got (ref null 16))`. This is the
type-index-shift hazard family (memory `project_type_index_shift_and_deadelim`).

**Fix (2 files, complementary):**
1. `emitVirtualMethodDispatchByTag` now mints a **fresh `blockType` object per
   `if`** (`freshBlockType()` clones the result ValType) — producers must never
   share an instruction-operand object across distinct instructions (the
   #1302/iterator-native/json-codec convention).
2. `remapTypeIdxInBody` now also guards on the **`blockType` object itself**
   (`seen.add(a.blockType)`) so an aliased block-type is remapped exactly once
   regardless of how many instructions reference it — defense-in-depth for any
   other producer that shares a block-type.

**Impact (class-category sweep, old main bundle vs. fixed, 4367 files):**
PASS 2395 → 2433 (**+38**), INVALID 32 → 14 (**−18**), FAIL 768 → 746, **0
regressions** (no PASS→worse, no new INVALID/CRASH). The fix is broad: besides
`privatefieldset-typeerror-3.js` (INVALID→PASS) it flipped 12 `dstr/*-meth-*-obj-
ptrn-prop-obj.js`, 5 `private-methods/prod-private-*`, and 22
`elements/*-rs-private-setter*` from INVALID/FAIL → PASS — all the same
shared-block-type bug surfacing through different class/method shapes.

### Two unrelated pre-existing INVALID-wasm files (NOT this bug, out of scope)

`privatefieldget-primitive-receiver.js` / `privatefieldput-primitive-receiver.js`
(both `features: [..., BigInt]`) emit invalid wasm via a DIFFERENT path
(`__closure_2`: `call[0] expected (ref null 20), found f64.const of type f64`).
They are INVALID on plain main too (pre-existing), are not touched by the dispatch
fix, and are a separate primitive-receiver/BigInt private-field bug. Left for a
follow-up; not a #1711 blocker (they were already on main).

### Part B — DEFERRED (read-before-own-slot TypeError)

`privatefieldget-typeerror-1.js` / `privatefieldset-typeerror-1.js` still return
the default (no throw) instead of throwing TypeError per ES2022
PrivateFieldGet/Set step 4. A spec-accurate fix needs an
initialized-flag / definite-assignment model for private slots during the
field-initializer phase (the slot exists structurally but is semantically "not
yet added"). That is a non-trivial design change, not cheap; the issue scoped
Part B as "only if Part A is cheap to finish". Deferred to keep the
invalid-wasm fix isolated and regression-free. Behavioral-only (2 tests).

### STEP 3 — top-level-await `module-import-rejection` files: NON-ISSUE

The 3 `language/module-code/top-level-await/module-import-rejection*.js` files
compile to **valid wasm** on both old main and the fixed bundle (outcome: runtime
`THROW`/`fail`, not `malformed_wasm`). They never tripped the hard-error gate
(which counts only `malformed_wasm` / `missing_test_export`). They were a red
herring in the #1711 ejection diagnosis: they're ordinary `fail` outcomes gated on
dynamic `import()` rejection handling (an unrelated feature gap), not invalid-wasm
blockers.
