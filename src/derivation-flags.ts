// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#743) The whole-program type-DERIVATION flag family, and the one token rule
 * they share.
 *
 * **Stakeholder decision, 2026-08-08: "derive types always; consumers arrive
 * later."** Every member of this family shipped default-OFF and every one of
 * them was kept off by a *benefit* verdict — the pass moved no slots, no
 * allocations, no wall time on acorn (see the "Flag verdict: STAYS OFF" entries
 * throughout `plan/issues/743-whole-program-type-flow-analysis.md`). That
 * criterion is retired: the analysis runs by default and whether a consumer
 * exploits it is decided separately, per consumer. The bar the flip had to
 * clear is therefore *cost*, not payoff — conformance-neutral and affordable at
 * compile time, both measured and recorded in that issue file's
 * "DEFAULTS FLIPPED" section.
 *
 * ## Why this module exists at all
 *
 * `JS2WASM_FNCTOR_CTOR_PARAM_TYPES` is read from THREE places that must agree
 * exactly — the field half (`codegen/fnctor-ctor-param-types.ts`), the legacy
 * param scan (`codegen/declarations/param-return-inference.ts`) and the IR
 * fixpoint's `new`-edge arm (`ir/propagate.ts`). They were three separate
 * inline `=== "1"` comparisons, which was safe only while the answer was a
 * single literal. Under the unset-⇒-ON rule the answer is a small parse, and
 * three copies of a parse drift. The modules cannot share a predicate through
 * any of themselves (`fnctor-ctor-param-types.ts` imports
 * `param-return-inference.ts`, so the reverse import is a cycle, and `ir/`
 * must not depend on `codegen/`), so the predicate lives here: a LEAF with no
 * imports, which nothing can cycle through.
 *
 * The per-pass modules keep their own exported predicates as the public name —
 * they delegate here rather than re-implementing.
 *
 * ## The token rule (the #4241 layout-emit idiom, verbatim)
 *
 * Unset ⇒ ON. `0` / `off` / empty ⇒ OFF. Case-insensitive, whitespace-trimmed.
 * Any other value — including `1`, including a typo — is ON.
 *
 * Boolean-shaped on purpose: there is no numeric knob in this family, so a
 * malformed value cannot half-enable anything. It merely fails to disable,
 * which is the safe direction for a flag whose OFF position exists to be a
 * one-variable revert. The asymmetry is deliberate — `JS2WASM_X=` (empty, the
 * shape a shell emits for an unset variable it forwards anyway) disables,
 * because an empty string is far more likely to mean "I tried to turn this off"
 * than "I tried to turn this on".
 */

/**
 * The family's shared token rule. Exported for the tests that pin the spelling;
 * production code should call one of the named predicates below.
 */
export function derivationFlagEnabled(raw: string | undefined): boolean {
  if (raw === undefined) return true;
  const norm = raw.trim().toLowerCase();
  return norm !== "" && norm !== "0" && norm !== "off";
}

/**
 * (#4415) Per-compile memo for the seven predicates below.
 *
 * `process.env.X` is not a property read — V8 goes to the real environ block
 * every time, measured **85x slower** than a cached boolean (2M reads: 507 ms
 * vs 6 ms). These predicates are called from the hot lowering path, and a CPU
 * profile of 40 steady-state test262 compiles put
 * `fnctorCtorParamTypesFlagEnabled` at **2.3% of total compile time** — ~12 ms
 * per compile, i.e. tens of thousands of env reads, to answer a question whose
 * answer cannot change while a compile is running.
 *
 * Memoised per compile rather than per process because ~244 sites under
 * `tests/` set and delete these variables between compiles; a module constant
 * would silently freeze the first value and break them. {@link
 * resetDerivationFlagCache} is called once at the start of each compile, so a
 * test's `process.env.X = "0"` is picked up by the next compile — the only
 * point at which it could ever have taken effect anyway.
 */
const flagCache = new Map<string, boolean>();

/** Drop the memo. Called once per compile; safe to call at any time. */
export function resetDerivationFlagCache(): void {
  flagCache.clear();
}

