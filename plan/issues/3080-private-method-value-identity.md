---
id: 3080
title: "private-method value identity: `this.#m === (()=>this)().#m` is false for class declarations (method-value-identity substrate)"
status: done
completed: 2026-07-09
assignee: ttraenkler/fable-identity
sprint: current
priority: low
horizon: m
feasibility: hard
reasoning_effort: max
model: fable
task_type: bugfix
area: codegen, runtime
language_feature: class-private-methods
es_edition: 6
goal: spec-completeness
created: 2026-07-07
related: [3045, 2963, 3037]
parent: 3045
---

## Resolution (fable-identity, 2026-07-09 — landed with the #2963/#3037 method-identity PR)

**Root cause (traced in WAT, not the narrated one):** not a "fresh wrapper per
access". The private-method VALUE read with a **non-`this` receiver**
(`(() => this)().#m`, property-access.ts brand-check branch, `cls.kind ===
"method"`) returned the **brand-checked RECEIVER itself** as an externref view
— a value that is neither the method nor `===` anything. The `this.#m` side
correctly answered the cached `__method_closure_C___priv_m` singleton
(`emitCachedMethodClosureAccess`), so the two sides could never be equal.

**Fix:** the method-value success arm now emits the SAME canonical singleton
(owner-chain + `classExprNameMap`-canonicalised key, captured via
pushBody/popBody with the detached throw-branch registered on `savedBodies`
during emission — the #2563 shift-hazard class). The brand check still throws
on a wrong-brand receiver; private-method CALLS are untouched (calls.ts path).

**Verified (both lanes):** `this.#m === (() => this)().#m` → 1 for class
declarations AND expressions; brand-check throw preserved; call parity
(`(() => this)().#m()` → 7) preserved; private GENERATOR method identity → 1
(host). Regression-locked in `tests/issue-2963-method-value-identity.test.ts`.

# #3080 — private-method value identity (`this.#m === (()=>this)().#m`)

Spun off from #3045 (class-expression enclosing-scope capture — DONE). #3045's
"Corrected finding" flagged two residual private-method-feature gaps behind the
8 harvested files. This issue records the **verify-first re-check on current
main** — one of the two is already resolved, the other is a method-value-identity
substrate instance.

## Verified on current main (2026-07-07) — corrects #3045's residual list

Empirically re-checked each residual #3045 named (compile + run, JS-host lane):

- **`.name` on a private method — ALREADY RESOLVED. Do NOT re-file.** All of
  `this.#m.name === '#m'`, name `.length`, a private **generator** method
  (`*#g(){}`), a **static** private method (`C.#s`), and `.name` via a local var
  (`let f = this.#m; f.name`) return the correct `'#m'` for **both** class
  declarations AND class expressions. #3045's "returns wrong value for both"
  no longer reproduces (fixed by intervening work).

- **arrow-captured-`this` private-method IDENTITY — REPRODUCES (declarations
  only).** The one real residual:

  ```js
  class C { #m() { return 1; }
    probe() { return this.#m === (() => this)().#m; } }   // ← false (should be true)
  new C().probe();
  ```

  `this.#m` and `(() => this)().#m` reference the SAME bound private method on
  the SAME receiver, so `===` must be `true`. On main it returns `false` for a
  class **declaration** (the class-**expression** form passes since #3045's
  Bug-2 fix). Note the **call** parity is fine — `(() => this)().#m()` returns
  the right value (`7`); only the function-VALUE identity comparison fails.

## Root cause (narrowed)

Not an arrow/`this`-capture bug (the arrow returns the correct receiver — method
calls through it work). It is **method-value identity**: accessing a
private method as a *value* (`this.#m`) materialises a **fresh, non-canonical
function wrapper** on each access instead of returning one stable object, so two
accesses of the same method on the same receiver are not `===`. This is the same
root as the broader class-method identity gap (`c.m === C.prototype.m`, ~87
test262 files) — methods lack stable first-class value identity.

## Why this is substrate (not a bounded point-fix)

Giving an accessed method a stable identity requires reifying methods as
first-class values with canonicalisation — the **#2963** (reify builtins/methods
as first-class values) / **#3037** (object-identity canonicalisation substrate)
work. This is Fable/senior substrate territory, not a standalone slice. Filed
here for tracking; the real fix lands with #2963/#3037.

## Acceptance criteria

- `this.#m === (() => this)().#m` is `true` for class declarations (and stays
  `true` for class expressions), without regressing private-method calls or
  `.name`.
- Fold into / gate behind the #2963/#3037 method-value-identity substrate rather
  than a bespoke wrapper-dedup hack.

## Provenance

Filed by dev-A after fixing the `claim-issue.mjs --allocate` hang (#3079) that
had blocked dev-3045 from allocating an id for this follow-up.
