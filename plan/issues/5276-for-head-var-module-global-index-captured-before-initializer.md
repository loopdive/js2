---
id: 5276
title: "for-head `var` at module scope captures its module-global index before compiling the initializer — stale `global.set` after a mid-body global insertion"
status: done
created: 2026-09-02
updated: 2026-09-02
completed: 2026-09-02
sprint: current
priority: medium
horizon: s
feasibility: easy
task_type: bug
area: codegen
goal: core-semantics
requested_by: claude/fable-ir-takeover
related: [3523, 5474, 5480, 2023, 2001, 3032, 3933, 4648]
# 2026-09-02: the fix is one expression plus the comment that says why the
# index must be re-read, and the acceptance criteria require the staleness-
# family citation to be written INTO `fixupModuleGlobalIndices` — both land in
# god-files already at their ceiling. +6 loops.ts / +9 imports.ts, all of it
# comment except the single re-read expression.
loc-budget-allow:
  - src/codegen/statements/loops.ts
  - src/codegen/registry/imports.ts
# 2026-09-02: same +4 lines land inside `compileForStatement`, already at its
# ceiling. Splitting a 614-line function to host a four-line comment would be a
# larger change than the fix it explains.
func-budget-allow:
  - src/codegen/statements/loops.ts::compileForStatement
---

## Problem

`compileForStatement` (`src/codegen/statements/loops.ts:322`) handles a
for-head `var` declaration at module scope by reading the variable's
module-global index into a local **before** compiling the initializer and
pushing the `global.set` **after** it:

```ts
// src/codegen/statements/loops.ts:416-422 (origin/main 33ea8606aa)
const moduleGlobalIdx = hasLocalShadow || blockScopedInsideFunction ? undefined : ctx.moduleGlobals.get(name);
…  // compileExpression(initializer) runs here
fctx.body.push({ op: "global.set", index: moduleGlobalIdx });
```

