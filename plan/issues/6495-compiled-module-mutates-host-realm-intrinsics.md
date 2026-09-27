---
id: 6495
title: "A compiled module can mutate the HOST process's intrinsics — `__get_builtin` hands out the real `Array.prototype` unless a narrow source regex fires"
status: done
sprint: current
created: 2026-09-17
updated: 2026-09-17
completed: 2026-09-17
priority: high
horizon: l
feasibility: hard
reasoning_effort: max
task_type: bug
area: runtime
goal: test262-conformance
depends_on: []
related: [1957, 3451, 4394, 6482]
---

# #6495 — realm isolation for intrinsics reachable from a compiled program

## Problem

A compiled program that does `delete Array.prototype[Symbol.iterator]` deletes
it **from the test process**, not from the row's realm. Everything downstream of
that point — every later row in the same worker, the runner's own iteration —
runs against a corrupted `Array.prototype`. In the linked-harness lane it does
not even degrade gracefully: the vitest worker **hangs** and the row never
returns a verdict.

### Why the sandbox does not stop it (measured 2026-09-17)

The runner *has* a per-row realm. `tests/test262-runner.ts` builds one with
`vm.createContext` (`_buildFreshSandbox`, ~L102) and passes it as
`buildImports(..., { globalSandbox: sandbox })`. But whether the compiled module
actually *sees* that realm's intrinsics is gated twice:

1. `src/runtime.ts` `resolveImport` (~L11213):
   ```ts
   const builtin = <T>(name: string, fallback: T): T =>
     coherentBuiltinRealms.has(globalSandbox!) ? ((globalSandbox![name] as T | undefined) ?? fallback) : fallback;
   ```
   Unless the sandbox was registered with `markCoherentBuiltinRealm`, `builtin`
   returns the **fallback** — and the fallback for `__get_builtin` is
   `(globalThis as any)[n]`, i.e. the host process's own constructor:
   ```ts
   if (name === "__get_builtin") return (n: string) => builtin(n, (globalThis as any)[n]);
   ```

2. `markCoherentBuiltinRealm` is called only when a **source regex** matches
   (`tests/test262-runner.ts` ~L4491):
   ```ts
   const coherentBuiltinRealm = requiresCoherentBuiltinRealm(originalSource);
   ```
   `HOST_INTRINSIC_DEFINE_RE` matches a literal
   `Object.defineProperty(Array.prototype, …)` **in the test body**. It is
   documented as "deliberately narrow".

So a row whose intrinsic mutation happens **inside the harness** rather than in
its own source text is unprotected. That is the entire `propertyHelper` family:
`verifyProperty` → `isConfigurable(obj, name)` → `delete obj[name]`, with `obj`
an intrinsic prototype the body merely *passed in*. The regex cannot see it —
the body says `verifyProperty(Array.prototype, Symbol.iterator, {...})`, which
contains no `defineProperty` call at all.

The mutation itself lands in `__delete_property` (`src/runtime.ts` ~L16502),
whose first arm is an unguarded native delete:

```ts
if (!_isWasmStruct(obj)) {
  try {
    const k = typeof key === "symbol" ? key : String(key);
    return delete obj[k] ? 1 : 0;
```

`__defineProperty` / the property-set imports have the same shape.

### Instrumented evidence (#6482 round 1, reconfirmed round 2)

With the two-line symbol brand of #6482 mechanism 2 applied (so the key arrives
as a real `Symbol.iterator` instead of the number `1`):

```
[del] symbol Symbol(Symbol.iterator) wasmStruct:false hostArrayProto:true
```

`hostArrayProto:true` is `obj === Array.prototype` of the **worker's** realm.
The delete succeeds, array iteration is gone process-wide, and the worker never
returns.

Today those 31 rows "pass" in the honest lane **partly by accident**: without
the brand the key crosses as the number `1`, so `delete Array.prototype[1]` is a
harmless no-op and `!hasOwnProperty(obj, 1)` is trivially true.

### Relationship to the #1957 realm canary

`tests/test262-shared.ts` already detects this class after the fact — the
`[realm-canary] drift after test#N` / `[pool] recycling worker: realm drift
(#1957)` lines fire routinely on ordinary runs (observed live 2026-09-17 on
`Array.prototype.forEach.name:changed` and `Object.prototype.__proto__:changed`).
The canary **contains** the damage by throwing the worker away; it does not
prevent it, it costs a worker restart each time, and it cannot help when the
corrupting delete hangs the worker before the canary runs.

## Blocking relationship

**#6482 mechanism 2 cannot land until this does.** Branding `Symbol.iterator`
across the linked call boundary (`src/codegen/property-access-dispatch.ts`
~L3777, gated on link role) is a two-line change that fixes the 31
`N should be an own property` rows' own-property reads — and converts a fast
failure into a process hang, because the real symbol key makes the
`isConfigurable` delete *effective*. Order is: realm isolation first, then the
brand, then re-measure the 31 rows.

## Implementation plan

Three candidate shapes, cheapest first. All are measured against the honest lane
— rows that currently pass **by** mutating a host builtin are the blast radius.

### Option A — widen the classifier (cheap, still a sniff)

