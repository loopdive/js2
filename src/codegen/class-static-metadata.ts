// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Static metadata for class objects.
 *
 * A compiled class object is a closed WasmGC carrier rather than an ordinary
 * `$Object`.  Keep the constructor's standard own keys and its declared own
 * static method keys in one small codegen helper so class-specific lowering
 * does not have to infer them from the carrier's instance shape.
 */
import { ts } from "../ts-api.js";
import type { CodegenContext } from "./context/types.js";
import { fnInstanceNameOf } from "./function-instance-meta.js";
import { isHostConstructibleBuiltin } from "./builtin-tags.js";
import { BUILTIN_CONSTRUCTOR_IDENTITY_NAMES } from "./builtin-static-globals.js";
import { bindingIsUniqueAndNeverWritten } from "./class-heritage-check.js";

/** The own keys created by a class constructor before static declarations. */
export const CLASS_CONSTRUCTOR_OWN_KEYS = ["length", "name", "prototype"] as const;

/**
 * Resolve a direct class identifier to the canonical class identity used by
 * `classSet` and the class metadata maps.  Transparent wrappers are accepted
 * because TypeScript commonly inserts them around an expression used at an
 * externref boundary.
 */
export function classIdentityFromExpression(ctx: CodegenContext, expression: ts.Expression): string | undefined {
  let bare = expression;
  while (
    ts.isParenthesizedExpression(bare) ||
    ts.isAsExpression(bare) ||
    ts.isTypeAssertionExpression(bare) ||
    ts.isNonNullExpression(bare)
  ) {
    bare = bare.expression;
  }
  if (!ts.isIdentifier(bare)) return undefined;
  const className = ctx.classExprNameMap.get(bare.text) ?? bare.text;
  return ctx.classSet.has(className) ? className : undefined;
}

/**
 * Return the own string keys of a class constructor in ECMAScript order for
 * the metadata currently collected by class-bodies.ts. Static accessors named
 * `name`/`length` are already represented by the standard constructor keys;
 * static methods with those names replace their value without adding another
 * key, so only non-standard static method names are appended.
 */
export function classStaticOwnPropertyNames(ctx: CodegenContext, className: string): string[] {
  const names: string[] = [...CLASS_CONSTRUCTOR_OWN_KEYS];
  for (const methodName of ctx.classStaticMethodNames.get(className) ?? []) {
    if (!names.includes(methodName)) names.push(methodName);
  }
  return names;
}

/**
 * True when `className.propertyName` is a declared static method. This is used
 * only for the two constructor metadata keys whose intrinsic TypeScript types
 * (`string`/`number`) are replaced by a static method at class evaluation.
 */
export function hasClassStaticMethod(ctx: CodegenContext, className: string, propertyName: string): boolean {
  return ctx.staticMethodSet.has(`${className}_${propertyName}`);
}

/**
 * (#5271 step 7, G2) The OBSERVABLE `name` of a class object.
 *
 * `classIdentity` is the compiler's registry key. For an anonymous class
 * EXPRESSION that key is the synthetic `__anonClass_<n>` id assigned during
 * collection — a compiler-internal identifier that must never surface as a
 * property value. `Object.getOwnPropertyDescriptor(class {}, 'name').value`
 * reported exactly that (`"__anonClass_0"` where §10.2.9 NamedEvaluation says
 * the binding's name, `"cls"`).
 *
 * `fnInstanceNameOf` is the shared §10.2.9 answer: a named class expression
 * keeps its own name, an anonymous one takes the binding it is defined into,
 * and anything unresolvable answers `""` — which is also the spec answer for a
 * genuinely anonymous class value.
 */
export function classObjectDisplayName(ctx: CodegenContext, classIdentity: string): string {
  if (!classIdentity.startsWith("__anonClass_")) return classIdentity;
  for (const [declaration, synthetic] of ctx.anonClassExprNames) {
    if (synthetic === classIdentity) return fnInstanceNameOf(declaration);
  }
  return "";
}

/** The `extends` expression of a class declaration, if it has one. */
function classHeritageExpression(decl: ts.ClassDeclaration | ts.ClassExpression): ts.Expression | undefined {
  for (const clause of decl.heritageClauses ?? []) {
    if (clause.token === ts.SyntaxKind.ExtendsKeyword && clause.types.length > 0) {
      let bare: ts.Expression = clause.types[0]!.expression;
      while (
        ts.isParenthesizedExpression(bare) ||
        ts.isAsExpression(bare) ||
        ts.isTypeAssertionExpression(bare) ||
        ts.isNonNullExpression(bare)
      ) {
        bare = bare.expression;
      }
      return bare;
    }
  }
  return undefined;
}

/**
 * The class declaration a resolved binding stands for, or `undefined` when the
 * binding is not a class at all. A `var`-bound class EXPRESSION counts; a
 * `var`-bound function expression, a parameter, an import, a call result do
 * not.
 */
function classDeclarationBehindBinding(
  declaration: ts.Declaration,
): ts.ClassDeclaration | ts.ClassExpression | undefined {
  if (ts.isClassDeclaration(declaration)) return declaration;
  if (ts.isVariableDeclaration(declaration) && declaration.initializer !== undefined) {
    let bare: ts.Expression = declaration.initializer;
    while (
      ts.isParenthesizedExpression(bare) ||
      ts.isAsExpression(bare) ||
      ts.isTypeAssertionExpression(bare) ||
      ts.isNonNullExpression(bare)
    ) {
      bare = bare.expression;
    }
    if (ts.isClassExpression(bare)) return bare;
  }
  return undefined;
}

