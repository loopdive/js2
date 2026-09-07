---
id: 5345
title: "marked Hooks residual (9/30): a dynamic read narrowed to `i32` reports an absent property as `false`, and a computed-key read of any class prototype method answers null"
status: in-progress
sprint: current
created: 2026-09-05
updated: 2026-09-06
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: correctness
---

## Problem

marked's single admitted file, `test/unit/Hooks.test.js`, is **9/30** on clean
main `c9a8b48616` (0 at the start of this effort — #5292, #5293, #5315, #5320
each removed one wall). The #5315 agent bisected the remaining 21 into two
clusters and left them, both measured, neither fixed:

**Cluster A — 11 × `The async option was set to true by an extension`.**
FIXED (see Implementation Notes). The guard is
`this.defaults.async === true && origOpt.async === false` with
`origOpt = {...options}` and `options` undefined, so `origOpt.async` must be
`undefined`. It read a definite `false`.

**Cluster B — `Cannot read properties of null (reading 'apply'/'call')`.**
NOT FIXED. `use()` installs hooks with
`const a = r[o]; r[o] = c => … a.call(r, c)` where `o` comes from
`for (const o in pack.hooks)` — a runtime string — and `r` is a `Hooks`
instance. `a` reads **null** for *every* prototype method.

## Acceptance criteria

1. `Hooks.test.js` ≥ 20/30 (either cluster fully fixed; both is the goal).
2. Regression tests, one per cluster, failing on parent, passing with fix,
   untyped `.js` two-file fixtures. Cluster A must pin `absent === undefined`
   on a spread-derived object **and** keep `false === false` on a field that
   is really `false` (anti-vacuity). Cluster B must pin a computed-key read
   of a default-param method returning a callable, plus a no-default method
   as control.
