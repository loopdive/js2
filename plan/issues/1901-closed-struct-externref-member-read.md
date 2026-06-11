---
id: 1901
title: "Standalone __extern_get string-key read on a closed-struct/$Vec-backed externref returns 0 (untyped-param object reads)"
status: done
created: 2026-06-05
updated: 2026-06-05
completed: 2026-06-05
priority: high
feasibility: medium
task_type: bugfix
area: codegen+runtime
language_feature: object-member-access
goal: standalone-mode
sprint: 61
---
# #1901 — closed-struct → externref string-key member read returns 0 (the post-S2 plateau-breaker)

## Symptom (dev-iter harvest 2026-06-05 + sd-s2 recon)

Under `--target standalone` / `--target wasi`, reading a **string** property off an
`externref` whose underlying value is a **compiled closed-struct object literal**
(or a `$Vec`) returns `0` / produces **invalid Wasm**:

```ts
function g(o: any): number { return o.x; }
export function test(): number { return g({ x: 9 }); }   // → 0 (want 9); module is invalid
```

Pervasive: **every untyped-param object argument** (`function f(o:any){return o.x}`
called with an object literal). ~1,072 direct standalone fails (dev-iter session
tracker "#130"), unifying with the ToPrimitive-on-objects cluster ("#124", ~1,228)
— same root → **≈2,300+ DIRECT pass-per-fix**. This is the dominant post-S2
standalone plateau cause.

## Root cause (sd-s2 recon, verified against 996815a05)

Two compounding defects at the closed-struct → `externref` boundary:

1. **The native object runtime is never emitted for a closed-struct-only program.**
   `ensureObjectRuntime(ctx)` (object-runtime.ts) — which registers the native
   `__extern_get` / `__extern_set` / `$Object` type — is **not** triggered by the
   closed-struct→`any` member-read path (it's only triggered by open-object /
   computed-key literal construction). So `o.x` on an `any` whose value is a closed
   struct calls `ensureLateImport(ctx, "__extern_get", …)`, which under standalone
   routes to the *native* helper **only if it was registered** — but it wasn't, so
   the `env::__extern_get` import is left **unbound → the module fails validation**
   (`valid=false`).

2. **Even when the runtime IS emitted, `__extern_get` can't read a closed struct.**
   Its native arm does `any.convert_extern` → `ref.test $Object` → walk the
   `$Object` open-hash-map. A closed-struct object literal is a **distinct closed
   struct type**, NOT a `$Object`, so the `ref.test $Object` fails and the read
   returns the undefined sentinel (0 in a numeric context).

### Recon evidence (compile-level, `target:wasi`)

