// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4506 S1) The SLOT half of the `new F()` → `$Object` reconstruction.
 *
 * ## What was actually blocking the representation change
 *
 * #2660 S3a landed the reconstruction itself: an escape-gate-approved,
 * empty-body, no-arg `new F()` under `--target standalone` is emitted as
 * `__object_create(F.prototype)` — a real `$Object` whose `$proto` is the one
 * per-fnctor prototype object every other consumer reads. Everything downstream
 * of that (`isPrototypeOf`, the `in` chain walk, descriptors, expandos) then
 * works through the ONE `$Object.$proto` walk with no new mechanism.
 *
 * It almost never fires. Measured on this branch (405 ES≤5 test262 files that
 * construct a user function, instrumented at the gate, run by this agent):
 *
 * | outcome for a `new F()` site | n |
 * | --- | ---: |
 * | classified `reconstruct` by the escape gate | 178 of 227 |
 * | of those, the S3a lowering actually fires | 74 |
 * | of those, it DECLINES because the binding's Wasm slot is not externref | **91** |
 * | declines for a non-empty ctor body / ctor args | 13 |
 *
 * So the dominant blocker is not the analysis and not the emission — it is the
 * slot. `fnctorNewResultConsumedAsExternref` (new-super.ts) refuses to return an
 * externref into a slot allocated from the checker's nominal instance type
 * (`(ref null $__fnctor_F)`), and it is RIGHT to refuse: doing so would
 * `ref.cast`-trap. The missing piece is to allocate the slot as externref in the
 * first place, for exactly the sites the lowering will reconstruct.
 *
 * ## Why the predicate lives here and not at either consumer
 *
 * Two independent places decide, and they must not be able to disagree:
 *
 *  - the slot TYPERS (`declarations.ts::moduleGlobalWasmType` for a module-scope
 *    `var x = new F()`, run during `collectDeclarations`), and
 *  - the LOWERING (`new-super.ts`, run during codegen, much later).
 *
 * A widened slot whose site then keeps the bespoke-struct lowering is not a
 * missed row, it is a WRONG one: the struct gets `extern.convert_any`'d into the
 * externref slot and every dynamic read of it misses (`ref.test $Object` fails
 * on a fnctor struct). So both consult this one predicate, and it deliberately
 * asks NOTHING about the slot — it is a property of the SITE (gate verdict,
 * ctor shape, argument count), decidable identically before and during codegen.
 * `ctx.fnctorEscapeGate` is frozen at index.ts before `collectDeclarations`,
 * which is what makes the two evaluations provably equal.
 *
 * The slot-type check in `fnctorNewResultConsumedAsExternref` is deliberately
 * LEFT IN PLACE rather than replaced by this predicate. It is the load-bearing
 * safety check (#2660 S3a) — "never return externref into a slot that is not
 * externref" — and keeping it means a shape this module fails to widen (a
 * function-local binding, a parameter, a `return`) still degrades to the
 * status-quo struct lowering instead of trapping. Widening only makes agreement
 * POSSIBLE; it never asserts it.
 */
import { ts } from "../ts-api.js";
import type { CodegenContext } from "./context/types.js";

/**
 * True when `newExpr` is a `new F()` site the #2660 S3a lowering will emit as a
 * native `$Object`. Every clause mirrors the lowering gate in
 * `compileNewFunctionDeclaration`, minus the slot question:
 *
 *  - **standalone/WASI only** — the host lane has the #1712 instance→prototype
 *    sidecar and `__object_create` is native only here, so host stays
 *    byte-identical.
 *  - **escape-gate approved** (`reconstruct` = clause A ∧ B): dynamically
 *    consumed AND no typed own-field consumer. This is what keeps the #1888 hot
 *    path safe; the gate is conservative-closed, so an unproven site keeps the
 *    struct.
 *  - **not an Array-carrier prototype** (#4387): `$Object.$proto` cannot hold an
 *    Array carrier, so reconstructing would discard the chain.
 *  - **empty ctor body**: with no `this.x = …` there is no own field to
 *    initialize and no side effect to drop. Running a real body against an
 *    `$Object` receiver is the next slice, not this one.
 *  - **no ctor arguments**: nothing to evaluate; an arg'd site keeps status quo
 *    so its argument side effects still run through the real ctor.
 */
