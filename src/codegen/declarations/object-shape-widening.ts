// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Empty / growable / array object-shape pre-pass (#2584/#2837/#2372/#2944).
 * Runs before collectDeclarations so struct/vec types register with the right
 * fields. Extracted verbatim from codegen/declarations.ts (#3268).
 */
import { collectShapes } from "../../shape-inference.js";
import { forEachChild, getTypeAtLocationBounded, ts } from "../../ts-api.js";
import { resolveWasmType } from "../index.js";
import { localGlobalIdx } from "../registry/imports.js";
import { getArrTypeIdxFromVec, getOrRegisterVecType, registerStructType } from "../registry/types.js";
import { valTypesMatch } from "../shared.js";
import { widenedVarKeyFromDecl } from "../widened-var-key.js";
import type { FieldDef, ValType } from "../../ir/types.js";
import type { CodegenContext } from "../context/types.js";
import { createDeclaredNestedWriteClassifier } from "./declared-nested-write.js";
import { collectEvalMutableNames } from "./eval-reachable-object-shape.js"; // (#4206)
import { fnctorBodyMayReturnForeignObject } from "../fnctor-foreign-return.js"; // (#2071)
import {
  bindingHasIrPlannedOpenWithTarget,
  bindingUsesOnlyIrPlannedOpenObjectOperations,
} from "./dynamic-with-shape.js";

function isUnboxedPrimitiveCarrier(type: ValType): boolean {
  return ["f64", "f32", "i64", "i32", "i16", "i8"].includes(type.kind);
}

type WidenedPropCandidate = {
  name: string;
  type: ValType;
  primitiveSeed: boolean;
};

function literalShapeNames(obj: ts.ObjectLiteralExpression): Set<string> | null {
  const names = new Set<string>();
  for (const property of obj.properties) {
    if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) return null;
    const name = property.name;
    if (!ts.isIdentifier(name) && !ts.isStringLiteral(name) && !ts.isNumericLiteral(name)) return null;
    names.add(name.text);
  }
  return names;
}

function propertyChainRoot(pae: ts.PropertyAccessExpression): { root: string; depth: number } | null {
  let expression: ts.Expression = pae;
  let depth = 0;
  while (ts.isPropertyAccessExpression(expression)) {
    depth++;
    expression = expression.expression;
  }
  return ts.isIdentifier(expression) ? { root: expression.text, depth } : null;
}

function isRuntimePrimitiveSeed(type: ValType, tsType: ts.Type): boolean {
  const sentinelFlags = ts.TypeFlags.Undefined | ts.TypeFlags.Void | ts.TypeFlags.Null;
  return isUnboxedPrimitiveCarrier(type) && (tsType.flags & sentinelFlags) === 0;
}

/** Preserve semantic brands that are erased by the numeric Wasm carrier. */
function resolveWidenedPropertyType(ctx: CodegenContext, tsType: ts.Type): ValType {
  const type = resolveWasmType(ctx, tsType);
  if (type.kind === "i32" && (tsType.flags & ts.TypeFlags.ESSymbolLike) !== 0) {
    return { ...type, symbol: true };
  }
  return type;
}

/**
 * Record properties that receive object-shaped or dynamically typed values.
 * Closed anonymous structs are shape-specific, while JavaScript properties can
 * later hold a different object shape. The field-registration pass consumes
 * this set before any bodies are emitted and gives matching fields a stable
 * externref carrier. This also covers a null-initialized field later assigned
 * through an `any` parameter (ReactDOM's `queue.pending = update`).
 */
export function collectObjectLiteralAssignedPropertyNames(ctx: CodegenContext, sourceFile: ts.SourceFile): void {
  // Avoid an AST walk for files that cannot contain a direct property write.
  // The scanner skips comments and strings, so this is a conservative lexical
  // preflight: every `PropertyAccessExpression = ...` has the token sequence
  // `. <property-name> =`, including keyword-named properties.
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, sourceFile.text);
  let token = scanner.scan();
  let hasPropertyAssignment = false;
  while (token !== ts.SyntaxKind.EndOfFileToken) {
    if (token === ts.SyntaxKind.DotToken) {
      scanner.scan();
      if (scanner.scan() === ts.SyntaxKind.EqualsToken) {
        hasPropertyAssignment = true;
        break;
      }
    }
    token = scanner.scan();
  }
  if (!hasPropertyAssignment) return;

  const visit = (node: ts.Node): void => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left)
    ) {
      let rhs: ts.Expression = node.right;
      while (
        ts.isParenthesizedExpression(rhs) ||
        ts.isAsExpression(rhs) ||
        ts.isSatisfiesExpression(rhs) ||
        ts.isTypeAssertionExpression(rhs)
      ) {
        rhs = rhs.expression;
      }
      const rhsType = getTypeAtLocationBounded(ctx.checker, rhs);
      const mayCarryObject =
        ts.isObjectLiteralExpression(rhs) ||
        ts.isArrayLiteralExpression(rhs) ||
        ts.isFunctionExpression(rhs) ||
        ts.isArrowFunction(rhs) ||
        ts.isNewExpression(rhs) ||
        (rhsType.flags &
          (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Object | ts.TypeFlags.NonPrimitive)) !==
          0;
      if (mayCarryObject) {
        const name = node.left.name.text;
        ctx.objectLiteralAssignedPropertyNames.add(name);
        const writes = ctx.objectLiteralAssignedPropertyTypes.get(name) ?? [];
        writes.push(rhsType);
        ctx.objectLiteralAssignedPropertyTypes.set(name, writes);
      }
    }
    forEachChild(node, visit);
  };
  forEachChild(sourceFile, visit);
}

/**
 * Early, type-table-neutral carrier scan for functions that return an empty
 * object populated through computed keys. Fnctor structs are reserved before
 * the full widening pass, so their RHS field inference must already know that
 * calls such as `getOptions(options)` return the open externref `$Object`.
 */
export function collectDynamicObjectReturnCarrierTypes(
  ctx: CodegenContext,
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
): void {
  const dynamicFunctionNames = new Set<string>();
  const inspect = (fn: ts.FunctionDeclaration): void => {
    if (!fn.body) return;
    const emptyVars = new Set<string>();
    const dynamicVars = new Set<string>();
    const returnedVars = new Set<string>();
    const visitBody = (node: ts.Node): void => {
      if (
        node !== fn &&
        (ts.isFunctionDeclaration(node) ||
          ts.isFunctionExpression(node) ||
          ts.isArrowFunction(node) ||
          ts.isMethodDeclaration(node) ||
          ts.isAccessor(node) ||
          ts.isConstructorDeclaration(node))
      ) {
        return;
      }
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        ts.isObjectLiteralExpression(node.initializer) &&
        node.initializer.properties.length === 0
      ) {
        emptyVars.add(node.name.text);
      }
      if (ts.isElementAccessExpression(node) && ts.isIdentifier(node.expression)) {
        dynamicVars.add(node.expression.text);
      }
      if (ts.isReturnStatement(node) && node.expression && ts.isIdentifier(node.expression)) {
        returnedVars.add(node.expression.text);
      }
      forEachChild(node, visitBody);
    };
    forEachChild(fn.body, visitBody);
    const returnsDynamic = [...returnedVars].some((name) => emptyVars.has(name) && dynamicVars.has(name));
    if (!returnsDynamic) return;
    const sig = checker.getSignatureFromDeclaration(fn);
    if (sig) ctx.objectHashConsumerTypes.add(checker.getReturnTypeOfSignature(sig));
    if (fn.name) {
      dynamicFunctionNames.add(fn.name.text);
      ctx.dynamicObjectReturnFunctions.add(fn.name.text);
    }
  };

  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node)) inspect(node);
    forEachChild(node, visit);
  };
  forEachChild(sourceFile, visit);
  if (dynamicFunctionNames.size > 0) {
    const collectCalls = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        dynamicFunctionNames.has(node.expression.text)
      ) {
        ctx.objectHashConsumerTypes.add(checker.getTypeAtLocation(node));
      }
      forEachChild(node, collectCalls);
    };
    forEachChild(sourceFile, collectCalls);
  }
}

/**
 * Pre-pass: detect empty object literals (`var obj = {}`) that later receive
 * property assignments (`obj.prop = val`) and record the extra properties so
 * that ensureStructForType creates a struct with the correct fields.
 *
 * This runs *before* collectDeclarations so the struct type is correct from
 * the start.
 */
/**
 * (#2071) Function declarations that are (a) constructed with `new` somewhere
 * in this file and (b) foreign-return-capable (§10.2.1.3 step 13 may hand
 * their `return obj` to the construct consumer). A `var X = {}` returned from
 * such a body ESCAPES as the construct result and is read dynamically by
 * consumers that know nothing of its evolved shape — a widened closed struct
 * is invisible to them (measured: `__obj.prop` answered undefined).
 */
function computeForeignReturnCtors(
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
): Set<ts.FunctionLikeDeclaration> {
  const ctors = new Set<ts.FunctionLikeDeclaration>();
  const newTargets = new Set<ts.Symbol>();
  const scanNew = (n: ts.Node): void => {
    if (ts.isNewExpression(n)) {
      const sym = checker.getSymbolAtLocation(n.expression);
      if (sym) newTargets.add(sym);
    }
    forEachChild(n, scanNew);
  };
  scanNew(sourceFile);
  const admit = (nameNode: ts.Identifier, fn: ts.FunctionLikeDeclaration): void => {
    const sym = checker.getSymbolAtLocation(nameNode);
    if (sym && newTargets.has(sym) && fnctorBodyMayReturnForeignObject(fn)) ctors.add(fn);
  };
  const scanFns = (n: ts.Node): void => {
    if (ts.isFunctionDeclaration(n) && n.name) {
      admit(n.name, n);
    } else if (
      // `var F = function(){…}` and `F = function(){…}` — the S13.2.2_A15_T3/T4
      // constructor spellings.
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.initializer !== undefined &&
      ts.isFunctionExpression(n.initializer)
    ) {
      admit(n.name, n.initializer);
    } else if (
      ts.isBinaryExpression(n) &&
      n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(n.left) &&
      ts.isFunctionExpression(n.right)
    ) {
      admit(n.left, n.right);
    }
    forEachChild(n, scanFns);
  };
  scanFns(sourceFile);
  return ctors;
}

/**
 * (#2071) Does `fn`'s own body (nested functions excluded) contain
 * `return <varName>`?
 */
function fnBodyReturnsIdentifier(fn: ts.FunctionLikeDeclaration, varName: string): boolean {
  if (fn.body === undefined) return false;
  let returned = false;
  const scanReturns = (n: ts.Node): void => {
    if (returned) return;
    if (n !== fn && ts.isFunctionLike(n)) return;
    if (ts.isReturnStatement(n) && n.expression) {
      let e: ts.Expression = n.expression;
      while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e)) e = e.expression;
      if (ts.isIdentifier(e) && e.text === varName) returned = true;
    }
    forEachChild(n, scanReturns);
  };
  scanReturns(fn.body);
  return returned;
}

/**
 * (#2071) `var X;` (no initializer, module level) — or an implicit global —
 * whose `X = {…}` assignment happens INSIDE a foreign-return-capable new'd
 * ctor body that also `return X`s: X escapes both as the construct result and
 * as a global, so its evolved closed shape is unsound everywhere. Poison the
 * name onto the open `$Object` and pin its evolved checker type (and the
 * ctor's return type) so no flow position resolves to the closed struct
 * (measured: the closed-struct global guard-cast the `$Object` to null and
 * `obj.prop` answered null — S13.2.2_A15_T2/T4).
 */
function poisonForeignCtorAssignedGlobals(
  ctx: CodegenContext,
  checker: ts.TypeChecker,
  foreignReturnCtors: Set<ts.FunctionLikeDeclaration>,
): void {
  for (const fn of foreignReturnCtors) {
    if (fn.body === undefined) continue;
    const assignedIds = new Map<string, ts.Identifier>();
    const scan = (n: ts.Node): void => {
      if (n !== fn && ts.isFunctionLike(n)) return;
      if (
        ts.isBinaryExpression(n) &&
        n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isIdentifier(n.left) &&
        ts.isObjectLiteralExpression(n.right) &&
        !assignedIds.has(n.left.text)
      ) {
        assignedIds.set(n.left.text, n.left);
      }
      forEachChild(n, scan);
    };
    scan(fn.body);
    for (const [name, id] of assignedIds) {
      if (!fnBodyReturnsIdentifier(fn, name)) continue;
      ctx.objectHashConsumerVars.add(name);
      ctx.growableObjectLiteralVars.add(name);
      const pin = (t: ts.Type | undefined): void => {
        if (t !== undefined && !(t.flags & ts.TypeFlags.Any) && t.getProperties().length > 0) {
          ctx.objectHashConsumerTypes.add(t);
        }
      };
      pin(checker.getTypeAtLocation(id));
      const vd = checker.getSymbolAtLocation(id)?.valueDeclaration;
      if (vd !== undefined && ts.isVariableDeclaration(vd) && ts.isIdentifier(vd.name)) {
        pin(checker.getTypeAtLocation(vd.name));
      }
      const sig = checker.getSignatureFromDeclaration(fn);
      if (sig) pin(checker.getReturnTypeOfSignature(sig));
    }
  }
}

