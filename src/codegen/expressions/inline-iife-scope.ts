// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Binding-scope bookkeeping for the inline-IIFE fast path, and the one question
 * that decides whether that path may be taken at all (#4555).
 *
 * The inline path shares a Wasm FunctionContext with its caller, so it needs a
 * snapshot/restore of exactly the names the IIFE declares (#3128) — that is the
 * scope half, moved here verbatim. The eligibility half is new: an inlined IIFE
 * has no function OBJECT, so an arguments object that ESCAPES it cannot have a
 * spec-correct `callee` (§10.6 step 13.a). See
 * {@link argumentsEscapesIife}.
 */
import { ts, forEachChild } from "../../ts-api.js";
import type { FunctionContext } from "../context/types.js";

/**
 * (#4555) Would inlining `callee` produce an arguments object whose `callee`
 * cannot be filled in?
 *
 * The inline path splices the body into the caller and builds the arguments
 * vec with a bare `array.new_fixed`/`struct.new` — there is no closure struct,
 * so the §10.6 step 13.a `callee` seed that the LIFTED closure path performs
 * (`arguments-callee.ts`, from the callee's own `__self`) has nothing to point
 * at. As long as the body only ever reads `arguments[i]` / `arguments.length`
 * that is unobservable, and those shapes keep the fast path. Any OTHER use —
 * returning `arguments`, passing it on, reading `arguments.callee` — can reach
 * the property, so the IIFE is compiled as an ordinary closure instead, where
 * `callee` and its descriptor come out right by construction.
 *
 * Measured on this branch: `Object.getOwnPropertyDescriptor(argObj, "callee")`
 * was `undefined` for `(function(){ return arguments })()` while the
 * observationally identical `var mk = function(){ return arguments; }; mk()`
 * already answered the full `{enumerable: false, configurable: true}`
 * descriptor.
 */
export function argumentsEscapesIife(callee: ts.Node, call: ts.CallExpression): boolean {
  if (!ts.isFunctionExpression(callee) || callee.body === undefined) return false;
  // (#4555) An UNDER-APPLIED IIFE cannot take the inline path at all (that arm
  // requires `params.length <= args.length`), so it falls through to the LIFTED
  // `compileIIFE`, which builds no arguments object whatsoever — the body then
  // resolves `arguments` lexically, to a null outer binding or nothing. Route
  // it to the closure path too, where the arguments object is real:
  // `(function (a,b,c) { return arguments.length; })()` read `NaN`, want `0`.
  if (callee.parameters.length > call.arguments.length && usesArgumentsInOwnBody(callee)) return true;
  let escapes = false;
  const visit = (node: ts.Node): void => {
    if (escapes) return;
    // A nested non-arrow function has its OWN arguments object.
    if (node !== callee && (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node))) return;
    if (ts.isIdentifier(node) && node.text === "arguments" && !isIndexOrLengthRead(node)) {
      escapes = true;
      return;
    }
    forEachChild(node, visit);
  };
  forEachChild(callee.body, visit);
  return escapes;
}

/** Does the function expression's OWN body mention `arguments` at all? */
function usesArgumentsInOwnBody(callee: ts.FunctionExpression): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (node !== callee && (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node))) return;
    if (ts.isIdentifier(node) && node.text === "arguments") {
      found = true;
      return;
    }
    forEachChild(node, visit);
  };
  forEachChild(callee.body!, visit);
  return found;
}

/** `arguments[i]` / `arguments.length` — the two uses the vec alone satisfies. */
function isIndexOrLengthRead(node: ts.Identifier): boolean {
  const parent = node.parent as ts.Node | undefined;
  if (parent === undefined) return false;
  if (ts.isElementAccessExpression(parent) && parent.expression === node) return true;
  return ts.isPropertyAccessExpression(parent) && parent.expression === node && parent.name.text === "length";
}

function cloneNameMap<T>(map: Map<string, T> | undefined): Map<string, T> | undefined {
  return map ? new Map(map) : undefined;
}

function cloneNameSet(set: Set<string> | undefined): Set<string> | undefined {
  return set ? new Set(set) : undefined;
}

