---
id: 4187
title: "standalone: hasOwnProperty const-fold ignores runtime delete — the #2726 routing gate's standalone exclusion has outlived its substrate gap"
status: done
completed: 2026-08-07
completed_slice: "the const-fold/runtime divergence itself — measured +1 / -0 over 2,654 files, exposure 5 modules. The 8 sibling files this issue named did NOT flip and are blocked behind separate defects (see Residue); option 2 (drop the standalone gate outright) is untested, not rejected."
sprint: 78
priority: medium
horizon: s
feasibility: medium
goal: standalone-gap
assignee: ttraenkler/W29
created: 2026-08-06
updated: 2026-08-18
found-by: ttraenkler/W9-descriptor-proto-residue
loc-budget-allow:
  # The fix is ~5 lines of code in three god-files; the overage is the
  # explanatory comments (already trimmed once, +23/+9/+7 -> +14/+8/+6).
  # `object-ops.ts` is where the routing gate lives, `types.ts` is where a
  # CodegenContext field must be declared, and `index.ts` is where every other
  # whole-program pre-scan is wired. The reusable half — the pre-scan itself —
  # went into the subsystem module `source-scan-predicates.ts`, not a god-file.
  - src/codegen/object-ops.ts
  - src/codegen/context/types.ts
  - src/codegen/index.ts
func-budget-allow:
  # Same growth, same reason. The gate being fixed IS a clause inside
  # `compilePropertyIntrospection`; the condition cannot be moved out of the
  # function whose routing decision it changes. `generateModule` grows by the
  # one pre-scan call line every other whole-program pre-scan also occupies.
  - src/codegen/object-ops.ts::compilePropertyIntrospection
  - src/codegen/index.ts::generateModule
---

## Problem

In `--target standalone`, `obj.hasOwnProperty(k)` (and `propertyIsEnumerable`,
and the shared static fold behind `in`/for-in shape answers) can
**constant-fold to `true` at compile time** for a key that
`Object.defineProperty` added and a later `delete obj[k]` removed at runtime.
The delete succeeds — the `$Object` entry is tombstoned, `gOPD` answers
`undefined`, `Object.keys` omits it, `Object.hasOwn` answers `false` — but the
folded call site still says `true`. A property that is provably gone by every
runtime channel is still "own" through the folded one.

Canonical repro (test262 `built-ins/Object/defineProperty/15.2.3.6-3-86-1.js`,
the last unfixed file of the 44-file "of prototype object" descriptor slice):

```js
var obj = {};
Function.prototype.configurable = true;      // inherited descriptor field
var funObj = function (a, b) { return a + b; };
Object.defineProperty(obj, "property", funObj); // configurable:true, inherited
var beforeDeleted = obj.hasOwnProperty("property"); // true (correct)
delete obj.property;                                // deletes (entry tombstoned)
var afterDeleted = obj.hasOwnProperty("property");  // true (WRONG — folded)
```

Measured on `origin/issue-4176-standalone-proto-named-keys` (the substrate this
slice needs), CI-aligned shimmed instrument:

```
d2(gOPD after delete) = none        ← delete worked
Object.hasOwn(obj,"property") = false  ← runtime native is truthful
obj.hasOwnProperty("property") = true  ← call site folded; no call emitted
```

Verified at the artifact level: the **executed** wasm (dumped via an
instantiate hook from the real runner pipeline) contains a
`call $__object_hasOwn` for the `Object.hasOwn` spelling and **no call at
all** for the direct `obj.hasOwnProperty(...)` spelling — it was folded. The
two natives' bodies are byte-identical (own-only, tombstone-skipping via
`__obj_find`); the runtime is NOT the defect.

## Root cause (exact)

