---
id: 3129
title: "any-receiver method call statically binds to the first CLASS with that method name and null-coerces foreign receivers — in-wasm trap instead of dynamic dispatch"
status: in-progress
assignee: fable-3124
sprint: current
priority: medium
horizon: l
feasibility: hard
created: 2026-07-10
task_type: bugfix
area: codegen
language_feature: method-dispatch
goal: spec-completeness
related: [3124, 2151, 1299]
---

# #3129 — any-receiver class-method static bind traps on foreign receivers

## Source

Split from #3124 (fable-3124, 2026-07-10). #3124 fixed the RUNTIME half of
inherited resolution over `Object.create(<struct>)` chains (member reads,
`in`, object-literal method calls — all host-glue). This issue is the
remaining CODEGEN half: it cannot be fixed in `src/runtime.ts` because the
host is never consulted.

## Repro (verified on main + #3124)

```ts
class Base {
  x: number;
  constructor() {
    this.x = 42;
  }
  getX(): number {
    return this.x;
  }
}
const base = new Base();
const o: any = Object.create(base);
o.getX(); // RuntimeError: dereferencing a null pointer  (want 42)
```

`o.x` reads 42 (fixed by #3124); only the METHOD CALL traps.

## Mechanism (exact, from the emitted WAT)

`compileCallExpression` (src/codegen/expressions/calls.ts ~10930, the
"Final fallback: scan all known classes for one that has the method" arm)
resolves ANY `any`-receiver `.m()` call to the FIRST compiled class with a
method named `m` — for an `any` receiver, `receiverType.getProperties()` is
empty, so the structural-compatibility heuristic is skipped entirely and the
scan always claims the call. The call site then coerces the receiver to the
method's param type with the standard test-else-null shape:

```wat
any.convert_extern            ;; host object → anyref
ref.test (ref $Base)          ;; fails for anything not a $Base struct
(if (result (ref null $Base))
  (then … ref.cast …)
  (else ref.null $Base))      ;; ← foreign receiver becomes NULL
call $Base_getX               ;; struct.get on null → trap
```

There is NO `__extern_method_call` fallback arm in the emitted code — the
host never sees the call, so no runtime patch can help. Every receiver that
is not an instance of (a subclass of) the statically-picked class traps:
`Object.create(instance)` chain receivers, host objects, Proxies.

## Fix direction

Emit a guarded dispatch instead of the null-coerce when the receiver's
static type is `any`/unknown AND the resolution came from the class-scan
fallback:

```wat
ref.test (ref $Base)
(if (result externref)
  (then …direct call $Base_getX, box result…)
  (else __extern_method_call(recv, "getX", [args…]) ))
```

- The host side already resolves inherited methods over struct chains
  (#3124's `_protoChainStructResolve` arm in `__extern_method_call`) and the
  vivified-fnctor/vec/native arms.
- For CLASS methods specifically, the host can only dispatch if a per-method
  dynamic entry exists. `__extern_method_call` cannot call `$Base_getX`
  directly (not exported, struct-typed param). Options: (a) reuse the
  standalone closed-method dispatcher machinery (`__call_m_<name>_<arity>`
  in closed-method-dispatch.ts, currently `ctx.standalone || ctx.wasi`
  gated) in host mode for the else-arm; (b) export per-class method
  wrappers `__mcall_<Class>_<name>(externref, …)` and teach
  `_protoChainStructResolve`/`_resolveHostField` to surface class methods
  through them.
- Receiver semantics boundary (document, don't chase): a compiled method
  body is shape-specialized (`struct.get $Base` on `this`), so a NON-struct
  receiver (`o` itself) can never be threaded as `this`. Dispatching with
  the struct HOP as `this` gives correct results unless an own property on
  `o` shadows a field the method reads (`o.x = 99; o.getX()` → 42 not 99).
  That shadow case is the true substrate limit.

## Emission-impact warning

This changes the emitted shape of every any-receiver class-method call in
host mode — prove-emit-identity WILL diff (unlike #3124, which was
byte-identical). Full merge_group validation required; watch the
`ref.test`-dispatch hot paths (#1299 virtual dispatch interplay).

## Acceptance criteria

- The repro returns 42 instead of trapping.
- `o.getX()` with `o.x = 99` shadow: dispatches without trapping (value may
  be 42 — shadow boundary documented).
- Zero test262 regressions (full merge_group).
