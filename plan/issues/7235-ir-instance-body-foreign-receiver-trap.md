---
id: 7235
title: "IR instance getters and methods trap on a foreign receiver where legacy throws a TypeError"
status: ready
sprint: Backlog
created: 2026-11-04
updated: 2026-11-04
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: ir
goal: correctness
related: [7227, 2025, 1571]
---

# #7235: IR instance bodies dereference the trampoline's `ref.null` for a foreign receiver

Found during #7227 (PR #7054), and present on main before it.

```ts
class P { #v = 2; get v(): number { return this.#v; } }
export function test() {
  const d = Object.getOwnPropertyDescriptor(P.prototype, "v")!;
  try { d.get!.call({}); return 1; } catch (e) { return e instanceof TypeError ? -2 : -1; }
}
```

- **node:** -2. **wasi:** -2.
- **gc / standalone:** an uncatchable Wasm trap ("dereferencing a null pointer").

The same happens for instance methods via `m.call({})` or `Reflect.apply(m, {}, [])`.

**Cause:** for a receiver that is not the exact struct,
`__obj_meth_tramp_<C>_<m>_cached` passes `ref.null`. This is deliberate
(#2025; throwing in the trampoline regressed PR #1571 for legitimate non-exact
receivers). Legacy bodies check the receiver before touching a field. IR
instance bodies read the field directly.

**Why #7227 kept JS instance members on legacy:** an entry check would change
every IR instance body, and so the typed-corpus bytes.

**Fix direction:**
- Emit a receiver null check (throw TypeError) in IR instance bodies only where
  the body reads `this` before any other observable effect. That leaves bodies
  that never touch `this` unchanged.
- Or move the check into the trampoline's null branch for IR-bodied slots only.
- Measure the byte delta, and explain every changed binary.

**Acceptance:**
- The repro gives -2 on all 3 lanes, for a getter, a method, and a private and a public field.
- No other observable change.
- Once this is fixed, #7227's JS instance-member fallback can be re-enabled
  (round 1 of #7054 measured +141 extra class-sample IR units).