/**
 * (#2071) Is `decl` (a `var X = {}`) declared inside one of the
 * `foreignReturnCtors` bodies AND returned by it? Only a RETURNED local
 * escapes as the construct result; an unreturned one keeps its widened fast
 * path.
 */
function varEscapesViaForeignReturnCtor(
  foreignReturnCtors: Set<ts.FunctionLikeDeclaration>,
  decl: ts.VariableDeclaration,
  varName: string,
): boolean {
  if (foreignReturnCtors.size === 0) return false;
  let fn: ts.Node | undefined = decl.parent;
  while (fn !== undefined && !ts.isFunctionLike(fn)) fn = fn.parent;
  if (fn === undefined || !foreignReturnCtors.has(fn as ts.FunctionLikeDeclaration)) return false;
  return fnBodyReturnsIdentifier(fn as ts.FunctionLikeDeclaration, varName);
}

export function collectEmptyObjectWidening(
  ctx: CodegenContext,
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
): void {
  // (#2071) Lazily computed: most files have no foreign-return constructor.
  let foreignReturnCtors: Set<ts.FunctionLikeDeclaration> | undefined;
  if (ctx.standalone || ctx.wasi) {
    foreignReturnCtors = computeForeignReturnCtors(checker, sourceFile);
    if (foreignReturnCtors.size > 0) poisonForeignCtorAssignedGlobals(ctx, checker, foreignReturnCtors);
  }
  // Scan all statements (top-level and inside function bodies)
  function scanStatements(stmts: readonly ts.Statement[]): void {
    for (const stmt of stmts) {
      // Look for var/let/const declarations with empty object literal initializer
      if (ts.isVariableStatement(stmt)) {
        for (const decl of stmt.declarationList.declarations) {
          if (!ts.isIdentifier(decl.name)) continue;
          if (!decl.initializer || !ts.isObjectLiteralExpression(decl.initializer)) continue;
          if (decl.initializer.properties.length > 0) continue;

          // Found `var X = {}` — now scan siblings for `X.prop = val`
          const varName = decl.name.text;
          // (#3403) per-declaration key for `widenedDefinePropertyKeys`; matches
          // what `integrityVarKey` yields at the USE sites in object-ops.ts.
          const varKey = widenedVarKeyFromDecl(decl.name);
          const extraProps: WidenedPropCandidate[] = [];
          const seenProps = new Set<string>();

          // Scan all following statements in the same block for property assignments
          collectPropsFromStatements(checker, ctx, stmts, varName, varKey, extraProps, seenProps);

          // (#2584/#2849/#2944) If this var is ALSO the subject of any
          // `$Object`-hash-only consumer (bracket read/write, `in`, Object.keys
          // / values / entries / GOPD / GOPN / assign, for-in), a widened closed
          // struct would be invisible to that consumer (`o.a=7; o["a"]` → 0).
          // Mark it poisoned so widening is suppressed below and the receiver
          // stays a `$Object`. Scan the whole enclosing statement list (the same
          // tree `collectPropsFromStatements` walks).
          //
          // History: originally `ctx.standalone`-gated (#2584) on the assumption
          // "host keeps the struct fast path via the live-mirror Proxy". #2849
          // dropped the gate (the Proxy does NOT bridge the for-in-write →
          // static-struct-read divergence, so host mis-read `getOptions`-shaped
          // objects). That extension alone REGRESSED compiled-acorn to a uniform
          // null-deref (#2937) because the poison was honored only at THIS
          // widening decision, while in JS-mode sources the checker's EVOLVED
          // type for the var still resolved to a colliding `__anon` struct at
          // the local/receiver/return/field positions — so it was reverted
          // (#2462). Re-landed here TOGETHER with the #2944 escape discipline:
          // the poison branch below records the var's evolved checker type in
          // `objectHashConsumerTypes`, and resolveWasmType / ensureStructForType
          // / resolveStructName refuse struct resolution for it, keeping the
          // value externref/host-MOP through every escape. Both constraints now
          // hold: the #2849 host arms pass AND compiled-acorn parses.
          for (const s of stmts) {
            markObjectHashConsumers(s, varName, ctx.objectHashConsumerVars);
          }

          // (#2071) Returned from a foreign-return-capable constructor → the
          // literal escapes as the construct result; keep it an open `$Object`
          // (see varEscapesViaForeignReturnCtor above).
          if ((ctx.standalone || ctx.wasi) && !ctx.objectHashConsumerVars.has(varName)) {
            foreignReturnCtors ??= computeForeignReturnCtors(checker, sourceFile);
            if (varEscapesViaForeignReturnCtor(foreignReturnCtors, decl, varName)) {
              ctx.objectHashConsumerVars.add(varName);
            }
          }

          // (#2992 S4, standalone) `delete varName.prop` / `delete varName[k]`
          // is an `$Object`-hash consumer too: a widened closed-struct FIELD
          // cannot represent a deleted property — the struct-delete arm
          // (typeof-delete.ts) writes a type-shaped SENTINEL (f64 → NaN,
          // ref → null) into the fixed slot, and a statically-f64 read makes
          // `o.k === undefined` CONST-FOLD to false, so the read can never
          // observe the deletion (the issue's headline nominal-struct repro;
          // also the pre-existing `delete-sentinel` string-field equivalence
          // failure). Poison the widening so the var stays a `$Object`, where
          // `__delete_property` tombstones give correct delete → read / `in` /
          // hasOwnProperty semantics. Standalone-gated: the host lane's
          // sidecar + live-mirror handles struct deletes (byte-inert).
          if (ctx.standalone && !ctx.objectHashConsumerVars.has(varName)) {
            for (const s of stmts) {
              markStandaloneDeleteTargets(s, varName, ctx.objectHashConsumerVars);
            }
          }

          // (#2992 S5, standalone) An ACCESSOR-descriptor
          // `Object.defineProperty(varName, k, {get/set…})` (or any
          // `defineProperties` member descriptor with a get/set key) is an
          // `$Object`-hash consumer too: a widened closed-struct FIELD can only
          // store a plain value, so the define either stores the getter closure
          // itself or null into the fixed slot — a later read (`obj[k]` through
          // an any-typed harness param, or `obj.k`) can never INVOKE the getter,
          // and gOPD can never observe accessor-ness (`hasOwnProperty("get")`).
          // Poison the widening so the var stays a `$Object`, where the slice-3
          // (#2893) accessor machinery (FLAG_ACCESSOR + live get/set halves +
          // §10.1.6.3 merge) serves define → read → gOPD correctly (measured:
          // the 15.2.3.6-4-75 / 4-82-* runner-wrapped family flips to pass).
          // Standalone-gated: the host lane applies accessor defines through the
          // live-mirror Proxy onto the real JS object (byte-inert there).
          if (ctx.standalone && !ctx.objectHashConsumerVars.has(varName)) {
            for (const s of stmts) {
              markStandaloneAccessorDefineTargets(s, varName, ctx.objectHashConsumerVars);
            }
          }

          // (#1712) Descriptor/integrity mutation is per OBJECT IDENTITY, not
          // per structural Wasm type. Keep every receiver of Object's mutating
          // MOPs on the canonical open `$Object` store so define/freeze/seal
          // update the exact `$PropEntry` metadata later read by direct OR
          // stored gOPD. This includes a builtin captured into a local
          // (`const define = Object.defineProperty; define(o, ...)`): the
          // stored closure has the same mutation effect as its direct spelling.
          // Baking these flags into a widened closed shape would incorrectly
          // share one instance's integrity state with every same-shape object.
          if (ctx.standalone && !ctx.objectHashConsumerVars.has(varName)) {
            for (const s of stmts) {
              markStandaloneObjectMutationTargets(ctx, s, varName, ctx.objectHashConsumerVars);
            }
          }

          // (#739 S1 — HOST-lane representation pinning, the store-unification)
          // Any `Object.defineProperty` / `Object.defineProperties` on this
          // receiver whose application lands in the RUNTIME STORE — the native
          // `$Object` open hash or the `_wasmPropDescs`/`_wasmStructProps`
          // sidecar — rather than a widened-struct `struct.set` fast path makes
          // a widened struct UNSOUND: every later dot-read `obj.p` lowers to
          // `struct.get` (a defined getter never fires; a runtime-store value
          // reads the struct default) and every dot-write `obj.p = X` to
          // `struct.set` (a defined setter is bypassed). The two stores never
          // see each other, and `_structFieldWriteback` mirrors only data
          // VALUES back into the field — accessors cannot be mirrored (a
          // `struct.get` can never invoke a getter). #3230 measured both bounded
          // point-fixes (read-reroute net −7; read-reroute + runtime fallback
          // still fails) and proved the field-vs-sidecar choice is
          // widening-sensitive — the only sound fix is to keep the receiver on
          // the ONE native store. Standalone already ships this via
          // `dynamicDescriptorWidenVars` (checked at :123) +
          // `markStandaloneAccessorDefineTargets` (above); the host lane was
          // exempted on the (disproved) assumption the live-mirror writeback
          // bridges the gap. Pin here by marking the var an
          // `objectHashConsumerVar` so the suppression branch below (a) skips
          // widening and (b) — load-bearing — records the var's EVOLVED checker
          // type in `objectHashConsumerTypes` (the #2944 escape discipline;
          // without it the checker re-registers a colliding `__anon` struct at
          // the var's escape positions and compiled-acorn null-derefs, #2937).
          // The now-pinned `$Object` rides the extern-lane MOP ops the
          // bracket-form (`obj["p"]`) already proves correct on main. Host-gated
          // so standalone stays byte-identical (also avoids colliding with
          // in-flight #2042); WASI is standalone (no host MOP).
          if (!ctx.standalone && !ctx.objectHashConsumerVars.has(varName)) {
            for (const s of stmts) {
              markRuntimeStoreDefineTargets(s, varName, ctx.objectHashConsumerVars);
            }
          }

          // (#2372) Standalone: if any `Object.defineProperty(varName, …)` on
          // this receiver used a *dynamic* (non-inline-literal) descriptor, the
          // struct-widening fast path is unsound — the dynamic define is applied
          // through the native `__obj_define_from_desc` `$Object` runtime, but a
          // widened struct would make the read-back `varName.key` lower to
          // `struct.get` against a different object (returns 0). Suppress
          // widening entirely for such receivers so they stay on the `$Object`
          // representation and writes + reads route through the native runtime
          // consistently. (`collectPropsFromStatements` sets the poison flag
          // above, before this decision point.) Host mode is unaffected — it
          // keeps the struct fast path via the live-mirror Proxy writeback.
          if (ctx.dynamicDescriptorWidenVars.has(varName)) {
            continue;
          }

          // (#2584) Suppress widening when a $Object-hash consumer was found
          // above — the var stays a `$Object` so bracket/`in`/keys/GOPD see the
          // same representation the dot-writes land in.
          if (ctx.objectHashConsumerVars.has(varName)) {
            // (#2937) Suppressing the widening pre-pass is NOT enough in a
            // JS-mode source file: the checker EVOLVES `var o = {}` through its
            // later static-named writes into an anonymous object type WITH
            // those props, and `resolveWasmType`/`ensureStructForType` would
            // independently register that evolved type as a closed `__anon_N`
            // struct — typing the local (and the var's every flow position:
            // returns, class fields, receivers) as `(ref null __anon_N)` while
            // the poisoned initializer builds a host plain object. The
            // declaration's guarded cast then stores ref.null and every static
            // read null-derefs (the compiled-acorn `getOptions` uniform throw).
            // Record the var's EVOLVED checker type so struct resolution
            // refuses it and the var stays externref / host-MOP end to end.
            //
            // Scope guards keep everything else byte-identical:
            //   - skip `any` (singleton type object shared by all any-typed
            //     vars — same hazard as the anonTypeMap guard below).
            //   - a 0-props (TS-mode, non-evolved `{}`) type is added ONLY when
            //     its provenance is THIS var's own initializer literal
            //     (`symbol.declarations[0] === decl.initializer`). The widened
            //     literal type is a fresh per-var instance (measured — two `{}`
            //     vars get distinct instances), but the type of a `: {}`
            //     ANNOTATION is an interned instance SHARED by every var so
            //     annotated — poisoning it would demote unrelated vars. The
            //     provenance check admits the safe per-var case and rejects the
            //     shared one.
            //
            // (#2944 residual) The 0-props TS-mode case MUST be poisoned too —
            // "already resolves to externref" does NOT hold for it: the
            // signature pre-pass `ensureStructForType(returnType)` on a function
            // that RETURNS the poisoned var registers the SAME 0-props ts.Type
            // as an EMPTY anon struct ("empty objects get an empty struct"), so
            // the local/return/field slots type `(ref null $__anon_N)`, the `{}`
            // host `$Object` fails the decl-init cast, and the var is null from
            // the first instruction — the acorn `Parser`/`getOptions` escape
            // shape in TS-mode typing (tests/issue-2944.test.ts).
            if (!ctx.standalone) {
              // Preserve the host lane's evolved-variable-only poison. Its
              // live-mirror/sidecar provider still relies on the initializer
              // retaining main's closed-struct representation.
              const vt = checker.getTypeAtLocation(decl.name);
              if (
                !(vt.flags & ts.TypeFlags.Any) &&
                (vt.getProperties().length > 0 ||
                  vt.symbol?.declarations?.[0] === (decl.initializer as unknown as ts.Declaration))
              ) {
                ctx.objectHashConsumerTypes.add(vt);
              }
            } else {
              // Standalone's native `$Object` provider needs the initializer,
              // variable, and enclosing return carrier pinned together.
              recordOpenObjectConsumerTypes(ctx, checker, decl, varName);
            }
            continue;
          }

          if (extraProps.length > 0) {
            // (#3364) Key by the DECLARATION site, not the bare name — acorn
            // reuses generic local names (`node`) across many functions with
            // different shapes, and bare-name keying let the last widening
            // clobber every other same-named var (foreign struct → dropped
            // fields → null reads → runaway walk).
            const varKey = widenedVarKeyFromDecl(decl.name);
            ctx.widenedTypeProperties.set(varKey, extraProps);

            // Register the struct type now so that collectDeclarations
            // can resolve the variable type to a struct ref instead of externref
            const fields: FieldDef[] = extraProps.map((wp) => ({
              name: wp.name,
              // `__*` keys are frequently package-private CJS export slots
              // whose value is produced by a different module's anonymous
              // object shape. Keeping a ref-typed slot here makes that
              // cross-module structural identity requirement unsound (the
              // assignment then stores null after a failed cast). Use the
              // universal host carrier for these dynamic/private keys; the
              // property accessor will still preserve their normal JS value.
              type: wp.name.startsWith("__") ? { kind: "externref" } : wp.type,
              mutable: true,
            }));
            const structName = `__anon_${ctx.anonTypeCounter++}`;
            registerStructType(ctx, structName, fields);
            // The empty-object widening path creates the struct outside
            // `compileObjectLiteral`, so it does not get the normal insertion
            // order record. Preserve every source-written key—including
            // user-facing `__*` names such as React's
            // `__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE`—
            // as a real field. Without this provenance the generic
            // `isInternalStructFieldName` screen hides the field from the
            // generated getter/dynamic read and cross-module consumers observe
            // `undefined` even though the assignment ran.
            ctx.structInsertionOrder.set(
              structName,
              extraProps.map((property) => property.name),
            );
            // Map variable declaration key to struct name for later lookup
            ctx.widenedVarStructMap.set(varKey, structName);
            // Also try to map TS types (may not match later due to type identity)
            // Skip `any` — it's a singleton type object shared by all any-typed vars,
            // so registering it would cause every any-typed var to resolve to this struct.
            const varType = checker.getTypeAtLocation(decl.name);
            if (!(varType.flags & ts.TypeFlags.Any)) {
              ctx.anonTypeMap.set(varType, structName);
            }
            const initType = checker.getTypeAtLocation(decl.initializer);
            if (!(initType.flags & ts.TypeFlags.Any)) {
              ctx.anonTypeMap.set(initType, structName);
            }
          }
        }
      }
      // Recurse into function bodies
      if (ts.isFunctionDeclaration(stmt) && stmt.body) {
        scanStatements(stmt.body.statements);
      } else {
        // (#4380) Script/bootstrap code commonly wraps its whole realm setup in
        // an arrow/function IIFE. Empty-object widening used to inspect named
        // function declarations only, so `{}` locals inside an IIFE missed both
        // their later fields and their dynamic-object consumers. Codegen then
        // built an open `$Object`, while the evolved checker type independently
        // allocated a closed struct local; the guarded cast stored null and the
        // first property write trapped. Walk function-expression bodies nested
        // in ordinary statements, stopping at each body because scanStatements
        // owns recursive scope traversal from there.
        const scanNestedFunctionExpressions = (node: ts.Node): void => {
          if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && ts.isBlock(node.body)) {
            scanStatements(node.body.statements);
            return;
          }
          forEachChild(node, scanNestedFunctionExpressions);
        };
        forEachChild(stmt, scanNestedFunctionExpressions);
      }
      // Recurse into try/catch blocks (wrapTest wraps test bodies in try blocks)
      if (ts.isTryStatement(stmt)) {
        scanStatements(stmt.tryBlock.statements);
        if (stmt.catchClause) {
          scanStatements(stmt.catchClause.block.statements);
        }
        if (stmt.finallyBlock) {
          scanStatements(stmt.finallyBlock.statements);
        }
      }
    }
  }

  scanStatements(sourceFile.statements);
}

