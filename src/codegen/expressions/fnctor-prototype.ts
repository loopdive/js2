// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2660 S2 — per-fnctor prototype `$Object` (standalone).
 *
 * A user function constructor `F` (a `function F(){}` / `function expression` /
 * `var F = function(){}`, NOT a `class`) is lowered to a closure trampoline
 * struct, NOT an `$Object`. So `F.prototype` read/write went through
 * `__extern_get` / `__extern_set` on the closure struct, whose `ref.test $Object`
 * MISSES → the write was silently dropped and the read returned null. Result:
 * `Object.create(F.prototype).foo` returned 0 (verified in the emitted WAT —
 * `Con.prototype` reads as `__extern_get($closure, "prototype")`).
 *
 * S2 synthesizes a per-fnctor prototype object held in a `mut externref` module
 * global (`ctx.fnctorPrototypeObject`, keyed by the fnctor symbol name) that is a
 * real native `$Object`:
 *   - READ `F.prototype` → lazy-init an empty `$Object` (`__new_plain_object`) on
 *     first access, then `global.get`.
 *   - WRITE `F.prototype = rhs` (whole reassign) → build `rhs` as a native
 *     `$Object` when it is a plain object literal (the #2580 Stage-A precedent),
 *     else compile it to externref, then `global.set`.
 *   - WRITE `F.prototype.p = v` (per-prop) needs NO code here — it RIDES the read
 *     interception: the inner `F.prototype` read returns the global `$Object`, and
 *     the existing `__extern_set_strict` fallback writes `p` onto it.
 *
 * This is the readable `$Object` that #2660 S3 will seed `instance.$proto` from at
 * `new F()` — ONE link location (`$Object.$proto`), ONE walk
 * (`__extern_get`/`__extern_has`). No parallel `[[Prototype]]` mechanism.
 *
 * Gated on `ctx.standalone` (the host fnctor prototype is the #2660 (3a) sidecar
 * lap — host stays byte-identical). Classes (`ctx.classSet` / class fast path in
 * property-access), builtins (`Array.prototype` etc.), arrow functions, and
 * method receivers are all excluded by `resolveFnctorSymbol` (it only matches an
 * identifier resolving to a user `FunctionDeclaration`/`FunctionExpression` /
 * `var F = function` with a body). The closed-struct/`$Object` shapes the hot
 * path relies on are untouched.
 */
import { ts } from "../../ts-api.js";
import type { Instr, ValType } from "../../ir/types.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { resolveFnctorSymbol } from "../fnctor-escape-gate.js";
import { nextModuleGlobalIdx } from "../registry/imports.js";
import { ensureLateImport, flushLateImportShifts } from "./late-imports.js";
import { compileObjectLiteralAsExternref } from "../literals.js";
import { coerceType, compileExpression } from "../shared.js";
import { emitCachedFuncClosureExternref } from "../closures/method-trampolines.js";
import { ensureObjectRuntime } from "../object-runtime.js";
import { stringConstantExternrefInstrs } from "../native-strings.js";
import { addStringConstantGlobal, localGlobalIdx } from "../registry/imports.js";

/**
 * (#4480 S1) Is `sym` an ORDINARY function — a plain, non-generator, non-async
 * declaration or function expression?
 *
 * `resolveFnctorSymbol` deliberately accepts any body-bearing function, which is
 * right for the RECONSTRUCT population (you cannot `new` a generator, so those
 * names never reach the approved set anyway). The widened never-constructed arm
 * below has no such implicit filter, so it needs an explicit one — for two
 * independent reasons:
 *
 *  - `genFn.prototype` is NOT an auto-minted empty object; it is
 *    `%GeneratorPrototype%`, and `property-access-dispatch.ts` already answers
 *    it from `emitGeneratorPrototypeSingleton` / the async host import. This
 *    module's arm sits EARLIER in the dispatch, so admitting a generator here
 *    would shadow the right answer with a wrong one.
 *  - the `constructor` back-ref materializes the closure singleton with
 *    `constructible: true`; that flavor is meaningless for a generator/async
 *    function and is the exact flag whose mismatch `arguments-callee.ts`
 *    records as a runtime `illegal cast`.
 */
function isOrdinaryFunctionSymbol(ctx: CodegenContext, sym: ts.Symbol): boolean {
  const decl = sym.valueDeclaration ?? sym.getDeclarations()?.[0];
  if (decl === undefined) return false;
  let fn: ts.Node = decl;
  if (ts.isVariableDeclaration(decl)) {
    let init = decl.initializer;
    while (init !== undefined && ts.isParenthesizedExpression(init)) init = init.expression;
    if (init === undefined || !ts.isFunctionExpression(init)) return false;
    fn = init;
  }
  if (!ts.isFunctionDeclaration(fn) && !ts.isFunctionExpression(fn)) return false;
  if (fn.asteriskToken !== undefined) return false;
  if (fn.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) === true) return false;
  // A `function*` whose declaration the generator lowering already claimed.
  return !ctx.generatorFunctions.has(sym.name);
}

