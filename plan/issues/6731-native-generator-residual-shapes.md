---
id: 6731
title: "Native generator residuals after the #680 prettier slice: for-of body throw does not IteratorClose, break/continue/return/yield* in a yielding for-of, `??` statements, rest in destructuring declarations, string-carrier spread"
status: done
sprint: current
created: 2026-09-28
updated: 2026-09-29
completed: 2026-09-29
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: standalone-mode
loc-budget-allow:
  # 2026-09-29 (#6731 tailwindcss slice): +201, the planner's jump-target stack,
  # lexical-rename wiring and emit-site swaps; the lowering itself lives in the
  # new generator-structured-jumps.ts / generator-lexical-renames.ts modules.
  - src/codegen/generators-native.ts
func-budget-allow:
  # 2026-09-29 (#6731): same growth, planner closure + emit-site rename swaps.
  - src/codegen/generators-native.ts::buildNativeGeneratorPlan
  - src/codegen/generators-native.ts::compileState
  - src/codegen/generators-native.ts::ensureNativeGeneratorResumeFunction
---

## Context

The #680 prettier slice (2026-09-28) taught the standalone native generator
planner four shapes: `&&` / `||` / `?:` / comma expression statements with a
yield in a deferred operand, `for (x of <non-iterator subject>)` over the
native `__iterator` protocol, non-numeric branch conditions (canonical
ToBoolean), and destructuring-declaration locals as frame spills. These are
the edges it deliberately left, each measured or read from the code.

## Residuals

1. **A runtime throw from a yielding for-of BODY does not IteratorClose the
   loop's iterator** (§14.7.5.7 step 6). The linearised loop closes it on an
   abrupt RESUME (`.return()` / `.throw()` at a yield — `dstr-close` unwind
   entry) and on a throwing loop op, but plain body statements are not wrapped.
   Shared with A2's `lowerForOf` and the #6651 A4 pattern-head loop.
2. **`break` / `continue` / `return` / `yield*` inside a yielding for-of body
   still refuse the generator** (same gates as the pattern-head loop).
3. **`A ?? (yield B);`** is not desugared (its test is nullishness, not
   ToBoolean), nor is a yield in the CONDITION operand of `&&` / `||` / `?:`.