function recordOpenObjectConsumerTypes(
  ctx: CodegenContext,
  checker: ts.TypeChecker,
  decl: ts.VariableDeclaration,
  varName: string,
  recordNameBasedGrowableVar = true,
): void {
  if (!decl.initializer) return;
  const initializerDeclaration = decl.initializer as unknown as ts.Declaration;
  const vt = checker.getTypeAtLocation(decl.name);
  if (
    !(vt.flags & ts.TypeFlags.Any) &&
    (vt.getProperties().length > 0 || vt.symbol?.declarations?.[0] === initializerDeclaration)
  ) {
    ctx.objectHashConsumerTypes.add(vt);
  }
  const it = checker.getTypeAtLocation(decl.initializer);
  if (
    !(it.flags & ts.TypeFlags.Any) &&
    (it.getProperties().length > 0 || it.symbol?.declarations?.[0] === initializerDeclaration)
  ) {
    ctx.objectHashConsumerTypes.add(it);
  }
  // The open-object plan is lane-neutral. `compileObjectLiteralAsExternref`
  // uses the existing host MOP in the host lane and the native `$Object` MOP in
  // standalone; both require the declaration slot to select the same carrier.
  if (recordNameBasedGrowableVar) ctx.growableObjectLiteralVars.add(varName);

  // Fnctor field derivation can run before collectDeclarations reaches the
  // function declaration, so record the inferred return carrier here too.
  let owner: ts.Node | undefined = decl.parent;
  while (owner && !ts.isFunctionDeclaration(owner) && !ts.isSourceFile(owner)) owner = owner.parent;
  if (!owner || !ts.isFunctionDeclaration(owner) || !owner.body) return;
  let returnsVar = false;
  const findReturn = (node: ts.Node): void => {
    if (returnsVar) return;
    if (
      node !== owner &&
      (ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isArrowFunction(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isAccessor(node) ||
        ts.isConstructorDeclaration(node))
    ) {
      return;
    }
    if (ts.isReturnStatement(node) && node.expression && ts.isIdentifier(node.expression)) {
      if (node.expression.text === varName) returnsVar = true;
      return;
    }
    forEachChild(node, findReturn);
  };
  forEachChild(owner.body, findReturn);
  if (!returnsVar) return;
  const sig = checker.getSignatureFromDeclaration(owner);
  if (sig) ctx.objectHashConsumerTypes.add(checker.getReturnTypeOfSignature(sig));
}

function ordinaryToPrimitivePropertyName(property: ts.ObjectLiteralElementLike): string | undefined {
  if (!ts.isPropertyAssignment(property)) return undefined;
  const name = property.name;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return undefined;
}

function isOrdinaryToPrimitiveLiteralCandidate(literal: ts.ObjectLiteralExpression): boolean {
  if (literal.properties.length === 0) return false;
  let hasMethod = false;
  for (const property of literal.properties) {
    const name = ordinaryToPrimitivePropertyName(property);
    if (name === undefined) return false;
    if (name !== "valueOf" && name !== "toString") return false;
    const initializer = (property as ts.PropertyAssignment).initializer;
    if (!ts.isFunctionExpression(initializer) || initializer.name || initializer.parameters.length !== 0) return false;
    hasMethod = true;
  }
  return hasMethod;
}

function isNumericOrdinaryToPrimitiveUse(identifier: ts.Identifier): boolean {
  const parent = identifier.parent;
  if (!parent) return false;
  if (ts.isPrefixUnaryExpression(parent) && parent.operand === identifier) {
    return (
      parent.operator === ts.SyntaxKind.PlusToken ||
      parent.operator === ts.SyntaxKind.MinusToken ||
      parent.operator === ts.SyntaxKind.TildeToken
    );
  }
  if ((ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) && parent.operand === identifier) {
    return parent.operator === ts.SyntaxKind.PlusPlusToken || parent.operator === ts.SyntaxKind.MinusMinusToken;
  }
  if (!ts.isBinaryExpression(parent) || (parent.left !== identifier && parent.right !== identifier)) return false;
  switch (parent.operatorToken.kind) {
    case ts.SyntaxKind.PlusToken:
    case ts.SyntaxKind.MinusToken:
    case ts.SyntaxKind.AsteriskToken:
    case ts.SyntaxKind.SlashToken:
    case ts.SyntaxKind.PercentToken:
    case ts.SyntaxKind.LessThanLessThanToken:
    case ts.SyntaxKind.GreaterThanGreaterThanToken:
    case ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken:
    case ts.SyntaxKind.AmpersandToken:
    case ts.SyntaxKind.BarToken:
    case ts.SyntaxKind.CaretToken:
    case ts.SyntaxKind.LessThanToken:
    case ts.SyntaxKind.LessThanEqualsToken:
    case ts.SyntaxKind.GreaterThanToken:
    case ts.SyntaxKind.GreaterThanEqualsToken:
    case ts.SyntaxKind.EqualsEqualsToken:
    case ts.SyntaxKind.ExclamationEqualsToken:
      return true;
    default:
      return false;
  }
}

/**
 * #4208 — find one exact ES3/ES5 idiom before local-slot allocation:
 *
 *   var object = { valueOf: function () { ... } };
 *   ... ToNumber(object) ...
 *   var object = { toString: function () { ... } };
 *
 * Every `var` declaration denotes the same function-scoped binding, but the
 * old representation selected a different closed anonymous struct at each
 * initializer. The later guarded store therefore produced null. Keep this
 * bounded to checker-identical bindings, compatible method-only literals, and
 * an observed coercive use, then pin every declaration/literal to the open
 * `$Object` representation used by the canonical OrdinaryToPrimitive runtime.
 */
function collectRepeatedOrdinaryToPrimitiveObjects(
  ctx: CodegenContext,
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
): void {
  const declarationsBySymbol = new Map<ts.Symbol, ts.VariableDeclaration[]>();
  const coerciveSymbols = new Set<ts.Symbol>();
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const list = node.parent;
      const isVar =
        ts.isVariableDeclarationList(list) &&
        (list.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const | ts.NodeFlags.Using | ts.NodeFlags.AwaitUsing)) === 0;
      const symbol = isVar ? checker.getSymbolAtLocation(node.name) : undefined;
      if (symbol) {
        const declarations = declarationsBySymbol.get(symbol) ?? [];
        declarations.push(node);
        declarationsBySymbol.set(symbol, declarations);
      }
    } else if (ts.isIdentifier(node) && isNumericOrdinaryToPrimitiveUse(node)) {
      const symbol = checker.getSymbolAtLocation(node);
      if (symbol) coerciveSymbols.add(symbol);
    }
    forEachChild(node, visit);
  };
  visit(sourceFile);

  for (const [symbol, declarations] of declarationsBySymbol) {
    if (declarations.length < 2 || !coerciveSymbols.has(symbol)) continue;
    if (
      declarations.some(
        (declaration) =>
          !declaration.initializer ||
          !ts.isObjectLiteralExpression(declaration.initializer) ||
          !isOrdinaryToPrimitiveLiteralCandidate(declaration.initializer),
      )
    ) {
      continue;
    }
    for (const declaration of declarations) {
      const literal = declaration.initializer as ts.ObjectLiteralExpression;
      ctx.ordinaryToPrimitiveObjectDeclarations.add(declaration);
      ctx.ordinaryToPrimitiveObjectLiterals.add(literal);
      recordOpenObjectConsumerTypes(ctx, checker, declaration, (declaration.name as ts.Identifier).text);
    }
  }
}

