---
id: 7097
title: "Constant folder: `s.length` of a reassigned `let`/`var` string folds to its initializer's length (seen after an `await`)"
status: done
assignee: ttraenkler/opus-7097-string-await
completed: 2026-10-20
created: 2026-10-19
updated: 2026-10-20
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
language_feature: async/await
goal: architecture
sprint: current
parent: 5385
related: [7094, 7096]
---

# #7097 — string accumulator state across an `await`

Found by #7094 (2026-10-19). `let s = ""; s += "a"; s += "bc"; await p;
s.length` answers 1 on the native lanes where Node answers 3. The
concatenation before the suspension is a string-builder (rope) candidate;
the value saved across the `await` appears to be the builder's first chunk
or a stale snapshot rather than the flattened string, so the resumed code
reads a one-character string.

## Plan

1. Measure: a `.tmp` matrix on native-first and standalone against Node —
   `s += t` once / twice / in a loop before the await, `s.length`, `s`
   itself, `s[1]`, `s.charCodeAt(2)` after the await; the same with the
   string created by `+` (no compound) and by template literals; with the
   string-builder lowering forced off (compile option) to confirm the site.
2. Fix at the identified site: either flatten the builder when it is saved
   into the async frame (`src/codegen/async-cps.ts` save set) or make the
   builder's length/read helpers correct on a resumed frame; keep programs
   without an `await` byte-identical.
3. Tests: a focused test under native-first and standalone vs Node.
4. Acceptance: equivalence gate "No new equivalence regressions"; no host
   import; direct-AST freeze respected.

## Implementation notes (2026-10-20)

### The cause is a constant folder, not the async frame

The await is incidental. The direct-AST constant folder `tryStaticToNumber`
(`src/codegen/expressions/misc.ts`) has an arm that folds `s.length` through the
binding's initializer. Its comment said "const variables", but it never checked
that the binding is `const`: any `let`/`var` with a string-literal initializer
qualified. So in `let s = "a"; s += "bc"; return s.length * 10`, the binary
operator's fold read `s.length` as `"a".length` and emitted `f64.const 10`.

- It fires only where a binary operator runs that folder: `s.length * 10`,
  `s.length + 0`. A bare `return s.length` was always right, and so were `s`,
  `s[1]` and `s.charCodeAt(2)`. That is why the first measurement (bare
  `.length`) could not reproduce it.
- It fires only on the direct-AST path. Every async function is on that path
  (async-CPS), so it looked like an await bug. A sync function the IR declines
  does the same, for example one with a closure capture:
  `var s = "a"; s = s + "bc"; const f = () => s; return s.length * 10` gave 10.
- The string accumulator, the async frame save set and the builder helpers are
  all fine. `async-cps.ts` is not touched, so this does not overlap #7096 and
  does not stack on #7094 (PR 6780).

### Fix

The arm now takes the initializer only when it IS the value:
`ctx.oracle.constInitializerOf(obj)`, or `ctx.oracle.variableInitializerOf(obj)`
when `bindingIsSingleAssignment` proves a `let`/`var` is never written after its
initializer. A never-reassigned `let` keeps folding, so its bytes do not change.
This only narrows an unsound fold and adds no behavior, so the direct-AST freeze
allows it (lead agreed, 2026-10-20). It also drops one raw `ctx.checker` call
(oracle ratchet: `ctx.checker -1`).

Other folds checked for the same missing `const` check: the identifier arm of
`tryStaticToNumber`, `isStaticNaN`, the `substring` receiver check in
`string-ops.ts`, `resolveStrictConstant`/`staticStringLength` and
`resolvesToStringConstant` all check `const` already. No `charCodeAt`/index fold
traces a binding: the two `text.charCodeAt(0)` folds read literal arguments.

### Measurement (`.tmp` probe, Node vs native-first | standalone, before → after)

Body inside `export async function test(): Promise<any>`, `P` = `await Promise.resolve(0);`.

| row | Node | native-first | standalone |
| --- | --- | --- | --- |
| `let s=""; s+="a"; s+="bc"; P return s.length` | 3 | 3 | 3 |
| `… P return s.charCodeAt(2)` / `s[1]` / `s === "abc"` | 99 / "b" / true | right | right |
| `let s="a"; s+="bc"; P return s.length * 10` | 30 | 10 → **30** | 30 |
| `let s="a"; P s+="bc"; return s.length + 0` | 3 | 1 → **3** | 3 |
| `let s="a"; P s = s+"bc"; return s.length * 10` | 30 | 10 → **30** | 30 |
| `let s=""; for(3×) s+="x"; P return s.length * 10` | 30 | 0 → **30** | 30 |
| `let s="z"; s = a+"bc"; P …*10` (`+`) | 30 | 10 → **30** | 30 |
| `let s="z"; s = \`${a}bc\`; P …*10` (template) | 30 | 10 → **30** | 30 |
| `var s="a"; s+="bc"; P …*10` | 30 | 10 → **30** | 30 |
| #7094's row: `let s="a"; const t = await …then(v=>v+"c"); s+=t; return s.length*10 + (s==="abc"?1:0)` | 31 | 11 → **31** | 11 → **31** |
| sync, closure capture: `var s="a"; s=s+"bc"; const f=()=>s; return s.length*10 + (f()==="abc"?1:0)` | 31 | 11 → **31** | 11 → **31** |
| `let s="abc"; P return s.length * 10` (never reassigned, still folds) | 30 | 30 | 30 |

Not part of this issue: `s += await p.then(…)` with a pending promise is
still wrong on upstream main (`a` plus the Promise object); that is #7094's
defect and PR 6780's fix.

The string-builder lowering has no compile option to force off, and it was
never involved (the defect is a compile-time `f64.const`).

### Byte identity

The fold needs a `.length` property access, so a source without `.length`
cannot change. Hashed with main's `misc.ts` and with the branch's, on gc,
standalone and wasi:

- every `.length`-bearing inline source in `tests/equivalence/*.test.ts`: 106
  sources, 318 rows (105/105/104 compiled): **0 differ**;
- every inline source in `tests/*.test.ts` with a string-literal-initialized
  `let`/`var` that is reassigned and read with `.length`: 108 sources, 324 rows
  (107/107/105 compiled): **28 rows differ** (14 gc, 14 standalone, 0 wasi). All 14 changed sources are in
  `tests/issue-6731-generator-residuals.test.ts` (sources #4–#17, gc and
  standalone); each builds `let s=""; … s+=…` and returns
  `…?1:2+s.length`, which used to fold `s.length` to 0. That file still
  passes (21/21).

### Tests

`tests/issue-7097-reassigned-string-length-fold.test.ts`: 12 rows ×
{native-first, standalone}, each against Node. Main: 10 of 24 fail; branch:
24/24 pass.

### Acceptance

- Equivalence gate (single fork, `--configLoader runner`): `20 failing, 2020
  passing, 22 known-failures in baseline` and "✓ No new equivalence
  regressions." The 2 baseline rows now passing (`delete-sentinel`,
  `Reflect.construct`) are the same two that #7094 reported and are unrelated.
- No host import: compile-time fold only. `check:host-import-policy` exits 0.
- tsc: 0 errors. Biome lint: clean. Ratchets: loc, func, coercion sites,
  oracle (`ctx.checker -1`), dead exports and import cycles all OK. No new
  `src/` module.