/**
 * Resolve a property-access/assignment receiver to a user-fnctor key (the
 * resolved symbol name), or `undefined` when it is not a user function
 * constructor. Mirrors the recognition `analyzeFnctorEscapeGate` /
 * `compileNewFunctionDeclaration` use, so the read/write key agrees with the
 * `new F()` lowering. Classes, builtins, arrows, and non-identifier receivers
 * return `undefined`.
 */
export function resolveUserFnctorName(ctx: CodegenContext, expr: ts.Expression): string | undefined {
  // `resolveFnctorSymbol` itself unwraps `( … )` / `as` / `!` wrappers and
  // requires the inner node to be an identifier resolving to a user function
  // (not a class/arrow/builtin), so do NOT pre-gate on `ts.isIdentifier` —
  // `(Con as any).prototype` must still resolve to `Con`.
  const sym = resolveFnctorSymbol(ctx.checker, expr);
  if (!sym) return undefined;
  // RECONSTRUCT-GATE (#2660 S2): only materialize the per-fnctor prototype
  // `$Object` for a constructor S3 will reconstruct (≥1 `reconstruct`-classified
  // `new F()` site). A `keep-typed` / `keep-static` / never-`new`'d function keeps
  // its existing prototype behaviour — an UNSCOPED interception clobbered working
  // paths: the species `Ctor.prototype` IDENTITY in `Array/prototype/*/create-proxy`
  // (Ctor is never `new`'d in source), and `Test262Error.prototype.toString` once
  // the keep-in-init made it execute (Test262Error is `keep-typed`). Both ejected
  // the standalone floor (−40). Gate on the S1 escape-gate result (computed at
  // index.ts:1076, before collectDeclarations + codegen, so it is always set).
  const hasRuntimeDescriptorInstall = (() => {
    let found = false;
    const visit = (node: ts.Node): void => {
      if (found) return;
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === "Object" &&
        (node.expression.name.text === "defineProperty" || node.expression.name.text === "defineProperties")
      ) {
        const receiver = node.arguments[0];
        if (
          receiver &&
          ts.isPropertyAccessExpression(receiver) &&
          receiver.name.text === "prototype" &&
          ts.isIdentifier(receiver.expression)
        ) {
          const receiverDeclaration = ctx.oracle.valueDeclarationOf(receiver.expression);
          if (receiver.expression.text === sym.name && receiverDeclaration === sym.valueDeclaration) {
            found = true;
            return;
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(expr.getSourceFile());
    return found;
  })();
  // (#4480 S1) …WIDENED to the §13.2-steps-16-18 population: every user
  // function owns a `.prototype` object, so a fnctor with NO `new F()` site
  // anywhere in the module also gets one. That third arm is safe for exactly
  // the reason the gate exists: the hazard the gate names is a SPLIT BRAIN
  // between the object `F.prototype` reads and the object `new F()` links its
  // instances to, and a constructor with no construction site has no instance
  // to disagree with. It is also the arm that pays: `S13.2_A1`/`S13.2_A4` and
  // the `.prototype`-only half of the isPrototypeOf family never construct.
  //
  // A fnctor that IS `new`'d but was NOT approved (`keep-typed` /
  // `keep-static`) keeps declining — that is precisely the population where
  // the instance link lives somewhere this global is not, and answering with
  // the auto-object would be a WRONG answer, not a missing one. `Test262Error`
  // is that case (`keep-typed`, `new Test262Error(...)` everywhere), so the
  // harness regression the gate comment records stays structurally excluded
  // rather than excluded by luck.
  //
  // The widened arm requires the gate to EXIST. A missing gate is "I don't
  // know whether this fnctor is constructed", not "it isn't" (#4235 records
  // that `generateMultiModule` shipped a null gate for a long time and that
  // the null was indistinguishable from "no fnctors"), so it keeps today's
  // decline.
  const gate = ctx.fnctorEscapeGate;
  const neverConstructed =
    gate !== undefined && !gate.ctorDeclByName.has(sym.name) && isOrdinaryFunctionSymbol(ctx, sym);
  if (!gate?.approvedNames.has(sym.name) && !hasRuntimeDescriptorInstall && !neverConstructed) {
    return undefined;
  }
  // Key by the stable symbol name so the WRITE site (`F.prototype = …`) and the
  // READ site (`Object.create(F.prototype)`) resolve to the SAME global.
  return sym.name;
}

/**
 * True when `target` is a `F.prototype = …` (whole reassign) or `F.prototype.p =
 * …` (per-prop) assignment LHS for a user function constructor `F`. Used by the
 * module-init collection (declarations.ts) to KEEP such a top-level statement in
 * `__module_init`: its root identifier `F` is a function (not a module global),
 * so the generic "assignment to a module global" check drops it, and the write
 * never reaches `compilePropertyAssignment`/the S2 interception. Mirrors the
 * `Array.prototype` CPR keep-in-init case. Element-access (`F.prototype[i]=v`) is
 * not matched (the S2 cluster uses whole-literal / named-prop writes).
 */
export function isFnctorPrototypeAssignTarget(ctx: CodegenContext, target: ts.Expression): boolean {
  if (!ts.isPropertyAccessExpression(target)) return false;
  // `F.prototype = …`
  if (
    ts.isIdentifier(target.name) &&
    target.name.text === "prototype" &&
    resolveUserFnctorName(ctx, target.expression) !== undefined
  ) {
    return true;
  }
  // `F.prototype.p = …`
  const recv = target.expression;
  if (
    ts.isPropertyAccessExpression(recv) &&
    ts.isIdentifier(recv.name) &&
    recv.name.text === "prototype" &&
    resolveUserFnctorName(ctx, recv.expression) !== undefined
  ) {
    return true;
  }
  return false;
}

/** Get-or-mint the `mut externref` module global holding F's prototype `$Object`. */
function getOrMintFnctorProtoGlobal(ctx: CodegenContext, fnctorName: string): number {
  const existing = ctx.fnctorPrototypeObject.get(fnctorName);
  if (existing !== undefined) return existing;
  const idx = nextModuleGlobalIdx(ctx);
  // Module globals are append-only and index-stable (separate index space from
  // the function table), so minting one mid-compile carries no late-import
  // funcidx-shift hazard (#2043) — unlike a `call` to a defined helper.
  ctx.mod.globals.push({
    name: `__fnctor_proto_${fnctorName}`,
    type: { kind: "externref" },
    mutable: true,
    init: [{ op: "ref.null.extern" }],
  });
  ctx.fnctorPrototypeObject.set(fnctorName, idx);
  return idx;
}

/**
 * (#4480 S1) §13.2 step 10 attributes for the `constructor` back-ref —
 * `{writable: true, enumerable: false, configurable: true}` in the HOST flag
 * encoding `__defineProperty_value` decodes (bits 0/1/2 are the
 * writable/enumerable/configurable VALUES; bit 1 left clear ⇒ non-enumerable).
 * The same constant `class-proto-object.ts` uses for §15.7.14, which the two
 * specs deliberately share — and the non-enumerability is directly asserted:
 * `S13.2_A4_T1` CHECK#3 `for (p in __func.prototype)` must not see it.
 */
const CONSTRUCTOR_FLAGS = 0x01 | 0x04;

/**
 * (#4491) The `var F = function(){}` half of the `constructor` back-ref.
 *
 * §13.2 step 10 does not care HOW the function object was produced, but this
 * compiler does: a top-level `function F(){}` is read through the
 * `__fn_closure_<F>` singleton, while `var F = function(){}` is read out of a
 * module global holding a separately-built closure. Installing the singleton for
 * the second shape would publish a DIFFERENT function object and make the
 * observable identity assertion false; installing the module global publishes
 * the very value the identifier read yields, so the identity holds by
 * construction.
 *
 * Measured before the change (`--target standalone`): `function __func(){}`
 * already satisfied `__func.prototype.constructor === __func`, while
 * `var __gunc = function(){}` answered `[object Object]` — the bare prototype
 * object, i.e. the property was simply absent and the read walked on.
 *
 * Declines (leaving the property absent, never wrong) unless:
 *  - the binding really is `var F = <function expression>` — a re-assignable
 *    name whose declaration is something else must not have its own initializer
 *    published as a constructor; and
 *  - a module global actually backs it, since a function-local `var F =
 *    function(){}` has no stable global to read and its prototype global is
 *    shared across activations.
 */
function moduleGlobalConstructorInstallInstrs(
  ctx: CodegenContext,
  fnctorName: string,
  ownerDecl: ts.Node | undefined,
  protoGlobalIdx: number,
): Instr[] | undefined {
  // A name this compiler DID resolve to a declaration is not this shape: the
  // caller's own arm owns the `function F(){}` case, and any other declaration
  // kind must not have its binding published as a constructor.
  if (ownerDecl !== undefined) return undefined;
  if (ctx.topLevelFunctionNames.has(fnctorName)) return undefined;
  const valueGlobalIdx = ctx.moduleGlobals.get(fnctorName);
  if (valueGlobalIdx === undefined) return undefined;
  if (ctx.mod.globals[localGlobalIdx(ctx, valueGlobalIdx)]?.type.kind !== "externref") return undefined;
  ensureObjectRuntime(ctx);
  const defineIdx = ctx.funcMap.get("__defineProperty_value");
  if (defineIdx === undefined) return undefined;
  addStringConstantGlobal(ctx, "constructor");
  return [
    { op: "global.get", index: protoGlobalIdx },
    ...stringConstantExternrefInstrs(ctx, "constructor"),
    { op: "global.get", index: valueGlobalIdx },
    { op: "f64.const", value: CONSTRUCTOR_FLAGS },
    { op: "call", funcIdx: defineIdx },
    { op: "drop" }, // the helper returns its target
  ];
}

/**
 * (#4480 S1) The instructions that install `F.prototype.constructor = F` onto
 * the just-minted prototype `$Object` held in the prototype global `g`, or
 * `undefined` when this module cannot resolve a STABLE function value for `F`.
 *
 * ## Why the value must be the cached singleton, and why we decline otherwise
 * The observable §13.2_A4 assertion is an IDENTITY one
 * (`__func.prototype.constructor === __func`), so the value installed here has
 * to be the very object an ordinary `F` identifier read yields. That is
 * `emitCachedFuncClosureExternref`'s `__fn_closure_<name>` singleton — the same
 * global `expressions/identifiers.ts` reads and the same one
 * `closure-prototype-edge.ts` keys its identity match on. A per-site
 * `emitFuncRefAsClosure` closure would make the identity FALSE, i.e. a wrong
 * answer where today there is merely a missing property, so every shape whose
 * identifier read does NOT go through the singleton declines instead:
 *
 *  - a CAPTURING function (`ctx.nestedFuncCaptures`) — the module-init-time
 *    singleton cannot carry per-activation captures, so the identifier read
 *    takes the per-site path (the guard `arguments-callee.ts` documents);
 *  - a class name (`ctx.classSet`) — class objects have their own carrier and
 *    `class-proto-object.ts` already installs their `constructor`;
 *  - an IMPORT (`funcIdx < numImportFuncs`) — no body to wrap.
 *
 * ## `externref`, not the struct view
 * `emitCachedFuncClosureExternref` skips the `ref.cast` back to the closure
 * struct. That is load-bearing, not an optimization: `ensureFuncClosureSingleton`
 * memoizes the cache global by NAME but recomputes the struct type from the
 * `constructible` flag, and casting a stored BASE wrapper to the CONSTRUCTIBLE
 * type traps at runtime. The descriptor only ever needs the value.
 */
function fnctorConstructorInstallInstrs(
  ctx: CodegenContext,
  fctx: FunctionContext,
  fnctorName: string,
  protoGlobalIdx: number,
): Instr[] | undefined {
  if (ctx.classSet.has(fnctorName)) return undefined;
  const captures = ctx.nestedFuncCaptures.get(fnctorName);
  if (captures && captures.length > 0) return undefined;
  // A top-level function DECLARATION is the one shape whose ordinary identifier
  // read is PROVABLY the `__fn_closure_<name>` singleton this helper installs;
  // `var F = function(){}` reads a module global holding a separately-built
  // closure. The whole value of the back-ref is an IDENTITY
  // (`F.prototype.constructor === F`), so publishing a different-but-plausible
  // function object would be a wrong answer where today there is a missing
  // property — the one trade this campaign's methodology forbids.
  //
  // Honest scope note: on this branch the `var F = function(){}` shape declines
  // one step EARLIER anyway (`emitCachedFuncClosureExternref` finds no
  // singleton for it — measured: probe `d3` reports `hasOwn("constructor") ===
  // false` with this check both enabled and disabled). So this check is a belt,
  // not the brace; it is kept because the invariant it states is the one a
  // future widening of the singleton path would silently break.
  const ownerDecl: ts.Node | undefined =
    ctx.funcMapOwnerDecl.get(fnctorName) ?? ctx.topLevelFunctionDeclarations.get(fnctorName);
  if (ownerDecl === undefined || !ts.isFunctionDeclaration(ownerDecl)) {
    // (#4491) `var F = function(){}` — the shape the note above scopes out. It
    // has no `__fn_closure_<F>` singleton, but it does have something just as
    // identity-stable and strictly CLOSER to the observable: the module global
    // the ordinary `F` identifier read itself returns. Installing that value
    // makes `F.prototype.constructor === F` true BY CONSTRUCTION — the two
    // sides are the same `global.get` — rather than plausible-but-different,
    // which is the trade this helper refuses.
    return moduleGlobalConstructorInstallInstrs(ctx, fnctorName, ownerDecl, protoGlobalIdx);
  }
  const funcIdx = ctx.funcMap.get(fnctorName);
  if (funcIdx === undefined || funcIdx < ctx.numImportFuncs) return undefined;
  ensureObjectRuntime(ctx);
  const defineIdx = ctx.funcMap.get("__defineProperty_value");
  if (defineIdx === undefined) return undefined;

  // Build into a DETACHED body: `emitCachedFuncClosureExternref` mints a
  // trampoline and can add late imports, whose funcidx shift must reach this
  // sequence. `liveBodies` is what makes the shifters walk a detached array
  // (the `class-proto-object.ts` / `arguments-callee.ts` pattern).
  const savedBody = fctx.body;
  const scratch: Instr[] = [];
  fctx.body = scratch;
  ctx.liveBodies.add(savedBody);
  let ok: boolean;
  try {
    fctx.body.push({ op: "global.get", index: protoGlobalIdx });
    addStringConstantGlobal(ctx, "constructor");
    for (const instr of stringConstantExternrefInstrs(ctx, "constructor")) fctx.body.push(instr);
    ok = emitCachedFuncClosureExternref(ctx, fctx, fnctorName, funcIdx, /* constructible */ true);
    if (ok) {
      fctx.body.push({ op: "f64.const", value: CONSTRUCTOR_FLAGS });
      fctx.body.push({ op: "call", funcIdx: defineIdx });
      fctx.body.push({ op: "drop" }); // the helper returns its target
    }
  } finally {
    fctx.body = savedBody;
    ctx.liveBodies.delete(savedBody);
  }
  return ok ? scratch : undefined;
}

/**
 * Emit the lazy-initialized prototype `$Object` get: `if (g == null) g =
 * __new_plain_object(); return g`. Leaves an externref (`$Object`) on the stack.
 * Returns false (emitting nothing) when `__new_plain_object` is unavailable, so
 * the caller declines and falls through to the legacy path.
 *
 * Exported for #2660 S3: the `new F()` reconstruct lowering (new-super.ts) seeds
 * the instance's `$proto` from this SAME per-fnctor prototype `$Object`, so the
 * inherited-read walk and the `F.prototype` read/write share ONE link location
 * (`$Object.$proto`) and ONE object identity (`Object.getPrototypeOf(new F()) ===
 * F.prototype`). The lazy-init guarantees the proto is always a real `$Object`
 * even when `F.prototype` was never explicitly assigned.
 *
 * (#4480 S1) The vivify also installs the §13.2 step 10 `constructor` back-ref.
 * It is done HERE — inside the one shared lazy-init — rather than at the
 * `F.prototype` read site, because this function is the SINGLE mint point every
 * consumer funnels through (`new F()` receiver seeding in `new-super.ts`, the
 * `instanceof` chain walk in `native-user-instanceof.ts`, the static read
 * below). Installing at any one call site would leave the object without a
 * `constructor` whenever a different site happened to run first.
 *
 * The `global.set` happens BEFORE the install, so the guard is already closed
 * while the install runs — a re-entrant read of `F.prototype` from anything the
 * install touches sees the object, not a second mint.
 */
export function emitFnctorProtoGet(ctx: CodegenContext, fctx: FunctionContext, fnctorName: string): boolean {
  const newObjIdx = ensureLateImport(ctx, "__new_plain_object", [], [{ kind: "externref" }]);
  flushLateImportShifts(ctx, fctx);
  if (newObjIdx === undefined) return false;
  const g = getOrMintFnctorProtoGlobal(ctx, fnctorName);
  const ctorInstall = fnctorConstructorInstallInstrs(ctx, fctx, fnctorName, g) ?? [];
  fctx.body.push({ op: "global.get", index: g });
  fctx.body.push({ op: "ref.is_null" });
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: [{ op: "call", funcIdx: newObjIdx }, { op: "global.set", index: g }, ...ctorInstall],
    else: [],
  });
  fctx.body.push({ op: "global.get", index: g });
  return true;
}

/**
 * READ interception for `F.prototype` (F a user fnctor, standalone). Returns the
 * per-fnctor prototype `$Object` as an externref, or `undefined` to decline (the
 * caller continues its normal dispatch).
 */
export function tryEmitFnctorPrototypeRead(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.PropertyAccessExpression,
  propName: string,
): ValType | undefined {
  if (!ctx.standalone || propName !== "prototype") return undefined;
  const fnctorName = resolveUserFnctorName(ctx, expr.expression);
  if (fnctorName === undefined) return undefined;
  if (!emitFnctorProtoGet(ctx, fctx, fnctorName)) return undefined;
  return { kind: "externref" };
}

/**
 * WHOLE-REASSIGN interception for `F.prototype = rhs` (F a user fnctor,
 * standalone). Builds `rhs` as a native `$Object` (plain object literal) or an
 * externref, stores it into the per-fnctor prototype global, and leaves the
 * assigned value on the stack (assignment-expression semantics). Returns
 * `undefined` to decline. Per-prop writes (`F.prototype.p = v`) are NOT handled
 * here — they ride the READ interception above.
 */
export function tryCompileFnctorPrototypeAssign(
  ctx: CodegenContext,
  fctx: FunctionContext,
  target: ts.PropertyAccessExpression,
  value: ts.Expression,
): ValType | undefined {
  if (!ctx.standalone) return undefined;
  if (!ts.isIdentifier(target.name) || target.name.text !== "prototype") return undefined;
  const fnctorName = resolveUserFnctorName(ctx, target.expression);
  if (fnctorName === undefined) return undefined;

  // Reserve the late import + global BEFORE building the RHS so any index shift
  // the RHS compile triggers reaches the already-emitted instrs via currentFunc.
  const g = getOrMintFnctorProtoGlobal(ctx, fnctorName);

  // Build the RHS as an externref (a native `$Object` when it is a plain object
  // literal — the #2580 Stage-A `compileProtoArg` precedent, replicated here to
  // avoid a calls.ts import cycle).
  if (ts.isObjectLiteralExpression(value)) {
    const lit = compileObjectLiteralAsExternref(ctx, fctx, value);
    if (lit) {
      if (lit.kind !== "externref") coerceType(ctx, fctx, lit, { kind: "externref" });
    } else {
      // `$Object` builder declined — fall back to the ordinary expression path.
      const t = compileExpression(ctx, fctx, value, { kind: "externref" });
      if (!t) fctx.body.push({ op: "ref.null.extern" });
      else if (t.kind !== "externref") coerceType(ctx, fctx, t, { kind: "externref" });
    }
  } else {
    const t = compileExpression(ctx, fctx, value, { kind: "externref" });
    if (!t) fctx.body.push({ op: "ref.null.extern" });
    else if (t.kind !== "externref") coerceType(ctx, fctx, t, { kind: "externref" });
  }

  // Stack: [rhs externref]. Store into the prototype global, leaving the value.
  fctx.body.push({ op: "global.set", index: g });
  fctx.body.push({ op: "global.get", index: g });
  return { kind: "externref" };
}
