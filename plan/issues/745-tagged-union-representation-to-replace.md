---
id: 745
title: "Tagged union representation to replace externref boxing"
horizon: xl
status: ready
model: fable
fable_role: implement
created: 2026-03-22
updated: 2026-07-19
priority: high
feasibility: hard
model: fable
reasoning_effort: max
goal: performance
sprint: current
related: [1624, 2104, 2105, 2106, 2107, 2141, 2949, 1852, 1471, 1917, 743, 744]
# S2 flag plumbing (CompileOptions -> CodegenOptions -> ctx) + the resolveWasmType
# mapping necessarily touch the option/driver files; the predicate itself lives
# in the subsystem module (src/checker/type-mapper.ts).
# (S3 adds the consumer-site fixes — each must live at its existing dispatch
# site in these budgeted modules.)
loc-budget-allow:
  - src/codegen/context/types.ts
  - src/codegen/context/create-context.ts
  - src/codegen/index.ts
  - src/compiler.ts
  - src/codegen/binary-ops.ts
  - src/codegen/type-coercion.ts
  - src/codegen/any-helpers.ts
  - src/codegen/string-ops.ts
  - src/codegen/expressions/identifiers.ts
  - src/codegen/value-tags.ts
  - src/codegen/expressions/misc.ts
# S3's declared-union equality routing needs SYMBOL resolution (declared vs
# narrowed type) — explicitly outside the oracle's v1 scope (#1930 D3). The
# predicate body lives in src/checker/type-mapper.ts; the single ctx.checker
# occurrence below is the argument at the call site.
oracle-ratchet-allow:
  - src/codegen/binary-ops.ts
  - src/codegen/expressions/identifiers.ts
files:
  src/codegen/index.ts:
    new:
      - "defineTaggedUnionType(): create WasmGC struct for tagged unions"
      - "tagged union helper functions: tag checks, value extraction"
  src/codegen/type-coercion.ts:
    breaking:
      - "replace externref boxing with tagged union struct for known union types"
  src/codegen/expressions.ts:
    breaking:
      - "binary/unary ops on tagged unions: branch on tag, dispatch to typed path"
---

# #745 — Tagged union representation to replace externref boxing

## Status: in-progress — design decided 2026-07-16, see `## Design Decision` below

