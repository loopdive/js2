---
id: 7216
title: "`Object.keys` on a subclass instance typed as its base class lists only the base's keys"
status: done
completed: 2026-11-04
sprint: Backlog
created: 2026-10-31
updated: 2026-11-04
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: classes
goal: correctness
related: [7199, 7156, 7158, 7201]
# 2026-11-04: `ownKeysSubclassRoute` (src/codegen/class-arm-tag-guard.ts)
# keeps one deliberate wasi condition. On wasi, `Object.values`/`entries`
# on a subclassed static class keep the compile-time fold. The wasi
# `__object_values`/`__object_entries` natives have no closed-struct arm
# (`nonObjectEnumerableOwnInstrs` is standalone-only) and would answer [],
# which is worse than base. Widening that native gate to wasi changes the bytes
# of every wasi program that builds the object runtime (66 of 131 no-subclass
# corpus programs), so it is left to a follow-up. This adds +1 ctx.standalone
# and +1 ctx.wasi in that one condition.
standalone-arms-allow:
  - src/codegen/class-arm-tag-guard.ts
# 2026-11-04: each consumer gains one route call into class-arm-tag-guard.ts,
# where the decision logic lives. The growth that remains is the call, its
# comment, and the line breaks prettier forces when a fourth `||` term is
# added (+3/+3/+2/+2 lines).
loc-budget-allow:
  - src/codegen/object-ops.ts
  - src/codegen/statements/loops.ts
func-budget-allow:
  - src/codegen/object-ops.ts::compileObjectKeysOrValues
  - src/codegen/object-ops.ts::compilePropertyIntrospection
  - src/codegen/statements/loops.ts::compileForInStatementInner
  - src/codegen/binary-ops-in.ts::compileInOperator
---

# #7216 — Object.keys sees the static type, not the instance

Found while implementing #7199, confirmed on main by the PR #7017 review
(gc and standalone):

```ts
class Animal { name = 'a' }
class Dog extends Animal { breed = 'b' }
const xs: Animal[] = [new Dog()];
console.log(Object.keys(xs[0]).join());   // node: name,breed — we: name
```

`JSON.stringify(xs[0])` is correct, so `Object.keys` picks its arm from the
static type instead of the runtime struct.

## Plan

1. Find the `Object.keys` lowering for a class-typed receiver and make it
   dispatch on the runtime type (or fall back to the runtime path) when the
   class has subclasses.
2. Check `Object.entries`, `Object.values`, `for…in` and spread the same way.
3. Tests on 3 lanes against node.

## Resolution (2026-11-04)

