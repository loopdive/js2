---
id: 2520
title: "Ambient global-function host-import warning flood under --target wasi (collapse to a --verbose summary)"
status: done
sprint: 64
created: 2026-06-19
updated: 2026-06-20
completed: 2026-06-20
# 2026-06-20: PR #1787 −6 regression fix — lib-file gate scoped to wasi/standalone
# 2026-06-20: PR #1787 −84 standalone-floor fix — DCE shared-array double-remap
#   (eliminateDeadImports remapped a shared rangeThrow template twice → invalid
#   Wasm on 132/133 built-ins/DataView). Root-cause fix in dead-elimination.ts;
#   see tests/issue-2520-dce-shared-array-double-remap.test.ts.
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bug
area: codegen
language_feature: host-imports
goal: correctness
---

## Regression follow-up (2026-06-20, PR #1787 −6 fix)

The lib-file referenced-names gate (change #1 below) fired for **all targets**,
but the ambient-global flood it cures is a `--target wasi` problem only. Under
the default JS-host (gc) target the gate is a no-op for warnings yet it
**reordered the import/type table** (it runs `addFuncType` a different number of
times during `collectExternDeclarations`). That reordering exposed a latent
late-import index-shift in the array-`join` element-stringify path, producing an
**invalid** binary ("not enough arguments on the stack for call (need 2, got 1)")
for `Array.prototype.join` / `TypedArray.prototype.join` over an array holding an
`undefined`/`null` element, plus `TypedArrayConstructors` HasProperty `inspect`
and `Array.prototype.reduce`/`reduceRight` — a real **−6** test262 regression
(host lane) caught only by the full merge_group shards.

**Fix:** scope the lib-file gate to `ctx.wasi || ctx.standalone` (pass
`libReferencedNames` only then; `undefined` otherwise). The gc lane is now
byte-identical to pre-#2520 (verified: 350 affected+diverse test262 files hash
identically vs main), so zero gc-lane regressions are possible; the wasi
flood-fix is unchanged (gate tests compile `--target wasi` and still pass).
Regression tests: `tests/issue-2520-host-import-gate.test.ts` — new
"gate must not break gc-lane codegen" block asserts those exact patterns compile
to valid binaries. The deeper late-import index-shift remains latent (only the
wasi/standalone path can still reorder the table); a separate hardening of the
shift math is out of scope for this regression fix.

## Regression follow-up #2 (2026-06-20, PR #1787 −84 standalone-floor fix)

