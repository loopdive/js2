---
id: 4095
title: "Wire the missing `String.prototype` member arms in standalone (`slice`/`concat`/`substr`) — mechanical, existing native helpers"
status: ready
sprint: current
created: 2026-08-02
updated: 2026-08-02
priority: medium
horizon: s
feasibility: easy
reasoning_effort: low
task_type: bug
area: standalone
es_edition: ES5
language_feature: string-methods
goal: standalone-mode
related: [4056, 4096, 2742]
---

# #4095 — the missing reflective `String.prototype` member arms

Seven `String.prototype` members have **no arm** in `emitStringProtoMemberBody`
(`src/codegen/array-object-proto.ts:813`) and fall through to
`emitProtoMemberBodyRefusal`, which throws:

```
TypeError: String.prototype.<M> is not yet implemented in --target standalone
```

Affected: `slice`, `trim`, `concat`, `split`, `substr`, `localeCompare`,
`search`. (`trim` refuses **by design** since the #3954 carve-out, which traded
the P2 shape for the P1 shape — do not "fix" it here without re-running that
A/B.)

This is a **loud** refusal, which is why it is filed separately from — and at
lower priority than — #4096, where the same area returns a **silent null**.

## Measured population

Scanning all **48,619** standalone baseline rows for that literal message:
**27 failures, 22 of them host-pass.**

| member | fail | host-pass |
| --- | --- | --- |
| `String.split` | 9 | 8 |
| `String.slice` | 4 | 3 |
| `String.search` | 2 | 2 |
| `String.concat` | 2 | 2 |
| `Symbol.valueOf` | 2 | 2 |
| `Date.toJSON` | 2 | 1 |
| `String.replace` | 2 | 1 |
| `Object.toString` | 2 | 1 |
| `String.valueOf` | 1 | 1 |
| `WeakRef.deref` | 1 | 1 |

This is a **floor, not a ceiling** — a test that catches the TypeError fails
with a different message and is not counted here. But nothing measured supports
a large flip estimate: the realistic in-scope slice is `slice` + `concat`
(≈5 host-pass files).

## Scope

**Do:** `slice`, `concat`, `substr`. Their native helpers already exist —
`__str_slice`, `__str_concat`, `__str_substr` are all registered in
`src/codegen/native-strings-basics.ts`. `localeCompare` only if genuinely
trivial (`__str_compare` exists).

**Do NOT do:** `split`, `search`, `replace`. They need the standalone RegExp
engine and/or `$ObjVec` array construction; they balloon well past a mechanical
arm and belong with the RegExp-engine work.

**Hard cap:** any arm that needs more than the in-tree pattern gets dropped
rather than grown.

## Implementation notes (read before starting — saves the rediscovery)

Copy the shape of `emitStringSubstringMemberBody` in
`src/codegen/string-proto-substring.ts` — it is the closest correct reference
and it is only ~70 lines. Its structure, in order (the order is observable and
load-bearing):

1. `ensureNativeStringHelpers` / `ensureObjectRuntime`, then
   `flushLateImportShifts` when `undefinedSingletonActive(ctx)`.
2. Register the only late import (`ensureExternrefToNumberProvider`) **first**,
   before fetching any helper index by name — the #1448 index-shift discipline.
3. Fetch `anyToStrIdx` / `toPrimitiveIdx` / `flattenIdx` / the member helper;
   if any is missing, `emitRefusal`.
4. `RequireObjectCoercible(this)` — param 1, `ref.is_null` **or**
   `__extern_is_undefined` (the #2106 undefined singleton is a distinct
   non-null sentinel, so a bare `ref.is_null` misses it).
5. Reject Symbol receivers explicitly — `__any_to_string` deliberately provides
   a printable fallback that abstract ToString must not accept.
6. `ToString(this)` via `__to_primitive("string")` → `__any_to_string` →
   `__str_flatten`, into a local.
7. **Only then** convert the numeric arguments (order matters: bound coercion
   must happen after `ToString(this)`).
8. The reflective ABI pads an omitted argument with **null**, and canonical
   standalone `undefined` is a *distinct* sentinel — recognise **both**.

Closure ABI: `this` = param 1, first arg = param 2, second = param 3.

`slice` differs from `substring` only in negative-index handling, which
`__str_slice` already does internally — so it should be close to a rename.
`concat` takes `$AnyString` args rather than i32 bounds.

## Acceptance criteria

- `slice`, `concat`, `substr` return spec-correct values in standalone for the
  transferred shape (`obj.M = String.prototype.M; obj.M(...)`) on a receiver
  whose static type does **not** trip #4096 (use a wrapper receiver such as
  `new Number(1234)`, which is on the working dynamic path).
- The refusal no longer fires for those three.
- `substring` / `charAt` unmoved — they are the references; if a change breaks
  them the change is wrong.
- No new host imports in standalone (the #2961 leak gate).
- Report pass→fail and fail→pass with denominators; re-run any apparent
  regression solo.

## Correction chain (read this before quoting any earlier number)

This issue is the tail of a three-step chain of corrections. Keeping the chain
readable is deliberate — each step was refuted by measurement, not opinion:

1. **#4056** — filed as "`String.prototype` generic receivers in standalone,
   218/630 ≤ES5 failures". Premise: #2742's default-lane fix never reached
   standalone.
2. **PR #4032** (diagnosis record on #4056) — **premise REFUTED.** #2742 *did*
   reach standalone (#3954, 2026-08-01). Fresh baseline: **130**/630, not 218.
   Split into two sub-defects: (a) missing member arms — *this issue*; and
   (b) "the reflective wrapper's ToString diverges for Array/RegExp".
3. **#4096** — **sub-defect (b) as stated was ALSO wrong.** Reading the emitted
   WAT showed there is no wrapper call at all for those receivers: the call is
   lowered to `ref.null extern`. Sub-defect (b) and the largest unexplained
   bucket in #4056 are **one mechanism**, and it is a silent-wrong-answer
   correctness bug, not a coercion defect.

So #4056's framing is superseded in part by #4096, and the "generic receivers"
label is misleading: the receiver kind only matters because it decides whether
the checker treats the type as closed.
