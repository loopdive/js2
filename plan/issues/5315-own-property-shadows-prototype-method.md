---
id: 5315
title: "An own property installed over a prototype method never wins the call, and two neighbours on the same path"
status: done
sprint: current
created: 2026-09-03
updated: 2026-09-04
completed: 2026-09-04
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: correctness
# 2026-09-04 — the own-slot guard has to be wired into every arm that answers a
# method call from the receiver's static class, and each of those arms lives in
# its own subsystem module; the shared logic (the scan, the wrapper mint, the
# finalize fill) is already factored out into the new
# `expressions/own-property-method-shadow.ts` rather than added to a driver.
# What remains in each file is the call-site wiring plus its rationale comment.
# `literals.ts` carries the runtime-spread copy, which belongs to the
# object-literal lowering it repairs.
loc-budget-allow:
  - src/codegen/literals.ts
  - src/codegen/closed-method-dispatch.ts
  - src/codegen/expressions/call-receiver-method.ts
  - src/codegen/context/types.ts
  - src/codegen/property-access-dispatch.ts
  - src/codegen/expressions/calls.ts
  - src/codegen/index.ts
# The guard has to be decided inside each arm's own dispatch context — the
# receiver class, the resolved funcIdx and the emit position are all local to
# these functions, so the wiring cannot move out of them; everything that could
# be hoisted already lives in `own-property-method-shadow.ts`. The two
# `generate*Module` entries are one `fillOwnShadowWrappers(ctx)` line each.
func-budget-allow:
  - src/codegen/literals.ts::compileObjectLiteralForStruct
  - src/codegen/expressions/call-receiver-method.ts::compileReceiverMethodCall
  - src/codegen/closed-method-dispatch.ts::fillClosedMethodDispatch
  - src/codegen/property-access-dispatch.ts::finalizeStructAndDynamicMemberGet
  - src/codegen/index.ts::generateModule
  - src/codegen/index.ts::generateMultiModule
---

## Problem

An own property installed at runtime over a prototype method of the same name
did not win the method call, and did not even win the property READ:

```js
class H { pre(x) { return x; } }
const h = new H();
h.pre = (x) => "W" + x;
h.pre("a");               // → "a"    WRONG, expected "Wa" — the prototype method won
const f = h.pre; f("a");  // → "a"    WRONG, expected "Wa" — the READ ignored the own property
```

§10.1.8.1 OrdinaryGet consults the own slot before `[[Prototype]]`. The write
itself was already correct — it lands in the host sidecar (`_wasmStructProps`)
and `_safeGet` reads the sidecar *before* `_resolveClassMember`. Every compiled
fast path was wrong, because each of them answers from the receiver's STATIC
class.

The motivating consumer is `marked@18`, whose `Marked#use()` installs each hook
as an own property over the `_Hooks` prototype method through a computed key:

```js
for (const o in n.hooks) { const a = r[o]; r[o] = c => a.call(r, u.call(r, c)); }
```

An identity hook is indistinguishable from no hook, which is why only an
OBSERVING hook exposes the defect. The whole 30-test upstream Hooks suite sat at
`0/30` on that shape.

## What the defect actually was — three independent bugs on one path

Chasing marked from the reported symptom turned up **three** defects in series.
Each one masks the next, so each had to be fixed to see the one behind it.

### 1. Every static class-method arm answered from the static class

`call-receiver-method.ts` already knew this collision exists, but only in its
DECLARED form: `hasUserClassField` looks for a struct field of externref type
named like the method and declines the closed method dispatcher for it
("a closed method dispatcher cannot represent that per-instance choice"). A
shadow installed at runtime declares nothing, so that gate never fired.

Three arms answer statically and all three were wrong:

| arm | file | shape it claims |
| --- | --- | --- |
| class-instance direct call | `expressions/call-receiver-method.ts` ~1958 | `h.pre(a)` on a `C`-typed receiver |
| struct-carrier direct call | `expressions/call-receiver-method.ts` ~2270 | the same call resolved via the receiver's wasm carrier — **this is the arm that actually claimed the repro** |
| member READ | `property-access-dispatch.ts` ~4140 | `const f = h.pre` → the per-method closure singleton |
| closed dispatcher | `closed-method-dispatch.ts` fill | `anyReceiver.pre(a)` → `__call_m_pre_1`'s `ref.test` ladder — **this is marked's arm** |

### 2. An unshaped spread source was silently DROPPED

```js
class M { defaults = { hooks: null };
  use(n) { const s = { ...n }; s.hooks = new H();
           this.defaults = { ...this.defaults, ...s }; } }
```

`m.defaults.hooks` came back `null`. In `compileObjectLiteralForStruct`, a
spread source with no resolvable struct shape (`s` types as `any`) failed
`resolveStructName`, was dropped from `spreadSources`, and was **never even
evaluated** — so `{ ...this.defaults, ...s }` emitted a `struct.new` reading
only `this.defaults`. That is marked's `use()`: the entire hook registry
vanished before anything could dispatch to it.

### 3. An immediately-invoked CONDITIONAL callee returned `undefined`

```js
(cond ? obj.method(arg) : other)(a, b)   // → undefined
```

`compileConditionalCallee`'s per-branch lowering handles an identifier, a nested
conditional, parentheses and a property access. Every other branch shape fell to
a "graceful" fallback that compiles the callee, **drops** it, compiles the
arguments, drops them, and pushes a default value. marked's pipeline is exactly
that shape —

