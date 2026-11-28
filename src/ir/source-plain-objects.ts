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
 *
 * (#7580) A call `Object.m(…)` is answered by the folded built-in without reading `Object.m`. The invariant that
 * makes this right is the kernel's, not this walk's: no run-time write reaches a static of `Object`, because the
 * kernel aborts every define, and every [[Set]] or delete that would take effect, on `%Object%`
 * (`NativeRealmIntrinsic.fixed`), whatever route obtained the object (an alias, the root's `constructor` under any
 * key, a descriptor's `value`). The walk decides only precision: which statics a call through a value may be
 * (`staticValues`), every held one where `Object` is handed on (`var O = Object`, `f(Object)`), else those a read
 * names.
 */
import { ts } from "../ts-api.js";
import type { ProgramObjects } from "./program/dynamic-value-kinds.js";
import { nativeObjectStaticCall, realmReceiverRead } from "./realm-static-call.js";
import {
  HELD_OBJECT_STATICS,
  PROTOTYPE_METHOD_NAMES,
  WRAPPER_OF_PRIMITIVE,
  realmConstructorId,
  type RealmFamily,
} from "./program/builtin-prototype-keys.js";
import type { NativeWrapperConstructor } from "../runtime/contracts/native-realm-catalog.js";
import {
  sourceLetsIntrinsicEscape,
  sourceMayWriteUnspelledMember,
  sourceNamesReflectiveRoute,
  sourceRunsDynamicCode,
  sourceWritesMemberNamed,
} from "../shared/intrinsic-prototype-writes.js";

/** `node` names a member (`x.Symbol`, `{ Symbol: 1 }`), not a binding. */
const isMemberName = (node: ts.Identifier): boolean =>
  (ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) ||
  ((ts.isPropertyAssignment(node.parent) || ts.isMethodDeclaration(node.parent)) && node.parent.name === node);

/** `node` is the `m` of a call `x.m(…)`, which reads the member only to call it at that site. */
const isCalledMemberName = (node: ts.Node): boolean => {
  const access = node.parent;
  return (
    ts.isPropertyAccessExpression(access) &&
    access.name === node &&
    ts.isCallExpression(access.parent) &&
    access.parent.expression === access
  );
};

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
  const prototypeMethodNames = new Set<string>();
  let methodValues = false;
  const realmFamilies = new Set<RealmFamily>();
  const wrappers = new Set<NativeWrapperConstructor>();
  // (#7354 G1) The realm constructor `node` reads as the unchanged global (`identifier-read.ts` reads it the same way,
  // through `realmIntrinsicRead`), and (#7580) the member it reads off it: a member name, a label or a binding of the
  // same spelling is no such read, nor a receiver the front end folds (`realmReceiverRead`), which reaches no object.
  const constructorRead = (node: ts.Identifier) => {
    const ctor = realmConstructorId(node.text);
    if (ctor === undefined || isMemberName(node) || !isPristineGlobal(node)) return undefined;
    const { folded, member } = realmReceiverRead(node, isPristineGlobal);
    return folded ? undefined : { ctor, member };
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
  // (#7580) The statics a value read reaches by name (`Object.defineProperty` that is no folded call).
  const staticValues = new Set<string>();
  const visit = (node: ts.Node): void => {
    const read = ts.isIdentifier(node) ? constructorRead(node) : undefined;
    const ctor = read?.ctor;
    if (ctor !== undefined) realmFamilies.add(ctor.family);
    // (#7561) `new X(…)` and `X.prototype` are how a program obtains a wrapper of X or its prototype.
    const access = node.parent;
    if (
      ctor?.family === "wrapper" &&
      ((ts.isNewExpression(access) && access.expression === node) || read?.member === "prototype")
    )
      wrappers.add(ctor.name);
    if (ctor?.family === "object") {
      objectWraps(node as ts.Identifier).forEach((kind) => wrappers.add(kind));
      if (read?.member !== undefined && HELD_OBJECT_STATICS.includes(read.member)) staticValues.add(read.member);
    }
    present ||=
      ts.isObjectLiteralExpression(node) ||
      ts.isFunctionExpression(node) ||
      (ts.isCallExpression(node) && nativeObjectStaticCall(node, () => true) !== undefined);
    functions ||= ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isAccessor(node);
    namesSymbol ||= ts.isIdentifier(node) && node.text === "Symbol" && !isMemberName(node);
    if ((ts.isIdentifier(node) || ts.isStringLiteralLike(node)) && PROTOTYPE_METHOD_NAMES.has(node.text)) {
      prototypeMethodNames.add(node.text);
      methodValues ||= node.text === "call" || !isCalledMemberName(node);
    }
    ts.forEachChild(node, visit);
  };
  sourceFiles.forEach(visit);
  const escapes = sourceFiles.some((file) => sourceLetsIntrinsicEscape(file, "Object"));
  return {
    present: present || realmFamilies.has("error"),
    functions,
    namesSymbol,
    prototypeMethodNames,
    methodValues,
    realmFamilies,
    wrappers,
    staticValues: escapes ? new Set(HELD_OBJECT_STATICS) : staticValues,
    // (#7557) A `call` member written anywhere, dynamic code, or, where the program can obtain Function.prototype, a
    // reflective route or a write under an unspelled name.
    replacesCall: sourceFiles.some(
      (file) =>
        sourceWritesMemberNamed(file, "call") ||
        sourceRunsDynamicCode(file) ||
        (realmFamilies.has("function") && (sourceNamesReflectiveRoute(file) || sourceMayWriteUnspelledMember(file))),
    ),
  };
}