After the −6 gc fix above, PR #1787 still breached the #2097 **standalone**
pass-count floor by **−84** (caught by `merge shard reports`, which runs the
floor only on merge_group, not on the PR's own checks). Proven via
`WebAssembly.validate` bisect at 3 heads (origin/main 133/133 valid, #1787 head
0/133 valid, #1711 head 133/133 valid): **132 of the 133 regressed files were
`built-ins/DataView`**, all invalid with
`throw[0] expected type externref, found call of type i64`.

**Root cause — a shared-array double-remap in dead-import elimination, NOT the
late-import shift.** `eliminateDeadImports` (`src/codegen/dead-elimination.ts`)
removes a now-dead host import and chains every funcIdx/typeIdx down via
`remapFuncIdxInBody` / `remapTypeIdxInBody`, which drive `walkInstructions`. That
walker visits an instruction once **per occurrence** in the body tree. The native
DataView setter's §24.2.1 bounds-RangeError template (`rangeThrow` in
`emitDataViewAccessor`) is the **same `Instr[]` object** spliced into both the
ToIndex `if.then` (step 4) and the bounds `if.then` (step 8). So when #1787's
gating made a host import dead (newly triggering the remap), the shared template's
`call __new_RangeError` was chain-remapped **twice** (53→52 then 52→51), landing
on `__to_bigint` (an i64-returning helper) → V8 rejects the throw operand type.
The bug only manifested when DCE actually drops an import — which #1787's
host-import gating newly caused — so it was latent on main.

**Fix:** dedupe shared instruction objects in both DCE remappers via a
`WeakSet<Instr>` so an aliased operand is chain-remapped exactly once, regardless
of how many tree positions reference it. This closes the documented #1302
shared-array double-shift hazard at the **sink** (the remapper) rather than
per-producer — prior instances were worked around producer-side by never sharing
instruction objects (`iterator-native` `buildVecArm`, `json-codec` `cloneBody`).

**Validation:** the 133 affected `built-ins/DataView` files now 133/133
`WebAssembly.validate` (0 throw-i64); +18 additional DataView
`return-values`/`set-values` files repaired (same bug class — invalid on main,
valid here); zero new regressions (the `issue-2036`, `arraybuffer-dataview`, and
`issue-1302` lodash test failures all reproduce identically on origin/main, so
they are pre-existing, not introduced). Regression test:
`tests/issue-2520-dce-shared-array-double-remap.test.ts` reproduces the exact
shape (poisoned-value DataView setter inside a throwing closure + a
dead-eliminated user ctor) and fails without the fix, passes with it.

## Resolution (2026-06-20)

Fixed by **two complementary changes**: a root-cause gate that stops registering
unreferenced ambient globals, plus a CLI summary for whatever genuinely remains.

### 1. Referenced-names gate (root fix) — `src/codegen/index.ts`

The lib-file `declare function` scan (`collectExternDeclarations` over
`lib.*.d.ts`) registered an `env.<name>` host import for **every** ambient global
function regardless of use — built mode-agnostically for JS-host mode, then
register-then-dropped under strict mode. Now gated by
`collectReferencedGlobalNames`: a name only registers if the user source has a
genuine reference that **resolves (via the checker) to an ambient declaration**
(a lib `declare function`, or a preprocessImports-injected ambient stub) — not a
local variable / parameter / property of the same name, and not a polyfilled
global (a `function` *with a body*, which needs no import). This is symbol-based,
so a local `let stop = …` no longer pulls in the DOM `window.stop` global, and
`obj.close` no longer pulls in `close`.

Effect: a `Uint8Array`-only program drops from ~60 attempted imports to ~3
(`global_Uint8Array`/`global_ArrayBuffer`, from the separate AMBIENT_BUILTIN_CTORS
path); the native-messaging example from ~60 to ~6. Gated only on the **lib-file**
call sites; user-file `declare function` stubs (preprocessImports) still always
register. Test: `tests/issue-2520-host-import-gate.test.ts`.

### 2. CLI summary collapse — `src/cli.ts`

For whatever still registers-and-drops, the per-import "not on the dual-mode
allowlist" warnings are redundant: they fire for *every dropped* import, then the
import is dead-code-eliminated and never reaches the `.wasm`; the authoritative
check is the emit-time scan (`assertNoLeakedHostImports`, severity `error`) that
fires only if an import actually *survives*. So the CLI collapses them to a
one-line summary by default; `--verbose`/`-v` restores the full listing. The
allowlist *budget* test governs the allowlist's size (not these warnings), so it
is unaffected. Test: `tests/issue-2520-host-import-warning-verbosity.test.ts`.

### 3. Builtin-constructor value-use gate — `src/codegen/index.ts`

The `AMBIENT_BUILTIN_CTORS` path registered `global_<Ctor>` (the host constructor
*object*, for identity uses like `x.constructor === Uint8Array`) on *any*
reference to the name — including `new Uint8Array(4)`, `Uint8Array.from(...)`, and
`: Uint8Array` type annotations, all of which hit native fast paths and need no
host object. Now gated on a **value use** (`isBareValueUse`): not the
`new X(...)` / `X(...)` callee, not the property NAME (`obj.X`), not a
type-reference position. So `new Uint8Array(4)` no longer registers
`global_Uint8Array`, while `x.constructor === Uint8Array` still does. The
native-messaging example now compiles with **zero** host-import warnings. Test
cases in `tests/issue-2520-host-import-gate.test.ts`.

**Regression follow-up (2026-06-20, PR #1787 −50 fix):** the first cut of this
gate also excluded the property-access **receiver** (`p.expression === id`), on
the assumption that `X.member` always hits a native fast path. That is only true
for the *intercepted* static members (`Date.now`, `Array.isArray`,
`Uint8Array.from`, …); for any **non-intercepted** static prop —
`Date.hasOwnProperty("prototype")`, `Date.parse`, `Date.UTC`, `Date.length`,
`X.constructor`, `X.prototype` — the bare receiver `X` must resolve to the host
constructor object, which needs `global_X`. Excluding the receiver dropped that
global, so the receiver resolved to `ref.null.extern` and
`null.hasOwnProperty(...)` returned false. This silently regressed test262 by
−50 (e.g. `built-ins/Date/S15.9.4_A1..A5`). The fix narrows the exclusion to
the property NAME only (`p.name === id`); a property-access receiver again
counts as a value use. The intercepted-member globals it now also registers are
harmless unused imports (the fast path resolves at the property-access site,
before identifier resolution — see the comment at the `AMBIENT_BUILTIN_CTORS`
loop). Regression tests added to `tests/issue-2520-host-import-gate.test.ts`
(receiver-registers + property-name-does-not).

Out of scope: a web-vs-node target/environment model (`window.stop` makes no
sense in a node host; auto-provide Node `process`/`Buffer` types) — tracked in
#2523. Original analysis kept below for reference.

## Problem

Compiling any source that touches a single lib global (e.g. `Uint8Array`,
`DataView`, `ArrayBuffer`, `Date`, `Map`, or a regex literal) injects a host
import (`env.<name>`) for the **entire** ambient global-function surface of
`lib.es5` + `lib.dom` — `eval`, `isNaN`, `alert`, `scroll`, `fetch`,
`matchMedia`, `createImageBitmap`, `postMessage`, `setTimeout`, … — regardless
of whether the user code references any of them.

Under `--target wasi` / `--no-host-imports` strict mode each unreferenced import
trips the dual-mode allowlist warning, producing a wall of ~60 warnings on an
otherwise trivial program. In JS-host mode they are ~60 spurious imports the
host environment must satisfy, and they bloat the import section and `.wat`.

Reported by an external user (guest271314) compiling the Native Messaging host
example as a `.js` file — see loopdive/js2#389. Distinct from the `.js` build
fix in #2195 (#1717); this is import over-emission, not a build error.

## Reproduction (verified on main `19612a24`)

```js
// flood.js — entire body
function main() {
  const a = new Uint8Array(4);
  a[0] = 1;
  return a[0];
}
```

```
npx tsx src/cli.ts flood.js --target wasi -o .
# → 60 warnings: Host import "env.eval" / "env.alert" / "env.fetch" /
#   "env.scroll" / "env.matchMedia" / "env.createImageBitmap" / ...
# The file references NONE of these names.
```

## Root cause

`src/codegen/index.ts`:

1. `sourceUsesLibGlobals()` returns true when the file references any name in
   `LIB_GLOBALS` (includes `Uint8Array`, `DataView`, `ArrayBuffer`, `Date`,
   `Map`, `Error`, regex literals, …).
2. That gates a scan running `collectExternDeclarations()` over the lib
   `lib.*.d.ts` source files (`index.ts:1076` single-file path, `index.ts:5173`
   multi-file path).
3. Inside `collectExternDeclarations`, the `declare function … (no body)` arm
   (`index.ts:~11124`) registers an `env.<name>` import for **every** ambient
   `declare function` in that lib file, gated only by `!ctx.funcMap.has(name)` —
   with **no check that the name is referenced in user source**.

The sibling `collectDeclaredGlobals()` (for `declare const`/DOM classes, right
above) **does** gate on a `referencedNames` set ("only register used globals").
The `declare function` path is missing that exact gate, so one benign lib-global
use drags in the whole ambient global-function surface.

## Fix

Add the same referenced-names gate to the lib-file `declare function` emission:
register `env.<name>` only for ambient functions actually referenced as
identifiers in user source.

- Gate **only** the lib-file invocations of `collectExternDeclarations`
  (`index.ts:1076`, `:5173`).
- Do **not** gate the user-file call (`index.ts:1062`): there the bodiless
  `declare function` stubs come from `preprocessImports` for unresolved external
  imports and must always register so call sites pass args correctly.

Mechanically mirror `collectDeclaredGlobals`: collect `referencedNames` from the
user source once, pass it into `collectExternDeclarations` (or a lib-specific
variant), and skip `addImport` for any `declare function` whose name is not in
the set. Real `setTimeout`/`fetch`/etc. usage still resolves because the name
appears as an identifier in user source.

## Acceptance criteria

- The reproduction above (`new Uint8Array(4)` only) emits **0** `env.*`
  ambient global-function imports under `--target wasi`.
- A file that genuinely calls e.g. `setTimeout(...)` still registers
  `env.setTimeout` (non-WASI) / behaves as before.
- Regression test asserting the `Uint8Array`-only case produces zero ambient
  global-function host imports.

## Follow-up

`referencedNames` collects property-access names too, so `obj.close` would still
spuriously match `env.close`. Tracked separately in #2509 (lower priority).