/**
 * (#2837) Detection pre-pass: mark variables initialized by a NON-EMPTY object
 * literal that later receive an OUT-OF-SHAPE property write, so `compileObjectLiteral`
 * (literals.ts) routes them through the recursive externref `$Object` builder
 * instead of a closed struct (whose unknown-field writes lower to `drop`).
 *
 * Two trigger rules (mirroring the issue's WAT-grounded isolation):
 *   - **Direct:**  `V.k = …` where `k` is NOT a property name in `V`'s literal shape.
 *   - **Nested (the acorn trigger):** any assignment whose LHS is a property-access
 *     chain rooted at `V` with depth ≥ 2 (`V.a.b… = …`) — e.g.
 *     `prototypeAccessors.inFunction.get = fn` onto the nested `{configurable:true}`
 *     descriptor. Conservative over-approximation: a depth-≥2 write to an
 *     already-in-shape nested field also marks `V` (it is being deep-mutated;
 *     growable is correct, only marginally slower).
 *
 * Consumer-safety guard (avoids the #1897 closed-struct-consumer regression):
 * a marked var becomes an externref `$Object`, so a consumer that requires the
 * closed-struct representation (a `struct.get` numeric read used in arithmetic, or
 * a pass into a CONCRETE nominal-struct-typed parameter / return / assignment)
 * would null-deref or mis-coerce. When such a consumer is detected, do NOT mark
 * (leave the pre-existing closed-struct lowering — the var keeps working for its
 * struct consumers; it just retains the dropped-write bug, which is acceptable —
 * it is not the acorn blocker). When in doubt, prefer NOT marking.
 *
 * Runs BEFORE collectDeclarations (alongside `collectEmptyObjectWidening`) so the
 * variable's representation decision is made before its type is resolved.
 */
export function collectGrowableObjectLiterals(
  ctx: CodegenContext,
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
): void {
  collectRepeatedOrdinaryToPrimitiveObjects(ctx, checker, sourceFile);
  // Emergency rollback for the closed-outer-table refinement below. Keeping
  // this narrow switch makes the performance claim directly A/B measurable:
  // `0` restores the old "every depth-2 write opens the root" policy.
  const keepClosedOuterForDeclaredNestedWrites = process.env.JS2WASM_KEEP_CLOSED_NESTED_TABLES !== "0";
  const nestedWriteTargetsDeclaredField = createDeclaredNestedWriteClassifier(ctx, sourceFile);
  // (#4206) Names a direct `eval(<literal>)` in this module could mutate.
  const evalMutableNames = collectEvalMutableNames(sourceFile);

  // Does a contextual type at a use site REQUIRE the closed-struct representation?
  // True only for a CONCRETE nominal struct (named own properties, not any/unknown/
  // `object`, not a pure string-index dictionary). any/object/index-sig consumers
  // (e.g. `Object.defineProperties`' PropertyDescriptorMap param) are SAFE.
  function typeRequiresStruct(t: ts.Type | undefined): boolean {
    if (!t) return false;
    if (t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.NonPrimitive)) return false;
    if (t.flags & (ts.TypeFlags.StringLike | ts.TypeFlags.NumberLike | ts.TypeFlags.BooleanLike)) return false;
    // A pure string-index dictionary (no named own props) is an open object → safe.
    const props = t.getProperties();
    const hasStringIndex = !!checker.getIndexInfoOfType(t, ts.IndexKind.String);
    if (props.length === 0 && hasStringIndex) return false;
    if (props.length === 0) return false; // empty/object-ish → safe
    return true; // concrete shape with named props → struct consumer
  }

  function scanStatements(stmts: readonly ts.Statement[]): void {
    for (const stmt of stmts) {
      if (ts.isVariableStatement(stmt)) {
        for (const decl of stmt.declarationList.declarations) {
          if (!ts.isIdentifier(decl.name)) continue;
          if (!decl.initializer || !ts.isObjectLiteralExpression(decl.initializer)) continue;
          if (decl.initializer.properties.length === 0) continue; // empty handled by widening
          const varName = decl.name.text;
          const shape = literalShapeNames(decl.initializer);
          if (!shape) continue; // not a pure data literal → skip (externref builder would decline)

          // A value nested in an object literal passed to an `any`/`unknown`
          // callable crosses a fully dynamic JavaScript boundary. Keeping the
          // nested value as a closed struct makes its fields invisible after
          // the outer literal is stored in an open object. Deno's bootstrap
          // uses this exact shape when it publishes `infra` through its
          // any-typed captured Object.assign primordial:
          //
          //   ObjectAssign(globalThis, { __infra: infra })
          //
          // Pin the declaration itself to the open-object representation so
          // the published value keeps both identity and reflective fields.
          const isNestedDynamicCallArgument = (id: ts.Identifier): boolean => {
            if (!(ctx.standalone || ctx.wasi) || id.text !== varName) return false;
            const property = id.parent;
            if (
              !(
                (ts.isShorthandPropertyAssignment(property) && property.name === id) ||
                (ts.isPropertyAssignment(property) && property.initializer === id)
              )
            ) {
              return false;
            }
            const literal = property.parent;
            if (!ts.isObjectLiteralExpression(literal)) return false;
            const call = literal.parent;
            if (!ts.isCallExpression(call) || !call.arguments.includes(literal)) return false;
            const calleeType = checker.getTypeAtLocation(call.expression);
            return (calleeType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0;
          };

          // (#671 W1) A direct bare-identifier DeleteBinding in `with (varName)`
          // makes the legacy static scope fall through to runtime HasBinding /
          // DeleteBinding. That runtime path and a later `varName.p` read must
          // see one MOP-capable object identity in BOTH lanes. The IR planner
          // supplies the language trigger; this allocator adds the binding- and
          // ABI-safety proof before ANY struct type/allocation can be created.
          //
          // Deliberately refuse rather than insert a cast or follow an alias:
          // an escaped concrete-struct consumer would otherwise observe a
          // second representation or null. The measured test262 family uses
          // only direct dot reads and is admitted here; every broader shape is
          // left on its existing path for a later slice to model explicitly.
          if (
            bindingHasIrPlannedOpenWithTarget(stmts, checker, decl.name) &&
            bindingUsesOnlyIrPlannedOpenObjectOperations(
              checker,
              stmts,
              decl.name,
              isOpenObjectPropertyReceiver,
              isObjectMopCallArg,
            )
          ) {
            // W1 routes member operations through its declaration-keyed set.
            // Do not also populate the legacy bare-name growable/accessor sets:
            // that would change an unrelated same-named binding in another
            // scope and can break its concrete-struct ABI consumers.
            recordOpenObjectConsumerTypes(ctx, checker, decl, varName, false);
            ctx.irWithOpenObjectTargetKeys.add(widenedVarKeyFromDecl(decl.name));
            continue;
          }

          // (#2992 S6, standalone) `delete varName.k` / `delete varName[e]` or
          // an ACCESSOR-descriptor define on a NON-EMPTY pure-data literal var:
          // the closed-struct representation cannot observe the deletion (the
          // delete arm writes a type-shaped SENTINEL — NaN/null — into the
          // fixed slot, so `o.k !== undefined` / `"k" in o` / hasOwnProperty /
          // typeof / for-in all lie) nor accessor-ness (a struct field stores a
          // plain value; reads never invoke the getter). This is the same
          // defect slices 4/5 fixed for the empty-`{}`-widening shape — here
          // the receiver is a non-empty literal, so instead of suppressing a
          // widening we (a) route the literal to the recursive externref
          // `$Object` builder (`growableObjectLiteralVars`) and (b) refuse
          // struct resolution for the var's checker type
          // (`objectHashConsumerTypes`, the #2944 escape discipline) so the
          // local/receiver/return positions stay externref and EVERY consumer
          // (delete, bracket, `in`, for-in, dot reads, defines) rides the
          // dynamic `$Object` arms slices 1/3/4/5 proved correct. The #2837
          // consumer-poison below (delete/bracket/for-in → "leave on the
          // struct path") is a HOST-lane discipline — in standalone the struct
          // path is precisely what cannot serve these consumers, so this arm
          // runs first. Host lane is untouched (byte-inert).
          // The #671 W1 `with` target has its own lane-neutral planner above.
          // Keep this standalone-only block for its existing direct receiver
          // delete/accessor paths; it must not re-admit a W1 target whose alias
          // or ABI proof declined the open-object promotion.
          if (ctx.standalone) {
            const mopSet = new Set<string>();
            for (const s of stmts) {
              markStandaloneDeleteTargets(s, varName, mopSet);
              markStandaloneAccessorDefineTargets(s, varName, mopSet);
              markStandaloneOutOfShapeDataDefineTargets(s, varName, shape, mopSet); // #4524
              // (#4491) `m.foo++` on a field the literal typed non-numerically —
              // or on no field at all — cannot land in the closed struct.
              markStandaloneNumericUpdateKindChangeTargets(s, varName, decl.initializer, mopSet);
            }
            // (#4491) `for…in` over a literal that out-of-shape writes GREW:
            // the closed struct has no slots for the added keys, so the
            // enumeration is a reason to OPEN the object, not to leave it shut.
            markStandaloneEnumeratedGrowthTargets(stmts, varName, shape, mopSet);
            if (evalMutableNames.has(varName)) mopSet.add(varName); // (#4206)
            // Consumer-safety (#1897/#2837): when the var ALSO flows into a
            // CONCRETE nominal-struct-typed position (call/new arg, return,
            // assignment), the externref `$Object` rep would fail that
            // consumer's cast. Leave such vars on the struct path (their
            // delete/accessor gap stays — documented residual), same
            // when-in-doubt-don't-mark discipline as the growable pre-pass.
            if (mopSet.has(varName)) {
              let structConsumer = false;
              const guardVisit = (node: ts.Node): void => {
                if (
                  ts.isIdentifier(node) &&
                  node.text === varName &&
                  isValueUseOfIdentifier(node) &&
                  // An `Object.<mop>(varName, …)` argument is NOT a struct
                  // consumer — TS's generic `defineProperty<T>(o: T, …)` binds
                  // T to the literal type, so the contextual type LOOKS
                  // concrete, but the MOP call is exactly what the `$Object`
                  // rep serves. Only genuine user-typed positions count.
                  !isObjectMopCallArg(node) &&
                  !isBorrowedMethodThisArg(node) && // #4524 — borrowed `thisArg: any`
                  typeRequiresStruct(checker.getContextualType(node))
                ) {
                  structConsumer = true;
                }
                forEachChild(node, guardVisit);
              };
              for (const s of stmts) guardVisit(s);
              if (structConsumer) mopSet.delete(varName);
            }
            if (mopSet.has(varName)) {
              ctx.growableObjectLiteralVars.add(varName);
              // Type-refusal with the #2944 provenance guard: only poison a
              // checker type whose provenance is THIS var's own initializer
              // literal (fresh per-literal instance). An annotation type is a
              // shared/interned instance — poisoning it would demote unrelated
              // vars.
              const vt = checker.getTypeAtLocation(decl.name);
              if (!(vt.flags & ts.TypeFlags.Any) && vt.symbol?.declarations?.[0] === decl.initializer) {
                ctx.objectHashConsumerTypes.add(vt);
              }
              const it = checker.getTypeAtLocation(decl.initializer);
              if (!(it.flags & ts.TypeFlags.Any) && it.symbol?.declarations?.[0] === decl.initializer) {
                ctx.objectHashConsumerTypes.add(it);
              }
              continue;
            }
          }

          let grows = false;
          let poisoned = false;

          const visit = (node: ts.Node): void => {
            if (ts.isIdentifier(node) && isNestedDynamicCallArgument(node)) {
              grows = true;
            }
            // Out-of-shape write rooted at varName.
            if (
              ts.isBinaryExpression(node) &&
              node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
              ts.isPropertyAccessExpression(node.left)
            ) {
              const info = propertyChainRoot(node.left);
              if (info && info.root === varName) {
                if (info.depth >= 2) {
                  // A deep write does not necessarily grow the ROOT object.
                  // Acorn's token table is the important generic shape:
                  //
                  //   var types = { parenR: new TokenType("]"), ... };
                  //   types.parenR.updateContext = fn;
                  //
                  // `updateContext` is a declared TokenType field, so only the
                  // nested instance mutates. Opening `types` itself turns every
                  // fixed-key token read into a 17KB `__extern_get` ladder.
                  //
                  // Keep the conservative open-object route when the final
                  // field is absent from the nested literal/fnctor declaration.
                  // That is still Acorn's descriptor-table case:
                  //
                  //   var descriptors = { inFunction: { configurable: true } };
                  //   descriptors.inFunction.get = fn; // `get` is new
                  //
                  // The rollback switch preserves an exact old-policy A/B.
                  const targetsDeclaredNestedField =
                    keepClosedOuterForDeclaredNestedWrites &&
                    nestedWriteTargetsDeclaredField(decl.initializer as ts.ObjectLiteralExpression, node.left, varName);
                  if (!targetsDeclaredNestedField) {
                    grows = true;
                  }
                } else if (info.depth === 1 && !shape.has(node.left.name.text)) {
                  grows = true; // direct out-of-shape field add
                }
              }
            }
            // Consumer-safety: a numeric/arithmetic read of a field off varName needs
            // the struct `struct.get` f64 contract (#1897) → poison.
            if (
              ts.isBinaryExpression(node) &&
              isArithmeticOperator(node.operatorToken.kind) &&
              (isFieldReadOf(node.left, varName) || isFieldReadOf(node.right, varName))
            ) {
              poisoned = true;
            }
            if (
              ts.isPrefixUnaryExpression(node) &&
              (node.operator === ts.SyntaxKind.MinusToken || node.operator === ts.SyntaxKind.PlusToken) &&
              isFieldReadOf(node.operand, varName)
            ) {
              poisoned = true;
            }
            // Consumer-safety: varName flows into a CONCRETE-struct-typed position
            // (call/new argument, return, or assignment target) → poison.
            //
            // (#739 S2) EXCEPT an `Object.<mop>(…)` argument — the same carve-out
            // the #2992 S6 standalone guard already applies via `isObjectMopCallArg`,
            // now applied here so the two arms agree. TS types the 3rd argument of
            // `Object.defineProperty` as `PropertyDescriptor`, which HAS named own
            // props (`value`/`writable`/`get`/`set`/…), so `typeRequiresStruct`
            // called it a struct consumer and poisoned every descriptor object —
            // the exact vars this pass needs to route to `$Object`. A MOP call is
            // not a struct consumer: it is precisely what the `$Object` rep serves
            // (native [[Get]] per descriptor field, §6.2.5.5). Note the *map* form
            // (`defineProperties`' `PropertyDescriptorMap`) was already safe — it is
            // a pure string-index dictionary, so `typeRequiresStruct` returns false
            // — which is why acorn's `prototypeAccessors` stayed marked; only the
            // singular `PropertyDescriptor` shape was affected.
            if (
              ts.isIdentifier(node) &&
              node.text === varName &&
              isValueUseOfIdentifier(node) &&
              !isObjectMopCallArg(node) &&
              !isNestedDynamicCallArgument(node)
            ) {
              if (typeRequiresStruct(checker.getContextualType(node))) {
                poisoned = true;
              }
            }
            // (#2837 regression fix) Consumer-safety: `delete V.k`, element/bracket
            // access `V[expr]`, and `for (k in V)` lower against V's STATIC struct
            // type (`ref.cast` to the inferred struct + `struct.set`/enumerate).
            // Routing V to externref `$Object` would make those casts `illegal cast`
            // (the consumers don't consult `externrefAccessorVars`). Such objects are
            // ALREADY handled correctly by the existing dynamic-consumer machinery
            // (they passed pre-fix), so do NOT mark them growable — leave them on the
            // struct path, byte-identical. acorn's `prototypeAccessors` has none of
            // these (consumed only by `Object.defineProperties`), so it stays marked.
            if (
              ts.isDeleteExpression(node) &&
              ts.isPropertyAccessExpression(node.expression) &&
              ts.isIdentifier(node.expression.expression) &&
              node.expression.expression.text === varName
            ) {
              poisoned = true;
            }
            if (
              ts.isElementAccessExpression(node) &&
              ts.isIdentifier(node.expression) &&
              node.expression.text === varName
            ) {
              poisoned = true;
            }
            if (ts.isForInStatement(node) && ts.isIdentifier(node.expression) && node.expression.text === varName) {
              poisoned = true;
            }
            // (#739 S2 — HOST-lane descriptor-object pinning) The S1 pin lives in
            // `collectEmptyObjectWidening`, which only reaches vars initialized
            // with an EMPTY `{}` literal. A NON-EMPTY pure-data literal that later
            // receives a RUNTIME-STORE-routed define (accessor descriptor, dynamic
            // key, no-`value` / explicit-`undefined` field) has the IDENTICAL
            // two-store defect — and it bites hardest when the var is itself used
            // as a DESCRIPTOR: the accessor lands in the `_wasmPropDescs` sidecar
            // while ToPropertyDescriptor's struct-field reader reads the closed
            // struct, so the getter never fires even though §6.2.5.5 requires a
            // full [[Get]] per descriptor field.
            //
            // Measured A/B on HEAD — the ONLY varying axis is the initializer:
            //   `const d = {};           d.value = 1; …{get}` → getter FIRES  ✓
            //   `const d = { value: 1 };              …{get}` → getter SILENT ✗
            //
            // Marking `grows` (rather than adding a separate pre-arm like the
            // standalone `markStandaloneAccessorDefineTargets` block above) is
            // deliberate: it routes the var to the recursive externref `$Object`
            // builder while keeping EVERY existing #1897/#2837 consumer-safety
            // poison in force (arithmetic field reads, concrete-struct-typed
            // positions, `delete V.k`, `V[expr]`, `for…in V`). Those consumers
            // lower against the STATIC struct type, so when one is present we
            // leave the var on the struct path — same when-in-doubt-don't-mark
            // discipline as the rest of this pass. Host-gated; standalone has its
            // own arm above and stays byte-identical.
            if (
              !ctx.standalone &&
              ts.isCallExpression(node) &&
              ts.isPropertyAccessExpression(node.expression) &&
              ts.isIdentifier(node.expression.expression) &&
              node.expression.expression.text === "Object" &&
              ts.isIdentifier(node.expression.name)
            ) {
              const method = node.expression.name.text;
              const recv = node.arguments[0];
              if (recv && ts.isIdentifier(recv) && recv.text === varName) {
                if (
                  method === "defineProperty" &&
                  node.arguments.length >= 3 &&
                  definePropertyRoutesToRuntimeStore(node.arguments[1]!, node.arguments[2]!)
                ) {
                  grows = true;
                } else if (method === "defineProperties" && node.arguments.length >= 2) {
                  // Every `defineProperties` shape lands in the runtime store
                  // (see `markRuntimeStoreDefineTargets`).
                  grows = true;
                }
              }
            }
            forEachChild(node, visit);
          };
          for (const s of stmts) visit(s);
          if (grows && !poisoned) {
            ctx.growableObjectLiteralVars.add(varName);
          }
        }
      }
      if (ts.isFunctionDeclaration(stmt) && stmt.body) {
        scanStatements(stmt.body.statements);
      } else {
        // Bootstrap sources commonly keep all realm state inside an IIFE.
        // Apply the same object-carrier analysis inside function/arrow
        // expressions; otherwise their declarations never reach this pass.
        const scanNestedFunctionExpressions = (node: ts.Node): void => {
          if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && ts.isBlock(node.body)) {
            scanStatements(node.body.statements);
            return;
          }
          forEachChild(node, scanNestedFunctionExpressions);
        };
        forEachChild(stmt, scanNestedFunctionExpressions);
      }
      if (ts.isTryStatement(stmt)) {
        scanStatements(stmt.tryBlock.statements);
        if (stmt.catchClause) scanStatements(stmt.catchClause.block.statements);
        if (stmt.finallyBlock) scanStatements(stmt.finallyBlock.statements);
      }
    }
  }

  scanStatements(sourceFile.statements);
}

