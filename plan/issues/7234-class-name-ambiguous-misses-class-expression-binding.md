---
id: 7234
title: "classNameIsAmbiguous misses a class expression bound to the same name"
status: done
completed: 2026-11-05
sprint: current
created: 2026-11-04
updated: 2026-11-05
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: ir
goal: ir-full-coverage
related: [7227, 7054]
---

# #7234: `classNameIsAmbiguous` misses `const C = class {}`

Found in the round-2 review of PR #7054 (#7227).

`classNameIsAmbiguous` (`src/ir/private-member-syntax.ts`) counts named class
declarations and named class expressions. It does not count an anonymous class
expression bound to a variable of the same name. The IR static-call arm then
looks up the wrong shape by name.

```js
class C { static #m() { return 1 } static a() { return C.#m() } }
function f() { const C = class { static #m() { return 12 } static a() { return C.#m() } }; return C.a(); }
export function test() { return f(); } // node 12
```

- **base:** null-pointer trap at runtime.
- **head (#7054):** compile error on all 3 lanes ("prepared implicit constructor
  C_new has no exact installed support pair").

Not worse in practice: base cannot run this program either, and the variant
where `f` is never called already fails to compile on base. A compile error
still loses the whole module.

**Fix:** also count `VariableDeclaration`s (and assignments) whose initialiser is
a class expression, so the static-call arm refuses the ambiguous name.

**Test:** add the repro to `tests/equivalence/issue-7227-ir-class-sync-member-gaps.test.ts`
(or a new `issue-7234-*.test.ts`) on gc, standalone and wasi.

## Implementation Plan (C lead, 2026-11-05; implement on Opus)

Stacked on #7233 (branch `issue-7233-ir-class-stride-blockers`, PR #7059).
Merge `origin/main` once #7059 lands.

1. **Widen the count to every binding of the name, not only class names.**
   The IR static-call and static-field arms key shapes by the *class name*,
   so any other binding that can shadow `C` inside the file makes the lookup
   ambiguous. Examples: `const C = class {}`, `let C = …`, `function C(){}`,
   a parameter `C`, a catch binding, an import alias, or a destructured `{ C }`.
   - In `classNameIsAmbiguous` (`src/ir/private-member-syntax.ts`), count every
     declaration whose *bound identifier* is `name`, plus every named class
     declaration or expression with that name.
   - Use `ts.isVariableDeclaration` with binding-pattern elements,
     `ts.isFunctionDeclaration`, `ts.isParameter`, `ts.isImportSpecifier` /
     `ImportClause` / `NamespaceImport`, `ts.isBindingElement` and
     `CatchClause.variableDeclaration`.
   - Refuse when the count is greater than 1.
   - Purely syntactic: no checker or oracle call, so the oracle ratchet is
     unaffected.
2. **Check every caller**: `staticMethodOwner…` and the #7233
   `staticPrivateFieldOwner`. Both must go through the same predicate.
   Nothing else changes.
3. **Never worse than legacy**: a refusal only sends units back to legacy, so
   the only risk is lost IR coverage.
   - Measure it with the #7227/#7233 1524-file class sample (A/B IR units)
     and the stride ledger. Expect zero or near-zero loss: test262 class files
     rarely rebind the class name.
   - The typed corpus must stay byte-identical on gc, standalone and wasi.

## Acceptance criteria

- The repro above compiles on all 3 lanes, and `f()` returns node's 12 or base's
  result; it must not be a compile error.
  - If base traps at runtime on the IR-free path, record base's result and
    keep the unit on legacy.
- Test: `tests/equivalence/issue-7234-class-name-ambiguous.test.ts`, run on 3 lanes,
  covering the `const C = class {}` repro plus `let`, `function`, parameter
  and import shadows. Each case pins the legacy route (`trackIrOutcomes`) and
  base's value.
- Class-sample IR units lost: 0, or each loss listed and justified.
- Ledger stride 40 is unchanged or higher. 0 invariants.

## Result (2026-11-05)

`classNameIsAmbiguous` now counts every value binding of the name: class
declaration/expression, function declaration/expression, variable (incl. catch),
parameter, destructuring element, import clause/specifier/namespace/import-equals.
Both callers (`staticPrivateThisCallClassName`, `staticPrivateFieldOwner`) and the
select.ts private-call arm already go through it; nothing else changed.

- **Repro:** compiles on all 3 lanes. `C.a` stays legacy, and `f()` traps
  (`dereferencing a null pointer`), the same as the IR-free path
  (`experimentalIR: false`) and pre-#7054 base. The trap is a pre-existing
  legacy bug with two same-named class shapes. The `f`-never-called variant
  still hits the `C_new` compile error, unchanged from base (unrelated to this
  predicate).
- **Class sample** (1524 files, ALLUNITS, standalone/gc/wasi): head JSON
  byte-identical to base on every lane. IR units lost: 0.
- **Ledger** stride 40 standalone: identical (ir 38, both 25, legacy 1620,
  neither 37, invariant 0).
- **Typed corpus** (2293 units × gc/standalone/wasi): byte-identical.
- **Test:** `tests/equivalence/issue-7234-class-name-ambiguous.test.ts`, 23 tests.
  All pass on head; 22 fail on base.