**S4.5 landed (2026-07-19):** `unionAnyRep` lane-default flipped **ON** for
native-string lanes (standalone / wasi / fast / strictNoHostImports /
`nativeStrings`) at `create-context.ts`; host (JS-host) lane stays default-OFF
until S5 (hard-gated on #2141). Explicit option > `JS2WASM_UNION_ANYREP=0`
kill-switch > lane default. Epic remains in-progress (S5/S6 pending).

## Problem

Currently, any value whose type can't be resolved to a single Wasm primitive becomes `externref`. Operations on `externref` require JS host calls (`__box_number`, `__unbox_number`, `__any_add`, etc.) — each costing a cross-boundary call.

For values that are a _known_ union of Wasm-representable types (e.g., `number | string`, `number | null`), we can use a WasmGC struct with a type tag instead — keeping everything in pure Wasm with no host calls.

## Approach

### Tagged union struct layout

```wasm
(type $tagged_union (struct
  (field $tag (mut i32))         ;; 0=f64, 1=i32, 2=string, 3=null, 4=ref, ...
  (field $f64_val (mut f64))     ;; populated when tag=0
  (field $i32_val (mut i32))     ;; populated when tag=1
  (field $ref_val (mut anyref))  ;; populated when tag=2,4 (strings, objects)
))
```

### Operations on tagged unions

Instead of calling `__any_add(externref, externref) → externref`:

```wasm
;; a + b where both are tagged unions
(block $done (result f64)
  ;; Fast path: both are f64
  (br_if $done
    (f64.add
      (struct.get $tagged_union $f64_val (local.get $a))
      (struct.get $tagged_union $f64_val (local.get $b)))
    (i32.and
      (i32.eqz (struct.get $tagged_union $tag (local.get $a)))
      (i32.eqz (struct.get $tagged_union $tag (local.get $b)))))
  ;; Slow path: coerce and add
  ...
)
```

### When to use

- After whole-program analysis (#743): if a variable's type resolves to a union of 2-3 concrete types, use a tagged union instead of externref
- For function parameters that receive different types at different call sites but monomorphization (#744) isn't worthwhile (large functions)
- For collection elements: `Array<number | string>` → `vec (ref $tagged_union)` with fast numeric path

### Performance model

| Operation  | externref (current)    | Tagged union           |
| ---------- | ---------------------- | ---------------------- |
| Arithmetic | 2 JS host calls        | 1 branch + native op   |
| Comparison | 1 JS host call         | 1 branch + native op   |
| Type check | 1 JS host call         | 1 i32 compare          |
| Boxing     | 1 allocation + JS call | 1 struct.new (Wasm GC) |

### Interaction with other issues

- #743 (whole-program analysis) determines which variables are known unions vs truly dynamic
- #744 (monomorphization) is preferred for small functions; tagged unions for large functions and collections
- Replaces need for `__any_add`, `__any_sub` etc. host helpers for known-union cases

## Complexity: XL

## Implementation Plan

(Author: architect, 2026-05-21. **Important**: #1552 is a newer
issue that supersedes parts of this with a single uniform `$Value`
struct. Recommend closing #745 in favour of #1552 unless there's a
reason for the per-union-type custom struct described here.)

### Coordination

This issue and #1552 describe overlapping designs:

- **#745 (this issue)**: Per-distinct-union-type custom struct
  with only the fields needed for that union (e.g.
  `number | string` gets `{tag, f64, ref}`).
- **#1552**: A single universal `$Value` struct covering ALL
  union types in the program.

#1552 is simpler (one type for everything) and easier to optimize
(predictable layout, JIT-friendly). #745 is space-efficient (no
unused fields) but generates many struct types and complicates
codegen branching.

**Architect recommendation**: Adopt #1552's universal design.
Close #745 as superseded once #1552's Implementation Plan is
approved.

### If #745 is kept

Follow the algorithm in #1552's Implementation Plan but generate
one struct type per distinct union signature observed (signature
= sorted set of member types). Helper functions become parametric
over the struct type. Add a `ctx.unionTypes:
Map<signature, typeIdx>` to dedup.

### Dependencies

- **#1552** — supersedes; coordinate.
- **#743** — required to identify union types.
- **#744** — monomorphization; complementary.

### Risk

Two competing designs in the backlog. Decide before any code
ships.

---

## Design Decision (slice 1, 2026-07-16, fable-gamma)

**DECIDED: reject this issue's original per-union-signature structs. Known
heterogeneous unions adopt the existing universal `$AnyValue` carrier**
(`{tag:i32, i32val:i32, f64val:f64, refval:eqref, externval:externref}`,
`ensureAnyValueType` in `src/codegen/any-helpers.ts`) **with the canonical
`JsTag` enum** (`src/codegen/js-tag.ts`, #2104/#2949). The issue is NOT
obsolete — its perf premise still reproduces on main (evidence below) — but
its layout/design section above is superseded.

### Stale cross-refs, corrected

- The architect note above says "superseded by **#1552**". That design was
  **renumbered to #1624** (`renumbered_from: 1552`; today's #1552 is an
  unrelated, done catch-dstr issue). #1624 itself is `wont-fix`, superseded
  by the 2026-06 value-rep program: #2104 (JsTag module, done), #2105
  (boolean brand, done), #2106 (undefined observability, in-progress),
  #2107 (standalone any-helper conformance, done).
- #1624's supersede note cites "**#2140** (tag-5 ABI untangle)" — that id
  was also reused; the tag-5 ABI untangle is **#2141** (in-progress,
  sprint current). Fixed in #1624 in this PR.
- The "#1552 universal `$Value`" design was never lost: it shipped
  incrementally as `$AnyValue` + the value-rep program. What NEVER shipped
  — and is the live remainder of THIS issue — is routing _statically-known_
  heterogeneous unions onto that carrier.

### Verified current-main reality (probe: `.tmp/probe-745-union.ts`, main 3186699e68)

1. `resolveWasmType` (`src/codegen/index.ts:5462-5471`) only unwraps
   `T | null/undefined/void` (2-member). Any other union falls through to
   `mapTsTypeToWasm` → **externref, in every lane**.
2. `any`/`unknown` already maps to `ref_null $AnyValue` — but **only under
   `ctx.fast`** (`index.ts:5476-5479`). Non-fast lanes: externref.
3. **Default (JS-host) lane WAT** for `let x: number | string`: every write
   is a host `__box_number` call, every read `__unbox_number`, every
   `typeof` guard `__typeof_number` — 1-2 JS boundary crossings per op.
   This is the issue's original claim; it still holds verbatim.
4. **Standalone lane** (#1471): same externref shape, but helpers are
   Wasm-native — each op is still a call + `extern.convert_any`/
   `any.convert_extern` round-trip + `ref.test` + a fresh single-field
   box-struct allocation per write. No host calls, but none of the tag
   fast paths this issue wants either.

### Why $AnyValue, not per-union structs

- **The D4 audit rule** (June audit, quoted in `src/codegen/js-tag.ts`):
  "never mint a second tag/boxing table". Per-union structs are exactly
  that — a parallel tagged rep needing its own eq/typeof/truthiness/
  ToPrimitive machinery plus interconversion at every union↔any boundary
  (assigning a union var into an `any` context is ubiquitous).
- All consumers already exist and are hardened: `__any_strict_eq`,
  `__any_typeof`, `$__any_to_string` conform to canonical tags (#2107);
  tag-agnostic consumer work is #2141; `$undefined` singleton is #2106.
- The IR lattice (#2949) grows `{kind: "dynamic", tag?: JsTag}` over the
  SAME carrier — a known union is just a dynamic value with a statically
  known tag SET (e.g. `number | string` ⇒ tags ⊆ {NumberI32, NumberF64,
  String}), enabling 2-way branch codegen instead of full dispatch. The
  per-union-struct design has no story there.
- Space cost of unused $AnyValue fields is minor vs. a type per union
  signature + parametric helper clones.

### Migration strategy (per-rep-site, flagged, byte-diff-gated)

Adoption is gated per lane and per site behind `ctx.unionAnyRep`
(internal flag, like #2119's pattern), with a **byte-diff neutrality gate**
in the #1917 style: modules containing no heterogeneous union must emit
byte-identical wasm with the flag on. Broad-impact slices validate via
full CI/merge_group only (never scoped sweeps).

### Slice plan (dispatchable)

- **S2 — standalone/nativeStrings locals** (L): in `resolveWasmType`, map
  heterogeneous PRIMITIVE-ONLY unions (members ⊆ {number, string, boolean,
  null, undefined} after literal widening) to `ref_null $AnyValue` when
  `ctx.nativeStrings || target standalone`; producers route through
  `boxToAny` (#2104); consumers: typeof lowering (`typeof-delete.ts`),
  truthiness, `coerceType` unbox reads. Byte-diff gate for union-free
  modules. Function-LOCAL variables only (no signature changes).
- **S3 — narrowing fast paths** (M): typeof-guarded reads lower to
  `struct.get $AnyValue tag` compare + direct payload `struct.get` (no
  call, no alloc); `===`/`==` route to `__any_strict_eq`; arithmetic on
  tag-narrowed values uses the f64val/i32val payload directly.
- **S4 — union params/returns** (L): extend to function signatures +
  union↔any (no-op — same carrier) and union↔host boundaries (externalize
  only at the boundary, per the existing $AnyValue coercion paths in
  `type-coercion.ts`). Watch `addUnionImports` index-shift (CLAUDE.md).
- **S5 — default (JS-host) lane flip** (L, **gated on #2141 landing**):
  same mapping without the nativeStrings gate. A union value flowing into
  any-consumers must not recreate the #1888 tag-5 comparator incident
  (−794 tests) — hence the hard gate on the ABI untangle.
- **S6 — endgame** (M): retire `__box_number`/`__unbox_number`/
  `__typeof_*` imports from modules that no longer reference them
  (#1624 Phase D equivalent); simplify `addUnionImports`.

### Risks

- Blast radius: every union-typed path. Mitigation: flag + lane phasing +
  byte-diff neutrality + full-CI validation per slice.
- #1888-class ABI incidents at union↔any/host boundaries — S5 hard-gated
  on #2141.
- Late-import func-index shifts when helpers register — use the
  name-based repoint patterns (#1461/#2191/#2193 memories).
- #2040 dstr-default regression guard applies to any tag-classifier
  change.

### Coordination

- **#2949** (IR dynamic rep, fable-11th, in-progress): shares the carrier
  and JsTag; this issue is codegen-lane adoption, #2949 is IR-lattice
  adoption. The tag-SET refinement idea above should feed #2949's spec.
- **#2141** (tag-5 ABI untangle, in-progress): blocks S5 only.
- **#743/#744** (whole-program analysis / monomorphization, Backlog):
  complementary optimizations, NOT dependencies — TS checker union types
  suffice to identify candidates.

## S2 landed (2026-07-16, fable-gamma) — opt-in mapping + measured consumer gap-list

S2 shipped as an **opt-in** `unionAnyRep` flag (default OFF, mirroring the
#2141 `honestAnyBoxing` pattern) rather than lane-default-on, because probing
the mapping against real consumers measured exactly which ones are not yet
carrier-agnostic. What landed:

- `isHeterogeneousPrimitiveUnion` (`src/checker/type-mapper.ts`) — the narrow
  predicate (≥2 distinct kinds among number/string/boolean after nullish
  filtering; rejects bigint/symbol/enum/object members and homogeneous or
  literal unions).
- The `resolveWasmType` mapping (`src/codegen/index.ts`, union block):
  qualifying unions → `ref_null $AnyValue` when `ctx.unionAnyRep`.
- Flag plumbing: `CompileOptions.unionAnyRep` → `CodegenOptions` →
  `ctx.unionAnyRep` (default false).
- `tests/issue-745.test.ts` — byte-identity gates (flag-off ≡ legacy on
  union-bearing input in BOTH lanes; flag-on ≡ flag-off on union-free,
  nullable, and literal-union input) + flag-on standalone behaviour for
  narrowed patterns + predicate unit tests.

**Verified working with flag ON (standalone), via existing coercion arms
alone**: typeof-narrowed reads/writes (`sum += x + 1` under a guard),
narrowed `.length` string reads, `x === undefined` checks and
undefined round-trips, cross-kind reassignment in loops. Zero host imports.

**Measured NOT working with flag ON (standalone) — this is the concrete S3
work list** (probe: `.tmp/probe-745-run.mts`):

| Pattern                                  | Symptom                                               | Likely site                                                                                                                                                      |
| ---------------------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `x === "done"` (union vs string literal) | wrong result (0)                                      | binary-ops strict-eq path assumes externref union rep; must route `$AnyValue` operands to `__any_strict_eq`                                                      |
| `if (x)` truthiness                      | wrong result                                          | truthiness coercion lacks a `$AnyValue` tag-switch arm                                                                                                           |
| `x === true` (boolean\|string)           | wrong result                                          | same strict-eq path, boolean payload                                                                                                                             |
| `"" + x` / `s + x` string concat         | `illegal cast` trap                                   | concat lowers via native-string cast on the raw ref; needs `$__any_to_string` for `$AnyValue` operands                                                           |
| union-typed PARAM at call boundary       | Wasm validation error (`struct.get[0] expected type`) | param ValType flips to `$AnyValue` but call-site argument coercion emits the old shape — S4 territory; consider excluding params/returns until S4                |
| `return k > 0 ? 7 : "neg"` union RETURN  | wrong result                                          | return-path coercion, same S4 territory                                                                                                                          |
| union → `any` assignment                 | wrong result                                          | any-boundary coercion arm ($AnyValue→externref-any) mis-round-trips in standalone; check `ensureAnyToExternHelper` unwrap vs `extern.convert_any` of the carrier |

S3 (revised): make the strict-eq / truthiness / concat consumers
carrier-agnostic (first three rows). S4 (unchanged): params/returns +
boundaries (last three rows). Flip `unionAnyRep` lane-default-on for
standalone/nativeStrings only after BOTH, validated by full CI/merge_group.

## S3 landed (2026-07-16, fable-gamma successor) — carrier-agnostic eq / truthiness / concat

The first three rows of the S2 gap table now behave correctly with the flag ON
(standalone), via five consumer-site fixes (all flag-gated except the first,
which is a #1988-class latent bug fix):

1. **type-coercion** `ref_null $AnyValue → ref_null $X` unbox arm: reads the
   tag-5 payload from `externval` (field 4) for native-string targets —
   mirroring the #1988 fix that only covered the `→ ref` (non-null) arm. Root
   cause of `union === "lit"` answering false after assignment narrowing.
2. **binary-ops** equality gate: an operand whose use-site OR declared symbol
   type is a heterogeneous primitive union routes `==/===/!=/!==` through
   `__any_strict_eq`/`__any_eq` (the both-`any` dispatch). Declared-type check
   needed because assignment/literal narrowing re-types the use site while the
   value stays in the $AnyValue carrier. Nullish counter-operands excluded
   (their existing paths work).
3. **any-helpers** `__any_unbox_bool`: corrected tag-5 truthiness arm
   (ToBoolean("") is false) — recovers externval, `flatten().length > 0`;
   non-string tag-5 carriers keep legacy truthy. Native lane, flag-gated.
4. **coercion-engine** eq marshal: statically-boolean i32 operands box tag-4
   via the `boxToAny` "boolean" hint (kind-keyed boxing produced tag-2, so
   `union === true` compared tag-4 vs tag-2 → false). Flag-gated.
5. **string-ops** concat operand: `$AnyValue` carriers are excluded from the
   string passthrough and route via `$__any_to_string` (the passthrough made
   the caller emit an always-trapping incompatible cast).

Verified (probes + `tests/issue-745.test.ts` S3 suite, 19/19): narrowed and
un-narrowed strict-eq vs string/number literals, union-vs-union eq, boolean
union `=== true`, empty/non-empty/0 truthiness, both concat narrowing shapes,
nullish regression guard, host-import-free. Flag-off byte-identity to pristine
main re-verified after the changes.

**S4 (unchanged scope)** — params/returns + boundaries (rows: union PARAM at
call boundary Wasm validation error; union RETURN wrong result; union → `any`
assignment wrong result).

## S4 landed (2026-07-16, fable-gamma successor) — params/returns/any-boundary

The last three gap-table rows now pass with the flag ON (all 10 probe rows
green). Three flag-gated fixes:

1. **identifiers** read-site narrowing unbox: an `$AnyValue` union local/param
   narrowed to a single kind at the use site unboxes AT THE READ (number →
   `__any_to_f64`, string → the S3-fixed externval coercion, boolean →
   `__any_unbox_bool` with the i32 boolean brand). Oracle-classified
   (`typeFactOf`); declared-union-gated so fast-lane `any` locals keep their
   read path. Fixes the union-PARAM invalid `struct.get` and the union→any
   boundary rows (the boundary boxes the concrete rep honestly).
2. **value-tags** `boxToAny`: boolean-branded i32 boxes tag-4 under the flag
   (kind-keyed dispatch produced tag-2).
3. **misc** ternary join: a mixed-kind conditional whose own type-fact is a
   heterogeneous primitive union joins on `ref_null $AnyValue` with per-arm
   static boxing (honest tags) instead of the externref join + legacy #1888
   tag-5 re-box that made a returned number `typeof`-report as string.

Remaining #745 ladder: S5 (default-lane flip, HARD-GATED on #2141) and S6
(endgame import retirement). The flag itself stays opt-in until S5.

---

## Implementation Plan — Slice S4.5 (Fable, lane-default flip)

**One PR, Opus-buildable, zero design decisions left.** Flip `unionAnyRep`
**default ON for native-string lanes** (standalone / wasi / fast /
strictNoHostImports / explicit `nativeStrings`); the default (JS-host) lane
stays default-OFF until S5. This is the issue's own designated next rung
("Flip `unionAnyRep` lane-default-on for standalone/nativeStrings only after
BOTH [S3+S4]" — both landed 2026-07-16), and the highest-leverage step: it
turns three landed-but-dormant opt-in slices into live production behavior,
puts the carrier under full test262 standalone-floor scrutiny, and produces
the empirical gap list S5 (host lane, gated on #2141 — still in-progress as
of this spec) needs. Verified against main `871c0e0d3`.

### Design decisions (resolved — do not re-litigate)

1. **Lane predicate = the computed `nativeStrings` const**
   (`create-context.ts:34-36`), NOT `standalone` alone. Rationale: the S3
   truthiness fix (`any-boxing-helpers.ts:335`) already keys on native-string
   machinery; #2106 `undefinedSingleton` flipped the SAME lane set and the
   carrier regime must stay lockstep with the undefined-singleton regime.
   Documented fallback if `merge_group` shows fast/wasi-ONLY regressions:
   narrow the predicate to `!!(options?.standalone || options?.wasi)`
   (one-line change; say so in the PR body). Do not start narrow.
2. **Precedence: explicit option > env kill-switch > lane default.** Exact
   #2106/`undefinedSingleton` pattern (`create-context.ts:301`); kill-switch
   env var name: `JS2WASM_UNION_ANYREP` (`=0` forces legacy for A/B).
3. **No exported-function carve-out.** Union-typed params/returns on EXPORTED
   functions flip to `ref_null $AnyValue` uniformly. Precedent: `ctx.fast`
   has mapped `any` — including exported-fn params — to `$AnyValue` for a
   long time (`index.ts:5513`); native-lane harness entry points are
   top-level/nullary, so no runner calls union-param exports with raw JS
   values. A carve-out would create a MIXED rep inside one module, and the
   consumer gates are TS-type-keyed, not ValType-keyed
   (`binary-ops.ts:791-802` routes on `isHeterogeneousPrimitiveUnion` of the
   static/declared type) — an externref-repped union operand would then be
   routed into `$AnyValue` machinery, strictly worse than uniformity.
4. **The S2 neutrality invariant is REVISED, not preserved.** After the flip,
   byte-identity to legacy holds for native-lane modules that are union-free
   AND do not emit `__any_unbox_bool`. Two **intended** drift classes go
   default-live module-wide (not just in union-bearing code):
   - `__any_unbox_bool` tag-5 truthiness arm (`any-boxing-helpers.ts:335`):
     ToBoolean("") correctly false for tag-5 string carriers (spec-correct;
     was a flag-gated latent-bug fix).
   - Honest tag-4 boolean boxing (`value-tags.ts:188`,
     `coercion-engine.ts:488`): boolean-branded i32 `boxToAny` emits the
     canonical JsTag boolean tag instead of tag-2. Both are steps toward the
     #2104/#2141 canonical-tag regime.

### Changes

**File: `src/codegen/context/create-context.ts`** (~line 171-173) — the core
one-liner. Replace:

```ts
// (#745 S2) union→$AnyValue rep: opt-in while consumers are made
// carrier-agnostic (S3); flips lane-default later (see types.ts doc).
unionAnyRep: options?.unionAnyRep ?? false,
```

with:

```ts
// (#745 S4.5 default-flip) union→$AnyValue rep — default ON in
// native-string lanes now that the S3 (eq/truthiness/concat) and S4
// (params/returns/any-boundary) consumer sweeps landed. Host (JS-host)
// lane stays default-OFF until S5 (hard-gated on #2141). Explicit option
// wins; set JS2WASM_UNION_ANYREP=0 to force the legacy externref union
// regime for A/B control (mirrors JS2WASM_UNDEF_SINGLETON, #2106).
unionAnyRep: options?.unionAnyRep ?? (nativeStrings && process.env.JS2WASM_UNION_ANYREP !== "0"),
```

(`nativeStrings` is the already-computed const at line 34 — it is in scope.)

**File: `src/codegen/context/types.ts`** — update the two doc comments
(line ~108 `CodegenOptions.unionAnyRep` and the ~1918-1924 block) from
"opt-in / flips lane-default later" to "default derived from lane
(nativeStrings); host lane opt-in until S5; env kill-switch
JS2WASM_UNION_ANYREP=0". No code change.

**File: `src/index.ts`** (~line 330) — same doc-comment update on the public
`CompileOptions.unionAnyRep`.

**File: `plan/issues/745-tagged-union-representation-to-replace.md`** —
frontmatter `loc-budget-allow`: add `src/codegen/context/create-context.ts`
(not currently on the list; the flip's one-liner lives there).

**File: `tests/issue-745.test.ts`** — rework the gates to the new regime:

1. Keep unchanged: "union-bearing input, default lane: explicit false ===
   unset" (host default is still OFF — this test must stay green as-is).
2. REPLACE "union-bearing input, standalone lane: explicit false === unset"
   (now false by design) with three tests:
   - `standalone lane: unset === explicit true (default-on proof)` —
     byte-compare `{target:"standalone"}` vs
     `{target:"standalone", unionAnyRep:true}` on `HET_UNION_SRC`.
   - `standalone lane: explicit false !== unset on union-bearing input
     (opt-out is live)` — byte-inequality of the same pair with
     `unionAnyRep:false`.
   - `env kill-switch: JS2WASM_UNION_ANYREP=0 ≡ explicit false` — set
     `process.env.JS2WASM_UNION_ANYREP = "0"` in a try/finally (delete
     after; the env is read per-compile at ctx creation, so no cross-test
     bleed), compile unset-standalone, byte-compare to `unionAnyRep:false`.
3. "flag ON, union-free input stays byte-identical" suite: unchanged (still
   must hold — the mapping and every consumer gate require a het-union type;
   `UNION_FREE_SRC` does not emit `__any_unbox_bool`). Add a guard comment
   noting the revised invariant (decision 4) so a future union-free-but-
   any-truthiness-using fixture isn't added here by mistake.
4. S2/S3/S4 behavior suites: change each `run()` helper to DROP
   `unionAnyRep: true` (they now prove the DEFAULT), and keep exactly one
   explicit `unionAnyRep: true` case per suite (option still honored). The
   host-import-free instantiation tests likewise run flag-unset.
5. ADD a wasi smoke: compile `HET_UNION_SRC` with `{wasi: true}`; assert
   success and that no `env.__box_*`/`__unbox_*`/`__typeof_*` import remains
   (execution under a WASI shim not required).

### Edge cases

- **Host lane + explicit `unionAnyRep: true`**: unchanged semantics
  (pre-S5 preview; unsupported until #2141 — same as today).
- **Env var read**: once per compile at context creation — no caching across
  compiles; safe for in-process A/B (the vitest env test relies on this).
- **`fast` lane**: `any` is already `$AnyValue` there; the flip only adds
  het-union locals onto the same carrier/helpers. Covered by the dedicated
  fast suites (`i32-fast-mode`, `fast-arrays`, `gradual-typing`) in
  `quality`.
- **`process.env` access**: `create-context.ts` already reads `process.env`
  at the adjacent lines (`JS2WASM_TAG5_CLASSIFIER`,
  `JS2WASM_UNDEF_SINGLETON`) — same exposure, no new hazard.

### Test plan

1. `npm test -- tests/issue-745.test.ts` — full reworked suite green.
2. Scoped adjacents: any-helpers/JsTag-adjacent suites (#2104/#2106/#2107
   test files), the fast suites above, and the #2040 dstr canaries
   (tag-classifier-adjacent, see risk 2).
3. `prove-emit-identity` (playground corpus): drift expected ONLY in
   standalone/wasi/fast emits of files containing het unions or
   any-truthiness; host-lane emits byte-identical. Paste the drift list in
   the PR body and check each file against the two intended drift classes.
4. **Full `merge_group` + standalone-floor — broad-impact; NEVER a scoped
   sweep.** Net ≥ 0, no bucket > 50; watch the standalone-floor signature.
5. If the floor regresses: re-run locally with `JS2WASM_UNION_ANYREP=0` to
   confirm attribution to the flip before touching anything.

### Regression risks (ranked) + rollback

1. `__any_unbox_bool` truthiness drift on NON-union any-code (most likely
   unexpected-flip source; a regression there is fixed in the tag-5 arm of
   `any-boxing-helpers.ts`, not by re-gating the flag).
2. Tag-4 boolean-boxing honesty vs. consumers expecting legacy tag-2 boxed
   booleans — the #2040 dstr canaries are the tripwire.
3. Playground/standalone examples that EXECUTE union-param exports with raw
   JS values would TypeError at the JS↔Wasm boundary (decision 3); emit-only
   corpus checks are unaffected. If the floor flags one, report it — do not
   carve out exports.
4. wasi-lane thin coverage — mitigated by the wasi smoke test.

**Rollback**: one-line revert of the default expression (all flag machinery
stays); `JS2WASM_UNION_ANYREP=0` gives a no-revert field kill-switch.

### Future slices (context only — NOT in this PR)

- **S5**: host-lane default flip — HARD-GATED on #2141 landing.
- **S6**: retire `__box_number`/`__unbox_number`/`__typeof_*` imports from
  modules that no longer reference them; simplify `addUnionImports`.