/** (#2837) `V.field` (depth-1 property read) where the chain root is `varName`. */
function isFieldReadOf(expr: ts.Expression, varName: string): boolean {
  if (!ts.isPropertyAccessExpression(expr)) return false;
  return ts.isIdentifier(expr.expression) && expr.expression.text === varName;
}

/** (#2837) Arithmetic binary operators whose operands need the f64 struct contract. */
function isArithmeticOperator(kind: ts.SyntaxKind): boolean {
  return (
    kind === ts.SyntaxKind.MinusToken ||
    kind === ts.SyntaxKind.AsteriskToken ||
    kind === ts.SyntaxKind.SlashToken ||
    kind === ts.SyntaxKind.PercentToken ||
    kind === ts.SyntaxKind.AsteriskAsteriskToken
  );
}

/** (#2992 S6) Is this identifier an argument of an `Object.<method>(...)`
 * call (defineProperty / defineProperties / keys / gOPD / ...)? Those MOP
 * receivers must not count as struct consumers in the S6 guard. */
function isObjectMopCallArg(id: ts.Identifier): boolean {
  const p = id.parent;
  if (!ts.isCallExpression(p) || !p.arguments.includes(id)) return false;
  const callee = p.expression;
  return (
    ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === "Object"
  );
}

/**
 * (#4524) Is `id` the `thisArg` of a BORROWED method call —
 * `X.prototype.m.call(id, …)` / `.apply(id, …)`?
 *
 * Such a position is NEVER a concrete-struct consumer: `Function.prototype.call`
 * declares `thisArg: any`, so no cast against a nominal struct can be required
 * there. Without this, the consumer-safety guard read
 * `Object.prototype.hasOwnProperty.call(o, "a")` as a struct consumer and
 * UN-POISONED `o`, silently reverting it to a closed struct — which put back
 * the very defect the poison exists to fix.
 *
 * Measured: with the out-of-shape data-define poison in place,
 *
 *     var o = { a: 1 };
 *     Object.defineProperty(o, "b", { value: 42, … });
 *     var unused = Object.prototype.hasOwnProperty.call(o, "a");  // ← this line
 *     o.b   // 42 without the line, undefined WITH it
 *
 * The un-poisoning was action at a distance: a call elsewhere in the module
 * changed the representation of an object it only reads. `isObjectMopCallArg`
 * did not catch it because it matches only the direct `Object.<mop>(o, …)`
 * form, and the borrowed idiom's callee is `Object.prototype.hasOwnProperty
 * .call` — a property access whose base is another property access, not the
 * `Object` identifier.
 *
 * Keyed on the `.call`/`.apply` shape rather than on a builtin allow-list,
 * because the `thisArg: any` argument is what makes the position safe and that
 * is true of every borrowed method, not just `Object.prototype`'s.
 */
function isBorrowedMethodThisArg(id: ts.Identifier): boolean {
  const call = id.parent;
  if (!ts.isCallExpression(call) || call.arguments[0] !== id) return false;
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee)) return false;
  if (callee.name.text !== "call" && callee.name.text !== "apply") return false;
  // `<something>.prototype.<m>` as the borrowed function — anything else (a
  // plain `f.call(o)` on a user function) keeps its existing classification,
  // since a user function's first parameter CAN be struct-typed.
  const borrowed = callee.expression;
  return (
    ts.isPropertyAccessExpression(borrowed) &&
    ts.isPropertyAccessExpression(borrowed.expression) &&
    borrowed.expression.name.text === "prototype"
  );
}

/** A direct dot read/write/delete is served by the existing externref MOP. */
function isOpenObjectPropertyReceiver(id: ts.Identifier): boolean {
  let current: ts.Expression = id;
  while (
    ts.isParenthesizedExpression(current.parent) ||
    ts.isAsExpression(current.parent) ||
    ts.isNonNullExpression(current.parent) ||
    ts.isSatisfiesExpression(current.parent) ||
    ts.isTypeAssertionExpression(current.parent)
  ) {
    current = current.parent as ts.Expression;
  }
  return ts.isPropertyAccessExpression(current.parent) && current.parent.expression === current;
}

/** (#2837) The identifier is used as a value (arg / return / RHS), not as an
 * assignment target or the base of its own property-write. */
function isValueUseOfIdentifier(id: ts.Identifier): boolean {
  const p = id.parent;
  if (ts.isCallExpression(p) || ts.isNewExpression(p)) {
    return (p.arguments?.indexOf(id) ?? -1) >= 0;
  }
  if (ts.isReturnStatement(p)) return true;
  if (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.EqualsToken && p.right === id) {
    return true;
  }
  return false;
}

