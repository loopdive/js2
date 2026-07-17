---
id: 3364
title: "Widened empty-object struct shape clobbered by a same-named var in an unrelated function (bare-name keying)"
status: done
completed: 2026-07-17
assignee: ttraenkler/dev-i
sprint: current
created: 2026-07-17
priority: high
horizon: m
feasibility: medium
task_type: bug
area: codegen
language_feature: object
goal: correctness
parent: 2927
related: [3343, 3308, 2937, 3024]
depends_on: []
# (#3364) `resolveWidenedVarKey` resolves a USE-site receiver identifier to its
# variable DECLARATION (for the per-declaration widening key) via
# `checker.getSymbolAtLocation` → `symbol.valueDeclaration`. This is raw
# symbol/declaration IDENTITY, not a type query — `ctx.oracle` (which answers
# type questions) cannot express it, and it mirrors the 296 existing
# `getSymbolAtLocation` sites in codegen. Sanctioned oracle-ratchet allowance.
oracle-ratchet-allow:
  - src/codegen/widened-var-key.ts
# (#3364) The per-declaration widening key threads through the existing widened
# lookup sites in these god-files; the change is a small in-place key swap
# (bare name → name+declStart), a few lines each — not new subsystem logic that
# belongs elsewhere. The bulk of the fix lives in the new leaf module
# src/codegen/widened-var-key.ts.
loc-budget-allow:
  - src/codegen/context/types.ts
  - src/codegen/registry/imports.ts
  - src/codegen/statements/variables.ts
  - src/codegen/typeof-delete.ts
  - src/codegen/expressions/unary-updates.ts
  - src/codegen/property-access.ts
  - src/codegen/literals.ts
---

# #3364 — widened `{}` struct shape clobbered by a same-named variable elsewhere

Found while root-causing #3343. **Distinct from** the #3343 fix (which addressed
a `for (let i)` loop-counter aliasing a module global, in `loops.ts`). This bug
**still reproduces on `main` after #3343 landed** — verified in a scratch
worktree at `upstream/main`.

## Problem

`const x = {}` followed by out-of-shape property writes (`x.p = …`) is promoted
to a **static struct** by the empty-object shape-widening pre-pass
(`src/codegen/declarations/object-shape-widening.ts`). The synthesized struct
shape was recorded in `ctx.widenedTypeProperties` / `ctx.widenedVarStructMap`
keyed by the **bare variable name**.

That key collides across functions. Acorn's parser (and the #3308 in-Wasm AST
probe) reuse generic local names — `node`, `type`, `parent` — in many
functions, each building an object with a **different field set**. With
bare-name keying, the **last** widening for a given name overwrote every other
same-named var, so every other same-named var's literal built the **wrong
(foreign) struct**:

- its real field values were computed and then **dropped** at `struct.new`
  (WAT shows a degenerate 1-field `struct.new` with the extra operands
  `drop`ped),
- while the field getters still read the correct struct via `ref.test` →
  **type mismatch** → `ref`/string fields (`.callee`, `.type`, `.arguments`, …)
  read back **null**.

Scale-dependent purely because more functions ⇒ more name collisions — the same
symptom that surfaced as the #3308 / #3343 in-Wasm recursive-walk runaway, but a
**separate cause** from the loop-counter bug fixed under #3343.

## Minimal repro (standalone, no acorn)

```ts
function ident(k: number): any { const node: any = {}; node.type="Identifier"; node.start=k; node.name="v"; return node; }
function call(callee: any, args: any): any {
  const node: any = {};
  node.type="CallExpression"; node.callee=callee; node.arguments=args; node.optional=false; return node;
}
// UNUSED, same local name 'node', DIFFERENT shape → clobbers call's struct.
function foo(e: any): any { const node: any = {}; node.expression = e; return node; }
export function test(): number {
  const cl = call(ident(1), [ident(2)]);
  return (cl.callee !== null && cl.callee !== undefined) ? 1 : 0; // pre-fix: 0
}
```

Renaming `foo`'s local `node` → `zzz` makes it pass — proof the trigger is the
bare-name collision.

## Root cause

`widenedTypeProperties` / `widenedVarStructMap` keyed by `decl.name.text`.
`any`-typed widened vars in particular rely on this name key (they skip
`anonTypeMap`, which is bypassed for the shared `any` singleton type), so the
last same-named widening wins for both the constructor and the local typing.

## Fix

Key both maps **per declaration** (name + declaration start offset) —
`src/codegen/widened-var-key.ts`:

- `widenedVarKeyFromDecl(name)` at SET / declaration sites (the widening
  pre-pass, `literals.ts` `compileWidenedEmptyObject`, `statements/variables.ts`).
- `resolveWidenedVarKey(ctx, ident)` / `widenedStructNameForUse(ctx, ident)` at
  USE sites (member reads/writes, `delete`, element-access import gating):
  resolve the receiver identifier's symbol → `valueDeclaration` → recompute the
  same key.

Non-colliding modules are **byte-identical** (the same struct is resolved, via a
different key string); only same-name / different-shape collisions change (to
correct).

Updated use sites: `property-access.ts`, `statements/variables.ts` (×2),
`expressions/unary-updates.ts`, `registry/imports.ts`, `typeof-delete.ts` (×2),
`object-ops.ts` (×3).

## Acceptance criteria

- [x] A same-named local in an unrelated function no longer clobbers a widened
      object's read shape (standalone).
- [x] Every field of a widened object survives when a same-named var exists
      elsewhere.
- [x] A full recursive in-Wasm walk of a heterogeneous AST-shaped tree (node
      builders reusing generic local names) terminates with the exact node
      count — `tests/issue-3364.test.ts`.

## Notes

- Likely also reduces the **#3024** "`struct.new` — not enough args" gc-lane
  validator-error cluster (same degenerate-struct mechanism). #3024 is a broad
  131-test multi-cause bucket with a separate owner — left open; cross-linked.
- 98 widening-suite tests pass unchanged
  (#2584/#2849/#2937/#2944/#2372/#3125 + object-literals + getters/setters).
