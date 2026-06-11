# Value-Representation Migration Spec — retiring type-erasing lowering

**Date**: 2026-06-11 · **Author**: architect agent (fable) · **Status**: proposal
**Anchors**: #1852 (per-backend representation), #2072/#2080 (type-aware boxing, in-flight senior-dev),
#2051 (optional-chain widening), #2001 (holes), #2030/#2016/#2005 (boolean brand), #2004 (undefined erasure)

> Note on the in-flight work: the boxing fix is the #2072/#2080 bundle routed to
> senior-dev by commit `1bb8be691` ("type-unaware AnyValue boxing root cause; re-rated
> hard, routed senior"). The TaskList entry numbered 19 in the on-disk store
> (`~/.claude/tasks/cf8c9009-…/19.json`) is #1947 (for-of cap), **not** the boxing fix —
> phase 0 below refers to the #2072/#2080 bundle regardless of its task number.

---

## 1. The disease, precisely

The compiler picks a value's runtime representation from its **Wasm ValType kind**, not
its **JS type**. The JS type is then unrecoverable at every observing site (String(),
typeof, truthiness, `===`, `??`, `?.`), so each observer guesses — and guesses wrong for
every value whose JS type doesn't match the "default" inhabitant of its Wasm kind.

There are today **four distinct value-representation regimes**, none with a stated
invariant:

| Regime | Where | Carrier for dynamic values | JS-type recovery |
|---|---|---|---|
| JS-host (default) | `src/codegen/` | `externref`, host owns the value | host imports (`__is_truthy`, `__extern_toString`, `__to_primitive`, `__extern_is_undefined`) — correct, but every f64/i32 boundary crossing erases |
| Fast/standalone | `src/codegen/` with `ctx.fast` | `ref_null $AnyValue` tagged struct | tag field — **currently populated by Wasm kind, not JS type** (the #2072 bug) |
| Typed mainline | both | bare `i32`/`f64`/refs | static TS type at the consuming site (`ctx.checker.getTypeAtLocation`) — lost whenever the value flows through a typed carrier |
| Linear | `src/codegen-linear/` | none — `i32`/`f64` only, heap objects have a u8 `type_tag` header (`src/codegen-linear/layout.ts:6-11`) | not representable; **zero** `AnyValue`/`anyref` references in `src/codegen-linear/index.ts` |

### 1.1 The AnyValue struct and its tags (fast/standalone regime)

`src/codegen/any-helpers.ts:21-35` — `$AnyValue = struct { tag:i32, i32val:i32,
f64val:f64, refval:eqref, externval:externref }`. `any`/`unknown` lower to
`ref_null $AnyValue` **only in fast mode** (`src/codegen/index.ts:9119-9125`); non-fast
mode falls through to externref (`src/checker/type-mapper.ts:117-120`).

Current tag assignments (box helpers, `any-helpers.ts:216-326`):

| tag | meaning | payload | box helper |
|---|---|---|---|
| 0 | null | — | `__any_box_null` (:218) |
| 1 | undefined | — | `__any_box_undefined` (:234) |
| 2 | number (i32) | i32val | `__any_box_i32` (:250) |
| 3 | number (f64) | f64val | `__any_box_f64` (:266) |
| 4 | boolean | i32val | `__any_box_bool` (:282) |
| 5 | string | externval | `__any_box_string` (:298) |
| 6 | object/ref | refval (eqref) | `__any_box_ref` (:314) |

The tag set itself is **adequate**. The disease is that the generic boxing path
**selects the helper by Wasm kind** (`src/codegen/type-coercion.ts:1181-1217`):

- `i32` → `__any_box_i32` (tag 2 "number") — so `true as any` is tagged **number**
  (booleans lower to i32, `type-mapper.ts:49-56`)
- `externref` → `__any_box_string` (tag 5 "string") — so `undefined`/`null` (which
  lower to externref, `expressions.ts:843-851`) are tagged **string**
- `ref`/`ref_null` → `__any_box_ref` (tag 6 "object") — so a standalone native string
  (`ref $AnyString`, an eqref subtype) is tagged **object** (#2080)

Every tag consumer then mis-dispatches: `$__any_to_string`
(`src/codegen/native-strings.ts:5480-5558`, "[object Object]" else-arms at :5546/:5582),
`__any_typeof` (`any-helpers.ts:1076-1163` — comment at :1151-1152 even concedes "tag 5
would be 'string' but we don't use it in fast mode"), `__any_unbox_bool`
(`any-helpers.ts:384-443`, final arm `tag >= 5 → 1`, so empty string is truthy — #2080),
`__any_strict_eq` (`any-helpers.ts:902-916`, `tagA != tagB → 0`, so `0 === -0` fails
across tags 2/3 — #1987).

Only **literal fast-paths** box type-aware today: null/undefined/bool literals in an
AnyValue-expected context (`expressions.ts:550-607`) and i32-with-BooleanLike-TS-type
(`expressions.ts:659-668`). Everything reaching the generic `coerceType` arm is boxed
blind — `coerceType`'s signature (`type-coercion.ts:980-987`) carries **no TS-type
information at all**: `(ctx, fctx, from: ValType, to: ValType, toPrimitiveHint?,
compileStringLiteralFn?)`.

### 1.2 The boolean brand — two half-mechanisms

Mechanism A — **static checker consult at the consuming site**: `isBooleanType(tsType)`
(`src/checker/type-mapper.ts:287-289`) called with `ctx.checker.getTypeAtLocation(operand)`
right before stringification, e.g. concat (`src/codegen/string-ops.ts:1106-1107`,
:1384-1386, :1461-1462), assignment-concat (`src/codegen/expressions/assignment.ts:4129-4130`),
then `emitBoolToString` (`string-ops.ts:928-961`). 33 `isBooleanType` consults across
codegen; 8 `emitBoolToString` call sites. This works **only** when (a) the AST node is
at hand and (b) the checker types it `boolean` — it fails for `any` receivers
(`o.hasOwnProperty("x")` on `o: any` — #2016), for template spans that never consult it
(`string-ops.ts:272-284` pre-#2005), and for anything routed through a synthesized i32
result (`.done` → raw `{kind:"i32"}`, `property-access.ts:2712-2717`; `__hasOwnProperty`
import result, `object-ops.ts:3299` + siblings :3117/:3226/:3327).

Mechanism B — **ValType-level brand** (#1788): `{ kind: "i32", boolean: true }`,
declared in the `ValType` union itself (`src/ir/types.ts:114`), produced in exactly
**one** place (`type-mapper.ts:55`) and consumed in exactly **four**
(`src/codegen/index.ts:1791, 1827, 4409, 9140` — all struct-field getter boxing /
shape-dedup). The brand is "structurally inert — every `.kind === 'i32'` check still
matches" (comment at `type-mapper.ts:51-55`). There is also the precedent
`{ kind: "i64", bigint: true }` (#1644, `type-mapper.ts:44`, decision tracked in #2044).

So: the brand **exists at the right level** (it travels with the value through locals,
params, fields, returns — exactly where mechanism A dies) but has ~zero producers and
~zero consumers outside struct getters.

### 1.3 undefined/null erasure in numeric carriers

Three sub-mechanisms, partially contradictory:

1. **Plain erasure** — null→`f64.const 0`, undefined→sNaN sentinel in f64 contexts
   (`expressions.ts:477-491`); both → `i32.const 0` in i32 contexts (:487-490).
   AnyValue→f64 unboxing maps tag 1 → NaN, tag 0 → 0 (`type-coercion.ts:1230-1270`).
   CLAUDE.md documents this as a deliberate compromise ("avoids externref roundtrip").
2. **The sNaN sentinel `0x7FF00000DEADC0DE`** — a *de facto* undefined-observable f64
   carrier that already exists: produced by `pushParamSentinel`
   (`type-coercion.ts:2645-2653`), `defaultValueInstrs` f64 arm (:2656-2661 — "so
   destructuring default checks … trigger for OOB elements (#866)"), undefined-in-f64
   literals (`expressions.ts:482`), and 14 total sites across 8 files; **consulted** by
   destructuring default checks (`statements/destructuring.ts:483-487, 615-618`),
   `statements/loops.ts:1957`, `statements/nested-declarations.ts:1069`,
   `property-access.ts:1249`. Chosen as a *signaling* NaN precisely because JS
   arithmetic only produces the quiet NaN `0x7FF8000000000000`
   (comment `type-coercion.ts:2647-2648`).
3. **Host-assisted observability** — `__get_undefined` (28 sites) /
   `__extern_is_undefined` (67 sites) for externref carriers;
   `emitBoundsCheckedArrayGetUndef` (`destructuring-params.ts:150-165`) returns real JS
   undefined for OOB **but only for externref element types** — f64/i32 elements fall to
   the plain bounds-checked get (:156-158), which is exactly the #2001-addendum bug
   (`const [p, q] = [1]` → q is `0`). In standalone, `emitUndefined` falls back to
   `ref.null.extern` (`expressions/late-imports.ts:535-543`) — **undefined and null are
   the same bit pattern**.

The observers do **not** check the sentinel where it matters: `??` short-circuits
unconditionally on i32/f64 LHS ("can never be null/undefined",
`expressions/logical-ops.ts:188-191`), which is why `"ab".codePointAt(5) ?? -1` returns
NaN (#2004 — `STRING_METHODS.codePointAt` result declared `{kind:"f64"}`,
`index.ts:6322`); `===` against undefined never reinterprets f64 bits; stringification
prints the sentinel as "NaN".

Two further erasure factories:

- **Union collapse**: `T | undefined` (and `| null | void`) resolves to bare `T` for
  primitives — `resolveWasmType` (`index.ts:9108-9117`) and `mapTsTypeToWasm`
  (`type-mapper.ts:79-99`). The static type that *says* "undefined is possible" is
  thrown away at the type-mapping boundary.
- **Default-value fabrication**: optional-chain short-circuit arms push the result
  type's zero (`property-access.ts:1095-1102`; `expressions/calls-optional.ts:43-48`
  via `defaultValueInstrs`) — #2051; VOID_RESULT/error recovery paths push defaults
  (`expressions.ts:618-655`); `pushDefaultValue` (67 callers) emits real JS undefined
  only for externref-with-ctx (`type-coercion.ts:2568-2590`).

### 1.4 Truthiness dispatch

`ensureI32Condition` (`index.ts:11687-11749`, 15 callers) is the central ToBoolean:
f64 → `abs > 0` (NaN/±0 falsy — correct, and incidentally correct for the undefined
sentinel and the null-erasure 0); externref → host `__is_truthy`; AnyValue →
`__any_unbox_bool` (:11713-11721 — broken by wrong tags); native string → flatten +
length (:11724-11738). The dispatch *structure* is right; only the AnyValue helper and
the boxing feeding it are wrong.

---

## 2. Target representation

### 2.1 Canonical tag discipline

**One canonical JS-type tag enum, defined once, shared by every consumer** (new module
`src/codegen/value-tags.ts`, exported as `const enum JsTag` + a `jsStaticType(ts.Type)`
classifier):

| tag | JS type | payload field (GC) | notes |
|---|---|---|---|
| 0 | null | — | |
| 1 | undefined | — | |
| 2 | number (i32 repr) | i32val | tags 2,3 form one **numeric class** |
| 3 | number (f64 repr) | f64val | |
| 4 | boolean | i32val | |
| 5 | string | externval (host) / refval=`ref $AnyString` (native-strings) | one tag, two payload slots — dispatch on `externval == null` |
| 6 | object | refval (eqref) / externval (host objects) | |
| 7 | function | refval (closure struct) / funcref via wrapper | new; today closures box as tag 6 and `typeof` answers "object" |

**Invariant V1 (tag fidelity)**: *the tag always equals the value's ECMAScript type
partition* (`typeof` partition + null split out). No consumer may infer JS type from a
Wasm kind again.

**Invariant V2 (numeric class)**: tags 2 and 3 are one JS type. Every equality/
relational/typeof/ToString helper must treat `{2,3}` as a class: `__any_strict_eq` must
numerically compare across 2/3 (fixes #1987 `0 === -0`), `__any_loose_eq`'s "same tag"
gate (`any-helpers.ts:910, 919`) likewise, `__any_typeof` already groups them
(`any-helpers.ts:1129`).

**Invariant V3 (string payload)**: tag 5 means string in **both** string backends. The
native-string case stops being tag 6. `$__any_to_string`'s tag-5 arm
(`native-strings.ts:5531-5544`, currently externval-only) gains the refval branch;
`__any_unbox_bool` gains a tag-5 arm that flattens and checks length (`__str_flatten` +
len field, the exact pattern of `ensureI32Condition` at `index.ts:11726-11737`) —
fixes #2080 without a tag-6 special case.

**How the in-flight #2072/#2080 fix fits**: that bundle makes the *boxing* type-aware —
threading a TS-type hint into `coerceType(→AnyValue)` so booleans get tag 4,
null/undefined get tags 0/1, native strings get a recoverable string tag. Under this
spec it is **phase 0**: it establishes V1 at the producer side for the standalone
regime. What it does *not* cover (and what the later phases own): the canonical enum
extraction, the consumer-side class fixes (V2), tag-7 functions, the boolean brand
outside `any`, undefined observability in f64/i32 carriers, holes, host-regime boundary
erasure, and the linear backend.

### 2.2 The boxing API

Replace blind boxing with one entry point:

```ts
// src/codegen/value-tags.ts
type JsStaticType = "null" | "undefined" | "boolean" | "number" | "string"
                  | "object" | "function" | "unknown";
function jsStaticType(t: ts.Type, checker: ts.TypeChecker): JsStaticType;

// src/codegen/any-helpers.ts
function boxToAny(ctx, fctx, from: ValType, jsType: JsStaticType): void;
```

- `coerceType` gains an optional `jsType?: JsStaticType` param (351 call sites keep
  compiling — default `"unknown"`); the AnyValue arm (`type-coercion.ts:1179-1218`)
  delegates to `boxToAny`.
- `boxToAny` dispatch: known JS type → exact helper. `"unknown"` + `i32.boolean` brand →
  `__any_box_bool`. `"unknown"` + native-string ref → tag 5. `"unknown"` + externref →
  **runtime classify** in host mode (null check + `__extern_is_undefined` + host
  `__typeof_*`-style check) and tag 0/1/5 split in standalone (where externref can only
  be null/undefined/host-opaque). `"unknown"` + f64 → sentinel check (§2.4) then tag 3.
- The 11 direct `__any_box_*` call sites outside the helpers file (`expressions.ts`,
  `type-coercion.ts`) migrate to `boxToAny`.

The literal fast-paths at `expressions.ts:550-607` stay (they're correct and cheaper);
they become *consistency-checked* against `boxToAny` by tests, not deleted.

### 2.3 Boolean brand: extend mechanism B, demote mechanism A

Decision: **the ValType brand `{kind:"i32", boolean:true}` becomes the single carrier of
boolean-ness for bare i32 values**; the checker consult (`isBooleanType` at consuming
sites) remains only as a producer-side source for setting the brand and as a temporary
fallback. Rationale: the brand travels with the value (locals, params, fields, returns,
struct dedup already handles it — `index.ts:9134-9151`); the checker consult cannot see
through carriers and is unavailable for synthesized results. A ValType-level distinction
(a new `"bool"` kind) was considered and rejected: `boolean?: true` is already in the
`ValType` union (`ir/types.ts:114`), is structurally inert (zero risk to the 158
`as unknown as Instr` sites and every `.kind === "i32"` check), and #1788/#2044 set the
brand precedent. Revisit a real kind only at the IR seam (#1926 removes
ValType/typeIdx from IrType anyway).

Producers that MUST set the brand (today they return bare `{kind:"i32"}`):

- comparison/equality operators — `binary-ops.ts` result returns (the `compileComparison`
  / equality paths around :828-:1746)
- logical `!`, `&&`/`||` over booleans
- builtin predicates: `__hasOwnProperty` + siblings (`object-ops.ts:3117, 3226, 3299,
  3327` — #2016), `Array.isArray`, `includes`/`startsWith`/`endsWith`/`some`/`every`
  results, `Number.isNaN/isFinite/isInteger`
- `IteratorResult.done` (`property-access.ts:2712-2717` — #2030 first half)
- host-import declarations whose JS contract is boolean (audit `runtime.ts` import
  signatures)
- `jsStaticType`-driven: any site that consults `isBooleanType` to *emit* should set the
  brand on its returned ValType

Consumers that MUST read the brand (replacing/augmenting the checker consult):

- all 8 `emitBoolToString` call sites: condition becomes
  `valType.kind === "i32" && (valType.boolean || isBooleanType(tsType))`
- template spans (`string-ops.ts:272-284` — #2005 boolean half)
- `boxToAny` (§2.2) and `coerceType` i32→externref (`__box_boolean`,
  cf. `expressions.ts:670-679`)
- struct getter boxing (already does, `index.ts:4409`)

### 2.4 undefined/null observability — the decision procedure

**Soundness analysis of erasure** (which contexts may keep null→0 / undefined→NaN):

| Consuming context | null→0 | undefined→NaN | verdict |
|---|---|---|---|
| arithmetic (`+ - * / %`, Math.*) | ToNumber(null)=0 ✓ | ToNumber(undefined)=NaN ✓ | **sound** — erasure IS the spec coercion |
| relational `< > <= >=` | ✓ (0) | ✓ (NaN ⇒ false) | **sound** |
| ToBoolean (`if`, `!`, `&&`) | 0 falsy ✓ | NaN falsy ✓ | **sound** (`ensureI32Condition` f64 arm already NaN-safe, `index.ts:11693-11698`) |
| bitwise/shift, ToInt32 | ✓ | ✓ (NaN→0) | **sound** |
| `=== / !== undefined/null`, `Object.is` | ✗ (0 ≠ null) | ✗ (NaN ≠ undefined; also NaN≠NaN) | **unsound** |
| `==` null checks | ✗ (`null == 0` is false!) | ✗ | **unsound** |
| `??` / `?.` chaining | ✗ | ✗ (#2004) | **unsound** |
| `typeof` | ✗ ("number") | ✗ (#2051 t6) | **unsound** |
| ToString/template/concat/join | ✗ ("0") | ✗ ("NaN" not "undefined") | **unsound** |
| property key, JSON, re-boxing to any/externref | ✗ | ✗ | **unsound** |

**Carrier rule** (replaces the blanket union collapse at `index.ts:9108-9117` /
`type-mapper.ts:79-99`):

1. static type `number` → bare f64. No change.
2. static type `number | undefined` → **f64 + canonical sentinel**
   `UNDEF_F64 = 0x7FF00000DEADC0DE` (already the de facto sentinel — 14 sites; name it
   once in `value-tags.ts`, export `pushUndefF64()` / `emitIsUndefF64()`). Every
   producer of maybe-undefined f64 emits the sentinel (not qNaN): `codePointAt`-class
   builtins (#2004), exhausted `.value` (`__gen_result_value_f64`,
   `property-access.ts:2699-2704` + host shim `runtime.ts:8352-8360` — #2030),
   OOB f64 array reads in destructuring (`emitBoundsCheckedArrayGetUndef` f64 arm,
   `destructuring-params.ts:156-158` — #2001 addendum), optional chains over `number`
   (#2051, replacing the `f64.const 0` arms at `property-access.ts:1095-1102` and
   `defaultValueInstrs` at `calls-optional.ts:47`). Every **unsound-context observer**
   checks it: `===/!== undefined` on f64 operands, `??`/`?.` (delete the "can never be
   nullish" short-circuit at `logical-ops.ts:188-191` *when the LHS static type admits
   undefined*), `typeof`, ToString paths, and `boxToAny`'s f64-unknown arm (sentinel →
   `__any_box_undefined`). Sound contexts stay untouched — sentinel is a NaN, so
   arithmetic/relational/ToBoolean already behave.
   *Sentinel hygiene*: the bit pattern is a signaling NaN that JS arithmetic cannot
   produce (engines canonicalize to `0x7FF8…`); it does not survive arithmetic — which
   is correct, because post-arithmetic the value is spec-NaN, not undefined.
3. static type includes **null** observably (`number | null`,
   `number | null | undefined`), or `boolean | undefined` (i32 cannot sentinel) →
   **do not collapse**; lower to externref (host) / `ref_null $AnyValue` (standalone).
   0 cannot be a null sentinel (it's a real number), and a second NaN sentinel for null
   would make `null * 2` (= 0 per spec) need a normalize at every arithmetic sink —
   wrong trade. Widening is scoped: only unions, only where null must be observable.
4. `any`/`unknown`/heterogeneous unions → AnyValue (fast) / externref (host), as today.
5. **Standalone undefined singleton**: introduce an immutable global
   `$undefined : ref $AnyValue` (tag 1) and make standalone `emitUndefined` /
   `pushDefaultValue(externref-equivalent)` return it instead of `ref.null.extern`
   (`late-imports.ts:535-543`, `type-coercion.ts:2583-2590`), so undefined ≠ null in
   standalone reference contexts.

**Holes (#2001)**: for arrays with element type `ref_null $AnyValue` (i.e. `any[]`),
**null ref = hole** — distinct from a present tag-1 undefined box. HOF loops
(`array-methods.ts`, e.g. `compileArrayForEach` ~:5721) add a `ref.is_null` skip
(= spec `HasProperty` step, §23.1.3.15 7.b); `join` renders null-ref, tag-0 and tag-1
as `""` (§23.1.3.18). For typed `number[]`: holes are unrepresentable in TS's type
system anyway — **document the divergence** and instead reclassify at compile time:
an array literal containing elisions, or a write at index > length on a numeric
array, promotes the array's representation to the `any[]` (boxed) form. No side
bitmap (cost on every typed access for a TS-illegal pattern). `defaultValueInstrs`'s
f64-sentinel arm (`type-coercion.ts:2659-2661`) stays as the destructuring-default
bridge until promotion lands.

### 2.5 Per-backend mapping (#1852 alignment)

The canonical tag enum and the soundness table are **backend-independent policy**; only
the carrier differs. This is exactly #1852's "dynamic-residue representation chosen per
backend at the BackendEmitter seam (#1851)":

| | typed mainline | dynamic residue | undefined-observable number | strings |
|---|---|---|---|---|
| **WasmGC host** | bare i32/f64/refs (unchanged) | externref, host = source of truth; boundary boxing via `__box_number`/`__box_boolean`/`__get_undefined` (brand-driven) | f64+sentinel, host `undefined` at re-entry | externref (JS strings) |
| **WasmGC standalone** | same | `ref_null $AnyValue`, tags V1-V3; future `i31ref` smallint = tag-2 class member (#1852), `$undefined` singleton global | f64+sentinel → tag-1 box at boxing boundary | `ref $AnyString`, tag 5 via refval |
| **Linear** | bare i32/f64 (unchanged) | **f64-value + i32-tag parallel pair** (locals & 16-byte field slots for declared-dynamic fields), tag values = the same `JsTag` enum; strings/objects are heap pointers in the f64's low bits with tag disambiguating | f64+the same sentinel bit pattern (works identically in linear memory) | heap pointer + tag 5 |

Rules that hold on every backend: tag numbering is shared from `value-tags.ts` (the
linear backend imports the same enum — no second tag table like the ad-hoc
`0x02 Uint8Array` tag at `codegen-linear/index.ts:758`); the boxed/tagged form is
**interchange only** — unbox at the static-type boundary (per #1852: "we can do at
compile time what a runtime does per loop iteration"); typed numeric kernels must show
zero emitted-op regression (#1852 acceptance).

---

## 3. Migration phases

Each phase is an independently green PR train. Blast-radius figures are grep counts on
main @ `1bb8be691`.

**Phase 0 — IN FLIGHT (senior-dev, #2072/#2080): type-aware boxing.**
Scope per the issue investigations: thread a TS-type hint into the
`coerceType(→AnyValue)` arm (`type-coercion.ts:1178-1218`) so booleans→tag 4,
null/undefined→tags 0/1, native strings→recoverable string tag; teach
`$__any_to_string`/`__any_unbox_bool` whatever shape it normalizes to.
*This spec's later phases must NOT touch `type-coercion.ts:1178-1218`,
`native-strings.ts:5417-5586`, or `any-helpers.ts:384-443` until phase 0 merges.*
Phase 1 rebases on its API choice.

**Phase 1 — canonical tag module + boxing API consolidation.** Extract `JsTag`,
`jsStaticType`, `UNDEF_F64`, `boxToAny` into `src/codegen/value-tags.ts`; rewrite the
11 direct `__any_box_*` call sites and phase 0's hint plumbing onto `boxToAny`; add the
optional `jsType` param to `coerceType` (351 callers unaffected — optional param).
Tag 7 (function) lands here as enum + boxer; `__any_typeof` gains the "function" arm.
Blast radius: 3 files structural (any-helpers, type-coercion, expressions), 351
call sites untouched-but-recompiled. Fixes residue of #2072.

**Phase 2 — boolean brand unification.** Producers set `{boolean:true}` (≈6 operator
return sites in `binary-ops.ts`, 4 predicate returns in `object-ops.ts`
:3117/:3226/:3299/:3327, `.done` at `property-access.ts:2717`, predicate builtins
audit); consumers read it (8 `emitBoolToString` sites, template spans
`string-ops.ts:272-284`, `boxToAny`, i32→externref boxing). Fixes #2016, #2005 (bool
half), #2030 (done half). Blast radius: ~20 produce sites + ~12 consume sites; the 33
`isBooleanType` consults shrink as sites convert.

**Phase 3 — undefined observability.** (a) Producers emit `UNDEF_F64`: #2004
(`index.ts:6322` result + host shim NaN→sentinel), #2030 `.value`
(`runtime.ts:8352-8360`), #2001-addendum (`destructuring-params.ts:156-158` f64 arm),
#2051 short-circuit arms (`property-access.ts:1095-1102`,
`calls-optional.ts:43-48` — sentinel for f64, `$undefined`/`__get_undefined` for refs).
(b) Observers check it: `===/!== undefined` (binary-ops equality path), `??`
(`logical-ops.ts:188-191` — gate on static-type-admits-undefined), `typeof` f64 arm,
ToString f64 paths, `boxToAny` f64-unknown arm. (c) Stop collapsing Null-bearing unions
(`index.ts:9108-9117`, `type-mapper.ts:79-99`) per rule §2.4(3) — feature-flagged,
measured against test262 before default-on. Blast radius: ~10 producer sites, ~8
observer sites, plus the union-collapse change whose radius is *measured* (it changes
lowered types of `number|null` locals/params).

**Phase 4 — standalone helper conformance on canonical tags.** `__any_strict_eq` /
`__any_loose_eq` numeric-class {2,3} comparison (#1987, and the `any`-vs-number mixed
`===` lowering in `binary-ops.ts` — #1986); `__any_unbox_bool` tag-5 length arm
(#2080 residue); `$__any_to_string` tag-5 refval branch; `$undefined` singleton global
+ standalone `emitUndefined` (`late-imports.ts:541`); `__any_typeof` tag-5/6/7 arms
(`any-helpers.ts:1151-1152`). One file dominates (any-helpers.ts); cross-helper dep on
`__str_flatten` uses the established `ensureNativeStringHelpers` + late-import-shift
protocol (#2043 tracks retiring that hazard class).

**Phase 5 — holes (#2001).** null-ref-as-hole for `any[]` + HOF `HasProperty` skips in
`array-methods.ts` (forEach/map/filter/reduce/join loops; 4 `defaultValueInstrs` uses
at :276/:5385/:5521/:5673 reviewed); sparse-literal/sparse-write promotion to boxed
representation; documented typed-`number[]` divergence.

**Phase 6 — linear backend + IR seam (#1852/#1851).** `BackendEmitter` trait method for
union/boxed lowering; linear f64+i32-tag pair using the shared `JsTag`; cross-backend
differential tests (#1854). Depends on #1851; explicitly last — nothing earlier blocks
on it, and phases 1-5 hand it a single tag policy to implement instead of today's four
regimes.

Ordering constraints: 1→2 and 1→3 (both consume `value-tags.ts`); 2 and 3 are
parallelizable; 4 needs 1 (enum) and benefits from 0's merge; 5 independent after 1;
6 last.

---

## 4. Regression guardrails

Each phase lands its probe table as a permanent equivalence test (host **and**
standalone/fast lanes — the sweeps showed the lanes fail differently), file pattern
`tests/value-repr-<area>.test.ts`:

- **T-string** (phase 0/1/4): `String(v)`, `"" + v`, `` `${v}` `` for
  `v ∈ {42, -0, 1.5, true, false, "", "x", null, undefined, {}, [1,2], () => 1}` both
  direct-typed and `any`-boxed. (From #2072/#2005/#2006 repros; catches tag-fidelity
  and brand regressions.)
- **T-typeof** (1/4): `typeof v` over the same vector, direct and any-boxed (catches
  the `typeof (true as any)` trap class).
- **T-truth** (4): the truthiness table `[0, -0, NaN, "", "0", null, undefined, [], {}]`
  via `v ? "T" : "F"`, direct and any-boxed (#2080's flipped index 3).
- **T-eq** (3/4): `===`/`==` matrix — `0 === -0` (any), `null == undefined`,
  `null == 0` (false!), `false === 0` (false), `"1" === 1` (false), `x === undefined`
  after optional chain / OOB read (#1986/#1987/#2051).
- **T-iter** (2/3): the #2030 generator drain string
  (`"1,false,2,false,3,true,undefined,true"`).
- **T-undef** (3): `codePointAt(oob) ?? -1`, `o?.v` table (t4/t6 of #2051),
  `const [p,q] = [1]` / `const [a=5,b=6] = [undefined, null]` stringification (#2001
  addendum), `hasOwnProperty` concat (#2016).
- **T-holes** (5): `[1,,3].forEach` count, `b[5]=9; b.join(",")` (#2001).
- **T-backend** (6): the #1854 cross-backend differential harness runs T-string/T-eq/
  T-truth on linear vs WasmGC.

CI: these are ordinary `tests/equivalence.test.ts`-style vitest files (PR-blocking via
the `quality` check), unlike the non-failing test262 dashboard. Each phase's PR also
cites its expected test262 buckets so `/dev-self-merge`'s bucket analysis can confirm
direction (e.g. phase 3 should move `language/expressions/optional-chaining/*` and
`built-ins/String/prototype/codePointAt/*`).

---

## 5. Risks / open questions

1. **Union-collapse reversal (phase 3c)** is the only phase with uncertain test262
   delta — hence the feature flag + measure-first protocol. Everything else replaces
   known-wrong values with known-right ones.
2. **Sentinel collision**: a hostile bit-pattern via `Float64Array`/DataView
   reinterpretation could forge `UNDEF_F64`. Accepted (documented) — same acceptance
   every NaN-boxing VM makes; the typed-array read path can canonicalize
   (`f64.ne` self-check → qNaN) if it ever bites.
3. **`boolean?: true` brand erosion**: ValType literals are constructed ad-hoc all over
   codegen; a copied `{kind:"i32"}` drops the brand. Mitigation: T-string/T-iter probes
   + a lint-style grep ratchet on predicate-returning sites, and the IR path (#1926+)
   eventually owns types centrally.
4. **Late-import index shifts** (phase 4's cross-helper deps) — the known #2043 hazard;
   use existing `flushLateImportShifts` discipline.
5. **typeof "function" (tag 7)** requires distinguishing closure structs from plain
   structs at boxing time — available statically at every boxing site via
   `jsStaticType`; runtime-side `ref.test` against closure struct types is bounded
   (closure shapes are compiler-generated).
