---
id: 3541
title: "Standalone: String.fromCodePoint.apply(null, vec) returns null (__str_concat null-deref) — the then-current gate on the RegExp property-escapes 311-row family"
status: done
created: 2026-07-23
updated: 2026-07-23
completed: 2026-07-23
priority: high
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
goal: standalone
sprint: 75
horizon: m
umbrella: 2860
assignee: ttraenkler/fable-2860
related: [2860, 3536, 3535, 2088, 3138, 3139, 3549]
loc-budget-allow:
  - src/codegen/expressions/call-builtin-static.ts
  - src/codegen/expressions/calls.ts
files:
  - src/codegen/expressions/call-builtin-static.ts
  - src/codegen/expressions/calls.ts
  - tests/issue-3541.test.ts
---

# Standalone: `String.fromCodePoint.apply(null, vec)` returns null

## Problem

With the #3536 call-boundary fix landed, every one of the **311
`built-ins/RegExp/property-escapes/generated/` baseline rows** now advances
into `regExpUtils.js`'s `buildString` — and hits this defect. All 311 run the
SAME harness function, so fixing this one path flips the family (measured
gate, not an extrapolation: 15/15 sampled tests die here and nowhere else,
via the real sharded worker).

Minimal repro — no functions, no params, plain top level, pre-existing
(unrelated to #3536; reproduces on main before it):

```js
var v = [0x41, 0x42, 0x43];
var s = String.fromCodePoint.apply(null, v); // s is null, not "ABC"
if (s !== "ABC") throw new Error("bad: " + s);
// → dereferencing a null pointer [in __str_concat ← __module_init]
```

Compiled shape (binaryen disasm): the call routes through the generic
`__call_m_apply_2(closureWrapper(__builtin_static_String_fromCodePoint),
null, extern.convert_any(vec))` — the apply runtime does not spread a native
`$vec_f64` into the builtin-static's variadic lowering; the result lands
null and the first consumer (`__str_concat` from `result += …`, or the
strict-compare against the expected string) null-derefs.

Second blocker in the SAME harness function (verify while here): the
grown-array variant

```js
const codePoints = [];
for (let length = 0, cp = start; cp <= end; cp++) codePoints[length++] = cp;
result += String.fromCodePoint.apply(null, codePoints);
```

fails with `illegal cast [in buildString]` — likely the empty-literal array's
vec type vs the apply path's expected carrier. 41 of the 198 re-measured
null-deref census rows now show exactly this signature.

## Direction

Options, in rough preference order (verify against the compiled shape
before choosing):

1. Special-case `<builtin fromCharCode/fromCodePoint>.apply(thisArg, arr)`
   at the call site (calls.ts already flattens STATIC array literals for
   `.apply`) — lower a dynamic array/vec argument through the same
   per-element loop `compileFromCharCodeFamily` uses, reading the vec at
   runtime (length + elem loop into the variadic concat primitive). Zero
   changes to the generic apply runtime.
2. Fix `__call_m_apply_2`'s native-vec argv handling for builtin-static
   closures generally (bigger blast radius — the fnctor/apply machinery
   borders #3138/#3139; coordinate before touching).

## Acceptance

- The minimal repro passes standalone (s === "ABC").
- The grown-`codePoints` variant passes (no illegal cast).
- ≥ measured-majority of a 15-test property-escapes sample flips to PASS
  through the real worker (the tests additionally exercise `\p{…}`
  unicode-property RegExp matching — measure, don't assume; if the RegExp
  engine lacks the property tables, record the residual honestly).
- Zero host-lane changes (standalone-scoped or verified byte-identical).

## Implementation (landed 2026-07-23; stacked on #3536)

Option 1, in the subsystem module: `tryCompileFromCharCodeFamilyReflective`
(`src/codegen/expressions/call-builtin-static.ts`), wired as a precise-match
arm in the `.call/.apply` dispatch of `compileCallExpression`
(`expressions/calls.ts`). Native-string lanes only; the host lane and every
non-matching shape fall through byte-identically.

- `.call(thisArg, …codes)` → synthetic direct `String.fromX(…codes)` (reuses
  the #2088 fold + #2601/#2875 guards wholesale; thisArg evaluated first).
- `.apply(thisArg)` / empty array → `""`.
- `.apply(thisArg, arr)` with a STATICALLY-typed native vec → destructure +
  shared `emitStringJoinFold` over the elements: §7.1.8 ToUint16 in the f64
  domain (fromCharCode) / §22.1.2.2 integral+[0,0x10FFFF] RangeError guard
  (fromCodePoint); i8/i16/i32/f64/externref(boxed) elements; #3224-style
  backing bounds check (absent index ⇒ undefined semantics); null argArray ⇒
  empty list.
- `.apply(thisArg, arr)` with an EXTERNREF value (the #3536 struct-narrowed
  callee shape — `const lone = args.pts` reads through the dynamic member
  path, wrapping the vec) → `any.convert_extern` + guarded 2-way `ref.test`
  dispatch over `$vec_f64` / `$vec_externref`, nullish ⇒ empty list, other
  non-array-like ⇒ §Function.prototype.apply TypeError.
- Re-eval-safety gate (identifier / literal / null / single member access on
  an identifier / array literal) so the bail-to-legacy path can never double
  side effects.

## Measured results (2026-07-23, combined #3536+#3541 tree)

- All 7 repro probes pass (top-level vec, struct-field, in-function
  struct-narrowed; each buildString body variant incl. the grown
  `codePoints` shape that formerly hit `illegal cast`).
- `tests/issue-3541.test.ts`: 8/8 (ToUint16, RangeError, surrogate pairs,
  empty/absent arrays, `.call`).
- **Full 311-row property-escapes family through the real worker: 0/311
  flips.** The apply layer is fixed and the wall MOVED one layer deeper —
  304/311 now die at `RangeError: regular expression step limit exceeded`
  in the native RegExp engine matching `^\p{…}+$` over the built
  multi-thousand-char strings; 6 are `RGI_Emoji…`/`Basic_Emoji` sequence
  properties; 1 misc. Filed as **#3549** with the per-signature tally —
  the honest lesson of the #3536 census (2/198 vs the ~1,190 naive
  extrapolation) applied: this fix's direct test262 yield is whatever the
  CI baselines show for non-PE `fromCharCode/fromCodePoint.apply` users,
  NOT the 311.
- Battery: typecheck · string-methods/arrow-call-apply/iife equivalence
  (123 tests) · issue-3536+3541 tests (13) · check:ir-fallbacks ·
  oracle-ratchet (no new checker usage) · prettier/biome — all green.