Extend `HOST_INTRINSIC_DEFINE_RE` / `requiresCoherentBuiltinRealm` to fire for
any body that passes an intrinsic to a harness helper
(`verifyProperty(Array.prototype, …)`, `verifyNotConfigurable`, …). Cost: one
fresh VM realm per matched row. Risk: the next unanticipated path re-opens the
hole — this is the same failure mode that produced the current gap.

### Option B — coherent realm by default (correct, biggest radius)

Call `markCoherentBuiltinRealm(sandbox)` unconditionally, so `builtin()` always
resolves through the row's realm. This is the design the sandbox was built for;
the conditional exists only because the broad case was never measured. Required
measurement before flipping: an honest slice of at least
`built-ins/Array/prototype/**`, `built-ins/Object/**` and every
`propertyHelper`-using path, before and after, with the flips enumerated (not
just the net).

### Option C — refuse the mutation at the boundary (narrow, defensive)

Make `__delete_property` / `__defineProperty` refuse to mutate an object that is
an intrinsic of the **host** realm and not of the sandbox realm. Smallest
radius, and it converts silent corruption into a well-defined refusal — but it
is a guard bolted onto the wrong layer: the module should never have been handed
the host object in the first place.

**Recommendation: B, with A as the fallback if B's honest-lane radius proves
unaffordable.** B removes the class; A and C only narrow it.

## Acceptance criteria

- [x] A compiled program's `delete Array.prototype[Symbol.iterator]` does not
      change the test process's `Array.prototype`; a dedicated test asserts the
      host intrinsic is untouched afterwards.
      (`tests/issue-6495-host-realm-intrinsics.test.ts`)
- [x] The honest lane's blast-radius slice (named above) shows every flip
      enumerated and justified — net is not sufficient evidence.
      (2,102 rows, ZERO flips — table below.)
- [ ] **NOT met, and deliberately so:** `[realm-canary] drift` still fires, for
      intrinsic METHODS (`Array.prototype.forEach.name:changed`). The prototype
      is realm-resolved; the method read off it is not. See "Residual" below —
      this is the remaining half of the class, not an oversight.
- [x] #6482 mechanism 2's two-line symbol brand applied without the worker
      hanging; the rows re-measured in both lanes (linked 68 → 98 / 114, honest
      unchanged).

## Resolution (2026-09-17, Opus lane) — Option B, measured

`tests/test262-runner.ts` now calls `markCoherentBuiltinRealm(sandbox)` for
**every** row, unconditionally. `HOST_INTRINSIC_DEFINE_RE` and
`requiresCoherentBuiltinRealm` are deleted — a source-sniffing gate on a
security-shaped property is exactly the failure mode that produced this issue,
and keeping it as a fallback would only preserve it.

### Honest-lane blast radius: ZERO rows changed across 2,102

Every arm run in this worktree with the real runner
(`tests/test262-chunk-dynamic.test.ts`, one chunk, path-filtered), A/B by
reverting the single runner line and re-running:

| honest slice | rows | before | after | flips |
| --- | --- | --- | --- | --- |
| #6482 descriptor bucket | 114 | 105 | 105 | 0 |
| for-in / own-property / vec | 818 | 699 | 699 | 0 |
| realm-sensitive: Symbol, Reflect, `instanceof`, `bind`, `Object.prototype.toString`, `getPrototypeOf`/`setPrototypeOf`/`create`, `isArray`, `concat`, NativeErrors, Error, RegExp `exec` | 1,170 | 933 | 933 | 0 |

The conditional existed only because the broad case had never been measured.
It costs one extra `vm.createContext` per row; wall-clock on the 1,170-row
slice went 437 s → 618 s, which is the price of the realm, not a regression.

### What it unblocked

#6482 mechanism 2's two-line link-role-gated symbol brand
(`src/codegen/property-access-dispatch.ts`) could then be applied without the
worker hanging: linked descriptor bucket **68 → 98 / 114 (+30, 0 regressions)**.

Guard: `tests/issue-6495-host-realm-intrinsics.test.ts` — a compiled
`delete Array.prototype[Symbol.iterator]` and a compiled
`Object.defineProperty(Object.prototype, …)` both leave the test process's own
intrinsics untouched, and the host can still iterate an array afterwards.

### Residual — intrinsic METHODS are still the host's

`__get_builtin` is realm-resolved, so `Array.prototype` and `Object.prototype`
are now the row's. A **method** of an intrinsic is reached by a further property
read off that prototype, and that read still hands back the HOST function:
`Object.defineProperty(Array.prototype.forEach, "name", { value: "clobbered" })`
in a compiled program does clobber the test process (measured 2026-09-17). This
is what the #1957 realm canary still reports as
`Array.prototype.forEach.name:changed`, and it still fires on ordinary runs.

There is deliberately **no test** for it: the only way to observe the gap is to
perform the corruption, which would poison every later file in the vitest
worker. The note lives at the bottom of
`tests/issue-6495-host-realm-intrinsics.test.ts`.

Next step for whoever picks this up: find where a property read off a
realm-resolved intrinsic prototype resolves its value (the `__extern_get` /
builtin-method carrier path), and make it resolve the method from the same
realm the prototype came from. The canary's own drift log is the ready-made row
list — every `[realm-canary] drift after test#N` line names the intrinsic that
escaped.
