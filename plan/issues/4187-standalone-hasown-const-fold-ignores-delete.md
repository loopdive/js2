---
id: 4187
title: "standalone: hasOwnProperty const-fold ignores runtime delete — the #2726 routing gate's standalone exclusion has outlived its substrate gap"
status: ready
sprint: current
priority: medium
horizon: s
feasibility: medium
goal: standalone-gap
assignee:
created: 2026-08-06
found-by: ttraenkler/W9-descriptor-proto-residue
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
