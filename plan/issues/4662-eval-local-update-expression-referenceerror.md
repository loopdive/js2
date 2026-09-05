---
id: 4662
title: "runtime-eval: `++`/`--` on a name LOCAL to eval'd or Function-minted code throws ReferenceError — but only when the eval/mint sits inside an enclosing function; plain reads and `x = x + 1` are fine"
status: done
assignee: ttraenkler/dev-4662
sprint: current
created: 2026-08-23
updated: 2026-08-24
completed: 2026-08-24
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: runtime-eval
es_edition: 5
language_feature: eval
goal: standalone-gap
related: [4653, 4515, 4642, 4647]
origin: "dev-4515 flagged an eval-scope symptom; dev-4653 ran the discriminator neither lane had and falsified BOTH narrowings, including its own prior write-up. Filed by the lead — neither lane owns runtime-eval substrate and neither started on it."
---

# #4662 — update expression on an eval-local name throws ReferenceError

> **SUPERSEDED by v4 — see "Correction to the issue's v3 rule" under `## Root cause`.**
> v3's second sentence ("It works for names bound in the **module/global**
> environment") is FALSE for a module-scope `var`; that cell throws on base too.
> v3's first sentence and its `## Readings this kills` list are correct and were
> confirmed cell-by-cell. Kept below unedited as the record.

## Measured rule (dev-4653, v3 — TWO earlier versions of this rule were wrong)

> Inside eval'd / `Function`-minted code, an **update expression (`++`/`--`)**
> throws `ReferenceError: <name> is not defined` for any name whose binding
> lives in a **FUNCTION variable environment** — the enclosing function's
> locals **or parameters**, a `Function` mint's own parameters, or an
> eval-local `var` when the eval runs inside a function. It works for names
> bound in the **module/global** environment. Plain reads and compound
> assignment (`x = x + 1`) work in every case.

**The axis is where the name is BOUND** — not the surrounding syntax, not the
nesting depth, not local-vs-outer as a lexical notion.

```js
function h(){ var d = 0; eval("d++;"); return d; }      // THROW `d`  enclosing-fn local
var mint = new Function("p","p++; return p;"); mint(1)  // THROW `p`  AT MODULE TOP LEVEL
new Function("p", "return p;")(7)                       // 7   the parameter IS bound
new Function("p", "p = p + 1; return p;")(1)            // 2   compound assignment fine
```

The second line is the decisive one: **no enclosing function exists there and
it still throws**, because a `Function` parameter is always bound in a function
environment. Full 19-row environment × operator table in
`plan/issues/4653-es5-function-declaration-semantics.md` residual **R**, with
both superseded versions kept and labelled. Probes `.tmp/probes/ev{1..6}.js`.

## Readings this kills — check yours against them before hypothesising

1. **`for` vs `while` is irrelevant**, and so is the loop: bare
   `eval("var i = 0; i++; i")` throws with no loop anywhere.
