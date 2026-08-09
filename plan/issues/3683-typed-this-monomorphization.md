---
id: 3683
title: "perf: typed-`this` monomorphization for fnctor prototype methods — the measured path past the #3673 inline-cache asymptote"
status: ready
created: 2026-07-27
updated: 2026-07-27
priority: high
feasibility: hard
reasoning_effort: max
task_type: perf
area: codegen
goal: value-rep
sprint: current
related: [3673, 1946, 1947, 1584]
loc-budget-allow:
  - src/codegen/fnctor-escape-gate.ts
  # S2: the four lowering-branch call sites. The emitters themselves live in
  # the new subsystem module `src/codegen/typed-this.ts` (which also absorbed
  # `EMIT_COMPOUND_OP_HANDLES`); what remains in each god-file is one guarded
  # call plus the comment explaining why it must run before the pinned
  # dispatcher — 42 net lines across all four, down from 161 before the move.
  - src/codegen/property-access-dispatch.ts
  - src/codegen/expressions/assignment.ts
  - src/codegen/expressions/operator-assignment.ts
  - src/codegen/expressions/unary-updates.ts
  # S4a: the whole-program numeric-property analysis lives in its own module;
  # `fnctor-escape-gate.ts` (already listed) gains the promotion loop and
  # `context/types.ts` / `index.ts` one field + one pre-pass call each.
  - src/codegen/numeric-property-analysis.ts
  - src/codegen/context/types.ts
  # S3: the whole direct-call subsystem (admission, trampoline reserve, the
  # call-site emitter and the finalize fill) lives in `typed-this.ts`. What
  # lands in the god-file is ONE guarded call plus the comment explaining why
  # it must run before the `__call_m_*` reservation it falls through to —
  # +19 lines, of which 5 are the dependency thunks that keep `typed-this.ts`
  # out of an import cycle with `closures.ts`.
  - src/codegen/expressions/call-receiver-method.ts
oracle-ratchet-allow:
  # S2 (granted retroactively here — the gate is measured against `main`, which
  # predates the whole typed-`this` branch). The two `getTypeAtLocation` calls
  # ask whether a property access is CALL-SIGNATURE typed, i.e. whether the
  # slot holds a method rather than data; that is a raw `ts.Type` identity
  # question the oracle deliberately does not model, and it is the precise
  # carve-out the ratchet documents. The `ctx.checker` uses are the three
  # `resolveEnclosingFnctorOwner` arguments, whose signature takes a checker.
  # S3 itself adds ZERO new checker usage — `admitDirectCall` reads its owner
  # from the S1 verdict map instead of re-deriving it.
  - src/codegen/typed-this.ts
---

# #3683 — Typed-`this` monomorphization for fnctor prototype methods

## Problem

#3673 drove the standalone compiled-acorn parse from 52.4ms to 1.51ms
(~35x) with runtime fast paths and inline caches, and then measured the
asymptote: **runtime helpers are ≈58% of remaining wasm time, the compiled
parser bodies ≈38%** — so even zeroing every helper lands ~0.8ms against
node-acorn's 0.0341ms. The parser bodies are slow for exactly one
structural reason: acorn's methods are compiled as generic closures with a
DYNAMIC `this` (the `__current_this` externref global), so

- every `this.pos` read is a CALL to a `__get_member_pos(__f64)`
  dispatcher (≈30 instrs + `ref.test` per read; node: one inline-cached
  load),
- every intermediate value round-trips through externref boxing
  (`__box_number`/`__unbox_number`/i31, `$AnyValue` lanes),
- every `this.method(...)` crosses `__call_m_*` → cache → closure-call
  bridge (`__call_fn_method_N`: argc globals, per-entry unbox, `call_ref`,
  re-box).

## Direction