/**
 * (#5195 r3 review round 2, F2/F3) The chain walk, on DECLARATIONS.
 *
 * The first cut resolved each heritage identifier by NAME
 * (`classExprNameMap.get(text) ?? text`, then `classSet.has`), which is both
 * scope-blind and reassignment-blind: `class A {}; function f(){ var A =
 * function(){}; class K extends A {} }` read as a class chain, as did
 * `class A {} A = function(){}; class K extends A {}`. Both throw on
 * `K.caller` where node answers `null` and the base tree answered `undefined`.
 * It also ended the walk at an inline class expression without inspecting that
 * class's OWN heritage (`class K extends (class extends F {}) {}`).
 *
 * So every link now resolves through `ctx.oracle.valueDeclarationOf`, must land
 * on a class declaration, and must carry the never-written proof before the
 * walk continues; an inline class expression is recursed into.
 */
function classDeclChainIsProvablyAllClasses(
  ctx: CodegenContext,
  decl: ts.ClassDeclaration | ts.ClassExpression,
  seen: Set<ts.Node>,
): boolean {
  if (seen.has(decl) || seen.size > 16) return false;
  seen.add(decl);
  const heritage = classHeritageExpression(decl);
  // No heritage, or `extends null`: the chain ends at %Function.prototype%,
  // and a class object is a strict function there.
  if (heritage === undefined || heritage.kind === ts.SyntaxKind.NullKeyword) return true;
  if (ts.isClassExpression(heritage)) return classDeclChainIsProvablyAllClasses(ctx, heritage, seen);
  if (!ts.isIdentifier(heritage)) return false;
  const declaration = ctx.oracle.valueDeclarationOf(heritage);
  // A BUILTIN constructor ancestor (`extends Error`/`Array`) does throw in
  // node, so it keeps the poison; everything else is unproven.
  if (declaration === undefined || declaration.getSourceFile().isDeclarationFile) {
    return isHostConstructibleBuiltin(heritage.text) || BUILTIN_CONSTRUCTOR_IDENTITY_NAMES.has(heritage.text);
  }
  const parentDecl = classDeclarationBehindBinding(declaration);
  if (parentDecl === undefined) return false;
  if (!bindingIsUniqueAndNeverWritten(heritage, declaration)) return false;
  return classDeclChainIsProvablyAllClasses(ctx, parentDecl, seen);
}

/**
 * (#5195 r3-7, r3 review F5) True when EVERY link of `className`'s heritage
 * chain is provably a class (or a builtin constructor, or `extends null`, or
 * no heritage at all) — the only case in which the §10.2.4 `caller`/
 * `arguments` poison is justified. Anything the compiler cannot prove to be a
 * class (a parameter, an alias it did not resolve, a conditional, a call
 * result, a property access, a function expression, a rebound name) declines.
 */
function classChainIsProvablyAllClasses(ctx: CodegenContext, className: string): boolean {
  const decl = ctx.classDeclarationMap.get(className);
  if (decl === undefined) return false;
  return classDeclChainIsProvablyAllClasses(ctx, decl, new Set<ts.Node>());
}

/**
 * (#5195 r3-7) True when `<Class>.<propName>` names one of the §10.2.4
 * restricted function properties AND the class declares nothing under that
 * name.
 *
 * A class object is a strict function, so `C.caller` / `C.arguments` resolve to
 * the %ThrowTypeError% accessor inherited from %Function.prototype%: both
 * reading and writing throw. A DECLARED `static caller` shadows the inherited
 * accessor and keeps its value, which is why every declaration surface is
 * consulted here.
 *
 * Standalone only — the host lane's class objects reach the real
 * %Function.prototype% accessors and must stay byte-identical.
 *
 * DECLINED for a class with a plain-FUNCTION ancestor: `function F(){}` is
 * sloppy, so V8 gives it OWN `caller`/`arguments` data properties valued
 * `null`, and `class G extends F {}` inherits them — node answers `null`, not
 * a throw (measured 2026-09-03). Poisoning that chain would turn a stable
 * value into an exception. A BUILTIN ancestor (`extends Error`/`Array`) does
 * throw in node, so it stays poisoned.
 *
 * Shared by the READ arm (`property-access-dispatch.ts::emitClassStaticMemberRead`)
 * and the WRITE arm (`expressions/assignment.ts::compilePropertyAssignment`) so
 * the two cannot disagree about which names are poisoned — the failure mode a
 * per-site copy invites.
 */
export function classObjectRestrictedProperty(ctx: CodegenContext, className: string, propName: string): boolean {
  if (ctx.standalone !== true) return false;
  if (propName !== "caller" && propName !== "arguments") return false;
  if (!classChainIsProvablyAllClasses(ctx, className)) return false;
  // Statics are INHERITED along the class chain, so a `static caller` declared
  // on an ancestor shadows the accessor for every descendant too. Walk the
  // chain over all four declaration surfaces rather than testing the own class
  // and then only the FIELD half of the ancestors.
  const seen = new Set<string>();
  let cls: string | undefined = className;
  while (cls !== undefined && !seen.has(cls)) {
    seen.add(cls);
    if (
      ctx.staticProps.has(`${cls}_${propName}`) ||
      ctx.staticMethodSet.has(`${cls}_${propName}`) ||
      // (r3 review F4) `staticAccessorSet` is keyed `<Class>_<prop>` at both
      // add sites (class-bodies.ts) — the `_get_`/`_set_` spelling this used to
      // test never matched, so a DECLARED `static get caller()` stayed poisoned.
      ctx.staticAccessorSet.has(`${cls}_${propName}`)
    ) {
      return false;
    }
    cls = ctx.classParentMap.get(cls);
  }
  return true;
}