Compiling the initializer can insert a module global mid-body — e.g. `a[0]`
adds the bounds-check error path's string constant, `addStringConstantGlobals`
runs `fixupModuleGlobalIndices`, and that fixup shifts `ctx.moduleGlobals`,
every already-emitted `global.get/set` reachable from a live body, and ~20
cached index maps. It cannot shift a number sitting in a caller's local that
has not pushed its instruction yet. Measured in emitted WAT (gap-6a census,
[#3523](https://js2wasm.loopdive.com/dashboard/issue.html?slug=3523-ir-r4-module-init-compile-once)
"gap-6a v2 repair record", family A): the for-head writes `global.set 107`
while every other reference to the same variable in the same function reads
`global.get 108` — the initializer lands in the PRECEDING global and the loop
variable keeps its default. On a neighbouring shape the same off-by-one writes
an `f64` into an `externref` slot, which is
`global.set[0] expected type externref, found if of type f64` at
`WebAssembly.instantiate`.

Reduced repro (4 lines, inside the test262 harness):

```js
var a = [1, 2];
var n = 0;
for (var j = a[0]; j <= 2; j++) { n = n + 1; }   // n === 4, expected 2
```

This is the **sixth instance** of the staleness family documented inside
`fixupModuleGlobalIndices` (#2023, #2001, #3032, #3933, #4648). The first five
all fixed a *cache*; this one is a value in flight on the stack, which no fixup
can reach.

## Why it is invisible on `main` today

The default two-pass module-init route compiles the whole initializer once in
pass 1, which creates every string-constant import the emitting compile would
have needed, so the second compile inserts no global mid-body and nothing goes
stale. PR #5474 (gap-6a, skipping pass 1 when discovery is static) removed the
mask and regressed 76 test262 rows (16 decodeURI/decodeURIComponent OOB traps,
the `do-while` single, part of cluster 2) before it was reverted (#5477). The
re-land [PR #5480](https://github.com/loopdive/js2/pull/5480) keeps the skip
behind `JS2WASM_ENABLE_MODULE_INIT_DISCOVERY_STATIC=1` and deliberately does
NOT carry this fix, so that a byte-neutral repair PR does not also change
emitted code. Any future change that moves work out of pass 1 hits this again.

## Implementation Plan

One-line fix, no-op whenever no shift happened:

1. In `compileForStatement`, re-read `ctx.moduleGlobals.get(name)` **after**
   `compileExpression(initializer)` returns and use that index for the
   `global.set` (`loops.ts:416` → read at :422). Keep the `hasLocalShadow ||
   blockScopedInsideFunction` guard as the decision, not the captured index.
2. Audit the sibling arms in the same file for the same capture-then-compile
   shape (the `for-in`/`for-of` module-global heads around `:969`, which
   registers `liveBodies` the same way) and apply the same re-read where an
   initializer or iterable expression is compiled between the read and the
   push.
3. Pin: `tests/issue-5276-for-head-module-global-stale-index.test.ts` compiles
   the 4-line repro with the pass-1 skip enabled
   (`JS2WASM_ENABLE_MODULE_INIT_DISCOVERY_STATIC=1`, available once #5480 lands)
   and asserts `n === 2`; a second case with a string-typed loop variable
   (`for (var s = a[0] + "", …)`) asserts the module instantiates. Without the
   seam the pin must still compile and pass (the mask hides the bug, the
   assertion holds either way) — state that in the test header so a later
   pass-1 retirement cannot silently un-pin it.
4. Byte neutrality on the default route: file-copy A/B (`cmp`) on the
   `playground/examples` host corpus, expected 100 % identical — the re-read
   returns the same index whenever no insertion happened.

## Acceptance criteria

1. The repro yields `n === 2` with the pass-1 skip enabled; the string-variable
   shape instantiates.
2. Default-route corpus bytes unchanged (A/B evidence in the checkpoint note).
3. The fix is cited from `fixupModuleGlobalIndices`'s staleness-family comment
   as instance six, so the next reader of that comment finds it.

## 2026-09-02 implementation checkpoint

Branch `claude/issue-5276-forhead-stale-global-index`, based on `origin/main`
`fc5d03342e`. Opus lane (High).

### Step 1 — the fix

`src/codegen/statements/loops.ts`, the module-global arm of the for-head `var`
declaration: the `global.set` now takes `ctx.moduleGlobals.get(name) ??
moduleGlobalIdx`, read AFTER `compileExpression(decl.initializer, …)` returns.
The `hasLocalShadow || blockScopedInsideFunction` guard is untouched and still
decides whether this arm runs at all; only the index is refreshed. The `??`
keeps the captured value as the fallback, matching the established shape at
`expressions/assignment.ts:4208`. The `globalDef` type probe stays where it is —
it reads `ctx.mod.globals` before anything can shift, which is correct.

### Step 2 — audit of the sibling arms in the same file

`loops.ts` emits exactly **one** `global.set` and holds exactly **one**
`ctx.moduleGlobals.get(…)` (both at the site above; `grep -n "lobal"` over the
file is the whole inventory). The sibling heads were checked as follows.

| arm | route to the module global | needs the re-read? |
| --- | --- | --- |
| for-head `var` (`:414-424`) | reads the index, compiles the initializer, then pushes | **yes — fixed** |
| for-of heads (`:1685`, `:2099`, `:2767`, `:3223`) | `emitForOfAssignmentTarget` → `tryEmitForOfIdentifierWrite` → `emitResolvedIdentifierWriteFromStack` | no — that helper already re-reads `ctx.moduleGlobals.get(id.text)` on the push line (`identifier-assignment.ts:227`), and the element arrives in an already-materialised local, so no expression compiles between the read and the push |
| for-of member/element targets | `emitAssignToTarget(…, valueLocal, valueType)` | no — same reason: value precomputed into a local, no index captured across a compile |
| for-in heads (`compileForInStatement:3747+`) | `ensureForInIdentifierLocal` / a fresh block-scoped local; `emitForInMemberTargetWrite` for member targets | no — a `var` head binds the function-scope slot the var-hoister allocated; this file pushes no `global.set` for them |
| `while` / `do-while` / for cond+incr buffers (`:209`, `:739`, `:817`, `:972`) | detached `Instr[]`s registered in `ctx.liveBodies` | no — these are already-emitted instructions, which is exactly what the fixup walks (#1690) |

One adjacent observation, deliberately **not** acted on because it is a
different index space and outside this issue: `emitForInMemberTargetWrite`
(`:3363`) caches the `__extern_set` **function** index in `setIdx` before
compiling the receiver and key expressions. That is a func index, not a module
global, so `fixupModuleGlobalIndices` is irrelevant to it; whether a late func
import can shift it belongs in its own issue rather than being widened into
this one.

### Step 3 — the pin, and its A/B non-vacuity proof

`tests/issue-5276-for-head-module-global-stale-index.test.ts`: the 4-line repro
(asserts `read() === 2`) and the string-typed head (`var s = a[0] + ""`, asserts
the module instantiates and the loop runs twice), each on two routes — the
default two-pass route and the #5480 seam
(`JS2WASM_ENABLE_MODULE_INIT_DISCOVERY_STATIC=1`). The test header states that
the assertions must hold with the seam OFF too, so a later pass-1 retirement
cannot silently un-pin it.

File-copy A/B (`cp src/codegen/statements/loops.ts .tmp/new-loops.ts;
git show origin/main:src/codegen/statements/loops.ts > .tmp/base-loops.ts`),
same test file both ways:

| tree | vitest result |
| --- | --- |
| `origin/main` `loops.ts` (fix reverted) | **4 failed / 4** |
| this branch's `loops.ts` | **4 passed / 4** |

The base failures, verbatim:

- numeric case, both routes — `AssertionError: expected 4 to be 2`
- string case, both routes — `CompileError: WebAssembly.instantiate(): Compiling
  function #7:"__module_init" failed: global.set[0] expected type f64, found
  call of type (ref extern) @+686`

The WAT symptom the issue names is reproduced directly. Dumping the first
`global.*` opcodes of `__module_init` for the numeric case:

```
base:  set3 set4 get3 get2 set4 get5 get4 set4 get5 set5
fixed: set3 set4 get3 get2 set5 get5 get4 set4 get5 set5
                          ^^^^ the for-head write
```

i.e. the head wrote `global.set 4` while every other reference to `j` read
`global.get 5` — the `N` vs `N+1` off-by-one of the census record, at this
module's smaller index range. `a[0]` therefore landed in the preceding global
(`n`) and `j` kept its 0 default: three iterations plus the stray 1 reads 4.

**Deviation from the issue's expectation, stated rather than smoothed over:**
the plan predicted the default two-pass route would MASK the bug, so that the
seam-off cases would pass on both trees. Measured here they do not — the
reduced repro compiled through `compile()` fails identically on both routes on
the base tree. The mask described in the census is real for the runner's
harness populations; it does not extend to this shape. The pin is stronger for
it (it fails on base on both routes), and the header note the plan asked for is
still there and still correct as a forward-looking guard.

### Step 4 — byte neutrality on the default route

File-copy A/B over the `website/playground/examples` host corpus, 13 `.ts`
files × 2 host lanes (`{target:"gc"}` and `{target:"gc", deferTopLevelInit:true}`),
default route (seam unset), binaries written per cell and compared with `cmp`:

**26 / 26 cells byte-identical, 0 differing.** All 26 cells are real wasm
binaries (`\0asm` magic checked), so the neutrality is not an artifact of
error payloads compared against each other. Expected: the re-read returns the
same index whenever nothing was inserted.

### Step 5 — the citation

`fixupModuleGlobalIndices` (`src/codegen/registry/imports.ts`) now names this as
instance six of the staleness family, immediately after the #4648 entry, with
the point that distinguishes it: it is the first instance the function cannot
repair, because the stale value is in flight on the stack rather than in a
cache — so the repair has to be a re-read at the push site.

### Gates

`check-loc-budget` (both `merge-base(origin)` and `LOC_GATE_BASE=origin/main`),
`check-func-budget`, `check-coercion-sites`, `check:oracle-ratchet`,
`check:dead-exports`, `pnpm run typecheck` and `pnpm run format:check` all green
before each commit. The growth is +6 `loops.ts` / +9 `imports.ts`, all comment
except the single re-read expression, granted in this file's `loc-budget-allow:`
frontmatter above.