/**
 * (#2584) Recursively walk `node` and poison `varName` in `poisonSet` if it
 * appears as the subject of any `$Object`-hash-only operation — i.e. an access
 * form that, in standalone, reads or enumerates the native `$Object` open hash
 * rather than a widened WasmGC struct field:
 *
 *   - `varName[<expr>]` — ElementAccessExpression with the var as receiver
 *     (covers both `o["a"]` read and `o[k]` write).
 *   - `<key> in varName` — `in` BinaryExpression with the var on the right.
 *   - `Object.keys/values/entries/getOwnPropertyDescriptor/getOwnPropertyNames(varName)`
 *     and `Object.assign(varName, …)` / `Object.assign(…, varName)` — the var as
 *     any relevant argument.
 *   - `for (… in varName)` — ForInStatement enumerating the var.
 *
 * A single match is enough; the receiver then stays a `$Object` so every access
 * form (including the dot-writes) targets the same representation. Name-based,
 * matching the existing widening pre-pass (aliasing is a shared, documented
 * limitation — see the issue's `## Deferred`).
 */
/**
 * (#2992 S4, standalone-only caller) Poison `varName` when it is the receiver
 * of any `delete varName.prop` / `delete varName[<expr>]` in the scanned
 * statements. A widened closed struct cannot drop a field, so the delete arm's
 * sentinel write (NaN / null) lies to every later read (`o.k === undefined`
 * const-folds false on an f64 field). Keeping the var a `$Object` routes the
 * delete through the `__delete_property` tombstone machinery, which slice 1
 * (#2872) already proved correct in every lane. Parenthesized targets
 * (`delete (o.k)`) are unwrapped like the module-init collector does.
 */
/**
 * (#4491) Compound/update operators whose result is ALWAYS a Number, whatever the
 * current value is (§13.4 UpdateExpression, §13.15.3 with a numeric operator).
 * `+=` is deliberately ABSENT: `"a" += x` stays a String, so it does not change
 * a string field's kind.
 */
function isAlwaysNumericCompoundOperator(kind: ts.SyntaxKind): boolean {
  return (
    kind === ts.SyntaxKind.MinusEqualsToken ||
    kind === ts.SyntaxKind.AsteriskEqualsToken ||
    kind === ts.SyntaxKind.SlashEqualsToken ||
    kind === ts.SyntaxKind.PercentEqualsToken ||
    kind === ts.SyntaxKind.AsteriskAsteriskEqualsToken
  );
}

/**
 * (#4491) Does an ALWAYS-numeric update of `propName` disagree with the kind the
 * object literal's own initializer pins into the closed struct slot?
 *
 * Returns true only when we can PROVE the disagreement from the literal's own
 * syntax — the field is absent (the update must CREATE it), or its initializer is
 * a syntactically non-numeric primitive/aggregate. Anything we cannot read off the
 * initializer (a call, an identifier, a numeric literal) answers false and stays
 * on the closed-struct path: the same when-in-doubt-don't-mark discipline the rest
 * of this pass uses.
 */
function numericUpdateChangesLiteralFieldKind(literal: ts.ObjectLiteralExpression, propName: string): boolean {
  for (const property of literal.properties) {
    const name = property.name;
    if (!name || (!ts.isIdentifier(name) && !ts.isStringLiteral(name) && !ts.isNumericLiteral(name))) continue;
    if (name.text !== propName) continue;
    if (!ts.isPropertyAssignment(property)) return false; // shorthand/method — unknown kind
    let initializer: ts.Expression = property.initializer;
    while (ts.isParenthesizedExpression(initializer)) initializer = initializer.expression;
    return (
      ts.isStringLiteral(initializer) ||
      ts.isNoSubstitutionTemplateLiteral(initializer) ||
      ts.isTemplateExpression(initializer) ||
      initializer.kind === ts.SyntaxKind.TrueKeyword ||
      initializer.kind === ts.SyntaxKind.FalseKeyword ||
      initializer.kind === ts.SyntaxKind.NullKeyword ||
      ts.isObjectLiteralExpression(initializer) ||
      ts.isArrayLiteralExpression(initializer) ||
      ts.isFunctionExpression(initializer) ||
      ts.isArrowFunction(initializer)
    );
  }
  return true; // absent from the literal — the update has to CREATE the property
}

/**
 * (#4491, standalone-only caller) Poison `varName` when an ALWAYS-numeric member
 * UPDATE (`V.k++`, `--V.k`, `V.k -= n`, …) targets a field whose closed-struct slot
 * cannot hold the numeric result.
 *
 * Two shapes, one defect — the slot's storage type is pinned by the literal:
 *
 * | source                                   | closed struct  | observed        | spec |
 * | ---------------------------------------- | -------------- | --------------- | ---- |
 * | `var m = {foo:"bar"}; m.foo++`           | `foo: stringref` | `m.foo` is null | NaN  |
 * | `var m = {a:1};       m.foo++`           | no `foo` slot  | write DROPPED   | NaN, `"foo" in m` |
 *
 * The first stores a boxed NaN through a string-typed slot (later reads null-deref
 * in `__str_concat`); the second takes `unary-updates.ts`'s unknown-field arm,
 * which emits `f64.const NaN` and drops the write entirely, so the property is
 * never created. Routing the var to the open `$Object` builder puts BOTH on the
 * `__extern_get`/`__extern_set` read-modify-write, which stores a boxed number
 * under a fresh key. Mirrors the #4250 write-kind-disagreement pattern.
 */
