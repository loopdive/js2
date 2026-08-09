---
id: 4258
title: "`T | undefined` erases undefined into null (or into T) at the type-mapper — silent wrong answers for typeof and === null"
status: ready
created: 2026-08-09
priority: high
horizon: l
feasibility: hard
area: value-rep
goal: core-semantics
related: [2107, 2104, 2106, 2949, 4253]
---

## Summary

`mapTsTypeToWasm`'s union arm collapses `T | undefined` to a representation that
**cannot hold `undefined`**. The value silently becomes `null` (ref case) or a
raw number (primitive case), and every consumer that can tell those apart
answers wrongly.

This is **NOT** a regression from the #2106 `$undefined`-singleton flip, and not
from the #4255 derivation-defaults flip. Both were suspected; both are ruled out
by measurement below. #2106 is the *revealer*, not the cause.

## The site

`src/checker/type-mapper.ts`, the `type.isUnion()` arm:

```ts
if (nonNullish.length === 1) {
  const inner = mapTsTypeToWasm(nonNullish[0]!, checker, fast);
  if (inner.kind === "ref") return { kind: "ref_null", typeIdx: inner.typeIdx };
  // T | undefined for primitives → just use T (e.g. number | undefined → f64)
  return inner;
}
```

Two erasures, both currently intentional:

| shape | lowers to | what happens to `undefined` |
| --- | --- | --- |
| `string \| undefined` | `(ref null $AnyString)` | becomes **null** — indistinguishable from JS `null` |
| `number \| undefined` | `f64` | becomes a **number** |
| `object \| undefined` | `externref` | **correct** — externref can carry the `$undefined` singleton |

The third row is the tell: the shapes that are wrong are exactly the ones whose
non-undefined arm has a narrower-than-externref representation.

## Affected population — READ THIS BEFORE SIZING THE FIX

The blast radius is **not** limited to ref-typed optionals. Measured on
`upstream/main` @ `4e90526dd`, standalone, `typeof pick(0)` and
`pick(0) === null` (JS answers `"undefined"` and `false`):

| declared return | emitted carrier | `typeof` | `=== null` | verdict |
| --- | --- | ---: | ---: | --- |
| `string \| undefined` | `(ref null $AnyString)` | `object` | **true** | BROKEN — aliases null |
| `{ a: number } \| undefined` | `(ref null $struct)` | `object` | **true** | BROKEN — aliases null |
| `number \| undefined` | `f64` | `number` | false | BROKEN — aliases a number |
| `boolean \| undefined` | `i32` | *(neither)* | false | BROKEN — aliases `false` |
| `object \| undefined` | `externref` | `undefined` | false | correct |
| `string \| number \| undefined` | `externref` | `undefined` | false | correct |
| `any` | `externref` | `undefined` | false | correct |

**The rule**: every `T | undefined` where `T` has a narrower-than-`externref`
carrier is broken — native strings, numbers, booleans **and named
struct/interface types**. Only shapes that already land on `externref` (the
`object` keyword, `any`, or a heterogeneous union whose arms force boxing) are
correct.

Three distinct failure modes, which matters because a fix that only addresses
the null-aliasing one is incomplete:

1. **aliases `null`** (ref carriers) — `=== null` answers true;
2. **aliases a number** (`number | undefined`) — `typeof` answers `"number"`;
3. **aliases `false`** (`boolean | undefined`) — `typeof` answers neither
   `"undefined"` nor `"boolean"`-correct semantics, and `=== null` is false, so
   the value is simply gone.

Modes 2 and 3 are wrong in **both** `$undefined`-singleton flag states and are
therefore far older than the #2106 flip. Nobody had observed them, for the same
reason nothing observed this issue at all — see #4253.

Sizing consequence: "optional parameter" and "find-shaped return" cover
`string`, `number`, `boolean` and every interface type, i.e. most optionals in
real code — not a niche.

## Evidence

Measured on `upstream/main` @ `4e90526dd`, standalone.

```js
function pick(i: number): string | undefined { return i > 0 ? "hi" : undefined; }
```

The emitted signature is `(func $pick (param f64) (result (ref null 3)))` — a
nullable native string — so the `undefined` arm is coerced out of existence at
the return boundary.

**`typeof` matrix** (which tag does the compiled code agree with?):

| shape | singleton ON (shipped) | singleton OFF | node |
| --- | --- | --- | --- |
| `string \| undefined` → undefined | **object** | undefined | undefined |
| optional param `f(a?: string)` → `f()` | **object** | undefined | undefined |
| `number \| undefined` → undefined | **number** | **number** | undefined |
| `object \| undefined` → undefined | undefined | undefined | undefined |
| `string \| undefined` → `"hi"` | string | string | string |
| `undefined` literal, `void 0`, `[][0]` | undefined | undefined | undefined |

