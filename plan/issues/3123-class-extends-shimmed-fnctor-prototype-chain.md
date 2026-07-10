---
id: 3123
title: "class C extends F (plain fnctor with runtime-assigned .prototype): instance member lookup does not reach F.prototype — Iterator-helper exhaustion/return-forwarding residual (~8 files)"
status: done
completed: 2026-07-10
assignee: ttraenkler/fable-3123
sprint: Backlog
priority: medium
horizon: m
feasibility: hard
created: 2026-07-09
task_type: bugfix
area: codegen, runtime
language_feature: class-extends, iterator-helpers
goal: spec-completeness
test262_category: built-ins/Iterator/prototype
related: [3049]
---

# #3123 — `class C extends F` over a runtime-assigned fnctor prototype

## Source

Split out of #3049 (fable-proto, 2026-07-09). After #3049 landed Layers 1–3
(top-level `F.prototype = …` init keep, deferred host init in the test262
harness, `%ArrayIteratorPrototype%` middle proto, bridge-exit marshaling), the
`this-plain-iterator` cluster flipped (11/11), but ~8 sibling files remained
red with a DIFFERENT root:

- `built-ins/Iterator/prototype/{map,filter,flatMap,drop}/exhaustion-does-not-call-return.js`
- `built-ins/Iterator/prototype/{drop,take,filter}/return-is-forwarded.js`
- `built-ins/Iterator/prototype/flatMap/iterable-to-iterator-fallback.js`

## Repro / mechanism

These tests all use:

```js
class TestIterator extends Iterator {
  next() {
    return { done: false, value: 1 };
  }
  return() {
    ++returnCount;
    return {};
  }
}
let iterator = new TestIterator().drop(0); // ← "Cannot read properties of null (reading 'drop')"
```

where `Iterator` is the test262-runner harness shim — a plain top-level
`function Iterator(){}` whose `.prototype` is ASSIGNED AT RUNTIME (module
init) to the helper-bearing `%IteratorPrototype%`:

```ts
function Iterator(this: any): void {}
(Iterator as any).prototype = Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]()));
```

The compiled `class TestIterator extends Iterator` wires its prototype chain
to whatever the class-extends machinery resolves as the parent prototype at
COMPILE/CLASS-SETUP time — it does not observe the runtime re-assignment of
`F.prototype`, so `new TestIterator().drop` (an inherited helper two levels
up) resolves through a chain that never reaches the helper proto; the member
read yields null/undefined ("Cannot read properties of null (reading
'drop')" / "reading 'next'").

Note this is NOT the #3049 elision (the assignment DOES run now) and NOT the
bridge-marshal gap — it is the class-hierarchy wiring for `extends <plain
function>` with a dynamically (re)assigned `.prototype`. Spec §15.7.14
(ClassDefinitionEvaluation): the parent's `prototype` property is read at
class-definition time — but at that point (module init order) the shim's
assignment HAS already executed (it precedes the class in program order), so
an implementation that reads `F.prototype` dynamically at class-eval time
would see the helper proto. Our class-extends lowering likely resolves the
parent prototype through a compile-time singleton / vivified sidecar object
instead of the live `F.prototype` slot.

## Suggested approach

Trace `class C extends F` (F = top-level plain function, not a class) in
`src/codegen/class-bodies.ts` / the fnctor-extends arm: where does the
parent-prototype link come from, and can it read the LIVE `F.prototype`
(host sidecar `_getOrVivifyFnPrototype` / `__extern_get(F, "prototype")`) at
class-definition time in `__module_init`? With #3049's deferred harness init,
class setup that runs inside `__module_init` executes after `setExports`, so
host reads are available.

## Acceptance criteria

- The 8 residual files above pass in the host lane.
- No regression in class-extends-class or the #3049 cluster.

## Implementation (2026-07-10, fable-3123) — SHIPPED