`compilePropertyIntrospection`, `src/codegen/object-ops.ts` (~line 4597-4625,
comment block "#2726 standalone fix"): the two broad routing signals that
force a runtime call when `Object.defineProperty` was statically observed on
the receiver — `ctx.definePropertyReceiverKeys` (every lowering path) and
`ctx.sidecarDefinedPropertyKeys` (runtime-descriptor route) — are gated
**`!ctx.standalone`**. The comment records why: at #2726 time the standalone
native `__hasOwnProperty` could not report a defineProperty-added
struct-shape property (pre-bag era), so routing regressed 19 files (the
PR #2177 park), and it says the standalone routing "awaits the standalone
`__hasOwnProperty` sidecar-awareness substrate work."

That substrate has since landed:

- `__defineProperty_value` / `__obj_define_from_desc` insert REAL `$Object`
  entries natively (#1629 S6, #2042 S4);
- the #3468/#3537/#4010 carrier bags + `__carrier_bag_has` arms;
- #4098 per-instance tombstones (`__instance_field_deleted` screen) for
  closed-struct receivers;
- the #6613 closed-struct field arms unshifted into
  `__hasOwnProperty`/`__object_hasOwn`/`__propertyIsEnumerable`.

The third, mode-agnostic signal (`definedPropertyFlags`) only covers *inline
object-literal* descriptors — in the repro the descriptor is an identifier
(`funObj`), so nothing routes and the fold wins with the
defineProperty-widened shape answer.

The reason only the `-1` variant of the test family fails: with
`Function.prototype.configurable = true` proven, the #3663
`inheritedTrueDescriptorFlags` fold routes the define through the flag-only
`emitExternDefinePropertyNoValue` lane rather than
`emitDefinePropertyDescRuntime`, and the hasOwn call-site gate never sees a
signal it is allowed to act on in standalone.

## Fix sketch

Two options, in decreasing safety:

1. **Narrow (recommended first)**: keep the standalone gate but add a
   delete-observed condition — route to the runtime helper when the receiver
   var has a recorded defineProperty (`definePropertyReceiverKeys` /
   `sidecarDefinedPropertyKeys`) **and** the module contains a
   `delete <recv>.<key>` / `delete <recv>[...]` on that receiver (AST
   pre-scan, same shape as `prototypeDescriptorFieldState` in
   `object-descriptor-analysis.ts` — do NOT record-as-you-compile; the
   `beforeDeleted` read precedes the delete statement textually and must keep
   folding true). The const-fold only diverges from runtime state when a
   delete exists, so this bounds the blast radius to exactly the incoherent
   modules.
2. **Broad**: drop `!ctx.standalone` entirely and re-measure the PR #2177
   19-file class — the substrate that caused it has landed, and the closed-
   struct arms + tombstone screen mean the native now answers struct-shape
   properties. Measure before believing; if it holds, prefer this (deletes
   the divergence class instead of gating it).

## Sizing (measured 2026-08-06)

- Direct yield on the W5 descriptor lever (558 files): the
  defineProperty+delete+hasOwnProperty shape appears in **9** failing files
  (`15.2.3.6-3-{86-1,87,91,92,94,95,123}.js`, `15.2.3.5-4-106.js`,
  `15.2.3.7-5-b-66.js`), of which -87/-92 are already fixed on the unmerged
  #4180 branch. Expect **single digits**, +1 guaranteed (`-3-86-1`).
- Do NOT implement while #4176 and #4180 are unmerged: both touch
  `object-ops.ts`, and those two branches ALREADY conflict with each other in
  that file (verified `git merge-tree --write-tree`: content conflict — both
  rewrote the #2372 reify gate hunk differently). Land those first; the
  resolution should keep #4180's `isDescriptorTranscribableStruct`
  (plausible-descriptor test), which subsumes #4176's three-name skip list.

## Instrument note (hard-won, do not rediscover)

`compile(src, {target:"standalone", emitWat:true})` on the bare test source is
**not** the executed artifact: the runner wraps the body inside
`export function test(): number { try { … } }` with hoisted `var`s, rewritten
asserts, `fileName: "test.ts"`, `deferTopLevelInit: true`. Lowering decisions
(fold vs call) differ between the two. To see the truth, dump the executed
module bytes from inside the runner (hook `WebAssembly.instantiate`, write the
buffer, `npx wasm-dis`) — worktree
`/home/user/js2/.claude/worktrees/agent-a7cf4452a1666951b/.tmp/w9-child-dump.mts`
does exactly this.

## Repro / acceptance

- `built-ins/Object/defineProperty/15.2.3.6-3-86-1.js` passes standalone
  (on a base that includes #4176).
- The 8 sibling files above re-measured; no regression on
  `built-ins/Object/{defineProperty,prototype/hasOwnProperty,getOwnPropertyNames}`
  (the #2177 park class).
- `Object.hasOwn` / direct-call coherence: both spellings agree after
  define+delete.


## MEASURED (2026-08-07, W29) — +1 / −0, exposure enumerated at 5 modules

### Instrument

Real standalone lane, `runTest262File(…, target: "standalone")`, runtime-eval
provider at the **INTERPRETER** tier (`TEST262_FULL_RUNTIME_EVAL=1`, key
`854c120ce015d507`, 4,141,601 bytes, cached `.wasm` deleted and rebuilt for
**each arm**). Both arms report **zero** `js2wasm:runtime-eval` link errors, so
no row is the fake-signature substitute.

**Instrument validated before any delta was read.** The BASE arm was diffed
file-for-file against the published **standalone** baseline
(`ensureStandaloneBaselineJsonl({force:true})`, 48,619 rows — *not* the default
jsonl, which is the host lane):

```
population overlap: 2,654 / 2,654
AGREE: 2,650 (99.85%)     DISAGREE: 4
```

All four disagreements are `baseline=compile_timeout` / `mine=pass` — the known
benign CI-timeout class, not instrument error.

**A first attempt was discarded**: the provider was missing, and 32 of the first
235 rows (13.6%) were `Import #0 module="js2wasm:runtime-eval": module is not an
object or function` — the real per-file result replaced by a uniform link error.
Caught because the canonical repro reported that instead of its filed
`afterDeleted` signature.

### Result — full control population, not a sample

`Object/{defineProperty, defineProperties, create, getOwnPropertyDescriptor,
isExtensible, preventExtensions, getOwnPropertyNames, keys, prototype/hasOwnProperty,
prototype/propertyIsEnumerable}` — **2,654 files**, every one run on both arms.

| | standalone |
| --- | --- |
| BASE pass | 2,390 / 2,654 |
| HEAD pass | **2,391 / 2,654** |
| fixed | **+1** |
| regressed | **0** |
| signature-changed (still failing) | **0** |

The one fix is the canonical repro,
`built-ins/Object/defineProperty/15.2.3.6-3-86-1.js`, RED on base with exactly
the filed signature (`afterDeleted Expected SameValue(«true», «false»)`) and
green on head.

**The PR #2177 park class did not regress.** `Object/defineProperty`,
`Object/prototype/hasOwnProperty` and `Object/getOwnPropertyNames` are all inside
the population above and contribute 0 regressions — which is the acceptance
criterion this issue set for widening the #2726 gate.

### Byte-hash exposure — 5 modules, enumerated

Emitted-module hash compared across both arms for all 2,654 files:

| | files |
| --- | ---: |
| **IDENTICAL** wasm | **2,648** |
| **CHANGED** wasm | **5** |
| no hash (compile error on both arms) | 1 |

The 5 that changed, and what happened to each:

| file | base → head |
| --- | --- |
| `15.2.3.6-3-86-1.js` | fail → **pass** (the fix) |
| `15.2.3.6-3-123.js` | fail → fail, *identical* error — blocked upstream on a `dereferencing a null pointer in __module_init()` at L16, so the `beforeDeleted` read is never reached |
| `15.2.3.6-3-245.js` | pass → pass |
| `15.2.3.6-3-246.js` | pass → pass |
| `15.2.3.6-3-247.js` | pass → pass |

The 1 file with no hash is `Object/isExtensible/15.2.3.13-2-13.js`, a pre-existing
`#1907 Function.constructor` compile error identical on both arms — not exposure.

### The honest cost: 3 modules pay for nothing

`-245/-246/-247` pass on **both** arms: the fold they lost was already giving the
right answer, so for them this change is pure cost. Measured — emitted module
size through the real runner pipeline (`WebAssembly.instantiate`/`Module` hooked
**before** a dynamic import of the runner; a static import is hoisted above the
hook, which is why the first attempt read `-1` everywhere):

| file | base | head | delta |
| --- | ---: | ---: | ---: |
| `15.2.3.6-3-86-1.js` | 569,463 | 569,479 | **+16** |
| `15.2.3.6-3-123.js` | 531,955 | 531,971 | **+16** |
| `15.2.3.6-3-245.js` | 712,261 | 712,269 | **+8** |
| `15.2.3.6-3-246.js` | 718,106 | 718,114 | **+8** |
| `15.2.3.6-3-247.js` | 713,504 | 713,512 | **+8** |

**+56 bytes total across the whole 2,654-file corpus** (≈0.002% on modules of
530–720 KB), because a folded `i32.const` becomes a two-argument call. Every
other module is byte-identical.

*(Do NOT size this with `compile()` on the raw test body: it reports 0 delta on
all five, because the raw-body compile does not reproduce the runner's lowering —
the trap this issue's own "Instrument note" section warns about.)*

### Compile-work cost: zero

The pre-scan is an O(nodes) AST walk, the shape that cost #4205's first cut
+21.7% on the #3437 harness compile-work budget. First cut here: **+3,847**
(111,568 → 115,415). Fusing the walk with #2179's `sourceContainsDelete` did
**not** recover it (115,487 → 115,415) — the cost is losing that predicate's
short-circuit, not the extra traversal. Gating name collection on
`ctx.standalone` (the only arm that reads the names) returns host mode to main's
exact traversal: **111,568 — the baseline exactly**.

### Reachability — the population this change can touch

AST scan over all **53,575** corpus files (body + `includes:` harness) for the
full trigger: one identifier that is simultaneously (a) the receiver of a member
delete, (b) arg0 of `Object.defineProperty`/`defineProperties`, and (c) the
receiver of a `hasOwnProperty`/`propertyIsEnumerable` call.

**122 files.** `Object/defineProperty` 68 · `Object/defineProperties` 36 ·
`language/expressions/delete` 5 · `Array/prototype/sort` 4 · 9 others.
104 of the 122 sit inside the control population above; all 122 were **also** run
as an explicit lever set on both arms: **109 → 110 pass, +1 / −0**, same 5
changed modules.

Note the syntactic scan over-approximates the real trigger **~24×** (122
candidates → 5 modules actually changed): it cannot model the static-key
requirement or whether the defineProperty signals were actually recorded. The
byte-hash is the authoritative exposure figure; the scan bounds it.

### Refusal-vacuous-pass at-risk set: EMPTY, by construction

Per `project_hostfree_pass_can_be_vacuous_inject_throw_probe` (second mechanism),
a standalone not-yet-implemented refusal throws, so a test asserting a throw can
pass *because* a member is missing — and implementing it converts the pass to a
failure in the `merge_group`.

`__hasOwnProperty` and `__propertyIsEnumerable` **are** both listed in
`STANDALONE_REFUSED_IMPORT` (`src/codegen/expressions/late-imports.ts` L84-85),
so the hazard is not a priori absent. But they are **also** in
`OBJECT_RUNTIME_HELPER_NAMES`, and `ensureLateImport` checks that set
**first** — `if ((ctx.standalone || ctx.wasi) && OBJECT_RUNTIME_HELPER_NAMES.has(name))
{ ensureObjectRuntime(ctx); return ctx.funcMap.get(name); }` — returning before
`refuseStandaloneObjectImport` is ever reached. In standalone these two always
bind to the native defined function and **cannot refuse**, so no file's current
pass can depend on their refusal throwing.

Confirmed empirically: 0 files flipped to `compile_error` across 2,654, and the
only two compile errors present are identical on both arms.

### Rejected variant, with its numbers

The issue's option 2 (drop `!ctx.standalone` outright) was **not** attempted.
Option 1 was tried first as recommended and yielded the guaranteed +1 with an
exposure of 5 modules; the broad variant would widen exposure to the entire
`(a)+(b)` population (**618 files** by the scan above) to chase the remaining 8
sibling files, and re-open the PR #2177 park class. Recorded as untested rather
than rejected on evidence — a future lane should measure it rather than assume
either way.

### Residue — the other 8 files this issue named

`15.2.3.6-3-{87,91,92,94,95,123}.js`, `15.2.3.5-4-106.js`, `15.2.3.7-5-b-66.js`
did **not** flip. `-123` is the informative one: its module DID change (the gate
fired) but it fails earlier, on `dereferencing a null pointer in
__module_init()`. So the remaining residue in this family is not the const-fold —
it is blocked behind separate defects. The `-87`/`-92` pair the issue expected
from the then-unmerged #4180 branch is already accounted for: #4180 is `done` on
main and both were passing on the BASE arm.
