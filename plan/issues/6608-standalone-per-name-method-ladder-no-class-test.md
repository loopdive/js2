---
id: 6608
title: "standalone: a method call by name on a statically-unknown receiver runs the WRONG class's body — every per-name dispatch ladder tests `ref.test`, which is structural"
status: done
completed: 2026-09-14
sprint: current
priority: high
horizon: m
feasibility: hard
reasoning_effort: high
goal: standalone-gap
parent: 5383
assignee: ttraenkler/s21-lane
created: 2026-09-14
loc-budget-allow:
  # 2026-09-14 (S21) — the nominal `__tag` arm guard, extracted to one file so
  #   the three ladders that need it stop each carrying their own copy (index.ts
  #   already had TWO, added by #4618 for the host-bridge ladders only). The new
  #   file is ~115 lines, of which ~45 are the rationale: `ref.test $C` is a
  #   STRUCTURAL test and WasmGC canonicalizes same-shaped struct types, so the
  #   test that looks like a class check is not one. A reader who deletes the
  #   guard "because ref.test already checks the class" reintroduces the bug
  #   this issue is about, and the symptom appears several layers away (a brand
  #   check inside someone else's method). index.ts NET SHRINKS by ~95 lines
  #   (both duplicate copies removed); closed-method-dispatch.ts grows by ~8.
  - src/codegen/class-arm-tag-guard.ts
  - src/codegen/closed-method-dispatch.ts
func-budget-allow:
  # 2026-09-14 (S21) — same change, function-level. `classArmTagCondition` is
  #   the #4618 body moved verbatim out of index.ts; `classArmClaimInstrs` is
  #   the 12-line wrapper that turns a bare `ref.test` claim into the guarded
  #   one, so the three call sites stop repeating the same `if`-block shape.
  - src/codegen/class-arm-tag-guard.ts::classArmTagCondition
  - src/codegen/class-arm-tag-guard.ts::classArmClaimInstrs
  - src/codegen/closed-method-dispatch.ts::fillClosedMethodDispatch
  # 2026-09-14 (S21) — the ToPrimitive ladder half. `emitDispatchForMethod`
  #   (nested in `emitToPrimitiveMethodExports`, so both keys grow by the same
  #   +6) gains the guarded claim plus its comment: that ladder is FIRST-match,
  #   so a same-shaped sibling declared EARLIER answered `toString`/`valueOf`
  #   for every one of them — in the compiled Temporal provider, as
  #   Number.prototype's radix error. The comment is the grant's substance: the
  #   claim looks like a redundant re-test of something `ref.test` already did.
  - src/codegen/index.ts::emitToPrimitiveMethodExports
  - src/codegen/index.ts::emitDispatchForMethod
---

# #6608 — the per-name method ladder has no runtime CLASS test, only a shape test

## Symptom

Host-free (`--target standalone`), one module, no Temporal, no dynamic `new`:

```js
class A { uniqB() { return "UA"; } }   // (A does not declare uniqB in the real
class B { uniqB() { return "UB"; } }   //  reduction; see the ladder probe)
function f(o) { return o.uniqB(); }    // `o` is `any`
f(new A());                            // → "UB"   ← B's body, on an A
```

Every call by name on a statically-unknown receiver — an `any`-typed
parameter, a value out of an intrinsic registry, a dynamic-`new` result,
a value that crossed the wasm↔wasm link — resolves through a per-name ladder
and lands in the wrong class's method whenever two classes share a field
layout. Two ladders, two different wrong answers:

| ladder | order | wrong answer |
| --- | --- | --- |
| `__call_m_<name>_<arity>` (closed-method dispatch) | last arm outermost | the **LAST**-declared class that declares the name |
| `__call_toString` / `__call_valueOf` (ToPrimitive) | first arm matches | the **FIRST**-declared class that declares the name |

In the compiled `@js-temporal/polyfill` provider this is
`Temporal.Duration.from("P1Y").toJSON()` throwing *invalid receiver: method
called with the wrong type of this-object* — the receiver is correct, its
slots are present and its own brand check passes; the method FOUND belongs to
another class — and `toString()` on any Temporal object reporting *toString()
radix argument must be between 2 and 36*, which is `Number.prototype.toString`
answering for a Temporal object.

## Root cause

`ref.test $C` is a **structural** test. WasmGC canonicalizes struct types by
shape, and field NAMES do not exist in wasm, so `class A { x }` and
`class B { y }` are literally the same runtime type — as is every pair of
classes that keep their state in a `WeakMap` and therefore have no fields at
all beyond the compiler's own `__tag`. The compiler's own type registry keeps
them apart (they get distinct type indices: measured 55 / 59 / 63 for a
three-class probe) which is exactly why this is invisible when reading the
emitter; canonicalization happens below it, at validation.

So every arm of the ladder claims every instance, and which body runs is
decided by the ladder's assembly order, not by the receiver.

This is **not** a new defect and not a Temporal one. #4618 found and fixed the
same thing for the JS-host class-member bridge ladders (`__call_method_<key>`,
`__member_kind_<key>`) — React's repeated `class Foo` test declarations ran a
later sibling's `UNSAFE_componentWillMount`. That fix introduced a `__tag`
guard, as a **local** helper, twice, inside `index.ts`; the standalone
any-receiver ladder and the ToPrimitive ladder never got it.

## The fix

`src/codegen/class-arm-tag-guard.ts` — the #4618 condition, moved out of
`index.ts` verbatim, plus a `classArmClaimInstrs` wrapper that emits the arm's
claim (`ref.test $C && recv.__tag ∈ {own} ∪ {descendants}`). Applied to:

- `fillClosedMethodDispatch` — the fixed-arity and vararg `__call_m_*` ladders;
- the `__call_toString` / `__call_valueOf` first-match ladder in `index.ts`.

Descendant tags are included so a parent's arm keeps matching subclass
instances (inherited-method dispatch); a subclass that overrides still has its
own arm, further out.

**Byte preservation is a property of the guard, not of a flag.** The helper
returns `undefined` — and the caller emits exactly its previous two
instructions — unless another emitted struct shares this one's field layout.
A module whose classes have distinct shapes, or which declares a method name
once, is byte-identical.

## Deliberately NOT fixed here

- `__call_@@toPrimitive` has the same unguarded ladder, but its entries do not
  carry a struct NAME (only a type index), so the guard cannot be applied
  without changing that collection. Same class of defect; separate slice.
- A same-shaped OBJECT LITERAL pair has no `__tag` to test, so the ladder
  still picks by order for `{ m(){…} }` carriers. Unchanged by this slice.
- `Object.getPrototypeOf(x) === C.prototype` remains false for a dynamic-`new`
  instance (#6607 residual 2, still pinned by that file's last `it`).
