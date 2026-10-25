---
id: 7145
title: "Native-first: inlined anyref result passed to an externref import without extern.convert_any (invalid wasm)"
status: in-progress
sprint: current
created: 2026-10-25
updated: 2026-10-25
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: builtins
goal: correctness
parent: 6979
related: [6899, 2787, 6708]
---

# #7145 — Native-first: inlined anyref result passed to an externref import without extern.convert_any (invalid wasm)

Surfaced by PR #6899 (S7-a): the differential-test harness had to drop its
`semanticProviders: "host-assisted"` pin, so `scripts/diff-test.ts` now measures
the default native-first profile and `builtins/03-map-set.js` went `match → compile_error — `Compiling function #96`
against the host-lane baseline. Reproduced on `origin/main` (96c5de84be) with the
pin removed: **pre-existing native-first gap, not S7-a code** (diagnosis
2026-10-25, PR #6899 review thread). Hidden since S6 (#6708) because the harness
pinned the host lane (#2787 note: "S7 owns removing or replacing this host-only
evidence").

## Observed

`builtins/03-map-set.js`: compile_error — `Compiling function #96:"__module_init" failed: call[0] expected type externref, found block of type anyref`

## Cause (as diagnosed; verify before fixing)

`console.log(m.get("a"))`: the inliner splices `__map_get` (locals `__inl8_p0 (ref null 52)`, `__inl8_p1 anyref`; `map-runtime.ts:779`) as `block (result anyref)` straight into the externref `console.log` import with no `extern.convert_any`. Emitting site: `src/codegen/ir-inline.ts` `inlineUserFunctions`, the splice `block blockType: blockTypeFor(calleeType.results)` (≈L1470), probably on the #6759 precomposed Map-adapter (`specBody`) path. With `JS2WASM_IR_INLINE=off` the file matches, but that also changes the import set (19 → 6), so the attribution is likely, not proven.

## Implementation Plan (Fable, 2026-10-25; implement on Opus)

1. Reproduce with a 3-line program (`const m = new Map(); m.set("a",1); console.log(m.get("a"))`) on gc native-first; dump WAT, locate the call.
2. Prove the attribution: diff WAT with `JS2WASM_IR_INLINE=off`; if the inliner is the site, the fix is in the splice — the spliced block's result type must be coerced to the call-site's expected param type (`coerceType` from `src/codegen/type-coercion.ts`, the `ref → externref` arm = `extern.convert_any`), i.e. the inliner must honour the *caller's* operand type, not the callee's result type, when they differ by representation.
3. If the site is the precomposed Map adapter instead, fix the adapter's result type declaration so the inliner's `blockTypeFor` sees externref.
4. Add the program to `tests/equivalence/` (standalone + gc) and a WAT assertion that no `block (result anyref)` feeds an externref import.

Acceptance: `npx tsx scripts/diff-test.ts` row for `builtins/03-map-set.js` is `match` on gc
native-first and standalone; the equivalence suite is byte-identical on every
program that does not reach the changed path (state the byte delta for those
that do, in the PR body); a test under `tests/issue-7145-*.test.ts` pins the
case on standalone and gc.