2. **"Local vs outer" is the wrong frame** (v2's error). It happens to describe
   some rows because the "outer" variables probed were all module-level. An
   enclosing function's own local is *outer* to the eval and still throws.
3. **The enclosing-function gate is FALSE** (v2's error). A top-level
   `Function` mint with a parameter throws with no enclosing function at all.
4. **The mint DOES bind its parameters** (v1's error) — the read-only case
   answers `7`.
5. Consequence for a fixer: the superseded wording **excluded the most common
   real shape** — a plain local of the function containing the eval — and
   pointed at the wrong seam.

## Provenance

Standalone lane, dev-4653's probes. The earlier cross-tree thread is **closed**:
dev-4515's repro is vindicated. Its error text named `n4515` while its quoted
source said `n`, and that mismatch revealed the probe wraps in
`export function test(){ var n4515 = 0; … }` — the enclosing-function-local
cell. It throws on both lanes' trees. The earlier "does not reproduce here" was
measuring a module-level `var`, a different cell entirely.

## The lesson from how BOTH earlier rules failed

> **A table is only evidence for the axes it varies; the axis you did not vary
> is where the wrong rule hides.**

v1 varied only the operator. v2 varied operator × surrounding-syntax ×
top-level-vs-in-a-function — a three-axis table that never varied **where the
name is bound**, because every probe wrapped its subject in the same helper and
every "outer" variable chosen was module-level. Both refuting probes were two
lines. Note also that v2's control was *labelled* "outer binding" when it was
really "module-environment binding"; the mislabel is precisely what produced the
wrong rule, so name controls by the axis they actually hold.

## Known conformance rows

`language/statements/function/S13.2.2_A8_T3.js`
(`Function.call(this, "arg", "return ++arg;")` inside a function expression) is
this root. `language/expressions/assignment/S11.13.1_A6_T{1,2}` are **plausibly**
the same and must be verified, not assumed.

## Implementation Plan

1. Brief: `plan/method/es5-standalone-agent-brief.md` — BINDING, read fully.
   Load-bearing here: methodology 1–7, the **contention trap** (a
   `compilation timeout` is a measurement failure, not a status — re-run every
   apparent flip and regression serially), the **pool-suite false green**
   (`skipped` is not `passed`; read counts, never exit codes), the stale
   `compiler-bundle.mjs` trap (rebuild bundle + adapter on BOTH arms — this is
   eval territory), the `test262/` symlink-farm + **GITLINK hazard**.
2. Re-establish the discriminator table on current campaign HEAD first, in
   both tiers (quickjs and `JS2WASM_EVAL_ENGINE=interpreter`). The
   enclosing-function axis is the one to keep in every probe — dropping it hides
   the defect entirely.
3. Then find why an update expression resolves its operand differently from a
   read or a compound assignment in minted code. The asymmetry is the lead:
   `p` reads fine and `p = p + 1` writes fine, so the binding exists — it is the
   update expression's own reference resolution that misses it.
4. Absent-not-wrong: if some shape cannot be resolved faithfully, decline rather
   than answer wrongly.

## Root cause (dev-4662, instrumented on campaign HEAD `74389b417`)

`tryEmitUnresolvableUpdateThrow` (`src/codegen/update-unresolvable-ref.ts`, #4640)
emits the §13.4.4 "GetValue on an unresolvable Reference" ReferenceError at
COMPILE TIME, gated on `ctx.oracle.isUnresolvableIdentifier(operand)` — which is
`checker.getSymbolAtLocation(id) === undefined`.

An eval'd / `Function`-minted body that the static splice accepts is parsed into a
**foreign `ts.SourceFile` named `<eval>.ts`** that is never added to the TypeScript
program. The checker therefore answers `undefined` for **every** identifier in it —
the body's own parameters and locals included. The helper read "the checker has no
opinion" as "the reference is unresolvable" and threw.

That is the whole asymmetry the lead pointed at. This helper is called from
`compilePrefixUpdate` and `compilePostfixUnary` and **from nowhere else**; a plain
read and a compound assignment never ask the checker whether the name resolves, so
`p` read fine and `p = p + 1` wrote fine while `p++` threw on a binding that
demonstrably existed. Instrumenting the throw site printed, for all six throwing
cells: `fctx.localMap.has(name) === true` — the binding was live in the very
`FunctionContext` being compiled, one map lookup away.

### The measured table (probe `.tmp/probes/e1.js`, standalone, both arms)

Axes VARIED: where the name is bound (mint parameter / mint-local `var` /
enclosing-function local / enclosing-function parameter / eval-local `var` /
script-global / **module-scope `var`**) × operator (read, `x = x + 1`, `x++`, `++x`,
`x--`, `--x`) × construct (`Function` mint vs direct eval) × loop-vs-straight-line ×
eval tier (default vs `JS2WASM_EVAL_ENGINE=interpreter`).
Axes held FIXED and stated as such: target (`standalone` only), strict mode (all
bodies sloppy), and — the one that had been hiding the last cell — **script vs
module** for the enclosing compilation unit.

| cell | shape | base | fixed |
| --- | --- | --- | --- |
| A1 | `new Function("p","return p;")(7)` | 7 | 7 |
| A2 | `new Function("p","p = p + 1; return p;")(1)` | 2 | 2 |
| A3 | `new Function("p","p++; return p;")(1)` | **THROW `p`** | 2 |
| A4 | `new Function("p","return ++p;")(1)` | **THROW `p`** | 2 |
| B1/B2 | mint-local `var` read / compound | 5 / 6 | 5 / 6 |
| B3 | `new Function("var q=5; q++; return q;")()` | **THROW `q`** | 6 |
| C1/C2 | enclosing-fn local read / compound via eval | 3 / 4 | 3 / 4 |
| C3 | `var d=3; eval("d++;"); return d` | **THROW `d`** | 4 |
| D1 | `(function(a){ eval("a++;"); return a; })(3)` | **THROW `a`** | 4 |
| E1 | `eval("var z=1; z++; z")` | **THROW `z`** | 2 |
| F1–F3 | SCRIPT-level `var g`, read / compound / `++` via eval | 10 / 11 / 12 | 10 / 11 / 12 |
| G | **MODULE-scope `var g`, `++` via eval** | **THROW `g`** | 11 |

### Correction to the issue's v3 rule — this is a v4

v3 said the defect spares "names bound in the **module/global** environment". **It
does not.** Row G above is a `var` at the top of a MODULE, updated from a direct
eval, and it threw on base exactly like a function-environment binding. v3's F rows
survived only because every probe was a **SCRIPT**, where a top-level `var` becomes
a realm-global property and the #4640 D3 sloppy-implicit-global decline catches the
name two lines EARLIER in the same function.

So the real axis is not "which environment holds the name" but **"which decline
catches the name before the checker is asked"** — `with`-supplied names and sloppy
implicit globals decline; everything else in a spliced body throws. Script-vs-module
was an axis the earlier probes held fixed by convenience, exactly the failure mode
methodology 6 describes. It was caught here because a *positive control labelled
"green on base"* turned red on the base arm — the control earned its keep by being
wrong.

## Fix

One file, one predicate: `src/codegen/update-unresolvable-ref.ts`.

After the oracle says "no symbol", ask whether codegen already holds a binding for
that name — `fctx.localMap`, a boxed cell, `ctx.moduleGlobals`, `ctx.capturedGlobals`,
or a boxed captured global, i.e. **the very arms the caller takes next**. If it does,
the static diagnostic is provably false; decline and let the ordinary update arm run.
If it does not, nothing changes.

The new check is placed **last, after** `isUnresolvableIdentifier`, not first where
the map lookups would also have been cheaper. That keeps its meaning exact — it fires
only on operands the helper was about to throw for — which is what made its blast
radius measurable instead of argued (see Test Results).

Absent-not-wrong holds in both directions: a genuinely undeclared name inside an
eval'd or minted body still gets the §13.4.4 throw (measured, four negative controls),
and no ordinary-source behaviour moves — for in-program code an identifier with a live
local or global always HAS a checker symbol, so "no symbol AND codegen has a binding"
is the foreign-AST case by construction.

## Acceptance

Scoped standalone sweep over `language/expressions/assignment`,
`language/statements/function` and the eval-dependent `built-ins/Function` rows
before AND after from your own runs, apparent flips/regressions serially
re-verified; per-file flip list; **zero regressions**.
`tests/issue-4662.test.ts` pinning each fixed shape in BOTH tiers, every pin
EXECUTING the update expression — and carrying **positive controls** the way
dev-4653's corrected pins do (parameter binding; outer-`++` in a loop), so the
suite claims "`++` on a local" rather than "eval scope is broken" and a fix that
widens the wrong thing cannot read as green. Verified failing on base by revert.
Record `## Root cause` / `## Fix` / `## Test Results` / `## Residuals` here.

## Test Results (dev-4662 — every number below is from a run I executed)

Base = campaign HEAD `74389b417`, captured as a revert copy of the single touched
file at the first edit and restored with `git diff --stat` checked before each arm
(one file changed, one file restored — no hybrid tree).

### Scoped standalone sweep, both arms, 1,934 rows

`language/expressions/assignment` (485) + `language/statements/function` (451) +
`built-ins/Function` (510) + `language/eval-code` (347) + the four
`postfix-`/`prefix-increment`/`decrement` directories (141), target `standalone`,
via `runTest262File(..., "standalone")`.

| arm | pass | fail | compile_error |
| --- | --- | --- | --- |
| base `74389b417` | 1,621 | 288 | 25 |
| this branch | **1,622** | 287 | 25 |

**Flips fail→pass: 1. Regressions: 0. Other status changes: 0.**

```
+ language/statements/function/S13.2.2_A8_T3.js   fail -> pass
```

Serially re-verified on both arms, one row per process, off the contended batch:
on base it fails with **`ReferenceError: arg is not defined`** — the issue's exact
signature — and on this branch it passes.

**Byte-level corroboration.** The sweep records each row's `wasm_sha`. Of the 1,734
rows that produce one, **1,733 are IDENTICAL across the two arms and exactly one
differs — the flipped row** (`37dc7da6e4bc` → `3eb929a27361`). So the change is not
merely regression-free by status; it emits identical bytes for every other module in
the scope. (The remaining 200 rows are `compile_error`/skip and carry no sha.)

**Blast radius, measured rather than argued.** The fix arm ran with an env-gated
counter at the new decline (dead when the env var is unset; stripped before the final
commit). Across all 1,934 rows the predicate fired on **exactly one file**,
`S13.2.2_A8_T3.js`, 6 times. That is why "1,933 rows unchanged" is a measurement and
not an inference — and it is the honest reachability of this change in these
directories.

### Named rows checked individually, serially, on both arms

| row | base | branch | verdict |
| --- | --- | --- | --- |
| `language/statements/function/S13.2.2_A8_T3.js` | fail `ReferenceError: arg is not defined` | **pass** | this root, fixed |
| `language/expressions/assignment/S11.13.1_A6_T1.js` | fail `innerX === undefined. Actual: 1` | fail, same | **NOT this root** |
| `language/expressions/assignment/S11.13.1_A6_T2.js` | fail `innerX === 2. Actual: 1` | fail, same | **NOT this root** |
| `language/statements/for/S12.6.3_A10_T1.js` | pass | pass, same sha | #4640 D3 decline untouched |
| `language/statements/for/S12.6.3_A10.1_T1.js` | pass | pass, same sha | #4640 D3 decline untouched |

The issue asked that `S11.13.1_A6_T{1,2}` be **verified, not assumed**. They are a
different defect: neither file contains an update expression at all (`x = (eval("var
x;"), 1)`), the decline counter reads 0 on both arms, and their `wasm_sha` is
unchanged. They test that PutValue targets the **originally-created** Reference when
a direct eval installs a fresher shadow — eval-created-var binding freshness, not
§13.4.4.

### Pins — `tests/issue-4662.test.ts`, both tiers

| tier | run | result |
| --- | --- | --- |
| default (quickjs) | this branch | `Tests 24 passed (24)` |
| `JS2WASM_EVAL_ENGINE=interpreter` | this branch | `Tests 24 passed (24)` |
| default (quickjs) | **base, by revert** | `Tests 11 failed \| 13 passed (24)` |
| `JS2WASM_EVAL_ENGINE=interpreter` | **base, by revert** | `Tests 11 failed \| 12 passed (23)`¹ |

¹ that arm ran against an earlier 23-test revision of the file, before the
mislabelled control was split into a positive pin plus a correct control; the
24-test base arm was then re-run on the default tier. `executed == total` holds in
every row — no run reports green having measured nothing.

The 11 base failures are exactly the 11 update-expression shapes. **Every control
and every negative is green on base**, which is what makes the file a claim about
`++` on a function-environment binding rather than about eval scope at large: the
same parameter reads correctly and accepts a compound assignment on base, an
ordinary local `++` and a module-global `++` outside eval both work on base, and all
four §13.4.4 "genuinely undeclared name still throws" negatives plus the `with`
decline hold on both arms.

**Why the pins are tier-independent, verified structurally rather than assumed.**
Every pinned shape is compiled by the static splice, so its module's import manifest
is EMPTY and no provider can influence the answer; three `TIER:` pins assert exactly
that from the emitted binary, with a splice-DECLINING mint as the contrast case that
DOES import `js2wasm:runtime-eval.*`. Without the contrast case, "the manifest is
empty" would be a claim about compiling nothing.

### Environment / arm separation

- **Fresh-worktree provider trap (#4484) was LIVE and cost a whole sweep.** The
  first fix-arm pass reported **234 of 799 rows** failing with
  `JS2WASM_EVAL_ENGINE=quickjs but the quickjs provider is not built (missing
  .test262-cache/quickjs-eval-adapter-3e7cb743f68ff3a4.wasm)`. Copying the main
  checkout's `.test262-cache/` in is **not sufficient** — the adapter key is derived
  from the compiler BUNDLE hash, so a cache built for a different tree never
  matches, and the rows fail identically on both arms while looking like ordinary
  failures. That pass was discarded and both arms re-run after
  `pnpm run build:compiler-bundle && npx tsx scripts/build-quickjs-eval-provider.mjs`.
  Final sweeps: **0 provider-missing rows on either arm.**
- **Distinct adapter key per arm, both cache MISSES** (so neither arm was measured
  through the other's compiler):

  | arm | compiler bundle | adapter key | cache |
  | --- | --- | --- | --- |
  | base `74389b417` | `c2e611af76ceeb13` | `7bb0b4a0229a3d35` | **MISS** — built + canary-verified |
  | branch (with probe) | `cf11ac9e961a2289` | `9311c5c7357da9ea` | **MISS** — built + canary-verified |
  | branch (final, probe stripped) | `e51db08690007a7e` | `694230afb01a5850` | **MISS** — built + canary-verified |

  Re-selecting the branch arm after the base sweep reported `adapter cache HIT +
  linked-pair verification — key 9311c5c7357da9ea`, i.e. the round trip landed back
  on its own artifact and not the base's.
- The final source was re-verified on the named rows serially (adapter
  `694230afb01a5850`): `S13.2.2_A8_T3.js` passes with `wasm_sha 3eb929a27361`,
  byte-identical to the probe-carrying fix arm — the instrumentation changed no
  emitted byte, only the bundle text.
- **`test262` gitlink hazard:** the worktree's `test262/` is repointed at the shared
  checkout in-process by the sweep driver (the isolation layer wipes it repeatedly).
  Nothing was ever staged from it — checked with `git status -- test262` before every
  commit and with `git diff 74389b417..HEAD --stat -- test262` (empty) before
  finishing.

### Scope stated, including what was dropped

`language/statements/for` (385 rows) was **not** swept in full. It is cited only for
the #4640 D3 sloppy-implicit-global decline, which sits two lines above this change
and is untouched by it; the two rows that issue names were run individually on both
arms instead (unchanged, identical shas). Nothing else in the acceptance-named scope
was dropped — in particular all 309 `built-ins/Function/prototype` rows were kept
even though the diff provably cannot reach them, because a directory that tests the
fix's own family is not a safe cut.

## Residuals

**R1 — `for (var i = …)` head + direct eval in the body fails Wasm VALIDATION.**
Not caused by this change and not fixed by it; pinned `it.fails` in
`tests/issue-4662.test.ts` with the root named so a future fix surfaces rather
than hides.

```js
var c = 0;
for (var i = 0; i < 4; i = i + 1) { eval("c++;"); }   // module fails to validate
return c;
```
```
CompileError: WebAssembly.instantiate(): Compiling function #50:"test" failed:
local.tee[0] expected type (ref null 117), found local.get of type i32
```
Measured identically on campaign HEAD `74389b417` and on this branch. The
**discriminator** is that the same shape with COMPOUND assignment
(`eval("c = c + 1;")`) fails byte-for-byte the same way on both arms — and
compound assignment never touches `tryEmitUnresolvableUpdateThrow`. So the root
is the `for (var …)` head's interaction with direct-eval binding reification (the
counter's cell promotion racing the body's), not the update operator. Replacing
the `for` with the equivalent `while` loop works on this branch (pinned, green).
Owner: unassigned — needs its own issue id (`claim-issue.mjs --allocate`); the
repro above is complete.

**R2 — the sloppy-implicit-global path has no vitest pin here, by design.** A
host-free module has no realm global object, so under this file's harness even the
plain READ (`x = 5; return x;`) throws on BOTH arms — a harness limit, not a
behavioural one, and adding `hostBridge: "always"` +
`instantiateTest262Module` does not lift it (measured). The #4640 D3 decline sits
two lines above this change and is untouched by it; it is covered where it can be
measured honestly, by the two conformance rows #4640 D3 cites (see Test Results).
