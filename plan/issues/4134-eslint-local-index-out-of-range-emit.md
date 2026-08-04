---
horizon: m
id: 4134
title: "Codegen leaves out-of-frame local references; reproduces in ONE file (uri.all.js)"
status: in-progress
created: 2026-08-02
updated: 2026-08-04
assignee: unassigned  # partial slice landed in PR #4074; remainder needs a spec
priority: critical
feasibility: hard
reasoning_effort: max
task_type: bug
area: codegen, emit
language_feature: multi-module-compilation
goal: npm-library-support
sprint: current
required_by: [1282, 1400, 2693]
es_edition: n/a
related: [1282, 2043, 4030, 4133]
# (#3102) This change-set grows ten god-files. The growth is intended and is
# mostly ENV-GATED INSTRUMENTATION plus the fixes it was built to find:
# the compile-phase profiler and the frame checker/reporters wired into
# `index.ts`, the capture-resolution guard in `call-identifier.ts`, and the
# nested-declaration scoping. Two new subsystem modules were split out already
# (`compile-profile.ts`, `frame-trap.ts`); the remaining `index.ts` call sites
# and reporters would be better extracted too, which is follow-up, not this PR.
# (#3102/#3400) Same rationale as the LOC allowance below: these functions grew
# to carry the frame checker/reporters, the compile-phase profiling calls, the
# #4001 module-init mode, and the capture-resolution guard. Splitting them is
# the right follow-up and is tracked, but doing it inside this change-set would
# mix a large mechanical refactor into a set of behavioural fixes.
func-budget-allow:
  - src/codegen/index.ts::generateMultiModule
  - src/codegen/expressions/call-identifier.ts::compileIdentifierCall
  - src/codegen/statements/nested-declarations.ts::compileNestedFunctionDeclaration
  - src/codegen/declarations.ts::compileDeclarations
  - src/codegen/closures.ts::compileArrowAsCallback
  - src/emit/binary.ts::encodeInstr
  - src/emit/binary.ts::emitBinaryWithSourceMapUnguarded
  - src/codegen/context/create-context.ts::createCodegenContext
loc-budget-allow:
  - src/codegen/index.ts
  - src/codegen/expressions/call-identifier.ts
  - src/codegen/closures.ts
  - src/codegen/declarations.ts
  - src/emit/binary.ts
  - src/codegen/statements/nested-declarations.ts
  - src/codegen/context/types.ts
  - src/compiler.ts
  - src/ir/from-ast.ts
  - src/codegen/expressions.ts
  # Added when the THIRD out-of-frame site was fixed: the closure-VALUE capture
  # guard, and the fnctor-constructor frame-trap install that localised it.
  - src/codegen/expressions/new-super.ts
  - src/codegen/closures/funcref-as-closure.ts
---

# #4134 — `local index out of range — 65 (valid: [0, 8))` at emit

## Problem

The **current and only** blocker for an ESLint binary. Everything upstream now
succeeds: zero hard codegen aborts, planning completes, and the compile reaches
binary emit before dying:

```text
Binary emit error: RangeError: Codegen error: local index out of range — 65
(valid: [0, 8)) at function 've' (position 1666, 6 declared locals).
```

Reproduce (~15 min):

```sh
node --max-old-space-size=6144 --import tsx \
  tests/helpers/compile-project-probe.ts <tier1-entry.ts> \
  '{"allowJs":true,"target":"gc","platform":"node","allowFs":true}'
```

where the entry is `tests/stress/eslint-tier1.test.ts`'s Tier 1a source.

## What is known

- Function `ve`, defined-function **position 1666**, **6 declared locals**, and
  the valid range `[0, 8)` implies **2 params**.
- The body references **local 65** — far beyond its own frame.
- **The name is NOT shared.** The emit diagnostic now reports
  `NAME SHARED BY n DEFINED FUNCTIONS` when a defined-function name is
  duplicated, and it did **not** fire here. So this is **not** the #4133
  cross-module collision, despite looking exactly like it.
- **No declaration named `ve` exists** anywhere in the 146-source resolved
  graph — checked across `FunctionDeclaration`, `MethodDeclaration`,
  named `FunctionExpression`, and variable declarations initialised with a
  function or arrow. So `ve` is either compiler-synthesized or introduced by a
  transform (the CJS rewrite and ground-call folding both run before analysis).

## Two candidate causes, not yet distinguished

1. **Genuinely the #2043 late-import index-shift class** the message names — a
   captured local index went stale, or a lookup baked a bogus value.
2. **A body installed against the wrong frame**, i.e. the same *shape* as #4133
   but arrived at by a different route than name collision (an alias, a
   trampoline rebuild, or a finalize pass reusing a slot).

The `(position, locals, name-sharing)` detail added in this session is the
evidence needed to tell these apart; it did not exist before and is what ruled
out the collision reading.

## Suggested next step

Find where the index 65 comes from rather than which function owns it: instrument
`encodeInstr`/`vIdx` to record the *instruction* and its enclosing block when the
breach fires, and correlate 65 against the local count of nearby functions — a
body built for a ~65-local function landing in a 2-param/6-local slot points at
(2), while an isolated bogus index points at (1).

Identifying what produces a function literally named `ve` would also localise it
immediately; a targeted dump of `mod.functions[1660..1670]` names at emit time is
cheap and would show its neighbours' provenance.

## Acceptance criteria