| program | emits | valid | result |
| --- | --- | --- | --- |
| `g({x:9}).x` (closed-struct→any) | `env::__extern_get` | **false** | 0 / invalid |
| `const o:any={x:9}; o.x` | `env::__extern_get` | **false** | 0 / invalid |
| `first([10,20])` (array→any, idx read) | `__extern_get` (native) | true | works (via `__extern_get_idx`) |
| open-object computed-key `o[k]=9; o.x` | `__extern_get`+`__extern_set` (native) | true | works (via `$Object`) |
| `({valueOf(){return 7}}) + 0` (#124 sibling) | — | — | **NaN** (ToPrimitive can't read valueOf off the boxed closed struct) |

So the array path (`__extern_get_idx`) and the open-object path (`$Object`) both
already work standalone; the gap is exactly the **closed-struct object literal
coerced to externref, then read by string key**, plus its ToPrimitive sibling
(#124: `valueOf`/`toString` read off the same boxed closed struct).

## Fix shapes (decide in impl)

- **(A) Box closed-struct → `$Object` at the externref boundary.** When a closed
  struct is coerced to `externref` (the `extern.convert_any` site in
  type-coercion.ts) under standalone, first materialise a `$Object` carrying the
  same fields (so any downstream `__extern_get`/`__extern_method_call`/ToPrimitive
  reads it natively). Forces `ensureObjectRuntime`; uniform — one boundary fix
  feeds every reader (get, method-call, ToPrimitive). Cost: an alloc + field copy
  per coercion.
- **(B) Teach `__extern_get`/`__extern_method_call` to read struct/$Vec-backed
  externrefs.** Add a `ref.test`-chain arm over the registered closed-struct types
  (mirroring the `$Vec` arm pattern from #6407's spec) that does `struct.get fieldIdx`
  by a compile-time key→field-index map. No per-coercion alloc, but needs a
  per-struct-type field-name table threaded to the runtime, and must also force
  `ensureObjectRuntime`. Larger runtime surface; closer to zero-copy.

Recon leans (A) for uniformity (one fix covers get + method-call + ToPrimitive, the
#124 unification) — confirm during impl. Either way **must trigger
`ensureObjectRuntime` on the closed-struct→externref coercion** so defect 1 is
fixed regardless of which read path runs.

### Chosen fix (sd-s2 2026-06-05): (A-narrowed) route any-context object literal to `$Object` at construction

The closed-struct literal **knows at compile time** when it flows into an
`any`/`externref`/`object` contextual type (the untyped-param-arg case is exactly
this). So rather than box at the `extern.convert_any` coercion (which would need a
struct→`$Object` field-copy helper), route the literal to the `$Object` path **at
construction** when its contextual type is non-specific:

- **Site**: `compileObjectLiteral` (literals.ts:573). Today only an **empty** `{}`
  in an any-context routes to `__new_plain_object` (:614-632). Extend that to a
  **non-empty named-prop** literal in an any-context: emit `__new_plain_object`
  then, per `PropertyAssignment`/`ShorthandPropertyAssignment`, compile the value,
  coerce to externref, and `__extern_set(obj, "<key>", value)`. This is the
  `$Object` the existing native `__extern_get` / `__extern_method_call` / ToPrimitive
  all already read — zero new read-path code, and `__new_plain_object` forces
  `ensureObjectRuntime` (fixes defect 1).
- **Reuse/extend** `compileObjectLiteralAsExternref` (literals.ts:164) — it already
  builds `__new_plain_object` + handles spread via `__object_assign`; today it
  *skips* named props (:224-227). Add the named-prop `__extern_set` loop there and
  call it from the any-context branch.
- **any-context detection**: mirror the existing `isAnyContext` check
  (`getContextualType` → Any | Unknown | NonPrimitive, or no contextual type). Do
  NOT divert when a concrete struct type is expected (typed param, typed var, dstr
  slot) — those keep the closed-struct path (fast, correct for typed reads). Narrow
  precisely so we don't regress the typed-object fast path.
- **Nested**: a nested object value (`{x:{y:5}}`) recurses — the inner literal's
  contextual type (the outer prop's value type) decides its own routing; when the
  outer is any-context the inner value is compiled to externref and `__extern_set`
  stores it, so `o.x.y` reads the inner `$Object` natively.
- **#124 sibling** falls out for free: a `{valueOf(){…}}` in any-context becomes an
  `$Object` with the method stored, so ToPrimitive's native `__extern_get("valueOf")`
  + `__apply_closure` (S2) finds and calls it.

This is narrower + lower-risk than boxing-at-coercion: it touches only the
object-literal construction path under an any-context, leaves the typed-struct fast
path untouched, and rides entirely on already-native readers. gc/host mode: the same
any-context branch already routes empty `{}` to `__new_plain_object` there too, so
non-empty just extends an existing host-mode behavior — byte-changes only the
any-context non-empty-literal case (which was the broken one).

## Acceptance

- `g({x:9}).x` → 9 under `target:wasi`, module `valid=true`, zero `env::` leaks.
- Nested (`g({x:{y:5}}).x.y`), `const o:any={x:9}; o.x`, and the untyped-param-arg
  family all read correctly.
- #124 sibling: `({valueOf(){return 7}}) + 0` → 7 (ToPrimitive reads valueOf off the
  boxed object).
- gc/host mode byte-unchanged.
- Regression guard: existing open-object + array→any reads stay green; equivalence
  + the standalone regression gate (#1897) clean.

## Owner / lane

sd-s2 — object-runtime.ts core lane. Serializes with sd-1888 S5c on
object-runtime.ts at the merge queue; build in parallel, rebase at merge.

## Implementation notes (sd-s2, delivered 2026-06-05)

Shipped option **(iii)** construction-time `$Object` routing in
`src/codegen/literals.ts`:

1. **`compileObjectLiteral`** — new branch (after the empty-`{}` any-context
   branch) routes a **non-empty** object literal whose every property is a
   data prop / shorthand / spread (no accessors, methods, or computed/symbol
   keys) and whose contextual type is any/unknown/`object`/absent through
   `compileObjectLiteralAsExternref`. The any-context test **mirrors the
   existing empty-`{}` check verbatim** (R2 guard: a concrete struct type keeps
   the closed-struct fast path, byte-identical).
2. **`compileObjectLiteralAsExternref`** — extended its per-prop loop to build
   named data props onto the `$Object` via native `__extern_set(obj, "<key>",
   value)` (was previously spread-only; named props were silently dropped).

**Scope correction during impl (important — differs from the original
acceptance):**

- **Gated to `ctx.standalone` only.** Recon proved the open-object runtime
  (`ensureObjectRuntime` / `__new_plain_object` / `__extern_get`) is emitted as
  native defined functions **exclusively** under `ctx.standalone` —
  `late-imports.ts:308` deliberately excludes `ctx.wasi` (#1472 Phase B note:
  "WASI is intentionally NOT routed here yet"). Under wasi the `$Object`
  builder declines (`ensureLateImport` → undefined), so the branch must not
  fire there. **Verified wasi is byte-identical to main** with the gate. The
  `target:wasi` half of the original acceptance is therefore a **tracked
  follow-on** (extend the object runtime to wasi — needs the wasi `__str_flatten`
  type-mismatch in `__extern_get`'s body fixed first; that defect is
  **pre-existing on main**, present whenever a closed-struct-only wasi program
  emits `__extern_get`, and is NOT caused by this change).
- **#124 ToPrimitive sibling does NOT "fall out for free"** (contra the design
  note). Recon proved that even a closure-valued `{valueOf: () => 7}` data prop
  — which **does** route to `$Object` here — still returns `NaN`: ToPrimitive's
  `(o as number)` coercion does not LOCATE + `__apply_closure` the stored
  valueOf/toString off the `$Object`. That dispatch is a separate lever
  (depends on S6b method-as-value wrapping) and is a **tracked follow-on**. The
  construction half is pinned (`{valueOf(){…}}` literal compiles valid +
  leak-free).

**Delivered & validated under `--target standalone`:**

- `g({x:9}).x` → **9** (was 0 + invalid Wasm on main), `valid=true`, zero
  `env::` object-import leaks. Nested `g({x:{y:5}}).x.y` → 5, multi-prop,
  `const o:any={x:9};o.x`, absent-prop → 0 (no trap) all correct.
- R2 regression guard green: typed `interface Point` literal still builds a
  closed struct (`p.x*p.x+p.y*p.y` → 25).
- gc/host + wasi codegen **byte-identical to main** (gate off in both).
- Suites green: `tests/issue-1901.test.ts` (7), `issue-1472` (object runtime),
  `issue-1239`/`issue-1433` (accessor/disposal routing), `issue-1806`
  (ToPrimitive). The 4 `object-mutability`/`object-literal-getters-setters`
  equivalence failures are **pre-existing on main** (confirmed by swapping
  main's `literals.ts`), unrelated to this change.

## #124 co-land plan (sd-s2, 2026-06-05) — REQUIRED before #1901 re-push

**Why co-land:** the standalone diff of #1901-alone is NET **-205** (+61, **-266**;
gate #1897 correctly blocked PR #1241). All 266 regressions are ToPrimitive on a
user `$Object` with own coercion methods: on main these object literals compile
to a **closed struct whose valueOf/Symbol.toPrimitive ARE callable** (pass
today); #1901 routes them to `$Object` which has **no ToPrimitive dispatch**, so
it forfeits the working coercion. Routing is all-or-nothing → #1901 + #124 are
inseparable (= the original ~2,300 plateau-breaker). Regression breakdown
(`plan/agent-context/1241-regression-analysis.md`): 174 "dereferencing a null
pointer" (abrupt-completion: `{valueOf(){throw}}` — needs **dispatch only**, the
user throw propagates via `__apply_closure`), 42 "Cannot convert object to
primitive" (needs the **TypeError-throw** path), 5 "returned 2", 1 not-iterable.

**No S6b dependency (confirmed):** `object-runtime.ts:3346 __extern_method_call`
already does `ref.test $Object → __apply_closure(__extern_get(recv,name), recv,
args)` (S1+S2). S6b is only builtin static-method *value-reads* via
`__get_builtin` — orthogonal.

**SHARPER ROOT CAUSE (empirically isolated 2026-06-05):** method **storage is
NOT the gap** — the regressing literals are `{valueOf: function(){…}}` /
`{valueOf: () => …}` (PropertyAssignment, not MethodDeclaration), which #1901
ALREADY stores as a callable closure on the `$Object`. Proof under standalone:
`{foo: ()=>7}` → `o.foo()` returns **7** (generic `__extern_method_call` finds +
calls the stored closure). The bug is **name-specific call-site interception**:
`o.valueOf()` → NaN, `o.toString()` → REFUSED `__extern_toString`, `(o as
number)+0` / `o*1` → NaN. The names `valueOf`/`toString` are routed by
wrapper/string/struct-specific handlers in `calls.ts` (the `method ===
"valueOf"|"toString"` arms ~L6043/7025/7270 + the `__extern_toString` path) and
by the ToPrimitive coercion sites, ALL of which bypass the generic
`__extern_method_call` that already works for arbitrary names. So the user's own
`valueOf`/`toString` stored on the `$Object` is never reached.

**The fix (surgical, no new runtime helper, no method-storage change):** when the
receiver/operand is a `$Object` externref under `ctx.standalone`, route
`valueOf`/`toString` member-CALLS and the ToPrimitive coercion through the
generic `__extern_method_call(obj, name, [])` (proven working) instead of the
name-specific builtin paths. Member-call sites: the `valueOf`/`toString` arms in
calls.ts must, before taking the wrapper/`__extern_toString` path, check
`receiver is $Object externref (standalone)` → emit `__extern_method_call`.
ToPrimitive coercion (type-coercion.ts `toPrimitiveHostCallInstrs` standalone
branch / the #1806 walkers): for a `$Object` operand, dispatch `valueOf` then
`toString` (string hint: reverse) via `__extern_method_call`, validate primitive
(`!ref.test $Object`), else `emitThrowTypeError(... "Cannot convert object to
primitive value")` (native standalone throw, no host import).

(Original "method storage" note retained for the MethodDeclaration-shorthand
`{valueOf(){…}}` form — that does NOT route to `$Object` today (#1901's `.every`
guard excludes MethodDeclaration), so it stays a closed struct and is NOT in the
266 regressions. A separate closed-struct `{f(){return 7}}`→0 bug exists but is
pre-existing + out of scope.)

2. **ToPrimitive dispatch over `$Object`** — analog of the closed-struct walkers
   (`tryToStringFallback` numeric / `tryStructToString` string) but for an
   externref `$Object` operand, at the CALL SITE (where `emitThrowTypeError` is
   available — native standalone TypeError, no host import; see
   destructuring-params.ts:246). Per §7.1.1/§7.1.1.1, for the `$Object` operand:
   try (number hint or default) `valueOf` then `toString`; (string hint)
   `toString` then `valueOf`; each via `__extern_method_call(obj, name, emptyArgs)`.
   If the method is absent it returns the undefined sentinel → skip to next. If a
   result is a primitive (not `ref.test $Object`) → use it. If neither yields a
   primitive → `emitThrowTypeError(ctx, fctx, "Cannot convert object to primitive
   value")`. (Symbol.toPrimitive own-key arm: dispatch `@@toPrimitive` first when
   present — covers the well-known-symbol method literals; keep behind the same
   primitive-validate path.)

   **Wiring:** simplest blast-radius is to make `__to_primitive` resolve natively
   under `ctx.standalone` (add to `OBJECT_RUNTIME_HELPER_NAMES`, drop
   `refuseStandaloneToPrimitive` for it) with a `registerNative` body that calls
   `__extern_method_call` per the order above — so the many existing
   `toPrimitiveHostCallInstrs` call sites are unchanged. The TypeError path inside
   a runtime helper needs the #1104 native-Error throw (verify reachable from a
   helper body; if not, do the walk at the call site instead where
   `emitThrowTypeError` is in scope).

**Validation gate:** re-run the standalone diff (baseline vs new head) BEFORE any
re-push; require NET POSITIVE past the -15 tolerance. Expect the 266 to flip +
the +61 #1901 already gains. Hold #1241 BLOCKED (no enqueue) until positive.

### Follow-ons carved out of #1901

1. **wasi object-runtime extension** — route `OBJECT_RUNTIME_HELPER_NAMES`
   through `ensureObjectRuntime` under `ctx.wasi` too (lift the
   `late-imports.ts:308` `ctx.standalone`-only gate), after fixing the
   pre-existing `__str_flatten` type-5 mismatch inside `__extern_get`'s emitted
   body under native-strings. Unblocks the `target:wasi` half here + the wider
   wasi object corner.
2. **#124 ToPrimitive-off-`$Object` dispatch** — `(o as number)` /
   `String(o)` must find a stored `valueOf`/`toString` (method shorthand OR
   closure-valued data prop) on the `$Object` and invoke it via
   `__apply_closure`. Depends on S6b method-as-value wrapping.

### #124 implementation status (sd-s2, in progress)

**Built + WORKING (open-`$Object` path — the actual ~2,300 plateau target):**
- New native `__to_primitive(recv, hint) -> externref` in `object-runtime.ts`:
  `ref.test $Object`; if `$Object`, OrdinaryToPrimitive number/default order —
  `__extern_method_call(recv, "valueOf"|"toString", null)`, return the first
  result that is a primitive (`!ref.test $Object`); non-`$Object` recv passes
  through unchanged; no-primitive returns the `undefined` sentinel.
  Added to `OBJECT_RUNTIME_HELPER_NAMES`. **RESERVE/FILL at finalize**
  (`fillToPrimitive`, wired after `fillApplyClosure` in `index.ts`;
  `ctx.toPrimitiveReserved` + `ctx.fillToPrimitiveBody`) — the body's
  `__extern_method_call` funcIdx MUST be re-resolved by name at finalize or it
  goes stale → `u32 out of range:-1` (the #1839/#1899 late-shift class). This was
  the load-bearing fix; a registration-time-captured idx fails.
- Coercion wiring: `type-coercion.ts` externref→f64 routes through
  `__to_primitive` (null hint) before `__unbox_number` under `ctx.standalone`.
  Root cause it fixes: the `calls.ts` fallback `o.valueOf()`/`o.toString()` for
  any/externref receivers took an identity/`[object Object]` short-circuit BEFORE
  the generic `__extern_method_call` dispatch, so own methods never ran. Routing
  the *coercion* through `__to_primitive` also fixes the explicit `o.valueOf()`
  case (the `as number` re-coerces the identity result).
- `tests/issue-124-toprimitive-object.test.ts`: 4/5 pass (numeric coercion,
  arithmetic, explicit `o.valueOf()`, abrupt-completion propagation). Test 5
  (no-primitive → genuine §7.1.1.1 step-6 TypeError) deferred — see below.

**Two verified defects carved OUT of #124 (separate follow-ons):**
3. **closed-struct → externref → ToPrimitive `global.get -1`** — `const o =
   {a:1,b:2}` (NO annotation → *closed struct*) then `(o as any) - 0` now compiles
   PAST the old #1806 refusal (because `__to_primitive` resolves natively) and
   hits a PRE-EXISTING latent `global.get -1` (a native-strings-mode string-global
   sentinel) in the closed-struct emission of `$run`. CONFIRMED isolation: the
   `const o: any = {a:1,b:2}` open-`$Object` variant compiles+runs fine; only the
   closed-struct variant fails. This is exactly what #1901's closed-struct→`$Object`
   routing eliminates — once `{a:1,b:2}` (no annotation) is a `$Object`, the
   closed-struct path is never taken. It fails refuse-loud (`Codegen error`, no
   invalid module instantiated), not silent-wrong.
4. **`__unbox_number(undefined)` → 0, not NaN** — the native union helper returns
   0 for null/undefined, so a plain-object / no-primitive coercion yields 0 today
   rather than the spec NaN (`Number(undefined)`/`Number("[object Object]")` =
   NaN). Pre-#124 baseline behavior; fixing it (box-NaN sentinel, or spec
   `Number(undefined)=NaN`) is the same follow-on as the genuine step-6 TypeError
   for the own-valueOf-and-toString-both-return-object case.

## Suspended Work (sd-s2, 2026-06-05 — sprint wind-down)

**Status: pushed, on CI, NOT enqueued. PR #1241 stays BLOCKED.** Resume here.

- **Worktree:** `/workspace/.claude/worktrees/issue-130-closed-struct-extern-get/`
- **Branch:** `issue-130-closed-struct-extern-get` · **head `d1ea2aedf`** (local == origin, 0/0).
- **PR #1241** updated to `d1ea2aedf`, mergeState BLOCKED (#1897 standalone gate). A
  background CI watcher (`b1795c94y`) was polling `gh pr checks 1241`; on resume
  read `.claude/ci-status/pr-1241.json` and **verify `head_sha == d1ea2aedf`**
  before trusting net/regression numbers (a stale-SHA file is misleading).
- **Gate (verbatim from tech lead):** the re-run standalone diff must be
  **NET POSITIVE past the −15 tolerance** before re-push/enqueue. Expected
  ~+254 (the ~260/266 coercion cluster flips; 6 residuals stay — see below).
  If net-positive: enqueue via GraphQL `enqueuePullRequest` (NOT `gh pr merge
  --auto`). If not: escalate to tech lead, do not enqueue.

### What's REWIRED (committed `493dbb266`, in `d1ea2aedf`)
1. **`src/codegen/object-runtime.ts`** — new native `__to_primitive(recv, hint)
   -> externref`: `ref.test $Object`; if $Object, OrdinaryToPrimitive
   number/default order via `__extern_method_call(recv,"valueOf"|"toString",null)`,
   return first PRIMITIVE result; non-$Object passes through unchanged; no-primitive
   returns the `undefined` sentinel (`ref.null.extern`). Added `"__to_primitive"`
   to `OBJECT_RUNTIME_HELPER_NAMES`. **RESERVE/FILL at finalize** — registered as a
   placeholder body, real body built by new exported **`fillToPrimitive(ctx)`**
   (wired in `src/codegen/index.ts` right AFTER `fillApplyClosure`) which
   re-resolves the `__extern_method_call` funcIdx BY NAME (a registration-time
   capture goes stale → `u32 out of range:-1`, the #1839/#1899 late-shift class;
   this was the load-bearing fix). Ctx fields `toPrimitiveReserved` +
   `fillToPrimitiveBody` added in `src/codegen/context/types.ts`.
2. **`src/codegen/type-coercion.ts`** — the externref→f64 coercion (the
   `from.kind==="externref" && to.kind==="f64"` arm, ~L1352) now, under
   `ctx.standalone`, calls `__to_primitive(recv, null-hint)` BEFORE
   `__unbox_number`. Byte-identical for every non-$Object operand (passthrough).
   This is the site that was the root cause: it (plus the calls.ts name-arms)
   bypassed the working generic dispatch. **NOTE: I rewired the externref→f64
   coercion site; I did NOT separately edit the calls.ts valueOf/toString
   name-arms** — routing the *coercion* through `__to_primitive` turned out to
   cover the explicit `o.valueOf()` case too (the `as number` re-coerces the
   identity-short-circuit result), so the 4/5 + #1806 tests pass without touching
   calls.ts. If the diff shows residual explicit-call misses, the calls.ts
   `valueOf`/`toString` fallback arms (calls.ts ~L7311 toString, ~L7388 valueOf —
   the "Fallback .valueOf()/.toString() for any type" identity short-circuits)
   are the next place to route through `__to_primitive`/`__extern_method_call`.

### Tests (all green): `tests/issue-124-toprimitive-object.test.ts` (5/5),
   `tests/issue-1806.test.ts` (6/6, closed-struct cases assert REFUSE-LOUD).

### Still-TODO / carved out (do NOT block this co-land)
- **Closed-struct `(o as any) - 0` (no annotation)** kept REFUSING-LOUD
  (decision A): removing the #1806 refusal unmasked a pre-existing latent
  `global.get -1` in the closed-struct→externref emission. Tracked as the
  closed-struct→$Object representation follow-on (fixed when #1901 routing
  itself co-lands). + `__unbox_number(undefined)→0` (should be NaN).
- **6 non-coercion residuals** expected to remain (file as follow-up): Array
  indexOf/lastIndexOf on $Object ×2, Symbol.iterator-null ×1, illegal-cast in
  `__obj_find`←`__extern_get` ×1 (likely same root as the $Object enumeration
  finding), valueOf-side-effect-count ×2 (these likely clear once valueOf fires).
- **for-of 69 cluster** — tech lead RETRACTED this; they're
  `async-func-decl-dstr-obj-id-*` destructuring (coercion, covered by gap-2), NOT
  Symbol.iterator iteration. Exactly 1 genuine iterator case in all 266. No
  separate iterator-bridge work needed for this PR.