/** `derivationFlagEnabled(process.env[name])`, read at most once per compile. */
function cachedFlag(name: string): boolean {
  const hit = flagCache.get(name);
  if (hit !== undefined) return hit;
  const value = derivationFlagEnabled(process.env[name]);
  flagCache.set(name, value);
  return value;
}

/**
 * `JS2WASM_FNCTOR_CTOR_PARAM_TYPES` — the #743 satellite: constructor-parameter
 * and `this`-field-read facts from the whole-module call graph, consumed f64-only
 * by `codegen/fnctor-ctor-param-types.ts`.
 *
 * ON also runs the #4246 satellite passes, which have no gate of their own
 * because they are unreachable without this one: receiver-provenance
 * attribution (`ir/fnctor-receiver-provenance.ts`), function-local bindings
 * (`ir/fnctor-local-bindings.ts`) and the string substrate
 * (`ir/fnctor-string-producers.ts`), all composed into the satellite evaluator
 * by `ir/fnctor-eval-extensions.ts`. That is the compile-time cost this flip
 * had to price: the satellite fixpoint now runs on every standalone compile.
 */
export function fnctorCtorParamTypesFlagEnabled(): boolean {
  return cachedFlag("JS2WASM_FNCTOR_CTOR_PARAM_TYPES");
}

/**
 * `JS2WASM_FNCTOR_CTOR_PARAM_SLOTS` — **the one sub-lever DELIBERATELY LEFT OFF
 * by the 2026-08-08 flip.** Opt in with `=1`; it is the only flag in this file
 * whose default is OFF, and the only one that does NOT follow the token rule
 * above (an explicit `1` is required, so it cannot be enabled by accident).
 *
 * It gates `inferFnctorFieldTypeFromCtorParam`: turning a derived ctor-param
 * fact into a **physical field SLOT** (`externref` → `f64`).
 *
 * ## Why it is excluded
 *
 * A field's type must join over EVERY write that reaches it. This narrowing
 * consults the constructor's param facts, which say nothing about writes to the
 * field made anywhere else. Measured on this branch:
 *
 *     var A = function A(n) { this.tag = n; };
 *     var a = new A(1);
 *     a.tag = "s";
 *     typeof a.tag === "string"   //  1 with the slot lever off
 *                                 //  0 with it on   ← wrong answer
 *
 * Both of the narrowing's arms have this hole, not just one: the `this.f =
 * <param>` arm and the `this.f = this.<y>` field-fact arm were probed
 * separately and both miss a later `a.f = "s"`.
 *
 * **The defect class is NOT new.** The identical wrong answer is already
 * reachable on `main` with every flag off, whenever the constructor's write is
 * a literal the checker can type (`this.tag = 1` derives `f64` and the later
 * string write is lost the same way). What this lever changes is the
 * POPULATION: it extends the same hazard to constructors whose write is an
 * OPAQUE PARAMETER — which is precisely the acorn-shaped code the pass was
 * built for. Enlarging a silent-wrong-answer class in exchange for slots that
 * measured zero value-level effect (#4246: `$AnyValue` allocations identical
 * flag-on and flag-off) is a bad trade in the one direction that matters, so
 * the DEFAULT stays sound and the lever stays opt-in.
 *
 * ## What unblocked it (#4250, 2026-08-09)
 *
 * The whole-program per-field WRITE-KIND VERDICT
 * (`computeFnctorGraphFieldVerdicts`, `src/ir/fnctor-method-edges.ts`): the
 * join over every write the satellite can enumerate as reaching
 * `Owner.<field>`, with every cannot-see path — escaped owner, replaced
 * prototype, computed-key writes, `delete`, reflection — answering DYNAMIC.
 * `inferFnctorFieldTypeFromCtorParam` now refuses any narrowing the verdict
 * cannot positively justify (fail-closed: an absent owner, an absent field, a
 * merely-UNPROVEN write all mean NO), which closes the hole above: the later
 * `a.f = "s"` is an enumerated write, its string contribution widens the
 * verdict, and the slot stays `externref`. With that in place this flag joins
 * the family's unset-⇒-ON rule.
 *
 * The lever is only defensible WITH the verdict, so disabling the verdict
 * (`JS2WASM_FIELD_WRITE_VERDICT=0`) forces this lever OFF regardless of its
 * own variable — the unsound-lever-ON combination cannot be reached by one
 * stray environment line.
 *
 * (`numericPropertyNames` — #3683 S4a — remains what it was: name-keyed and
 * syntactic-only, which is exactly why acorn's `Parser.pos` never qualified
 * for it and why the verdict had to come from the satellite's value facts
 * instead.)
 *
 * Note the deliberately narrow scope: this flag does NOT gate the `new`-site
 * PARAMETER narrowing in either inference lane. A parameter's writes ARE its
 * call sites, which the existing conflict/under-application/escape rules
 * already enumerate — so that half keeps `JS2WASM_FNCTOR_CTOR_PARAM_TYPES` and
 * ships ON.
 */