**Equality, independent of the singleton flag** — this is the cleanest proof
that #2106 is not the cause, since the wrong answer is identical in both:

| expression | got (both flag states) | JS |
| --- | ---: | ---: |
| `pick(0) === null` | **1** | 0 |
| `pick(0) === undefined` | 1 | 1 |
| `pick(0) == null` | 1 | 1 |
| `pick(0) ?? "d"` is `"d"` | 1 | 1 |

`=== null` answering **true** for a value that is `undefined` is the erasure
stated in one line.

## Why #2106 was suspected, and why it is innocent

`tests/issue-2107.test.ts` "undefined-any reports typeof 'undefined'" went red
at `6f7f93c8` **feat(#2106): flip $undefined singleton default ON** (git-bisect,
3,059 revisions, first-bad exact). `JS2WASM_UNDEF_SINGLETON=0` still makes it
pass today.

That looks damning and is not. Under the legacy regime `undefined ≡ null`, so
`typeof null` answered `"undefined"` — and the erased value IS null, so the
test passed **for the wrong reason**. #2106 correctly made `typeof null ===
"object"` (§13.5.3), which converted a masked wrong answer into a visible one.

**Do not "fix" this by reverting or re-gating #2106.** That restores a second
bug whose only virtue is cancelling this one. A pin against exactly that
mistake is in `tests/issue-2107.test.ts`.

## Scope of the fix

The sound fix is that a union containing `undefined` must lower to a carrier
that can represent `undefined` — i.e. `externref` (or `$AnyValue`) rather than
`ref null T` / bare `T`.

**This is a value-representation change with a wide blast radius**, which is why
it is filed rather than patched inline:

- `T | undefined` is extremely common (every optional parameter, every
  `find`-shaped return). Making them all `externref` boxes values that are
  currently native, which costs allocation, size and speed on exactly the
  hot paths #4157 is trying to unbox.
- It interacts with the #2104 canonical tags, the #2106 singleton, and the
  #2949 partition tests.
- It needs a full CI conformance pair plus a standalone-floor measurement, not
  a scoped check.

Cheaper options worth pricing before committing to the general fix:

1. **Only when `undefined` is actually reachable.** If the fixpoint can prove no
   `undefined` reaches the position, keep the narrow carrier. That converts a
   blanket cost into a targeted one.
2. **Nullable-ref plus a distinct sentinel** for the ref case, so `null` and
   `undefined` stay distinguishable without boxing.
3. **Refuse-and-count**: keep the narrow lowering but emit a counted diagnostic
   where an `undefined` could reach it, so the wrong answer stops being silent
   even before it is fixed. *(Tech-lead's initial lean, 2026-08-09, offered as
   a read and not a directive: a counted loud refusal beats a silent null-alias
   while the real fix waits. The choice belongs to this issue, decided with
   measurements.)*

Whichever option is taken, it must cover **all three failure modes** in the
population table above. A fix that only stops the ref carriers aliasing `null`
leaves `number | undefined` and `boolean | undefined` silently wrong.

## Acceptance criteria

- [ ] `pick(0) === null` is `false` and `typeof pick(0)` is `"undefined"` for
      **every** row of the population table: `string | undefined`,
      `number | undefined`, `boolean | undefined`, `{ a: number } | undefined`,
      and an optional parameter.
- [ ] The three already-correct rows (`object`, `any`, heterogeneous) do not
      regress — they are the positive controls, and one of them is already
      pinned in `tests/issue-2107.test.ts`.
- [ ] The `it.fails` markers in `tests/issue-2107.test.ts` are removed, not
      re-marked — they are the acceptance test.
- [ ] CI conformance pair, artifact-vs-artifact (never against the committed
      baseline, #4239), plus a standalone-floor check, since this changes value
      representation on a very common shape.
- [ ] A perf note: whatever the chosen option, record the acorn binary-size and
      compile-time delta, because option (1) vs the blanket fix is exactly a
      cost tradeoff.

## Notes

- Found because `tests/issue-2107.test.ts` was red on `main` and nothing runs
  the root `tests/*.test.ts` population on a cadence — **#4253, Exhibit B**. The
  first two exhibits were stale pins; this one is a real silent wrong answer,
  which is the case that argues the structural gap actually matters.
- The `number | undefined → f64` and `boolean | undefined → i32` rows are wrong
  in **both** flag states and have presumably been wrong far longer than the
  ref row — they cannot have been unmasked by #2106, since they never aliased
  null at all. Nobody had looked, for the same reason nothing looked at any of
  this.
- `{ a: number } | undefined` was initially written into the #2107 test as a
  POSITIVE CONTROL, on the assumption that object types map to externref. They
  do not — an interface maps to a named struct ref and is broken identically.
  The control is now a heterogeneous union, which does force externref. Worth
  recording because it is the same trap this whole issue is about: the shape
  you reach for as "obviously fine" may be in the affected set.