function restoreNameMap<T>(
  current: Map<string, T> | undefined,
  saved: Map<string, T> | undefined,
  names: ReadonlySet<string>,
): Map<string, T> | undefined {
  let restored = current;
  for (const name of names) {
    if (saved?.has(name)) {
      restored ??= new Map();
      restored.set(name, saved.get(name)!);
    } else {
      restored?.delete(name);
    }
  }
  return restored;
}

function restoreNameSet(
  current: Set<string> | undefined,
  saved: Set<string> | undefined,
  names: ReadonlySet<string>,
): Set<string> | undefined {
  let restored = current;
  for (const name of names) {
    if (saved?.has(name)) {
      restored ??= new Set();
      restored.add(name);
    } else {
      restored?.delete(name);
    }
  }
  return restored;
}

/**
 * The inline-IIFE fast path shares a Wasm FunctionContext with its caller, but
 * it must not share the caller's source-level binding namespace. Snapshot and
 * temporarily hide only names declared by the IIFE. Changes to every other
 * name remain live, which is load-bearing for closures that box a genuinely
 * captured outer binding while the IIFE body is compiled (#3128).
 */
export function enterInlineIifeBindingScope(fctx: FunctionContext, names: ReadonlySet<string>) {
  const snapshot = {
    localMap: new Map(fctx.localMap),
    boxedCaptures: cloneNameMap(fctx.boxedCaptures),
    boxedTdzFlags: cloneNameMap(fctx.boxedTdzFlags),
    tdzFlagLocals: cloneNameMap(fctx.tdzFlagLocals),
    directEvalBindingNames: cloneNameSet(fctx.directEvalBindingNames),
    directEvalActivationBindingNames: cloneNameSet(fctx.directEvalActivationBindingNames),
    directEvalOuterBindingNames: cloneNameSet(fctx.directEvalOuterBindingNames),
    directEvalActivationBindings: cloneNameMap(fctx.directEvalActivationBindings),
    forInIdentifierVars: cloneNameSet(fctx.forInIdentifierVars),
    promotedCaptureNames: cloneNameSet(fctx.promotedCaptureNames),
    nestedFnClosureMemos: cloneNameMap(fctx.nestedFnClosureMemos),
    readOnlyBindings: cloneNameSet(fctx.readOnlyBindings),
    constBindings: cloneNameSet(fctx.constBindings),
    hoistedFuncs: cloneNameSet(fctx.hoistedFuncs),
    narrowedNonNull: cloneNameSet(fctx.narrowedNonNull),
    undefWidenedLocals: cloneNameSet(fctx.undefWidenedLocals),
    nullGuardAliases: cloneNameMap(fctx.nullGuardAliases),
    aliasedNullGuardNonNull: cloneNameSet(fctx.aliasedNullGuardNonNull),
    fnctorWidenedLocals: cloneNameSet(fctx.fnctorWidenedLocals),
    annexBCancelled: fctx.annexBCancelled
      ? new Map(Array.from(fctx.annexBCancelled, ([name, ranges]) => [name, ranges.map((range) => ({ ...range }))]))
      : undefined,
    annexBOuterBindings: cloneNameSet(fctx.annexBOuterBindings),
    annexBRepeatedOuterBindings: cloneNameSet(fctx.annexBRepeatedOuterBindings),
    annexBExistingDirectFunctionBindings: cloneNameSet(fctx.annexBExistingDirectFunctionBindings),
    moduleBindingShadowLocals: cloneNameMap(fctx.moduleBindingShadowLocals),
  };

  for (const name of names) {
    fctx.localMap.delete(name);
    fctx.boxedCaptures?.delete(name);
    fctx.boxedTdzFlags?.delete(name);
    fctx.tdzFlagLocals?.delete(name);
    fctx.directEvalBindingNames?.delete(name);
    fctx.directEvalActivationBindingNames?.delete(name);
    fctx.directEvalOuterBindingNames?.delete(name);
    fctx.directEvalActivationBindings?.delete(name);
    fctx.forInIdentifierVars?.delete(name);
    fctx.promotedCaptureNames?.delete(name);
    fctx.nestedFnClosureMemos?.delete(name);
    fctx.readOnlyBindings?.delete(name);
    fctx.constBindings?.delete(name);
    fctx.hoistedFuncs?.delete(name);
    fctx.narrowedNonNull?.delete(name);
    fctx.undefWidenedLocals?.delete(name);
    fctx.nullGuardAliases?.delete(name);
    fctx.aliasedNullGuardNonNull?.delete(name);
    fctx.fnctorWidenedLocals?.delete(name);
    fctx.annexBCancelled?.delete(name);
    fctx.annexBOuterBindings?.delete(name);
    fctx.annexBRepeatedOuterBindings?.delete(name);
    fctx.annexBExistingDirectFunctionBindings?.delete(name);
    fctx.moduleBindingShadowLocals?.delete(name);
  }

  return () => {
    fctx.localMap = restoreNameMap(fctx.localMap, snapshot.localMap, names)!;
    fctx.boxedCaptures = restoreNameMap(fctx.boxedCaptures, snapshot.boxedCaptures, names);
    fctx.boxedTdzFlags = restoreNameMap(fctx.boxedTdzFlags, snapshot.boxedTdzFlags, names);
    fctx.tdzFlagLocals = restoreNameMap(fctx.tdzFlagLocals, snapshot.tdzFlagLocals, names);
    fctx.directEvalBindingNames = restoreNameSet(fctx.directEvalBindingNames, snapshot.directEvalBindingNames, names);
    fctx.directEvalActivationBindingNames = restoreNameSet(
      fctx.directEvalActivationBindingNames,
      snapshot.directEvalActivationBindingNames,
      names,
    );
    fctx.directEvalOuterBindingNames = restoreNameSet(
      fctx.directEvalOuterBindingNames,
      snapshot.directEvalOuterBindingNames,
      names,
    );
    fctx.directEvalActivationBindings = restoreNameMap(
      fctx.directEvalActivationBindings,
      snapshot.directEvalActivationBindings,
      names,
    );
    fctx.forInIdentifierVars = restoreNameSet(fctx.forInIdentifierVars, snapshot.forInIdentifierVars, names);
    fctx.promotedCaptureNames = restoreNameSet(fctx.promotedCaptureNames, snapshot.promotedCaptureNames, names);
    fctx.nestedFnClosureMemos = restoreNameMap(fctx.nestedFnClosureMemos, snapshot.nestedFnClosureMemos, names);
    fctx.readOnlyBindings = restoreNameSet(fctx.readOnlyBindings, snapshot.readOnlyBindings, names);
    fctx.constBindings = restoreNameSet(fctx.constBindings, snapshot.constBindings, names);
    fctx.hoistedFuncs = restoreNameSet(fctx.hoistedFuncs, snapshot.hoistedFuncs, names);
    fctx.narrowedNonNull = restoreNameSet(fctx.narrowedNonNull, snapshot.narrowedNonNull, names);
    fctx.undefWidenedLocals = restoreNameSet(fctx.undefWidenedLocals, snapshot.undefWidenedLocals, names);
    fctx.nullGuardAliases = restoreNameMap(fctx.nullGuardAliases, snapshot.nullGuardAliases, names);
    fctx.aliasedNullGuardNonNull = restoreNameSet(
      fctx.aliasedNullGuardNonNull,
      snapshot.aliasedNullGuardNonNull,
      names,
    );
    fctx.fnctorWidenedLocals = restoreNameSet(fctx.fnctorWidenedLocals, snapshot.fnctorWidenedLocals, names);
    fctx.annexBCancelled = restoreNameMap(fctx.annexBCancelled, snapshot.annexBCancelled, names);
    fctx.annexBOuterBindings = restoreNameSet(fctx.annexBOuterBindings, snapshot.annexBOuterBindings, names);
    fctx.annexBRepeatedOuterBindings = restoreNameSet(
      fctx.annexBRepeatedOuterBindings,
      snapshot.annexBRepeatedOuterBindings,
      names,
    );
    fctx.annexBExistingDirectFunctionBindings = restoreNameSet(
      fctx.annexBExistingDirectFunctionBindings,
      snapshot.annexBExistingDirectFunctionBindings,
      names,
    );
    fctx.moduleBindingShadowLocals = restoreNameMap(
      fctx.moduleBindingShadowLocals,
      snapshot.moduleBindingShadowLocals,
      names,
    );
  };
}
