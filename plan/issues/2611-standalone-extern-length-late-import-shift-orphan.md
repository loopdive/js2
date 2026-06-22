---
id: 2611
title: "standalone: `__extern_length` invalid-Wasm (#2043 late-import index-shift orphan) in async-gen-method destructuring-param defaults"
status: done
sprint: 65
created: 2026-06-22
completed: 2026-06-22
assignee: sendev-flatten
priority: medium
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: class
parent: 2158
goal: standalone-mode
language_feature: destructuring-params, async-generators, late-imports
related: [2043, 2567, 1109]
---

# #2611 — standalone `__extern_length` invalid-Wasm (#2043 late-import index-shift orphan)

Slice of umbrella **#2158**. Second-largest clean root cause in the re-measured
#2158 host-vs-standalone gap (sprint-65 architect re-measurement, 2026-06-22):
~24 % of the `class/dstr` gap. This is the **deeper shift orphan** the umbrella's
"Slice F-1" notes explicitly predicted would surface after the F-1 fix
("the static-method variant surfaces a second shift orphan").

## Problem

`--target standalone` emits **invalid Wasm** for an **async-generator (or
generator) class method whose parameter binds a destructuring pattern with a
default value**, when compiled inside a full-size module (the test262 harness
preamble supplies the import pressure). The validator rejects the module:

```
Binary emit error: Codegen error: local index out of range — 4 (valid: [0, 4))
at function '__extern_length'. This is the late-import index-shift class (#2043):
a captured index went stale across a deferred flushLateImportShifts/
addUnionImports/addStringImports shift, or a map lookup failed and baked
-1/undefined. Re-resolve the index by name AFTER the last shift, or make the
producer refuse loudly.
```

The compiler's own diagnostic names the class precisely: **#2043 late-import
index-shift**.

### Verified repro (needs the full harness preamble)

The minimal `class C { async *m([a,b]=[3,4]) { yield a; } }` compiles fine — the
bug only manifests once the module is large enough that a late import is added
_after_ `__extern_length` is registered. Reproduce via the real wrapped test:

```
test/language/statements/class/dstr/async-gen-meth-dflt-ary-ptrn-rest-id-elision-next-err.js
test/language/statements/class/dstr/async-gen-meth-static-dflt-obj-ptrn-prop-id-get-value-err.js
```

(wrap with `tests/test262-runner.ts` `wrapTest`, compile `target:"standalone"`).
Both reproduce the exact error above on current main.

## Root cause (diagnosis)

`__extern_length` is a **native-built** runtime function (standalone), registered
in `src/codegen/object-runtime.ts` (the `// ── __extern_length …` block, ~line
3196, `registerNative("__extern_length", …)`). It declares 4 entries (param 0 +
locals `any`/`lenF64`/`lenTrunc` = indices 0–3), so "valid [0, 4)" matches — and
yet the decoded body references index **4**. The body itself only uses indices
0–3, so this is not a local-count bug in the source array: it is the #2043
symptom — a later index shift desynced the already-encoded body.

The two prime suspects, both captured at **build time** inside the
`objLengthArm` IIFE:

```ts
const externGetIdx2036 = ctx.funcMap.get("__extern_get")!;
const unboxIdx2036 = ctx.funcMap.get("__unbox_number")!;
// … { op: "call", funcIdx: externGetIdx2036 } / funcIdx: unboxIdx2036 …
```

