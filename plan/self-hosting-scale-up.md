# Stdlib self-hosting scale-up plan (battle-plan slice 9)

**Date:** 2026-07-11 · **Author:** fable-selfhost (senior-dev) · **Gate:** #3141 pilot — **GO**
**Pilot evidence:** nine Math helpers converted to TS source compiled through our own
IR pipeline; 36,477-case bit-exact sweep, zero mismatches; byte-inert for non-users;
standalone + wasi green; **zero dialect gaps**; 3.3× body compression measured
(316 hand lines → ~95 TS-source lines); one-time driver `src/codegen/stdlib-selfhost.ts`
(161 lines) amortizes over every future family. See
`plan/issues/3141-self-hosted-stdlib-pilot-math-helpers.md` §Result.

## The mechanism (what the pilot banked, reusable as-is)

1. Builtin = ordinary TS function in the IR-claimable subset, stored as source in
   `src/stdlib/<family>.ts` with a descriptor (`name`, `callees`, `source`).
2. `stdlib-selfhost.ts` memoizes a context-free `IrFunction` per builtin (symbolic
   refs, #1131 §1.2) and lowers it per compilation against the live ctx.
3. **Composition rule (the key scaling property):** self-hosted code calls ANY
   registered helper by funcMap name via `calleeTypes` — hand-written or
   self-hosted — so every family converts LEAF-FIRST, incrementally, no big-bang.
   Precision-sensitive or rep-heavy kernels can stay hand-written indefinitely
   (the escape hatch works in both directions, exactly porffor's model inverted).
4. Per-slice gates (unchanged): equivalence probe vs a JS port of the deleted hand
   algorithm (bit-exact, `.tmp/probe-3141.mts` is the template), byte-inertness
   SHA check for non-users, LOC-budget, full CI + `merge_group` net ≥ 0.

## Ranked target list (by leverage = deletable-lines ÷ precursor-cost)

| #   | Family (file, current LOC)                                                                                                        | Est. TS source |                                                           Est. net | Expressible today?                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Precursors / risk                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --- | --------------------------------------------------------------------------------------------------------------------------------- | -------------: | -----------------------------------------------------------------: | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | ✅ **DONE — math cores** — `math-helpers.ts` remainder: sin/cos/exp/log/atan/tan/atan2/pow/log2/log10                             |           ~320 |                                               **−0.8k (realised)** | **DONE** (#3141 pilot → #3204 log/trig → #3233 atan2 → #3226 exp/pow/log10)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | **COMPLETE 2026-07-13.** The whole Math family is self-hosted; only `Math_random` stays hand-emitted (WASI `random_get` host import — not a dialect gap). #3226 reframed: exp/pow needed NO i32-bit-op/reinterpret and log10 NO `f64.nearest` — all expressible in pure f64 (`ni & 1`→`ni-Math.floor(ni/2)*2`, `ni>>>1`→`Math.floor(ni/2)`, `f64.nearest`→guard-bounded `Math.floor(x+0.5)`). Each bit-exact-validated vs a main-built control (0 mismatches). Net realised ≈ −0.8k across the four PRs.                                       |
| 2   | **parse/format** — `parse-number-native.ts` (1,838) + `number-format-native.ts` (1,712)                                           |           ~700 |                                                          **−2.8k** | **READY — dispatched as #3305 (2026-07-16).** Verified shape: 9 discrete fixed-ABI funcMap-registered helpers (`parseInt` ~970-line region, `__str_to_number` ~360, `number_toString`/`_radix`/`toFixed`/`toExponential`/`toPrecision` 230–360 each), pure algorithm bodies. The #3256 Tier-1 dialect covers them TODAY: charCodeAt scans via `__str_charCodeAt`, f64 arithmetic, string building via substring-of-literal digit tables + concat. Zero new resolver machinery.                                                                                                                                                                                                                              | Precursor A LANDED (#3256). Medium-low risk.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 3   | **string methods** — `string-ops.ts` (3,495) + parts of `native-strings.ts` (7,433; keep the i16-array core kernels hand-written) |          ~1.6k |                                                          **−6–7k** | **TIER-1 LANDED (#3256, 2026-07-16)** — trim family (`isWhitespace`/`trimStart`/`trimEnd`/`trim`), `startsWith`/`endsWith`, `repeat`/`padStart`/`padEnd` self-hosted: ~795 hand `Instr[]` lines deleted → ~135 TS-source lines (**≈6× body compression**), net **−206** src LOC incl. the one-time Tier-1 driver widening (+204, amortizes over Tier-2/3). Measured: pure-Wasm lanes green (standalone + wasi, tests/issue-3256.test.ts), host lane byte-identical, godfile baseline ratcheted. Remaining string targets: indexOf/lastIndexOf (hot scan kernels — perf call), replace/split/getSubstitution, case/wellformed (Unicode-table-driven), `string-ops.ts` AST-dispatch arms (not stdlib-shaped). | Precursor A + C LANDED with #3256: driver `resolveFunc` name-fallback + on-demand `__str_charCodeAt`, `resolveString()`, `resolveType` name-scan, `emitString{Const,Concat,Equals,Len}`, and a context-free native-strings `stringMethodPlan` at build (`dialect: "native-strings"`); mutated string `let`s bind as slots via build-time `resolveString()` (ctx-bound ⇒ NO memoKey for string defs); legacy i32 ABIs preserved by hand thunks (the #3159 move). Params are NOT reassignable in the IR subset — flatten binds to a fresh `let`. |
| 4   | **array methods** — `array-methods.ts` (9,565)                                                                                    |      ~1.2–1.5k | ~~−8k~~ **RE-SCOPED (#3257, 2026-07-16): NOT a self-host target.** | **NO** — measured, not estimated: the file registers ZERO discrete runtime helpers (0 pushDefinedFunc, 211 allocLocal) — every `compileArray*` is a call-site inline emitter dominated by irreducible AST/arg plumbing. Best full-coverage slice (indexOf/lastIndexOf/includes) measured net ≈ −60..−180 at HIGH risk (#2648 packed signedness × #2001 holes × #2719 mode-split eq × ref-string micro-kernels); move-only ops net-0. Reduction path = IR adoption of the AST kinds (codegen-axes), not stdlib self-hosting. See #3257 §Result — do not re-attempt without new facts.                                                                                                                        | Tier-2 driver widening (`__vec_elem_set_<t>` on-demand arm) LANDED with #3257; note the i32-index ABI wall (dialect produces i32 only via comparisons — stdlib callers need `__arri_*`-style f64-ABI wrappers). The XL budget redirected to family 2 → **#3305**.                                                                                                                                                                                                                                                                              |
| 5   | **dataview/typed-array** — `dataview-native.ts` (3,866)                                                                           |           ~900 |                                                          **−2.9k** | MOSTLY — byte-shuffling loops are i32 arithmetic; needs u8-array load/store intrinsic callees + i64 for the 64-bit views                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Precursor B variant (u8 element access); i64 ops partially in IR union. Medium risk.                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 6   | **json codec** — `json-codec-native.ts` (2,859)                                                                                   |           ~800 |                                                            **−2k** | PARTIAL — scanner/printer loops fine; value construction touches the dynamic rep                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Needs 3 + 4 landed first (strings + arrays). Medium risk.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 7   | **map/iterator** — `map-runtime.ts` (2,103) + `iterator-native.ts` (2,354)                                                        |          ~1.1k |                                                          **−3.3k** | PARTIAL — hash/probe loops fine; struct-field access on the runtime structs needs typed struct intrinsics                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Precursor D (`__struct_get`-style typed intrinsics, battle-plan §4). Medium-high.                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 8   | **object runtime** — `object-runtime.ts` (6,616 current profiler LOC)                                                              |            ~2k | **BLOCKED; 0 realised in #3258 recon**                              | **DIALECT-GAP VERIFIED (#3258, 2026-07-20).** The two safe externref-composition leaves were already self-hosted by #3160. The smallest remaining duplicated group (`__hasOwnProperty`/`__object_hasOwn`, ~55-line shared body) needs externref→named-ref test/cast, nullable `$PropEntry`, and a typed `$Object` call to `__obj_find`; `resolveObject` only models compiler-owned TS object shapes and cannot express those runtime casts. Tiny constructor/`__objvec_new` bodies are net-positive as source. Current profile: file 6,616 LOC/2,449 emissions; `ensureObjectRuntime` 3,495 LOC/1,298 emissions, d=0.37. | Precursor D at full strength: named-ref test/cast/nullability, typed struct/array access+allocation, and `ref.eq`, then re-measure starting with has-own. Full deferred registries alone do not unblock source expression. Convert last. |
| —   | `generators-native.ts` (4,696), `regexp-standalone.ts`/`native-regex`                                                             |              — |                                                                  — | DEFER — control-flow transformation machinery, not stdlib-shaped source                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Not self-hosting candidates in this program.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

**Cumulative (1–8): ≈ −34–37k net** from the files above alone; with the long tail of
smaller emission files (58 files total in the ~76k bucket) the battle plan's **−45–55k**
holds at the measured 3.3× floor (porffor's 5–8× on large families is upside).

## Precursors (dispatch as their own small issues, in this order)

- **A. String char-code callees** (S): declare existing `__str_*` helper signatures as
  `calleeTypes` entries usable from stdlib source. No new Wasm — pure driver/descriptor
  plumbing. Unblocks 2, 3.
- **B. Array/vec element callees** (S/M): same pattern for vec len/get/set/push
  (helpers exist: `ensureVecElemSet` etc.). Unblocks 4, 5.
- **C. Driver-resolver widening** (S): `stdlib-selfhost.ts` currently throws on
  globals/named-types/objects (deliberate pilot scope-guard). Delegate to
  integration.ts's `makeResolver` (export it) for families that need string/vec/ref
  types. Unblocks 3–7.
- **D. Typed struct intrinsics** (M/L — battle-plan §4's "main deliverable"):
  `__struct_get`/`__tag_of`-style intrinsic functions from-ast lowers as IR nodes.
  Only needed from family 7 on — do NOT front-load it.
- **QoL (optional):** `NaN`/`Infinity` identifiers in from-ast (pilot workarounds are
  fine: `x !== x`, `0/0`, `> 1.7976931348623157e308`).

## Sequencing rule

One family per PR, leaf-first within the family, each PR: convert + probe bit-exact +
delete + measure. Family 1 (math cores) is dispatchable **today** with zero precursors —
it is the natural next-window opener and turns the pilot's +72 net into a clean negative.

## Backend caveat

IR loop/try lowering is WasmGC-`Instr[]`-only until the #1584 a1..a6 trait migration;
self-hosted bodies with loops serve the WasmGC backend today. The linear backend does
not consume these emission files at all currently, so nothing regresses — but the
"one source, both backends" dividend for loop-bearing builtins arrives with #1584.

## Tier-1 resolver-widening scope (Precursor C) — next-window handoff

_Author: opus-selfhost2, 2026-07-13. Durable capture of the scope analysis done_
_after the Math family completed, so the next-window Tier-1 agent inherits it._

**FLAG — the ranked table's "Precursor C = export `makeResolver` (S)" is
misleading.** `makeResolver` (`src/ir/integration.ts:1281`) is NOT drop-in
reusable: it takes **6 constructed dependencies** — `unionRegistry`,
`stringBackend` (from `computeStringBackend`, currently **not exported**), and
four **deferred registry resolvers** (`DeferredObjectResolver`,
`DeferredClosureResolver`, `DeferredRefCellResolver`, `DeferredClassResolver`)
that are wired to `ObjectStructRegistry` / `ClosureStructRegistry` / … across
~40 lines of Phase-3 back-patching (`integration.ts:706–740`). Dragging that
whole apparatus into the stdlib-selfhost driver is not an "S".

**The genuinely-S/M path is a TIERED, purpose-built widening of the driver's
OWN resolver** (`src/codegen/stdlib-selfhost.ts:243`, currently
`resolveFunc`=funcMap-only, `resolveGlobal`/`resolveType`=throw,
`internFuncType`). Do NOT reuse `makeResolver` wholesale; grow the driver's
resolver tier by tier, only as far as each family needs:

- **Tier 1 (strings)** — for a leaf `__str_*` helper that only reads char codes:
  1. widen `resolveFunc` to add `makeResolver`'s name-fallback + on-demand
     string-helper materialization (scan `ctx.mod.functions` + `ctx.nativeStrHelpers`
     by name; `ensureHostCharCodeAtGuarded` / `ensureNativeStringHelpers` —
     mirror `integration.ts:1322–1383`);
  2. add `resolveString` by **exporting `computeStringBackend(ctx)`** and calling it;
  3. add `resolveType` for the string struct type.
     **No object/closure/vec/union registries needed.** This is the whole Tier-1 lift.
- **Tier 2 (arrays/vecs)** — additionally: `resolveFunc`'s `VEC_ELEM_SET`
  on-demand path (`ensureVecElemSet`) + `resolveType` for vec structs. Still no
  objects/closures.
- **Tier 3 (objects/classes, families 6–8)** — only HERE do you need the full
  deferred-registry machinery (`ObjectStructRegistry` etc.). This is the
  genuinely hard part; keep it deferred per the ranked table (convert LAST).

**Precursor A (char-code callee sigs)** co-lands with Tier 1: declare the
existing `__str_*` helper signatures (e.g. a `__str_charCodeAt`-style
`(string, i32) -> i32`) as `calleeTypes` entries so stdlib source can call them.
No new Wasm — pure descriptor/`calleeTypes` plumbing.

**First-unit choice.** NOT `string-ops.ts` — that file is **AST-dispatch
emitters** (`compileNativeStringMethodCall`, `compileStringLiteral`, …), not
stdlib-shaped functions. The real leaf candidates are the discrete fixed-ABI
`__str_*` **runtime helpers** in `native-strings.ts` (`__str_repeat`,
`__str_indexOf`, `__str_padStart`/`padEnd`, `__str_startsWith`/`endsWith`/
`includes`, `__str_slice`, …) — pure char-code loops over the i16-array rep.
**Recommend `__str_repeat` or `__str_startsWith`** as the smallest fixed-ABI
leaf.

**Measure-first first PR** = Tier-1 resolver widening + Precursor A char-code
callee + **ONE** `__str_*` helper converted. Validation differs from Math:
these are **non-numeric**, so use **A/B equivalence** (compiled self-hosted vs
compiled hand helper on a corpus of inputs, incl. empty/unicode/surrogate/large)

- a **containment SHA check** for non-users — the bit-exact f64-bit-pattern
  sweep is a numeric-only tool. Both host and standalone/wasi lanes.

**Reusable driver mechanism confirmed working for binary builtins**: the
`StdlibMathBuiltin.arity?: 1|2` field + `mathBuiltinDef`'s `paramTypes` split
(landed in #3233/#3226) generalises; a string helper descriptor will want its
own positional `paramTypes`/`returnType`/`calleeTypes` via the already-general
`SelfHostedFuncDef` / `emitSelfHostedFunc` path (`stdlib-selfhost.ts:91,232`).