For a fnctor class `F` whose instances are a single known struct type
`$__fnctor_F` (the common case — acorn's Parser/Node/TokenType/etc.),
compile each prototype method body a SECOND time as a typed twin:

    `F_proto_<m>_typed(this: (ref $__fnctor_F), ...params) -> ret`

with these lowering changes inside the twin only:

1. **`this.X` reads/writes** where `X` is a field of `$__fnctor_F` lower
   to bare `struct.get`/`struct.set` — no dispatcher call, no boxing when
   the consumer context is numeric (compose with the #3673 round-8 typed
   f64 lowering decisions).
2. **`this.m2(...)` calls** where `m2` is provably a prototype method of
   the SAME class (assigned exactly once at module init, never reassigned
   — see the write-once analysis below) lower to a DIRECT `call` to
   `F_proto_<m2>_typed`, keeping `this` in its typed register. No closure
   struct, no arity probe, no `call_ref` ladder.
3. All other constructs keep their current dynamic lowering (the twin can
   always fall back to boxing at genuine `any` boundaries).

The DYNAMIC entry points stay: the prototype `$Object` still holds the
generic closure (identity for `Parser.prototype.readToken` reads,
`.call/.apply`, reflection), whose body becomes a thin shim: cast
`__current_this` to `(ref $__fnctor_F)` on success → tail-call the typed
twin; cast failure → the ORIGINAL generic body (detached `this`, patched
prototypes, subclass shapes).

## Admission analysis (compile-time, conservative)

A method `m` of fnctor `F` is admissible iff:
- `F.prototype.<m> = <function-expr>` is assigned exactly ONCE, at module
  top level (acorn's `pp.readToken = function() {…}` pattern); no other
  write to `F.prototype.<m>` or computed write to `F.prototype` exists in
  the program (reuse the fnctor escape-gate machinery that already
  classifies "approved" fnctors);
- the method body contains no `eval`/`with`/`arguments`-aliasing that the
  IR path already rejects;
- direct-call devirtualization (2) additionally requires the CALLEE to be
  admissible.

Inheritance: a fnctor with subclass shapes (two struct types for one
logical class — the #2674 `$__anon_5`/`$__fnctor_Parser` pair) admits the
typed twin against the SUPERTYPE struct only if both shapes share the
field layout prefix used by the body; otherwise skip (conservative).

## Implementation plan (slices)

- **S1 — write-once prototype analysis**: extend the fnctor escape gate
  with a per-(class, method) "assigned once at init, never reassigned"
  verdict + the field-use set of each method body. Pure analysis + tests.
- **S2 — typed twin emission for leaf methods** (no `this.m2()` calls):
  compile the twin with `this` typed; shim the generic closure. Gate:
  acorn canaries + corpus; measure (expect the `__get_member_*` +
  `__to_primitive` residue and much boxing in hot bodies to drop).
- **S3 — direct-call devirtualization** between admissible methods
  (call graph over the S1 verdicts; emit direct calls in twins).
- **S4 — numeric locals**: inside twins, keep number-typed locals as raw
  f64/i32 through expressions (the #1584 value-rep question, scoped to
  twin bodies only).

Each slice is independently landable and measurable on the #3673 bench
(`.tmp/bench-min.mjs` methodology, 330B corpus input, min-of-batches).

## S3 design notes (scoped during S1, 2026-07-27)

- **Admission facts landed (S1b)**: `otherNameWrites` (name-shadowing
  proof, with a null sentinel when any dynamic computed member write
  exists — acorn's `keywordTypes[name] = …` trips it, so S3 on acorn MUST
  use receiver-shape runtime guards, not name-only proofs) and
  `inheritedFrom` (`Object.create(F.prototype)` consumers).
- **The `self` operand is the real S3 design problem.** A direct call to
  the lifted method function needs its closure-struct `self` argument.
  The write-once closure singleton is materialized during `__module_init`
  straight into the prototype `$Object` entry — there is no global
  holding it, and anonymous function expressions get a NON-NULLABLE
  `(ref $struct)` self param, so `ref.null` cannot be passed even though
  admitted (capture-free) methods never read it. Two viable designs:
  (a) per-admitted-method singleton GLOBALS `__pm_<F>_<m>` written at the
  construction site (extend `emitClosureConstruction` to `global.tee`
  when the assignment target is an admitted prototype slot) — trampoline
  loads the global, `struct.get` funcref + `call_ref`; or (b) widen
  admitted methods' lifted self params to the nullable root (the round-5
  named-expr mechanism generalized), enabling plain `call` with
  `ref.null`. (a) is less invasive (no signature changes ripple into
  `__call_fn_method_N` entries); prefer it.
- **funcIdx staleness**: record lifted-function NAMES (funcMap is
  late-import-shift-maintained), never raw indices, in any node→function
  map added for the trampoline fill.
- **Runtime guard set** (mirrors the round-12/13 cache guards, all O(1)):
  `ref.test $__fnctor_F(recv)` + own-dynamic-props emptiness (when the
  fnctor struct carries a sidecar field) + compile-time `m ∉ F's struct
  fields`; miss → the legacy `__call_m_` path unchanged.

## S2 scoping (2026-07-27) — prerequisite refactor identified

The twin emission point is `compileArrowAsClosure` (closures.ts ~1900-
2500): the generic lifted body is compiled through ~200 lines of coupled
machinery (capture/TDZ materialization, named-expr self bindings,
savedFunc swap + liveBodies tracking, param defaults/destructuring,
`arguments` vec, string-builder detection, var/let-const hoisting,
generator/async lanes) that is NOT reusable as-is for a second
compilation of the same AST. **S2 therefore starts with an extraction
refactor**: pull the body-compilation core into a parameterized
`compileLiftedClosureBody(ctx, arrow, opts)` consumed twice — once for
the generic body (byte-identical output, verified by the full battery)
and once for the twin with `opts.typedThis = {structTypeIdx,
thisLocalIdx}`. Only then do the three lowering branches land
(property-read, assignment, compound/update on a ThisKeyword receiver
with `typedThisStructIdx` set — each an additive early-return that emits
`struct.get`/`struct.set` and returns the FIELD's unboxed ValType, which
is what lets downstream expression lowering stay numeric). Twin entry:
`this` cast once from `__current_this`; the generic body gets a 3-instr
`ref.test → forward-call` prepend. Additional S2 admission gates
discovered: no nested function-likes in the body (a second compile would
re-mint their closures), presence-tracked/optional fields excluded from
the inline branches (the dispatcher's presence check is semantic), and
`!moduleUsesDelete` (tombstone-aware reads). The shim keeps
`__current_this` semantics for all non-field uses inside the twin.

## S2 implementation notes (2026-07-27) — landed

**Step 1 (the risky one) — `compileLiftedClosureBody` extraction.** Phase 5 of
`compileArrowAsClosure` (the ~590 lines from "5. Build the lifted function
body" to the `ctx.currentFunc = savedFunc` restore) moved verbatim into
`compileLiftedClosureBody(ctx, fctx, arrow, opts)`. Minting/registering the
wasm function, the construction site and `registerClosureBindingInfo` stayed
with the caller — they must run exactly ONCE per arrow even when two bodies are
emitted. Verified **byte-identical**: the standalone acorn bench binary before
and after `cmp`s equal at 1,353,337 bytes. One non-behavioural edit was
required: `arrow` used to be narrowed to `FunctionExpression` at the
native-generator arm by TS aliased-condition analysis on `const isGenerator =
ts.isFunctionExpression(arrow) && …`; that alias no longer reaches the
extracted scope, so the arm restates a condition its own non-null
`nativeGenExprInfo` already implies.

**Why `!moduleUsesDelete` was dropped.** The scoping note listed it as an
admission gate on tombstone grounds. It is not what makes the inline branches
safe, and applying it would have made S2 a **measured no-op**: acorn contains
`delete node.operator` and `delete this.undefinedExports[name]`, so the flag is
TRUE for the entire benchmark target. The tombstone-aware read
(`tryEmitDeleteAwareDynamicGet`) is a JS-HOST lowering that runs *after* the
pinned branch in `tryPinnedAndDeleteAwareDynamicGet`, so a pinned `this`
receiver never reaches it today. What actually protects a deleted slot is the
presence-bit carve-out plus the standalone struct-delete lowering, which writes
a delete sentinel into the field itself. A regression pin covers exactly this.

**Why the inline branches are equivalent** (the load-bearing argument, restated
in full in `src/codegen/typed-this.ts`'s header): they fire only where today's
lowering is the pinned dispatcher path, and they are that path's own
`$__fnctor_F` arm inlined. The dispatcher's arm is `ref.test $C → ref.cast $C →
struct.get/set`; the twin's receiver is `ref.cast $__fnctor_F`-verified, so the
arm the dispatcher would select is that struct's own or a super/subtype's in
the same WasmGC chain, whose shared field PREFIX puts the same-named field at
the same index. The caller then immediately unboxed back via
`coerceType(externref → fieldType)`, so inlining collapses box∘unbox to the
identity.

**Measured result (this is the headline, and it is NOT what S2 alone was hoped
to deliver).** Three builds loaded into ONE process and benchmarked
round-robin, min-of-24-batches × 200 parses, 330B corpus — interleaving is what
made the signal readable, cross-process runs were pure noise at this effect
size. Five independent sessions:

| session | baseline (S1 tip) | shim only (`=shim`) | full S2 | full vs base | full vs shim |
| --- | --- | --- | --- | --- | --- |
| A | 1.5902 | 1.6652 | 1.5074 | −5.2 % | −9.5 % |
| B | 1.5102 | 1.5863 | 1.4373 | −4.8 % | −9.4 % |
| C | 1.6527 | 1.7700 | 1.5996 | −3.2 % | −9.6 % |
| D | 1.6429 | 1.7507 | 1.5400 | −6.3 % | −12.0 % |
| E | 1.6991 | 1.7804 | 1.6543 | −2.6 % | −7.1 % |

The ORDERING (`full < baseline < shim`) is identical in all five, which is the
robust result; the absolute ms wander with machine load. Median: **≈5 % faster
than baseline, ≈9.5 % faster than shim-only.** Read that as: the inline
branches are worth **≈10 %** of parse time, and the `ref.test` forward shim
gives **≈5 %** of it straight back. The shim is pure S2 scaffolding — S3's
direct calls into the twin delete it from the hot path, at which point the full
10 % banks.

**Why S2 alone cannot deliver more, and what that means for S4.** With
`JS2WASM_TYPED_THIS_DEBUG=1`, acorn gets 244 twins and 1,340 inline reads / 98
writes / 20 compounds / 98 inc-decs — essentially full coverage, with almost no
declines (top declines are `nofield:inAsync`, `nofield:canAwait` — option flags
that are not struct fields at all; **zero** presence-tracked declines). But the
per-site win is small because **`$__fnctor_Parser`'s hot fields are
`externref`**: `type`, `pos`, `options`, `start`, `value`, `strict`,
`lastTokEnd`… all boxed (`input`, `labels`, `scopeStack` are `ref_null`; only
`awaitPos`/`yieldPos`/`awaitIdentPos` are `f64` and `containsEsc`/`inModule`/
`exprAllowed` are `i32`). So `struct.get` hands back an externref and the
consumer still unboxes — S2 removes the *dispatcher call*, not the *boxing*.
The boxing is the #1584 value-rep question, i.e. **S4 is where the typed lane
pays off**, and S2's branches are the substrate it needs. Recommend
re-sequencing S4 ahead of, or alongside, S3.

**Diagnostics shipped**: `JS2WASM_TYPED_THIS=0` (kill-switch — reproduces
pre-S2 output byte-for-byte on any program), `=shim` (twins + shim, no inline
lowering — isolates shim cost from branch win; this is what produced the table
above), `JS2WASM_TYPED_THIS_DEBUG=1` (per-compile tallies + declined-field
histogram).

**Binary size**: 1,353,337 → 1,808,339 bytes (+34 %) on acorn, from duplicating
244 method bodies. If size becomes a gate, admission can be narrowed to methods
with ≥N inline sites.

**Regression evidence.** `tests/equivalence` (213 files / 1,646 tests) run on
this branch AND on the base commit `ff944acc`: **identical** — 14 failed files
/ 35 failed tests / 1,608 passed / 3 todo on both. All 14 are pre-existing
(`coercion-arithmetic-add`, `delete-sentinel`, `reflect-api`, `symbol-basic`,
`tdz-reference-error`, `yield-as-expression`, …); `coercion-arithmetic-add` was
additionally re-run alone at the base commit and fails 8/20 there too. Also
green: `DOGFOOD_ACORN=1 dogfood:acorn-corpus` (distinct REAL gaps 0),
`issue-1712` acorn differential AST parity, `issue-3673-i31-smallint`,
`issue-2151-nary`, `issue-2674-*`, `issue-3683-proto-method-write-once`, and
the 12 new `issue-3683-typed-this-twin` pins.

## S4a implementation notes (2026-07-27) — landed, and the measurement that
## redirects the roadmap

**What landed.** A new whole-program analysis,
`src/codegen/numeric-property-analysis.ts`
(`analyzeNumericPropertyNames`), computes the property NAMES whose complete
statically visible write set is numeric; `deriveFnctorFields` then gives such a
field a PHYSICAL `f64` slot instead of the boxed `externref` carrier.
Standalone lane only. 13 pins in `tests/issue-3683-numeric-fields.test.ts`;
kill-switch `JS2WASM_NUMERIC_FIELDS=0`, diagnostics
`JS2WASM_NUMERIC_FIELDS_DEBUG=1` / `JS2WASM_NUMERIC_FIELDS_EXPLAIN=<names>`.

**Why the field was externref at all** (the thing S2's note asked S4 to fix):
`deriveFnctorFields` types a field from the FIRST constructor write's checker
type. Acorn's is `if (startPos) { this.pos = startPos; … } else { this.pos =
this.lineStart = 0; }` with `this: any`, so the first write wins and `pos` —
82 numeric writes across the whole parser — carries a box.

**`pos` is the keystone, and a fully SOUND analysis proves nothing.** `start`,
`end`, `lastTokStart`, `lastTokEnd`, `potentialArrowAt`, `yieldPos` are all
written from `this.pos`, so they stand or fall with it. Its one
non-numeric-provable write is `this.pos = startPos`, whose value comes from the
public `parseExpressionAt(input, pos, options)` entry point — unprovable by
construction. The analysis therefore has exactly ONE trust boundary: a bare
read of a PARAMETER slot counts as *opaque* rather than *non-numeric*, so a
non-number written through such a site is ToNumber-coerced. This demands
strictly MORE evidence than the status quo (which types a field from ONE write
and coerces all the others — `awaitPos` is f64 today for exactly that reason),
requires ≥1 provably-numeric write to ground the slot, and is off in host mode.
The divergence is pinned (`p.pos = "5"` stores `5` promoted, `"5"` unpromoted).

**Design points worth keeping.** Name-keyed like #2847's boolean brand (strictly
more conservative than per-class, and it sidesteps the alias problem a
per-class verdict would need a points-to analysis for). Value inference uses
LEXICAL SLOTS, not #2847's pooled bare names — pooling every `i`/`end`/`size`
in a 230 KB module into one verdict sinks the analysis on one non-numeric use,
and switching to slots is what took acorn from 0 hot fields to all of them.
Three carve-outs (presence-tracked, `delete` targets, accessor names) each have
a positive control in the pin suite. Boolean names are excluded by passing
#2847's REAL verdict in as `excludeNames` — deriving a second opinion raced the
brand and would have made `node.static === false` answer `false`.

Two refinements integration forced, both documented in the module:
- **`a[k] = b[k]` with the same key slot is not a poison.** Acorn's `copyNode`
  is a computed write through a #2660-proven fnctor instance, which tripped the
  hard sentinel and zeroed the entire slice. It is name-PRESERVING, which is
  exactly what a name-keyed verdict already covers. A real `this[k] = …` still
  poisons.
- **`this.f += <opaque param>` is acceptable** (acorn's `this.pos += size`), on
  the same trust boundary — but it does NOT ground a slot.

**Acorn verdict** (22 names program-wide): `pos` (232 inline twin read sites),
`start` (92), `lastTokStart` (18), `lastTokEnd` (18), `end`, `curLine`,
`potentialArrowAt`, `yieldPos`, `awaitPos`, `awaitIdentPos` promoted; `type`
(242 sites), `options` (224), `value`, `strict`, `context`, `input`, `labels`,
`scopeStack`, `lineStart` correctly kept. Binary 1,794,038 → 1,793,281 bytes.

### The measurement — and why it is the most useful thing in this slice

Same interleaved methodology as S2 (all arms in ONE process, round-robin,
min-of-N-batches × 200 parses of the 330 B corpus) with one addition that turned
out to be decisive: **a duplicate baseline arm built from the identical commit**
(`base2`), which measures the harness's own noise floor.

| session | batches | S4a | base | base2 (identical to base) | control spread |
| --- | --- | --- | --- | --- | --- |
| pre-merge | 24 | 0.8648 | 0.8647 | 0.8089 | **6.5 %** |
| pre-merge (reordered) | 24 | 0.8434 | 0.8663 | 0.8583 | 0.9 % |
| pre-merge | 40 | 0.8323 | 0.8345 | 0.8393 | 0.6 % |
| merged | 40 | 0.5700 | 0.5818 | 0.5914 | 1.6 % |
| merged (reordered) | 40 | 0.7225 | 0.7251 | 0.7164 | 1.2 % |
| merged | 60 | 0.7302 | 0.7457 | 0.7209 | **3.4 %** |

S4a against the mean of the two baselines: −2.8 %, +0.2 %, −0.4 %, −0.5 % on the
four ≥40-batch sessions (mean ≈ −0.9 %). Directionally consistent, but **the two
byte-identical control arms disagree by 0.6–3.4 % in the same runs**, so the
wall-clock effect is NOT separable from noise at this scale. Read the honest
result as: *at most ~1–2 %, indistinguishable from zero on this harness.*
(Anything read off a 24-batch run at this effect size is noise — the first row
is the proof, and it is worth remembering before trusting a future 5 % claim.)

The reliable evidence is the profile, not the clock.

The V8 CPU profile says exactly why, and this is the finding that should
re-sequence the remaining work. Base → S4a, self time:

| helper | base | S4a |
| --- | --- | --- |
| `__box_number` | 1.81 % | 1.33 % |
| `__unbox_number` | 1.66 % | 1.32 % |
| `__to_primitive` | 1.00 % | 0.68 % |
| `__apply_closure` | 1.47 % | 1.05 % |

**The entire boxing/unboxing surface was only ≈4.5 % of the profile to begin
with**, and S4a took about a third of it. The S2 note's inference — "the win is
the boxing" — was qualitatively right about the mechanism (the box IS removed:
`__unbox_number` sites 5576 → 5270, `__to_primitive` 1500 → 1207) and
quantitatively wrong about the size of the prize. Where the time actually is,
in the S4a profile:

- **method-call bridge ≈13 %** — `__call_fn_method_1` 4.9 %,
  `__call_fn_method_0` 3.6 %, `__method_cache_lookup` 2.3 %,
  `__extern_method_call` 1.2 %, `__apply_closure` 1.1 %. **This is S3.**
- **generic property lookup ≈14 %** — `__extern_get` 7.9 % plus `__str_equals`
  6.1 % (the name compare inside the dispatchers). These are the reads S2/S4
  do NOT reach: non-`this` receivers (`node.start`, `this.options.locations`).
  The natural follow-on is extending the #2660 receiver-flow map so a proven
  fnctor receiver gets the same inline `struct.get` a twin's `this` gets.
- **regex engine 8.7 %** (`__regex_run`), **GC 1.9 %**.

One caveat S4a itself surfaces: promoting a slot moves cost, it does not only
remove it. Static `__box_number` call sites went UP 3412 → 4793, because an f64
field read that feeds an externref consumer (a call argument, an untyped local)
must now box on the way out. The dynamic share still fell, because #3673's i31
small-int boxing makes those added boxes allocation-free while the removed
unboxes were real calls — but it means the promotion only pays where the
consumer is numeric, and **S4b (raw f64 locals inside twins) is what would
close the loop**. Its ceiling is now measurable and small: box + unbox +
to_primitive in S4a total **3.3 %**, so perfect elimination of all remaining
boxing is worth ~3 %. That is why S4b was NOT attempted here — the same effort
against `__extern_get`/`__str_equals` or S3's call bridge addresses 4× more
time.

**Verification.** `tsc` clean; acorn standalone canaries 2/3/4/5 with
`imports: 0`; `DOGFOOD_ACORN=1 dogfood:acorn-corpus` 23/23 exact, distinct REAL
gaps 0; 15 S4a pins; `issue-3683-typed-this-twin` 12/12,
`issue-3683-proto-method-write-once` 10/10, `issue-3673-i31-smallint` 7/7,
`issue-2151-nary`, `issue-1712` ×5, `issue-2674` ×2, `issue-2664` ×2 all green.

Full `tests/equivalence` (213 files / 1,646 tests) run on the merged state AND
on the merge parent `5d8dafd2`, both with `--reporter=json`, and diffed by FULL
TEST NAME rather than by counts: **33 failed / 1,610 passed / 3 todo on both,
identical set, zero tests failing on only one side.** The 13 failing files
(`arguments-nested-and-loops`, `array-inline-return`, `delete-sentinel`,
`issue-1197`, `logical-conditional-identity`, `misc-small-patterns`,
`new-non-constructor`, `null-dereference-guards`, `optional-direct-closure-call`,
`reflect-api`, `spec/coercion-arithmetic-add`, `tdz-reference-error`,
`yield-as-expression`) are all pre-existing. `delete-sentinel` failing on both
sides is worth noting explicitly given S4a's delete carve-out: the carve-out is
what keeps it from getting WORSE, and it was already failing.

Three soundness fixes were found by review before that differential and are in
their own commit: `ownReturnExpressions` missing #2847's definite-return guard
(a function that falls off the end returns `undefined`, which is invisible in
its return list), an unguarded `parent` deref in the scope walk, and
exponential branching in `isString`'s slot recursion.

## S3 implementation notes (2026-07-27) — landed

**What landed.** Inside a typed twin, `this.<m>(args…)` on a write-once
prototype method of the SAME fnctor lowers to `local.get <this>;
extern.convert_any; <args>; call $__dc_<F>_<m>_<n>` — one direct call, arguments
in their NATIVE types, result in its native type — instead of the `__call_m_*`
→ `__method_cache_lookup` → `__call_fn_method_N` → `call_ref` bridge. On acorn:
**1,458 devirtualized call sites across 229 trampolines** (219 resolve straight
to a twin, 10 degrade to the legacy fill). Kill-switch `JS2WASM_DIRECT_CALLS=0`,
diagnostics `JS2WASM_DIRECT_CALLS_DEBUG=1`. Emitters live in `typed-this.ts`;
the god-file gains one guarded call (+19 lines).

### The `self`-operand problem, and why option (b) won

The S1 note framed the design choice as (a) per-admitted-method singleton
GLOBALS holding the closure, vs (b) widening the twin's lifted `self` param.
**(b) was chosen, in a form the note did not anticipate: the twin's unread
`__self` parameter is REPLACED by the receiver**, typed `(ref $__fnctor_F)`.
Three facts make that work:

- **Nothing in an admitted body reads `__self`.** `admitTypedThisTwin` already
  requires zero captures, no self-recursive binding and no named function
  expression — the three (and only) consumers of param 0.
- **The generic shim can still tail-forward.** `return_call` constrains only the
  callee's RESULTS to equal the caller's; parameters are ordinary stack
  operands. The shim tees `__current_this` into an anyref scratch, `ref.test`s
  it, and on a hit pushes `ref.cast $__fnctor_F` plus `local.get 1..n`.
- **It removes work instead of adding it.** The S2 twin prologue's
  `global.get; any.convert_extern; ref.cast; local.set` is gone — the typed
  local IS param 0 — where option (a) would have ADDED a `global.get` +
  `ref.cast` per call and a `global.set` at every construction site.

`__current_this` is still installed for every twin entry: a twin body's
NON-field uses of `this` (a `this` argument, a dispatcher fallback read, a
nested legacy `__call_m_*`) read the global. That install, plus the
save/restore, is owned by the trampoline — one place, mirroring
`__call_fn_method_N` (including its known limitation that an exceptional unwind
skips the restore).

### Why a trampoline at all

Acorn's parser is mutually recursive (`parseMaybeAssign` → `parseExprOps` →
`parseMaybeUnary` → back), so whichever body compiles first references a twin
that does not exist yet. Patching the call instruction later was rejected: it
means holding `Instr` object identities across the whole compile, exactly the
aliasing hazard the codebase forbids. The project's established answer is
reserve-then-fill (`reserveMemberGetDispatch` / `reserveClosedMethodDispatch`),
and it earns its keep three times over here:

1. the stable-handle regime (`mintDefinedFunc`, `STABLE_FUNC_BASE`) makes the
   baked `call` immediate immune to late-import shifts;
2. the trampoline owns the `__current_this` / `__argc` bookkeeping, so N call
   sites cost one instruction each instead of five;
3. it gives the fill somewhere to **degrade**. Call-site admission is decided
   from the AST + the S1 verdicts, but the twin's own admission additionally
   needs capture analysis, available only once the method's closure compiles.
   When the two disagree the fill emits the byte-for-byte legacy
   `__call_m_<m>_<n>` sequence instead, so a call site can never point at a twin
   that failed to materialize (10 of acorn's 229 land here).

The legacy dispatcher is reserved at trampoline-reserve time — it is the exact
dispatcher this site would have reserved without S3, so the set of `__call_m_*`
functions in the module is unchanged, and it registers every box/unbox helper
the fill needs (the fill is strictly read-only over `funcMap`).

### Soundness: the `otherNameWrites = null` sentinel is not a blocker

The S1 note warned that acorn trips the computed-write sentinel
(`keywordTypes[name] = …`) so S3 "MUST use receiver-shape runtime guards, not
name-only proofs". The receiver-shape guard turns out to be **free**: it is the
twin's own `ref.cast`, already established at entry. Given that, `this.<m>`
resolves through exactly two steps and both are pinned at compile time:

- **Own property?** In STANDALONE mode a `$__fnctor_F` instance is a CLOSED
  WasmGC struct. `deriveFnctorFields` computes the complete field list, and the
  expando sidecar that would let a property appear at runtime is explicitly
  host-mode-only ("Host mode already has its fnctor sidecar for expando
  properties… This native shape growth is the host-free standalone replacement
  only"). So the only own-property shadow possible is a DECLARED field, rejected
  by name — together with accessor names and the reserved-name set the pinned
  path itself refuses. `keywordTypes` is a plain object, not a Parser, so the
  sentinel was over-conservative for this question all along.
- **Prototype slot?** The S1 write-once verdict, with `poisoned` (prototype
  reassigned / computed-written / deleted from / escaped) and `inheritedFrom`
  (`Object.create(F.prototype)`) both declining.

Everything unproven declines, and a decline is byte-for-byte the pre-S3
lowering (the call falls through to `tryCompileLateFnctorPrototypeMethodCall`).

### The `fixups.ts` landmine — a genuine pre-existing bug, worth its own issue

The natural trampoline signature is `(ref $__fnctor_F, …params)`. It **cannot be
used**, and the reason is not S3's: `fixups.ts`'s `ref.null.extern` retyping
walks a call's arguments backwards **one INSTRUCTION per parameter**, and skips
a nested call by subtracting that callee's **PARAMETER count** — i.e. it
silently assumes every argument is produced by exactly one instruction. Acorn's

```js
this.parseExprOp(this.parseMaybeUnary(null, false, false, forInit), …)
```

breaks the assumption: each `false` is `i32.const 0` + `call __box_boolean`, two
instructions, so the OUTER walk under-skips by two and lands the inner call's
`ref.null.extern` on the outer callee's **parameter 0**. Every pre-existing
callee in that position (`__call_m_*`, `__extern_method_call`) has an
all-`externref` signature, so a misaligned landing was harmless — the fixup only
rewrites when the parameter is a `ref`/`ref_null`. A typed receiver made
parameter 0 a struct ref for the first time in that position, the null was
rewritten to `ref.null $__fnctor_Parser`, and the module failed validation
(`call[1] expected type externref`).

S3 therefore keeps its own signature outside the hazard: **the receiver travels
as `externref`** (one `extern.convert_any` per call site, one
`any.convert_extern; ref.cast` per trampoline — trivial against the bridge being
removed) and a call with any `ref`-typed user parameter simply declines. No
`__dc_*` signature contains a `ref`/`ref_null`, so a misaligned landing is a
no-op exactly as it is for `__call_m_*`. Re-engineering the shared fixup would
need a real operand-count model, and its current approximations (`struct.new`,
`array.new_fixed` and the `call` case are all instruction-count guesses) may
have consumers that depend on them — that is a separate slice.

### Void-returning callees are 30 % of the win

`this.next()` / `this.expect(…)` — the tokenizer's hottest calls — return
nothing, so `computeClosureWrapperSig` gives them a null return type. The first
cut declined them (430 of the 1,458 sites); the trampoline now carries an EMPTY
result list, the legacy arm drops the externref the dispatcher unconditionally
yields, and the call site answers `VOID_RESULT` — which `compileExpression`
already materializes into whatever the consuming context needs.

### Measured result

Same interleaved methodology as S2/S4a (all arms in ONE process, round-robin,
deep warm ≥600 parses, min-of-N batches × 200 parses), with the S4a
**duplicate-baseline control arm** — and here it is stronger than S4a's, because
the kill-switch reproduces the pre-S3 tip **byte-for-byte**, so `base` and
`base2` are provably identical binaries (asserted with `Buffer.equals`), making
the control arm's true delta exactly zero by construction.

| session | batches | order | S3 | base | base2 | control band | S3 vs mean |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 40 | s3,base,base2 | 1.1046 | 1.3085 | 1.3110 | **0.19 %** | **−15.7 %** |
| 2 | 40 | base2,base,s3 | 1.1047 | 1.3225 | 1.3175 | **0.38 %** | **−16.3 %** |
| 3 | 60 | base,s3,base2 | 1.0443 | 1.2866 | 1.2806 | **0.47 %** | **−18.7 %** |

**≈16 % faster, against a 0.2–0.5 % noise floor — the first change in this
family whose wall-clock effect is unambiguously outside the control band.**
(Contrast S4a, whose ≈1 % was correctly reported as indistinguishable from zero
because the two control arms disagreed by 0.6–3.4 %. The control arm is doing
its job in both directions.)

The profile says exactly where it came from. Base → S3, self time, 6,000-parse
window (total 10,276 ms → 8,773 ms):

| helper | base | S3 |
| --- | --- | --- |
| `__call_fn_method_1` | 5.78 % | 2.57 % |
| `__call_fn_method_0` | 3.81 % | 1.56 % |
| `__method_cache_lookup` | 3.21 % | 1.13 % |
| `__call_fn_method_2` | 2.13 % | 1.14 % |
| `__call_fn_method_3` | 1.09 % | 0.86 % |
| `__extern_method_call` | 1.13 % | 1.27 % |
| `__apply_closure` | 0.94 % | 1.09 % |
| **bridge total** | **18.10 %** | **9.62 %** |

The bridge is roughly HALVED (−8.5 pp). Read the remaining entries carefully:
`__extern_get` "rises" 7.44 → 9.07 % and `__regex_run` 6.15 → 7.06 % purely
because they are a share of a 15 % smaller total — their absolute cost is flat.
The residual 9.6 % of bridge is the traffic S3 does not claim: the arity-skewed
calls (below) and every non-`this` receiver (`node.start`, `other.inner()`).

### What is left on the table, and the exact convention the next slice must match

The decline histogram on acorn is now: **`arity-mismatch` 428**,
`no-write-once-verdict` 102, `uses-arguments` 4. The first is the whole
remaining prize and it is NOT hard, but it is subtle enough to deserve its own
slice rather than being bolted on here:

- Under-application (`this.parseIdent()` into a 1-formal method) is the common
  JS shape. `__apply_closure`'s #3592 widening handles it by raising the
  dispatch index to `declaredArity` and letting `ARG_OF(k)` answer the
  **undefined externref sentinel** for `k >= len`, which means `__argc` ends up
  at **`formals`, not the call-site argc**. A padding trampoline must reproduce
  BOTH halves exactly, or default-parameter presence (`paramDefaultNeedsArgc`)
  silently flips for every under-applied call in the program.
  > **CORRECTION (S3b, measured).** The `__argc` half of that sentence is
  > WRONG — see the S3b notes below. `__argc` ends at the **call-site count**,
  > not `formals`. The warning it carries is still the right one: this is
  > exactly the state whose mis-guess flips default-parameter presence
  > program-wide, which is why S3b measured it instead of reading it.
- Over-application must still EVALUATE the extra arguments (side effects) and
  discard them, and `__extras_argv` only matters for bodies that read
  `arguments` — which already decline.

Expected shape: key the trampoline by call-site arity (already done), give it
the twin's first `argc` params, and pad the rest inside the trampoline.

### Two places S3 FIXES a pre-existing divergence

Both are pinned with explicit values on each side rather than as lane
agreement, so the difference is documented instead of averaged away:

- `var r = this.step(2)` with a void `step`: node and the devirtualized lane
  answer `undefined`; the dynamic `__call_m_*` lane does not.
- `this.take(this.tag(1), this.tag(2))` where `take` reads `this.<field>`: node
  and S3 answer 12; the dynamic lane answers `NaN` after two nested bridge
  frames.

### Verification

`tsc` clean; `check:loc-budget` and `check:oracle-ratchet` both green (S3 adds
ZERO checker usage — `admitDirectCall` reads its owner from the S1 verdict map
instead of re-deriving it; the `oracle-ratchet-allow` in this file's frontmatter
grants S2's pre-existing +2/+3, which has been red since S2 landed because the
gate measures against `main`). Standalone acorn canaries 4/4 with `imports: 0`,
binary 1,808,486 → 1,807,913 bytes (S3 is SMALLER than base — a direct call
takes fewer bytes than the dispatcher call it replaces).
`DOGFOOD_ACORN=1 dogfood:acorn-corpus` 23/23, distinct REAL gaps 0. 16 new S3
pins; `issue-3683-typed-this-twin` 12/12, `issue-3683-numeric-fields` 15/15,
`issue-3683-proto-method-write-once` 10/10, `issue-3673-i31-smallint` 7/7,
`issue-2151-nary`, `issue-2674` ×2, `issue-2664` ×2 green (the 12
`issue-1712` failures are `ENOENT` on an unchecked-out test262 submodule, not a
code result).

Full `tests/equivalence` (1,646 tests) run on the final commit AND on the merge
parent `17816991`, both with `--reporter=json`, diffed by FULL TEST NAME:
**1,610 passed / 33 failed / 3 todo on both, identical set, zero tests failing
on only one side.**

## S3b implementation notes (2026-07-27) — landed

**What landed.** The direct-call trampoline is now keyed by CALL-SITE arity and
materializes the missing arguments itself, so an UNDER-APPLIED `this.m(a)` into
a 2-formal method devirtualizes. On acorn: **1,458 → 1,886 devirtualized sites
across 229 → 264 trampolines** (250 twin fills, 14 legacy), and the
`arity-mismatch` decline bucket — 428, the largest one S3 left — is now **ZERO**.
The remaining declines are `no-write-once-verdict` 102 and `uses-arguments` 4.
Binary 1,806,262 → 1,804,245 bytes (again SMALLER: a shared padded trampoline
costs less than the `__call_m_*` sequences it replaces).

### The convention — and why the S3 note's reading of it was wrong

S3 handed this slice one instruction: reproduce both halves of what the dynamic
bridge leaves for an under-applied callee, because a wrong guess flips
default-parameter presence program-wide. Half of what it handed over was wrong,
and only a differential measurement caught it.

- **The VALUE half was right.** `__apply_closure`'s #3592 widening raises only
  the dispatch SELECTOR to `declaredArity`; the args vector is not padded, so
  `ARG_OF(k)` reads out of bounds for `k >= len` and answers
  `undefinedExternInstrs(ctx)` — the #2106 `$undefined` singleton (or
  `ref.null.extern` with the regime off). That is what the trampoline pads with.
- **The `__argc` half was wrong.** The claim was "`__argc` ends up at `formals`,
  not the call-site argc". It does not. `fillApplyClosure` writes the RAW
  call-site count *before* the widening ("Preserve the raw call-site count in
  `__argc`…", object-runtime.ts), and `emitClosureMethodCallExportN`'s #2745
  setup then clamps it to `min(preset, closureArity)` — which for an
  under-applied call is the call-site count again. Measured directly on this
  branch before writing any code: a 3-formal method called with one argument
  observes `arguments.length === 1`, and an f64 defaulted formal (whose default
  check is the argc-driven `emitParamDefaultArgMissingCheck`, NOT a value test)
  correctly takes its default.

The practical consequence is the happy one: S3's trampoline already wrote
`i32.const <call-site arity>` into `__argc`, because its `arity` IS the
call-site count. **No change was needed** — but had the note been trusted, the
"fix" would have been to write `formals` there, which would have silenced every
argc-driven parameter default in every under-applied call in the program while
leaving all the externref-typed ones (the ones a hand-written test reaches for
first) perfectly correct. That is the failure mode the slice was carved out to
avoid, and it is the reason the convention is now documented on
`buildPadValue` with the measurement rather than the inference.

### What a padded slot costs, per type

Given that `__argc` carries the call-site count, the argc check
`argc != -1 && argc <= k` is TRUE for every padded index `k >= arity`. So:

| padded slot | pad emitted | why it is exact |
| --- | --- | --- |
| `externref` | `global.get $undefined; extern.convert_any` | byte-for-byte `ARG_OF(k)`'s OOB answer; fires `__extern_is_undefined` and NOT `ref.is_null` |
| `f64`/`i32` **with** an initializer | `f64.const 0` / `i32.const 0` | the argc check always fires, so the default overwrites the slot — the bits are dead |
| `f64`/`i32` **without** an initializer | — DECLINES (`pad-native-param`) | the body reads the raw value, whose legacy production is `__unbox_number(<undefined>)`, i.e. a NaN that `i32.trunc_f64_s` TRAPS on. Reproducing a trap is not worth a devirtualization and guessing a different value is a silent divergence. Acorn has no such formal (every parser parameter is `any`). |

OVER-application still declines (`arity-over`): the extra arguments must be
evaluated for their side effects and routed into the canonical `__extras_argv`
vector, which is a different protocol from padding, not a bigger version of it.

The legacy degradation arm needs **no** pad — `__call_m_<m>_<arity>` is the
exact dispatcher the site would have reserved without S3, and the dynamic bridge
behind it does its own widening. Only the twin arm pads.

`padInstrs` are built at RESERVE time and stored on the trampoline record: the
fill is read-only over the module, and the sequences are funcIdx-free
(`global.get` / `extern.convert_any` / constants), so they are immune to the
late-import index shift.

### Isolation switch, and the byte-identity that makes the measurement mean something

`JS2WASM_DIRECT_CALLS=nopad` keeps S3's exact-arity devirtualization and
declines every under-applied site. Two checks make it a usable control arm:

- an exact-arity-only module is **byte-identical** compiled with and without
  `nopad`, and
- **the acorn binary compiled on this branch under `nopad` is byte-identical to
  the acorn binary compiled at the merge parent `dae75375`** (`cmp` clean,
  1,806,262 bytes), with an identical tally (1458 / 229 / 219 / 10 — exactly the
  numbers in the S3 notes above).

So the `base` arm below is not "a build that should be equivalent"; it is
provably the same bytes as S3. The `JS2WASM_DIRECT_CALLS=0` kill-switch is
likewise byte-identical across the two commits.

### Measured result

Same methodology as S3/S4a: all arms in ONE process, round-robin, deep warm
(600 parses) before any measured batch, min-of-N batches × 200 parses of the
330 B corpus, with the duplicate-baseline control arm (`base2` is the same bytes
as `base`, asserted with `Buffer.equals`, so its true delta is zero by
construction).

| session | batches | order | S3b | base | base2 | control band | S3b vs mean |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 40 | s3b,base,base2 | 0.5441 | 0.5695 | 0.5742 | 0.83 % | **−4.85 %** |
| 2 | 40 | base2,base,s3b | 0.5721 | 0.5964 | 0.5978 | 0.23 % | **−4.19 %** |
| 3 | 60 | base,s3b,base2 | 0.5698 | 0.6009 | 0.5937 | 1.21 % | **−4.59 %** |

**≈4.5 % faster against a 0.2–1.2 % noise floor** — outside the control band in
all three orders, but a fifth the size of S3's ≈16 %. That ratio is worth
recording: S3b devirtualizes 29 % more sites (1,458 → 1,886) for a fifth of the
win, because the 428 under-applied sites are the *colder* ones — acorn's hot
tokenizer edges (`this.next()`, `this.expect(t)`) are exact-arity and S3 already
took them.

The profile says the same thing, two independent 6,000-parse windows:

| helper | base | S3b (run 1) | base | S3b (run 2) |
| --- | --- | --- | --- | --- |
| `__call_fn_method_0` | 1.67 % | 1.26 % | 1.51 % | 1.53 % |
| `__call_fn_method_1` | 2.03 % | 2.28 % | 2.23 % | 2.56 % |
| `__call_fn_method_2` | 1.73 % | 0.71 % | 1.50 % | 0.30 % |
| `__call_fn_method_3` | 1.02 % | 0.36 % | 1.26 % | 0.30 % |
| `__method_cache_lookup` | 1.12 % | 0.99 % | 1.61 % | 0.77 % |
| `__extern_method_call` | 1.59 % | 1.24 % | 1.26 % | 0.88 % |
| `__apply_closure` | 1.83 % | 0.73 % | 1.21 % | 0.65 % |
| **bridge total** | **11.26 %** | **7.99 %** | **10.84 %** | **7.17 %** |

Bridge absolute cost over the same workload: 561 → 374 ms and 553 → 343 ms
(≈−33 %). The two entries that collapse are exactly the ones the theory predicts:
**`__apply_closure` roughly halves** (it is the only entry point that performed
the #3592 widening, i.e. it was the under-applied calls' bridge), and
`__call_fn_method_2`/`_3` fall by ~⅔ (an under-applied call was dispatched to
the arity-`formals` export, not the arity-`argc` one). `__call_fn_method_1`
*rises* slightly — a share of an 8 % smaller total, and the residue is the
non-`this` receivers S3/S3b do not claim.

### Verification

`tsc` clean; `check:loc-budget` and `check:oracle-ratchet` both green (S3b adds
ZERO checker usage). Standalone acorn canary on a fresh compile: `smoke=4`,
`imports: ZERO`, 1,804,245 bytes. `DOGFOOD_ACORN=1 dogfood:acorn-corpus` 23/23,
**distinct REAL gaps 0**. 14 new pins in
`tests/issue-3683-arity-padding.test.ts`; `issue-3683-direct-calls` 16/16 (one
pre-existing pin updated — the S3 arity pin asserted that BOTH skewed arities
decline, which is now true only of over-application),
`issue-3683-typed-this-twin` 12/12, `issue-3683-numeric-fields` 15/15,
`issue-3683-proto-method-write-once` 10/10, `issue-3673-i31-smallint` 7/7,
`issue-2674` ×2, `issue-2664` ×2 green. Pre-existing and unchanged by this
slice, verified by re-running them at `dae75375`: 3 `issue-2151` failures
(including "empty dynamic spread: trailing numeric param reads 0"), and the 12
`issue-1712` failures which are `ENOENT` on an unchecked-out test262 submodule.
The `medium` bench fixture traps ("dereferencing a null pointer") on the base
commit and under both switches too — also pre-existing, not an S3b regression.

Full `tests/equivalence` (1,646 tests) run on the final commit AND on the merge
parent `dae75375`, both with `--reporter=json`, diffed by FULL TEST NAME:
**1,610 passed / 33 failed / 3 todo on both, identical set, zero tests failing
on only one side.**

### One divergence this slice documents rather than fixes

An EXPLICIT `undefined` argument does not fire the callee's parameter default
when the call crosses `__call_m_*` — `p.m(1, undefined)` answers as if `1` were
passed. It is pre-existing and devirtualization-independent (reproducible with a
plain top-level call on every lane), and S3's exact-arity devirtualization
already fixes it where it applies. The `nopad` and `direct` lanes therefore
answer the node-correct value while the fully dynamic lane does not, so the pin
records the value per lane instead of asserting lane agreement — the same
treatment the two S3 divergences got.

## Acceptance criteria

- S2: standalone acorn parse measurably faster than the #3673 round-13
  baseline (1.51ms) with corpus 23/23 exact and the full #3673 battery
  green; every admission-rejected method keeps byte-identical output.
- S3+S4: cumulative ≥5x over the round-13 baseline on the 330B bench
  (≤0.3ms/parse), putting the node-acorn gap under 10x for the first
  time.