export function newExpressionReconstructsAsObject(ctx: CodegenContext, newExpr: ts.NewExpression): boolean {
  if (!ctx.standalone) return false;
  const gate = ctx.fnctorEscapeGate;
  if (gate === undefined) return false;
  if (!gate.approved.has(newExpr)) return false;
  if ((newExpr.arguments?.length ?? 0) !== 0) return false;
  // The gate resolved this site's constructor already (through the alias /
  // cast unwrapping `resolveFnctorSymbol` does), so read its answer rather
  // than re-deriving one — the identifier's TEXT is not always the symbol name
  // (`new (F as any)()`), and a key that disagrees with `ctorDeclByName` /
  // `stableArrayPrototypeNames` would silently answer about a different
  // constructor.
  const name = gate.siteCtorName.get(newExpr);
  if (name === undefined) return false;
  if (ctx.classSet.has(name)) return false;
  if (gate.stableArrayPrototypeNames.has(name)) return false;
  // The gate's `ctorDeclByName` is the SAME declaration resolution
  // `compileNewFunctionDeclaration` performs (#2773 S1 states this explicitly),
  // so the emptiness verdict here is the emptiness verdict there.
  const decl = gate.ctorDeclByName.get(name);
  const body = decl?.body;
  if (body === undefined) return false;
  if (body.statements.length !== 0) return false;
  if (prototypeCarriesAttributeInstall(newExpr.getSourceFile(), name)) return false;
  return true;
}

/**
 * The `Object.*` calls that can put a NON-DEFAULT attribute on `F.prototype`.
 * A plain `F.prototype.p = v` cannot — §10.1.9 CreateDataProperty gives it
 * `{writable, enumerable, configurable}` — so only these need the exclusion.
 */
const ATTRIBUTE_INSTALLERS = new Set(["defineProperty", "defineProperties", "freeze", "seal"]);

/**
 * True when `file` installs non-default property attributes on
 * `<name>.prototype` — `Object.defineProperty(F.prototype, …)` and friends.
 *
 * ## Why this excludes the site, measured
 *
 * §10.1.9 OrdinarySetWithOwnDescriptor: a set on a receiver whose PROTOTYPE
 * carries a non-writable data property of that name is a silent no-op in sloppy
 * code — no own property is created. Our `$Object` `[[Set]]` does not implement
 * that lookup; it writes the own property. On the bespoke struct the same write
 * was dropped for an unrelated reason (the struct has no such slot), so the
 * observable answer happened to be right.
 *
 * That made `language/expressions/assignment/8.14.4-8-b_1.js` the ONE regression
 * in this slice's 2,268-file A/B (`Object.defineProperty(foo.prototype, "bar",
 * {value:"unwritable"}); var o = new foo(); o.bar = "overridden";` ⇒
 * `o.hasOwnProperty("bar")` became true). Its sibling `_b_2` passes both ways.
 *
 * The gap is GENERAL to `$Object` — the identical shape written with
 * `Object.create` has it too, on the base as much as on the branch — so the
 * right long-term fix is in `[[Set]]`, not here. Until then this declines the
 * conversion for the population that can observe it, which is the trade this
 * campaign requires: a missing conversion, never a wrong answer.
 *
 * Deliberately syntactic and deliberately NAME-keyed rather than
 * symbol-resolved: a same-named unrelated `X.prototype` in the file makes this
 * decline, which is the safe direction.
 */
function prototypeCarriesAttributeInstall(file: ts.SourceFile, name: string): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      (node.expression.expression.text === "Object" || node.expression.expression.text === "Reflect") &&
      ATTRIBUTE_INSTALLERS.has(node.expression.name.text)
    ) {
      const target = node.arguments[0];
      if (
        target !== undefined &&
        ts.isPropertyAccessExpression(target) &&
        target.name.text === "prototype" &&
        ts.isIdentifier(target.expression) &&
        target.expression.text === name
      ) {
        found = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

/**
 * True when `decl` is a `var/let/const x = new F()` whose initializer this
 * module's predicate reconstructs — i.e. the binding will receive an externref
 * `$Object` and its Wasm slot must be externref to hold one.
 *
 * Consumed by the module-global slot typer. A binding whose initializer is
 * anything else (including a `new F(arg)` or a non-empty-bodied constructor)
 * answers `false` and keeps whatever type the existing cascade derived.
 */
export function variableSlotHoldsReconstructedFnctorInstance(
  ctx: CodegenContext,
  decl: ts.VariableDeclaration,
): boolean {
  let init = decl.initializer;
  while (init !== undefined && ts.isParenthesizedExpression(init)) init = init.expression;
  if (init === undefined || !ts.isNewExpression(init)) return false;
  return newExpressionReconstructsAsObject(ctx, init);
}