**Measured cluster delta (in-process runner, host lane): 8/8 target files
flip to pass; both `this-plain-iterator` controls (the #3049 cluster) stay
green; emit-identity byte-identical (39/39 (file,target) hashes across
gc/standalone/wasi on the curated corpus vs the predecessor branch).**

The issue title's mechanism ("class wiring does not observe the live
`F.prototype`") is real but was only ONE of five stacked walls — each pinned
empirically (WAT dumps + import traces) before fixing. WHY each exists:

1. **No host-side link from a class instance to the fnctor parent's live
   prototype.** `class C extends F` (F a plain top-level function) compiles
   instances as WasmGC structs; nothing registered them with the host MOP, so
   `inst.drop` (inherited from the runtime-assigned `F.prototype`) resolved
   nowhere. Fix: `${className}_init` tails a `__register_fnctor_instance(self,
   F_closure)` host call (host lane only, fnctor-ancestor classes only —
   `fnctorAncestorOfClass` in `class-member-keys.ts`); the runtime records it
   in the existing `_fnctorInstanceCtor` WeakMap so the #1712
   `_fnctorProtoLookup` walk serves inherited reads. The walk also gained a
   `__sget_prototype` fallback: the #2664 `__set_member_prototype` dispatcher
   can store `F.prototype = …` in the closure STRUCT's field slot, invisible
   to the sidecar-only read.
2. **Compiled class methods/getters were host-INVISIBLE on the instance.**
   The helper wrappers (native V8 `Iterator.prototype.drop` et al.) read
   `this.next` / IteratorClose reads `this.return` from HOST code; struct
   methods aren't fields, so every read yielded undefined. Fix: per-module
   dispatch exports `__member_kind_<k>` (0 none / 1 method / 2 getter) +
   `__call_get_<k>` (getter runner), gated on `moduleHasFnctorSubclass` so
   every other module's bytes are IDENTICAL; `_resolveHostField` / `_safeGet`
   consult them (arm gated on `_fnctorInstanceCtor.has(obj)`) and bridge via
   the #3049 `_marshalBridgeResult` machinery. Getter reads run PER [[Get]]
   (the exhaustion tests' `get next()` mints a fresh generator per read —
   caching would break §27.1.4 GetIteratorDirect semantics).
3. **calls.ts emitted a graceful-NULL for the helper call and a null-self
   static call for the wrapper's methods.** `new C().drop(0)` fell to the
   graceful tail (`__extern_get` + drop + `ref.null.extern` — WAT-verified);
   `iterator.return()` on an any-typed binding got INFERRED to C and
   tag-dispatched statically — a host wrapper fails the `ref.test`, so the
   class method ran with a NULL self (this is why returnCounts double-bumped
   pre-fix). Fixes: (a) method-MISS on a fnctor-subclass receiver routes
   through a new `emitFnctorSubclassDynamicMethodCall` (`__extern_method_call`
   mirror of the #799 WI3 generic arm); (b) the any-receiver class-inference
   scan SKIPS fnctor subclasses (the runtime value must decide); (c) the
   `__gen_next/return/throw` dispatchers gained a `_safeGet` miss-arm gated on
   registered instances so struct receivers still dispatch.
4. **`(ref $C)`-typed bindings NULLED the host wrapper on reassignment.**
   `let iterator = new TestIterator(); iterator = iterator.drop(0);` — the
   slot was the class struct type; storing the wrapper goes through the
   guarded cast → null → "Cannot read properties of null (reading 'next')".
   Fix: pre-hoist widening to externref (`fnctorWidenedLocals`) when a
   fnctor-subclass-typed `let` has a foreign-typed reassignment
   (symbol-matched scan), mirrored in `statements/variables.ts` for the
   block-scoped-shadow re-allocation path; widened bindings dispatch member
   calls dynamically. Never-reassigned bindings keep static dispatch (the
   guarded cast recovers the struct — verified `a.bump()` unchanged).
5. **#2818's derived-class carve-out silently no-op'd captured writes in the
   HOST lane.** A capturing derived class nested in control flow (the
   try-block the test262 wrapper puts every body in!) compiled EAGERLY —
   before the block-`let` exists — so `++returnCount` in the method lowered
   to `f64.const NaN; drop` (WAT-verified). The carve-out existed ONLY to
   protect the standalone lane (its comment documents the deferred path as
   correct for host); it is now gated `ctx.standalone || ctx.wasi`, so host
   defers derived capturers like base-less ones and capture promotion fires.

Plus one adjacent root shared by the cluster's 8th file
(`flatMap/iterable-to-iterator-fallback`): a computed well-known-symbol
LITERAL property (`{ [Symbol.iterator]: 0 }`) compiles to a struct FIELD
named `@@iterator` that the host symbol-read arms never consulted — GetMethod
saw undefined instead of the non-callable 0 and never threw. `_safeGet` /
`_resolveHostField` now fall back to the per-shape `__sget_@@<name>` getter
(null/undefined results stay MISS, so the `[Symbol.iterator]: null/undefined`
fallback variants keep their spec behavior).

**Known bounded residual (documented, not a cluster blocker):** the kind-1
method bridge dispatches on the captured instance and ignores a re-bound
`this` (`const f = it.next; f.call(other)`) and passed args (the exports are
0-arg dispatchers); parameterized methods report kind 0 and fall back.

Validation: `tests/issue-3123.test.ts` (6 green); scoped sweeps
(`built-ins/Iterator` chunked per-dir, branch-vs-base control at 269a8127) —
flips only in the target direction; `prove-emit-identity` IDENTICAL vs base;
`tests/issue-{3049,2818,2628,2015,1712*}.test.ts` — one pre-existing failure
(`issue-1712-capture-closure-dispatch` #3) reproduced UNCHANGED on
origin/main b6691942 (local Node-25 environment, not a branch delta). Full
validation: PR-level test262 diff + merge_group (broad-impact: host defer
scope + dynamic dispatch).