export function fnctorCtorParamSlotsEnabled(): boolean {
  return fieldWriteVerdictEnabled() && cachedFlag("JS2WASM_FNCTOR_CTOR_PARAM_SLOTS");
}

/**
 * `JS2WASM_FIELD_WRITE_VERDICT` — the #4250 per-field write-kind verdict, in
 * BOTH of its consumer roles:
 *
 *  1. the fail-closed gate inside `inferFnctorFieldTypeFromCtorParam` (see the
 *     SLOTS flag above, which this one dominates), and
 *  2. the proven-violation veto on the PRE-EXISTING literal slot choice in
 *     `deriveFnctorFields` — the `this.tag = 1; … a.tag = "s"` miscompile that
 *     was reachable on `main` with every flag off since the fnctor machinery
 *     shipped.
 *
 * OFF restores the pre-#4250 behaviour of role 2 and forces the SLOTS lever
 * off (role 1 has no sound OFF state of its own). Same token rule as the rest
 * of the family.
 */
export function fieldWriteVerdictEnabled(): boolean {
  return cachedFlag("JS2WASM_FIELD_WRITE_VERDICT");
}

/**
 * `JS2WASM_DTS_ENTRYPOINT_SEEDS` — seed an exported entrypoint's implicit-`any`
 * parameters from the package's shipped `.d.ts`.
 *
 * Seeds are restricted to `string`/`number`, the two declared types whose
 * export boundary already guards a violating external caller (ToNumber at an
 * f64 param; a TypeError at a native-string ref param). `boolean` was
 * considered and excluded because ToInt32 at an i32 boundary diverges from JS
 * truthiness — see the trust-boundary paragraph in the issue file. That
 * restriction is what makes default-ON a soundness-preserving change rather
 * than blind trust in a declaration file.
 */
export function dtsEntrypointSeedsFlagEnabled(): boolean {
  return cachedFlag("JS2WASM_DTS_ENTRYPOINT_SEEDS");
}

/**
 * `JS2WASM_FNCTOR_TYPED_READS` — #4155 Phase 2: direct `struct.get`/`struct.set`
 * for a struct-typed fnctor receiver, instead of the dynamic member ladder.
 * A direct CONSUMER of the derived slot types, not a derivation itself.
 */
export function fnctorTypedReadsFlagEnabled(): boolean {
  return cachedFlag("JS2WASM_FNCTOR_TYPED_READS");
}

/**
 * `JS2WASM_FNCTOR_TYPED_BINDINGS` — #2660 S3b: a function-local binding that
 * provably holds only one escape-gate-approved fnctor's instances gets the
 * reserved `(ref null $__fnctor_F)` slot instead of `externref`. The multiplier
 * that takes typed reads from 78 to 424 candidate sites on acorn.
 */
export function fnctorTypedBindingsFlagEnabled(): boolean {
  return cachedFlag("JS2WASM_FNCTOR_TYPED_BINDINGS");
}

/**
 * `JS2WASM_NUMERIC_RETURNS` — allow a standalone function's implicit-`any`
 * result to use a numeric carrier when every returned value is independently
 * proven numeric, even when an unrelated parameter uses a non-numeric ABI.
 *
 * This is a consumer of the grounded, symbol-scoped numeric-local verdict. It
 * is deliberately separate from the older all-parameters-numeric recursive
 * kernel inference so `=0` restores that established signature selection
 * exactly.
 */
export function numericReturnsFlagEnabled(): boolean {
  return cachedFlag("JS2WASM_NUMERIC_RETURNS");
}