```js
(i.hooks ? i.hooks.provideLexer(e) : e ? Lexer.lex : Lexer.lexInline)(src, opts)
```

— so with hooks registered every `parse()` returned `undefined`. Before fix 2
this was invisible: `i.hooks` was always `null`, so the branch never ran.

## Implementation notes — why it is built this way

**A runtime guard, not a compile-time decline.** The obvious fix for (1) is to
decline the static arm and let the generic host ladder answer. Measured: that is
both too coarse and not conservative. Declining the two static call arms for
`pre` made a receiver carrying NO shadow return `null` instead of running its
method (the arms below the declined one do not all reconstruct a class-method
call). And the decision must come from a compile-time scan that cannot see WHICH
instance acquired the slot, so a file-wide decline pessimises every unrelated
receiver in the file.

So the fast path stays and gains a runtime guard. Each `(class, method)` a scan
admits gets one wrapper with the method's exact wasm signature:

```wat
(func $__ownshadow_H_pre_1 (param (ref null $H) externref) (result externref)
  ;; own slot? → __extern_method_call, which reads the sidecar first
  ;; else      → call $H_pre, unchanged
```

Call sites swap only the `funcIdx`. Argument marshalling, arity padding, `__argc`
seeding and the result type are untouched, so a receiver without a shadow runs
the body it always ran, one `__hasOwnProperty` later. The closed dispatcher gets
the same guard inline in its per-class arm rather than a wrapper, because its
fill runs at finalize where minting is possible but the AST is gone.

**Why the guard cannot recurse.** `__extern_method_call` resolves through the
host proxy, which prefers the sidecar, and reaches the class method only via
`__class_call_<name>_<arity>` — the RAW prototype entry point, deliberately NOT
wrapped. This matters for marked, where the installed hook closes over the method
it displaced (`const a = r[o]; r[o] = c => a.call(r, …)`). Wrapping the method
BODY, or `__class_call_*`, would make `a.call(r, …)` re-enter the guard, see the
own slot, and loop forever. That is the reason this is not a one-line change to
the method prologue.

**Why the scan is name-imprecise for computed keys.** Receiver precision was
tried first and is not available: TypeScript types marked's `r` in
`for (const o in n.hooks) { r[o] = … }` as `any`. Measured 2026-09-03 against the
pinned 18.0.2 bundle — all four element-access callable writes report
`symbol=undefined type=any`. So a computed-key callable write admits every class
method **in that file**; a literal-named write admits exactly that name. Files
with no callable member write at all — the overwhelming majority — are
byte-identical. Over-admitting costs one host predicate call per invocation;
under-admitting returns the wrong value.

**Why the spread copy is restricted to a suffix.** Later writers win in
JavaScript and the `__object_assign` copy necessarily happens after `struct.new`.
Applying it for a source that some later named property or shaped spread must
override would invert that order, so a non-suffix unshaped source keeps today's
behaviour (dropped) rather than being silently mis-ordered.

**Scope: JS-host lane only for (1).** The guard is `env.__hasOwnProperty` +
`env.__extern_method_call`. Standalone/WASI is untouched and keeps the defect —
see *What remains*. Fixes (2) and (3) are lane-independent.

## Evidence

`tests/class-method-own-property-shadow.test.ts` — 7 cases, untyped `.js`
fixtures fed through a two-file project (annotating the receiver `: any` routes
to a different externref arm and the test then passes with and without the fix).

| | parent `68246a740c` | with the fix |
| --- | --- | --- |
| `tests/class-method-own-property-shadow.test.ts` | **6 failed, 1 passed** | **7 passed** |
| `marked@18.0.2` upstream Hooks suite | **0/30** | **2/30** |

marked's remaining 28 are two further clusters, both beyond this change:

- 11 × `marked(): The async option was set to true by an extension` — an absent
  boolean property on a spread-derived struct reads `false` rather than
  `undefined`, so `r.async === false` is wrongly true.
- 11 × `Cannot read properties of null (reading 'apply')` — `const a = r[o]`
  returns `null` for the two hooks that carry a default parameter
  (`provideLexer(e = this.block)` / `provideParser`). A fresh instance reads
  both `preprocess` and `postprocess` correctly through the same computed-key
  route, so it is specific to that shape, not to computed reads generally.

## What remains

1. **Standalone/WASI keeps defect (1).** The guard needs an own-property
   predicate the no-host lane can answer; `__hasOwnProperty` is a host import.
2. **The two marked clusters above.**
3. **A virtual-dispatch call site is not guarded.** When the receiver class
   does not itself declare the method and the compiler builds a tag-comparison
   cascade over descendants, `emitVirtualMethodDispatchByTag` returns before the
   guard is reached, so that site keeps today's shadow-blind behaviour. This is
   the region PR #5577 (`issue-5249-adjustcalendardate-unreachable`) rewrites;
   the two changes are textually disjoint (its hunk ends ~1876, the first of
   these starts ~2019) and semantically independent — #5577 decides WHICH
   descendant arm to emit, this decides whether an own slot pre-empts the arm,
   and neither touches `hasUserClassField` / `needsRuntimeUserMethodName`, the
   gate that declines the closed dispatcher. Extending the guard to the virtual
   cascade is follow-up work, best done after #5577 lands.
4. **A neighbouring pre-existing crash, out of scope:** reassigning a local
   whose initializer gave it one struct shape from a spread of a different
   shape (`let d = { hooks: null }; d = { ...d, ...s };`) traps with
   `illegal cast`. Reproduced on the parent commit; unrelated to this change.