function markStandaloneNumericUpdateKindChangeTargets(
  node: ts.Node,
  varName: string,
  literal: ts.ObjectLiteralExpression,
  poisonSet: Set<string>,
): void {
  const considerTarget = (target: ts.Expression): void => {
    let expression: ts.Expression = target;
    while (ts.isParenthesizedExpression(expression)) expression = expression.expression;
    if (!ts.isPropertyAccessExpression(expression)) return;
    if (!ts.isIdentifier(expression.expression) || expression.expression.text !== varName) return;
    if (ts.isPrivateIdentifier(expression.name)) return;
    if (numericUpdateChangesLiteralFieldKind(literal, expression.name.text)) poisonSet.add(varName);
  };
  const visit = (n: ts.Node): void => {
    if (ts.isPostfixUnaryExpression(n)) {
      considerTarget(n.operand);
    } else if (
      ts.isPrefixUnaryExpression(n) &&
      (n.operator === ts.SyntaxKind.PlusPlusToken || n.operator === ts.SyntaxKind.MinusMinusToken)
    ) {
      considerTarget(n.operand);
    } else if (ts.isBinaryExpression(n) && isAlwaysNumericCompoundOperator(n.operatorToken.kind)) {
      considerTarget(n.left);
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
}

/**
 * (#4491, standalone-only caller) Poison `varName` when a NON-EMPTY literal is
 * both GROWN by an out-of-shape write and ENUMERATED by `for…in`.
 *
 *     var o = { bar: true };
 *     o.some = 1; o.foo = "a";
 *     for (var k in o) count++;      // observed 1, spec 3
 *
 * The #2837 growable pre-pass already recognises the growth, but its
 * consumer-safety poison for `for…in` then cancels the marking — and that
 * poison is a HOST-lane statement ("for…in lowers against V's STATIC struct
 * type, so an externref `$Object` would fail the cast"). In standalone the
 * relation inverts, exactly as #2992 S6 argued for `delete`: the closed struct
 * is precisely what cannot serve the consumer, because the added keys have no
 * slots to enumerate. So the enumeration is a REASON to open the object here,
 * not a reason to leave it closed.
 *
 * The one #2837 poison that still has force in standalone is kept by hand: an
 * ARITHMETIC read of a field off `V` wants the `struct.get` f64 contract
 * (#1897), so a var with one declines and keeps its closed struct — with the
 * enumeration gap intact, which is the documented trade.
 */
function markStandaloneEnumeratedGrowthTargets(
  stmts: readonly ts.Statement[],
  varName: string,
  shape: ReadonlySet<string>,
  poisonSet: Set<string>,
): void {
  let enumerated = false;
  let grown = false;
  let arithmeticFieldRead = false;
  const visit = (n: ts.Node): void => {
    if (ts.isForInStatement(n) && ts.isIdentifier(n.expression) && n.expression.text === varName) {
      enumerated = true;
    }
    if (
      ts.isBinaryExpression(n) &&
      n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(n.left) &&
      ts.isIdentifier(n.left.expression) &&
      n.left.expression.text === varName &&
      !ts.isPrivateIdentifier(n.left.name) &&
      !shape.has(n.left.name.text)
    ) {
      grown = true;
    }
    if (
      ts.isBinaryExpression(n) &&
      isArithmeticOperator(n.operatorToken.kind) &&
      (isFieldReadOf(n.left, varName) || isFieldReadOf(n.right, varName))
    ) {
      arithmeticFieldRead = true;
    }
    ts.forEachChild(n, visit);
  };
  // The three signals routinely sit in DIFFERENT statements (the literal, the
  // writes, the loop), so the scan is over the whole statement list at once —
  // a per-statement call would never see them together.
  for (const s of stmts) visit(s);
  if (enumerated && grown && !arithmeticFieldRead) poisonSet.add(varName);
}

function markStandaloneDeleteTargets(node: ts.Node, varName: string, poisonSet: Set<string>): void {
  const visit = (n: ts.Node): void => {
    if (ts.isDeleteExpression(n)) {
      let target: ts.Expression = n.expression;
      while (ts.isParenthesizedExpression(target)) target = target.expression;
      if (
        (ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target)) &&
        ts.isIdentifier(target.expression) &&
        target.expression.text === varName
      ) {
        poisonSet.add(varName);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
}

/**
 * (#2992 S5, standalone-only caller) Poison `varName` when it is the receiver
 * of an accessor-descriptor `Object.defineProperty(varName, k, {get/set…})` or
 * of an `Object.defineProperties(varName, {…})` whose any member descriptor
 * literal carries a `get`/`set` key. A widened closed-struct field cannot hold
 * an accessor (reads never invoke the getter; gOPD cannot see accessor-ness),
 * so the receiver must stay a `$Object` for the #2893 accessor machinery.
 *
 * A PRESENT `get`/`set` key counts even when its value is `undefined` — the
 * §10.1.6.3 semantics (and gOPD `hasOwnProperty("get")`) must still observe an
 * accessor property, which the slice-3 explicit-undefined-half routing handles
 * on the `$Object` path.
 */
function markStandaloneAccessorDefineTargets(node: ts.Node, varName: string, poisonSet: Set<string>): void {
  const visit = (n: ts.Node): void => {
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      ts.isIdentifier(n.expression.expression) &&
      n.expression.expression.text === "Object" &&
      ts.isIdentifier(n.expression.name)
    ) {
      const method = n.expression.name.text;
      const recv = n.arguments[0];
      if (recv && ts.isIdentifier(recv) && recv.text === varName) {
        if (method === "defineProperty" && n.arguments.length >= 3) {
          if (descriptorHasAccessorKey(n.arguments[2]!)) poisonSet.add(varName);
        } else if (method === "defineProperties" && n.arguments.length >= 2) {
          const props = n.arguments[1]!;
          if (ts.isObjectLiteralExpression(props)) {
            for (const p of props.properties) {
              if (ts.isPropertyAssignment(p) && descriptorHasAccessorKey(p.initializer)) {
                poisonSet.add(varName);
                break;
              }
            }
          }
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
}

/** Mutating Object static methods whose receiver must use the identity-bearing
 * open-object store in standalone. Resolve both direct member calls and the
 * exact single-assignment stored-builtin shape used by test262's harnesses. */
function markStandaloneObjectMutationTargets(
  ctx: CodegenContext,
  node: ts.Node,
  varName: string,
  poisonSet: Set<string>,
): void {
  const mutators = new Set(["defineProperty", "defineProperties", "freeze", "seal", "preventExtensions"]);
  const resolveMethod = (callee: ts.Expression): string | undefined => {
    if (
      ts.isPropertyAccessExpression(callee) &&
      ts.isIdentifier(callee.expression) &&
      callee.expression.text === "Object"
    ) {
      return callee.name.text;
    }
    if (!ts.isIdentifier(callee)) return undefined;
    const sym = ctx.checker.getSymbolAtLocation(callee);
    const decl = sym?.valueDeclaration;
    if (!decl || !ts.isVariableDeclaration(decl) || !decl.initializer) return undefined;
    let init: ts.Expression = decl.initializer;
    while (
      ts.isParenthesizedExpression(init) ||
      ts.isAsExpression(init) ||
      ts.isTypeAssertionExpression(init) ||
      ts.isNonNullExpression(init) ||
      ts.isSatisfiesExpression(init)
    ) {
      init = init.expression;
    }
    return ts.isPropertyAccessExpression(init) && ts.isIdentifier(init.expression) && init.expression.text === "Object"
      ? init.name.text
      : undefined;
  };
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && mutators.has(resolveMethod(n.expression) ?? "")) {
      const recv = n.arguments[0];
      if (recv && ts.isIdentifier(recv) && recv.text === varName) poisonSet.add(varName);
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
}

/** (#2992 S5) Does a descriptor object literal carry a `get` or `set` key (any
 * form: property assignment — including `get: undefined` —, method shorthand,
 * or string-named)? Presence of the key is what makes the define an accessor
 * define per §10.1.6.3, independent of the value. */
function descriptorHasAccessorKey(descArg: ts.Expression): boolean {
  if (!ts.isObjectLiteralExpression(descArg)) return false;
  for (const prop of descArg.properties) {
    if (
      (ts.isPropertyAssignment(prop) || ts.isMethodDeclaration(prop)) &&
      prop.name &&
      (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name)) &&
      (prop.name.text === "get" || prop.name.text === "set")
    ) {
      return true;
    }
  }
  return false;
}

/**
 * (#4524) The statically-resolvable property key of a `defineProperty` call, or
 * `undefined` when the key is computed / not a literal. `undefined` is the
 * "cannot prove it is in shape" answer, and callers must treat it as
 * out-of-shape — a key we cannot read is exactly the key that might not have a
 * struct slot.
 *
 * Numeric literals are included: `Object.defineProperty(obj, 0, …)` and
 * `Object.defineProperty(obj, "0", …)` name the same property, and the ES5
 * array-like test corpus writes both.
 */
function staticDefineKey(keyArg: ts.Expression | undefined): string | undefined {
  if (!keyArg) return undefined;
  if (ts.isStringLiteral(keyArg) || ts.isNumericLiteral(keyArg)) return keyArg.text;
  if (ts.isNoSubstitutionTemplateLiteral(keyArg)) return keyArg.text;
  return undefined;
}

/**
 * (#4524, standalone) Poison `varName` when a `Object.defineProperty` /
 * `Object.defineProperties` call installs a **DATA** descriptor at a key that
 * is not already in the literal's own shape.
 *
 * WHY. A closed WasmGC struct has one slot per shape name and no way to grow.
 * An out-of-shape data define therefore has nowhere to write, and the write is
 * **silently dropped** — no trap, no diagnostic, the property simply is not
 * there afterwards. Measured on main before this fix, standalone:
 *
 *     var o = { a: 1 };                                     // closed struct
 *     Object.defineProperty(o, "b", { value: 42, … });
 *     o.b   // undefined  ← the define vanished
 *
 * The sibling cases were already covered and keep working: an ACCESSOR define
 * poisons via {@link markStandaloneAccessorDefineTargets}, and a plain dynamic
 * write (`o.b = 42`) poisons via the #2837 growable pre-pass. The data define
 * was the one hole in that set, and it is the one real test262 code hits — the
 * corpus is plain JavaScript, so its objects are never annotated `any` and
 * always take the closed-struct path.
 *
 * Downstream this is what emptied `Array.prototype.filter.call(obj, cb)` in the
 * ES5 `15.4.4.20-9-b-*` family: those tests install their indices with
 * `Object.defineProperty(obj, "0", …)`, the indices never landed, and the
 * per-index HasProperty check then correctly skipped every one of them.
 *
 * NARROWNESS is deliberate, in two directions:
 *   - An **in-shape** key (`Object.defineProperty(o, "a", {value})` where the
 *     literal already declares `a`) does NOT poison. That slot exists, the
 *     struct path serves it today, and re-representing those objects would
 *     re-open the #1897 consumer-cast regression class for no gain.
 *   - A **non-literal** key poisons, because it cannot be proven in-shape.
 *
 * Descriptor ATTRIBUTE fidelity (writable/enumerable/configurable semantics and
 * redefinition rules) is NOT this function's business — see #4479 / #2668 /
 * #739. This decides only whether the define can land at all.
 */
function markStandaloneOutOfShapeDataDefineTargets(
  node: ts.Node,
  varName: string,
  shapeNames: ReadonlySet<string>,
  poisonSet: Set<string>,
): void {
  const outOfShapeDataDefine = (keyArg: ts.Expression | undefined, descArg: ts.Expression | undefined): boolean => {
    if (!descArg || descriptorHasAccessorKey(descArg)) return false; // accessors: other marker
    const key = staticDefineKey(keyArg);
    return key === undefined || !shapeNames.has(key);
  };

  const visit = (n: ts.Node): void => {
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      ts.isIdentifier(n.expression.expression) &&
      n.expression.expression.text === "Object" &&
      ts.isIdentifier(n.expression.name)
    ) {
      const method = n.expression.name.text;
      const recv = n.arguments[0];
      if (recv && ts.isIdentifier(recv) && recv.text === varName) {
        if (method === "defineProperty" && n.arguments.length >= 3) {
          if (outOfShapeDataDefine(n.arguments[1], n.arguments[2])) poisonSet.add(varName);
        } else if (method === "defineProperties" && n.arguments.length >= 2) {
          const props = n.arguments[1]!;
          if (ts.isObjectLiteralExpression(props)) {
            for (const p of props.properties) {
              // A spread / computed / shorthand entry in the descriptor bag is
              // an unreadable key set — poison, same "cannot prove in-shape"
              // rule as a computed key above.
              if (!ts.isPropertyAssignment(p)) {
                poisonSet.add(varName);
                break;
              }
              const nameNode = p.name;
              const key =
                ts.isIdentifier(nameNode) || ts.isStringLiteral(nameNode) || ts.isNumericLiteral(nameNode)
                  ? nameNode.text
                  : undefined;
              if (!descriptorHasAccessorKey(p.initializer) && (key === undefined || !shapeNames.has(key))) {
                poisonSet.add(varName);
                break;
              }
            }
          } else {
            // Non-literal descriptor bag: its keys are unknowable statically.
            poisonSet.add(varName);
          }
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
}

/**
 * (#739 S1, HOST-lane caller) Poison `varName` when it is the receiver of any
 * `Object.defineProperty` / `Object.defineProperties` call whose application
 * lands in the RUNTIME STORE (native `$Object` open hash or the
 * `_wasmPropDescs`/`_wasmStructProps` sidecar) rather than a widened-struct
 * `struct.set` fast path. Such receivers must stay a `$Object` so define →
 * read → write → delete → for-in → hasOwnProperty → gOPD all target the ONE
 * native store — see the block comment at the call site. This is the host-lane
 * generalization of `markStandaloneAccessorDefineTargets` (which only covers
 * accessor descriptors, standalone-gated); the host lane must additionally pin
 * for dynamic descriptors, explicit-undefined / no-value literals, dynamic
 * keys, and every `defineProperties` shape.
 *
 * Name-based, matching the widening pre-pass (aliasing is a shared documented
 * limitation — see the issue's "Edge cases").
 */
function markRuntimeStoreDefineTargets(node: ts.Node, varName: string, poisonSet: Set<string>): void {
  const visit = (n: ts.Node): void => {
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      ts.isIdentifier(n.expression.expression) &&
      n.expression.expression.text === "Object" &&
      ts.isIdentifier(n.expression.name)
    ) {
      const method = n.expression.name.text;
      const recv = n.arguments[0];
      if (recv && ts.isIdentifier(recv) && recv.text === varName) {
        if (method === "defineProperty" && n.arguments.length >= 3) {
          if (definePropertyRoutesToRuntimeStore(n.arguments[1]!, n.arguments[2]!)) {
            poisonSet.add(varName);
          }
        } else if (method === "defineProperties" && n.arguments.length >= 2) {
          // Every `Object.defineProperties(varName, …)` shape lands in the
          // runtime store: the static per-entry expansion still routes each
          // inner define through the runtime applier, and the dynamic route
          // (`__defineProperties`) is entirely native. A widened struct is
          // unsound for all of them.
          poisonSet.add(varName);
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
}

/**
 * (#739 S1) Does a single `Object.defineProperty(varName, key, desc)` route its
 * APPLICATION to the runtime store (native `$Object` / `_wasmPropDescs`
 * sidecar) rather than the widened-struct `struct.set` fast path? True for
 * every shape EXCEPT a pure data-descriptor object literal (`value` key
 * present, no `get`/`set`, no explicit-`undefined` field) on a string/numeric
 * literal key. Mirrors the routing in `object-ops.ts`: dynamic descriptor
 * (`:1580` → `__defineProperty_desc`), explicit-`undefined` fields (`:1608`),
 * the accessor path (`emitExternDefinePropertyNoValue` → `__defineProperty_accessor`),
 * and the no-`value` path (also `emitExternDefinePropertyNoValue`). The pure
 * data-literal family is deliberately KEPT on the struct fast path + flag
 * side-channel — it already passes (`15.2.3.6-4-*` static rows) and must not be
 * disturbed in S1.
 */
function definePropertyRoutesToRuntimeStore(keyArg: ts.Expression, descArg: ts.Expression): boolean {
  // Dynamic key (not a string/numeric literal) can never be a widened field.
  if (!ts.isStringLiteral(keyArg) && !ts.isNumericLiteral(keyArg)) return true;
  // Non-inline-literal descriptor → runtime `__defineProperty_desc` (:1580).
  if (!ts.isObjectLiteralExpression(descArg)) return true;
  // Accessor descriptor (`get`/`set` key present, any value incl. `undefined`)
  // → runtime accessor path.
  if (descriptorHasAccessorKey(descArg)) return true;
  // Explicit-`undefined` descriptor field (`{ value: undefined }`,
  // `{ writable: undefined }`, …) → runtime path so the presence bit is
  // recorded per ToPropertyDescriptor (:1608, host-only).
  if (descriptorHasExplicitUndefinedField(descArg)) return true;
  // No `value` key → `emitExternDefinePropertyNoValue` → runtime sidecar.
  if (!descriptorHasValueKey(descArg)) return true;
  return false;
}

/** (#739 S1) Recognized descriptor field names, per §6.2.5 ToPropertyDescriptor. */
const S1_DESCRIPTOR_FIELD_NAMES = new Set(["value", "writable", "enumerable", "configurable", "get", "set"]);

/** (#739 S1) Is `expr` `undefined` / `void <x>` (an explicit-undefined field
 * value)? Mirrors `object-ops.ts`'s `isUndefinedLikeExpression`, unwrapping
 * transparent `as` / `!` / parenthesized wrappers. */
function isS1UndefinedLikeExpression(expr: ts.Expression): boolean {
  let inner: ts.Expression = expr;
  while (
    ts.isAsExpression(inner) ||
    ts.isTypeAssertionExpression(inner) ||
    ts.isNonNullExpression(inner) ||
    ts.isParenthesizedExpression(inner) ||
    ts.isSatisfiesExpression(inner)
  ) {
    inner = inner.expression;
  }
  return (
    inner.kind === ts.SyntaxKind.UndefinedKeyword ||
    (ts.isIdentifier(inner) && inner.text === "undefined") ||
    ts.isVoidExpression(inner)
  );
}

/** (#739 S1) Does the descriptor literal carry a recognized field explicitly
 * set to `undefined` (`{ value: undefined }`, `{ configurable: void 0 }`, …)?
 * Mirrors `object-ops.ts`'s `descriptorUndefinedFields(...).length > 0`. */
function descriptorHasExplicitUndefinedField(descArg: ts.ObjectLiteralExpression): boolean {
  for (const prop of descArg.properties) {
    if (!ts.isPropertyAssignment(prop)) continue;
    const name = prop.name;
    if (!ts.isIdentifier(name) && !ts.isStringLiteral(name)) continue;
    if (S1_DESCRIPTOR_FIELD_NAMES.has(name.text) && isS1UndefinedLikeExpression(prop.initializer)) {
      return true;
    }
  }
  return false;
}

/** (#739 S1) Does the descriptor literal have a (non-undefined-guaranteed)
 * `value` key present? A property-assignment or shorthand `value` counts; an
 * explicit-`undefined` `value` is caught earlier by
 * {@link descriptorHasExplicitUndefinedField}. */
function descriptorHasValueKey(descArg: ts.ObjectLiteralExpression): boolean {
  for (const prop of descArg.properties) {
    if (!ts.isPropertyAssignment(prop) && !ts.isShorthandPropertyAssignment(prop)) continue;
    const name = prop.name;
    if ((ts.isIdentifier(name) || ts.isStringLiteral(name)) && name.text === "value") {
      return true;
    }
  }
  return false;
}

function markObjectHashConsumers(node: ts.Node, varName: string, poisonSet: Set<string>): void {
  const isVarRef = (n: ts.Node): boolean => ts.isIdentifier(n) && n.text === varName;

  const OBJECT_HASH_METHODS = new Set([
    "keys",
    "values",
    "entries",
    "getOwnPropertyDescriptor",
    "getOwnPropertyDescriptors",
    "getOwnPropertyNames",
    "assign",
  ]);

  const visit = (n: ts.Node): void => {
    // varName[<expr>]  (bracket read or write)
    if (ts.isElementAccessExpression(n) && isVarRef(n.expression)) {
      poisonSet.add(varName);
    }
    // <key> in varName
    else if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.InKeyword && isVarRef(n.right)) {
      poisonSet.add(varName);
    }
    // Object.<hashMethod>(… varName …)
    else if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      ts.isIdentifier(n.expression.expression) &&
      n.expression.expression.text === "Object" &&
      ts.isIdentifier(n.expression.name) &&
      OBJECT_HASH_METHODS.has(n.expression.name.text) &&
      n.arguments.some((a) => isVarRef(a))
    ) {
      poisonSet.add(varName);
    }
    // for (… in varName)
    else if (ts.isForInStatement(n) && isVarRef(n.expression)) {
      poisonSet.add(varName);
    }
    // (#3366 follow-up) A destructuring member target such as
    // `[obj.value = fallback()] = source` is an open-property write. The
    // extracted value is not bounded by the default initializer's checker
    // type, so widening an empty `{}` receiver to a closed struct can select a
    // colliding anonymous shape and leave the runtime receiver null. Keep this
    // receiver on the same `$Object`/externref representation used by the
    // dynamic member setter and subsequent sidecar read.
    else if (
      ts.isBinaryExpression(n) &&
      n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      (ts.isArrayLiteralExpression(n.left) || ts.isObjectLiteralExpression(n.left))
    ) {
      const visitTarget = (target: ts.Node): void => {
        if (ts.isBinaryExpression(target) && target.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
          visitTarget(target.left);
          return;
        }
        if (
          ts.isPropertyAccessExpression(target) &&
          ts.isIdentifier(target.expression) &&
          target.expression.text === varName
        ) {
          poisonSet.add(varName);
          return;
        }
        ts.forEachChild(target, visitTarget);
      };
      visitTarget(n.left);
    }
    ts.forEachChild(n, visit);
  };

  visit(node);
}

/**
 * (#3268) Extract the `value` type from an `Object.defineProperty` descriptor
 * object literal (defaulting to externref) and record the widened property plus
 * its `${varName}:${propName}` key. Shared by the ExpressionStatement and
 * VariableStatement `Object.defineProperty(...)` branches of
 * {@link collectPropsFromStatements}.
 */
function recordDefinePropertyWiden(
  ctx: CodegenContext,
  checker: ts.TypeChecker,
  // (#3403) the per-declaration key (`name@declStart`), NOT the bare name, so a
  // same-named `{}` var in another function does not share this entry.
  varKey: string,
  propName: string,
  descArg: ts.Expression,
  extraProps: WidenedPropCandidate[],
  seenProps: Set<string>,
): void {
  if (!seenProps.has(propName)) {
    seenProps.add(propName);
    // Try to get value type from descriptor.value
    let wasmType: ValType = { kind: "externref" };
    let primitiveSeed = false;
    if (ts.isObjectLiteralExpression(descArg)) {
      for (const prop of descArg.properties) {
        if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) && prop.name.text === "value") {
          const rhsType = checker.getTypeAtLocation(prop.initializer);
          wasmType = resolveWidenedPropertyType(ctx, rhsType);
          primitiveSeed = isRuntimePrimitiveSeed(wasmType, rhsType);
          break;
        }
      }
    }
    extraProps.push({ name: propName, type: wasmType, primitiveSeed });
    ctx.widenedDefinePropertyKeys.add(`${varKey}:${propName}`);
  }
}

export function collectPropsFromStatements(
  checker: ts.TypeChecker,
  ctx: CodegenContext,
  stmts: readonly ts.Statement[],
  varName: string,
  // (#3403) per-declaration key for `widenedDefinePropertyKeys` (threaded to
  // `recordDefinePropertyWiden`); `varName` stays bare for the `objArg.text ===
  // varName` receiver match below.
  varKey: string,
  extraProps: WidenedPropCandidate[],
  seenProps: Set<string>,
): void {
  for (const s of stmts) {
    // ExpressionStatement: obj.prop = value
    if (ts.isExpressionStatement(s) && ts.isBinaryExpression(s.expression)) {
      const bin = s.expression;
      if (
        bin.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isPropertyAccessExpression(bin.left) &&
        ts.isIdentifier(bin.left.expression) &&
        bin.left.expression.text === varName
      ) {
        const propName = bin.left.name.text;
        // Infer wasm type from the RHS
        const rhsType = checker.getTypeAtLocation(bin.right);
        const wasmType = resolveWidenedPropertyType(ctx, rhsType);
        if (!seenProps.has(propName)) {
          seenProps.add(propName);
          extraProps.push({
            name: propName,
            type: wasmType,
            primitiveSeed: isRuntimePrimitiveSeed(wasmType, rhsType),
          });
        } else {
          // (#3669) A LATER write of a different kind must not be force-coerced
          // into the first write's slot. This pre-pass used to be
          // first-write-wins, so `o.p = 1; o.p = "s"` froze the field to `f64`
          // and every subsequent `struct.set` ran a numeric coercion — a string
          // landed as NaN while `typeof o.p` (folded from the checker's
          // narrowed static type, independent of the slot) still said "string".
          // Widen to the universal carrier only when the slot was seeded by a
          // real unboxed primitive. `resolveWasmType(undefined)` is also i32,
          // but that is a missing-value sentinel rather than a runtime boolean;
          // widening an anticipated `undefined -> null` property changes its
          // empty-object default and can null-deref reads before the first write.
          const existing = extraProps.find((p) => p.name === propName);
          if (existing?.primitiveSeed && !valTypesMatch(existing.type, wasmType)) {
            existing.type = { kind: "externref" };
          }
        }
      }
    }
    // Object.defineProperty(obj, "prop", { value: v }) — treat as obj.prop = v for widening
    if (ts.isExpressionStatement(s) && ts.isCallExpression(s.expression)) {
      const call = s.expression;
      if (
        ts.isPropertyAccessExpression(call.expression) &&
        ts.isIdentifier(call.expression.expression) &&
        call.expression.expression.text === "Object" &&
        ts.isIdentifier(call.expression.name) &&
        call.expression.name.text === "defineProperty" &&
        call.arguments.length >= 3
      ) {
        const objArg = call.arguments[0]!;
        const propArg = call.arguments[1]!;
        const descArg = call.arguments[2]!;
        if (ts.isIdentifier(objArg) && objArg.text === varName && ts.isStringLiteral(propArg)) {
          const propName = propArg.text;
          // (#2372) The struct-widening fast path only works when the
          // descriptor is a statically-resolvable inline object literal: the
          // define lowers to `struct.set` and the read-back to `struct.get` on
          // the SAME widened struct field. A *dynamic* descriptor (a variable /
          // call result) cannot be applied via `struct.set` — standalone routes
          // it to the native `__obj_define_from_desc` helper, which writes the
          // `$Object` open-hash runtime. If we widen the receiver to a struct
          // anyway, the read-back `o.x` lowers to `struct.get` against the
          // struct while the write landed in the `$Object` — different objects,
          // so the read returns 0. Mark this var as define-poisoned so the
          // widening is suppressed for it (below): the receiver then stays on
          // the `$Object` representation and BOTH the dynamic write and the
          // read route through the native runtime consistently. Host mode keeps
          // the struct fast path (the host `__defineProperty_desc` import
          // reflects back through the live-mirror Proxy onto the struct sidecar).
          if (ctx.standalone && !ts.isObjectLiteralExpression(descArg)) {
            ctx.dynamicDescriptorWidenVars.add(varName);
          }
          recordDefinePropertyWiden(ctx, checker, varKey, propName, descArg, extraProps, seenProps);
        }
      }
    }
    // Also handle: const result = Object.defineProperty(obj, ...)
    if (ts.isVariableStatement(s)) {
      for (const decl of s.declarationList.declarations) {
        if (decl.initializer && ts.isCallExpression(decl.initializer)) {
          const call = decl.initializer;
          if (
            ts.isPropertyAccessExpression(call.expression) &&
            ts.isIdentifier(call.expression.expression) &&
            call.expression.expression.text === "Object" &&
            ts.isIdentifier(call.expression.name) &&
            call.expression.name.text === "defineProperty" &&
            call.arguments.length >= 3
          ) {
            const objArg = call.arguments[0]!;
            const propArg = call.arguments[1]!;
            const descArg = call.arguments[2]!;
            if (ts.isIdentifier(objArg) && objArg.text === varName && ts.isStringLiteral(propArg)) {
              const propName = propArg.text;
              recordDefinePropertyWiden(ctx, checker, varKey, propName, descArg, extraProps, seenProps);
            }
          }
        }
      }
    }
    // Recurse into compound statement bodies to find property assignments
    if (ts.isBlock(s)) {
      collectPropsFromStatements(checker, ctx, s.statements, varName, varKey, extraProps, seenProps);
    }
    if (ts.isIfStatement(s)) {
      if (ts.isBlock(s.thenStatement)) {
        collectPropsFromStatements(checker, ctx, s.thenStatement.statements, varName, varKey, extraProps, seenProps);
      }
      if (s.elseStatement && ts.isBlock(s.elseStatement)) {
        collectPropsFromStatements(checker, ctx, s.elseStatement.statements, varName, varKey, extraProps, seenProps);
      }
    }
    // Recurse into try/catch/finally blocks (wrapTest wraps test bodies in try blocks)
    if (ts.isTryStatement(s)) {
      collectPropsFromStatements(checker, ctx, s.tryBlock.statements, varName, varKey, extraProps, seenProps);
      if (s.catchClause) {
        collectPropsFromStatements(
          checker,
          ctx,
          s.catchClause.block.statements,
          varName,
          varKey,
          extraProps,
          seenProps,
        );
      }
      if (s.finallyBlock) {
        collectPropsFromStatements(checker, ctx, s.finallyBlock.statements, varName, varKey, extraProps, seenProps);
      }
    }
    // Recurse into for/while/do-while/switch bodies
    if (
      ts.isForStatement(s) ||
      ts.isForInStatement(s) ||
      ts.isForOfStatement(s) ||
      ts.isWhileStatement(s) ||
      ts.isDoStatement(s)
    ) {
      if (ts.isBlock(s.statement)) {
        collectPropsFromStatements(checker, ctx, s.statement.statements, varName, varKey, extraProps, seenProps);
      }
    }
    if (ts.isSwitchStatement(s)) {
      for (const clause of s.caseBlock.clauses) {
        collectPropsFromStatements(checker, ctx, clause.statements, varName, varKey, extraProps, seenProps);
      }
    }
  }
}

/**
 * Apply shape inference: detect module-level variables used as array-like objects
 * and override their global types from externref/AnyValue to vec struct types.
 * Must be called after collectDeclarations (which registers module globals).
 */
export function applyShapeInference(ctx: CodegenContext, checker: ts.TypeChecker, sourceFile: ts.SourceFile): void {
  const shapes = collectShapes(checker, sourceFile);
  if (shapes.size === 0) return;

  for (const [varName, shape] of shapes) {
    const globalIdx = ctx.moduleGlobals.get(varName);
    if (globalIdx === undefined) continue;

    // Determine element type for the vec struct from the shape's numeric value type
    let elemType: ValType;
    let elemKey: string;
    if (shape.numericValueType === "number") {
      if (ctx.fast) {
        elemType = { kind: "i32" };
        elemKey = "i32";
      } else {
        elemType = { kind: "f64" };
        elemKey = "f64";
      }
    } else if (shape.numericValueType === "string") {
      elemType = { kind: "externref" };
      elemKey = "externref";
    } else {
      // Default to f64 for unknown numeric types
      if (ctx.fast) {
        elemType = { kind: "i32" };
        elemKey = "i32";
      } else {
        elemType = { kind: "f64" };
        elemKey = "f64";
      }
    }

    // Register or reuse the vec struct type
    const vecTypeIdx = getOrRegisterVecType(ctx, elemKey, elemType);
    const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);

    // Override the module global's type to ref_null of the vec struct
    const localIdx = localGlobalIdx(ctx, globalIdx);
    const globalDef = ctx.mod.globals[localIdx];
    if (globalDef) {
      const newType: ValType = { kind: "ref_null", typeIdx: vecTypeIdx };
      globalDef.type = newType;
      // Update initializer to ref.null of the vec type
      globalDef.init = [{ op: "ref.null", typeIdx: vecTypeIdx }];
    }

    // Record in shapeMap for use during compilation
    ctx.shapeMap.set(varName, { vecTypeIdx, arrTypeIdx, elemType });
  }
}
