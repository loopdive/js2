# #1917 concretized — Single Coercion Engine spec

**Date**: 2026-06-11 · **Author**: analysis agent (concretizing `plan/issues/1917-single-coercion-engine.md`)
**Grounding**: June-2026 spec-conformance bug corpus (#1986-#2081 sweep) — every cited line verified on main @ HEAD (post-1bb8be691).

> Scope note: upstream #1917 as filed targets the **ValType-level** coercion matrices
> (`coerceType` / `coercionInstrs` / `callArgCoercionInstrs` / `fixBranchType`). This
> spec extends it to the layer where the June bug corpus actually lives: the
> **JS-semantic** abstract operations (ToString, ToNumber, ToPrimitive, ToBoolean,
> IsLooselyEqual/IsStrictlyEqual) that are re-implemented per call site. The ValType
> matrix unification of the original issue becomes Step 0 of the migration below;
> the JS-semantic engine is Steps 1-4.

---

## 1. Why: the drift mechanism, in one example

The fix history of "string concat operand → ToString" shows the failure mode.
The same §7.1.17 ToString matrix (number / i32-bool / i64 / null / undefined /
opaque externref / struct ref / void) is hand-rolled **seven times** in
`src/codegen/`, and bug fixes landed in some copies but not others:

| Copy | Has bool→"true"/"false"? | Has null→"null"? | Has opaque-externref ToString? | Result |
|---|---|---|---|---|
| `compileStringBinaryOp` inline left arm (string-ops.ts:1374-1432) | yes (1386) | yes (1397) | yes `__extern_toString` (1420) | correct |
| `compileStringBinaryOp` inline right arm (string-ops.ts:1451-1508) | yes (1462) | yes (1473) | yes (1492) | correct (literal duplicate of the left arm) |
| `compileAndCoerceConcatOperand` (string-ops.ts:1092-1142, batched `__concat_N`) | yes (1107) | yes | partial | correct-ish, third copy |
| `compileNativeConcatOperand` (string-ops.ts:84-169, standalone `+`) | yes (105) | yes (130) | yes (143) + `$__any_to_string` (162) | fullest matrix |
| `compileTemplateExpression` (string-ops.ts:267-285, host templates) | **NO → #2005** (`${true}`→"1") | **NO → #2006** (`${null}` traps illegal cast) | **NO** (line 285: "externref assumed to be string already") | broken |
| `compileNativeTemplateExpression` (string-ops.ts:344-436, standalone templates) | **NO → #2005 (native half)** | yes (397) | yes (404) | half-broken |
| `String()` lowering (expressions/calls.ts:8051-8150+) | yes (8095) | yes (8075) | (own matrix again) | yet another copy |
| `compileArrayJoin` elemToStr (array-methods.ts:4555-4565) | n/a | **NO → #1998** (externref elements trap) | **NO → #1998**; native-string ref elements **null-deref → #2074** | broken in both modes |

Identical structure in ToPrimitive (5 sites, #1988/#1989/#1990/#2022), equality
(7 sites, #1986/#1987/#1990/#2073/#2081), ToNumber (6+ sites), ToBoolean (4
sites, one **latently divergent**, §2.4). A fix to one copy is structurally
invisible to the others. This is the cost #1917 names.

---

## 2. Full inventory

Legend — **Mode**: H = JS-host, NS = nativeStrings+host, SA = standalone/WASI, ALL = mode-dispatching.
**Backend**: all sites are WasmGC (`src/codegen/`); the linear backend (`src/codegen-linear/`) has
essentially **no coercion layer** yet (its `.toString()` lowering at `codegen-linear/index.ts:2921-2924`
is an identity no-op on numbers; everything else is unsupported-error). Linear is therefore a
*future consumer* of the engine, not a migration source.

### 2.1 ToString / string-concat element conversion (§7.1.17)

| # | Site | file:line | Types handled | Known bugs | Mode |
|---|------|-----------|---------------|-----------|------|
| S1 | `compileStringBinaryOp` inline ×2 (left/right arms are copy-pasted) | string-ops.ts:1374-1432, 1451-1508 | void, f64, i32(+bool), i64, extern-null/undef, opaque extern (`__extern_toString`), ref (coerceType hint "string") | — (reference copy) | H |
| S2 | `compileAndCoerceConcatOperand` (batched `__concat_N`) | string-ops.ts:1092-1142 | void, f64/i32(+bool)/i64, extern-null/undef, ref hint "string" | — (third copy of S1) | H |
| S3 | `compileNativeConcatOperand` | string-ops.ts:84-169 | string-ref, i32-bool, f64/i32/i64, extern-null/undef, dynamic extern, struct ref (`tryStructToString` → `$__any_to_string`) | — (fullest copy) | SA |
| S4 | `compileTemplateExpression` span loop | string-ops.ts:267-285 | f64, i32 (numeric only), i64, ref | **#2005** (bool→"1", undefined→"0"), **#2006** (`${null}` trap), opaque externref passes raw | H |
| S5 | `compileNativeTemplateExpression` span loop | string-ops.ts:344-436 | string-ref, f64, i32 (numeric only), i64, extern-null/undef/dynamic, struct ref | **#2005** native half (no bool branch at 368-375) | NS+SA |
| S6 | `String(x)` lowering | expressions/calls.ts:8051-8150+ | null/undef literals, void, i32(+bool), f64, … own full matrix | — (fourth-ish copy) | ALL |
| S7 | `compileArrayJoin` elemToStr | array-methods.ts:4555-4565 | **f64, i32 only** | **#1998** (externref elems trap illegal cast: any[], undefined, null, holes, Array(n)), **#2074** (native-string ref elems null-deref standalone), #1968 sibling | ALL |
| S8 | `$__any_to_string` Wasm helper (tag dispatch over $AnyValue + AnyString passthrough) | native-strings.ts:5438-5594 | null/undef/i32/f64/bool tags, string ref, fallback "[object Object]" | — (canonical standalone dynamic tail) | SA |
| S9 | `__extern_toString` host import | runtime.ts:6150-6166 | everything (JS String() + `_toPrimitive` struct walk) | — (canonical host dynamic tail) | H |
| S10 | `emitBoolToString` leaf | string-ops.ts:928 | i32 bool | — (leaf, fine; just must be *called*) | ALL |
| S11 | coerceType ref→externref hint-"string" walk | type-coercion.ts:1512-1690 | struct with @@toPrimitive/toString | shares #1989 name-keyed dispatch | H |
| S12 | `tryStructToString` (static OrdinaryToPrimitive hint "string") | type-coercion.ts:2275-2470 | compile-time-resolvable structs | shares #1989 family | SA |
| S13 | Array `toString`/template-of-array etc. | various | — | **#1997** (object-array toString), **#2008** (tagged template object), #2007 (array operand concat illegal cast) | ALL |

Related sibling (not ToString itself, but same 4-lowerings drift): `String.fromCharCode`/
`fromCodePoint` lowered 4 ways at expressions/calls.ts:3493-3557, 3 of them drop args — **#1955**.

### 2.2 ToNumber (§7.1.4) / ToPrimitive (§7.1.1)

| # | Site | file:line | Types handled | Known bugs | Mode |
|---|------|-----------|---------------|-----------|------|
| N1 | Unary `+`/`-`/`~` | expressions/unary.ts:45-165 | static fold (`tryStaticToNumber`), externref→`__unbox_number` (comment at :59 claims "centralized ToNumber funnel" #1434 — it is not), ref→coerceType, i32-bool | — | ALL |
| N2 | `Number(x)` lowering | expressions/calls.ts:7907-7990 | symbol-throw, i64, externref (host `__unbox_number` / standalone coerceType), native-string ref→`__str_to_number`, struct→ToPrimitive | — (own matrix) | ALL |
| N3 | `coerceType` ref→f64 ToPrimitive static dispatch | type-coercion.ts:1713-1930 | @@toPrimitive → valueOf (field / class method / closure) → toString fallback (`tryToStringFallback` :2104) → host `__to_primitive` | **#1989** — dispatch keyed by struct *type name* (:1755-1790, `${name}_valueOf`, `ctx.valueOfClosureTypes.get(name)` registered literals.ts:1486); last same-shape literal wins. Typed-ref field path (:1853-1920) is already per-instance-correct; **eqref path (:1928-2074) is the broken half** (see Implementation Plan in issue 1989) | H+SA |
| N4 | `emitToPrimitiveHostCall` / `toPrimitiveHostCallInstrs` → `__to_primitive` import | type-coercion.ts:94-160; runtime.ts:6244 | host-side full ToPrimitive (#1090) | — (canonical host tail) | H |
| N5 | `_toPrimitiveSync` host helper | runtime.ts:2358 | struct ToPrimitive with wasm callback re-entry | used by `__extern_has`, property keys, relational (runtime.ts:4412) — **but NOT by `host_loose_eq` → #1990** | H |
| N6 | `__any_to_f64` Wasm helper | any-helpers.ts:465-509 | tags 0-4 (null/undef/i32/f64/bool) | **#1988** — ref/string tags (5/6) fall through to raw `f64val` field read (garbage); `__any_add` (any-helpers.ts:520-567) therefore never does ToPrimitive: `1+{}`→NaN, `[]+[]`→0 | ALL |
| N7 | `+` operator hint routing | binary-ops.ts:941-952 | string-typed operand → `compileStringBinaryOp` immediately | **#2022** — pre-commits to string-hint concat; spec requires ToPrimitive(default) (valueOf first) *before* the concat/add decision: `new P() + ""` → "P!" not "7" | ALL |
| N8 | `__str_to_number` Wasm helper (§7.1.4.1 StringToNumber) | parse-number-native.ts:448-1000 | full numeric grammar incl. hex/octal/binary | — (canonical standalone string tail) | SA |
| N9 | PR for **#2073** (branch `origin/issue-2073-standalone-loose-eq`, commit 2e3cde6d6) | binary-ops.ts:+868-905 (diff) | inline `emitToNumber` closure (string→`__str_to_number`, bool→convert, number→hint) | **new drift being added** — a fresh inline ToNumber matrix inside the loose-eq lowering; engine must absorb it (§4 step 3) | SA |
| N10 | `Number.isNaN`/`isInteger`/`isFinite` f64-hint lowering | expressions/calls.ts:3371-3420 | — | **#2034 (done 2026-06-11)** — predicates coerced; fixed by per-site tag check, i.e. yet another local copy | ALL |
| N11 | standalone native OrdinaryToPrimitive over `$Object` (#1900, **in-review** PR 1251) | index.ts:~2286 region | $Object property-table valueOf/toString | engine's SA ToPrimitive tail must call this, not re-implement | SA |

### 2.3 IsStrictlyEqual (§7.2.16) / IsLooselyEqual (§7.2.15)

| # | Site | file:line | Types handled | Known bugs | Mode |
|---|------|-----------|---------------|-----------|------|
| E1 | num==bool inline | binary-ops.ts:835-849 | f64.eq after convert | — | ALL |
| E2 | str⇄num/bool loose eq → `__host_loose_eq` | binary-ops.ts:861-896 | host JS `==` | **#2073** — unconditional host import leaks into standalone binary (fix in flight, N9) | H (SA broken) |
| E3 | any/any dispatch → `__any_eq`/`__any_strict_eq` | binary-ops.ts:905-922 → any-helpers.ts:700-1000 | tags incl. string content (tag 5) and ref identity (tag 6) | **#1987** — `__any_strict_eq` (any-helpers.ts:887-1000) bails on tagA≠tagB before numeric compare, but numbers box as tag 2 (i32, `__any_box_i32` type-coercion.ts:1182) *or* tag 3 (f64): `(0 as any)===(-0 as any)`→false. `__any_eq` shares the tag table | ALL |
| E4 | single-side-any `===` falls to numeric path | binary-ops.ts:1654+, compileNumericBinaryOp :2385-2390 | unboxes any via `__any_to_f64` then `f64.eq` | **#1986** — `===` looser than `==`: `null===0`→true, `"1"===1`→true, `false===0`→true (gate at :906-908 requires *both* sides any) | ALL |
| E5 | externref equality host fallback `__host_eq`/`__host_loose_eq` | binary-ops.ts:1914-1970, 2050-2170 | JS `===`/`==` | **#1990** — `host_loose_eq` (runtime.ts:9959) applies raw JS `==`; opaque struct with valueOf/toString throws "Cannot convert object to primitive value"; `_toPrimitiveSync` routing exists (N5) but isn't called | H |
| E6 | standalone externref tag dispatch (#1776) | binary-ops.ts:1771-1910 | number/boolean/bigint unbox + eqref identity | **#2081** — used for `==` too: any/any loose eq compares ref identity, `'1'==1`→false standalone; no string-content arm, no ToNumber arm | SA |
| E7 | string==string via `wasm:js-string equals` / `__str_equals` (+ String-wrapper unwrap) | string-ops.ts:1441-1448, 1510-1547, 1248-1262 | string content | — | ALL |
| E8 | BigInt mixed equality | binary-ops.ts:960-1010 | strict→const false, loose→f64 compare via parseFloat | parseFloat≠StringToNumber drift (same disease E2 was fixed for in #1134) | ALL |

### 2.4 ToBoolean (§7.1.2)

| # | Site | file:line | Types handled | Known bugs | Mode |
|---|------|-----------|---------------|-----------|------|
| B1 | `ensureI32Condition` | index.ts:11687-11749 | f64 (abs>0, NaN-correct), externref (`__is_truthy`), AnyValue (`__any_unbox_bool`), native string (len>0), ref (null-check), i64 | — (canonical-ish; 25 call sites incl. `!`, `&&`, `||`, if/while) | ALL |
| B2 | `buildTruthyCheck`/`buildFalsyCheck` (array callback predicates: filter/some/every/find) | array-methods.ts:5121-5180 | f64 via **`f64.ne 0` → NaN counts truthy** (B1's own comment at index.ts:11694-11695 says this is wrong); externref/ref via **`ref.is_null`** → boxed `0`/`""`/`false` count truthy; no native-string arm | **latent divergence, no issue filed yet** — file as part of step 4 | ALL |
| B3 | filter-extern callback truthiness | array-methods.ts:583, 681-684 | `__is_truthy` for externref, null-check fallback for struct refs | partial duplicate of B1 | H |
| B4 | compile-time folds | object-ops.ts:51 (`tryConstantFoldToBoolean`), literals.ts:933-935 | literals | two separate constant-fold tables | ALL |
| B5 | host imports `__is_truthy` / `__to_boolean` | runtime.ts (~6230) | JS truthiness | — (host tail) | H |

### 2.5 ValType-matrix layer (original #1917 — unchanged, becomes Step 0)

`coerceType` (type-coercion.ts:980, ~1100 lines), `coercionInstrs` (:2695-2903),
`callArgCoercionInstrs` (stack-balance.ts:1179-1310), `fixBranchType` (stack-balance.ts:678-764).
Documented divergences: externref→f64 lossy `drop; f64.const 0` in fixBranchType vs `__unbox_number`
in callArgCoercionInstrs; ref→f64 NaN vs 0. Guarded-ref-cast idiom copy-pasted ≥6× (now partially
extracted as `emitGuardedRefCast`, type-coercion.ts:26).

---

## 3. Target architecture

### 3.1 One module: `src/codegen/coercion-engine.ts`

```ts
// ── mode is derived once, not re-tested ad hoc per site ──
export type CoercionMode = "js-host" | "native-strings-host" | "standalone";
export function coercionMode(ctx: CodegenContext): CoercionMode;
// (today's ad-hoc tests: `ctx.nativeStrings && ctx.nativeStrTypeIdx >= 0`,
//  `noJsHost(ctx)`, `ctx.standalone === true || ctx.wasi === true` — 3 different spellings)

// ── operand description: ValType + the static TS facts each matrix re-derives ──
export interface Operand {
  valType: ValType | null;           // null = void result
  staticClass: StaticClass;          // classified ONCE from (ValType, ts.Type):
                                     // f64 | i32-number | i32-bool | i64 |
                                     // extern-null | extern-undef | extern-string |
                                     // extern-opaque | ref-string | ref-anyvalue |
                                     // ref-struct(typeIdx) | ref-eq | void | symbol
}
export function classifyOperand(ctx, valType, tsType): Operand;

// ── emitters: write into a sink (default fctx.body) so loop builders
//    (array-methods elemToStr, callback predicates) can capture Instr[] ──
export function emitToString(ctx, fctx, op: Operand, sink?: Instr[]): StrType;   // externref | ref $AnyString per mode
export function emitToNumber(ctx, fctx, op: Operand, sink?: Instr[]): void;      // → f64
export function emitToPrimitive(ctx, fctx, op: Operand, hint: "default"|"number"|"string", sink?): Operand;
export function emitToBoolean(ctx, fctx, op: Operand, sink?): void;              // → i32
export function emitStrictEq(ctx, fctx, l: Operand, r: Operand, negate: boolean): void;
export function emitLooseEq(ctx, fctx, l: Operand, r: Operand, negate: boolean): void;
```

Every emitter is **one switch over `staticClass` × one switch over `coercionMode`**, with
exactly one row per (class, mode) pair. Symbol rows throw TypeError per spec
(absorbing `tryThrowOnSymbolStringCoercion` string-ops.ts:1639 and `emitSymbolToNumberThrow`
unary.ts:31 — today *also* duplicated per operation).

### 3.2 Shared emitter functions vs shared Wasm helpers — decision

**Both, split by static knowledge — and this requires no measurement** because the
duplication being removed is at the **TypeScript-emitter level, not the Wasm level**:

- **Static fast paths stay inline** (emitted by the shared TS function): when
  `staticClass` is known, the sequence is ≤6 instrs (`f64.convert_i32_s; call number_toString`,
  `global.get "null"`, `f64.eq`, …). A Wasm helper call here would *add* call overhead
  and a funcidx dependency for zero size win. This is what every correct copy
  (S1/S3) already does.
- **Dynamic tails stay shared Wasm helpers / host imports** — exactly the ones that
  already exist and are already canonical per mode:
  `$__any_to_string` (S8) and `__extern_toString` (S9) for ToString;
  `__any_to_f64` (N6, fixed per #1988) + `__str_to_number` (N8) + `__to_primitive` (N4)
  for ToNumber/ToPrimitive; `__is_truthy` (B5) / `__any_unbox_bool` for ToBoolean;
  `__any_strict_eq`/`__any_eq` (E3, fixed per #1987) + one new `$__any_loose_eq`
  standalone helper (E6/#2081) for equality.
  These are ~50-150 instr bodies; inlining them per site *would* bloat the binary —
  the helper-per-module pattern is the right one and stays.

Net effect on emitted Wasm: **zero by construction** for already-correct sites
(the engine's rows are transcribed from the best existing copy; equivalence tests
verify identical behavior), bugfix-sized deltas for the broken sites.

### 3.3 What the engine does NOT do

- It does not pick `+` add-vs-concat, `==` algorithm steps, etc. — operators keep
  their control flow but obtain *every conversion* from the engine. E.g. the #2022 fix:
  `compileBinaryExpression` calls `emitToPrimitive(op, "default")` on ref operands
  *first*, then branches concat/add on the returned primitive `Operand`.
- It does not replace `coerceType` wholesale. Step 0 (original #1917) extracts the
  ValType `coercionPlan` table; the engine *consumes* `coercionPlan` for representation
  changes and adds the JS-semantic layer on top. Long-term `coerceType`'s ToPrimitive
  internals (N3) move into the engine and `coerceType` shrinks to representation-only.
- Linear backend: `codegen-linear` consumes the engine later via a second
  `coercionMode`-like axis ("linear"); the engine's TS-level table is backend-neutral
  where possible (staticClass classification is), with per-backend instr rows.

---

## 4. Migration order (PR-sized steps, highest bug density first)

In-flight work respected (team TaskList `~/.claude/tasks/cf8c9009-…/`):
task 19 → #2067 (loops.ts), task 21 → #2069 (calls.ts:2517-2630 call/apply), task 22 → #2070
(closures.ts) — **no file-region overlap** with any step below except calls.ts, where step 2/4
touch ~:7907/:8051 (far from :2517-2630; merge-order only, no conflict expected).
Branch `origin/issue-2073-standalone-loose-eq` (PR for #2073, commit 2e3cde6d6) and
PR 1251 (#1900 native ToPrimitive, in-review) **land first**; steps 3 and 2 absorb them.

| Step | PR scope | Absorbs sites | Fixes (test gate = these issues' repros + equivalence + test262 CI) |
|---|---|---|---|
| **0** | `coercionPlan` ValType table + `guardedRefCast` dedup (original #1917 acceptance) | §2.5: coercionInstrs/callArgCoercionInstrs/fixBranchType | externref→f64 & ref→f64 context divergence; table-driven unit test: all consumers emit identical sequences per (from,to) |
| **1** | `coercion-engine.ts` skeleton (`coercionMode`, `classifyOperand`) + **emitToString**; migrate S4, S5, S7 (templates + join elemToStr); S1/S2/S3/S6 migrate mechanically (behavior-neutral, diff-checked) | S1-S13 | **#2005, #2006, #1998, #2074**; regression guard for #1997/#2007/#2008 family. Highest bug density: 4 open high-priority issues in one matrix |
| **2** | **emitToPrimitive** (+hint routing): per-instance funcref dispatch per #1989's Implementation Plan (literals.ts field typing + type-coercion.ts eqref-path demotion); `+` default-hint pre-pass in binary-ops.ts:941; `host_loose_eq` → `_toPrimitiveSync` routing (runtime.ts:9959) | N3, N4, N5, N7, S11, S12; calls #1900's helper as SA tail | **#1989, #2022, #1990, #1988** (ref-tag arm of `__any_add` routes through ToPrimitive then re-dispatches concat/add) |
| **3** | **emitStrictEq / emitLooseEq**: single-side-any boxing → `__any_strict_eq`; tag-2/3 number-class unification; standalone `$__any_loose_eq` helper (extends E6 with string-content + ToNumber arms, reusing #2073's `__str_to_number` path instead of its inline closure) | E1-E8, N9 | **#1986, #1987, #2081**; #2073 regression-guarded; E8 parseFloat→StringToNumber drift |
| **4** | **emitToNumber + emitToBoolean**: unify N1/N2 matrices; replace `buildTruthyCheck`/`buildFalsyCheck` (B2) and B3 with engine rows (file the B2 NaN-truthy/boxed-falsy divergence as an issue in this PR) | N1, N2, N6, N8, B1-B4 | B2 latent bugs (`[NaN].filter(x=>x)` keeps NaN; boxed-`0`/`""` predicates truthy); #1955-family follow-up separately (variadic lowering, not coercion) |
| **5** | **Drift gate** (§5) + visibility seal: baseline file committed, ratchet wired into `quality` CI job | — | CI fails on any new out-of-engine coercion site |

Each step is independently green-mergeable; steps 1-4 each end with diff-verified
identical behavior for a corpus of already-correct programs (reuse
`playground/examples/` like the IR-fallback walker does) plus the new repro tests.

## 5. Drift prevention — make bypass a CI failure

Model: the existing **IR-fallback ratchet** (`scripts/check-ir-fallbacks.ts`,
`scripts/ir-fallback-baseline.json`, `pnpm run check:ir-fallbacks -- --update-on-decrease`).

1. **`scripts/check-coercion-sites.mjs`** — greps `src/codegen{,-linear}/**/*.ts`
   *excluding* `coercion-engine.ts` (and the `any-helpers.ts`/`native-strings.ts` helper
   *bodies*, which are engine-owned tails) for the sealed vocabulary:
   - call-sites: `number_toString`, `emitBoolToString`, `__extern_toString`,
     `__any_to_string`, `__to_primitive`, `_toPrimitiveSync`, `__host_loose_eq`,
     `__host_eq`, `__any_to_f64`, `__str_to_number`, `__unbox_number`, `__is_truthy`,
     `__to_boolean`, `__any_eq`, `__any_strict_eq`, `valueOfClosureTypes`,
     `toPrimitiveHint`, plus the adjacent-pair form `f64.convert_i32_s` →
     `number_toString`;
   - counts per (file, token) vs `scripts/coercion-sites-baseline.json`; **growth fails,
     shrink auto-ratchets** (`--update-on-decrease`, same flags as the IR gate).
   During migration the baseline equals today's counts; each step's PR ratchets it down;
   end state is ~0 outside the engine, at which point the grep becomes a hard seal.
2. **Type-level assist** (cheap, not sufficient alone): move `emitBoolToString`,
   `compileAndCoerceConcatOperand`, `compileNativeConcatOperand`,
   `emitToPrimitiveHostCall` into `coercion-engine.ts` as **non-exported** internals;
   the host-import names above get a single `ensureCoercionImport()` chokepoint in the
   engine so `ensureLateImport(ctx, "__host_loose_eq", …)` outside it has no exported
   path. (Biome has no no-restricted-imports rule wired here; the grep gate is the
   enforcement, the visibility change is the ergonomic guide.)
3. **Wire-up**: `package.json` `"check:coercion-sites"`, run in the `quality` job of
   `ci.yml` (a required check per `docs/ci-policy.md`), post-merge ratchet alongside
   `check:ir-fallbacks --update-on-decrease`.

## 6. Open questions / risks

- **`coerceType` entanglement**: N3's ToPrimitive lives inside the 1100-line `coerceType`;
  step 2 extracts rather than rewrites — keep `coerceType(…, hint)` signature as a façade
  delegating to the engine to avoid touching its ~100 callers in one PR.
- **#1900 (in-review)**: if PR 1251 churns, step 2's SA tail target moves; the façade
  isolates this.
- **funcidx shifting**: engine tails registered via late imports must keep the
  `ensureLateImport`/`flushLateImportShifts` discipline (addUnionImports caveats in
  CLAUDE.md apply unchanged) — the engine centralizes this, removing a whole class of
  mid-body-registration index bugs (cf. comment at expressions/calls.ts:7950).
- **Bug-corpus issues remain individually fixable**: nothing here blocks #2005/#2006/etc.
  being fixed standalone first — but each such fix should land **as the engine row**
  (step 1 can split per-issue if sprint scheduling prefers), not as an eighth copy.