3. A/B at one HEAD, 17 suites, per test file — marked improves, nothing else
   moves (anchors in #5338).
4. All ratchet gates green including `pnpm run check:dogfood-validation`.

## Implementation Plan

**Cluster B first** — it is the sharper defect and likely smaller.

1. Reduce: `class H { pre(x) { return x; } withDefault(e = 1) { return e; } }
   const h = new H(); for (const o in {pre:0, withDefault:0}) { const a =
   h[o]; assert(typeof a === "function"); }`. Confirm `withDefault` reads
   null. Dump WAT: the computed-key read goes through `__get_member_<name>` /
   `member-get-dispatch.ts` (`classMethodCandidatesForProp`). A method with a
   default parameter has a **different lifted signature** (arity/optional
   sentinel), so `ctx.funcMap.get(classMemberFuncKey(...))` or the
   `methodFuncIdx` lookup likely misses and the arm is dropped. Fix the
   candidate enumeration to resolve default-param methods; do not special-case
   the two names.
2. **Cluster A**: this is the "absent vs false" representation problem. Read
   #5315 defect 2's fix in `literals.ts` `compileObjectLiteralForStruct`
   (spread sources) and how a struct field that the source lacks is
   initialised. Options, in order of preference: (a) when a spread source
   *may* lack a boolean/number field, type that field's slot `externref`
   (nullable) rather than `i32`/`f64` so absence is representable — the
   #2011/#4204 widening precedent in `moduleGlobalWasmType` /
   `heterogeneous-scalar-var-widening.ts` is the model; (b) if the slot must
   stay `i32`, the strict-equality lowering against a boolean literal must
   consult a presence flag. (a) is sound; (b) is a patch. Take (a) unless it
   moves the A/B.
3. Regression tests; A/B; **one PR per cluster**.

Out of scope, recorded in #5315: the standalone/WASI lane still lacks an
own-property predicate; virtual-dispatch call sites are unguarded pending
#5577.

## Dispatch

Model: **opus**. Cluster A is a representation decision with a real
blast-radius trade-off; Cluster B needs the closed-dispatch candidate
machinery read carefully.

## Implementation Notes (2026-09-06)

Measured on `upstream/main` `68e1c0c2cb`. **Four of this issue's own claims did
not survive contact.** Recorded here so the next agent does not re-derive them.

### The two clusters are SERIAL, not parallel — AC 1 as written is unreachable

AC 1 says "≥ 20/30 (either cluster fully fixed)". They are not independent:
Cluster A's guard throws *before* the hook wrapper runs, and Cluster B breaks
that same wrapper. Fixing A alone moves marked from **9/30 to 9/30** — the 11
async errors disappear and the same 10 tests immediately fail one step later
with `Cannot read properties of null (reading 'trim')` (the null `prevHook`
returning nothing, so `lex()` gets null). ≥20/30 needs **both**. What landed
here is A; B is untouched and is what still gates the counter.

Also note the failure set on `68e1c0c2cb` is not the one this issue recorded on
`c9a8b48616`: it is 11 async + 4 `this.block`-undefined + 2 `value is not
iterable` + 2 deepStrictEqual + 1 `<p>line1` + 1 `illegal cast`, and **zero**
`reading 'apply'`. Cluster B was invisible because Cluster A pre-empted it.

### Cluster A: the defect is not where the plan said, and not a struct slot

The plan blames `compileObjectLiteralForStruct` and prescribes widening the
spread-derived struct's boolean slot to `externref`. Both were checked and are
wrong for marked:

- **marked is compiled from its published `lib/marked.esm.js` bundle**, not
  `src/*.ts` (see `marked-upstream-suite.mjs` → `transformMarkedTest`). There
  are no interfaces, no `MarkedOptions`, no optional-property annotations. A
  widening in `mapDeclaredFieldType` was implemented and measured: it fixes
  `interface Opts { async?: boolean }` (a real, separate defect — an absent
  optional boolean reads `false` where an absent optional *string* correctly
  reads `undefined`) and moves marked **not at all**. Reverted.
- `origOpt = {...options}` does not produce a struct at all. It lowers to
  `__new_plain_object` + a copy loop — a **host** object — and the read
  `origOpt.async` correctly answers `undefined`. `Object.keys(origOpt)` is
  `["silent"]` and `"async" in origOpt` is `false`. Nothing about the object is
  wrong.

The actual defect is in `finalizeStructAndDynamicMemberGet`
(`property-access-dispatch.ts`), in the Phase-3 (#1269) **narrowing vote**: when
every struct carrying the name agrees on one field kind, the dynamic read's
result type is narrowed to that scalar. Exactly one struct in marked carries
`async` (the defaults literal `{async:!1, …}`, an `i32`), so the read was
narrowed to `i32` and the dispatcher terminal's `undefined` was coerced back
down through `__unbox_number` + `i32.trunc_sat_f64_s` — NaN saturates to `0`,
bit-identical to `false`.

The tell that this is a *comparison-lowering* fault and not a value fault:
on the parent commit `origOpt.async === false` and `origOpt.async === undefined`
were **both true for the same read**. Which one a program observes depends on
the order it asks; marked asks `=== false` first.

Fix: `i32` is no longer an admissible narrowing target for a dynamic read
(`src/codegen/dynamic-read-narrowing.ts`). `f64` keeps its narrowing — it has a
NaN/sentinel encoding for "absent" and is the hot numeric case; `i32` has no
spare value at all, so for a boolean slot the lie is unconditional. This is the
general form of #3927, which fixed the identical symptom (acorn: all 32,506 AST
nodes read `node.generator === false`) by contributing `externref` from a
carrier the finder could not see. Removing the unsound target also covers the
case #3927 could not: the receiver is not a struct in the first place.

The #2938 boolean-brand preservation the old `i32` arm existed for is kept for
free — the finalize-filled `__get_member_<name>` dispatcher boxes a branded slot
through `__box_boolean` itself.

### Cluster B: not default-param-specific, and much larger than estimated

The plan's mechanism ("a default-param method has a different lifted signature,
so `classMemberFuncKey`/`methodFuncIdx` misses") is wrong on both halves.

- **Every prototype method is affected, default parameter or not.** Reduction
  (`tests/issue-5345-…test.ts`, second describe): `preprocess(markdown)` —
  no default — reads `undefined` through a runtime key, identically to
  `provideLexer(block = this.block)`. The reason marked's earlier bisect saw
  only the two default-param hooks is that those are the only ones whose
  `prevHook` is reached on the paths that were failing at the time.
- **The control that isolates it:** the same computed-key read against a plain
  object literal returns `function`. A literal's methods are struct FIELDS, so
  `__sget_<name>` reaches them; a class's live on the prototype and have **no
  host-visible carrier**.
- It is not the candidate enumeration. `classMethodCandidatesForProp` is only
  consulted for a *statically named* property. With a runtime key there is no
  `propName`, so the read lowers to a bare
  `__extern_get(extern.convert_any(recv), key)` and no dispatcher is involved.
  A key the compiler can const-fold (`const k = "preprocess"; h[k]`) works
  today — which is what makes this look narrower than it is.
- Measured: with a genuine runtime key, `Hooks.prototype[k]` and
  `Object.getPrototypeOf(h)[k]` are **also** `undefined`. The prototype
  `$Object` does not physically carry the methods in the JS-host lane, so
  there is nothing to delegate to. Only a class with a runtime-keyed member
  gets its prototype force-initialised (#5195 Step 1.5/1.7) and only in
  standalone.

So Cluster B = **#5195 Step 4.3** (populate every class's prototype `$Object`,
which needs the force-init question answered generally) **plus a JS-host-lane
twin of `__class_proto_lookup`**. Sizing done here: marked has 14 classes /
273 class-method entries; `memberGetDispatchNames` has 128 names and
`memberGetMethodArms` 27, and **none** of them are `preprocess`, `postprocess`,
`provideLexer`, `provideParser` or `processAllTokens` — so the cheap option
(chain the dynamic key over the dispatchers that already exist) does not reach
marked's hooks and would need ~150 new closure singletons minted. That is a
representation change to the hottest chokepoint in the runtime and wants its own
issue and its own A/B, not a tail-end addition to this one.

### A/B (17 suites, both arms at `68e1c0c2cb`, one suite at a time)

Every suite is byte-identical between arms; per test file, **zero deltas**.
webpack 16/16 · three 17/18 · clsx 32/32 · cookie 63740/63740 · lodash 53/62 ·
redux 61/82 · axios 200/231 · stylelint 108/108 · tailwindcss 13/13 · jsdom 6/6 ·
styled-components 9/9 · uuid 75/75 · marked 9/30 · moment 10/10 ·
prettier 101/151 · jest 329/358 · hono 244/324.

**axios needed the "re-run it ALONE" rule.** Its first fix-arm run reported
162/231; `compile.details` showed 11 of its 33 modules failing with
`Cannot find package 'tsx'` from the worker spawn — an infrastructure artifact
under load, not a code change. The base arm compiled 33/33 and a solo fix-arm
re-run also compiled 33/33 and scored 200/231. Worth knowing: this artifact is
invisible in the headline and in `results.tests` (those entries carry
`wasmError: null`); only `compile.details` names it.

### Also observed, deliberately not fixed

- An absent optional **number** on a declared struct reads `NaN`, not
  `undefined` (`count?: number`). Same family as the optional-boolean defect
  above; widening f64 would move the representation of the commonest field kind.
- `{...options}` where `options` is a typed `Opts | null | undefined`
  parameter traps with `illegal cast` on the parent commit too — unrelated to
  this issue, and it is very likely the `RuntimeError: illegal cast` in
  marked's `should process tokens before walkTokens`.
