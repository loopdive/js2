---
id: 3546
title: "codegen: module TOP-LEVEL closure reassignment writes only the __module_init local shadow — cross-function calls read the stale first closure from the global"
status: done
assignee: ttraenkler/fable-3546
completed: 2026-07-23
pr: 3512
sprint: Backlog
created: 2026-07-23
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: closures
goal: correctness
related: [3534, 3533]
loc-budget-allow:
  - src/codegen/expressions/assignment.ts
  - src/codegen/statements/variables.ts
  - src/codegen/context/types.ts
---

# #3546 — `let f = () => 1; f = () => 2;` at module top level: `f()` from another function returns 1

## Repro (verified 2026-07-23 on post-#3505 main; gc lane)

```ts
let f = (): number => 1;
f = (): number => 2;
export function test(): number {
  return f();
}
// test() === 1   (want 2)   — binary sha256-16: d57a1b35964e0b09
```

`var` behaves identically (`module_var_reassign` → WRONG got=1). This is
PRE-EXISTING relative to #3534/#3505 (same WRONG result + same binary hash on
the pre-#3505 baseline) — it is the ASSIGNMENT-path sibling of the #3534
declaration-path family, not a regression.

## Scoping matrix (probe `.tmp/probe-3546.mts`, kept in the #3534 owner's notes)

| shape                                                       | result          |
| ----------------------------------------------------------- | --------------- |
| module top-level reassign, call from exported fn            | **WRONG got=1** |
| reassign inside a function (`set2()` writes `f`), then call | PASS            |
| purely local `let f = …; f = …; f()`                        | PASS            |
| module top-level `var` reassign                             | **WRONG got=1** |

## Mechanism (verified by the scoping split; exact write-arm to confirm)

The declaration's arrow path in `variables.ts` dual-stores the closure: it
`local.tee`s a **local shadow of `f` inside `__module_init`** and boxes the
value into the `$__mod_f` externref global. A LATER top-level reassignment
statement compiles inside the same `__module_init` fctx, where
`fctx.localMap.has("f")` is true — the assignment takes the LOCAL write arm and
updates only the shadow local. The module global — which every OTHER function's
read/call of `f` resolves through — still holds the first closure. The
function-scope variant passes precisely because `set2`'s fctx has no local
shadow, so the assignment writes the global.

## Suggested direction

In the assignment path, when the write target has BOTH a local shadow in the
current fctx AND a module global (`ctx.moduleGlobals.has(name)`), mirror the
declaration's dual-store: write the local AND box-on-store
(`extern.convert_any` for a precise closure ref — the #3534 invariant: the
global stays externref, never narrowed) into the global. Alternatively drop the
`__module_init` local shadow entirely and route top-level reads through the
global; the dual-store is the smaller change.

## Acceptance criteria

- The repro returns 2 on both lanes; `module_var_reassign` likewise.
- ~~The #3534 corpus (sha256s in that issue file) stays byte-identical except
  the reassignment shapes.~~ **Amended (see Implementation Notes):** the fix
  deliberately changes the declaration emission for EVERY top-level closure
  declaration (externref shadow local), so corpus entries with a top-level
  closure decl change bytes by design. The behavioral bar replaces the byte
  bar: all 13 corpus cases must be runtime-PASS; the three entries with no
  top-level closure decl stay byte-identical.
- No new invalid-Wasm signatures; equivalence suite delta zero.

## Implementation Notes (2026-07-23, fable-3546 — resumed from fable-3534's WIP)

Two coupled changes in `compileVariableStatement` (variables.ts) + one new
sync hook in `compileAssignment` (assignment.ts), wired through
`fctx.moduleBindingShadowLocals` (context/types.ts):

