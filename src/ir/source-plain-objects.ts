// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7354 O2, O2b) What a Prepared program's source allows its ordinary objects (`ProgramObjects`), in one walk. On
 * this path an object literal is the only producer of an ordinary object, so the source decides whether the object
 * kind is admitted. OrdinaryToPrimitive is decided at run time (`ordinary-to-primitive.ts`) and needs to know only
 * whether `@@toPrimitive` is reachable, i.e. whether the program names `Symbol`. A member read of a primitive meets
 * the built-in prototypes, so it asks whether any code can reach one to change it.
 */
import { ts } from "../ts-api.js";
import type { ProgramObjects } from "./program/dynamic-value-kinds.js";

/** Global names through which a program reaches a built-in prototype (or Symbol.toPrimitive). */
const PROTOTYPE_GLOBALS: ReadonlySet<string> = new Set([
  "Object",
  "Function",
  "Number",
  "Boolean",
  "String",
  "Symbol",
  "Reflect",
  "globalThis",
]);

/** `node` names a member (`x.Object`, `{ Object: 1 }`), not a binding. */
const isMemberName = (node: ts.Identifier): boolean =>
  (ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) ||
  ((ts.isPropertyAssignment(node.parent) || ts.isMethodDeclaration(node.parent)) && node.parent.name === node);

/** The global `node` names, if it names one of {@link PROTOTYPE_GLOBALS}. */
const prototypeGlobal = (node: ts.Node): string | undefined =>
  ts.isIdentifier(node) && PROTOTYPE_GLOBALS.has(node.text) && !isMemberName(node) ? node.text : undefined;

/** The first way `node` lets code reach a built-in prototype, if any. */
function prototypeReach(node: ts.Node): string | undefined {
  if (ts.isPropertyAccessExpression(node) && ["prototype", "__proto__"].includes(node.name.text))
    return `the program reads '${node.name.text}'`;
  const global = prototypeGlobal(node);
  return global === undefined ? undefined : `the program names '${global}'`;
}

export function programObjects(sourceFiles: readonly ts.SourceFile[]): ProgramObjects {
  let present = false;
  let namesSymbol = false;
  let reachesPrototype: string | undefined;
  const visit = (node: ts.Node): void => {
    present ||= ts.isObjectLiteralExpression(node);
    namesSymbol ||= prototypeGlobal(node) === "Symbol";
    reachesPrototype ??= prototypeReach(node);
    ts.forEachChild(node, visit);
  };
  sourceFiles.forEach(visit);
  return { present, namesSymbol, reachesPrototype };
}