**Cause.** Every own-key consumer folded from the receiver's STATIC struct.
`compileObjectKeysOrValues` (`object-ops.ts`) expanded the static class's field
list at compile time. The no-host for…in path (`loops.ts`) sent a class struct
to the static unroll (`emitForInStaticUnroll`). `hasOwnProperty`
(`object-ops.ts`) and `in` (`binary-ops-in.ts`) folded against the static field
list. A receiver typed `Animal` that holds a `Dog` is a longer subtype struct at
runtime, so the subclass-only fields were missing. `JSON.stringify`, spread,
`Object.getOwnPropertyNames` and `Object.assign` already enumerated at runtime
through the `__tag`-guarded closed-struct arms (#7158), which is why they were
right.

**Fix.** New predicates in `src/codegen/class-arm-tag-guard.ts` ask whether
any emitted class extends the static struct. When one does, the consumer uses
the runtime path the `any` receiver already uses:

| Consumer | Change |
| --- | --- |
| `Object.keys` / `values` / `entries` | route to the runtime `__object_<method>`, with the §7.1.18 ToObject nullish guard. Two exceptions keep the fold: a receiver re-flagged by `Object.defineProperty` (only the compile-time filter honours those flags), and wasi `values`/`entries` (see frontmatter). |
| for…in | treat as a dynamic receiver (`__object_keys_forin`) |
| `hasOwnProperty` / `propertyIsEnumerable` | runtime `__hasOwnProperty` / `__propertyIsEnumerable` |
| `k in o` | a folded `false` is re-asked through `__extern_has`. A positive fold is unchanged. |

Every other receiver keeps its fold, so its bytes do not move:
- a class that no class extends;
- the constructor itself (`typeof C`, review round 2). It lowers to the same
  struct ref, but its own keys are the statics. Routing it made
  `A.hasOwnProperty("s")` false. The test262 harness rewrites
  `Object.prototype.hasOwnProperty.call(C, k)` to exactly that call.
- a `C.prototype` receiver (review round 3). It is typed as an instance of
  `C`, but its own keys are the methods. The fold already answers it, and on
  wasi the runtime `__hasOwnProperty` inverts it (`(A.prototype)
  .hasOwnProperty("m")` would read `false`). The test262 harness rewrites
  `Object.prototype.hasOwnProperty.call(C.prototype, k)` to that call.
- a receiver that is provably a `new` of the static class. That is a `new X()`
  expression, or a `const` (or a `let`/`var` that nothing writes again)
  initialised from one, where `X` is the static class or a constructor-typed
  value. A `new` of a subclass (`const y: A = new B()`) takes the runtime path.
  Without this, `const a = new A(); Object.keys(a)` paid about +67 KB and
  15–20× the run time for an answer the fold already had right. It is now
  byte-identical to base (42,005 / 36,951 / 53,496 B on gc / standalone /
  wasi).

**Evidence.**
- `tests/equivalence/issue-7216-object-keys-subclass.test.ts` covers 16 rows on
  gc, standalone and wasi against node. The `values`/`entries` rows skip wasi.
  The rows include 3-level chains, an abstract base, a twin-layout sibling,
  parameter properties, class expressions, `this` in a base method, private
  fields and accessors, inline `.length`/index, a null receiver, and a
  leaf-typed receiver.
- The neighbouring tests for #7156, #7158, #7199, #7200, #7201 and #7215 pass.
- A/B against base: 131 no-subclass programs on 3 lanes are byte-identical.
  The corpus is every case in `tests/equivalence/issue-6*`/`issue-7*` with no
  `extends`, plus 8 own-key probes and the playground examples.
- 133 subclass probes show no row that passes on base and fails on head.
  They are my 37 probes plus the 96 review probes (c1–c7), including the
  constructor-receiver set. The constructor and exact-`new` probes are
  sha-identical to base on all 3 lanes.
- A runtime path that genuinely needs it still costs its runtime. A mixed
  `xs[i & 1]` receiver on gc goes from 42.8 KB and 5 ms to 110 KB and 135 ms
  per 200k `Object.keys`. Base gave the wrong answer there.

**Left open (separate causes):**
- wasi `Object.values`/`entries` on a class instance answer `[]` even through
  `any`. The natives lack the #7201 closed-struct arm. On a subclassed static
  class they keep the base (static) answer.
- `const o = Object.assign({}, inst)` typed `{} & C` reads back through the
  closed struct: `JSON.stringify(o)` is `null`, even with no subclass.
  `JSON.stringify(Object.entries(inst))` is `[null]` on base for a plain class.
  Head fixes the subclassed case.
- `"n" in x`, where `n` is a method only the subclass declares, is `false`
  through `any` as well. `__extern_has` does not walk a subclass prototype.
- `Object.defineProperty(o, k, { enumerable: false })` on a class instance is
  ignored by the runtime enumerators (`Object.keys(o)` through `any` lists
  `k`).
- `new K()` with `K: typeof P` bound to a subclass `Q` constructs a `P`
  (`instanceof Q` is false).
- Constructor receivers, same as base: `B.hasOwnProperty("s")` for an
  inherited static answers `true`, and for…in over a class lists `prototype`.
- `x!.hasOwnProperty(k)` on a null `x` returns `false` instead of throwing.
  `__hasOwnProperty` has no RequireObjectCoercible guard.
