---
id: 4469
title: "Private method + super HomeObject traps when .call()ed with a foreign receiver"
status: done
sprint: current
created: 2026-08-15
completed: 2026-08-15
priority: high
horizon: s
feasibility: medium
task_type: bug
area: codegen
related: [4507, 4578]
---

# #4469 — private-method HomeObject dispatch regressed to an uncatchable trap

## Symptom

Every PR in the merge queue failed the uncatchable-trap ratchet (#3189):
`null_deref` **140 → 142**.

Two test262 files flipped to `null_deref`:

| File | Baseline | After #4507 |
| --- | --- | --- |
| `test/language/statements/class/elements/super-access-inside-a-private-method.js` | **pass** | `null_deref` |
| `test/language/statements/class/elements/private-method-get-and-call.js` | fail (catchable) | `null_deref` |

The first is the genuine conformance regression; the second was already
failing, but a *catchable* failure became an *uncatchable* trap, which is what
the ratchet counts.

## Bisect

First-parent probes on `main` (2026-08-15), run by the tech lead:

| Commit | Time | Result |
| --- | --- | --- |
| `0b50dada` | — | PASS |
| `d1cc32ef` | — | PASS |
| `92f78620` | — | PASS |
| `602aee7c` | — | PASS |
| `63247601` (GVN, flag OFF) | — | untested, inert |
| `c3ff8a1f` | 14:21 | **PASS** |
| `6756ed8c` (PR #4507) | 14:58 | **TRAP** |

Narrowed within #4507's diff by file-copy A/B (`git show c3ff8a1f:<file>` swapped
in, one file at a time): reverting **only**
`src/codegen/closures/method-trampolines.ts` to its `c3ff8a1f` content removes
the trap. Every other file in the diff is innocent.

## Repro

```ts
class A {
  method(): string { return "Test262"; }
}
class C extends A {
  #m(): string { return super.method(); }
  access(o: any): string { return (this as any).#m.call(o); }
}
const c = new C();
c.access(c);   // "Test262"
c.access({});  // "Test262" — HomeObject is independent of the receiver
```

`null_deref` on **both** front-ends (`experimentalIR` true and false) and in
both `target: "gc"` and `target: "standalone"` + `hostBridge: "always"`, which
is what identified the break as shared class/closure plumbing rather than
front-end selection.

## Root cause

`coerceTrampolineThisSlot` in `src/codegen/closures/method-trampolines.ts`
(added by #4507, refined by `9b8f6f82`).

`buildTrampolineThisSlot` produces the trampoline's receiver as a **nullable**
`ref_null $S`, and that nullability is load-bearing: the #2025 passthrough
hands the method `ref.null` whenever the resolved `this` is non-null but does
not `ref.test` as this exact struct — i.e. exactly the foreign-receiver case
`this.#m.call({})`.

`coerceTrampolineThisSlot` then reconciled that slot with the method's hidden
`this` parameter whenever the two `ValType.kind`s differed:

```ts
if (source.kind === methodThisType.kind) return;
body.push(...coercionInstrs(ctx, source, methodThisType, fctx));
```

A class instance method's hidden `this` is a **non-null** `ref $S`
(`class-bodies.ts`: `methodParams = [{ kind: "ref", typeIdx: structTypeIdx }]`),
so `"ref_null" !== "ref"` and the bridge fired. Instrumented on the repro:

```
[tramp] src= {"kind":"ref_null","typeIdx":49} -> this= {"kind":"ref","typeIdx":49}  usesThis=true
```

Same struct — the mismatch is **nullability only**. `coercionInstrs`
(`type-coercion.ts:4187`) answers `ref_null → ref` with
`[{ op: "ref.as_non_null" }]`, so the designed null passthrough became an
uncatchable trap at the ABI boundary, **before** the method body ran. `#m()`
here only needs its HomeObject (`super.method()`) and never reads `this`, so the
body would have returned `"Test262"` regardless of the receiver.

The `methodUsesThis` guard added in `9b8f6f82` ("preserve nullable receivers for
this-free methods") already patched the same class of bug for methods that never
read `this`. `#m() { return super.method(); }` *does* read `this` in the emitted
code — `super.method()` lowers to a direct call passing `this` on as the callee's
receiver — so it fell through that guard into the trapping path.

## Fix

Limit the reconciliation to a genuine **cross-carrier** mismatch. `ref` and
`ref_null` are one carrier family differing only in nullability; nullability is
settled by the callee's own signature, never by a cast at the trampoline. The
externref / anyref case that #4507 added the bridge for is untouched.

```ts
if (isStructRefCarrier(source) && isStructRefCarrier(methodThisType)) return;
```

`ref.as_non_null` never fixed a *typeIdx* mismatch anyway (it preserves the heap
type), so the narrowing removes no capability: the only thing the ref→ref branch
ever did was strip nullability, which is precisely the harmful part.

## Test Results

Behaviour is now **byte-for-byte parity with pre-#4507 `c3ff8a1f`** on both
shapes, both front-ends, both targets:

| Shape | pre-#4507 base | `main` (regressed) | with fix |
| --- | --- | --- | --- |
| `super-access-inside-a-private-method` | PASS | `null_deref` | **PASS** |
| `private-method-get-and-call` | catchable throw / `NaN` | `null_deref` | **catchable throw / `NaN`** |

`private-method-get-and-call` reading the foreign receiver's own `_v` is a
separate, still-open gap (the #2025 passthrough gives the body a null receiver);
this issue only restores it from uncatchable to catchable, which is what the
ratchet measures.

Pinned by `tests/issue-4469.test.ts` (both front-ends, module instantiated and
run, direct and `.call(o)` invocations).

## Non-goals

Undoing #4507's Marked win. Its class-method identity / ABI-key /
closed-dispatch changes (`class-member-keys.ts`, `closed-method-dispatch.ts`,
`class-bodies.ts`, …) are untouched — only the trampoline receiver bridge is
narrowed.
