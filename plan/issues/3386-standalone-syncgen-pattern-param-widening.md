---
id: 3386
title: "standalone: native sync-generator DESTRUCTURING-pattern params — methods, fn-expressions, element defaults, untyped array patterns (~1,860 host_import_leak rows)"
status: ready
sprint: current
created: 2026-07-17
updated: 2026-07-17
priority: high
horizon: l
feasibility: hard
model: opus
reasoning_effort: high
task_type: feature
area: codegen, standalone
language_feature: generators, destructuring
goal: standalone-mode
umbrella: 3178
related: [2920, 3164, 3302, 3032, 2938, 3312, 2581]
origin: "2026-07-17 fable-3178 umbrella decomposition — largest sync-gen residual cohort in the standalone host_import_leak baseline (post-#2961 accounting)."
---

# #3386 — sync-generator pattern params: widen the native admission

## Problem

Since #2961, a standalone compile that emits the `env::__gen_*` family is a
hard `compile_error` (`error_category: host_import_leak`). The single largest
SYNC-generator residual cohort is **generators with destructuring-pattern
params**, measured 2026-07-17 from the promoted
`test262-standalone-current.jsonl` (official scope):

| dir                                                                        |  rows | shape                                             |
| -------------------------------------------------------------------------- | ----: | ------------------------------------------------- |
| `{expressions,statements}/class/dstr` (`gen-meth-*`, `private-gen-meth-*`) | 1,184 | class generator METHODS with pattern params       |
| `expressions/generators/dstr`                                              |   174 | generator fn EXPRESSIONS with pattern params      |
| `expressions/object/dstr` (`gen-meth-*`)                                   |   170 | object-literal generator methods                  |
| `statements/generators/dstr`                                               |   166 | generator fn DECLARATIONS (dflt:87 ary:53 obj:25) |
| smaller (`class/elements` 78, `for-of/dstr` 27, `assignment/dstr` 24)      |  ~130 | mixed                                             |

Dominant import combo:
`__create_generator,__gen_create_buffer,__gen_next[,__gen_return,__gen_result_*],__get_caught_exception`.

## Live probes (2026-07-17, current main, `--target standalone`)

| probe                                                               | result    |
| ------------------------------------------------------------------- | --------- |
| `function* f([x, y]) {}` at module scope                            | HOST-FREE |
| `function* f([x = 1]) {}` at module scope                           | HOST-FREE |
| same decl WRAPPED in the test262 `export function test(){}` wrapper | **LEAKS** |
| `class C { *method([x, y]) {} }` (even module scope, plain pattern) | **LEAKS** |
| `var f = function*([x = 1]) {}`                                     | **LEAKS** |
| `{ *method([x]) {} }` object literal                                | **LEAKS** |
| wrapped `function* g() { yield 1; }` (no pattern)                   | HOST-FREE |

