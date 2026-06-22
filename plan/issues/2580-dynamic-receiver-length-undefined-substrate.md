---
id: 2580
title: "`.length` on an any/dynamically-mutated receiver returns numeric 0, not undefined (runtime property-presence)"
status: in-progress
assignee: ttraenkler/sd-value-rep
sprint: 65
created: 2026-06-21
priority: medium
feasibility: hard
reasoning_effort: max
task_type: bugfix
area: codegen, runtime, value-rep
language_feature: property access, length, dynamic objects
goal: test262-conformance
related: [2573, 983d]
---

# #2580 — `.length` on an `any`/dynamic receiver → runtime property-presence (substrate)

## Problem

`.length` on an **`any`-typed / dynamically-mutated** receiver returns numeric
`0` where the value is actually a plain object whose `length` is an absent
property (→ `undefined`, §10.1.8 OrdinaryGet). #2573 attempted a
**statically-typed** plain-object slice (a fail-safe static gate
`isPlainObjectWithoutLength` in `property-access.ts`) but that PR (#1868) was
**abandoned**: it moved 0 test262 rows AND ejected from the merge_group on a
hidden `.length` regression the targeted array-like pre-checks missed — the
`.length` path is too central to risk for zero conformance gain. The static gate
deliberately EXCLUDES `any`/`unknown` (at that static type a plain object and an
array are indistinguishable, and arrays dominate, so the numeric vec-field-0 /
`__extern_length` lowering is kept — excluding `any` is exactly what keeps
`any[].length` arithmetic safe), so it structurally cannot move the cluster.

The test262 `built-ins/Array/prototype/S15.4.4.*_A2_T*` cluster (the #983d
generic-Array-method-on-plain-object residual, 8 fails) is precisely the excluded
case:

```js
var obj = {};
obj.join = Array.prototype.join;
if (obj.length !== undefined) throw ...;   // obj is `any`; obj.length === 0, fails
```

## Why this is substrate, not a point-fix

Making `any`/dynamic-receiver `.length` correct requires a **runtime**
property-presence check at the read site: `ref.test $Object` → if it's a plain
`$Object`, `__extern_get(obj, "length")` (returns `undefined` when absent);
else (array / $ObjVec / string) read the numeric length. To express *both*
outcomes from one expression, `.length` on an `any` receiver must return a
**uniform externref** (the numeric array length **boxed** too). That is a
return-type change on the hot `any[].length` path — `for (;i<a.length;)` loops
and `a.length`-arithmetic are everywhere — so it carries broad regression risk
and is a value-representation decision (coordinate the value-rep lane:
`project_standalone_any_string_value_read_substrate`). #2573's #1868 ejection
already demonstrated how easily a `.length` change regresses a hidden case.

It also interacts with the #983d generic-array-method-on-plain-object machinery
(task #20, reverted as net-negative) and a standalone ToPrimitive throw, so a
correct `.length` alone would not flip the whole cluster.

## Fix direction (substrate)

- Decide the representation: either (a) `.length` on `any` returns a uniform
  boxed externref (numeric arrays boxed; plain objects `__extern_get`-undefined),
  validated against `any[].length` arithmetic across the FULL gate; OR (b)
  represent `var obj = {}` (dynamically mutated) as a dynamic `$Object` so the
  existing `$Object`-aware `.length` path applies.
- Validate via the FULL gate (merge_group / local-ci) — broad-reach, not a
  scoped sweep (the `.length` path is read everywhere; the #1868 eject is the
  cautionary example).
- Coordinate with #983d retry (task #20) for the generic-method cluster.

## Acceptance

- `var obj = {}; obj.length === undefined` (the `any`-receiver case) — typeof
  `"undefined"`.
- `S15.4.4.*_A2_T*` length-assertions flip to pass (with the #983d method-dispatch
  piece).
- ZERO regression in `any[].length` / array / string / arguments / typedarray /
  bound-fn `.length` arithmetic across the full gate.

## Cross-links

- #2573 (the static plain-object slice — PR #1868 abandoned: 0-row + hidden `.length` eject)
- #983d (generic Array method on plain object — task #20, reverted; the cluster needs both)
- value-rep / `project_standalone_any_string_value_read_substrate`

---

# Scoping doc — the value-rep dynamic-read substrate (2026-06-21, sd-1838)

> Filed under #2580 (the substrate's narrowest symptom is `.length`, but the
> lever is broader). This is a SCOPING artifact for a planning/next-phase
> decision — **not** an implementation plan. It sizes the payoff, proposes the
> representation, and stages an incremental, full-gate-validated migration.

## 0. Why this doc exists

The sprint-64 sparse-array tail (#2001 S2/S3/S4) and the open-object work
(#2580/#2573/#983d) **all converged on the same wall**: the compiler's
**dense/typed WasmGC representation cannot model a *dynamic read*** — reading a
property (indexed or named) from a receiver whose true shape is only known at
runtime. Each slice was individually spec-correct but conformance-flat or
net-negative because the rows it targeted need the dynamic-read substrate, not a
point-fix:

- **#2001 S2 (HOF visit-skip)** — ejected −6. The reachable test262 hole-HOF
  surface is "inherited accessor on `Array.prototype`" — HasProperty walks the
  **prototype chain**, which the dense vec can't model.
- **#2001 S3 (index-grow `$Hole` fill)** — 0 rows. The reachable form
  `var a=[1]; a[5]=9` lowers the assignment *target* to an **f64 vec** (numeric
  inference), so the externref hole-fill never fires; and test262 detects
  sparseness via `in`/`hasOwnProperty`/`delete`, not `join`.
- **#2001 S4 (dstr-past-length)** — 0 rows. The target family already passes;
  the failures are orthogonal (prototype-chain iterator, async iteration).
- **#2573 (#1868)** — abandoned, 0 rows + a hidden `.length` eject. The static
  plain-object gate **structurally excludes `any`**, which is exactly the
  cluster.
- **#983d (#1844)** — −200 net. The over-broad `__extern_method_call` fallback
  intercepted every unresolved `obj.method()`.

The common root: **a value whose static type is `any`/`unknown` (or a plain
object dynamically given array-like shape) has no compile-time-known field
layout, so indexed/`.length`/method reads must be resolved at RUNTIME against the
actual heap value — but the current codegen commits to a typed vec / numeric
field-0 / static dispatch at compile time.** Fixing one symptom (e.g. `.length`)
in isolation either moves 0 rows (the cluster needs the *whole* dynamic read) or
regresses the hot typed path.

## 1. What it unblocks — enumerated, with baseline row counts

Measured against the host test262 baseline (`.test262-cache/test262-current.jsonl`,
26m-old at measure time; **15,237** total host failures):

| Cluster | Failing rows | What it needs from the substrate |
|---|---|---|
| **`built-ins/Array/prototype/S15.4.4.*` — generic array method on an Array-LIKE object** | **~993** | `Array.prototype.{reduce,reduceRight,filter,every,some,forEach,map,indexOf,lastIndexOf,splice,slice,sort}.call({length:N, 0:…, 1:…}, cb)` — read `obj.length` + `obj[i]` from an arbitrary runtime object, HasProperty-skip absent indices. **This is the bulk of the lever.** |
| — of which: inherited/accessor/sparse element-retrieval (`-c-i-`/`-b-i-`) | 350 | prototype-chain HasProperty + accessor `Get` (the #2001 S2 ejection family) |
| — of which: `-2-N` "applied to Array-like, `length` own/inherited data prop" + `-5-N` length-coercion | ~640 ("other") | runtime `obj.length` read (own OR inherited) + ToLength coercion |
| **`any`/dynamic-receiver `.length` → undefined** (#2580 core) | ~12 (`S15.4.4.*_A2_T*` + `var obj={}; obj.length`) | runtime property-presence: plain-object `.length` is absent → `undefined` |
| **`Object.prototype.{hasOwnProperty,propertyIsEnumerable}` on dynamic objects** | 17 | runtime own-property presence on `$Object` |
| **`delete arr[i]` Array sparseness** | 11 | `delete` writes a hole the dynamic read honours (`in`/HOF skip) |
| **acorn dogfood** (#1712/#2582 family — dynamic struct read identity) | (non-test262, unblocks the tokenizer loop) | canonical struct rep on dynamic read paths |

**Rough reachable payoff: ~1,000 test262 host rows** concentrated in
`Array.prototype.*` generic-method-on-arraylike, plus the open-object/`delete`
tails. Caveat: not all ~993 flip from the substrate alone — a subset also needs
the #983d method-dispatch piece and a standalone-ToPrimitive fix (§4). A
conservative **first-wave estimate is the 350 `-c-i-`/`-b-i-` element-retrieval +
the ~640 `-2-/-5-` length/this-coercion rows that are *purely* runtime-read
gated**; the prototype-chain-accessor subset (the hardest) is a later wave. Even
the conservative slice dwarfs any single point-fix this session moved.

## 2. The core problem, precisely

Three runtime-read operations the dense/typed rep can't express:

1. **Indexed read `recv[i]` on an `any`/array-like receiver** — needs
   "does the object have own/inherited property `i`?" (HasProperty) then
   `Get(recv, i)`. The typed vec commits to `array.get` on a typed backing
   array, which (a) traps/0-fills for array-like *objects* (no vec), and (b)
   can't see prototype-chain entries.
2. **`recv.length` on an `any`/array-like receiver** — needs runtime
   property-presence: a plain object → `undefined`; an array/arguments/string →
   numeric. The current path commits to vec-field-0 / `__extern_length` (numeric
   0 for a plain object).
3. **`recv.method(...)` dispatch on an `any` receiver** — needs runtime
   resolution of `method` against the actual object (own/inherited/Array.proto
   generic), not a static funcMap lookup. (#983d's domain — the over-broad
   fallback regressed; the substrate gives it a *typed* dispatch surface.)

All three share one requirement: **a canonical runtime object representation that
carries (or can answer) property-presence + value for a dynamically-shaped
receiver**, and a **read site that branches on the runtime kind** (`ref.test
$Object` / `$Vec` / string / boxed-primitive) rather than committing to a typed
layout at compile time.

## 3. Proposed substrate (representation decision)

**Canonical dynamic-read protocol on the existing `#1852` boxed-family.** The
GC dynamic residue already dispatches an anyref-domain typed-struct family by
`ref.test`/`br_on_cast` (`$box_number`/`$box_boolean`/`$BigInt`/NativeString/
`$Object`/`$Vec`). Extend it with **two runtime read primitives**, Wasm-native
(no new host import; standalone-parity), that every `any`/array-like read site
calls:

- **`__dyn_has(recv: anyref, key) -> i32`** — HasProperty including the prototype
  chain. For `$Object`: walk own fields + the proto link. For `$Vec`: `idx <
  length && slot !== $Hole`. For array-like `$Object` with a numeric `length`
  field: `idx < length` (own/inherited). For string: `idx < len`.
- **`__dyn_get(recv: anyref, key) -> externref`** — `Get`: returns the value as a
  **uniform externref** (numeric boxed), or the spec `undefined` (externref) when
  absent. `.length` is just `__dyn_get(recv, "length")`.

**Representation choice for `.length` / indexed reads on a *statically-`any`*
receiver: uniform externref** (option (a) in the existing problem section) —
`recv.length` and `recv[i]` on an `any` receiver return a boxed externref, with
the numeric length/element boxed too. The **typed** path is UNCHANGED:
`a.length` where `a` is statically `number[]`/`string[]`/`Array<T>` stays the
numeric vec-field-0 read (no boxing, byte-identical). The branch is on the
**static receiver type**, gated exactly like the #1852 typed-mainline-unboxed
invariant: only `any`/`unknown`/dynamic-shaped receivers pay the runtime cost.

**Why uniform-externref, not "represent `var obj={}` as `$Object`" (option b):**
option (b) requires deciding the dynamic-object representation at *allocation*
time (every object literal), a far larger blast radius; option (a) is a
*read-site* change scoped to `any`-typed reads, which is where the cluster lives
and where the migration can be gated and incremental.

## 4. Blast radius + the −794-class risk

The hot path is `a.length` in `for (;i<a.length;)` loops and `.length`
arithmetic — read *everywhere*. The #1868 (#2573) ejection and the #1844 (#983d)
−200 are the cautionary precedents: any change that perturbs the **typed**
`.length`/method path regresses hundreds of rows. **The migration's prime
directive: the statically-typed read path stays byte-identical; only
statically-`any`/dynamic reads change.** Each step MUST be full-gate validated
(merge_group / local-ci), NEVER a scoped sweep — per
`project_broad_impact_validate_full_ci` (this session's three ejects all passed
scoped sweeps then failed the full gate).

## 5. Incremental, gated migration (NOT a #1844 big-bang)

Each slice is independently landable, full-gate-validated, and gated on the
static receiver type so typed reads are byte-identical:

- **M0 — `__dyn_has`/`__dyn_get` primitives (no call sites yet).** Add the two
  Wasm-native helpers + their `$Object`/`$Vec`/string/boxed arms + standalone
  parity. Dead-elim-pruned when unreferenced ⇒ **0 rows, 0 regression** (pure
  scaffolding; validates the helpers compile + the boxed-family dispatch is
  sound). Lands first, de-risks everything after.
- **M1 — `any`-receiver `.length` → `__dyn_get(recv,"length")`** (the #2580
  core). Gate strictly on a *statically-`any`/unknown* receiver; typed
  `.length` untouched. ~12 rows + de-risks the read-site branch. **This is the
  smallest real-row slice and the canary for the hot-path regression risk** —
  if M1 ejects on a hidden typed-`.length` case, the gating is wrong and we stop
  before the big slices.
- **M2 — generic `Array.prototype.X.call(arrayLike, cb)` over `__dyn_has`/
  `__dyn_get`.** Route the array-method-on-arraylike path (the ~640 `-2-/-5-`
  length/this-coercion rows) through the runtime read instead of the typed vec.
  Coordinates with #983d's method-dispatch (task #20) — the generic-method
  *resolution* + the *read* land together here.
- **M3 — prototype-chain HasProperty for indexed reads** (the 350 `-c-i-`/`-b-i-`
  element-retrieval rows + the #2001 S2 visit-skip, now correctly gated on
  `__dyn_has` so an inherited `Array.prototype[N]` accessor is "present"). This
  retroactively un-blocks #2001 S2 (re-land the visit-skip *driven by
  `__dyn_has`*, not own-only). Hardest, last.
- **M4 — `delete arr[i]` + `in`/`hasOwnProperty` honour the dynamic read** (the
  11 delete-Array + 17 Object-presence rows). Retroactively gives #2001 S3 its
  payoff (`3 in a` correct after a grow/delete).

Order rationale: M0 (scaffold, 0-risk) → M1 (smallest-row canary for the
hot-path risk) → M2 (biggest row block) → M3 (hardest, prototype chain) → M4
(tail). Stop-the-line if M1 ejects (gating wrong).

## 6. Cost / risk estimate

- **M0:** ~1–2 days, low risk (scaffolding, dead-elim-pruned).
- **M1:** ~1–2 days impl, **high regression risk** on the hot `.length` path —
  the full-gate canary. The #1868 eject says budget a fix-iterate cycle.
- **M2:** ~3–5 days, medium-high — the array-method-on-arraylike rewrite +
  #983d coordination; biggest payoff (~640 rows) and biggest surface.
- **M3:** ~3–5 days, high — prototype-chain modeling is the part the dense vec
  fundamentally lacks; re-lands #2001 S2.
- **M4:** ~2 days, medium — `delete`/`in` over the dynamic read.
- **Total:** ~2–3 weeks of senior-dev (value-rep lane) for ~1,000 rows, **if
  taken incrementally with a full-gate canary at M1**. A big-bang is
  contraindicated (#1844). Each slice is independently landable, so partial
  progress banks rows.

## 7. GENERALIZATION ASSESSMENT (the key sizing question)

**Question (per the task spec):** does the uniform-externref + `__dyn_has`/
`__dyn_get` rep that fixes `any`-receiver `.length` ALSO unblock the rest of the
parked tail? This decides whether #2580 is THE big lever (~1,000 rows) or a
small one (~12 rows). **Honest answer: it GENERALIZES to the READ clusters (the
bulk) but NOT to the two type-INFERENCE axes (S3/S4).** Verified by reading the
actual test bodies (e.g. `reduce/15.4.4.21-2-1`: `obj={0:12,1:11,2:9,length:2};
Array.prototype.reduce.call(obj,cb,1)` — a runtime read of `obj.length` +
`obj[i]` from a plain object).

| Cluster | Rows | Substrate fixes it? | Why / milestone |
|---|---|---|---|
| `Array.prototype.X.call(arrayLike, cb)` — `{0:..,length:N}` | **~640** | **YES — substrate IS the fix** | reads `obj.length` (own/inherited) + `obj[i]` at runtime = `__dyn_get`/`__dyn_has`. M2. |
| inherited/accessor/sparse element-retrieval (`-c-i-`/`-b-i-`) | **350** | **YES — `__dyn_has` prototype-chain arm** | HasProperty walks the proto chain (the #2001 S2 ejection family). M3 re-lands S2 *driven by `__dyn_has`*. |
| `any`-receiver `.length` → undefined (#2580 core) | **~12** | **YES — direct** | `recv.length` = `__dyn_get(recv,"length")`. M1. |
| `Object.prototype.{hasOwnProperty,propertyIsEnumerable}` | **17** | **YES — `__dyn_has` own-arm** | own-property presence on `$Object`. M4-adjacent. |
| `delete arr[i]` sparseness (`in`/HOF skip) | **11** | **YES — `__dyn_has` vec-arm honours `$Hole`** | M4 re-lands #2001 S3's `join` payoff via `in`. |
| #983d host-method dispatch | (overlap) | **PARTIAL — necessary, not sufficient** | `__dyn_get(recv,"method")` gives the *typed* dispatch surface #983d's over-broad fallback lacked; the generic-method *body* + a standalone-ToPrimitive throw are separate. M2 coordinates. |
| **#2001 S3 — `var a=[1]; a[5]=9` target → f64** | (0) | **NO — separate axis (WRITE-target type inference)** | the array-LITERAL element heuristic picks f64 for `[1]`, so the assignment *target* `a[5]` resolves f64. The substrate is dynamic *reads* on `any` *receivers*; it never touches a typed-write-target resolution. S3's externref grow-fill (`ba634ef44`) is correct for genuine-externref vecs but its headline needs a *literal-inference* fix, not this substrate. |
| **#2001 S4 — `const [p,q]=[1]` binding → numeric** | (0) | **NO — separate axis (binding-type inference)** | S4's fix (`779e98fa5`) re-types an OOB tuple-binding to externref — destructuring binding-local inference, orthogonal to dynamic receiver reads. |

**Verdict: GENERALIZES to ~1,030 READ rows (640+350+12+17+11) — the big lever.**
The two NON-generalizing axes (S3 headline, S4) are *type-inference* problems,
not dynamic-read problems; they were correctly parked but are NOT what #2580
unblocks (they'd need their own smaller literal/binding-inference fixes).

**Floor vs. ceiling (honest):** M1 (12) and M3 (350) are *substrate-pure*. M2's
640 *also* needs the #983d generic-method body (task #20) + a standalone-
ToPrimitive fix to fully flip, so M2 is "substrate + #983d", not substrate
alone. **Substrate-pure floor ≈ 390 rows (M1 12 + M3 350 + M4 28); ceiling
≈ 1,030 with #983d coordination.**

## 8. Recommendation

The value-rep dynamic-read substrate is **the single highest-leverage open
conformance lever** — a **~390-row substrate-pure floor / ~1,030-row ceiling
(with #983d)** vs. the point-fixes' single digits — and the common blocker
behind the dynamic/sparse READ tail (S2, #2573, #983d, the S15.4.4 generic-method
cluster). It does NOT generalize to the S3/S4 type-inference axes (separate,
smaller, already parked on their own merits).

Recommend **M0→M1 first**: M0 is 0-risk scaffolding (dead-elim-pruned), M1 is the
smallest-row (12) substrate-pure canary that sizes the hot-`.length` regression
reality. Hold M2–M4 behind M1's full-gate result; M2 additionally gates on #983d
coordination. **The investment decision — a ~2–3-week senior-dev/value-rep
commitment — is the USER's call.** This spec sizes the payoff (390 floor / 1,030
ceiling), the cost (~2–3 weeks), and the risk (hot-`.length` path, mitigated by
the M1 canary + per-slice full-gate validation, never a #1844 big-bang) for that
decision.

---

# Implementation log

## M0 — `__dyn_has`/`__dyn_get` scaffold (LANDED, PR #1880, 2026-06-21)

The two Wasm-native read primitives + a `ctx.usesDynRead` gate + finalize-phase
wiring (`src/codegen/dyn-read.ts`). **Provably inert / 0-risk**: the helpers are
gated on `usesDynRead`, which M0 sets nowhere, so they are never emitted and every
module is byte-identical (the *gate*, not dead-elim, is the guarantee — an
uncalled *defined* function is not import-pruned). Validated three ways: inert for
normal programs (incl. `any[].length`, `o.length===undefined`); valid when
force-emitted (`JS2WASM_FORCE_DYN_READ=1`, host + standalone — the bodies-are-sound
self-test); 0 regression on the array/object suites. Merged clean through the
merge_group (no eject), exactly as the byte-identity proof predicted.

## M1 — `any`-receiver `.length` canary (CANARY VERDICT: REPRESENTATION CALL, NOT landed)

The canary did its job — it surfaced the return-type-change as a **representation
decision before M2 sank any effort**, with the typed-`.length` safety property
cleanly bounded. Branch `issue-2580-m1-length-canary` (WIP, NOT pushed).

- **SOLVED — the #2043 `-1` type-index desync.** In HOST mode `__extern_get` is a
  JS *import*, not the native `$Object` runtime; the call-site helper called
  `ensureObjectRuntime`, which in host mode registers `$PropEntry` with
  `key: ref $AnyString` where `anyStrTypeIdx === -1` → a struct field referencing
  typeidx -1 → binary-emit fail. Fix: host uses `ensureLateImport("__extern_get")`,
  `ensureObjectRuntime` only in standalone. (Same family as
  `project_type_index_shift_and_deadelim`.)
- **SOLID — the typed safety property HOLDS.** `number[]`/`string`/`arguments`/
  `rest` `.length` are byte-identical: they return from the typed arms *above* the
  new `any`-gated arm and never reach it. The substrate's hot-path risk is bounded.
- **THE FINDING (the re-assessment).** `.length` on an `any` receiver returning a
  uniform externref fights every downstream *numeric* consumer. Scouting the five
  `obj.length` consumer contexts (`const x = obj.length` inference, `===`,
  arithmetic `+`, `String()`, `if`-truthiness) shows **none route through the
  `compilePropertyAccess` arm** — `obj.length`-on-`any` is lowered *independently*
  by multiple expression handlers (the `===` HasProperty fold, the arithmetic
  numeric-coercion path, …), each with its own `.length` handling. So the
  uniform-externref `.length` representation is **not one front-end change** but
  either (a2) a refactor making `compilePropertyAccess` the single `.length`-on-any
  chokepoint all consumers defer to, (a1) a per-handler patch, or (b) a narrower
  absent-sentinel that keeps `.length` numeric (smaller, but does not generalize to
  M2/M3's arbitrary `obj[i]` reads). **The canary proved the rep has
  distributed-lowering integration cost the scoping doc under-estimated** — a
  scope/investment decision (escalated to the user).

### Known follow-ups (track for M2/M3)

- **M0 `__dyn_has` semantic bug** — the M0 form returns "present" iff
  `__extern_get` is non-null, which **conflates "present with value `undefined`"
  vs "absent"** (`{}.x === undefined` own-property edge, and a real `undefined`
  value). HasProperty-proper (own + prototype-chain presence, independent of the
  *value*) is needed in M2/M3 where the distinction matters. M1's `.length` /
  the array-like cluster only need non-null-Get ⇔ present, so this is deferred,
  not a blocker for M0/M1.
- **`__dyn_get` standalone arm** — M0 delegates to `__extern_get`; the
  native-string indexed/`length` arm + the `$Vec` `$Hole→undefined` arm are M2/M3.

---

# M1 (a2) chokepoint-refactor plan — APPROVED path (a); CONFIRM before deep work

User greenlit path (a) end-to-end any-typing via the (a2) chokepoint refactor.
Scoped here as **its own bounded slice** (guardrail 1) for lead review BEFORE the
days go in; each step **full-gate validated** (guardrail 2).

## Re-scoping finding (good news — smaller than the M1 verdict feared)

A read-only map of EVERY `.length`-on-`any` consumer (`===`, arithmetic `+`,
truthiness, `const x = obj.length` inference, `String()`/template) found
**`compilePropertyAccess` is ALREADY the universal chokepoint**:
`compileExpression` (expressions.ts:~1171) routes every `PropertyAccessExpression`
through it with no exceptions, and **no consumer structurally special-cases
`.length`** before `compileExpression`. The apparent "bypass" (M1's first read)
is an *illusion of type coercion*: my arm returns externref, then each consumer's
existing coercion converts it — sometimes WRONGLY (unboxing the externref back to
numeric, losing `undefined`).

**So (a2) is NOT a multi-handler rewrite.** It is: (i) make the
`compilePropertyAccess` `.length`-on-`any` arm return externref cleanly (done in
the WIP, gated on static `any`/`unknown`), and (ii) fix the FEW consumer-coercion
sites that mishandle the externref. The hot-path (typed `.length`) never enters
this arm → byte-identical (verified: number[]/string/arguments/rest return from
the typed arms above).

## Consumer-coercion sites to audit + fix (the actual work)

Audit each `compileExpression(obj.length)` → my externref arm → consumer
coercion; fix only where the externref is mishandled:

1. **`x === undefined`** — binary-ops.ts:420-440 has a correct externref arm
   (`__extern_is_undefined`). The WIP showed a `__dyn_has`-flavored fold for the
   `propaccess === undefined` shape — INVESTIGATE whether the `===` path
   const-folds `.length === undefined` into a presence check and, if so, route it
   to the externref-from-`__dyn_get` (not a separate `__dyn_has`). PRIMARY canary
   assertion: `var obj={}; obj.length === undefined` → true.
2. **`const x = obj.length` inference** — variables.ts:~563/648/837. For
   `obj: any`, TS types `obj.length` as `any` → externref; the binding local
   SHOULD be externref. The WIP showed `typeof x === "number"`, so the local got
   a numeric ValType — fix the `.length`-on-any initializer's binding local to
   externref.
3. **Truthiness `if (obj.length)`** — control-flow.ts:568 + externref `__is_truthy`
   (index.ts:~13551). Likely already coerces; VERIFY (`if ({}.length)` falsy,
   `if ([1].length)` truthy).
4. **Arithmetic `obj.length + 1`** — binary-ops.ts:929/935. externref→f64 via
   `__unbox_number`; absent → NaN, spec-correct. VERIFY `[1,2].length + 1 === 3`,
   `({}).length + 1` is NaN.
5. **`String(obj.length)` / template** — calls.ts:~10427 / string-ops.ts:~363.
   externref→string via `__extern_toString`. VERIFY `String([1,2].length)==="2"`,
   `String({}.length)==="undefined"`.

Expect **2–4 small consumer fixes + the arm**, not a sweeping refactor.

## Staging (each its own full-gated PR; stop-the-line on a typed-`.length` eject)

- **M1a — the arm + `=== undefined` canary** (smallest, highest-signal). Land the
  externref arm + whatever the `=== undefined` path needs so `var obj={};
  obj.length === undefined` → true and the S15.4.4 `.length`-property rows flip.
  Full-gate. **The viability proof.**
- **M1b — binding-inference + truthiness + arithmetic + String** consumer fixes
  (only the ones M1a's audit flags). Full-gate.
- Each PR: typed-`.length` byte-identity guard + determinism guard.
  STOP-THE-LINE if either ejects.

## Cost / risk (revised DOWN from the M1 pessimistic estimate)

The chokepoint already exists; the work is the arm (done) + 2–4 consumer-coercion
fixes. **~2–4 days** (M1a ~1–2d incl. the `=== undefined` fold investigation,
M1b ~1–2d), each full-gated. Risk bounded by the static-`any` gate (hot-path
untouched) + per-PR full-gate. The M1 WIP (`d9956bfa3`, branch
`issue-2580-m1-length-canary`) is the starting point — the arm + the
host/standalone `__extern_get` #2043 fix already land.

**CONFIRM-WITH-LEAD checkpoint (guardrail 1):** posted for review BEFORE the deep
work. The material change from the M1 verdict: the chokepoint already exists, so
(a2) is a ~2–4-day arm+consumer-coercion slice, not a multi-handler refactor —
which de-risks the whole substrate's M1 cost. Awaiting go-ahead to execute M1a.

## Concurrency seam — vs. the parallel tag-5 equality wave (#1888/#1864/#1883)

A parallel value-rep wave rewrites the **tag-5 content-equality classifier**
(#2040 field-4 / #2579 any-str strict-eq / #2583 any-array search). My (a2)
`.length`-externref result flows into the `===` consumer, which meets their
classifier — so the question is collision vs. clean layering.

**VERDICT: CLEAN LAYERING — zero overlapping lines** (read-only `binary-ops.ts`
trace). My canary's `===` shapes land in arms DISJOINT from theirs:
- `obj.length === undefined` (my PRIMARY assertion) → the **presence arm**,
  `binary-ops.ts:429-435` (`__extern_is_undefined`). Not the classifier.
- `obj.length === <number>` → the **numeric-fallback arm**, `binary-ops.ts:
  2853-2876` (`__unbox_number` + `f64.eq`). Not the classifier.
- Their tag-5 content-equality rewrite lives at `binary-ops.ts:2804-2823`
  (`__any_from_extern` → `__any_eq` tag-dispatch), and is **strict-vs-loose
  disjoint** from mine: that arm is the LOOSE-equality (`==`/`!=`) + standalone
  branch; my shapes are STRICT (`===`/`!==`). They never execute the same code.

**No DIRECT collision.** My `.length`-externref just lands in the
presence/numeric arms unchanged; their classifier overhauls a different arm. So
the two waves can proceed **in parallel** with no sequencing dependency on the
`===` seam — my externref does NOT feed their classifier (it takes the
`=== undefined` / numeric arms before reaching tag-5 content comparison). If a
future (a2) shape compared two `any` VALUES for content (e.g. `obj.length ===
otherObj.prop`, both externref), THAT would route into their classifier and want
their base first — but the M1 `.length` canary (`=== undefined` / `=== <number>`)
does not. Flagged for the lead's wave-sequencing: **parallel-safe at the `===`
seam.**

## M1a — IMPLEMENTED (this PR)

The `.length`-on-`any` HOST arm landed as a clean **2-file** change
(`src/codegen/dyn-read.ts` + `src/codegen/property-access.ts`); the M0 scaffold,
#1899, and the typed `.length` hot-path are all untouched.

**Where the arm sits (the key root-cause fix).** It is NOT a new `propName ===
"length"` block placed ahead of the existing ones — that was the first (wrong)
attempt and it *clobbered the working array path*. Origin already reads
`const o: any = [1,2,3]; o.length` correctly as `3` because `o`'s value is an
externref wrapping a WasmGC vec; the existing handler eventually reaches a generic
externref reader that ref.test-dispatches the vec. Intercepting `any`-`.length`
BEFORE the vec detection forced every array through `__extern_get(vec,"length")`,
which the host evaluates to `undefined` (V8 sees an opaque struct). So the arm is
folded into the **`savedLen` fallback block** (`property-access.ts` ~3644): it
runs only AFTER the length-bearing-vec-struct detection misses, i.e. the genuinely
non-vec dynamic receiver.

**`emitDynGet` host path = runtime receiver-kind dispatch (no funcidx hazard).**
For the `length` key it emits, inline:
```
ref.test $vec_i  → if hit:  box_number(f64(struct.get $vec_i 0))   // the array length
                   else:    __extern_get(recv, "length")            // value or undefined
```
nested as one if/else chain over every registered `{length,data}` vec type in
`ctx.vecTypeMap`. `ref.test typeIdx` uses **type** indices (append-only /
dead-elim-stable via the rec-group), so unlike a `call __is_vec` it carries no
funcidx-ordering / late-import-shift hazard — which is what derailed the earlier
`__dyn_get`-wrapper attempt (a DEFINED-func `call` whose index floated when a
consumer added a late import). `__extern_get` + `__box_number` are host IMPORTS
(stable), ensured up-front before any baked index is resolved. Non-`length` keys
skip the vec arm and go straight to `__extern_get` (vec indexed reads are a later
slice). Standalone is unchanged (M1a is host-scoped; it still routes through the
`__dyn_get` wrapper, which is correct there because `__extern_get` is a defined
native helper).

**Representation = uniform externref, and consumers coerce for free.** The arm
returns `{ kind: "externref" }` (a boxed number for an array length, JS
`undefined` for an absent property). Every numeric consumer tested
(`+`/`*`/`<`/`for`-bound) unboxes it via the existing externref→f64 coercion;
`=== undefined` hits the presence arm; `typeof`/`String()`/truthiness all correct.
So M1a needed **no** separate M1b consumer-coercion work for these shapes — the
pessimistic M1 verdict over-scoped it.

**Validation.** New regression suite `tests/issue-2580-any-length.test.ts` (13
cases) green; `tsc`/`prettier` clean; the 3 pre-existing `strings.test.ts`
failures are an unrelated worktree test-infra artifact (identical on origin/main).
Conformance is the merge_group full-Test262 gate's call (this is a value-rep /
chokepoint touch → authoritative gate per `project_broad_impact_validate_full_ci`,
NOT a scoped sweep). Stop-the-line on any typed-`.length` eject.

## M1a — MERGE_GROUP EJECT (PR #1894 v1, 13 regressions) + ROOT CAUSE

PR #1894 v1 (the `ctx.vecTypeMap`-dispatch arm above) passed every PR check and
all 117 merge_group test262 shards, but the merge_group **net-regression gate**
ejected it: **13 regressions** (pass→fail), all `assertion_fail`, all with a
wasm-hash change, **0 improvements** (fails net AND ratio). `auto-park` applied
the `hold` label. Confirmed NOT cross-PR drift (only #1894's merge_group shows
bucket `964d9207`). Pulled the merged-report artifact + diffed vs baseline → the
exact 13 split into two clusters, BOTH the `.length`-on-any arm firing on a
receiver the prior numeric path handled correctly:

- **A (5): function/closure `.length` = ARITY.** `verifyProperty(IteratorProto[
  Symbol.iterator], 'length', {value:0})` etc. `(fn as any).length`: origin = `0`
  (matches the arity the tests assert), my arm = **NaN** (a closure externref →
  `__extern_get(closure,"length")` → undefined → NaN coercion).
- **B (8): for-await-of array-rest destructuring `.length`.** `for ([x, ...y] of
  …)` then `y.length`. The rest binding `y` is `let`-declared → `any`, and in the
  loop-head-destructuring desugaring it ends up as a boxed/wrapped externref that
  is NEITHER a directly-`ref.test`-able vec NOR a plain host object — so my vec
  chain misses and `__extern_get` returns undefined → **NaN** (origin returned the
  correct count). (A reduced `for ([x,...y] of [[1,2,3]]) {}; return y.length`
  reproduces NaN locally; note `typeof y` is `"undefined"` / `Array.isArray(y)`
  false in this reduced shape — there is a *separate* for-of-rest-binding
  representation quirk here, orthogonal to M1a, that the prior numeric `.length`
  path happened to read correctly.)

**Unified root cause:** the gate `objType.flags & (Any|Unknown)` is too broad. My
arm intercepts `.length` for ANY boxed/wrapped non-plain-object receiver (closure,
loop-destructured rest array, …) and emits a uniform-externref `undefined` →` NaN`
where the prior numeric path returned a usable value. The substrate CORE is sound
(the `{}.length === undefined` canary still passes); the gate just over-reached.

**FIX — option 2 (positive `$Object` gate) is NOT VIABLE in host mode; use
option 3 (decline-for-struct).** Option 2 fails twice: (a) `objectTypeIdx` only
exists when `ensureObjectRuntime` runs, and that registers `$PropEntry` with
`key: ref $anyStrTypeIdx` — host mode `anyStrTypeIdx = -1` → the original −1
type-index crash; (b) more fundamentally, in HOST mode a plain `{}` is NOT a
WasmGC `$Object` struct — it's a host JS object (externref). There is no struct to
`ref.test`. So a positive `$Object` gate can't work host-side.

The host-mode picture (confirmed by probing): plain `{}` is a host externref that
`ref.test`-misses ALL structs (→ `__extern_get` → undefined, the canary —
*already* works via the current vec-MISS branch); array/closure are WasmGC
structs; the for-of/await rest binding points at a vec (the v1 arm matched it and
read the SOURCE array's length 3, hence "returned 3" for expected 2).

**Option 3 — decline-for-struct:** the dyn-read `.length` arm DECLINES (return
false → caller falls through to the prior numeric `.length` path) when the
receiver `ref.test`s as a VEC **or** a CLOSURE base type
(`collectClosureBaseWrapperTypeIdxs(ctx)`, same body-compile mechanism as the vec
types); it fires `__extern_get(recv,"length")` ONLY for the residual genuine host
externref. Effect: array → declines → prior path reads vec field-0 = 3 ✓ (this
also DROPS the v1 box-number vec arm, eliminating the Cluster-B wrong-vec-match);
`{}` → all struct-tests miss → `__extern_get` → undefined ✓ (canary); closure →
declines → prior path → 0 ✓ (Cluster A); rest binding (vec) → declines → prior
path → correct count ✓ (Cluster B). SIMPLER than v1 (removes the box-number arm —
the prior path already read array `.length` correctly). Arm shrinks to
"`ref.test` vec OR closure → decline; else `__extern_get(recv,'length')`". One
gate, all 13 fixed, canary preserved, no `$Object` struct needed. **Validate
against the REAL async-generator rest test262 file** (the reduced
`for ([x,...y] of …)` probe is unfaithful — origin ALSO returns 0 there).
Re-validate via merge_group (one-shot); stop-the-line on re-eject.

## M1a — FINAL VERDICT (faithful runner): NOT a surgical slice; defer to M2

Built a faithful local gate — call the REAL `runTest262File` (tests/test262-runner.ts)
on all 13 regressed files directly (`.tmp/run13.mjs`). Reduced `compile()`+probe
shapes repeatedly MISLED (a user closure ≠ a host builtin; `for([x,...y]of)` ≠ the
async-gen harness). Results:

- **Arm OFF → 12/13 pass** (the 13th `[skip]`s on Temporal). ZERO regression,
  identical to origin — the prior path is correct for every one of the 13.
- Arm ON v1 → 0/13. Closure-arm v2 → STILL 0/13 (the real Cluster-A receivers are
  host-builtin functions reached via Symbol-keyed prototype walks, NOT user
  closures the `ref.test` catches). Receiver-`ref.is_null` guard → STILL 0/13 (the
  13's receivers are NON-null wrapped externrefs). Decline-for-struct → can't
  separate them (the 13 `ref.test`-MISS all structs, exactly like the canary `{}`).

**Root cause = TOTAL ENTANGLEMENT.** Every one of the 13 reaches
`__extern_get(recv,"length")` → undefined → NaN, where the prior numeric path
returned a usable value (0 via `__extern_length`'s null-guard, or the real count).
The canary (`{}.length` → undefined) needs that SAME `__extern_get`-undefined
result to STAY undefined. A non-null `{}` lacking `length` and a non-null wrapped
builtin / rest-binding are the SAME externref shape — **no `ref.test` /
`ref.is_null` / `__extern_has` predicate separates them.** The distinction lives in
the boxed `$AnyValue` tag, which only a TAG-AWARE reader (M2's job) can inspect; a
bare-externref runtime test cannot. So options (a)/(3) are dead — there is no
surgical gate.

**RESOLUTION = turn the arm OFF (option c).** The `.length`-on-any value-semantics
is not a surgical M1 slice; it requires M2's tag-aware dynamic reader to
disambiguate the receiver. Turning the arm off reverts the canary to the
PRE-EXISTING #2580 bug (NOT a new regression), keeps M0 inert, and is zero-regression
(validated 12/13 + skip). The `{}.length`→undefined fix folds into M2's acceptance.
M1 over-scoped the value-semantics; M0 (the inert scaffold) is the landable M1.

## M2.2c — reduce/reduceRight-no-init un-refuse: WONT-FIX (A/B proven net-negative, 2026-06-22, sd-2611)

**Do not re-attempt the un-refuse without first landing the parked native
no-init arm.** M2.2c was framed as "un-refuse `reduce`/`reduceRight` no-init on
array-likes by fixing the #2043 funcidx desync (re-resolve-by-name) at the
hole-scan's baked `__extern_has_idx`/`__extern_get_idx`." Measured against
CURRENT main, all three premises are stale:

1. **The funcidx desync is ALREADY fixed.** The native no-init arm already
   re-resolves by name (`getIdxFnNow`/`hasIdxFnNow`, array-methods.ts ~L867, the
   #16 fix) and #2611's `flushLateImportShifts` hardening closed the remaining
   leak. Instrumented build + A/B over the whole corpus: compile-validity is
   IDENTICAL refusal-ON vs OFF (450/520 valid both ways), ZERO invalid-Wasm from
   the no-init path. There is nothing left for the re-resolve-by-name pattern to
   fix here.
2. **The refusal is ROW-PROTECTIVE, not a graceful CE.** Its `reportError` fires
   only in a SPECULATIVE compile pass; the final emit routes the no-init shape to
   the WORKING host `__proto_method_call` path. So removing the refusal does not
   "un-block a graceful CE" — it diverts working rows to the incomplete native arm.
3. **Un-refusing REGRESSES rows.** A/B harness = compile + instantiate + run every
   `built-ins/Array/prototype/{reduce,reduceRight}` test262 file standalone:
   - **refusal ON (current main): PASS 363, FAIL 8, CE 68** (520 files)
   - **refusal OFF (the un-refuse): PASS 306 (−57), FAIL 57 (+49)**
   The native no-init arm returns WRONG results for the real corpus shapes
   (defineProperty-getter array-likes, sparse holes, proto-chain receivers,
   `arguments`); a bare object-literal array-like (`{0:..,1:..,length:n}`) is the
   only best-case shape that returns correctly, and it is not representative.

**A genuine un-refuse requires a CORRECT native no-init arm** (handle
defineProperty getters / holes / proto-chain / `arguments`) — that is the M2
value-rep / tag-aware-reader substrate (this issue's parked work; see the
S15.4.4 cluster row in the scoping doc above, and the M2 slices). It is NOT an
index-shift point-fix. Until that lands, the `arguments.length < 3` refusal in
`standaloneArrayLikeMethodRefused` (array-methods.ts) stays — it is strictly
better than the alternatives (working host path > incomplete native arm).
Tracking task #74 set WONT-FIX on this basis.
