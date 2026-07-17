---
id: 3311
title: "G4 — `string[]` push/pop under standalone is a no-op: native-string vec carrier missing from `__vec_push`/`__vec_pop` mutEntries"
status: ready
created: 2026-07-16
priority: medium
horizon: s
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen, standalone
language_feature: arrays
goal: runtime-eval
sprint: current
parent: 2927
related: [2784, 2928, 1584]
---

# #3311 — G4: add the native-string vec carrier to `__vec_push` / `__vec_pop`

Slice **G4** of the #2928 `CallBuiltin` prerequisites
(`docs/architecture/runtime-eval-interpreter.md` §16; #2927 Part-2 audit gap 3).
A **soft** prerequisite of E5 (degrades to `undefined` until landed).

## Problem

The carrier-generic `__vec_push` / `__vec_pop` helpers (built in
`src/codegen/vec-access-exports.ts`; the `mutEntries` filter at line ~414 —
NOT index.ts as the #2927 audit note said) cover only the externref / f64 /
i32 element carriers. The native-string vec carrier (WasmGC
`ref $NativeString` elements, the standalone rep of `string[]`) is not in the
set, so:

- `__vec_push` returns the `-1` unsupported-carrier sentinel → the #2927
  `$__vec_base` brand arm (closed-method-dispatch.ts ~849–917, PR #2592)
  deliberately maps that to `undefined` — so `(a as any).push("x")` on a
  `string[]` is a silent no-op standalone.
- `__vec_pop` returns `null.extern` (`undefined`) for the same receivers.

No regression was introduced by #2592 (it was already broken — the old
fall-through also returned `undefined`); this issue is the actual fix.

## Implementation plan (distilled)

1. In `vec-access-exports.ts`, extend the `mutEntries` element-kind filter
   (~line 414) to admit the native-string carrier
   (`ref_null ctx.nativeStrTypeIdx` elements).
2. In the `__vec_push` fill (~line 485–520): the incoming externref value for
   a string carrier converts `any.convert_extern` + `ref.cast $NativeString`
   before `array.set` (mirror the f64/i32 arms' unbox step; the boxed side is
   already a `$NativeString` under nativeStrings — no numeric unbox).
   Grow-and-append logic is carrier-generic already.
3. In the `__vec_pop` fill: the popped `ref $NativeString` element boxes back
   via plain `extern.convert_any` (anyref subtype — no `__box_number`).
4. Also check `__vec_get`/`__vec_set`/`__vec_len` for the same carrier gap
   while in the file (the read guards at ~377 may already cover it — verify,
   don't assume).
5. Tests: standalone `const a: any = ["a","b"]; a.push("c")` → returns 3,
   `a[2]==="c"`, `a.length===3`; `a.pop()==="c"`; 0 function imports asserted.

## Acceptance criteria

- [ ] `string[]` push/pop via the any-receiver brand arm works standalone
      (values, length, return values correct; host-free).
- [ ] The `-1` sentinel path still returns `undefined` for genuinely
      unsupported carriers (no bogus boxed `-1` length).
- [ ] Existing #2927 push/pop suite (`tests/issue-2927-standalone-any-push-pop.test.ts`)
      stays green.

## Notes

Filed under #2784 lineage per the #2927 audit ("fix belongs in the
`__vec_push`/`__vec_pop` carrier set, not the brand arm"). Umbrella:
#2927 → #1584.
