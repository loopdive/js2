---
horizon: m
id: 4075
title: "Codegen leaves out-of-frame local references; reproduces in ONE file (uri.all.js)"
status: ready
created: 2026-08-02
updated: 2026-08-02
assignee: unassigned
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
related: [1282, 2043, 4030, 4045]
---

# #4075 — `local index out of range — 65 (valid: [0, 8))` at emit

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
  duplicated, and it did **not** fire here. So this is **not** the #4045
  cross-module collision, despite looking exactly like it.
- **No declaration named `ve` exists** anywhere in the 146-source resolved
  graph — checked across `FunctionDeclaration`, `MethodDeclaration`,
  named `FunctionExpression`, and variable declarations initialised with a
  function or arrow. So `ve` is either compiler-synthesized or introduced by a
  transform (the CJS rewrite and ground-call folding both run before analysis).

## Two candidate causes, not yet distinguished

1. **Genuinely the #2043 late-import index-shift class** the message names — a
   captured local index went stale, or a lookup baked a bogus value.
2. **A body installed against the wrong frame**, i.e. the same *shape* as #4045
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
  already misleading once (it fired for #4045's collision).
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
the #4045 fixes, e.g. `TokenTranslator_init`, `TokenTranslator_new`, `_format`,
`_globToRegExp`, `analyzeScope`, `assertArg`, `__sget_`, `__sset_`,
`__async_resume_fanon_410`. #4045 covered top-level *function declarations*;
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
   with each other and with top-level functions — the same hazard as #4045,
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
| 1 | #4045 cross-module **name collision** | the emit diagnostic reports `NAME SHARED BY n` when a defined-function name is duplicated. It did not fire for `ve`; the name is unique in the table. |
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