4. **Rest elements of a destructuring declaration** (`let {a, ...r} = o`) are
   still not spilled (the destructure re-allocates the rest slot, #971), so a
   read after a suspension sees the frame default. Non-rest names are fixed.
   The JS-host lane keeps the pre-slice behaviour for all of these (not
   measured there).
5. **Spreading a native string-carrier generator into `any[]`** yields an empty
   array: `[...(function*(){ yield "x"; yield "y"; })()]` has length 0 in
   standalone (for-of over the same generator sees both values). Pre-existing
   on main `2e23e49fb1`.
6. Scoped standalone test262 rows still refused with the #680 diagnostic
   (2026-09-28, generators + GeneratorPrototype + yield + for-of-with-generators
   scope): `built-ins/GeneratorPrototype/return/try-finally-set-property-within-try.js`,
   `language/expressions/yield/from-with.js`, `language/expressions/yield/rhs-regexp.js`,
   `language/statements/generators/scope-param-rest-elem-var-{open,close}.js`.

## Acceptance

Each item fixed or split with a regression test that fails on its parent;
scoped standalone test262 over the same four directories with no losses.

## tailwindcss slice (2026-09-29)

tailwindcss 4.3.3's standalone-dynamic lane, after the #1472 `Error.captureStackTrace`
slice, refused six generators of `package/dist/lib.mjs` with the #680 diagnostic
(12:2985 `ti`, 12:6739 `ii`, 15:26560 `Tt`, 16:1078 `Bl`, 16:2978 `Ii`,
21:2285 `Gi`; the seventh the #1472 Resolution lists, 16:13983 `sa`, already
compiles on main `c8b4f0ef36`). The planner's refusal points, located with a
temporary stack dump in its `fail()` (not committed):

| generator | refusal | shape |
| --- | --- | --- |
| `ii` | `lowerFor` → `loopBodyHasUnsupportedJump` | `if (…) break;` in a yielding `for (;;)` |
| `Tt` | `lowerStatements` generic arm | a nested `function* i(…) {…}` declaration (its own yields/returns made the statement "structural") |
| `Bl` | `lowerForOf` | `for (let [r, t] of map)` binding-pattern head |
| `Ii` | linear for-of `failed`, then spill typing | `yield* Ii(e, s, r)` in a for-of body; `if (r.add(i), yield …, …, i.includes("/"))`; `let n = Array.from(set).sort(…)` (`any[]` spill unresolved) |
| `Gi` | linear for-of `failed` | `switch` with a yielding case (and `break`) in a nested for-of |
| `ti` | `lowerForOf` | pattern-head for-of whose body has `continue` / `return`; a dozen shadowed block `let`s (`m` ×5, `u`/`v`/`h`/`y` ×3-4) of number / string / object types |

### Implementation Plan (executed)

All standalone/WASI only (`noJsHostTarget`); the JS-host lane keeps every
pre-slice gate.

1. **Structured jumps** — new `src/codegen/generator-structured-jumps.ts`. The
   planner keeps a stack of jump targets (one per structurally lowered
   `while` / `do` / `for` / for-of / `switch` / labelled block: break state,
   continue state, unwind depth). A statement holding a `break` / `continue`
   that escapes it (`statementHasEscapingJump`) is structural; the jump becomes
   a `jump` terminator after leaving the crossed unwind entries innermost-first
   (a yield-free `finally` is replayed, a linearised for-of record is closed
   with a normal-completion IteratorClose, §14.7.5.7 step 6; a state-lowered
   `finally` or an A2 `for-of-step` record refuses). `loopBodyHasUnsupportedJump`
   now only gates the JS-host lane.
2. **`switch`** (§14.12.4) — discriminant evaluated once into a frame spill,
   selectors in source order minus the default (= the spec's A-then-B order),
   IsStrictlyEqual via `__extern_strict_eq` (new `strict-eq` linear op), case
   bodies consecutive states (fall-through = jump), default reached last.
3. **Labelled statements** — labels are handed to the loop / `switch` they
   label; any other labelled statement is a block whose `break l` lands after it.
4. **`return` / `yield*` in a linearised for-of** — the refusals in
   `planForOfLoop` are gone. A `return` crossing a `dstr-close` record uses
   the delegated-return terminator's unwind walk (value first, then the
   return-completion close); a string carrier still refuses (its `abrupt`
   field is f64). A for-of A2 cannot carry (pattern head, a jump or `return`
   in the body) takes the linear drive even over a typed iterator
   (`forOfNeedsLinearDrive`).
5. **Binding-pattern for-of heads** — `planBindingPattern` drives
   `let [k, v]` / `const {k, v = d}` through the same get-iter / step / rest /
   get-prop / default / put-ident ops as assignment patterns; each name must be
   a typed frame spill (a rest element or an unstorable type refuses). The
   PutValue const guard (`isConstIdentifierAssignmentTarget`, shared) exempts a
   BindingElement's own name, as it already did a VariableDeclaration's — it is
   the binding's initialisation.
6. **`if` comma conditions** — `splitYieldingIfCondition`: `if (A, B, C) S` ≡
   `A; B; if (C) S` when a discarded operand yields and `C` does not.
7. **Self-contained nested function declarations** — a direct-child
   `function`/`function*` declaration referencing no generator binding but its
   own name is straight-line and hoisted to the start of the body
   (`isSelfContainedNestedFunction`). A capturing one keeps the refusal
   (measured: a mutation of a captured param after a yield was invisible to it).
8. **Block-scoped shadowing** — new `src/codegen/generator-lexical-renames.ts`.
   A nested `let`/`const` whose name is declared more than once in the
   generator gets its own spill (`<name>$lex<k>`); at emission every source
   node is compiled with the variants whose scope range contains it swapped
   into `localMap` (statements, linear ops, terminator operands, replayed
   finalizers). Before, all same-named bindings shared one slot typed by the
   first: `ti` emitted invalid Wasm (`f64.ge` on an externref slot).
9. **`any[]` spills** — the array-literal externref fallback of the spill typer
   now covers any `any[]` binding (`Array.from(set).sort(…)`).
10. **Re-declared generator names** — a second `function* f` (nested in another
    function) is registered as `f__redecl<n>` (#3505) with no funcMap entry; the
    factory-identity lookup now falls back to the function being compiled
    (`Missing native generator factory identity`, pre-existing on main, reached
    by tailwindcss's `Ml` / `f` once `f` became plannable).

### Resolution

- Regression test `tests/issue-6731-generator-residuals.test.ts`: parent
  **20 failed / 1 passed**, fix **21 / 21** (the plain yielding `while` row
  passes both ways — anti-vacuity control). Rows are tailwindcss's `ii`, `Tt`,
  `Bl`, `ti` verbatim (with stubbed helpers) plus reductions: `switch`
  fall-through, comma-condition yields, recursive `yield*` in a for-of,
  IteratorClose on `break` / `return` (observed `return()` calls), labelled
  jumps, `finally` replay on jumps, const / object pattern heads, shadowing,
  and the re-declared generator name.
- npm-compat tailwindcss, `--only tailwindcss --no-write --perf-only --lane standalone-dynamic`,
  same checkout, parent vs fix:
  - parent: `compile-error` — `Codegen error: native generator lowering currently supports only sequential numeric yields in standalone/WASI targets (#680). Recompile with a JS host target for complex generator shapes.`
  - fix: `compile-error` — `struct hierarchy layout became invalid before finalization: subtype #196 (U) supertype #93 (Map) is no longer an exact mutable-field prefix`
  - Full fix-side list (from a direct `compileProject` of the lane driver): no
    #680 error left; 2 × struct hierarchy layout invalid (`U`,
    `__anonClass_70`, subclasses of `Map` —
    [#6754](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6754-standalone-map-subclass-struct-layout)),
    1 × stack-balance invariant (`__anon_87_parseCandidate` references local 37
    of 13), host-import-leak warnings `env.Intl_ListFormat_new`,
    `env.Intl_ListFormat_format`, `env.Promise_all`.
- Scoped STANDALONE test262 (`scripts/run-test262-paths.mts --standalone`, 680
  rows: `language/statements/generators`, `language/expressions/generators`,
  `built-ins/GeneratorPrototype`, `language/expressions/yield`): parent
  **651 pass / 17 fail / 12 CE**, fix **651 / 17 / 12**, identical per-row
  non-pass set (6 of the fails are the local box's missing quickjs eval
  provider, both sides).
- JS-host output byte-identical: sha256 of `gc` compiles of 1,096 sources (the
  680 rows above, a third of `language/statements/{for-of,const,let}/dstr`,
  and every probe fixture of this slice), parent vs fix, 0 differences.
- Generator unit tests (70 files, 919 tests): 17 failures, the same 17 on the
  parent (`issue-2173-yieldstar-generic-iterable`, `issue-2864` carrier R1/D2,
  `issue-3526-*`, `issue-4922`).
- JS-host dogfood control: `tests/dogfood/tailwindcss-upstream-suite.mjs` 13/13.

### Residuals

Items 1, 3, 4, 5 and 6 of the original list are not touched by this slice and
move to
[#6753](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6753-native-generator-residuals-after-tailwind),
with the edges this slice leaves:

- a jump or `return` crossing a state-lowered `finally` or an A2 `for-of-step`
  record refuses; a `return` in a linearised for-of of a string-carrier
  generator refuses;
- a capturing nested function declaration in a generator body refuses;
- a binding-pattern for-of head with a rest element (or a yield in a default)
  refuses.

Pre-existing standalone runtime defects met while writing the fixtures (not
generator lowering, reproduced without a generator) are
[#6755](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6755-standalone-runtime-defects-found-by-6731).
