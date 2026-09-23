// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6651 A3, #3236 S1) The standalone `%GeneratorFunction%` intrinsic and its
 * prototype `%GeneratorFunction.prototype%` (= `%Generator%`, ECMA-262 §27.3).
 *
 * `Object.getPrototypeOf(genFn)` must answer `%GeneratorFunction.prototype%`, an
 * ordinary, non-callable, extensible object whose own properties are (§27.3.3):
 *
 * | key              | value                      | attributes      |
 * | ---------------- | -------------------------- | --------------- |
 * | `constructor`    | `%GeneratorFunction%`      | {w:F, e:F, c:T} |
 * | `prototype`      | `%GeneratorPrototype%`     | {w:F, e:F, c:T} |
 * | `@@toStringTag`  | `"GeneratorFunction"`      | {w:F, e:F, c:T} |
 *
 * and whose `[[Prototype]]` is `%Function.prototype%`. `%GeneratorFunction%`
 * itself (§27.3.1/§27.3.2) owns `length` 1 and `name` "GeneratorFunction"
 * ({w:F, e:F, c:T}) and `prototype` = `%GeneratorFunction.prototype%`
 * ({w:F, e:F, c:F}); it is extensible, callable and a constructor.
 * `%GeneratorPrototype%.constructor` points back at `%GeneratorFunction.prototype%`
 * ({w:F, e:F, c:T}, §27.5.1.1).
 *
 * The predecessor (in `array-object-proto.ts`) built only the `prototype` link,
 * through `__extern_set` — so it was writable AND enumerable — and nothing else:
 * `.constructor` read `undefined`, `@@toStringTag` was absent, and
 * `GeneratorPrototype.constructor` did not exist.
 *
 * ## What is NOT modelled
 *
 * Calling or constructing `%GeneratorFunction%` is `CreateDynamicFunction`
 * (§20.2.1.1.1): it parses source text at run time, which a compiled module can
 * only do through the runtime-eval provider. The carrier is branded
 * callable/constructible (so `typeof` and `IsConstructor` answer as the spec
 * says) but invoking it is out of scope here.
 *
 * `%GeneratorPrototype%.constructor` is wired when `%GeneratorFunction.prototype%`
 * is first reified, not when `%GeneratorPrototype%` is. Wiring it from the
 * `%GeneratorPrototype%` builder too would splice this whole init body into
 * every generator-instance prototype read in the corpus; every test262 row that
 * reads `GeneratorPrototype.constructor` reaches it through
 * `Object.getPrototypeOf(genFn).prototype`, i.e. through this builder first.
 *
 * Standalone/WASI only (the JS host answers through
 * `__get_generator_function_prototype`, see `src/runtime/iterator-polyfills.ts`).
 */
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { allocLocal } from "./context/locals.js";
import {
  emitFunctionPrototypeObjectSingleton,
  emitGeneratorPrototypeSingleton,
  ensureGeneratorPrototypeNativeProtoGlue,
} from "./array-object-proto.js";
import { pushMarkBuiltinCarrierCallable } from "./builtin-callable-brand.js";
import { ensureObjectRuntime } from "./object-runtime.js";
import { addStringConstantGlobal } from "./registry/imports.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";
import { ensureLateImport, flushLateImportShifts } from "./shared.js";
import { bindingIsSingleAssignment } from "./single-assignment-binding.js";
import { ts } from "../ts-api.js";

/** `__defineProperty_value` attribute words: bit0 writable, bit1 enumerable, bit2 configurable. */
const FLAGS_NONE = 0x00;
const FLAGS_CONFIGURABLE = 0x04;
/** Well-known symbol id of `Symbol.toStringTag` for `__box_symbol`. */
const SYMBOL_TO_STRING_TAG_ID = 4;

function lazyGlobal(ctx: CodegenContext, name: string): number {
  let idx = ctx.builtinObjectGlobals.get(name);
  if (idx === undefined) {
    idx = ctx.numImportGlobals + ctx.mod.globals.length;
    ctx.mod.globals.push({ name, type: { kind: "externref" }, mutable: true, init: [{ op: "ref.null.extern" }] });
    ctx.builtinObjectGlobals.set(name, idx);
  }
  return idx;
}

/**
 * Leave `%GeneratorFunction.prototype%` on the stack (lazily built, identity
 * stable). Returns its ValType, or `null` when the object runtime is not
 * available (the caller keeps its historical fallback).
 */