- The origin of function `ve` is identified.
- Cause (1) vs (2) is decided with evidence, not by the message's default
  attribution — the `#2043` text in this diagnostic is a **guess**, and it was
  already misleading once (it fired for #4133's collision).
- A reduced fixture reproduces the breach without ESLint.
- ESLint's Tier 1a entry emits a binary.

## Further evidence gathered (2026-08-02)

### The exact site

```text
local (local.get) index out of range — 65 (valid: [0, 8))
at function 've' (position 1666, 6 declared locals)
```

So it is a **`local.get 65`** — a READ of a local that does not exist in this
frame — not a write and not a computed index.

### `ve`'s neighbourhood (`JS2WASM_EMIT_DUMP=1`, position → frame size → name)

```text
1662   2   ye
1663   3   me
1664  46   xe
1665   3   __fn_tramp_t_cached
1666   8   ve      <-- references local 65
1667  19   ge
1668  30   Ae
1669  42   Ee
1670   2   __get_member_nextPos
```

Every neighbour is a two-letter minified name, so `ve` comes from a **minified
dependency** in the graph (`esquery.min.js` is the likeliest — it is an ESLint
dependency and is shipped minified). That also explains why no *declaration*
named `ve` was found by an AST scan of the resolved sources: the scan looked at
declaration forms, and these names are also introduced by patterns it did not
cover (object-literal properties, class expressions, and the CJS rewrite, which
runs before analysis).

**No neighbour has a frame ≥ 66**, so the body is not simply the adjacent
function's. Module-wide, **322 of 8,225** defined functions have a frame large
enough to own local 65 — too many to guess from; the origin has to be traced,
not inferred.

### A separate finding worth its own triage

The emitted table still contains **61 duplicated defined-function names** after
the #4133 fixes, e.g. `TokenTranslator_init`, `TokenTranslator_new`, `_format`,
`_globToRegExp`, `analyzeScope`, `assertArg`, `__sget_`, `__sset_`,
`__async_resume_fanon_410`. #4133 covered top-level *function declarations*;
these are class members, synthesized helpers and async resume points, which are
named by other schemes. `ve` is **not** among them — which is exactly why the
name-sharing check ruled the collision reading out here — but the duplicates are
a latent instance of the same hazard and should be triaged separately.

### Narrowed next step

Instrument the producer, not the emitter: record which pass last wrote
`mod.functions[1666].body`. Candidates worth checking first, in order —
`replaceDefinedFuncAt`, the `pendingMethodTrampolines` finalize rebuild, and
`fillMethodTrampolines`/`finalizeMethodTrampolines`, since all three overwrite an
existing slot's body after it was first compiled and are therefore the paths that
can pair a body with a foreign frame.

## Localised (2026-08-02) — `ve` is a NESTED function declaration

`JS2WASM_TRACE_SLOT=1666` (added in this session) answers the "who wrote it"
question outright. Slot 1666 is written **exactly once**:

```text
[js2:slot] pushDefinedFunc -> position 1666 name='ve' locals=0 bodyOps=0
    at pushDefinedFunc (src/codegen/func-space.ts)
    at pushProgramAbiNestedFunctionDeclaration (src/codegen/program-abi-source-callable-planning.ts:128)
    at compileNestedFunctionDeclaration (src/codegen/statements/nested-declarations.ts:659)
    at compileStatementInner (src/codegen/statements.ts:265)
```

Three facts follow, and they reshape the issue:

1. **`ve` is a nested function declaration**, not a top-level one — which is why
   the earlier top-level AST scan found nothing named `ve`.
2. The slot is claimed as an **empty placeholder** (`locals=0 bodyOps=0`) and its
   `locals`/`body` are filled in later **by mutating that same object**. So the
   inconsistency is introduced by the fill, not by a competing slot write —
   `replaceDefinedFuncAt` is NOT involved and can be dropped from the suspect
   list.
3. `compileNestedFunctionDeclaration` does `ctx.funcMap.set(funcName, …)` with
   the **bare** name. Nested declarations therefore share the flat name space
   with each other and with top-level functions — the same hazard as #4133,
   whose fix deliberately covered **only top-level declarations**.

### Where to look next

The body assigned to `ve` uses a frame of ≥ 66 while the object ends up with 6
locals, so the fill pairs a body compiled in one `FunctionContext` with another
function's `locals`. `compileNestedFunctionDeclaration` compiles the nested body
in a `liftedFctx` **while the enclosing function's context is live**, so the
first thing to check is whether the fill can take the body from the enclosing
context (65+ locals is entirely plausible for a large minified function) while
writing the nested placeholder's `locals`.

That is a specific, testable hypothesis and does not require the ESLint graph:
a nested function inside a host function with many locals, in a minified-style
(CJS-rewritten) source, should reproduce it.

### Note on the standing `#2043` attribution

The diagnostic's boilerplate blames the late-import index-shift class. For this
defect the evidence points elsewhere — a single placeholder write followed by an
in-place fill, with no shift involved. The text should be softened to name both
candidate classes rather than assert one.

### Hypothesis TESTED and NOT confirmed (2026-08-02)

The "nested body filled against the enclosing frame" reading above was tried
directly and **does not reproduce**. Three shapes, each a nested function
declaration inside a host with 70 locals, all compile and emit cleanly:

| shape | result |
| --- | --- |
| nested declaration in a 70-local host | clean |
| nested declaration **called before** its declaration (hoisting) | clean |
| nested declaration **capturing** two of the host's 70 locals | clean |

So the plain nested-declaration path is fine, and the trigger needs something
further: the real `ve` lives in a **minified, CJS-rewritten** source, so the
untested variables are the CJS rewrite, the enclosing construct (an IIFE, a
class method, or a deeper nesting level), and `opts.reuseReservedEntry` — the
branch that does NOT mint a fresh placeholder and is therefore the one path where
a pre-existing entry is adopted rather than created.

`reuseReservedEntry` is the most promising remaining lead precisely because it
reuses a slot someone else claimed; the traced write shows the entry for `ve`
being freshly pushed, but a LATER nested declaration reusing that reserved entry
would not appear as a second slot write and would still swap in a foreign body.

## Hypotheses ELIMINATED (2026-08-02)

Recorded so none of these is paid for twice. Each ESLint iteration is ~16 min, so
the negative results are most of the cost already spent.

| # | hypothesis | how it was eliminated |
| - | ---------- | --------------------- |
| 1 | #4133 cross-module **name collision** | the emit diagnostic reports `NAME SHARED BY n` when a defined-function name is duplicated. It did not fire for `ve`; the name is unique in the table. |
| 2 | a competing **slot write** (`replaceDefinedFuncAt`, a trampoline rebuild, a finalize pass) | `JS2WASM_TRACE_SLOT=1666` shows slot 1666 written **exactly once**, as an empty placeholder. Nothing overwrites it. |
| 3 | **shared body array** between two functions (a documented hazard here) | the emit dump compares body array identity across all 8,225 defined functions: **zero** shared arrays. |
| 4 | nested declaration compiled against the **enclosing frame** | three fixtures — nested in a 70-local host, called-before-declaration, and capturing host locals — all compile and emit cleanly. |
| 5 | `ctx.currentFunc` not switched during nested body compilation, so temps land in the enclosing frame | it *is* switched: `ctx.currentFunc = liftedFctx` before, restored after (`nested-declarations.ts:627/781`). |
| 6 | **call-site inlining** copying unmappable local indices | the inliner remaps only parameter `local.get`s and copies everything else verbatim — which *would* be unsound — but `INLINE_DISALLOWED_OPS` bars `block`/`loop`/`if`/`try`/`local.set`/`local.tee`, and registration rejects any callee with its own locals or a top-level `local.get >= paramCount`. Bodies are therefore flat, local-free and param-only, so the verbatim copy cannot produce an out-of-range index. |

### What is still true and unexplained

`ve` owns its slot, owns its body array, is written once, has 2 params + 6
locals, and its body contains `local.get 65`. Whatever produced that instruction
allocated against a frame of ≥ 66 and wrote into `ve`'s own body — so the next
step is to catch the **instruction** as it is appended, not the slot as it is
written.

### Concretely, the next probe

Extend the tracer to a body-append hook: wrap the `ve` placeholder's `body`
array (a `Proxy`, or a push-site assertion behind the same env var) that throws
the moment an instruction with a local index ≥ the current frame size is
appended. The stack at that throw names the producer directly, exactly as
`JS2WASM_TRACE_SLOT` named the slot writer. That is a ~20-line, one-run change
and is the cheapest remaining path.

### A latent unsoundness found on the way (separate issue material)

The inliner is safe **only because** of its gate. Its remap loop
(`call-identifier.ts`) copies every non-`local.get` instruction verbatim and
falls through to a verbatim copy for any `local.get` index not in `argLocals`.
If the eligibility gate is ever relaxed — to allow callee locals, control flow,
or `local.set`/`local.tee` — the loop silently emits foreign local indices. It
should refuse rather than rely on a distant gate staying strict.

## BISECTED (2026-08-02) — a codegen defect, and there are 14 of them

`JS2WASM_CHECK_FRAMES=1` (added in this session) runs the emitter's frame check
at the **end of codegen**, before any post-codegen pass. Result on the ESLint
graph:

```text
[js2:frames] position 1666 've'             frame=8  (2 params +  6 locals) worst local index=65
[js2:frames] position 1674 'Se'             frame=58 (3 params + 55 locals) worst local index=68
[js2:frames] position 1677 '_e'             frame=61 (4 params + 57 locals) worst local index=68
[js2:frames] position 1679 'Ce'             frame=27 (3 params + 24 locals) worst local index=68
[js2:frames] position 1680 'Pe'             frame=50 (3 params + 47 locals) worst local index=68
[js2:frames] position 1687 'De'             frame=56 (4 params + 52 locals) worst local index=68
[js2:frames] position 1705 'A'              frame=3  (3 params +  0 locals) worst local index=4
[js2:frames] position 1841 '__closure_288'  frame=6  (2 params +  4 locals) worst local index=17
[js2:frames] position 1843 '__closure_290'  frame=6  (2 params +  4 locals) worst local index=17
[js2:frames] position 1886 'equal'          frame=15 (3 params + 12 locals) worst local index=31
[js2:frames] position 3904 '__closure_1092' frame=6  (2 params +  4 locals) worst local index=17
[js2:frames] position 3906 '__closure_1094' frame=6  (2 params +  4 locals) worst local index=17
[js2:frames] position 4498 '__closure_1647' frame=6  (2 params +  4 locals) worst local index=17
[js2:frames] position 4500 '__closure_1649' frame=6  (2 params +  4 locals) worst local index=17
[js2:frames] 14 function(s) reference out-of-frame locals at end of codegen
```

### Three conclusions

1. **This is a CODEGEN defect, not a post-codegen pass.** Every one of these is
   already inconsistent when `generateMultiModule` returns. Fixups, peephole,
   dead-code elision and late-import shifting are all ruled out — as is the
   diagnostic's standing `#2043` attribution, which should be corrected.
2. **`ve` is not special.** It is simply the first function the emitter reaches.
   Fixing "the `ve` bug" was always the wrong framing; there are 14, in at least
   three families.
3. **The families are structured, and one is highly tractable:**
   - **`__closure_N`** (6 of 14) — every single one is `frame=6 (2 params + 4
     locals)` with `worst=17`. Identical shape every time, across four widely
     separated positions. A compiler-**synthesized** body, so the generator is
     findable and the pattern is systematic rather than input-dependent. **Start
     here.**
   - **the `Se`/`_e`/`Ce`/`Pe`/`De` cluster** (positions 1674-1687) — all
     `worst=68` with wildly different frames (27 to 61), so they share one
     producer that bakes a fixed index regardless of the host frame.
   - **`ve`, `A`, `equal`** — assorted, smallest overshoot (`A` is 4 in a
     3-slot frame).

### Next step

Take `__closure_288`: identical to five siblings, so a reduced fixture is very
likely reachable without ESLint. Find what emits `__closure_<n>` bodies and why
it writes a `local.get 17` into a 6-slot frame — the constant 17 across
unrelated call sites suggests an index captured from a *template* or a
lifting context rather than the closure's own frame.

### Reduced-repro sweep — 8 more shapes, all clean

With `JS2WASM_CHECK_FRAMES=1` a candidate now costs **milliseconds** instead of a
15-minute ESLint compile, so shapes can be swept in bulk. Eight closure-heavy
programs — each with a 20-local host — all compile with **no** out-of-frame
local:

arrow capturing many host locals · arrow nested in arrow · arrow created in a
loop · arrow as an `Array.map` callback · `function` expression capturing ·
arrow inside `try`/`catch` · two-param arrow capturing · arrow inside a nested
function declaration.

So the `__closure_N` breach is **not** reached by ordinary closure creation over
a wide host frame. The remaining distinguishing features of the real sites are
the ones these fixtures lack: **minified, CJS-rewritten** sources, and whatever
enclosing construct the ESLint dependency uses (IIFE / class body / deeper
nesting).

**Use the checker, not a hypothesis.** The productive next move is to bisect by
INPUT rather than by guessing shapes: run `JS2WASM_CHECK_FRAMES=1` over each of
the 146 resolved sources compiled alone, find which single file produces a
`__closure_N` breach, and reduce from that file's real text. That converts an
open-ended search into a bounded one, and each probe is seconds.

## REPRODUCER FOUND (2026-08-02) — one file, seconds

Bisecting **by input** (compile each of the 146 resolved sources as its own
entry under `JS2WASM_CHECK_FRAMES=1`) localises it to a handful of files, the
smallest being `uri-js`'s minified ES5 bundle — **57 KB, self-contained**:

```sh
JS2WASM_CHECK_FRAMES=1 node --max-old-space-size=4096 --import tsx \
  tests/helpers/compile-project-probe.ts \
  node_modules/.pnpm/uri-js@4.4.1/node_modules/uri-js/dist/es5/uri.all.js \
  '{"allowJs":true,"target":"gc","platform":"node","allowFs":true}'
```

```text
[js2:frames] position  28 '__closure_21' frame=6  (2 params +  4 locals) worst local index=17
[js2:frames] position  30 '__closure_23' frame=6  (2 params +  4 locals) worst local index=17
[js2:frames] position  77 'resolve'      frame=15 (3 params + 12 locals) worst local index=33
[js2:frames] position  78 'normalize'    frame=7  (2 params +  5 locals) worst local index=33
[js2:frames] position  79 'equal'        frame=21 (3 params + 18 locals) worst local index=33
[js2:frames] position 134 '__closure_63' frame=6  (2 params +  4 locals) worst local index=17
[js2:frames] position 136 '__closure_65' frame=6  (2 params +  4 locals) worst local index=17
[js2:frames] 7 function(s) reference out-of-frame locals at end of codegen
```

**Identical signature to the ESLint graph** — `__closure_N` at `frame=6
(2 params + 4 locals)` with `worst=17` — so this is the same defect, not a
lookalike. A ~15-minute, 146-source compile is now a seconds-long one-file probe.

Other single-file reproducers from the same sweep, all likewise self-contained:
`resolve.js`, `error_classes.js`, `index.js`, `ajv.js` (8 breaches each).

### Why the constants matter

Within one file every breach shares an index: `17` for the `__closure_N` family
and `33` for `resolve`/`normalize`/`equal`, **regardless of each function's own
frame** (7, 15 and 21 slots respectively). A constant that ignores the host frame
is not an off-by-one — it is an index carried over from **one specific other
frame**, so the producer is copying instructions from a shared source rather than
miscomputing per function. Find which function in `uri.all.js` has ≥ 34 slots and
the origin is likely immediate.

### Status

This supersedes the earlier framing entirely: the issue is **not** "the `ve`
bug", and not ESLint-specific. It is a general codegen defect that any minified
bundle appears to trigger, of which ESLint's failure is one instance. Retitled
accordingly.

## The offending SOURCE CONSTRUCT, named (2026-08-02)

`JS2WASM_CHECK_FRAMES=1` now also fires inside `compileArrowAsClosure`, printing
the arrow/function-expression **source text** the moment a lifted body escapes
its own frame. On `uri.all.js` all four `__closure_N` breaches are two functions,
each compiled twice:

```text
[js2:closure-frame] __closure_21 frame=6 (2 params + 4 locals) worst=17
  source: function toUnicode(input) { return mapDomain(input, function (string) {
             return regexPunycode.test(string) ? decode(string.slice(4).toLowerCase()) : string; }); }

[js2:closure-frame] __closure_23 frame=6 (2 params + 4 locals) worst=17
  source: function toASCII(input) { return mapDomain(input, function (string) {
             return regexNonASCII.test(string) ? 'xn--' + encode(string) : string; }); }
```

The breaching unit is the **outer named function expression**, not the inner
callback. Both have the identical shape:

> a **named function expression** whose entire body is
> `return helper(input, function (x) { … });` — an **inline callback passed to a
> user function**.

And the number lines up: `mapDomain`, the callee, has a **40-slot** frame in the
same module (`[js2:emit] 18  40  mapDomain`), so `worst=17` is comfortably inside
*its* frame while being far outside the 6-slot closure that ended up holding it.
Something copies instructions from the callee's frame into the caller's body.

### Minimal-repro attempts that did NOT reproduce

Four variants of exactly that shape, each with a 40-slot `helper`, all compile
clean:

| variant | result |
| --- | --- |
| named function expression + inline `function` callback | clean |
| plain function declarations, same shape | clean |
| named function expression + **arrow** callback | clean |
| callback with the regex/ternary body from the original | clean |

So the shape is necessary but **not sufficient** — the surrounding `uri.all.js`
context contributes. That bundle is UMD: an outer IIFE, `_typeof`/`_slicedToArray`
helper preludes, and the whole module compiled twice (both `toUnicode` and
`toASCII` appear at two closure ids, e.g. 21/23 and 63/65), which is itself worth
a look — a module compiled twice is exactly where a stale frame could be reused.

### Now-cheap next step

`uri.all.js` is 57 KB of readable ES5 (not single-line). With the closure
reporter, deleting halves of the file and re-probing costs **seconds** per round,
and the reporter names the surviving construct each time. That is a
straightforward delta-debug to a minimal fixture — no more hypothesis-guessing
required.

## Delta-debugged to 200 lines — and the signal is an OFF-BY-ONE (2026-08-02)

Automated statement-level reduction (greedy removal from the UMD factory body,
re-probing with the closure-frame reporter as the oracle) took the reproducer
from the full 146-source ESLint graph down to a single file:

| stage | size |
| --- | --- |
| ESLint `linter.js` graph | 146 sources, ~15 min per probe |
| `uri.all.js` alone | 57,304 B, seconds per probe |
| after reduction round 1 | 19,011 B |
| **fixpoint** | **8,392 B / 200 lines**, 5 load-bearing factory statements |

Two independent reduction strategies (largest-statement-list, and
factory-body-targeted) converge on the same fixpoint, so this is the limit of
statement-level deletion; going further needs sub-statement granularity.

### The five load-bearing statements

```js
var URI_PROTOCOL = buildExps(false);
var IRI_PROTOCOL = buildExps(true);
var regexSeparators = /[\x2E\u3002\uFF0E\uFF61]/g;
function mapDomain(string, fn) { … var encoded = map(labels, fn).join('.'); … }
var toUnicode = function toUnicode(input) {
  return mapDomain(input, function (string) { … });
};
```

Note `buildExps` is called **twice**, and in the original it is a function with a
very large local frame.

### The sharpened signal

At the fixpoint the reporter says:

```text
[js2:closure-frame] __closure_2 frame=4 (2 params + 2 locals) worst=4
[js2:closure-frame] __closure_6 frame=4 (2 params + 2 locals) worst=4
```

**`worst=4` against `frame=4`** — the body references exactly ONE index past the
end of its own frame, where the un-reduced file showed `worst=17` against
`frame=6`. An off-by-one is a much more specific defect than an arbitrary stale
index: it points at an index computed as `params + locals` where
`params + locals - 1` was meant, or at a local that was counted and then dropped
from the emitted list — not at a wholesale frame mix-up.

That also weakens the earlier "body from another function's frame" reading: at
the fixpoint there is no 40-slot neighbour to borrow from.

### Caveat on the fixture

The reducer's oracle is "does the closure-frame reporter still fire", and a
compile that emits *diagnostics* still returns normally — so the reduced file is
**not** guaranteed to be semantically valid JavaScript (some referenced helpers
may have been deleted). That is acceptable for a compiler-crash fixture but it
must be cleaned up before being committed as a test, and the cleaned version
re-verified to still breach.

### Reproducing the reduction

The reducer is a ~70-line script: parse the file, take the UMD factory body's
statement list, greedily try deleting each statement from last to first, keep the
deletion when `compileMulti` still prints `[js2:closure-frame]`, repeat to
fixpoint. With in-process `compileMulti` each probe is well under a second.

## The exact bad instruction, and four ruled-out hypotheses (2026-08-02)

`JS2WASM_FRAME_OPS=1` dumps the offending lifted body instruction-by-instruction.
On the 200-line fixture, both breaching closures are byte-identical:

```text
__closure_2  params=ref_null,externref  locals=__self_cast:ref, regexSeparators:externref
  local.get 0          ; __self
  ref.cast
  local.set 2          ; __self_cast
  local.get 2
  struct.get           ; read capture field
  local.set 3          ; regexSeparators
  local.get 4          ; <<<< OUT OF FRAME (frame is 0..3)
  local.get 1          ; input
  ref.func
  i32.const
  struct.new           ; build the INNER callback's closure
  extern.convert_any
  call                 ; mapDomain(...)
  extern.convert_any
  call
  return
```

So the bad read is **not** in the capture prologue — that ran correctly, once,
for the single capture `regexSeparators` (local 3). `local.get 4` is emitted
immediately before `struct.new`, i.e. while **constructing the inner callback's
closure struct**: it is pushing a capture VALUE for the inner closure, read from
the outer frame, at an index the outer frame does not have.

### Ruled out, with evidence — do not re-investigate these

1. **`allocLocal` off-by-one.** It computes `index = params.length + locals.length`
   *before* pushing, which is correct.
2. **A body-swap crossing a speculative probe.** `snapshotSpeculative` records
   `bodyLen` as a number, not the array identity, so a `savedBodies` swap between
   snapshot and rollback would truncate the wrong array. Instrumented
   `rollbackSpeculative` to report when `fctx.body !== ` the snapshot array:
   **never fires** on the fixture.
3. **A stale `localMap` entry.** The callback-capture collector
   (`closures.ts`, `fctx.localMap.get(name)`) skips names it cannot find, so a
   `localMap` entry pointing past the frame would explain it exactly.
   Instrumented the reporter to list `localMap` entries `>= frame`:
   **`STALE-localMap=none`** for both closures.
4. **A second truncation site.** `fctx.locals.length = …` appears exactly ONCE in
   all of `src/codegen/` (`restoreLocals`), whose only caller is
   `rollbackSpeculative` — and that truncates `fctx.body` too. So this is not a
   case of some other path shrinking locals behind the body's back.

### Where that leaves it

The value pushed for the inner closure's capture is resolved through some path
OTHER than the outer `localMap` — the collector at `closures.ts` (the
`callbackCaptures` construction) is the place to instrument next: print, for each
capture it emits at the construct site, the name and the index it chose and where
that index came from. The frame is only 4 slots wide, so the wrong index is
almost certainly `params.length + locals.length` computed against a DIFFERENT
FunctionContext (the inner callback's, or the enclosing non-lifted one) and then
emitted into this body.

`JS2WASM_FRAME_OPS=1` is committed and does exactly this dump, so the next step
costs seconds, not another compile cycle.

## ROOT CAUSE FOUND AND ONE CLASS FIXED (2026-08-02)

A `push`-trap on the lifted body (`JS2WASM_FRAME_OPS=2`, since removed) printed
the stack of whoever wrote the out-of-frame index. It is
`compileIdentifierCall` (`src/codegen/expressions/call-identifier.ts`), in the
branch that pushes a nested function's capture values at its call site:

```ts
fctx.body.push({ op: "local.get", index: cap.outerLocalIdx });
```

`cap.outerLocalIdx` is a slot in the **declaring** function's frame. When the
nested function is called from a DIFFERENT frame — here, from inside a lifted
closure — that index can point past the current frame entirely.

Confirmed with the exact values:

```text
[js2:nested-cap] 'regexSeparators' outerLocalIdx=4 frame=4 in __closure_2
                 mapped=3 capturedGlobal=false moduleGlobal=false
```

`mapped=3` — the lifted closure genuinely HAS the capture, materialised by its
own prologue at slot 3. The emitter simply used the declaring function's slot
number instead.

**Mechanism**: `mapDomain` is a nested function capturing `regexSeparators`.
`toUnicode` is a lifted closure that CALLS `mapDomain`, so it transitively
captures `regexSeparators` into its own frame. At the call site the emitter
pushed the declaring frame's index.

### Why the fix is narrow, and why that matters

The obvious fix — `localMap.get(name) ?? outerLocalIdx` — is **known to be
unsafe**: the in-file note records that #1177 tried exactly that and caused
**100+ test262 regressions**, because main's wrong-slot read is load-bearing for
tests relying on the resulting null deref throwing.

So the guard prefers the mapped slot **only when `outerLocalIdx` is out of the
current frame** — i.e. only where the existing behaviour emits provably invalid
Wasm and there is therefore no working behaviour to preserve. Every in-frame
case is byte-identical. Equivalence confirms it: 32 failed / 1611 passed, empty
diff against base.

### Measured

| fixture | before | after |
| --- | --- | --- |
| 200-line reduced fixture | 2 breaches, compile fails | **0 breaches, compiles** |
| real `uri.all.js` | 8 breaches | **3** |
| ESLint package entry | blocked at binary emit | still blocked (see below) |

### What is NOT fixed — a SECOND, distinct class

The 3 survivors on `uri.all.js` are `resolve`, `normalize` and `equal` — **top-level
functions, not lifted closures** — and the `nested-cap` probe does not fire for
them. All three breach at **exactly index 33**, despite frames of 15, 7 and 21.
A single shared index across three unrelated functions points at an inlined body
carrying its own frame indices, not at a capture mis-resolution.

ESLint's remaining blocker is this second class: `local (local.get) index out of
range — 65 (valid: [0, 8)) at function 've' (position 1666, 6 declared locals)`.

### No synthetic test ships with this fix

Six synthetic shapes were tried across this investigation — named function
expression + inline callback, plain declarations, arrow callback, shadowed
parameter name, forwarded callback, the UMD-nested sibling-closure layout, and
finally the exact declaring-frame/lifted-frame mechanism above. **All compile
clean on both sides.** The real `uri.all.js` remains the only reproducer, and the
evidence for the fix is the measured breach-count drop plus the reduced fixture
going 2 → 0. A committed test needs either the cleaned 200-line fixture (see the
validity caveat above) or a programmatic surface for the frame checker's result,
which today is env-gated stderr only.

## The SECOND class is introduced AFTER body emission (2026-08-02)

Two probes, both silent, narrow it sharply:

1. **The inliner is not the source.** `compileIdentifierCall`'s inline path
   remaps only PARAMETER indices and copies anything else verbatim, which looked
   like an obvious candidate — three callers inlining one callee would all carry
   its index. Instrumented every unmapped `local.get` at inline time
   (`[js2:inline-unmapped]`): **never fires** on `uri.all.js`. Registration
   already rejects a callee with any local (`func.locals.length > 0`) or any
   `local.get >= paramCount`, and that invariant evidently holds through to the
   inline.

2. **Nothing writes the bad index during emission.** The same `push`-trap that
   identified the first class immediately — applied here to ORDINARY function
   bodies in `compileFunctionBody` — is **silent** for `resolve`, `normalize` and
   `equal`, even though the end-of-codegen checker reports all three.

So the bad indices are **not emitted by body compilation at all**. They are
introduced by a pass that runs BETWEEN the end of a function's body compilation
and the end of codegen — a remap, a shift, a splice, or a body replacement.

That reframes the error message's own `#2043 late-import index-shift` hint: for
this class it may be the right FAMILY (a post-hoc index remap) applied to the
wrong index space — locals rather than funcidx.

### Candidates to instrument next, in order

- the late-import shift (`flushLateImportShifts` / `addUnionImports` /
  `addStringImports`) — does any of them walk `local.*` operands?
- dead-code elimination / peephole renumbering,
- the IR overlay patching a legacy body in place,
- `fixupStructNewArgCounts` / the other post-body fixup passes.

The cheapest decisive probe is a checksum: record each function's set of
`local.*` indices at the end of its own compilation, re-check at end of codegen,
and report the first pass boundary where the two diverge.

All three survivors share **index 33** despite frames of 15, 7 and 21, so
whatever mutates them applies one common offset or one common source of indices.

## Second class: narrowed to a compilation path, not a post-pass (2026-08-02)

`JS2WASM_FRAME_STAGES=1` re-runs the breach count after each post-body pass and
prints the first boundary where it grows. Result on `uri.all.js`:

```text
[js2:frame-stage] after bodies: 0 -> 3
```

So the breaches ARE introduced during the bodies phase — the earlier conclusion
("not emitted by body compilation") was **wrong**, and wrong for a specific
reason worth recording: the `push`-trap it rested on was installed on
`fctx.body`, but `fctx.body` is REASSIGNED during compilation (the `savedBodies`
swap), so the proxy stops observing writes after the first swap. A trap on a
field that gets reassigned is not a trap.

Further narrowing, all measured:

- **Not the inliner.** Every unmapped `local.get` at inline time is instrumented
  (`[js2:inline-unmapped]`); silent.
- **Not the late-import shift.** That walker only rewrites `funcIdx` on
  `call` / `return_call` / `ref.func`; it never touches `local.*` operands. The
  error message's own `#2043` attribution is misleading for this class.
- **Not a frame shrink or a body splice after compilation.** Snapshotting
  `locals.length` / `body.length` at each function's compile and re-checking at
  the end of the bodies phase reports **no** change.
- **These three functions never reach `compileFunctionBody`'s wired call sites
  at all** — `dumpFrameBreach`, hooked at both, never fires for them, and they
  have no snapshot entry.

`resolve`, `normalize` and `equal` are **nested** function declarations (inside
the UMD factory), not module-top-level ones, so they are compiled by a different
route than the two sites instrumented here. That route is where to look next.

All three call `parse(...)` and `serialize(...)`, and all three breach at the
same index 33 — consistent with one shared callee's frame leaking into three
callers along that nested-declaration path.

### Instrumentation now available (all env-gated, inert by default)

- `JS2WASM_CHECK_FRAMES=1` — end-of-codegen breach report.
- `JS2WASM_FRAME_OPS=1` — per-closure instruction dump, the nested-capture probe,
  the inline-unmapped probe, and `dumpFrameBreach` for ordinary functions.
- `JS2WASM_FRAME_STAGES=1` — breach count after each post-body pass, plus a
  locals/body-length delta per function.

## SECOND CLASS FIXED (2026-08-02) — transitive nested-sibling captures

The `resolve`/`normalize`/`equal` class is a **capture-analysis gap**, not a
post-pass and not an index-shift.

### Mechanism

A nested function declaration is lifted to a module-level Wasm function with its
captures as leading synthetic params. At a call site the caller supplies the
callee's captures by `local.get`-ing the **declaring** frame's slot
(`nestedFuncCaptures` prepend, `call-identifier.ts`). Capture collection only
looked at names the body referenced **directly** — so a sibling that merely
*calls* the capturing function captured nothing, and emitted the declaring
frame's slot number into its own, much smaller frame.

In `uri.all.js` the UMD factory declares `SCHEMES` (slot 31), `URI_PARSE` (32),
`NO_MATCH_IS_UNDEFINED` (33) …; nested `parse`/`serialize` capture them; sibling
`normalize`/`resolve`/`equal` call `parse` without ever naming them. Confirmed
directly:

```text
[js2:nested-cap] 'SCHEMES' callee='parse' caller='normalize'
                 outerLocalIdx=31 frame=2 mapped=none
```

`mapped=none` — the caller does not have the value at all, which is why the
first-class fix (prefer the mapped slot when out of frame) could not help.

### Fix

`transitiveSiblingCaptures` closes "captures an outer local" over the
"references a sibling declaration" edge; those names become the caller's own
captures and ride in as leading params. `liftedCaptureNames` marks them on the
`FunctionContext` so the forwarding call site reads the param instead of the
declaring slot.

Three constraints, each of which cost a wrong attempt:

1. **The closure must be SYNTACTIC, not read from `ctx.nestedFuncCaptures`.**
   The Phase-0 reservation in `hoistFunctionDeclarations` must reach the same
   verdict *before any sibling has been compiled*. When the two disagreed —
   reservation "capture-free", compile "capturing" — the capturing branch never
   filled the reserved slot and **every call to that function returned 0**.
2. **Phase 0 consults the same helper**, for the same reason.
3. **The call site prefers the mapped slot whenever the name is one of THIS
   function's own capture params**, not merely when the declaring index is out
   of frame. An in-frame declaring index is equally meaningless and silently
   read an unrelated local. The narrow condition preserves the #1177 revert.

### This was also a SILENT WRONG ANSWER

The small shape — a 2-local host, no out-of-frame index — compiles fine on base
and computes **2** where node gives **101**. So the defect's reach is larger than
"minified bundles fail to validate": any nested function calling a capturing
sibling could read the wrong slot and return a plausible wrong number.

### Measured

| target | before | after |
| --- | --- | --- |
| `uri.all.js` | 3 out-of-frame fns, no binary | **0, valid 131 KB module** |
| ESLint Tier 1a package entry | 14 out-of-frame fns | **1** |
| small sibling-call fixture | returns 2 (node: 101) | **101** |

### The remaining ESLint breach is #4133, not this class

`assertASTDidntChange` (eslint's `rule-tester.js`) calls `equal` —
*fast-deep-equal*, capture-free. But `ctx.nestedFuncCaptures` is keyed by the
**bare name**, so it collides with **uri-js's** nested `equal`, and the call site
prepends uri-js's factory locals:

```text
[js2:nested-cap] 'SCHEMES'    callee='equal'     caller='assertASTDidntChange' outerLocalIdx=31 frame=2
[js2:nested-cap] 'UNRESERVED' callee='equal'     caller='assertASTDidntChange' outerLocalIdx=51 frame=2
[js2:nested-cap] 'SCHEMES'    callee='serialize' caller='_addSchema'           outerLocalIdx=31 frame=22
```

Every name is a uri-js factory local; `assertASTDidntChange` and ajv's
`_addSchema` have nothing to do with uri-js. This is the **#4133 flat-namespace
hazard** in `nestedFuncCaptures`, one layer below the `funcMap` collision #4133
already fixed. That is the next blocker for an ESLint binary, and it belongs to
#4133, not here.

### Validation notes (honest)

- The 106 test files a full-suite run had not reached were A/B'd against base in
  three batches — **all identical**.
- Files that looked newly-failing (`ir/utf8-storage`,
  `issue-2949-slice2/slice3b`, `issue-1126-stage3`) were A/B'd individually and
  fail **identically on base** — pre-existing.
- A full-suite `npm test` OOMs in a ~512 MB vitest worker shortly after
  `issue-2542-standalone-dynamic-key`. **I did not establish whether this change
  causes it.** An earlier full run of an intermediate version of the fix
  completed cleanly and matched base exactly. Worth a dedicated look; do not
  read the batch results as covering it.

### Instrumentation added

`JS2WASM_FRAME_TRAP=<funcName>` (`src/codegen/frame-trap.ts`) reports, with a
stack, the moment an out-of-frame local reference is appended to that function's
body. It installs the accessor on the **FunctionContext**, not on `fctx.body` —
`fctx.body` is reassigned during compilation, so a proxy on the array stops
observing writes after the first swap. That is exactly the mistake that produced
an earlier wrong conclusion on this issue ("introduced after body emission").

## The out-of-frame GUARD cannot close the last two breaches (2026-08-03)

Measured on the ESLint Tier 1a graph with the guard applied at all three sites
(call-site prepend, nested-declaration scoping, closure-VALUE materialisation):

```text
[js2:frames] position 1290 '__fnctor_MurmurHash3_new' frame=15 worst local index=24
[js2:frames] position 3508 'assertASTDidntChange'     frame=4  worst local index=51
[js2:frames] 2 function(s) reference out-of-frame locals at end of codegen
```

**Identical to the run before the third-site guard was added.** The guard is a
no-op for these two, and the reason is structural, not a bug in the guard:

```ts
capSourceIdx = <out of frame>
  ? (fctx.localMap.get(cap.name) ?? cap.outerLocalIdx)   // <-- nothing to fall back TO
  : cap.outerLocalIdx;
```

The guard can only *prefer a better slot when one exists*. In both survivors the
capture is not present in the current frame in any form — `localMap` has no
entry — so the fallback lands on the same invalid index. Substituting a slot is
the wrong shape of fix for "the value is not here at all".

### Why each one is unreachable

- **`__fnctor_MurmurHash3_new`** — imurmurhash declares `MurmurHash3` inside an
  IIFE that also holds the captured `cache`. The synthesized fnctor constructor
  is compiled into its OWN small context, which never receives the IIFE's
  captures.
- **`assertASTDidntChange`** — eslint's rule-tester calls fast-deep-equal's
  `equal`, but the bare name resolves to uri-js's factory-nested `equal`, whose
  captures are IIFE-factory locals. Note this one is a REGRESSION of the #4133
  narrowing: suppressing the out-of-scope binding removed it, but suppression
  caused the `null_deref` explosion, so the suppression was narrowed back.

### The actual fix, and why it is not attempted here

The value has to be made *reachable*, not re-indexed. The mechanism already
exists in this codebase for the analogous #2029 family-A case: promote the
capture to a module global (`ctx.capturedGlobals` /
`ctx.capturedBoxGlobals`) and read it with `global.get`, which
`funcref-as-closure.ts` and `call-identifier.ts` both already do on that path.

Extending that promotion to cover cross-frame-unreachable captures is a design
change with real blast radius (it changes mutation semantics — a global is
shared where a per-activation slot is not), and it interacts with the #4133
suppression tension recorded below. It should be specced, not improvised at the
end of a long session.

### The #4133 tension, stated plainly

These two pull in opposite directions and neither end is currently safe:

| out-of-scope nested binding | consequence |
| --- | --- |
| suppress it | call falls to `ref.null.extern` → `null_deref` +1200 on Temporal |
| let it through | wrong-frame capture index → out-of-frame, module fails to validate |

A correct fix has to make the *right* callee reachable, which is the same
promotion work. Until then the branch takes the "let it through" end, because an
invalid module is a loud failure and a null-trap explosion is a conformance
regression that also parks the merge queue.

---

# POST-MERGE STATE — PR #4074 landed a slice, 2026-08-04

`status` stays `in-progress`, **not** `done`: the PR that closed ten sibling
issues shipped only the first half of this one. Recording the boundary so the
next lane starts from the remainder rather than re-deriving it.

## What landed

The out-of-frame capture guard. `main` had independently landed the equivalent
as a shared helper — `captureSourceSlot` (`src/codegen/closures/capture-source-slot.ts`)
— and the merge took main's version, so the rule now lives in one place:

> prefer the mapped slot when the name is one of this lifted function's own
> capture params, **or** when `outerLocalIdx` lands outside the frame entirely
> (where the historical read is provably invalid Wasm, so there is no behaviour
> to preserve).

Restricting the second disjunct to *out-of-frame* is what makes it safe where
#1177's blanket `localMap`-first lookup was not: every in-frame call stays
byte-identical.

Measured effect: `uri.all.js` went from 8 out-of-frame functions and no binary
to **0 and a valid 131 KB module**. ESLint went from 14 to **2**.

## What remains — and why re-indexing will not close it

Two functions still emit out-of-frame locals:

| function | worst index | frame |
| --- | ---: | ---: |
| `__fnctor_MurmurHash3_new` | 24 | 15 |
| `assertASTDidntChange` | 51 | 4 |

These are **not** more of the same bug. The right callee is not merely
mis-indexed, it is **unreachable** from the frame doing the call, so no choice
of index is correct. The mechanism that fixes it already exists: the #2029
family-A promotion of a capture to `capturedGlobals`. Applying it here changes
mutation semantics for the promoted binding, so it needs a spec before code —
see `/architect-spec`.

## Negative results — do not re-run these

- **A third guard site** (`funcref-as-closure.ts`, the closure-**value**
  materialisation path, as opposed to the call-site prepend) was implemented and
  **measured ineffective**: `localMap` is empty there, so the guard falls through
  to the identical index. It was briefly claimed here as "the last blocker" —
  that was wrong and was retracted on the PR. The merge dropped it in favour of
  main's shared helper.
- **A recompile path** (`funcMapOwnerDecl` + `restoreShadowedFuncBindings`) broke
  lodash `createHybrid` and was backed out entirely.
- **Suppressing the out-of-scope nested binding** — i.e. emitting
  `ref.null.extern` rather than a wrong index — trades an invalid module for a
  `null_deref` explosion (+1200 on Temporal, measured). The shipped code
  deliberately picks "let it through": an invalid module fails loudly at
  validation, whereas a null-trap explosion is a silent conformance regression.
  That trade is the residual this issue still owns.

## Instrumentation left in place (env-gated, inert by default)

`JS2WASM_FRAME_TRAP=<fn>` (`src/codegen/frame-trap.ts`) reports, with a stack,
the moment an instruction referencing an out-of-frame local is appended to a
function's body. It installs the accessor on the **FunctionContext**, not on
`fctx.body` — `body` is reassigned by the `savedBodies` swap, so a proxy on the
array stops observing after the first swap. That detail is what made it work
where a naive proxy did not; keep it if you touch the file.

Also available: `JS2WASM_COMPILE_PROFILE`, `JS2WASM_CHECK_FRAMES`,
`JS2WASM_FRAME_OPS`, `JS2WASM_FRAME_STAGES`, `JS2WASM_TRACE_SLOT`.

---

## Verification Plan — #4133/#4134 shared remainder (capturedGlobals promotion)

Written 2026-08-04 by the verification architect. The mechanism (#2029 family-A
promotion of unreachable captured bindings to module globals) is specced
separately in `## Implementation Plan`. This section answers only: how do we
know it is correct, and what will it break. Everything marked **verified** below
was run or read in this session; the workflow-gate claims cite the file read.

### 0. Ground truth at plan time (verified 2026-08-04)

- `uri.all.js` probe: **0 out-of-frame functions, valid 131,546-byte module**
  (`JS2WASM_CHECK_FRAMES=1 … compile-project-probe.ts …/uri-js/dist/es5/uri.all.js`,
  ran in ~2 min including TS program load). This is the do-not-regress floor.
- The residual is exactly two functions on the ESLint Tier 1a graph:
  `__fnctor_MurmurHash3_new` (worst 24 / frame 15) and `assertASTDidntChange`
  (worst 51 / frame 4). Both fail **loudly** today (invalid module at emit).
  That loud failure is the current safe state; any change that converts it into
  a silent wrong value or a null trap is strictly worse than not shipping.

### 1. Unit / equivalence tests to write

Convention (project-wide, and enforced in review on this issue): every test
states in a header comment **what the unfixed base does**, with the measured
wrong value or the measured `success:false`. A test that passes on base is
decoration, not evidence — see the recorded lesson in
`tests/issue-4133-cross-module-function-name-collision.test.ts` (3 of 4 rungs
pass on base because small bodies inline). Measure base via file-copy A/B
(`cp src/... .tmp/`, `git show HEAD:src/... > src/...`), **never `git stash`**.

New file `tests/issue-4134-unreachable-capture-promotion.test.ts` (same
`compileMulti` + import-backfill harness as the existing #4133/#4134 guards):

| # | construct | expected (node) | non-vacuity proof on unfixed base |
|---|-----------|-----------------|-----------------------------------|
| T1 | imurmurhash shape: IIFE holding `let cache` + a constructor-style `function MurmurHash3()` that reads/writes `cache`, called both with and without `new` from module scope; wide (20+ local) IIFE body so `cache`'s slot is out of any synthesized frame | the concrete hash/cache value node computes for the fixture | base: `success:false`, no binary — out-of-frame local at emit (the `__fnctor_MurmurHash3_new` class). Assert `success===true` **and** the value; compile success alone is vacuous |
| T2 | cross-module unreachable callee: module A = UMD-style factory with wide frame + nested capturing `equal`; module B calls its **own** `equal` (fast-deep-equal shape); B's caller frame is 4 slots | B's caller returns B's `equal` result (e.g. 1), A's factory returns its own sum | base: this is the `assertASTDidntChange` class — `success:false` at emit. NOTE: distinguish from `tests/issue-4133-nested-name-scope.test.ts`, which passes on current main because its capture IS reachable there; this rung must use a shape where the shipped scoping still resolves to the out-of-scope nested binding |
| T3 | mutation visibility: capture reassigned **after** the closure/nested fn is created, then the promoted-path callee is invoked | callee sees the updated value (ref-cell semantics must survive promotion) | on base the whole fixture fails to emit (same T1 shape carrier); on a *reachable* control variant (same code, narrow host frame) the value must be identical before/after the fix — that control is the anti-overreach probe |
| T4 | factory invoked twice (hazard 4 — see §3 matrix) | two independent states | base fails to emit; the point of the rung is that the FIX must not share |
| T5 | no-change guard: re-run the three existing guards (`issue-4133-*.test.ts` ×2, `issue-4134-transitive-nested-captures.test.ts`) plus a binary-hash A/B on `uri.all.js` (sha256 of the emitted binary, base vs fix) | byte-identical uri.all.js binary, or a named justified diff | these are already non-vacuous against their own bases; the binary hash is the "promotion fired only where nothing worked before" check |

Equivalence: run the full suite locally once
(`pnpm exec vitest run tests/equivalence.test.ts` or `node
scripts/equivalence-gate.mjs` per shard) and require an **empty diff vs base**
(the standard set on this issue: 32 failed / 1611 passed on both sides, same
membership). Any membership change is an iterate signal even if counts match.

### 2. npm-library / real-bundle checks (all local; NONE of these run in any PR gate — see §5)

Commands, cheapest first:

1. **uri.all.js floor** (~2 min, verified):
   ```sh
   JS2WASM_CHECK_FRAMES=1 node --max-old-space-size=4096 --import tsx \
     tests/helpers/compile-project-probe.ts \
     node_modules/.pnpm/uri-js@4.4.1/node_modules/uri-js/dist/es5/uri.all.js \
     '{"allowJs":true,"target":"gc","platform":"node","allowFs":true}'
   ```
   Must stay `0 function(s) … out-of-frame`, `valid:true`. Also hash the binary
   for the T5 byte-identity check.
2. **lodash full bundle** — the `createHybrid` canary. The recompile-path
   attempt on this issue broke lodash `createHybrid` and **no committed test
   caught it** (verified: `createHybrid` appears nowhere in `tests/`; the
   tier suites cover memoize/flow/partial/negate per-module, not the bundle).
   So probe the bundle directly:
   ```sh
   JS2WASM_CHECK_FRAMES=1 node --max-old-space-size=6144 --import tsx \
     tests/helpers/compile-project-probe.ts \
     node_modules/.pnpm/lodash@4.17.23/node_modules/lodash/lodash.js \
     '{"allowJs":true,"target":"gc","platform":"node","allowFs":true}'
   ```
   `createHybrid` is a nested function inside lodash's IIFE capturing many
   IIFE locals — exactly the promotion's blast zone. Expect: no new breaches,
   compile parity with base (A/B the probe output). Then run the runtime
   suites that exist: `pnpm exec vitest run tests/stress/lodash-tier1.test.ts
   tests/stress/lodash-tier2.test.ts tests/lodash-compile.test.ts`.
3. **Hazard-3 guards (scoping regressions)**:
   `pnpm exec vitest run tests/issue-165.test.ts
   tests/issue-2200-annexb-block-fn-hoist.test.ts tests/issue-1303.test.ts
   tests/issue-4133-nested-name-scope.test.ts` — the exact files the
   parent-block-vs-enclosing-function mistake regressed last time.
4. **ESLint Tier 1a** (~15 min per iteration — budget for exactly two runs:
   one to confirm 2 → 0 breaches + binary emits, one after any subsequent
   change):
   ```sh
   JS2WASM_CHECK_FRAMES=1 node --max-old-space-size=6144 --import tsx \
     tests/helpers/compile-project-probe.ts <tier1-entry.ts> \
     '{"allowJs":true,"target":"gc","platform":"node","allowFs":true}'
   ```
   (entry per `tests/stress/eslint-tier1.test.ts`; also run that test file.)
   This is the acceptance criterion of the whole effort; do not iterate against
   it — iterate against T1/T2 fixtures and use ESLint only to confirm.
5. Do **not** run `pnpm run generate:npm-compat` (tens of minutes; CI
   regenerates post-merge, and `--only` cannot write the artifact anyway).

### 3. Mutation-semantics probe matrix

The promotion moves a binding from a per-activation frame slot (or ref cell)
to **one module global**. That is only correct when the binding's hosting scope
is entered at most once per module instance. These probes decide whether the
predicate the implementation uses ("host provably single-invocation") actually
holds. Each row is a test in the T-file above or a sibling; each needs a
node-computed expected value in the assertion, and each must be run on the
control variant (reachable capture, narrow frame) to prove the fix did not
change already-correct behaviour.

| construct | expected behaviour | failure mode the probe catches |
|---|---|---|
| factory called twice; each call's closure increments its captured counter | two independent counters: `[1, 1]`, not `[1, 2]` | promoted global shared across activations — the headline hazard 4 |
| capture reassigned after closure creation, closure called before and after | closure observes the reassignment (live binding) | promotion snapshotting the value instead of the cell |
| recursive host: outer fn recurses, each depth's nested fn reads that depth's binding | per-depth values | one global serving all depths (last-write-wins) |
| loop-created closures over `let` (3 iterations, closures called after loop) | `[0, 1, 2]` | promoted global collapses to `[2, 2, 2]` |
| re-entrancy: nested fn's body calls back into the host before reading the capture | inner activation's mutation does not corrupt the outer's binding | global torn between interleaved activations |
| single-run IIFE / module-init host (the actual target shape: imurmurhash, uri-js UMD) | plain correct values | (this is the case promotion is FOR — it must pass, and is the only shape the promotion should fire on) |

Design consequence to hand the implementer: rows 1–5 are shapes where
promotion is **unsound**. The verification stance is: the promotion predicate
must exclude them (they keep today's behaviour — which for reachable captures
is correct, and for unreachable ones is the loud emit failure), and the probes
prove the predicate's edges. If the implementation instead makes rows 1–5 take
the promoted path, expect exactly the class of silent wrong answers this issue
family exists to kill — that is an abandon signal (§6), not a bug to patch
around.

### 4. Detecting the +1200 null_deref class BEFORE the merge queue

History: suppressing the out-of-scope binding emitted `ref.null.extern` at the
call and cost **+1200 null_deref** (measured, on Temporal-with-proposals) —
found only in the merge_group trap ratchet. The promotion has the same failure
shape available: a promoted global that is read before module init writes it,
or that init never writes on some path, is a null at the call site → the same
explosion, and the #3189 ratchet **hard-fails pass→trap with no valve**
(verified in `scripts/diff-test262.ts` `evaluateTrapCategoryGrowth`: only
baseline `fail` rows are eligible for a named `trap-growth-allow` (#3596);
baseline `compile_error`/`compile_timeout`/`skip`/absent are excluded outright
(#3595/#4141); baseline `pass` has no valve).

Local pre-flight, in cost order:

1. **Static canary, seconds**: `JS2WASM_CHECK_FRAMES=1` on uri.all.js + the
   T1/T2 fixtures. Catches out-of-frame regressions, NOT null-at-runtime.
2. **Scoped test262 A/B, ~minutes to ~tens of minutes** — the actual
   null_deref detector. The runner honours `TEST262_PATH_FILTER`
   (pipe-separated substrings, verified in `tests/test262-runner.ts`) and
   `TEST262_INCLUDE_PROPOSALS=1`:
   ```sh
   TEST262_INCLUDE_PROPOSALS=1 TEST262_PATH_FILTER="Temporal" \
     pnpm run test:262            # once on base, once on fix (file-copy A/B)
   ```
   plus a closure-semantics slice on the default population:
   `TEST262_PATH_FILTER="language/statements/function|language/expressions/function|language/statements/let|annexB/language/function-code"`.
   Then diff categories from the two jsonls
   (`benchmarks/results/test262-results-<ts>.jsonl`):
   ```sh
   jq -r 'select(.error_category=="null_deref" or .error_category=="illegal_cast" or .error_category=="oob" or .error_category=="unreachable") | .file' <run>.jsonl | sort > /tmp/traps-{base,fix}
   diff /tmp/traps-base /tmp/traps-fix
   ```
   **Decision input is the diff of trap FILES, not the pass count** — the
   ratchet gates on category membership. Any file appearing on the fix side
   only, whose base status was pass/fail, blocks: fix before PR.
3. **Full local conformance** — see §5 for what fits.

### 5. Trustworthy local conformance signal (honest costs)

- `JS2WASM_LOCAL_CI=1 ./scripts/local-ci.sh` — **fits and is the recommended
  single full-signal run** before opening the PR: idempotent setup + full
  test262 at `COMPILER_POOL_SIZE=$(nproc)`; recorded baseline ~68 min
  wall-clock / ~2.8 GB peak on a 4-core/16 GB container (script header,
  read this session). Run it once on the finished fix, not per iteration —
  per-iteration signal comes from §4's scoped runs. To A/B against base
  cheaply, prefer the scoped runs; a second full 68-min base run is only
  warranted if the scoped diffs are ambiguous.
- The recorded constraints stand: `--shard` does not partition as documented
  (one shard observed at 1h36m), and the unsharded `npm test` full suite OOMs
  in the default ~512 MB vitest worker. For the root-suite batches you need
  (equivalence + the named guard files), either run named files or raise the
  worker heap: `VITEST_FORK_MAX_OLD_SPACE_SIZE=2048 npm test -- <files…>`
  (knob verified in `vitest.config.ts`).
- Whatever local run you use, the merge_group diffs against the **fetched
  baseline** (`scripts/fetch-baseline-jsonl.mjs`, 6h freshness default) — for
  any local triage, read the fetch helper's stderr age report; a stale-cache
  comparison manufactures phantom deltas.

### 6. What a green PR does and does not prove (verified against workflow files)

Read this session from `.github/workflows/test262-sharded.yml` and `ci.yml`:

| gate | PR (`pull_request`) | merge_group |
|---|---|---|
| `cheap gate (main-ancestor + lint)` | runs | runs |
| `quality` (oracle-ratchet, func/loc budgets, **PR-touched root tests**, guard suite #3552) | runs | runs |
| `equivalence-gate` (8 shards vs `scripts/equivalence-baseline.json`) | runs (path-gated) | runs |
| test262 shard matrix | **does not run** — `test262-shard` has `if: push/workflow_dispatch` only; `test262-shard-mg` has `if: merge_group` only (test262-sharded.yml ~580 and ~827; the header comment at line 4 claiming "runs at PR-time" is **stale** — trust the job `if:`s) | runs (102-runner mg matrix) |
| `check for test262 regressions` (#3467 per-SHA diff) | **green no-op** — `HOST_RAN=false`, prints "No js-host … artifacts to diff" (regression-gate job, ~line 1630) | real gate |
| #3189 trap ratchet, #1668 catastrophic guard | no-op (same job) | real gate |
| standalone floor/net (#1897/#2097) | no-op | real — `merge-report` step is `if: … && github.event_name == 'merge_group'` (line ~1577) |
| root suite (~2,100 files incl. the #4133/#4134 guards, when untouched) | **not run** — post-merge only (`issue-tests.yml`: push:main + 6h cron; population is `tests/` root, non-recursive) | not run |
| `tests/stress/*` (lodash/eslint tiers) | **not run anywhere in CI** (not in issue-tests population — root readdir only; not in guard-suite.json — verified) | not run |

Consequences for the dev:

- A fully green PR proves lint/types/budgets, equivalence parity, and that the
  tests **this PR touches** pass. It proves **nothing** about test262, traps,
  or the standalone floor. The first conformance verdict the queue gives is a
  merge_group park (`hold` + `auto-park-bot:merge-group-failure`) — which is
  precisely how all four prior regressions in this area were found. §4 exists
  so this one is found at the desk instead.
- Because this PR adds/modifies the #4133/#4134 test files, they DO run at PR
  time (quality's changed-root step) — but the lodash/eslint tier evidence is
  local-only and must be pasted into the PR description, since no gate will
  reproduce it.
- If the fix legitimately converts a baseline-`fail` file into a trap flavour
  change, the valve is a **named** `trap-growth-allow` (#3596) in this issue
  file's frontmatter — and note #3735: the declaration is only read if the
  same PR touches a test262-paths-matched file (this PR touches `src/**`, so
  it is).

### 7. Decision criteria

**Ship** when all of:
1. ESLint Tier 1a: 2 → 0 out-of-frame functions AND a binary emits (probe §2.4).
2. uri.all.js: still 0 breaches, valid; binary byte-identical to base (or every
   byte of diff explained by a promotion that provably fired on a
   previously-invalid shape).
3. All §1 tests pass and each was demonstrated to fail (wrong value or
   `success:false`) on base via file-copy A/B.
4. Mutation matrix rows 1–5 keep node semantics (promotion did not fire) and
   row 6 computes node's values.
5. Scoped test262 A/B (§4.2): zero new trap-category files whose baseline
   status was pass/fail; net Δ ≥ 0 on the scoped slices.
6. Equivalence: identical membership vs base.
7. lodash bundle probe + tier suites + `issue-165`/`annexb`/`issue-1303`
   guards: identical to base.
8. One full local-ci run completed with pass count ≥ the committed baseline
   summary and trap counts ≤ baseline per category.

**Iterate** (fix on branch, re-run the affected probe only) when:
- A single mutation-matrix row fails → narrow the promotion predicate; do not
  widen tests to match the implementation.
- Scoped test262 shows a small (<10) trap or fail delta traceable to a named
  promoted binding → tighten the predicate or the init-ordering, re-A/B.
- ESLint drops to 1 breach → the two residuals are different sub-shapes
  (fnctor-ctor vs cross-module callee); treat the survivor as its own fixture,
  reduce it (the delta-debug tooling from this issue makes that cheap), and
  extend — not generalise — the fix.

**Abandon the mechanism** (report back to the architect pair, do not force it)
when any of:
- Per-activation isolation (matrix rows 1, 3, 4, 5) cannot be preserved
  without the promotion predicate collapsing to "hosts that run exactly once"
  AND the two real targets turn out not to satisfy that predicate (e.g. the
  uri-js factory is instantiated twice in the ESLint graph — the emit dump in
  this file already shows `toUnicode`/`toASCII` compiled twice; verify the
  factory-activation count FIRST, it is a one-probe check and would kill the
  design early).
- The scoped Temporal A/B reproduces a broad null_deref growth (≥ ~50) that
  tracing shows is structural (promoted globals read before init on the
  harness path) rather than a fixable ordering bug.
- Making the callee reachable changes which callee wins for any currently
  *passing* test (a #1177-shaped regression: the wrong-slot read is
  load-bearing somewhere). The #1177 history says: prefer keeping the loud
  emit failure + the #4133 interim "refuse loudly" diagnostic over shipping a
  semantics change that trades invalid-module for silent wrong answers.

Fallback if abandoned: land the "refuse loudly" diagnostic from #4133's
acceptance criteria for the unreachable-capture case (a hard, named compile
error instead of an invalid module), which converts the residual from
"mystery emit RangeError" to an actionable message without touching semantics.

---

## Implementation Plan (2026-08-04, architect — shared remainder of #4133/#4134)

Full copy also at the session scratchpad (`spec-mechanism.md`). #4133's plan
points here and adds only the naming-specific slice.

## 0. Kill-check result (read first — it reshapes the plan)

A sibling verification lane raised: if the declaring frames are multi-activation,
#2029-style promotion is unsound for the very cases that motivate this work.
Checked directly:

- **`__fnctor_MurmurHash3_new`** — declaring frame is imurmurhash's bare
  module-top-level IIFE (`(function(){ var cache; function MurmurHash3(...){…}
  … cache = new MurmurHash3(); module.exports = MurmurHash3; }())`,
  `node_modules/.pnpm/imurmurhash@0.1.4/.../imurmurhash.js`). Invoked exactly
  once at module evaluation; CJS caches evaluation. **Single activation,
  verified by reading the source.**
- **`assertASTDidntChange`** — the prepended captures belong to uri-js's UMD
  factory: outer IIFE called once at module top level; the factory function
  expression is referenced three times inside the wrapper, all call positions,
  on mutually exclusive branches. **Single activation at runtime.**
- The sibling's "uri-js factory compiled twice" observation **does not hold on
  current main**: `JS2WASM_EMIT_DUMP=1` over `uri.all.js` alone shows **zero
  duplicated defined-function names** (`parse`/`serialize`/`equal`/… each appear
  once). The historical 21/23 + 63/65 duplication was per-REFERENCE-site
  `__closure_N` materialisation of `toUnicode`/`toASCII` (each referenced twice),
  not a twice-compiled or twice-activated factory. Verified by running the probe
  on this checkout (`[js2:frames] 0 breaches`, no `uniq -d` hits on names).

**Branch landed: promotion stays, gated on an explicit single-activation
predicate — but it is the primary fix for only ONE of the two survivors.**

The second survivor, `assertASTDidntChange`, is a **misresolved callee** (#4133's
bare-name fallthrough reaching uri-js's nested `equal` instead of
fast-deep-equal's capture-free module export). Promoting uri-js's factory locals
would make that module *emit* while still calling the *wrong* `equal` — it
converts a loud invalid-module failure into a silent wrong answer, which this
project has explicitly ranked worse. For that case the fix is resolution
(#4133's plan) plus the diagnostic below; promotion must NOT fire as a
workaround for misresolution.

## 1. Design overview — additive write-through mirror

Three deliberate departures from `promoteAccessorCapturesToGlobals`
(`src/codegen/closures.ts:541-778`), which is the template but not the shape:

1. **Additive, not a rebind.** The accessor promotion does `localMap.delete` and
   reroutes every declaring-frame read through the global. We do NOT: the local
   stays the primary store, and every write to the binding in the declaring
   frame additionally mirrors into the global (`local.get; global.set`). In-frame
   codegen semantics (including the #1177-load-bearing wrong-slot reads and
   per-activation locals under recursion) stay byte-compatible; only sites that
   today emit *provably invalid* Wasm read the mirror.
2. **Planned before bodies compile, emitted during the declaring body's
   compile.** The need is discovered at a FOREIGN call site that may compile
   before or after the declaring frame (CJS cycles; fnctor synthesis order). So
   a syntactic pre-pass mints the globals and registers them before any body
   compiles; the declaring frame emits the value copies / box aliases when it
   compiles. Runtime ordering is correct by module-init order (provider init
   runs at `require` time, before any consumer call).
3. **Keyed by declaration node, not bare name.** Bare-name keying is the #4133
   disease; the plan is `Map<ts.FunctionDeclaration, …>` and each promoted
   binding's global belongs to one declaring frame. The name-keyed
   `ctx.capturedGlobals` / `ctx.capturedBoxGlobals` registration (needed because
   all existing consumers are name-keyed) is first-wins with a conflict set —
   a colliding later registration is refused, leaving that binding unpromoted
   (→ diagnostic, loud) rather than silently read cross-module.

No signature change anywhere: lifted functions keep their leading capture
params; Phase-0 reservation (`hoistFunctionDeclarations`) is untouched. This
sidesteps the reservation/compile-agreement trap that broke the first
`transitiveSiblingCaptures` attempt (#4134 history, constraint 1).

## 2. Eligibility (question 1)

A capture of nested function F, declared in frame D, is promoted iff ALL hold:

- **(E1) F escapes D** — F's identifier is referenced anywhere in D outside
  call-callee position (assigned, returned, passed as argument, `exports.x =`,
  `module.exports =`, `new F` counts via the value reference). Self-reference
  inside F does not count. Both real cases qualify (`module.exports =
  MurmurHash3`; `exports.equal = equal` etc. in the UMD factory).
- **(E2) D is single-activation**, established syntactically by
  `isSingleActivationFrame` (§3). Recursion of D, D being itself a
  capture-carrying escapee, or an unrecognized shape ⇒ ineligible.
- **(E3) the binding is declared directly in D's body** — not inside a loop
  (per-iteration `let`/`const` semantics), not a `catch` parameter. `var`,
  top-of-body `let`/`const`, and D's own parameters are eligible.
- **(E4) no name conflict** — the bare name is not already registered in
  `ctx.capturedGlobals`/`ctx.capturedBoxGlobals` by a different owner (first
  wins; loser is unpromoted and recorded in `capturePromotionConflicts`).

Mutation semantics under these conditions are EXACT, not approximate:

| shape | verdict |
| --- | --- |
| immutable capture, single-activation D | value mirror ≡ local (single store of each write, one activation) |
| mutable capture, single-activation D | box-alias: the SAME ref cell the declaring frame and siblings write through is aliased in a global — live write-through, identical to `capturedBoxGlobals` today |
| factory called twice producing two closures | D fails E2 → not promoted → diagnostic if actually unreachable-called; in-frame closures unaffected either way |
| recursive D | fails E2 |
| loop-body binding | fails E3 |
| two frames with same-named captures | E4: first promoted, second refused → diagnostic |

## 3. The analysis pass (question 2)

**New file** `src/codegen/closures/capture-promotion.ts`.

`planCrossFrameCapturePromotions(ctx, sourceFiles)` — called from
`generateMultiModule` AND the single-module generate path
(`src/codegen/index.ts`), after module resolution / CJS rewrite (final ASTs),
BEFORE the per-source body-compile loop.

Walk: for each source file, find function-like nodes that pass
`isSingleActivationFrame` (below); within each such D, find nested
`FunctionDeclaration`s with a nonempty syntactic capture set and test E1.

- The capture set MUST be computed with the same helpers Phase-0/compile use —
  `addFunctionOwnLocals` + `collectReferencedIdentifiers` +
  `transitiveSiblingCaptures` (`src/codegen/statements/nested-declarations.ts:221`,
  mirroring `preRegisterCapturingSibling` at :1800-1816) — so the plan's verdict
  and `compileNestedFunctionDeclaration`'s capture list agree (the lesson that
  cost the earlier attempt a "every call returns 0" bug).
- Mutability per capture: same predicate the capture collector uses (assignment
  scan). Wasm type for the value global: `resolveWasmType` on the checker type —
  the SAME derivation the lifted signature's capture params use, so the global's
  type matches what consumers expect. (Use existing sanctioned helpers; do not
  add raw `checker.*` queries — oracle-ratchet, #1930/#3273.)

`isSingleActivationFrame(fn)` (also exported for tests):
- (a) fn is a `FunctionExpression`/`ArrowFunction` whose ONLY reference is being
  the callee of a `CallExpression` (paren-skipping) that is an
  `ExpressionStatement` at SourceFile top level — the bare IIFE (imurmurhash);
- (b) the UMD idiom: fn is an ARGUMENT to a case-(a) IIFE call, and inside the
  IIFE callee the corresponding parameter is referenced only in call-callee
  positions (uri-js). Honest note: a pathological wrapper calling its factory
  twice defeats this; accepted and documented — the standard UMD boilerplate
  never does, and the blast radius is bounded to bindings that today emit-crash.
- (c) the CJS module wrapper synthesized by the rewrite, if it materializes as a
  function (verify against the rewrite's output shape; if module top level stays
  top level, (c) is vacuous).
- In all cases: no self-reference by name inside fn.

Stores (new context fields, `src/codegen/context/types.ts` +
`src/codegen/context/create-context.ts`):

```ts
capturePromotionPlan: Map<ts.FunctionDeclaration /* the NESTED decl */, {
  ownerFn: ts.Node;                    // the declaring frame D's AST node
  captures: Map<string, {
    kind: "value" | "box";
    globalIdx: number;                 // minted at plan time (nextModuleGlobalIdx)
    widened: boolean;                  // value kind: ref widened to ref_null
    refCellTypeIdx?: number;           // box kind
  }>;
}>;
capturePromotionConflicts: Set<string>;  // E4 losers, for diagnostics
// on FunctionContext:
captureMirrorGlobals?: Map<string, { kind: "value"|"box"; globalIdx: number }>;
```

At plan time, also register name-keyed for the existing consumers:
`ctx.capturedGlobals.set(name, globalIdx)` (+`capturedGlobalsWidened`) for value
kind, `ctx.capturedBoxGlobals.set(name, {globalIdx, refCellTypeIdx})` for box
kind — first-wins per E4. Globals are minted with default inits (0 / null /
`ref.null`), exactly like `promoteAccessorCapturesToGlobals` (closures.ts:689-707).

## 4. Emission — producer side (the declaring frame)

Hook in `compileNestedFunctionDeclaration`
(`src/codegen/statements/nested-declarations.ts`, at the registration block
~:1166-1221 where `nestedFuncCaptures.set` runs and the DECLARING `fctx` is the
function's `fctx` parameter):

If `ctx.capturePromotionPlan.has(stmt)`:

1. For each planned **value** capture: emit into the DECLARING fctx (at the
   current — hoist — position) `local.get <localIdx>; [coerce]; global.set
   <globalIdx>` (initial copy — covers D's parameters and anything already
   initialized), and record the name in `fctx.captureMirrorGlobals`.
2. For each planned **box** capture: eagerly box in the declaring fctx if not
   already boxed — same sequence `promoteAccessorCapturesToGlobals` uses at
   closures.ts:630-650 (`local.get; struct.new cell; local.set __boxed_<name>;
   localMap.set; boxedCaptures.set`), then `local.get box; global.set
   <boxGlobalIdx>`. Eager boxing at hoist time is correct: later writes flow
   through the cell (the standard mutable-capture machinery), and the global
   aliases the one live cell from the start — so no null-box window exists for
   foreign readers after module init. Follow the #2623/#2967 rule: the plan's
   `refCellTypeIdx` derives from the capture's INNER value type, matching what
   call-site consumers derive via `getOrRegisterRefCellType(valType)`.
3. Nothing else in this function changes; note `ctx.currentFunc` is switched to
   `liftedFctx` further down (:1164) — emit the mirror init BEFORE that switch,
   into the declaring `fctx`.

**Write-through mirror hooks** (value kind only; boxes are write-through by
sharing the cell): after any store to a named local whose fctx has a
`captureMirrorGlobals` "value" entry, append `local.get <idx>; global.set
<globalIdx>`. Sites:

- `src/codegen/expressions/assignment.ts` — identifier-LHS store path (the
  existing `capturedGlobals` write handling around :791-795 is the adjacent
  pattern; add the mirror on the LOCAL-store branch).
- `src/codegen/statements/variables.ts` — declaration-initializer store.
- `src/codegen/expressions/operator-assignment.ts`, `unary-updates.ts` — compound
  assignment / `++`/`--` stores.
- Destructuring assignments route through the same local-store helpers; verify
  with a fixture rather than auditing every path (a missed exotic write path
  yields a stale mirror — see Risks).

Since `captureMirrorGlobals` is per-FunctionContext, the hooks cannot fire in
lifted siblings, generators, or unrelated functions — no cross-fctx name
ambiguity at the write sites.

## 5. Emission — consumer side + the diagnostic (question 3)

The three consumers of an unreachable capture already have `capturedGlobals` /
`capturedBoxGlobals` arms that fire exactly when `fctx.localMap` misses:

- call-site prepend, mutable box arm: `src/codegen/expressions/call-identifier.ts:2041-2050`
- call-site prepend, value arm: `call-identifier.ts:2051-2059` and `:2093-2103`
- closure-VALUE materialisation: `src/codegen/closures/funcref-as-closure.ts:120-159`
- declaring-/foreign-frame identifier reads and writes (covers the fnctor ctor
  body reading `cache` directly): `src/codegen/expressions/identifiers.ts:789+`,
  `assignment.ts:440/533/791`.

**No changes to those arms.** Once the plan registers the name-keyed entries,
they light up for the promoted bindings. (This is why `funcref-as-closure`'s
guard measured ineffective — `localMap` empty there means it needs a GLOBAL to
fall through TO; the plan provides it. Do not re-add a slot-substitution guard.)

**The diagnostic** replaces today's deliberate "let the wrong index through" in
the terminal fallbacks — but ONLY in the provably-invalid configuration:

New helper in `src/codegen/closures/capture-source-slot.ts`:

```ts
export function captureSourceKind(fctx, cap):
  "lifted-param" | "in-frame" | "unreachable" 
```

`"unreachable"` iff: not in `liftedCaptureNames`, `cap.outerLocalIdx >=
fctx.params.length + fctx.locals.length`, and no `localMap` entry — i.e. the
exact condition under which the emitted `local.get` cannot validate.
`captureSourceSlot` itself keeps byte-identical behavior.

At the two terminal fallbacks — `call-identifier.ts:2060-2084` (mutable, raw
`cap.outerLocalIdx` box-build) and `:2104-2118` (value,
`captureSourceSlot`), plus `funcref-as-closure.ts:139-151` and `:160-163` —
when `captureSourceKind` says `"unreachable"` AND no promotion arm fired:
`ctx.errors.push` a compile error naming the callee, the capture, the declaring
function, the call-site function, and (if applicable) that the name lost an E4
conflict or that the callee resolved out of lexical scope (#4133); then emit the
historical instruction as a placeholder (compile already fails; the emitter is
never reached).

Why a diagnosed compile error and not the alternatives:

- **Ref-cell boxing alone cannot fix it** — the box would live in the declaring
  frame's locals, exactly as unreachable as the value. Boxing only helps when
  paired with a global alias, which IS the box-kind promotion above. So "box it"
  is not a distinct fallback; it is the eligible-mutable path.
- **`ref.null.extern` suppression is measured catastrophic** (+1200
  `null_deref`, #4134 history) because it fired for calls that today reach a
  working (or harmlessly wrong) in-frame configuration. The diagnostic here is
  gated on `"unreachable"`, which is exactly the set of sites that today produce
  a module that FAILS VALIDATION — no working program can regress, and the
  Temporal class (in-range or resolvable) is untouched by construction.
- In-range wrong-slot reads (the #1177 load-bearing class) do not satisfy
  `"unreachable"` and keep their current behavior. Not negotiable — 100+ test262
  regressions the last time this restraint was dropped.

## 6. IR path or legacy path (question 4)

**Legacy AST→Wasm.** The entire lifted-capture mechanism (`nestedFuncCaptures`,
cap-prepend, `funcref-as-closure`) is legacy-path; the IR front-end REJECTS
capture-carrying call graphs (`call-graph-closure` is an unintended fallback
bucket — `scripts/ir-fallback-baseline.json`), so there is no IR lowering to
fix and nothing here changes `src/ir/`. Per `docs/architecture/codegen-axes.md`
this is a legacy-hack area the IR will eventually adopt wholesale; keep
`capture-promotion.ts` free of legacy-context entanglement (pure functions over
AST + a thin context adapter) so the IR closure conversion can reuse the
analysis (`isSingleActivationFrame`, escape test) later.

## 7. Ordering constraints

1. Plan pass AFTER CJS rewrite / module resolution (needs final ASTs), BEFORE
   the first body compiles (consumers read name-keyed maps at compile time).
2. Plan-time global minting precedes all other global minting done during body
   compile — indices are stable; no fixup needed. (Do NOT mint globals lazily
   mid-consumer: a consumer can compile before the declaring frame.)
3. Producer emission in `compileNestedFunctionDeclaration` must run before
   `ctx.currentFunc = liftedFctx` (nested-declarations.ts:1164) and target the
   declaring `fctx`.
4. Phase-0 reservation and lifted signatures are UNCHANGED — the plan must not
   alter capture lists or param layouts (constraint 1 of the
   `transitiveSiblingCaptures` fix).
5. The runtime ordering claim (provider module init before consumer use) holds
   for CJS require semantics; a true init cycle where the consumer calls during
   the provider's init reads the global's default — same value a local would
   hold at that point, so not worse than node semantics violations we already
   have in cycles.

## 8. Edge cases

- **fnctor ctor body reads** (`__fnctor_MurmurHash3_new`): the ctor compiles
  the user body in its own fctx (`src/codegen/expressions/new-super.ts`,
  `compileNewFunctionDeclaration`); its reads of `cache` resolve via
  `identifiers.ts`'s existing `capturedGlobals` arm once promoted. The `new` may
  live in a different module than the IIFE — covered because E1 (escape via
  `module.exports`) triggers the plan regardless of where the `new` is.
- **`cache = new MurmurHash3()` inside the IIFE**: a write AFTER the fn
  declaration — covered by the assignment mirror hook; also note `cache` is
  mutable-captured (assigned in D) → box kind → alias covers it without any
  mirror hook at all.
- **TDZ-flagged captures** (`hasTdzFlag`): promote the flag exactly as
  `promoteAccessorCapturesToGlobals` does (closures.ts:741-763,
  `ctx.tdzGlobals`); the consumer prepend's flag sourcing already treats
  cross-fctx-unavailable flags as initialized (`i32.const 1`), so this is
  belt-and-suspenders, not load-bearing.
- **Same package, two versions** (eslint-visitor-keys 3.4.3/5.0.1): distinct
  AST nodes → distinct plan entries → distinct globals; the bare NAME collides →
  E4 first-wins; the loser's unreachable uses get the diagnostic. Acceptable
  interim; the real fix is re-keying the name-keyed consumer maps by owner,
  which is follow-up scope (it touches `identifiers.ts`/`assignment.ts`
  consumers).
- **`preRegisterOnly` / `reuseReservedEntry` paths** through
  `compileNestedFunctionDeclaration`: the producer hook must be idempotent per
  decl (emit the mirror init once — guard with a `Set<ts.FunctionDeclaration>`
  on ctx).
- **Standalone/WASI lanes**: nothing here is host-dependent; globals and ref
  cells work in both. Keep the standalone floor green (#1897/#2097).

## 9. What could regress

- **Equivalence drift in declaring frames**: mirror `global.set`s are additive
  instructions in real bodies. Expect wasm-byte diffs but identical results;
  gate with the full equivalence suite (diff vs base must be results-empty).
- **A missed write path → stale value mirror**: silent wrong value at a foreign
  read. Bounded to promoted bindings; covered by fixture (4) below and by
  preferring box-kind whenever the binding is assigned anywhere after
  declaration (cheap over-approximation: if the capture collector marks it
  mutable OR the plan's own assignment scan finds any post-declaration store,
  use box kind — then the only value-kind mirrors are single-assignment
  bindings, whose one store is the declaration initializer hook).
  **Recommended: adopt this narrowing** — value kind ONLY for
  never-reassigned-after-init bindings; everything else box kind. It removes
  the assignment.ts/operator-assignment.ts/unary-updates.ts hooks from the
  critical path entirely (only variables.ts init remains), shrinking both the
  diff and the risk.
- **The diagnostic firing on previously-"working" graphs**: only possible where
  emit was already invalid (validation failure). Message quality matters more
  than reach; include the #4133 out-of-scope hint.
- **Global-index assumptions**: `capturedBoxGlobals` participates in a
  global-index fixup (see assignment.ts:524 comment) — plan-time minting is
  before any shifting, but verify the fixup shifts plan-minted indices too.
- **`merge_group`-only gates**: PR-level green is a no-op for test262; the real
  regression check happens in the queue. Watch `null_deref` buckets
  specifically (the suppression failure mode) — should be structurally
  impossible here, but it is the named hazard of this issue family.

## 10. Tests & validation

`tests/issue-4134-cross-frame-capture-promotion.test.ts`, rungs (verify each is
non-vacuous against unfixed base — expect base to fail 1, 2, 3):

1. Two modules: A = IIFE with local `k`, nested capturing `f`, `module.exports
   = f`; B calls `f()`. Assert node-equivalent result (base: invalid module).
2. imurmurhash shape: IIFE-nested constructor function using a captured
   `cache`, exported, consumer does `new F()` (fnctor path). Base: the
   `__fnctor_*_new` breach.
3. Mutable capture: consumer call mutates through the promoted box; a second
   in-frame call in A observes the write (live write-through).
4. Single-assignment value capture initialized AFTER the nested decl (hoisting
   order) — foreign read sees the initialized value, not the default.
5. Two factories with same-named captures — first promoted, second's unreachable
   use produces the diagnostic (assert the error message, not a crash).
6. Recursion / factory-called-twice fixture — NOT promoted (E2), in-frame
   behavior identical to base (equivalence).

Validation runs:
- `JS2WASM_CHECK_FRAMES=1` on `uri.all.js` (must stay 0) and on the ESLint
  Tier 1a graph (**2 → expected 1**: the MurmurHash3 breach closes; the
  `assertASTDidntChange` breach closes only with #4133's resolution slice, or
  becomes the diagnostic — see #4133's plan for the paired change).
- Full equivalence suite, results-diff empty vs base.
- `JS2WASM_FRAME_TRAP=<fn>` for any surprise (accessor-on-FunctionContext
  detail — see the note in #4134; keep it if touching frame-trap.ts).

## 11. Explicitly out of scope

- Re-keying `capturedGlobals`/`capturedBoxGlobals`/`nestedFuncCaptures` by
  owner identity (the full flat-namespace retirement) — follow-up issue.
- The #4133 trampoline/allocator-locator per-owner discriminator
  (`ensureFuncClosureSingleton`) — tracked in #4133, unchanged by this spec.
- Multi-activation declaring frames: deliberately ineligible; their unreachable
  uses become the diagnostic. If real code hits it, that is a new issue with
  its own design (likely an environment-record object, not globals).
