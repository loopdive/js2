---
id: 3594
title: "codegen: static `super.<prop>` reads model no receiver — static members are compiled instance-shaped (silent 0 for fields, invalid Wasm for getters)"
status: ready
sprint: current
created: 2026-07-25
updated: 2026-07-25
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: classes-static-super
goal: correctness
related: [3024]
# The #3024 static-super CALL-ARITY fix ships in the same change-set as this
# issue file (branch issue-3024-static-super-arity). +24 LOC in new-super.ts:
# ~7 lines of fix, the rest load-bearing comments recording WHY the getter path
# is deliberately left unpadded (a naive pad emits ref.null + ref.as_non_null =
# runtime trap). Those comments are the guard against the next agent re-making
# the rejected fix, so the growth is intended.
loc-budget-allow:
  - src/codegen/expressions/new-super.ts
---

# #3594 — static `super.<prop>` reads have no receiver to pass

Split out of the #3024 umbrella while landing the static-super **call-arity**
fix (`compileSuperMethodCallCore`, branch `issue-3024-static-super-arity`). That
slice fixed `super.m(arg)` in a static method. The **property-read** half is a
**distinct root cause** and is deliberately left unfixed there — see
"Why the obvious fix is wrong" below before touching this.

## Root cause (one cause, two symptoms)

A **static** class member is compiled **instance-shaped** — it takes a receiver
param typed as the class's struct:

```wat
(func $Base_get_x (param (ref null 1)) (result f64))   ;; static getter!
```

But a **static method has no `this` local** (`fctx.localMap.get("this")` is
`undefined`), so there is no receiver to pass. `src/codegen/expressions/new-super.ts`
guards the receiver push on that lookup and then proceeds as if a receiver were
always present.

The correct model: in a static method `this` is **the class**, and
`super.<prop>` must resolve against the **parent class object**. The fix is to
**model the CLASS as the receiver** for static-context super property reads (and,
consistently, for static member access generally) — not to paper over the
missing argument at the call site.

## Symptoms (both measured on `origin/main`, default gc lane)

| shape                                  | today                                                                      | severity                           |
| -------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------- |
| `super.<plain static field>` in static | **valid Wasm, silently returns `0`** — emits `f64.const 0`                 | **worst — wrong answer, NO error** |
| `super.<static getter>` in static      | invalid Wasm: `not enough arguments on the stack for call (need 1, got 0)` | loud                               |
| `super.<static setter>` in static      | valid (unchanged)                                                          | ok                                 |
| instance `super.prop` / `super.get x`  | valid + correct (unchanged)                                                | ok                                 |

**The silent-`0` case is the dangerous one and it is live on `main` today.** A
wrong answer with no error is worse than the invalid-Wasm one: it can make an
assertion pass vacuously. Prioritise it accordingly.

Repro (both):

```ts
class Base {
  static x: number = 13;
}
class C extends Base {
  static m(): number {
    return super.x;
  }
}
export function test(): number {
  return C.m();
} // returns 0, expected 13

class Base2 {
  static get x(): number {
    return 9;
  }
}
class C2 extends Base2 {
  static m(): number {
    return super.x;
  }
}
export function test2(): number {
  return C2.m();
} // invalid Wasm
```

WAT evidence (so the next owner need not re-derive it):

```wat
;; plain static field — no call at all, just a default
(func $C_m (type 7)
  f64.const 0
  return)

;; static getter, WITH a naive receiver pad applied — TRAPS
(func $C_m (type 8)
  ref.null 1
  ref.as_non_null      ;; <- traps on null
  call 2
  return)
```

## Why the obvious fix is wrong (do NOT do this)

"Pad the missing receiver with the type default" **was tried and rejected**
while landing the #3024 call-arity slice. For a `(ref null <Base>)` param the
default pad is `ref.null` + `ref.as_non_null`, which **traps at runtime**. That
trades a loud compile-time validation error for a guaranteed runtime trap —
strictly worse. The getter path was therefore left emitting invalid Wasm on
purpose. Any fix must supply a **real** receiver (the class), not a placeholder.

## Existing KNOWN-OPEN assertions (these will flip)

`tests/issue-3024-static-super-arity.test.ts` pins today's broken behaviour so a
fix surfaces loudly rather than silently:

- `KNOWN-OPEN — static super.<plain field> silently reads 0 (pre-existing)`
  asserts the result **is `0`**
- `KNOWN-OPEN — static super.<getter> still emits invalid Wasm`
  asserts validation **fails** with `/not enough arguments on the stack/`

Whoever fixes this **must update both** to assert the correct values (`13` and
`9` respectively). Their failure is the signal the fix worked, not a regression.

## Acceptance criteria

- `super.<plain static field>` in a static method returns the field's value
  (`13` in the repro), not `0`.
- `super.<static getter>` in a static method compiles to valid Wasm **and**
  returns the getter's value (`9`), with no runtime trap.
- Controls unchanged: instance `super.prop` / `super.get x`, static
  `super.<setter>`, and the static `super.m(arg)` call arity fixed under #3024
  (`tests/issue-3024-static-super-arity.test.ts` controls stay green).
- The two KNOWN-OPEN assertions are updated to the correct expectations.

## Notes

- Do not size this from the two test262 rows that surfaced it. Like the call-arity
  slice, this is a **general correctness bug** — any `super.<prop>` in a static
  method is affected. Measure the corpus footprint with denominators before
  claiming a number.

## Note — renumbered from #3589

Originally filed as **#3589**, which collided with
`plan/issues/3589-assert-harness-null-deref-unmasked-by-3563.md` (PR #3582,
merged first — id reserved on `origin/issue-assignments` at
2026-07-24T22:30:26Z, ~5 min before this branch's PR was opened). The collision
was caught by the `--check` duplicate-id gate in the `merge_group`, which
auto-parked PR #3581 with a `hold`.

Renumbered to **#3594** (fresh id via `claim-issue.mjs --allocate`) by the
PR-queue shepherd, since the authoring session was unreachable. Purely
mechanical: file rename plus the `id:` frontmatter and the heading. No other
file referenced this id, and no source, test or expectation was touched.