export function emitGeneratorFunctionPrototypeSingleton(ctx: CodegenContext, fctx: FunctionContext): ValType | null {
  const brand = ensureGeneratorPrototypeNativeProtoGlue(ctx);
  if (brand === undefined) return null;

  ensureObjectRuntime(ctx);
  const boxSymbolIdx = ensureLateImport(ctx, "__box_symbol", [{ kind: "i32" }], [{ kind: "externref" }]);
  const boxNumberIdx = ensureLateImport(ctx, "__box_number", [{ kind: "f64" }], [{ kind: "externref" }]);
  flushLateImportShifts(ctx, fctx);
  const createIdx = ctx.funcMap.get("__object_create");
  const defineIdx = ctx.funcMap.get("__defineProperty_value");
  if (createIdx === undefined || defineIdx === undefined || boxSymbolIdx === undefined || boxNumberIdx === undefined) {
    return null;
  }

  const protoGlobal = lazyGlobal(ctx, "__native_generator_function_prototype");

  const fpLocal = allocLocal(fctx, `__genfn_fp_${fctx.locals.length}`, { kind: "externref" });
  const protoLocal = allocLocal(fctx, `__genfn_proto_obj_${fctx.locals.length}`, { kind: "externref" });
  const ctorLocal = allocLocal(fctx, `__genfn_ctor_obj_${fctx.locals.length}`, { kind: "externref" });
  const gpLocal = allocLocal(fctx, `__genfn_gp_obj_${fctx.locals.length}`, { kind: "externref" });
  const initBody: Instr[] = [];

  // (#2182 pattern) `savedBody` is detached during the swap; register it in
  // `liveBodies` so any late-import funcidx shift still walks it.
  const savedBody = fctx.body;
  fctx.body = initBody;
  ctx.liveBodies.add(savedBody);
  const define = (target: number, pushKey: () => void, pushValue: () => void, flags: number): void => {
    fctx.body.push({ op: "local.get", index: target });
    pushKey();
    pushValue();
    fctx.body.push({ op: "f64.const", value: flags }, { op: "call", funcIdx: defineIdx }, { op: "drop" });
  };
  const strKey = (key: string) => (): void => {
    addStringConstantGlobal(ctx, key);
    for (const instr of stringConstantExternrefInstrs(ctx, key)) fctx.body.push(instr);
  };
  const local = (idx: number) => (): void => {
    fctx.body.push({ op: "local.get", index: idx });
  };
  let ok = true;
  try {
    // FP = %Function.prototype% — the [[Prototype]] of BOTH objects built here
    // (§27.3.3: %GeneratorFunction.prototype%'s is %Function.prototype%; the
    // constructor's is %Function%, whose own [[Prototype]] is again FP — the
    // closest object the standalone runtime reifies).
    if (emitFunctionPrototypeObjectSingleton(ctx, fctx) === null) {
      ok = false;
    } else {
      fctx.body.push({ op: "local.set", index: fpLocal });
      // G = OrdinaryObjectCreate(FP), published BEFORE seeding so a re-entrant
      // read during the seed observes the one identity.
      fctx.body.push(
        { op: "local.get", index: fpLocal },
        { op: "call", funcIdx: createIdx },
        { op: "local.tee", index: protoLocal },
        { op: "global.set", index: protoGlobal },
      );
      // C = %GeneratorFunction%
      fctx.body.push(
        { op: "local.get", index: fpLocal },
        { op: "call", funcIdx: createIdx },
        { op: "local.set", index: ctorLocal },
      );
      pushMarkBuiltinCarrierCallable(ctx, fctx, ctorLocal);
      define(
        ctorLocal,
        strKey("length"),
        () => {
          fctx.body.push({ op: "f64.const", value: 1 }, { op: "call", funcIdx: boxNumberIdx });
        },
        FLAGS_CONFIGURABLE,
      );
      define(ctorLocal, strKey("name"), strKey("GeneratorFunction"), FLAGS_CONFIGURABLE);
      define(ctorLocal, strKey("prototype"), local(protoLocal), FLAGS_NONE);
      // G.constructor / G[@@toStringTag]
      define(protoLocal, strKey("constructor"), local(ctorLocal), FLAGS_CONFIGURABLE);
      define(
        protoLocal,
        () => {
          fctx.body.push({ op: "i32.const", value: SYMBOL_TO_STRING_TAG_ID }, { op: "call", funcIdx: boxSymbolIdx });
        },
        strKey("GeneratorFunction"),
        FLAGS_CONFIGURABLE,
      );
      // G.prototype = %GeneratorPrototype%; %GeneratorPrototype%.constructor = G
      if (emitGeneratorPrototypeSingleton(ctx, fctx) === null) {
        ok = false;
      } else {
        fctx.body.push({ op: "local.set", index: gpLocal });
        define(protoLocal, strKey("prototype"), local(gpLocal), FLAGS_CONFIGURABLE);
        define(gpLocal, strKey("constructor"), local(protoLocal), FLAGS_CONFIGURABLE);
      }
    }
  } finally {
    fctx.body = savedBody;
    ctx.liveBodies.delete(savedBody);
  }
  if (!ok) return null;

  fctx.body.push({ op: "global.get", index: protoGlobal });
  fctx.body.push({ op: "ref.is_null" });
  fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: initBody, else: [] });
  fctx.body.push({ op: "global.get", index: protoGlobal });
  return { kind: "externref" };
}

