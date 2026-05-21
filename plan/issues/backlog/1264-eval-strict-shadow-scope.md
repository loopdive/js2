---
id: 1264
title: "eval tier 4: strict-mode direct eval — optimistic unboxed locals + shadow scope deopt"
status: backlog
created: 2026-05-02
updated: 2026-05-02
priority: high
feasibility: hard
reasoning_effort: max
task_type: feature
area: codegen
language_feature: eval, strict-mode, deopt
goal: performance
depends_on: [1261]
required_by: [1266]
---
# #1264 — eval tier 4: strict-mode direct eval — optimistic shadow scope + null-check deopt

## Background

In strict mode, `eval` gets its own lexical environment. Function declarations and `var`
declarations do **not** leak into the enclosing scope. This eliminates the main worst-case
scenario (tier 5 function replacement) entirely.

What strict-mode direct eval *can* still do: assign to existing variables in the enclosing scope:

```js
"use strict";
let x = 1;
eval('x = 42'); // works — x is now 42
```

## Proposed approach

Keep locals unboxed (f64, i32, etc.) on the fast path. Instead of boxing, provide eval with a
**shadow scope** — a heap-allocated `struct` that mirrors the variables reachable by eval:

```wat
;; synthetic shadow for function with let x: number, let s: string
(type $EvalShadow (struct
  (field $x (mut f64))
  (field $s (mut externref))
  (field $written (mut i32))   ;; bitmask: which fields were written
))
```

**Call sequence**:
1. Before `eval(str)` — write current local values into shadow struct
2. Call host `eval` with the string + a reference to the shadow struct
3. After `eval` returns — check `shadow.$written` (null-check on the struct or bitmask):
   - **Zero (common case)**: eval didn't write anything. Continue on the fast path with unboxed locals. Zero additional cost beyond the null-check.
   - **Non-zero, type-compatible**: eval wrote to `x` but kept it `f64`. Read back from shadow, update the local. Continue on the fast path.
   - **Non-zero, type changed**: eval wrote a non-number to `x`. Branch to the **deopt continuation** — a duplicate of the remaining function body compiled with boxed locals (all locals as `externref`). This is the only code bloat, and it only affects the suffix of the function after the eval call.

**Alternative (--no-eval-scope-write flag, #1266)**: skip shadow entirely; throw `TypeError` at runtime if eval attempts to write to an enclosing scope variable. Opt-in for codebases that prefer static optimization over compatibility.

## Code bloat

Only the code **after** the eval call site is duplicated (as the boxed-locals deopt path). The pre-eval code is shared. In practice the deopt path is never entered in TypeScript codebases where eval rarely mutates outer scope types.

## Wasm implementation

The shadow struct is heap-allocated per eval call site (not per invocation — one struct type per eval site, reused per invocation via `struct.new` at the call site). The host eval implementation must be extended to accept and populate the shadow.

## Acceptance criteria

1. `let x = 1; eval('x = 42'); return x` → returns 42 correctly
2. `let x = 1; eval('x = "hello"'); return typeof x` → returns "string" (deopt path taken)
3. No local boxing in the common case (fast path) — verified via WAT snapshot
4. `--no-eval-scope-write` variant throws TypeError instead of entering deopt path

## Depends on

#1261 (tiering classifier)

## See also

#1265 (sloppy mode — harder), #1266 (--no-eval-scope-write flag)

## Implementation Plan

(Author: architect, 2026-05-21. Builds on the design above with
exact codegen sequence and edge cases.)

### Entry point

- `compileCallExpression` in `src/codegen/expressions/calls.ts`:
  detect `eval(strLiteral)` direct call in strict mode.
- New file `src/codegen/eval-shadow.ts` with shadow-struct
  emitter.

### Data structure

Per eval call site, generate a unique shadow struct type at
compile time:

```wat
(type $EvalShadow_<callsiteId> (struct
  (field $written (mut i32))
  (field $local_x (mut f64))
  (field $local_s (mut externref))
  ;; ... one field per reachable local
))
```

`$written` is a bitmask: bit i = local i was written.

### Algorithm

1. **Reachable-locals analysis**: which locals are syntactically
   reachable from the eval string? Conservative: all locals in
   the same function + closure-captured.

2. **Pre-eval emit**:
   ```wat
   struct.new $EvalShadow_<n> with current local values
   local.set $shadow
   ```

3. **Call host eval**:
   ```wat
   <push string arg>
   local.get $shadow
   call $__eval_with_shadow
   ```

4. **Post-eval bitmask check**:
   ```wat
   local.get $shadow
   struct.get $written
   if
     ;; per-local: bit i set → reload local i from shadow
     ;; if type mismatch → branch to deopt continuation
   end
   ```

5. **Deopt continuation**: pre-emit a duplicate of remaining
   function body with all locals as externref. Branch label
   `$deopt_<callsiteId>`. The fast path falls through.

### Edge cases

- **Indirect eval**: `(0, eval)(str)` — strict-mode indirect eval
  evaluates in global scope; no shadow needed; emit a separate
  global-eval lowering.
- **Multiple eval calls in one function**: each gets its own
  shadow type + deopt path. Memory cost: O(n) where n = eval
  sites.
- **Eval inside loop**: shadow struct allocation per iteration;
  acceptable.
- **Eval inside closure**: shadow must capture closure variables
  too; depends on whether the closure has ref-cell wrappers
  (already exist for mutable captures).
- **`var` declaration inside eval**: spec says these don't leak in
  strict; our `__eval_with_shadow` host helper must enforce this.
- **`let`/`const` inside eval**: per spec, these create a new
  block scope inside eval; never visible outside.

### Test262 paths

- `test/language/eval-code/direct/var-env-funcs-strict-no-skip-decl.js`
- `test/language/eval-code/direct/var-env-let-strict-*.js`
- `test/language/expressions/assignment/eval-arg-strict-*.js`

Acceptance: shadow-scope deopt covers the strict-mode tier;
target ~80 strict-eval-related fails clear.

### Dependencies

- **#1261** — tiering classifier; identifies which calls qualify
  for tier 4.
- **#1102** — wasm-native eval AOT compilation; overlaps. The
  shadow scope mechanism can dispatch to compiled-AOT-eval for
  const-string evals, host eval for dynamic strings.
- **#1265** — sloppy mode; this issue is the strict subset.

### Risks

- **Reachable-locals over-approximation**: shadow struct may
  include locals eval never touches. Memory waste; OK.
- **Type-change deopt**: if eval frequently changes a local's
  type, deopt path runs often → performance loss. Mitigate by
  inferring per-site likelihood from heuristics; for safety, all
  reachable locals get a deopt path.
