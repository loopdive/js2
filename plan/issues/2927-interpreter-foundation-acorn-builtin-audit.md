---
id: 2927
title: "Interpreter foundation: Acorn-via-js2wasm runtime parser + generic-built-in audit"
status: ready
created: 2026-07-02
updated: 2026-07-16
priority: medium
horizon: l
feasibility: hard
model: fable
reasoning_effort: high
task_type: feature
area: runtime
language_feature: eval
goal: runtime-eval
sprint: current
parent: 1584
depends_on: [1058, 1710, 2527]
related: [1584, 1715, 1066]
---

# #2927 — Interpreter foundation: Acorn-via-js2wasm + generic-built-in audit

Slice **D** of the runtime-eval roadmap
([docs/architecture/runtime-eval-interpreter.md](../../docs/architecture/runtime-eval-interpreter.md), §6-D, §4.2).
The prerequisite for the standalone bytecode interpreter (#2928): a runtime
parser and a complete generic built-in surface. No bytecode/dispatch yet.

## Problem

The standalone interpreter needs two things that do not exist yet:

1. **A runtime parser.** `eval(dynamicString)` / `new Function(dynamicBody)` need
   to parse ECMAScript at **runtime**, standalone (no host). The build-time
   TypeScript parser is unavailable inside the emitted module.
2. **A generic call surface for every built-in.** The AOT path calls
   type-specialized built-in wrappers (`add_int_int`, typed-array fast paths).
   The interpreter, operating on `any`-typed operands, needs a **generic
   `(any, …) → any` sibling** for each so its future `CallBuiltin` opcode
   (#2928) has a target.

## Part 1 — Acorn compiled via js2wasm (runtime parser)

- Compile Acorn (MIT, ES2024-current, ESTree AST) through js2wasm, building on
  the **#1710 dogfood harness** (already validates + diffs compiled-Acorn AST
  vs node-acorn). Restrict Acorn to **runtime use for dynamic JS source only** —
  the build-time pipeline keeps using the TS parser (eval is always JS, never
  TS).
- **Optional linking (size floor).** A module the static analyzer proves has no
  `eval`/`new Function` must NOT pay Acorn's size cost. Package Acorn +
  interpreter as a **separately-compiled module linked on demand via #2527**
  (core-wasm canonical rec-group linking — shares the `$Object` substrate
  zero-copy; Phase-0 spike is GREEN). This preserves the ~0.2 KB no-eval floor.
- Every Acorn-compilation gap surfaced is filed as a child issue under #1058
  (self-host). Tackle Acorn compilation **first** so gaps surface early.

## Part 2 — generic built-in audit

- Enumerate every specialized built-in the AOT path emits; for each, ensure a
  generic `(any, …) → any` entry exists (or add one) that operates on the boxed
  representation with full runtime type dispatch.
- These generic forms are **shared work** with standalone AOT conformance (a
  dynamically-typed AOT call site needs the same generic entry), so this audit
  is not interpreter-only overhead.
- Produce a coverage report: `builtin → {specialized: y/n, generic: y/n}`, with
  gaps as a checklist that gates #2928 sign-off.

## Value-representation note (the crux — free by construction)

Because the interpreter is compiled by js2wasm (strategy 2a), its `JSValue`
**is** the AOT `anyref`/`$Object` substrate — no marshalling, `ref.eq` identity
preserved across the AOT↔interpreter boundary (roadmap §4.2). This audit is the
_only_ real bridge work, and it is completeness, not conversion.

## Acceptance criteria

- [ ] Acorn compiles through js2wasm with no manual source edits; the #1710
      harness reports AST parity on a representative ES2024 corpus.
- [ ] A `parser` artifact is produced and links on demand via #2527; a no-eval
      module's size stays within 5% of the current floor.
- [ ] Generic-built-in coverage report committed; every gap has a tracking item.
- [ ] Acorn-compilation gap issues filed under #1058 where found.

## Notes

Consumes the boxed-any substrate — land after the corresponding value-rep
substrate fixes, don't race them (roadmap §8). Umbrella: #1584. Goal:
`runtime-eval`. This is #1584 scope items 1 + 9, extracted so the parser +
library land and validate before the VM core (#2928).

---

## Probe results — Acorn-via-js2wasm self-compile (dev-2927, 2026-07-02)

Ran the committed #1710 dogfood harness (`tests/dogfood/acorn-corpus.mjs`,
pinned `acorn@8.16.0`, `skipSemanticDiagnostics: true`) + a direct throw-payload
probe against current `main` (`c26fc059a3422`).

### Path "Acorn source → valid Wasm that parses hello-world" — honest %

| Stage                                                         | Status on current `main`                                           |
| ------------------------------------------------------------- | ------------------------------------------------------------------ |
| Acorn source → **compiles** through js2wasm (no manual edits) | ✅ 100% — `success:true`                                           |
| → **valid Wasm** (`WebAssembly.compile` / instantiate)        | ✅ 100% — 651 KB binary validates, exposes callable `parse`        |
| → `parse(<hello-world>)` **returns a correct AST**            | ❌ **0% on current main** — throws for **every** input, incl. `""` |

**Bottom line: ~66% of the way** (compile + validate work; runtime parsing is
regressed to 0%). This is a **regression**, not a greenfield gap: two days ago
(harness re-run 2026-06-30, per `tests/dogfood/CORPUS-GAP-MAP.md`) the same
harness parsed **13/22 corpus inputs** to structural parity (equal±quirks). The
regression bisects cleanly to **`4173306a9b29`** (PR #2432 / #2849) — filed as
**#2937** (host-mode `$Object`-hash poison → uniform null-deref at parser setup).

With #2937 fixed, the path returns to **~59% structural parity** (13/22 inputs
equal modulo cosmetic quirks), with the remaining ~41% being the already-filed
host-marshalling / parser gaps below.

### Catalogue of failures (all distinct root causes)

| Root cause                                                                                 | Issue     | Status                              | New?    |
| ------------------------------------------------------------------------------------------ | --------- | ----------------------------------- | ------- |
| **Host `$Object`-hash poison → uniform parse null-deref** (parser setup; masks all others) | **#2937** | **filed here, sprint: current, P1** | **NEW** |
| regex char-class `[…]`/`\d` + named-group `(?<n>…)` validation-throws                      | #2850     | prior art, sprint: current, ready   | no      |
| self-parse: division-after-number + regex-group throw                                      | #2853     | prior art, sprint: current, ready   | no      |
| `params[]` (arrow/fn-expr, incl. destructure/default/rest) marshalled blank                | #2841     | prior art, in-progress              | no      |
| `TemplateElement` quasis marshalled blank                                                  | #2851     | prior art, ready                    | no      |
| `SequenceExpression` children marshalled blank                                             | #2852     | prior art, ready                    | no      |
| BigInt literal → f64 corruption                                                            | #2846     | prior art, ready                    | no      |
| cosmetic marshalling quirks (`sourceFile:null`, bool→i32)                                  | #2847     | prior art, ready (cosmetic)         | no      |

**Only one NEW distinct root cause found (#2937).** All input-specific gaps were
already filed by prior sessions; per reground I did **not** re-file them.
Critically, **#2850 / #2853 are currently unobservable** — #2937 kills the parser
at setup, before any regex/division logic runs — so #2937 gates their
re-verification and must land first. I did **not** fix #2850/#2853 in this probe
for the same reason (they cannot be exercised on current main).

### Why I did not fix #2937 inline

#2937 is a deep `$Object`-representation interaction (needs #2849/#2584 context);
a blind revert (re-gate to `ctx.standalone`) fixes Acorn but reintroduces the
#2849 host bug and breaks `tests/issue-2849.test.ts`. Seven reduced shapes did
not reproduce, so there is no minimal repro yet. This is an **escalation + focused
follow-up**, not a small/safe inline fix. See #2937 for the fix-direction
analysis and the recommended reduction step (instrument the null-guard throw
site with a per-site-unique message).

### Harness-measures-host-boundary caveat (important for strategy 2a)

The #1710/#1712 corpus reads the AST **across the host boundary** via
`wrapExports`, so it conflates (a) real parser-correctness bugs (#2850/#2853/
#2846) with (b) host-marshalling losses (#2841/#2851/#2852/#2847) that are
**irrelevant to the self-compiled interpreter** — under strategy 2(a) the
bytecode emitter consumes the AST **in-Wasm** via WasmGC struct access, never
through `wrapExports`. **Recommended #2928-prep artifact:** an _in-Wasm_ AST
consumer probe — a small TS harness compiled alongside Acorn that calls `parse`
**and walks the resulting AST inside Wasm**, returning a scalar (node count / a
specific field). That isolates true parser bugs from marshalling artifacts and is
the correct fidelity metric for the interpreter. (Blocked on #2937.)

### IR front-end alignment (project-lead north star)

The interpreter's compiled substrate should assume the **IR front-end** ("everything
through the IR, backends are the only fork"), not the legacy AST→Wasm path. Acorn
currently compiles via the legacy path (with IR fallbacks); the dispatch loop +
bytecode emitter (#2928) should be authored to compile cleanly through IR. Acorn
self-compilation is therefore also an **IR-adoption stress test** (surfaced gaps
file under #1058 / #2855), and the built-in audit below should be read as "what
the IR-lowered interpreter can call generically".

---

## Generic built-in audit (Part 2)

**Question:** the interpreter's future `CallBuiltin(name, recv: any, args: any[])`
(#2928) operates on **boxed-`any`** operands. Which built-ins can already be
invoked that way, and which are compile-time-type-specialized only?

**Dispatch surfaces found (current `main`):**

- **Host mode** — `__extern_method_call(recv, name, argsVec)` in `src/runtime.ts`
  is a **fully generic** JS bridge (resolves + calls the real JS method on any
  receiver). Complete, but **host-only** (traps standalone) → serves an
  interpreter _Tier-1_ only, not the 2(a) standalone goal.
- **Standalone** — native `__extern_method_call` in `src/codegen/object-runtime.ts`
  (#1888 Slice 2): open-`$Object` receivers resolve `name` via `__extern_get`
  (own + prototype walk) and invoke through the `__apply_closure` arity bridge
  (`__call_fn_method_0..4`). **Non-`$Object` brand arms (String / Array-vec /
  Map / Set built-in prototype methods on a genuinely-`any` receiver) are stubs
  that return `undefined`.**
- **`__call_m_<name>_<arity>` / `_vararg`** (`src/codegen/closed-method-dispatch.ts`,
  #2151): per-method-name type-switch dispatchers over **user closed
  object-literal** structs — NOT built-in prototypes. Standalone-gated.
- **`__get_builtin(name)`** (#2863): resolves a built-in **global/function** by
  name to a callable externref, standalone.
- **`__str_*` / `__vec_*` / `__arr_*`**: type-**specialized** helpers, emitted
  when the receiver type is statically known (String / Array / TypedArray).

**Coverage table (generic `(any,…)→any` callability for the standalone interpreter):**

| Built-in family                                                                | Specialized (AOT, static type)?         | Generic `(any,…)→any` today?                                                                     | What's missing for `CallBuiltin`                                                                                                  |
| ------------------------------------------------------------------------------ | --------------------------------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| User object-literal methods (on `$Object`)                                     | n/a                                     | ✅ standalone via `__extern_method_call` → `__extern_get` → `__apply_closure` (arity 0–4)        | **args not passed**: caller `emitWrapperDynamicMethodCall` gates `wantArgs` off for standalone/wasi; arity >4; keyed-by-name only |
| `Array.prototype.*` (map/filter/push/slice/indexOf/…)                          | ✅ `__vec_*`/`__arr_*` (typed receiver) | ⚠️ brand arm is a **stub → undefined**; partial only via `__call_m_*` for closed-literal methods | generic vec brand arm in `__extern_method_call`: type-switch `ref.test $Vec` → route to `__vec_*` with boxed args                 |
| `String.prototype.*` (slice/charAt/indexOf/split/replace/…)                    | ✅ `__str_*` (native string)            | ⚠️ brand arm **stub → undefined**                                                                | generic string brand arm → `__str_*` over `ref $NativeString` with boxed args                                                     |
| `Map`/`Set`/`WeakMap` methods (get/set/has/add/…)                              | ✅ typed                                | ⚠️ brand arm **stub → undefined**                                                                | generic Map/Set brand arms                                                                                                        |
| `Object.*` (keys/values/entries/assign/GOPD/GOPN/freeze)                       | ✅ typed + `__extern_*`                 | ✅ mostly generic (open-`$Object` path)                                                          | completeness pass; some standalone (`groupBy` via #2863)                                                                          |
| Global functions (`parseInt`/`parseFloat`/`isNaN`/`String`/`Number`/`Boolean`) | ✅ imports                              | ✅ resolvable via `__get_builtin` standalone                                                     | wire `__get_builtin` result into a generic `__apply_closure` call w/ boxed args                                                   |
| `Math.*`, `JSON.*` (namespace statics)                                         | ✅ specialized                          | ⚠️ via `__get_builtin` for the namespace object; per-method generic dispatch untested            | generic static-method dispatch (namespace + method name)                                                                          |
| Number/String/Boolean **wrapper** proto (via boxed primitive)                  | ✅                                      | ⚠️ depends on the boxed-primitive read substrate (memory `reference_1629b…`)                     | boxed-primitive → brand classification in the generic dispatcher                                                                  |
| Arithmetic / operators (`+ - * / %`, `<` …)                                    | ✅ `add_int_int` etc. (typed)           | ⚠️ generic `(any,any)→any` `__to_primitive`/toNumber arms partial (#2358/#2873)                  | complete the generic operator arms (roadmap §4.2 completeness)                                                                    |

**Headline gap for #2928:** standalone has a **generic dispatcher skeleton**
(`__extern_method_call` open-`$Object` path + `__get_builtin` + the #2151 family)
but the **non-`$Object` brand arms are unimplemented stubs**, and the caller does
**not pass args** to the generic path in standalone. The interpreter's
`CallBuiltin` needs:

1. **Brand-arm completion** in the standalone `__extern_method_call` (or a new
   sibling): type-switch the boxed receiver (`ref.test` $Vec / $NativeString /
   $Map / $Set / boxed-number) and route to the existing specialized `__str_*` /
   `__vec_*` helpers with **boxed args**. This is the #2151 "Slice 4 brand arms"
   made real, and is **shared work** with standalone AOT any-receiver dispatch —
   not interpreter-only overhead (roadmap §4.2).
2. **Args on the standalone generic path**: grow the `$ObjVec` args builder in
   `emitWrapperDynamicMethodCall` for standalone/wasi (currently empty-args only)
   and lift the arity-4 ceiling on `__apply_closure`/`__call_fn_method_N`.
3. **A unified `CallBuiltin(name, recv, argsVec)` entry** (the standalone analog
   of host `__extern_method_call`) the bytecode emitter targets — layered over
   1+2, keyed by method name, boxed-`any` in/out.

These three are the concrete #2928 prerequisites this audit gates; each maps to
existing infra (#2151 dispatchers, #2863 `__get_builtin`, `__str_*`/`__vec_*`
helpers) rather than net-new machinery.

---

## Generic built-in audit — Part 2 refinement + first fix (sr-interp, 2026-07-03)

Empirically re-measured the "generic `(any,…)→any` callability" surface on
current `origin/main` by compiling genuinely-`any`-receiver built-in method
calls (param typed `any`, so the compiler cannot statically resolve the brand)
and inspecting the **declared Wasm function imports** of the emitted module. This
materially corrects the coverage table above.

### Methodology correction — `standalone: true` (option) ≠ host-free

The earlier probes used the `{ standalone: true }` compile **option**, which is a
**hybrid** mode that still permits `env.*` host imports (the object runtime is
host-backed: `env.__extern_get`, `env.__extern_method_call`, …). The **truly
host-free** path is `--target standalone` / `--target wasi` (the native runtime,
0 function imports). Measuring host-freeness under the _option_ conflates a real
host dependency with a satisfied JS bridge. **All findings below use `target:
"standalone"`** and assert the function-import set directly
(`WebAssembly.Module.imports`).

### Measured host-free status of any-receiver built-in calls (`target: standalone`)

| Any-receiver call                                                    | Host-free (0 fn-imports)? | Correct value?       | Note                                                                            |
| -------------------------------------------------------------------- | ------------------------- | -------------------- | ------------------------------------------------------------------------------- |
| `String.prototype.*` (toUpperCase/indexOf/charCodeAt/concat/slice/…) | ✅                        | ✅                   | resolved inline/native — **does NOT use the `__extern_method_call` brand stub** |
| `Array.prototype` non-callback (indexOf/lastIndexOf/includes)        | ✅                        | ✅                   | #2583 `$__vec_base` search arm                                                  |
| `Array.prototype.push` / `.pop`                                      | ✅                        | ❌→✅ **FIXED here** | was host-free but **silently wrong** (see below)                                |
| object-literal methods (`o.m()` / `o.m(a)`)                          | ✅                        | ✅                   | #2151 closed-method dispatch                                                    |
| `Array.prototype` **callback** methods (map/filter/forEach/reduce)   | ❌                        | (host)               | emits `env.__make_callback` — **GAP**                                           |
| `Map.prototype` (get/set) on `any`                                   | ❌                        | (host)               | emits `env.WeakMap_get` / `env.WeakMap_set` — **GAP**                           |
| `Set.prototype` (has/add) on `any`                                   | ❌                        | (host)               | emits `env.WeakMap_has` / `env.Set_add` — **GAP**                               |

**Key correction to the coverage table above:** the String/Array brand arms are
**NOT** "stub → undefined" in practice — genuinely-`any` String and non-callback
Array methods already run **host-free and correct** via inline/native paths (they
never reach the native `__extern_method_call` non-`$Object` `else` arm). The real
host-free gaps for the #2928 interpreter's `CallBuiltin` are narrower and more
specific: **Map/Set methods** and **Array callback methods** on an `any` receiver
still emit `env.*` host imports.

### Fix landed here — native-vec `.push`/`.pop` on `any` (host-free data-loss bug)

The one **reachable, host-free, silently-WRONG** case found: `--target standalone`
`const a:any=[1,2]; a.push(3)` returned **0**, left `a.length===2`, and dropped
the element (`a[2]===0`); `a.pop()` returned **0**. Host mode was correct (3).

Root cause: the standalone any-receiver method-call-with-args path (#2151) routes
`push`/`pop` through `__call_m_push_1` / `__call_m_pop_0`, whose dispatcher had
**no native-vec arm** — an `any`/externref array receiver matched no closed-struct
`entries` arm and fell to the open-`$Object` bottom arm (returns `undefined`). The
#2784 S3 native-vec push/pop fast path in `calls.ts` is `!ctx.standalone`-gated,
so it never fired standalone.

Fix (`src/codegen/closed-method-dispatch.ts` + `src/codegen/expressions/calls.ts`):
a `$__vec_base` brand arm in the fixed-arity closed-method dispatcher routes
`push` (arity 1) / `pop` (arity 0) to the carrier-generic `__vec_push` /
`__vec_pop` helpers (grow-and-append / pop-last over every vec carrier). `push`'s
`-1` unsupported-carrier sentinel returns `undefined` (matching the pre-fix
fall-through) instead of boxing a bogus length. The vec helper is reserved at the
`calls.ts` call site to avoid an eval-time import cycle. This is the #2151
"Slice-4 brand arms" made real for the mutation methods, and is **shared work**
with standalone AOT any-receiver dispatch (roadmap §4.2), not interpreter-only.

Tests: `tests/issue-2927-standalone-any-push-pop.test.ts` (7 cases; standalone
assertions verify **0 function imports** before running, i.e. truly host-free).
No regression: `#2151`/`#2583` suites (51) + array-methods/prototype (35) green;
`tsc` clean.

### Remaining generic-built-in gaps (tracking items — gate #2928 sign-off)

1. **Map/Set methods on an `any` receiver are NOT host-free** — emit
   `env.WeakMap_get`/`WeakMap_set`/`WeakMap_has`/`Set_add`. **Root cause pinned:**
   the native Map/Set/WeakMap interception in `compileExternMethodCall`
   (`src/codegen/expressions/extern.ts:60-93`) keys on the receiver's **static
   TypeScript class name** (`className === "Map"` / `"Set"` / …). A genuinely-`any`
   receiver has no static class name, so the interception is skipped and the call
   falls to the generic extern/host path → `env.WeakMap_*` / `Set_*` imports —
   even though the WasmGC-native Map/Set runtime already exists
   (`src/codegen/map-runtime.ts`: `__map_get`/`__map_set`/`__map_has`/
   `__map_delete`/`__map_size`; `ctx.mapTypeIdx` `$Map` struct; `set-runtime.ts`).
   **Turnkey fix (mirrors the #2927 push/pop arm):** a runtime `ref.test
ctx.mapTypeIdx` / `$Set` brand arm in the closed-method dispatcher
   (`__call_m_get_1` / `__call_m_set_2` / `__call_m_has_1` / `__call_m_add_1`)
   routing to the native `__map_*` / `__set_*` helpers with the boxed args, so an
   `any` Map/Set receiver dispatches native. This is the highest-value host-free
   gap and the next slice to pick up. _(new gap — file as a #2928-prep child of
   #1584.)_
2. **Array callback methods (map/filter/forEach/reduce) on an `any` receiver are
   NOT host-free** — emit `env.__make_callback`. Host callback marshalling on a
   dynamic receiver; the largest of the three (needs an in-Wasm callback bridge).
   _(new gap — child of #1584.)_
3. **`string[].push` under standalone is a no-op** — the native-string vec carrier
   is not in `__vec_push`'s `mutEntries` (only externref/f64/i32), so the brand
   arm's `__vec_push` returns `-1` and the fix returns `undefined` for `string[]`
   (no regression — it was already broken). Fix belongs in the `__vec_push`/
   `__vec_pop` carrier set (`src/codegen/index.ts` `mutEntries`), not this arm.
   _(new gap — file under #2784.)_

Parts still open on this umbrella issue: **Part 1 (Acorn-via-js2wasm runtime
parser)** is untouched here — it is gated on **#2937** (host `$Object`-hash poison
→ uniform parse null-deref) per the probe results above, and remains the larger
half of this foundation. See `## Suspended Work`.

## Suspended Work

- **Branch**: `issue-2927-interpreter-foundation` (PR opened 2026-07-03).
- **Landed**: native-vec `.push`/`.pop` brand arm for standalone any-receiver
  (the one reachable host-free correctness bug the Part-2 audit surfaced) +
  refined coverage findings above.
- **Not done (roll forward)**:
  - Part 1 — Acorn runtime parser (blocked on #2937; then #2850/#2853/#2841/etc.).
  - Part 2 remaining gaps 1–3 above (Map/Set host imports, array-callback
    `__make_callback`, `string[]` push carrier). Each should become a child
    issue under #1584 / #2784 and gates #2928.
- **Resume**: pick up Part 2 gap #1 (Map/Set native brand arms) next — it is the
  highest-value host-free gap and mirrors the push/pop pattern (a `$Map`/`$Set`
  `ref.test` arm in the closed-method dispatcher routing to `map-runtime.ts`).

## Architect update (2026-07-04)

- Stale claim from the dead `sr-interp` session released
  (`claim-issue.mjs --release`); status flipped back to `ready`. The push/pop
  fix + audit refinement above are MERGED (PR #2592) — the roll-forward items
  are what remains.
- This issue's remaining work is now sequenced in the unified spec:
  `docs/architecture/runtime-eval-interpreter.md` **Part II §15–§16** and the
  `## Implementation Plan` in **#2928**. Mapping: the in-Wasm AST consumer
  probe = slice **E0**; the #2853-A/B parser blockers = **P1/P2**; the Part-2
  gaps 1–3 = **G1/G3/G4** (plus **G2** args-passing/arity). Devs picking this
  up should claim one named slice, not the whole umbrella.

## Slice decomposition (dev fable-interp, 2026-07-16)

Every named slice now has its own issue file:

| Slice                                              | Issue                    | Status                             |
| -------------------------------------------------- | ------------------------ | ---------------------------------- |
| E0 — in-Wasm AST consumer probe                    | **#3308**                | ready (unblocked)                  |
| P1/P2 — parser blockers                            | #2853                    | **done** (sprint 71)               |
| G1 — Map/Set any-receiver brand arms               | **#3309**                | done (implemented in the #3309 PR) |
| G2 — args on the standalone generic path + arity>4 | **#3310**                | ready                              |
| G3 — array-callback host-free (`__make_callback`)  | #3098 (+ #3235 residual) | **done**                           |
| G4 — `string[]` push/pop carrier                   | **#3311**                | ready                              |

**Mechanism correction (G1, verified 2026-07-16 on `bdb8491ee1`):** the audit's
"root cause pinned" paragraph above (gap 1) is stale — the `env.WeakMap_*` /
`Set_add` imports for an `any` receiver do NOT come from the
`compileExternMethodCall` className interception (that lane requires a type
symbol; `any` has none) nor from `registerBuiltinExternClasses` (all four
collections are `!nativeStrings`-gated there). They come from
`tryExternClassMethodOnAny` (`src/codegen/expressions/calls-closures.ts`
~1479–1514), a first-match scan over `ctx.externClasses` whose standalone
candidate pool still contains WeakMap/Set/WeakSet because the lib `.d.ts`
declare-var scan (`collectExternFromDeclareVar`,
`src/codegen/extern-declarations.ts:790`) nativeStrings-gates only `"Map"` —
and which returns before the #2151 closed-method dispatcher lane
(`call-receiver-method.ts:2601` vs `:2629`) is reached. Full corrected analysis
and fix: **#3309**. (Also: G4's `mutEntries` lives in
`src/codegen/vec-access-exports.ts:414`, not index.ts.)
