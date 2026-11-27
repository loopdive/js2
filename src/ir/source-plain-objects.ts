// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7354 O2, O2b) What a Prepared program's source allows its ordinary objects (`ProgramObjects`), in one walk. On
 * this path an object literal, (F1b) a constructor's `prototype` and (O1) a native `Object` static (`Object.create`'s
 * object, `Object.getOwnPropertyDescriptor`'s record) are the only producers of an ordinary object, so
 * the source decides whether the object kind is admitted. OrdinaryToPrimitive is decided at run time (`ordinary-to-primitive.ts`) and needs to know only
 * whether `@@toPrimitive` is reachable, i.e. whether the program names `Symbol`.
 *
 * (#7354 M1, C1) A built-in prototype is one a program can change only where it can obtain it: (#7561) a wrapper's
 * (`wrappers`), (#7352, #7574) Array's or the root through its family (`realmFamilies`). A receiver the front end
 * folds (a native `Object` static's call, the intercepted `Object.prototype.toString.call(v)`) reaches none.
 */
import { ts } from "../ts-api.js";
import type { ProgramObjects } from "./program/dynamic-value-kinds.js";
import { nativeObjectStaticCall, objectTagCallReceiver, realmConstantRead } from "./realm-static-call.js";
import {
  WRAPPER_OF_PRIMITIVE,
  realmConstructorId,
  type RealmConstructor,
  type RealmFamily,
} from "./program/builtin-prototype-keys.js";
import type { NativeWrapperConstructor } from "../runtime/contracts/native-realm-catalog.js";

/** `node` names a member (`x.Symbol`, `{ Symbol: 1 }`), not a binding. */
const isMemberName = (node: ts.Identifier): boolean =>
  (ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) ||
  ((ts.isPropertyAssignment(node.parent) || ts.isMethodDeclaration(node.parent)) && node.parent.name === node);

/**
 * `readsDeclarationValue`: (#7354 F1b) a function declaration is read as a value (`function-declaration-values.ts`),
 * or (#7372 2a) an Annex B block function is made as one (`annexb-block-function-values.ts`).
 * Such a function, like a function expression, is a constructor whose `prototype` is an ordinary object the source
 * spells nowhere, so either one admits the object kind too.
 */
export function programObjects(
  sourceFiles: readonly ts.SourceFile[],
  readsDeclarationValue: boolean,
  isPristineGlobal: (identifier: ts.Identifier) => boolean,
): ProgramObjects {
  let present = readsDeclarationValue;
  let functions = readsDeclarationValue;
  let namesSymbol = false;
  const realmFamilies = new Set<RealmFamily>();
  const wrappers = new Set<NativeWrapperConstructor>();
  // (#7354 G1) The family of the realm constructor `node` reads as the unchanged global (`identifier-read.ts` reads it
  // the same way, through `realmIntrinsicRead`): a member name, a label or a binding of the same spelling is no such
  // read, nor a receiver the front end folds, which reaches no object: (#7350 B3a) of a constant
  // (`realmConstantRead`), (#7574) of a native `Object` static's call (`nativeObjectStaticCall`) or of the object tag
  // (`objectTagCallReceiver`).
  const constructorRead = (node: ts.Identifier): RealmConstructor | undefined => {
    const ctor = realmConstructorId(node.text);
    if (ctor === undefined || isMemberName(node) || !isPristineGlobal(node)) return undefined;
    const access = node.parent;
    if (!ts.isPropertyAccessExpression(access)) return ctor;
    const call = access.parent;
    const tag = access.parent.parent?.parent;
    const folded =
      realmConstantRead(access, isPristineGlobal) !== undefined ||
      (ts.isCallExpression(call) && nativeObjectStaticCall(call, isPristineGlobal) !== undefined) ||
      (tag !== undefined && ts.isCallExpression(tag) && objectTagCallReceiver(tag) === node);
    return folded ? undefined : ctor;
  };
  // (#7574) The wrapper kinds `Object(v)` / `new Object(v)` may make of its first argument: a literal's, else all.
  const objectWraps = (node: ts.Identifier): readonly NativeWrapperConstructor[] => {
    const site = node.parent;
    if (!(ts.isCallExpression(site) || ts.isNewExpression(site)) || site.expression !== node) return [];
    const [argument] = site.arguments ?? [];
    if (argument === undefined) return [];
    if (ts.isStringLiteralLike(argument)) return [WRAPPER_OF_PRIMITIVE.string];
    if (ts.isNumericLiteral(argument)) return [WRAPPER_OF_PRIMITIVE.number];
    if (argument.kind === ts.SyntaxKind.TrueKeyword || argument.kind === ts.SyntaxKind.FalseKeyword)
      return [WRAPPER_OF_PRIMITIVE.boolean];
    return Object.values(WRAPPER_OF_PRIMITIVE);
  };
  const visit = (node: ts.Node): void => {
    const ctor = ts.isIdentifier(node) ? constructorRead(node) : undefined;
    if (ctor !== undefined) realmFamilies.add(ctor.family);
    // (#7561) `new X(…)` and `X.prototype` are how a program obtains a wrapper of X or its prototype.
    const access = node.parent;
    if (
      ctor?.family === "wrapper" &&
      ((ts.isNewExpression(access) && access.expression === node) ||
        (ts.isPropertyAccessExpression(access) && access.name.text === "prototype"))
    )
      wrappers.add(ctor.name);
    if (ctor?.family === "object") objectWraps(node as ts.Identifier).forEach((kind) => wrappers.add(kind));
    present ||=
      ts.isObjectLiteralExpression(node) ||
      ts.isFunctionExpression(node) ||
      (ts.isCallExpression(node) && nativeObjectStaticCall(node, () => true) !== undefined);
    functions ||= ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isAccessor(node);
    namesSymbol ||= ts.isIdentifier(node) && node.text === "Symbol" && !isMemberName(node);
    ts.forEachChild(node, visit);
  };
  sourceFiles.forEach(visit);
  return { present: present || realmFamilies.has("error"), functions, namesSymbol, realmFamilies, wrappers };
}