1. **The `__module_init` shadow local for a top-level closure decl is now
   EXTERNREF, not the precise closure struct.** WHY: the dual-store fix needs
   later reassignments to flow through BOTH stores. If the shadow stays
   precise-typed, a reassignment whose RHS is a _different_ closure struct
   (different captures) forces assignment.ts to RETYPE the local mid-function —
   the exact #3534 retro-invalidation mechanism one slot over (earlier emitted
   code validated against the old struct type). Uniform externref removes the
   retype hazard entirely and keeps top-level LOOP shapes correct (reads always
   go through the still-current externref local). Cost: top-level reads/calls
   inside `__module_init` take `compileClosureCall`'s guarded externref arm —
   cold code, module init runs once. Cross-function call cost is unchanged
   (already guarded per #3534; perf follow-up is #3550).
2. **`bindsModuleGlobal` gate:** only a genuinely top-level (`stmt.parent` =
   SourceFile) lexical decl binds the `$__mod_<name>` global. Pre-fix, a
   `let`/`const` closure inside a top-level BLOCK stored into the OUTER module
   binding (`{ let f = () => 7; }` clobbered module `f` — got=7 measured).
   `var` keeps the module store from any top-level block (§10.2.10); function
   bodies were already gated by `hasLocalShadow`.
3. **`emitModuleShadowGlobalSync`** (assignment.ts): after the local-arm
   `local.tee` of a name whose exact local index is registered in
   `moduleBindingShadowLocals`, re-push the local and `global.set` the module
   global (box-on-store if needed — the #3534 invariant: the global stays
   externref, never narrowed). Exact name→index match keeps it inert for
   genuine function locals and block shadows. Called at all three return paths
   of the plain `=` local arm; indices read fresh post-RHS (string-constant
   global shifts can't stale them).

Rejected alternative: dual-store only in the assignment path keeping the
precise local. Fails on (a) different-struct reassignment (retype hazard
above) and (b) top-level loops (a read compiled before the reassignment would
keep reading the stale precise local on iteration 2).

Residual (out of scope, same family, far narrower): compound/logical
(`f ||= …`) and destructuring (`[f] = […]`) writes to a top-level closure
binding go through different assignment arms that still update only the
shadow local. The plain `=` reassignment fixed here is the shape test262 and
user code actually hit; extend `emitModuleShadowGlobalSync` to those arms if
a real case surfaces.

## Test Results (2026-07-23, measured runtime verdicts)

- `tests/issue-3546-toplevel-closure-reassign.test.ts` (8 tests): **5 FAIL on
  origin/main src (got=1 stale closure ×4, got=7 block clobber), 8/8 PASS
  post-fix** — wrong-answer assertions, not absence-of-trap.
- Standalone lane probe (7 shapes): **5 WRONG pre-fix → 7/7 PASS post-fix**
  (same shapes as host lane; `module_let_reassign`, `module_var_reassign`,
  `capture_state`, `toplevel_call_between`, `block_shadow_control` all fixed).
- #3534 13-case corpus: **13/13 runtime PASS** (`var_reassign_call` flipped
  WRONG d57a1b35964e0b09 → PASS c73447cf308a9e10). Byte-identical where no
  top-level closure decl exists: `capture_mutable` 7bbcc06bbb9ccfa1,
  `closure_capture_call_sibling` 5885800c56b700ee, `returned_closure`
  cd89dcc51ddd41d9. The other 10 changed bytes (deliberate, see note 1);
  all PASS, zero invalid-Wasm.
- Guard suites: issue-3534 (6), issue-3024 family, module-globals,
  issue-329, issue-2800 — green. issue-1690b (4 fails) and issue-3505
  (2 fails) fail IDENTICALLY on origin/main src in this container
  (`string_constants` import harness gap / missing test262-fyi submodule) —
  pre-existing, delta zero.
- Full equivalence dir (213 files / 1646 tests): matched-pair JSON runs,
  fixed tree vs origin/main src — **identical 35 failing tests on both, zero
  flips in either direction** (all pre-existing in this container, matching
  #3534's documented run). Delta exactly zero.
- Edge probes (host lane): `export_let_reassign` PASS, `reassign_in_loop`
  PASS (=122: first iteration reads closure 1, second reads 2 — the shape the
  rejected precise-local alternative would break), `different_captures` PASS
  (reassignment to a closure with a different capture set — the retype-hazard
  shape — is valid Wasm and correct).