const isSyncGeneratorFunctionLike = (node: ts.Node): boolean =>
  (ts.isFunctionExpression(node) || ts.isMethodDeclaration(node)) &&
  node.asteriskToken !== undefined &&
  !node.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword);

/**
 * Does `expr` statically denote a SYNC generator function value whose
 * `[[Prototype]]` is `%GeneratorFunction.prototype%`?
 *
 *  - a generator function expression, `function* () {}` (parenthesised or not);
 *  - `o.m`, where `o` is a single-assignment binding initialised to an object
 *    literal whose ONLY `m` member is a `*m() {}` method, and no `o.m` is
 *    written or deleted anywhere in the file (§15.5.1 MethodDefinition
 *    evaluation gives such a method `%GeneratorFunction.prototype%` as its
 *    `[[Prototype]]`, exactly like a generator expression).
 *
 * The second arm exists because the first changes an answer an existing row
 * relied on: `language/expressions/object/method-definition/generator-prototype.js`
 * compares `getPrototypeOf(obj.method)` with `getPrototypeOf(function* () {})`,
 * and passed only because BOTH answered `%Function.prototype%`. A value that
 * reaches here through anything else (an escaped `o` whose method is replaced
 * by a callee, a parameter, a computed key) is not claimed — the caller keeps
 * its existing lowering.
 */
export function isStaticSyncGeneratorFunctionValue(ctx: CodegenContext, expr: ts.Expression): boolean {
  let e: ts.Expression = expr;
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  if (ts.isFunctionExpression(e)) return isSyncGeneratorFunctionLike(e);
  if (!ts.isPropertyAccessExpression(e) || !ts.isIdentifier(e.expression) || !ts.isIdentifier(e.name)) return false;
  const holder = e.expression;
  const name = e.name.text;
  if (!bindingIsSingleAssignment(ctx, holder)) return false;
  const init = ctx.oracle.variableInitializerOf(holder);
  if (init === undefined || !ts.isObjectLiteralExpression(init)) return false;
  let method: ts.Node | undefined;
  for (const prop of init.properties) {
    if (ts.isSpreadAssignment(prop)) return false; // could supply `name`
    const pn = prop.name;
    if (pn === undefined || ts.isComputedPropertyName(pn)) return false;
    if ((ts.isIdentifier(pn) || ts.isStringLiteral(pn)) && pn.text === name) {
      if (method !== undefined) return false;
      method = prop;
    }
  }
  if (method === undefined || !isSyncGeneratorFunctionLike(method)) return false;
  const holderDecl = ctx.oracle.valueDeclarationOf(holder);
  if (holderDecl === undefined) return false;
  let written = false;
  const visit = (node: ts.Node): void => {
    if (written) return;
    let target: ts.Expression | undefined;
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    ) {
      target = node.left;
    } else if (ts.isDeleteExpression(node)) {
      target = node.expression;
    }
    if (target !== undefined) {
      while (ts.isParenthesizedExpression(target)) target = target.expression;
      const receiver =
        ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target) ? target.expression : undefined;
      if (
        receiver !== undefined &&
        ts.isIdentifier(receiver) &&
        receiver.text === holder.text &&
        ctx.oracle.valueDeclarationOf(receiver) === holderDecl
      ) {
        written = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(expr.getSourceFile());
  return !written;
}