So sync-gen NESTING itself is solved (#3302/#3032 W3/W4); the bails are all in
the pattern-param admission.

## Root cause (exact gates, verified on current main)

All in `src/codegen/generators-native.ts`:

1. **Fn-expression gate is identifier-only** — `isNativeGeneratorExpressionShape`
   (line 1454; the identifier check at line 1457: `if (!ts.isIdentifier(param.name)) return false;`).
   #3164 shipped fn-exprs but never extended them to the #2920 pattern-param
   lowering. This alone bails all 174 `expressions/generators/dstr` rows and the
   fn-expr-shaped harness templates.
2. **Element defaults bail** — plan builder at lines ~1274–1281: any
   `el.initializer` (`[x = 23]`, `{a: b = expr}`) returns `null` ("throwing /
   function-valued default produced invalid modules"). This bails every
   `dflt-*` file (87×2 decl rows + the method `gen-meth-dflt-*` families).
3. **Untyped ARRAY patterns bail** — lines ~1282–1305: array patterns require a
   syntactic `param.type` resolving to a concrete vec/tuple ref. Test262 is
   plain JS — **no param is ever TS-annotated**, so every array-pattern param in
   the corpus bails. (Object patterns are admitted untyped; that is why
   `obj-ptrn-id-init-skipped.js` passes host-free.) This is what bails the
   plain-pattern class-method probe above.
4. **Whole-param defaults, nested sub-patterns, rest elements bail** — lines
   ~1250–1273 (`param.initializer`, non-identifier elements, `dotDotDotToken`).
5. Object-literal methods with param defaults/optionals bail separately
   (lines ~1736–1744, the `__argc_default` trampoline gap, #2581) — keep that
   bail; it is NOT this issue's scope to fix the trampoline.

## Implementation Plan

Waves, each independently landable and measure-first (sample by CONSTRUCT):

### W1 — fn-expression pattern params (cheap, unlocks ~174+ rows)

**File: `src/codegen/generators-native.ts`**, `isNativeGeneratorExpressionShape`
(line 1454). Replace the `!ts.isIdentifier(param.name)` bail with the SAME
param acceptance the plan builder applies (identifier | ArrayBindingPattern |
ObjectBindingPattern, no rest) — i.e. delegate the pattern legality entirely to
`buildNativeGeneratorPlan` (which `isNativeGeneratorCandidate` already calls
last). Check the #3164 emit site in `closures.ts` (the lifted-closure factory
registration) threads the raw pattern arg into the state struct the same way
the free-function path does (`emitPatternParamDestructure` +
`collectPatternBindingIdentifiers`, both already exported in
generators-native.ts). The single-candidate-gate discipline (#3164 comment at
line ~1685) means NO separate mirror edit is needed in
`sourceNeedsGeneratorHostImports` — but verify with a leak probe on
`var f = function*([x]) {}` in both lanes.

### W2 — array-pattern params via the native ITERATOR protocol (the big lever)

The `param.type`-required vec-indexing destructure is both too narrow AND
spec-divergent: §14.3.3 array destructuring goes through the iterator protocol
(the corpus tests exactly that — `ary-ptrn-elem-id-iter-done`,
`iter-step-err`, `iter-val-*`). Replace the state-0 resume-prelude destructure
for array patterns with the SAME native `__iterator` /
IteratorBindingInitialization lowering that ordinary (non-generator) function
params and for-of heads already use host-free (see `iterator-native.ts` and
`destructuring-params.ts` — find the non-generator array-pattern param path and
reuse its emitters; do NOT build a parallel destructure). Then drop the
`param.type` requirement (lines ~1282–1305) — the raw arg is stored externref
in the state struct and iterated in the prelude, so the concrete-vec typing
question disappears.

- Edge cases: iterator `done` before pattern exhausted → remaining bindings
  `undefined`; abrupt `next()` → the error must propagate out of the FIRST
  `.next()` call on the generator (the prelude runs at state 0, i.e. first
  resume — matches §27.5.3.1 lazy semantics); elision holes advance the
  iterator without binding; IteratorClose on early abrupt completion.
- The eager host path snapshots by-value at CREATION — the native prelude runs
  at first `.next()`. That is a semantic FIX (lazy per spec), but re-run the
  construct sample in the JS-HOST lane too: host lane must stay byte-identical
  (the gate change is inside plan admission consumed identically by both — the
  host lane's own candidate arm at line 1651 restricts to fn decls with
  try-across-yield, so host-lane emission does not change; verify with
  SHA-equal probe).

### W3 — element defaults in the resume-prelude destructure

Lines ~1274–1281. After W2, a defaulted element lowers as: bind from iterator
step; `if (value === undefined) value = <initializer>`. Initializers evaluate
in the RESUME function scope — they may reference earlier pattern bindings
(already spilled), module globals, and captured boxes (#3302 slots). First
root-cause the recorded "#2920 invalid modules on throwing/function-valued
defaults" (likely: the initializer expression compiled against the OUTER fctx
local table instead of the resume fctx — compile initializers with the resume
fctx, same as body statements). Whole-param defaults (`[x] = []`, line ~1257)
join here: evaluate the whole-param initializer when the raw arg field reads
undefined, BEFORE the iterator acquire.

### W4 — nested sub-patterns + rest elements

Nested patterns recurse the W2 lowering (each sub-pattern gets its own
iterator/property extraction). Array rest (`[a, ...rest]`) drains the iterator
into a native vec (host-free — the `__iterator` loop); object rest still needs
`__extern_rest_object` — keep object-rest bailed (correct-or-legacy) and note
the residual count.

### Excluded / guarded

- The 16 `*-ary-ptrn-elem-ary-elision-iter` private-gen files guarded on #3312
  (shadowed-binding capture promotion) stay excluded until #3312 lands.
- Object-literal method param DEFAULTS keep the #2581 `__argc_default` bail.

## Test plan

- Leak probes per wave (compile → import set empty + `WebAssembly.instantiate(binary, {})` succeeds).
- Construct-sampled corpus flip on `class/dstr` + `generators/dstr` +
  `object/dstr` (never directory-sampled — #2938 lesson).
- Equivalence tests: add `tests/issue-3386.test.ts` with wrapped-shape probes
  (the wrapper is load-bearing — module-scope-only probes gave false greens
  during decomposition).
- JS-host lane byte-identity (SHA-equal) on modules without the construct AND
  on host-lane generator modules (the host candidate arm must not widen).

## Regression risks

- Gate/registration lockstep: `isNativeGeneratorCandidate` ==
  `sourceNeedsGeneratorHostImports` == the emit sites (class-bodies.ts:~2354
  region, literals.ts, closures.ts) must agree per-decl or the module bakes an
  undefined `__gen_*` funcIdx (invalid wasm). Every wave: run the async/gen
  corpus compile-validity scan (0 invalid wasm).
- The wrapped-vs-module-scope delta above means ALL probes must use the test262
  wrapper shape.