and `getOrRegisterVecBaseType(ctx)` / `objVecTypeIdx`. These funcIdx/typeIdx are
**baked into `__extern_length`'s body** when it is registered. The
async-generator + destructuring-param-default lowering then adds a **late import**
(`__array_from_iter_n` / `__extern_get_idx` / `__extern_length` itself /
`__get_undefined` — the destructuring-params path is a known late-import adder,
see #2567 / destructuring-params.ts:421 `shiftLateImportIndices`). That shift
moves the defined-function indices, but the shift walk does **not** re-resolve
the indices baked into the already-registered `__extern_length` body (the native
runtime bodies are registered into `ctx.funcs`, not the per-function
`fctx.body`/`savedBodies`/`liveBodies` chain that `shiftLateImportIndices`
walks). The stale baked funcIdx then points at a function with a different
signature/local-frame, and the validator's frame check reports the mismatch as
"local index out of range — 4 at \_\_extern_length".

This is the **same family** as #2567 (destructuring-param default-buffer orphan)
and the umbrella's Slice F-1 (`destructuring-params.ts` outer-body orphan), but
the orphaned body here is a **native runtime function** (`__extern_length`),
registered up-front and not on any fctx chain — so the existing
`liveBodies`/`savedBodies` tracking can't reach it.

## Implementation Plan

### Step 1 — confirm which captured index goes stale (diagnostic)

Instrument the `objLengthArm` / `vecBaseArm` registration in
`object-runtime.ts` (~3196): log `externGetIdx2036`, `unboxIdx2036`,
`vecBaseIdx`, `objVecTypeIdx` at capture time, and at module-finalize log the
final `ctx.funcMap.get("__extern_get")` / `__unbox_number`. If they differ, the
baked funcIdx is the orphan. (The error's "(#2043)" tag + the
`flushLateImportShifts` hint already point here.) Repro file:
`async-gen-meth-dflt-ary-ptrn-rest-id-elision-next-err.js` wrapped.

### Step 2 — fix: re-resolve native-runtime body indices after the last shift

Two viable approaches; pick per how the registration is structured:

**(A) Resolve-by-name late (preferred, matches the error's own advice).**
Make `__extern_length` (and any sibling native body that bakes a
`ctx.funcMap.get(...)` funcIdx — `__extern_get_idx`, `__getOwnPropertyDescriptor`,
the #2042 reflection helpers) defer its `call` funcIdx resolution to **after**
all late imports are flushed. The cleanest mechanism already in the codebase is
`ensureLateImport` (which participates in the shift bookkeeping) rather than a
raw `ctx.funcMap.get(...)` captured into the body array. Where the callee is a
native runtime func (not an import), register the native body so its
cross-references are patched by the same finalize pass that shifts imports — i.e.
add the native runtime bodies' instruction arrays to the set that
`shiftLateImportIndices` / the module-finalize shift walks (the symmetric fix to
#2567's `liveBodies` tracking, applied to `ctx.funcs[*].body` for native
runtime functions).

**(B) Order the registration so no shift can follow.** Ensure
`__extern_length` and friends are registered (and their callee indices resolved)
**after** the destructuring-params / async-generator late imports are added, so
nothing shifts their baked indices. This is more fragile (any future late adder
re-breaks it) — prefer (A).

Whichever path: the invariant to restore is _every funcIdx/typeIdx baked into a
native runtime body must be re-resolved (or shift-tracked) across the final
import shift_, exactly as the per-function fctx bodies already are.

### Step 3 — make the producer refuse loudly if it can't (defense)

Per the error text's last clause: if a native body must bake an index that could
shift, and approach (A) is not wired for that callee, the registration should
assert the funcIdx is still valid at finalize (or route through a shift-tracked
mechanism) rather than emit a body the validator later rejects. This converts a
future regression of this class from invalid-Wasm into a loud compile error.

### Files

- `src/codegen/object-runtime.ts` — `__extern_length` registration (~3196) and
  the shared native-runtime-body shift bookkeeping. Check siblings
  `__extern_get_idx` (~3322) and the #2042 reflection helpers (~5106, ~5358) for
  the same baked-funcIdx pattern; fix them together if they share the orphan.
- `src/codegen/expressions/late-imports.ts` — `shiftLateImportIndices` (the walk
  that must also cover native runtime bodies, if approach (A) extends it).
- `src/codegen/destructuring-params.ts` — the late-import adder that triggers the
  shift (no change expected, but it is the trigger; cross-reference #2567 / F-1
  for the body-orphan tracking pattern to mirror).

### Edge cases

- Generator (non-async) class method with the same default-destructuring param —
  same trigger; verify it is fixed too (sample shows `gen-meth-*` variants).
- Static vs instance method (`*-static-dflt-*`) — both reproduce; the fix must
  cover both (the static variant was the umbrella's predicted "second orphan").
- Nested patterns (`{x:[y]}=…`, `[[y]]=…`) and rest elements
  (`*-ptrn-rest-id-*`) — the highest import pressure; include in the test.
- Must NOT change gc/host output: `objArrayLikeArms`/`objVec` arms are already
  `ctx.standalone`-gated; the fix is to index bookkeeping, observationally inert
  for host (host's `__extern_length` is a JS import, not a native body).

### Failing test262 paths (sample)

- `test/language/statements/class/dstr/async-gen-meth-dflt-ary-ptrn-rest-id-elision-next-err.js`
- `test/language/statements/class/dstr/async-gen-meth-static-dflt-obj-ptrn-prop-id-get-value-err.js`
- `test/language/expressions/class/dstr/async-gen-meth-dflt-obj-ptrn-prop-obj-value-null.js`
- `test/language/statements/class/dstr/async-gen-meth-dflt-ary-init-iter-get-err.js`
- `test/language/statements/class/dstr/async-gen-meth-static-dflt-ary-ptrn-elem-{ary,obj}-val-null.js`

### Estimated rows

~24 % of the `class/dstr` host-vs-standalone gap. Stratified samples →
**~60–90 rows** (the async-gen-meth + gen-meth default-destructuring families,
across both `class/dstr` trees). Several overlap with #2610 (iterator-error-path
tests need BOTH the Symbol fold AND this shift fix to pass at runtime). Standalone
invalid-Wasm → valid-Wasm uplift is the direct win; full pass also needs the
async-generator runtime path to be conformant (mostly landed; see #2174).

### Test to add

`tests/issue-2611-extern-length-shift-async-gen-dstr-standalone.test.ts` —
compile (`WebAssembly.compile` / validate) the wrapped repro files above under
`target:"standalone"` and assert NO `local index out of range` / invalid-binary
error. Mirror `tests/issue-2158-dstr-param-default-nested-pattern.test.ts` (the
Slice F-1 validate-only regression guard).

## Resolution (2026-06-22, sendev-flatten)

**Verified root cause — corrects the spec's hypothesis.** The diagnostic names
the #2043 *funcIdx-call-shift* class, but the actual mechanism is a **name↔body
desync from an UNFLUSHED deferred late-import shift that leaked past later
function registrations** — confirmed via instrumented build + emitted-body dump,
not the spec's `objLengthArm`-captured `externGetIdx2036` theory:

1. The error `local index out of range — 4 at __extern_length` is a body-content
   corruption, not a call-target shift: the dumped `__extern_length` body was
   literally `__extern_get_idx`'s body (it used local 4 / `i32.trunc_sat_f64_s` /
   `array.get` / `ref.null.extern` returns), spliced into the wrong function.

2. `tryEmitInlineDynamicCall` (`src/codegen/expressions/calls.ts`) adds the
   `__get_undefined` arity-pad late import via `ensureLateImport` — which DEFERS
   the index shift (records `ctx.pendingLateImportShift`, bumps `numImportFuncs`)
   — but, unlike every sibling late-import call site, **never flushed it**. The
   async-generator class method's destructuring-param default is one path that
   reaches this site (other adders `__array_from_iter_n` are flushed by their
   own sites; `__get_undefined` here was the leak).

3. The dangling pending shift then leaked past further function registrations.
   `__module_init` (and any function registered after the import) got funcIdx =
   post-import `numImportFuncs + arrayPos` — already correct. But the native
   runtime helpers registered BEFORE the import (`__extern_length`,
   `__extern_get_idx`, …) had stale-low `funcMap` entries. Instrumentation:
   `funcMap{EL=127,EGI=128}` while `arraySlot{EL=109→128, EGI=110→129}` and
   `pendingLateImportShift={importsBefore:18}` — stale-low by exactly the
   unflushed `added`.

4. At finalize, `fillExternGetIdxVecArms` resolved
   `mod.functions[funcMap.get("__extern_get_idx") - numImportFuncs] =
   mod.functions[128-19] = mod.functions[109]` = `__extern_length`, and spliced
   `__extern_get_idx`'s vec arms into `__extern_length`'s body → invalid Wasm.

**Why flushing at finalize is WRONG (rejected alternative).** The deferred shift
is HALF-applied by finalize: `startFuncIdx` and post-import funcMap entries are
already at post-shift values while pre-import native helpers are stale. Running
the full `shiftLateImportIndices` at finalize re-bumps `startFuncIdx` → `invalid
start function: non-zero parameter or return count` (verified: startFuncIdx 201
→ wrongly 202; `__module_init` was already correctly at funcIdx 201). The shift
must be flushed at the leak source, before any further function is registered.

**Fix (1 line + comment, `src/codegen/expressions/calls.ts`).** After the
`__get_undefined` add in `tryEmitInlineDynamicCall`, flush immediately:
`if (undefinedIdx !== undefined) flushLateImportShifts(ctx, fctx);`. This repairs
ONLY the genuinely-stale pre-import indices (no later function exists yet to be
over-shifted) and keeps the index space self-consistent through finalize —
mirroring `emitUndefined`, which already flushes after the same
`ensureGetUndefined` add. Idempotent no-op when nothing pends.

**Validation.** Repro (3 wrapped test262 files) now emit valid Wasm. New
regression test `tests/issue-2611-extern-length-shift-async-gen-dstr-standalone.test.ts`
(7 tests: standalone validate for async-gen/static/gen/array-rest dstr defaults +
a `startFuncIdx` over-shift guard + host-runtime correctness). Regression-neutral:
the #820/#2158/#2567/#2512/#2174/#2542/#2029 clusters pass; the equivalence
async/generator/dstr/call subset passes (141/144 — the 3 tagged-template-cache
failures + the 14 #820b/#820m failures are PRE-EXISTING on `origin/main`,
A/B-confirmed, unrelated to this fix). tsc / prettier / biome / coercion-sites
gates clean.
