// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * for-of loop-variable head-binding destructuring subsystem.
 *
 * Extracted verbatim from `loops.ts` (#3269). Covers both the binding form
 * (`for (const [a]/{a} of …)`) and the assignment form (`for ([a]/{a} of …)`),
 * including rest, tuple/vec, externref and boxed-capture writes, plus the
 * iterator-protocol assignment-destructuring path. The cluster is internally
 * recursive but never calls a loop driver and never calls compileStatement —
 * the boundary is one-directional (drivers call in; this never calls out), so
 * there is no import cycle with loops.ts.
 */
import { ts } from "../../ts-api.js";
import type { ValType } from "../../ir/types.js";
import { isStandalonePromiseActive } from "../async-scheduler.js";
import { reportError, reportErrorNoNode } from "../context/errors.js";
import { allocLocal, getLocalType } from "../context/locals.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import {
  emitExternrefDestructureGuard,
  emitNativeObjectRest,
  emitObjectPatternRestFromVec,
  patternIteratorStepCount,
} from "../destructuring-params.js";
import { emitAssignToTarget, isStrictContext } from "../expressions/assignment.js";
import { findUnresolvableInArrayPattern, findUnresolvableInObjectPattern } from "../expressions/unresolvable-assign.js";
import { emitCoercedLocalSet, emitThrowTypeError } from "../expressions/helpers.js";
import { ensureLateImport, flushLateImportShifts, shiftLateImportIndices } from "../expressions/late-imports.js";
import { arrayIteratorOverrideGlobalIdx } from "../expressions/proto-override.js";
import { reportSilentFallback } from "../fallback-telemetry.js";
import { resolveWasmType } from "../index.js";
import { resolveComputedKeyExpression } from "../literals.js";
import { stringConstantExternrefInstrs } from "../native-strings.js";
import { addImport, addStringConstantGlobal, ensureExnTag, localGlobalIdx } from "../registry/imports.js";
import { addFuncType, getArrTypeIdxFromVec } from "../registry/types.js";
import {
  coerceType,
  compileExpression,
  emitBoundsCheckedArrayGet,
  materializeStructAsObject,
  valTypesMatch,
} from "../shared.js";
import {
  arrayDstrNeedsIdentity,
  compileExternrefArrayDestructuringDecl,
  compileExternrefObjectDestructuringDecl,
  emitDefaultValueCheck,
  emitNestedBindingDefault,
  emitNullGuard,
  ensureExternIsUndefined,
  syncDestructuredLocalsToGlobals,
  tryEmitArrayProtoIteratorReadDrive,
} from "./destructuring.js";
import { collectInstrs } from "./shared.js";

/**
 * Emit the "write the destructured local back to its module global" tail —
 * `if (syncGlobalIdx !== undefined) { local.get targetLocal; global.set … }`.
 * Extracted from 10 identical inline copies (#3269 DRY). NOT for the
 * boxed-capture variants that struct.get through the cell first (different shape).
 *
 * (#3024) A module global's declared slot type can differ from the
 * destructured local's type — e.g. an array-rest target `for ([...y] of …)`
 * materializes a `(ref null vec)` local while the untyped module `var y` global
 * is `externref`. The raw `local.get; global.set` then emits invalid Wasm
 * (`global.set expected externref, found local.get of type (ref null N)`).
 * Coerce local→global type before the store, mirroring the binding-form
 * `syncDestructuredLocalsToGlobals` (destructuring.ts). Byte-inert whenever the
 * types already match (the previously-valid shapes); the coercion only fires on
 * shapes that were ALWAYS invalid Wasm before, so no valid module changes.
 */
function emitGlobalSyncWriteback(
  ctx: CodegenContext,
  fctx: FunctionContext,
  targetLocal: number,
  syncGlobalIdx: number | undefined,
): void {
  if (syncGlobalIdx !== undefined) {
    fctx.body.push({ op: "local.get", index: targetLocal });
    const localType = getLocalType(fctx, targetLocal);
    const globalType = ctx.mod.globals[localGlobalIdx(ctx, syncGlobalIdx)]?.type;
    if (localType && globalType && !valTypesMatch(localType, globalType)) {
      coerceType(ctx, fctx, localType, globalType);
    }
    fctx.body.push({ op: "global.set", index: syncGlobalIdx });
  }
}

/**
 * (#4447) Re-resolve a module global's ABSOLUTE index at write time, then emit
 * the sync writeback.
 *
 * A module global's absolute index shifts every time a string-constant IMPORT
 * global is added (`addStringConstantGlobal` → `fixupModuleGlobalIndices`,
 * which re-maps `ctx.moduleGlobals` and every already-emitted `global.get/set`
 * — but obviously not an index a caller stashed in a local variable). Between
 * resolving the target and emitting its writeback these paths now register a
 * property-name constant and/or compile a default initializer, either of which
 * can import a string constant. A stale index then lands in the IMPORT range:
 * "immutable global #N cannot be assigned" (reproduced on
 * `for ({ x: a = 11 } of [{}])` in the JS-host lane).
 *
 * `hadGlobal` preserves the caller's decision that this target IS a module
 * global (a name absent from `ctx.moduleGlobals` must stay unsynced).
 */
function emitGlobalSyncWritebackByName(
  ctx: CodegenContext,
  fctx: FunctionContext,
  targetLocal: number,
  targetName: string,
  hadGlobal: boolean,
): void {
  if (!hadGlobal) return;
  emitGlobalSyncWriteback(ctx, fctx, targetLocal, ctx.moduleGlobals.get(targetName));
}

export function compileForOfDestructuring(
  ctx: CodegenContext,
  fctx: FunctionContext,
  pattern: ts.ObjectBindingPattern | ts.ArrayBindingPattern,
  elemLocal: number,
  elemType: ValType,
  stmt: ts.ForOfStatement,
): void {
  if (ts.isObjectBindingPattern(pattern)) {
    // Resolve the struct type from the element type
    if (elemType.kind !== "ref" && elemType.kind !== "ref_null") {
      if (elemType.kind === "externref") {
        // Externref elements: use __extern_get to extract properties (e.g. iterator protocol)
        fctx.body.push({ op: "local.get", index: elemLocal });
        compileExternrefObjectDestructuringDecl(ctx, fctx, pattern, elemType);
        syncDestructuredLocalsToGlobals(ctx, fctx, pattern);
        return;
      }
      // Primitives (bool, number, string) are object-coercible in JS.
      // Empty binding pattern `for (let {} of [val])` is a no-op — just iterate.
      // Non-empty patterns: properties don't exist on primitives, so use defaults
      // or the appropriate undefined sentinel.
      for (const element of pattern.elements) {
        if (!ts.isBindingElement(element)) continue;
        if (!ts.isIdentifier(element.name)) continue; // skip non-identifier binding names
        const localName = element.name.text;
        const bindingTsType = ctx.checker.getTypeAtLocation(element);
        const bindingType = resolveWasmType(ctx, bindingTsType);
        const localIdx = allocLocal(fctx, localName, bindingType);
        if (element.initializer) {
          const instrs = collectInstrs(fctx, () => {
            compileExpression(ctx, fctx, element.initializer!, bindingType);
            fctx.body.push({ op: "local.set", index: localIdx });
          });
          fctx.body.push(...instrs);
        } else {
          // No default — use "undefined" sentinel matching the local's type
          if (bindingType.kind === "f64") {
            fctx.body.push({ op: "f64.const", value: NaN });
          } else if (bindingType.kind === "i32") {
            fctx.body.push({ op: "i32.const", value: 0 });
          } else if (bindingType.kind === "ref_null" || bindingType.kind === "ref") {
            const refTypeIdx = (bindingType as { typeIdx: number }).typeIdx;
            fctx.body.push({ op: "ref.null", typeIdx: refTypeIdx });
          } else {
            fctx.body.push({ op: "ref.null.extern" });
          }
          fctx.body.push({ op: "local.set", index: localIdx });
        }
      }
      return;
    }

    const structTypeIdx = (elemType as { typeIdx: number }).typeIdx;
    const typeDef = ctx.mod.types[structTypeIdx];
    if (!typeDef || typeDef.kind !== "struct") {
      reportErrorNoNode(ctx, "for-of destructuring: element type is not a struct");
      return;
    }

    // Find the struct fields by looking up the struct name from reverse map
    const structName = ctx.typeIdxToStructName.get(structTypeIdx);
    const fields = structName ? ctx.structFields.get(structName) : undefined;
    if (!fields) {
      reportError(ctx, stmt, "for-of destructuring: cannot find struct fields");
      return;
    }

    // Null guard: collect field extractions for ref_null types
    emitNullGuard(ctx, fctx, elemLocal, elemType.kind === "ref_null", () => {
      for (const element of pattern.elements) {
        if (!ts.isBindingElement(element)) continue;

        // Handle rest element: for (const { a, ...rest } of arr)
        if (element.dotDotDotToken) {
          if (ts.isIdentifier(element.name)) {
            const restName = element.name.text;
            let restIdx = fctx.localMap.get(restName);
            if (restIdx === undefined) {
              restIdx = allocLocal(fctx, restName, { kind: "externref" });
            }
            // Collect excluded keys
            const excludedKeys: string[] = [];
            for (const el of pattern.elements) {
              if (!ts.isBindingElement(el) || el.dotDotDotToken) continue;
              const pn = el.propertyName ?? el.name;
              if (ts.isIdentifier(pn)) excludedKeys.push(pn.text);
              else if (ts.isStringLiteral(pn)) excludedKeys.push(pn.text);
              else if (ts.isNumericLiteral(pn)) excludedKeys.push(pn.text);
            }
            // (#3241/#4397) Native semantic providers route to the Wasm-defined
            // __extern_rest_object (exclusion-object ABI). Compatibility mode
            // retains the historical host helper and its CSV-key ABI below.
            if (ctx.targetProfile.semanticProviders === "native-first") {
              // The loop element is a CLOSED-shape struct; reify it into an open
              // `$Object` (#3222 C1) so `__object_keys` enumeration sees the
              // fields — a bare `extern.convert_any` would yield an EMPTY rest.
              emitNativeObjectRest(
                ctx,
                fctx,
                () => {
                  fctx.body.push({ op: "local.get", index: elemLocal });
                  if (elemType.kind === "ref_null") fctx.body.push({ op: "ref.as_non_null" });
                  if (!materializeStructAsObject(ctx, fctx, structTypeIdx, { skipInternalFields: true })) {
                    // Declined — struct ref still on stack; reinterpret as-is.
                    fctx.body.push({ op: "extern.convert_any" });
                  }
                },
                excludedKeys,
                restIdx,
              );
              continue;
            }
            let restObjIdx = ctx.funcMap.get("__extern_rest_object");
            if (restObjIdx === undefined) {
              const importsBefore = ctx.numImportFuncs;
              const restObjType = addFuncType(
                ctx,
                [{ kind: "externref" }, { kind: "externref" }],
                [{ kind: "externref" }],
              );
              addImport(ctx, "env", "__extern_rest_object", {
                kind: "func",
                typeIdx: restObjType,
              });
              shiftLateImportIndices(ctx, fctx, importsBefore, ctx.numImportFuncs - importsBefore);
              restObjIdx = ctx.funcMap.get("__extern_rest_object");
            }
            if (restObjIdx !== undefined) {
              const excludedStr = excludedKeys.join(",");
              addStringConstantGlobal(ctx, excludedStr);
              const excludedStrIdx = ctx.stringGlobalMap.get(excludedStr);
              if (excludedStrIdx !== undefined) {
                fctx.body.push({ op: "local.get", index: elemLocal });
                fctx.body.push({ op: "extern.convert_any" });
                // (#51) `addStringConstantGlobal` stores a `-1` sentinel under
                // nativeStrings (no host string-constant global); a bare
                // `global.get -1` crashes binary emit ("global index out of
                // range — -1"). Materialize the excluded-keys string inline via
                // the dual-mode helper (inline NativeString externref standalone,
                // host `global.get` under GC).
                for (const instr of stringConstantExternrefInstrs(ctx, excludedStr)) fctx.body.push(instr);
                fctx.body.push({ op: "call", funcIdx: restObjIdx });
                fctx.body.push({ op: "local.set", index: restIdx });
              }
            }
          }
          continue;
        }

        const propNameNode = element.propertyName ?? element.name;
        let propNameText = ts.isIdentifier(propNameNode)
          ? propNameNode.text
          : ts.isStringLiteral(propNameNode)
            ? propNameNode.text
            : ts.isNumericLiteral(propNameNode)
              ? propNameNode.text
              : undefined;
        // Try resolving computed property names at compile time
        if (!propNameText && ts.isComputedPropertyName(propNameNode)) {
          propNameText = resolveComputedKeyExpression(ctx, propNameNode.expression);
        }
        // (#2808) Nested sub-pattern in a for-of OBJECT binding head:
        //   for (const { a: { x }, b: [y] } of arr)
        // The struct branch previously DROPPED these at the identifier-only
        // `continue` just below, so a nested object/array sub-pattern never
        // bound its inner names and — for a null/undefined property value —
        // never threw. Mirror the array branch (#2669/#2216): extract the
        // field value, apply the (undefined-only) nested default, then recurse.
        // `compileForOfDestructuring`'s own RequireObjectCoercible / GetIterator
        // null guard throws TypeError for a null/undefined nested target
        // (§13.15.5.5 / §8.5.2 BindingInitialization), so the throw is handled
        // by the recursion rather than re-emitted here.
        if (propNameText && (ts.isObjectBindingPattern(element.name) || ts.isArrayBindingPattern(element.name))) {
          const nestedFieldIdx = fields.findIndex((f) => f.name === propNameText);
          // A default initializer fires ONLY when the property value is
          // `undefined` (never `null`) — KeyedBindingInitialization §13.3.3.7
          // step 3. Restricted to PURE (non-call) defaults: a call default
          // compiled in a conditionally-skipped arm materialises its capture box
          // on the not-taken branch (#2692) / over-consumes a generator (#2566),
          // exactly the for-await regression class the array branch guards against.
          const nestedInit =
            element.initializer && !stmt.awaitModifier && !ts.isCallExpression(element.initializer)
              ? element.initializer
              : undefined;
          if (nestedFieldIdx >= 0) {
            const nestedFieldType = fields[nestedFieldIdx]!.type;
            const nestedLocal = allocLocal(fctx, `__forof_obj_nested_${fctx.locals.length}`, nestedFieldType);
            fctx.body.push({ op: "local.get", index: elemLocal });
            fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx: nestedFieldIdx });
            fctx.body.push({ op: "local.set", index: nestedLocal });
            if (nestedInit) {
              emitNestedBindingDefault(ctx, fctx, nestedLocal, nestedFieldType, nestedInit);
            }
            compileForOfDestructuring(ctx, fctx, element.name, nestedLocal, nestedFieldType, stmt);
          } else {
            // Property absent ⇒ the value is `undefined`.
            const dfltTsType = ctx.checker.getTypeAtLocation(element);
            let dfltType = resolveWasmType(ctx, dfltTsType);
            // For an absent property with no default the value is undefined and
            // must throw; force a nullable carrier so the recursion's guard fires.
            if (!nestedInit && dfltType.kind !== "ref_null" && dfltType.kind !== "externref") {
              dfltType = { kind: "externref" };
            }
            const nestedLocal = allocLocal(fctx, `__forof_obj_nested_${fctx.locals.length}`, dfltType);
            if (nestedInit) {
              const dt = compileExpression(ctx, fctx, nestedInit, dfltType);
              if (dt && !valTypesMatch(dt, dfltType)) coerceType(ctx, fctx, dt, dfltType);
            } else if (dfltType.kind === "ref_null") {
              fctx.body.push({ op: "ref.null", typeIdx: (dfltType as { typeIdx: number }).typeIdx });
            } else {
              fctx.body.push({ op: "ref.null.extern" });
            }
            fctx.body.push({ op: "local.set", index: nestedLocal });
            compileForOfDestructuring(ctx, fctx, element.name, nestedLocal, dfltType, stmt);
          }
          continue;
        }
        if (!ts.isIdentifier(element.name)) continue; // skip non-identifier binding names
        const localName = element.name.text;
        if (!propNameText) continue; // skip truly unresolvable computed property names

        const fieldIdx = fields.findIndex((f) => f.name === propNameText);
        if (fieldIdx === -1) {
          // Field not found in struct — property is "undefined" at runtime.
          // Use the default value if one is provided, otherwise use the
          // appropriate "undefined" sentinel for the target type.
          const bindingTsType = ctx.checker.getTypeAtLocation(element);
          const bindingType = resolveWasmType(ctx, bindingTsType);
          const localIdx = allocLocal(fctx, localName, bindingType);
          if (element.initializer) {
            const instrs = collectInstrs(fctx, () => {
              compileExpression(ctx, fctx, element.initializer!, bindingType);
              fctx.body.push({ op: "local.set", index: localIdx });
            });
            fctx.body.push(...instrs);
          } else {
            // No default — use "undefined" sentinel matching the local's type
            if (bindingType.kind === "f64") {
              fctx.body.push({ op: "f64.const", value: NaN });
            } else if (bindingType.kind === "i32") {
              fctx.body.push({ op: "i32.const", value: 0 });
            } else if (bindingType.kind === "ref_null" || bindingType.kind === "ref") {
              const refTypeIdx = (bindingType as { typeIdx: number }).typeIdx;
              fctx.body.push({ op: "ref.null", typeIdx: refTypeIdx });
            } else {
              fctx.body.push({ op: "ref.null.extern" });
            }
            fctx.body.push({ op: "local.set", index: localIdx });
          }
          continue;
        }

        const fieldEntry = fields[fieldIdx];
        if (!fieldEntry) continue;
        const fieldType = fieldEntry.type;
        const localIdx = allocLocal(fctx, localName, fieldType);

        fctx.body.push({ op: "local.get", index: elemLocal });
        fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx });

        // Handle default value
        if (element.initializer) {
          emitDefaultValueCheck(ctx, fctx, fieldType, localIdx, element.initializer);
        } else {
          fctx.body.push({ op: "local.set", index: localIdx });
        }
      }
    }); // end null guard for for-of object destructuring
  } else if (ts.isArrayBindingPattern(pattern)) {
    // Array destructuring in for-of: for (var [a, b] of arr)
    // (#1719 CPR-2) When the program overrode Array.prototype's @@iterator and
    // the per-element array is destructured, drive the override instead of the
    // backing store (§8.5.2). Strictly gated behind the brand + a captured
    // override; both clear in the common case ⇒ byte-identical. The element
    // value lives in `elemLocal`, so feed the shared decl read-drive that local.
    if (
      arrayDstrNeedsIdentity(ctx, false) &&
      arrayIteratorOverrideGlobalIdx(ctx) !== undefined &&
      tryEmitArrayProtoIteratorReadDrive(ctx, fctx, pattern, elemType, elemLocal)
    ) {
      syncDestructuredLocalsToGlobals(ctx, fctx, pattern);
      return;
    }
    // Element may be a vec struct (array wrapper) OR a tuple struct.
    // Handle externref elements: use __extern_get to extract indexed properties
    if (elemType.kind !== "ref" && elemType.kind !== "ref_null") {
      if (elemType.kind === "externref") {
        // Externref elements: use __extern_get(elem, box(i)) for each binding (e.g. iterator protocol)
        fctx.body.push({ op: "local.get", index: elemLocal });
        compileExternrefArrayDestructuringDecl(ctx, fctx, pattern, elemType);
        syncDestructuredLocalsToGlobals(ctx, fctx, pattern);
        return;
      }
      // #846: A non-ref, non-externref element (f64/i32 ⇒ number/boolean) is a
      // primitive that lacks [Symbol.iterator]. ArrayBindingPattern initialization
      // (§8.5.2 BindingInitialization → §8.5.3 IteratorBindingInitialization)
      // first performs GetIterator(elem), which throws TypeError for a non-iterable
      // primitive. This applies even to an EMPTY pattern (`for ([] of [1])`) because
      // GetIterator runs before any binding element is read. Previously this branch
      // silently assigned undefined sentinels and never threw. Strings are iterable
      // but lower to a string ref / externref, so they take a different branch and
      // are unaffected.
      //
      // The binding locals are still declared (allocated) so later references in
      // the loop body type-check, but the throw makes the code after it
      // unreachable in this iteration.
      for (const element of pattern.elements) {
        if (ts.isOmittedExpression(element)) continue;
        if (!ts.isBindingElement(element)) continue;
        if (!ts.isIdentifier(element.name)) continue;
        const localName = element.name.text;
        const bindingTsType = ctx.checker.getTypeAtLocation(element);
        const bindingType = resolveWasmType(ctx, bindingTsType);
        allocLocal(fctx, localName, bindingType);
      }
      emitThrowTypeError(ctx, fctx, "value is not iterable");
      return;
    }

    const structTypeIdx = (elemType as { typeIdx: number }).typeIdx;
    const structDef = ctx.mod.types[structTypeIdx];

    // Check if element is a tuple struct (fields named _0, _1, etc.)
    const isTupleStruct =
      structDef &&
      structDef.kind === "struct" &&
      structDef.fields.length > 0 &&
      structDef.fields.every((f: { name?: string }, idx: number) => f.name === `_${idx}`);

    if (isTupleStruct) {
      // Tuple destructuring: extract fields directly from the struct by index
      const tupleFields = (structDef as { fields: { name?: string; type: ValType }[] }).fields;

      emitNullGuard(ctx, fctx, elemLocal, elemType.kind === "ref_null", () => {
        for (let i = 0; i < pattern.elements.length; i++) {
          const element = pattern.elements[i]!;
          if (ts.isOmittedExpression(element)) continue;

          if (i >= tupleFields.length) break; // more bindings than tuple fields

          const fieldType = tupleFields[i]!.type;

          // Handle rest element — convert tuple to externref and slice
          if (ts.isBindingElement(element) && element.dotDotDotToken) {
            const restName = ts.isIdentifier(element.name) ? element.name.text : `__rest_${fctx.locals.length}`;
            let restIdx = fctx.localMap.get(restName);
            if (restIdx === undefined) {
              restIdx = allocLocal(fctx, restName, { kind: "externref" });
            }
            // (#3100 S4) ensureLateImport routes `__extern_slice` native standalone.
            let sliceIdx = ctx.funcMap.get("__extern_slice");
            if (sliceIdx === undefined) {
              ensureLateImport(
                ctx,
                "__extern_slice",
                [{ kind: "externref" }, { kind: "f64" }],
                [{ kind: "externref" }],
              );
              flushLateImportShifts(ctx, fctx);
              sliceIdx = ctx.funcMap.get("__extern_slice");
            }
            if (sliceIdx !== undefined) {
              fctx.body.push({ op: "local.get", index: elemLocal });
              fctx.body.push({ op: "extern.convert_any" });
              fctx.body.push({ op: "f64.const", value: i });
              fctx.body.push({ op: "call", funcIdx: sliceIdx });
              fctx.body.push({ op: "local.set", index: restIdx });
            }
            continue;
          }

          // Handle nested binding patterns: for (const [{ a, b }] of arr)
          if (
            ts.isBindingElement(element) &&
            (ts.isObjectBindingPattern(element.name) || ts.isArrayBindingPattern(element.name))
          ) {
            const nestedLocal = allocLocal(fctx, `__forof_nested_${fctx.locals.length}`, fieldType);
            fctx.body.push({ op: "local.get", index: elemLocal });
            fctx.body.push({
              op: "struct.get",
              typeIdx: structTypeIdx,
              fieldIdx: i,
            });
            fctx.body.push({ op: "local.set", index: nestedLocal });
            compileForOfDestructuring(ctx, fctx, element.name, nestedLocal, fieldType, stmt);
            continue;
          }

          if (!ts.isIdentifier(element.name)) continue;
          const localName = element.name.text;
          const bindingTsType = ctx.checker.getTypeAtLocation(element);
          const bindingWasmType = resolveWasmType(ctx, bindingTsType);
          const localIdx = allocLocal(fctx, localName, bindingWasmType);

          fctx.body.push({ op: "local.get", index: elemLocal });
          fctx.body.push({
            op: "struct.get",
            typeIdx: structTypeIdx,
            fieldIdx: i,
          });

          if (!valTypesMatch(fieldType, bindingWasmType)) {
            coerceType(ctx, fctx, fieldType, bindingWasmType);
          }

          if (element.initializer) {
            emitDefaultValueCheck(ctx, fctx, bindingWasmType, localIdx, element.initializer);
          } else {
            fctx.body.push({ op: "local.set", index: localIdx });
          }
        }
      }); // end null guard for for-of tuple destructuring
      return;
    }

    // Vec array destructuring: element is a vec struct { length, data }
    const innerArrTypeIdx = getArrTypeIdxFromVec(ctx, structTypeIdx);
    const arrDef = ctx.mod.types[innerArrTypeIdx];
    if (!arrDef || arrDef.kind !== "array") {
      reportError(ctx, stmt, "for-of array destructuring: element is not an array type");
      return;
    }

    const innerElemType = arrDef.element;

    emitNullGuard(ctx, fctx, elemLocal, elemType.kind === "ref_null", () => {
      for (let i = 0; i < pattern.elements.length; i++) {
        const element = pattern.elements[i]!;
        if (ts.isOmittedExpression(element)) continue;

        // Handle nested binding patterns: for (const [{ a, b }] of arr)
        // Skip rest elements (dotDotDotToken) — those are handled below so the
        // rest vec is built before recursing into the nested pattern.
        if (
          ts.isBindingElement(element) &&
          !element.dotDotDotToken &&
          (ts.isObjectBindingPattern(element.name) || ts.isArrayBindingPattern(element.name))
        ) {
          const nestedLocal = allocLocal(fctx, `__forof_nested_${fctx.locals.length}`, innerElemType);
          fctx.body.push({ op: "local.get", index: elemLocal });
          fctx.body.push({
            op: "struct.get",
            typeIdx: structTypeIdx,
            fieldIdx: 1,
          });
          fctx.body.push({ op: "i32.const", value: i });
          // (#2669) Apply the nested element's default initializer BEFORE recursing
          // into the sub-pattern — otherwise a short/empty source left `nestedLocal`
          // null/undefined and the recursive destructure threw
          // "Cannot destructure 'null' or 'undefined'"
          // (`for (const [[x,y,z]=[4,5,6]] of [[]])`). Mirrors the
          // `destructureParamArray` nested-default path.
          //
          // Restricted to (a) the SYNC for-of path and (b) PURE (non-call)
          // default initializers — array/object literals and identifiers. A
          // CALL-expression default (IIFE, generator `g()`, capturing helper) is
          // deferred to the pre-fix behaviour because compiling it inside the
          // conditionally-skipped default arm materialises its capture box only on
          // the not-taken branch, corrupting later reads of the captured variable
          // (#2692 closure-box-lazy territory) — and the generator case also
          // over-consumes the iterator (#2566). This is exactly what regressed 15
          // `for-await-of` elision-default tests in the merge_group floor; a pure
          // literal/identifier default has no side effect or capture box, so it is
          // safe to evaluate conditionally. Call-expression nested defaults stay
          // tracked under the umbrella tail (#2566 / #2692).
          const applyNestedDefault =
            element.initializer !== undefined && !stmt.awaitModifier && !ts.isCallExpression(element.initializer);
          if (applyNestedDefault) {
            // The OOB else-branch must yield JS `undefined` (not wasm-null) for an
            // externref source so `emitNestedBindingDefault`'s
            // `__extern_is_undefined` check fires the initializer. For a typed
            // (f64/ref) source the existing sentinel/null check already fires.
            const nestedWantsUndef = innerElemType.kind === "externref" || innerElemType.kind === "ref_extern";
            emitBoundsCheckedArrayGet(fctx, innerArrTypeIdx, innerElemType, ctx, nestedWantsUndef);
            fctx.body.push({ op: "local.set", index: nestedLocal });
            (ctx as any)._arrayLiteralForceVec = true;
            try {
              emitNestedBindingDefault(ctx, fctx, nestedLocal, innerElemType, element.initializer!);
            } finally {
              (ctx as any)._arrayLiteralForceVec = false;
            }
          } else {
            // Byte-identical to the pre-#2669 extraction (no sentinel, no default).
            emitBoundsCheckedArrayGet(fctx, innerArrTypeIdx, innerElemType);
            fctx.body.push({ op: "local.set", index: nestedLocal });
          }
          compileForOfDestructuring(ctx, fctx, element.name, nestedLocal, innerElemType, stmt);
          continue;
        }

        // Handle rest element: for (const [...rest] of arr) or for (const [a, ...rest] of arr)
        if (ts.isBindingElement(element) && element.dotDotDotToken) {
          const restName = ts.isIdentifier(element.name) ? element.name.text : `__rest_${fctx.locals.length}`;

          // Compute rest length: max(0, original.length - i)
          const restLenLocal = allocLocal(fctx, `__rest_len_${fctx.locals.length}`, { kind: "i32" });
          fctx.body.push({ op: "local.get", index: elemLocal });
          fctx.body.push({
            op: "struct.get",
            typeIdx: structTypeIdx,
            fieldIdx: 0,
          }); // length
          fctx.body.push({ op: "i32.const", value: i });
          fctx.body.push({ op: "i32.sub" });
          fctx.body.push({ op: "local.set", index: restLenLocal });
          // Clamp to 0 if negative
          fctx.body.push({ op: "i32.const", value: 0 });
          fctx.body.push({ op: "local.get", index: restLenLocal });
          fctx.body.push({ op: "local.get", index: restLenLocal });
          fctx.body.push({ op: "i32.const", value: 0 });
          fctx.body.push({ op: "i32.lt_s" });
          fctx.body.push({ op: "select" });
          fctx.body.push({ op: "local.set", index: restLenLocal });

          // Create new data array: array.new_default(restLen)
          const restArrLocal = allocLocal(fctx, `__rest_arr_${fctx.locals.length}`, {
            kind: "ref",
            typeIdx: innerArrTypeIdx,
          });
          fctx.body.push({ op: "local.get", index: restLenLocal });
          fctx.body.push({
            op: "array.new_default",
            typeIdx: innerArrTypeIdx,
          });
          fctx.body.push({ op: "local.set", index: restArrLocal });

          // array.copy(restArr, 0, srcData, i, restLen)
          fctx.body.push({ op: "local.get", index: restArrLocal });
          fctx.body.push({ op: "i32.const", value: 0 });
          fctx.body.push({ op: "local.get", index: elemLocal });
          fctx.body.push({
            op: "struct.get",
            typeIdx: structTypeIdx,
            fieldIdx: 1,
          }); // src data
          fctx.body.push({ op: "i32.const", value: i });
          fctx.body.push({ op: "local.get", index: restLenLocal });
          fctx.body.push({
            op: "array.copy",
            dstTypeIdx: innerArrTypeIdx,
            srcTypeIdx: innerArrTypeIdx,
          });

          // Create new vec struct: struct.new(restLen, restArr)
          const restVecType: ValType = { kind: "ref", typeIdx: structTypeIdx };
          fctx.body.push({ op: "local.get", index: restLenLocal });
          fctx.body.push({ op: "local.get", index: restArrLocal });
          fctx.body.push({ op: "struct.new", typeIdx: structTypeIdx });

          let restIdx = fctx.localMap.get(restName);
          if (restIdx === undefined) {
            restIdx = allocLocal(fctx, restName, restVecType);
          }
          fctx.body.push({ op: "local.set", index: restIdx });

          // If the rest target is itself a binding pattern, destructure the
          // freshly built rest vec into it.
          if (ts.isArrayBindingPattern(element.name)) {
            // Nested array sub-pattern (e.g. [...[a, b]]): recurse — the
            // recursion's vec-array branch reads A.data[i].
            compileForOfDestructuring(ctx, fctx, element.name, restIdx, restVecType, stmt);
          } else if (ts.isObjectBindingPattern(element.name)) {
            // (#2844) Nested object sub-pattern (e.g. [...{ 0: v, length: z }]):
            // the rest vec is array-like. The generic object destructure resolves
            // struct fields by name (no field `0`) and dropped numeric-key
            // bindings — route through the shared array-like object read instead.
            // For-of/for-await loop heads are always declarations -> isDecl=true.
            emitObjectPatternRestFromVec(ctx, fctx, restIdx, structTypeIdx, innerArrTypeIdx, element.name, true);
          }
          continue;
        }

        if (!ts.isIdentifier(element.name)) continue;
        const localName = element.name.text;
        const bindingTsType = ctx.checker.getTypeAtLocation(element);
        const bindingWasmType = resolveWasmType(ctx, bindingTsType);
        const localIdx = allocLocal(fctx, localName, bindingWasmType);

        fctx.body.push({ op: "local.get", index: elemLocal });
        fctx.body.push({
          op: "struct.get",
          typeIdx: structTypeIdx,
          fieldIdx: 1,
        });
        fctx.body.push({ op: "i32.const", value: i });
        // (#1396) Pass `useUndefinedSentinel: true` when this element has a
        // default initializer AND the source-array element type is externref.
        // The OOB else-branch must produce JS `undefined` (not `null`) so
        // `emitDefaultValueCheck` → `__extern_is_undefined` returns 1 and
        // the initializer fires for empty/short arrays.
        const wantUndefinedSentinel =
          element.initializer !== undefined &&
          (innerElemType.kind === "externref" || innerElemType.kind === "ref_extern");
        emitBoundsCheckedArrayGet(fctx, innerArrTypeIdx, innerElemType, ctx, wantUndefinedSentinel);

        if (element.initializer && wantUndefinedSentinel) {
          // (#2669) Externref source element WITH a default: the OOB else-branch
          // yields JS `undefined`, which is only detectable on the RAW externref
          // via `__extern_is_undefined`. Coercing to the (numeric) binding type
          // FIRST would unbox `undefined` to a plain NaN — NOT the f64 sNaN
          // sentinel the default-check looks for — so the default never fired
          // (`for (const [a=9] of [[]])` kept NaN). Run the check on the externref
          // and let emitDefaultValueCheck coerce the surviving value afterwards.
          emitDefaultValueCheck(ctx, fctx, innerElemType, localIdx, element.initializer, bindingWasmType);
        } else {
          if (!valTypesMatch(innerElemType, bindingWasmType)) {
            coerceType(ctx, fctx, innerElemType, bindingWasmType);
          }
          if (element.initializer) {
            emitDefaultValueCheck(ctx, fctx, bindingWasmType, localIdx, element.initializer);
          } else {
            fctx.body.push({ op: "local.set", index: localIdx });
          }
        }
      }
    }); // end null guard for for-of array destructuring
  }
}

/**
 * Handle assignment destructuring in for-of expression form:
 *   for ({a, b} of arr) — assigns to already-declared variables
 *   for ([x, y] of arr) — assigns to already-declared variables
 */
/**
 * (#2692) Store a for-of-assignment destructuring field value — currently the
 * single value on top of the stack (type `fieldType`) — into a target that is a
 * closure-captured-mutable BOX. A plain `local.set` on the box-ref local would
 * clobber the cell pointer; we must write THROUGH the cell with `struct.set`.
 * Mirrors the #1510 vec-default / #1258 externref box-aware branches, but covers
 * the plain (no-default) array/tuple writes that were left box-unaware — newly
 * reachable now that #2692 boxes captured-mutable vars eagerly at function-top.
 * Captured-mutable names live in a cell, never a module global, so there is no
 * global-sync to emit. Consumes exactly one stack value.
 */
function emitBoxedForOfAssignStore(
  ctx: CodegenContext,
  fctx: FunctionContext,
  targetLocal: number,
  fieldType: ValType,
  boxedCap: { refCellTypeIdx: number; valType: ValType },
): void {
  const valType = boxedCap.valType;
  const tmpVal = allocLocal(fctx, `__forof_boxset_${fctx.locals.length}`, fieldType);
  fctx.body.push({ op: "local.set", index: tmpVal });
  fctx.body.push({ op: "local.get", index: targetLocal });
  fctx.body.push({ op: "local.get", index: tmpVal });
  if (!valTypesMatch(fieldType, valType)) {
    coerceType(ctx, fctx, fieldType, valType);
  }
  fctx.body.push({ op: "struct.set", typeIdx: boxedCap.refCellTypeIdx, fieldIdx: 0 });
}

/** True when an assignment pattern binds at least one target. */
function assignPatternIsNonEmpty(pattern: ts.ObjectLiteralExpression | ts.ArrayLiteralExpression): boolean {
  return ts.isObjectLiteralExpression(pattern) ? pattern.properties.length > 0 : pattern.elements.length > 0;
}

/**
 * (#4447) Destructure a NESTED assignment pattern out of an externref value
 * already sitting in `valueLocal`.
 *
 * §13.15.5.4/§13.15.5.5 recurse into a nested pattern through the same
 * DestructuringAssignmentEvaluation as the top level, so the nested value gets
 * its own RequireObjectCoercible/GetIterator — `for ({ x: { y } } of [{}])`
 * must throw TypeError, not silently bind `undefined`. Array patterns route to
 * the externref array path (which performs the #4447 GetIterator
 * materialisation); object patterns route to the extern-get property path.
 */
function destructureNestedExternrefPattern(
  ctx: CodegenContext,
  fctx: FunctionContext,
  pattern: ts.ObjectLiteralExpression | ts.ArrayLiteralExpression,
  valueLocal: number,
  stmt: ts.ForOfStatement,
): void {
  if (assignPatternIsNonEmpty(pattern)) {
    emitExternrefDestructureGuard(ctx, fctx, valueLocal);
  }
  if (ts.isArrayLiteralExpression(pattern)) {
    compileForOfAssignDestructuringExternref(ctx, fctx, pattern, valueLocal, stmt);
  } else {
    compileForOfIteratorAssignDestructuring(ctx, fctx, pattern, valueLocal, stmt);
  }
}

export function compileForOfAssignDestructuring(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.ObjectLiteralExpression | ts.ArrayLiteralExpression,
  elemLocal: number,
  elemType: ValType,
  vecTypeIdx: number,
  arrTypeIdx: number,
  stmt: ts.ForOfStatement,
): void {
  // §6.2.4 PutValue: strict-mode assignment to unresolvable reference throws
  // ReferenceError. For for-of destructuring assignment, the throw happens each
  // iteration at the point of first unresolvable PutValue.
  const hasUnresolvable = ts.isObjectLiteralExpression(expr)
    ? findUnresolvableInObjectPattern(ctx, fctx, expr)
    : findUnresolvableInArrayPattern(ctx, fctx, expr);
  if (hasUnresolvable && isStrictContext(stmt)) {
    const tagIdx = ensureExnTag(ctx);
    fctx.body.push({ op: "ref.null.extern" });
    fctx.body.push({ op: "throw", tagIdx });
    return;
  }
  if (ts.isObjectLiteralExpression(expr)) {
    // for ({a, b} of arr) — elem is a struct ref, extract fields
    if (elemType.kind !== "ref" && elemType.kind !== "ref_null") {
      // Externref nested elements may be null/undefined (e.g. `for ([{x}] of [[null]])`).
      // Per ECMA-262 §13.15.5.5 RequireObjectCoercible, destructuring null/undefined
      // through a non-empty object pattern must throw TypeError (#1225).
      if (elemType.kind === "externref" && expr.properties.length > 0) {
        emitExternrefDestructureGuard(ctx, fctx, elemLocal);
        // (#4447) An externref element is a REAL object at runtime — an empty
        // object literal `[{}]`, an `any`-typed source, a boxed value. The
        // default-only loop below never READ a property, so
        // `for ({ x: t = d } of [{}])` dropped the write entirely (the target
        // resolved to the KEY name, and only shorthand defaults were seen), and
        // a shorthand default fired UNCONDITIONALLY even when the property was
        // present. Route to the extern-get path, which does the real
        // `__extern_get` read plus §13.15.5.4 undefined-only defaulting.
        compileForOfIteratorAssignDestructuring(ctx, fctx, expr, elemLocal, stmt);
        return;
      }
      // Primitives (bool, number, string) are object-coercible in JS.
      // Empty destructuring `for ({} of [val])` is a no-op — just iterate.
      // Non-empty patterns: properties don't exist on primitives, so use defaults.
      for (const prop of expr.properties) {
        if (ts.isSpreadAssignment(prop)) continue;
        if (!ts.isShorthandPropertyAssignment(prop) && !ts.isPropertyAssignment(prop)) continue;
        const targetName = ts.isShorthandPropertyAssignment(prop)
          ? prop.name.text
          : ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.initializer)
            ? prop.initializer.text
            : ts.isIdentifier(prop.name)
              ? prop.name.text
              : undefined;
        if (!targetName) continue; // skip computed property names
        const targetLocal = fctx.localMap.get(targetName);
        if (targetLocal === undefined) continue;

        // Property doesn't exist on primitive — use default if provided
        const init = ts.isShorthandPropertyAssignment(prop) ? prop.objectAssignmentInitializer : undefined;
        if (init) {
          // (#2692) Box-aware: when `targetName` is a captured-mutable var (now
          // boxed eagerly at function-top), write the default THROUGH the cell.
          const boxedCapPrim = fctx.boxedCaptures?.get(targetName);
          const targetType = boxedCapPrim ? boxedCapPrim.valType : getLocalType(fctx, targetLocal);
          const instrs = collectInstrs(fctx, () => {
            const dfltType = compileExpression(ctx, fctx, init, targetType ?? { kind: "externref" });
            if (boxedCapPrim) {
              emitBoxedForOfAssignStore(ctx, fctx, targetLocal, dfltType ?? boxedCapPrim.valType, boxedCapPrim);
            } else {
              fctx.body.push({ op: "local.set", index: targetLocal });
            }
          });
          fctx.body.push(...instrs);
        }
      }
      return;
    }

    const structTypeIdx = (elemType as { typeIdx: number }).typeIdx;
    const typeDef = ctx.mod.types[structTypeIdx];
    if (!typeDef || typeDef.kind !== "struct") return;

    const structName = ctx.typeIdxToStructName.get(structTypeIdx);
    const fields = structName ? ctx.structFields.get(structName) : undefined;
    if (!fields) return;

    for (const prop of expr.properties) {
      if (!ts.isShorthandPropertyAssignment(prop) && !ts.isPropertyAssignment(prop)) continue;
      let propName = ts.isShorthandPropertyAssignment(prop)
        ? prop.name.text
        : ts.isIdentifier(prop.name)
          ? prop.name.text
          : ts.isStringLiteral(prop.name)
            ? prop.name.text
            : undefined;
      // Try resolving computed property names at compile time
      if (!propName && ts.isPropertyAssignment(prop) && ts.isComputedPropertyName(prop.name)) {
        propName = resolveComputedKeyExpression(ctx, prop.name.expression);
      }
      if (!propName) continue; // skip truly unresolvable computed property names

      // (#4447) Split the property's VALUE position into (target, default).
      // §13.15.5.4 ObjectAssignmentPattern: `{ k: t = d }` parses as a
      // PropertyAssignment whose initializer is the AssignmentExpression
      // `t = d`, and `{ k = d }` as a ShorthandPropertyAssignment carrying an
      // `objectAssignmentInitializer`. Before this, neither shape was
      // recognised here: `targetName` fell through to `propName` (so
      // `for ({y: b = 22} of [{y: 5}])` wrote a variable named `y`, not `b`)
      // and the default was dropped entirely.
      const targetExpr: ts.Expression = ts.isShorthandPropertyAssignment(prop)
        ? prop.name
        : ts.isBinaryExpression(prop.initializer) && prop.initializer.operatorToken.kind === ts.SyntaxKind.EqualsToken
          ? prop.initializer.left
          : prop.initializer;
      const defaultInit: ts.Expression | undefined = ts.isShorthandPropertyAssignment(prop)
        ? prop.objectAssignmentInitializer
        : ts.isBinaryExpression(prop.initializer) && prop.initializer.operatorToken.kind === ts.SyntaxKind.EqualsToken
          ? prop.initializer.right
          : undefined;
      const targetName = ts.isIdentifier(targetExpr) ? targetExpr.text : propName;

      const fieldIdx = fields.findIndex((f) => f.name === propName);
      const isMemberTarget = ts.isPropertyAccessExpression(targetExpr) || ts.isElementAccessExpression(targetExpr);
      const isNestedPattern = ts.isObjectLiteralExpression(targetExpr) || ts.isArrayLiteralExpression(targetExpr);
      if (fieldIdx === -1) {
        // (#4447) The property is ABSENT ⇒ the read is `undefined`. A nested
        // pattern must then RequireObjectCoercible/GetIterator on `undefined`
        // and throw TypeError (§13.15.5.4 step 3 → §13.15.5.2) — that is the
        // `obj-prop-nested-{obj,array}-undefined` family, which previously
        // bound nothing and threw nothing. A default initializer, if present,
        // fires first and the nested pattern destructures ITS value instead.
        if (isNestedPattern) {
          const nestedLocal = allocLocal(fctx, `__forof_objnestmiss_${fctx.locals.length}`, { kind: "externref" });
          if (defaultInit) {
            const instrs = collectInstrs(fctx, () => {
              const dt = compileExpression(ctx, fctx, defaultInit, { kind: "externref" });
              if (dt && dt.kind !== "externref") coerceType(ctx, fctx, dt, { kind: "externref" });
              fctx.body.push({ op: "local.set", index: nestedLocal });
            });
            fctx.body.push(...instrs);
          } else {
            fctx.body.push({ op: "ref.null.extern" });
            fctx.body.push({ op: "local.set", index: nestedLocal });
          }
          destructureNestedExternrefPattern(ctx, fctx, targetExpr, nestedLocal, stmt);
          continue;
        }
        // The read is `undefined` ⇒ a default initializer, if any, MUST fire
        // (§13.15.5.4 KeyedDestructuringAssignmentEvaluation step 4). Only a
        // default-less miss is a genuine silent drop.
        if (defaultInit && !isMemberTarget) {
          let missLocal = fctx.localMap.get(targetName);
          let missSyncGlobalIdx: number | undefined;
          if (missLocal === undefined) {
            const globalIdx = ctx.moduleGlobals.get(targetName);
            if (globalIdx !== undefined) {
              const globalDef = ctx.mod.globals[localGlobalIdx(ctx, globalIdx)];
              const globalType = globalDef?.type ?? { kind: "externref" as const };
              missLocal = allocLocal(fctx, targetName, globalType);
              missSyncGlobalIdx = globalIdx;
            }
          }
          if (missLocal !== undefined) {
            const boxedCapMiss = fctx.boxedCaptures?.get(targetName);
            const missType = boxedCapMiss ? boxedCapMiss.valType : (getLocalType(fctx, missLocal) ?? undefined);
            const instrs = collectInstrs(fctx, () => {
              const dfltType = compileExpression(ctx, fctx, defaultInit, missType ?? { kind: "externref" });
              if (boxedCapMiss) {
                emitBoxedForOfAssignStore(ctx, fctx, missLocal!, dfltType ?? boxedCapMiss.valType, boxedCapMiss);
              } else {
                if (dfltType && missType && !valTypesMatch(dfltType, missType)) {
                  coerceType(ctx, fctx, dfltType, missType);
                }
                fctx.body.push({ op: "local.set", index: missLocal! });
              }
            });
            fctx.body.push(...instrs);
            if (!boxedCapMiss) {
              emitGlobalSyncWritebackByName(ctx, fctx, missLocal, targetName, missSyncGlobalIdx !== undefined);
            }
            continue;
          }
        }
        reportSilentFallback(ctx, "lookup-miss-skip", "loops:forof-assign-destructure-field-miss", prop);
        continue;
      }

      // (#4447) Nested pattern in the value position — `for ({ x: { y } } of …)`
      // / `for ({ x: [y] } of …)`. Extract the field (applying any default),
      // then recurse through the top-level dispatcher so the nested value gets
      // its own RequireObjectCoercible / GetIterator. Previously `targetName`
      // degraded to the KEY and the nested targets were never written.
      if (isNestedPattern) {
        const fieldEntryN = fields[fieldIdx];
        if (!fieldEntryN) continue;
        const fieldTypeN = fieldEntryN.type;
        const nestedLocal = allocLocal(fctx, `__forof_objnested_${fctx.locals.length}`, fieldTypeN);
        fctx.body.push({ op: "local.get", index: elemLocal });
        fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx });
        if (defaultInit) {
          emitDefaultValueCheck(ctx, fctx, fieldTypeN, nestedLocal, defaultInit, fieldTypeN, true);
        } else {
          fctx.body.push({ op: "local.set", index: nestedLocal });
        }
        compileForOfAssignDestructuring(ctx, fctx, targetExpr, nestedLocal, fieldTypeN, vecTypeIdx, arrTypeIdx, stmt);
        continue;
      }

      // (#2869) Member-expression target — `for ({k: obj.y} of src)`. The
      // identifier-only resolution below computes targetName=propName and drops
      // the write (no local/global). Extract the field value into a temp and
      // route through emitAssignToTarget → the #2664 member-set dispatcher. This
      // emits into the LIVE loop body, so there is no detached-buffer funcIdx
      // repoint hazard (unlike the assignment-expression path).
      if (isMemberTarget) {
        const fieldEntryM = fields[fieldIdx];
        if (!fieldEntryM) continue;
        const fieldTypeM = fieldEntryM.type;
        const tmpV = allocLocal(fctx, `__forof_objmemtgt_${fctx.locals.length}`, fieldTypeM);
        fctx.body.push({ op: "local.get", index: elemLocal });
        fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx });
        if (defaultInit) {
          emitDefaultValueCheck(ctx, fctx, fieldTypeM, tmpV, defaultInit, fieldTypeM, true);
        } else {
          fctx.body.push({ op: "local.set", index: tmpV });
        }
        emitAssignToTarget(ctx, fctx, targetExpr, tmpV, fieldTypeM);
        continue;
      }

      let targetLocal = fctx.localMap.get(targetName);
      let targetSyncGlobalIdx: number | undefined;
      if (targetLocal === undefined) {
        const globalIdx = ctx.moduleGlobals.get(targetName);
        if (globalIdx === undefined) continue;
        const globalDef = ctx.mod.globals[localGlobalIdx(ctx, globalIdx)];
        const globalType = globalDef?.type ?? { kind: "externref" as const };
        targetLocal = allocLocal(fctx, targetName, globalType);
        targetSyncGlobalIdx = globalIdx;
      }

      const fieldEntry2 = fields[fieldIdx];
      if (!fieldEntry2) continue;
      const fieldType = fieldEntry2.type;

      // (#4447) Present field WITH a default: fire the initializer only when
      // the read is `undefined` (object-property semantics — a genuine `null`
      // does NOT trigger it, §13.15.5.4 / #1550).
      if (defaultInit) {
        const boxedCapDflt = fctx.boxedCaptures?.get(targetName);
        if (boxedCapDflt) {
          const dfltTmp = allocLocal(fctx, `__forof_objdflt_${fctx.locals.length}`, fieldType);
          fctx.body.push({ op: "local.get", index: elemLocal });
          fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx });
          emitDefaultValueCheck(ctx, fctx, fieldType, dfltTmp, defaultInit, fieldType, true);
          fctx.body.push({ op: "local.get", index: dfltTmp });
          emitBoxedForOfAssignStore(ctx, fctx, targetLocal, fieldType, boxedCapDflt);
          continue;
        }
        const targetTypeD = getLocalType(fctx, targetLocal);
        fctx.body.push({ op: "local.get", index: elemLocal });
        fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx });
        emitDefaultValueCheck(ctx, fctx, fieldType, targetLocal, defaultInit, targetTypeD ?? undefined, true);
        emitGlobalSyncWritebackByName(ctx, fctx, targetLocal, targetName, targetSyncGlobalIdx !== undefined);
        continue;
      }
      // (#2692) Box-aware write: when `targetName` is a closure-captured-mutable
      // var, `targetLocal` is the ref-cell-ref local (now the common case since
      // #2692 boxes such vars eagerly at function-top). A plain
      // `emitCoercedLocalSet` would coerce the field value f64/externref → cell
      // ref (garbage / null deref). Write THROUGH the cell with `struct.set`,
      // mirroring the #1510 vec box-aware branch below. (Module-global sync is
      // moot here — captured-mutable names live in a cell, not a global.)
      const boxedCapObj = fctx.boxedCaptures?.get(targetName);
      if (boxedCapObj) {
        const valType = boxedCapObj.valType;
        fctx.body.push({ op: "local.get", index: targetLocal });
        fctx.body.push({ op: "local.get", index: elemLocal });
        fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx });
        if (!valTypesMatch(fieldType, valType)) {
          coerceType(ctx, fctx, fieldType, valType);
        }
        fctx.body.push({ op: "struct.set", typeIdx: boxedCapObj.refCellTypeIdx, fieldIdx: 0 });
        continue;
      }
      const targetType = getLocalType(fctx, targetLocal);
      fctx.body.push({ op: "local.get", index: elemLocal });
      fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx });
      const effectiveStackType = targetType && !valTypesMatch(fieldType, targetType) ? targetType : fieldType;
      if (targetType && !valTypesMatch(fieldType, targetType)) {
        coerceType(ctx, fctx, fieldType, targetType);
      }
      emitCoercedLocalSet(ctx, fctx, targetLocal, effectiveStackType);
      emitGlobalSyncWriteback(ctx, fctx, targetLocal, targetSyncGlobalIdx);
    }
  } else if (ts.isArrayLiteralExpression(expr)) {
    // for ([x, y] of arr) — elem is a vec struct or tuple struct, extract by index
    if (elemType.kind !== "ref" && elemType.kind !== "ref_null") {
      // Externref elements: use __extern_get to extract indexed properties
      if (elemType.kind === "externref") {
        // Per ECMA-262 §13.15.5.2 / §8.4.2 GetIterator(null/undefined) throws
        // TypeError. Required for nested patterns like `for ([[x]] of [[null]])`
        // (#1225). Skip for empty `[] of …` patterns to match existing behavior.
        if (expr.elements.length > 0) {
          emitExternrefDestructureGuard(ctx, fctx, elemLocal);
        }
        compileForOfAssignDestructuringExternref(ctx, fctx, expr, elemLocal, stmt);
      }
      return;
    }

    const innerVecTypeIdx = (elemType as { typeIdx: number }).typeIdx;
    const innerStructDef = ctx.mod.types[innerVecTypeIdx];

    // Check if element is a tuple struct (fields named _0, _1, etc.)
    const isTuple =
      innerStructDef &&
      innerStructDef.kind === "struct" &&
      innerStructDef.fields.length > 0 &&
      innerStructDef.fields.every((f: { name?: string }, idx: number) => f.name === `_${idx}`);

    // Handle 0-field structs (empty tuples like []) — all elements are OOB, apply defaults
    if (innerStructDef && innerStructDef.kind === "struct" && innerStructDef.fields.length === 0) {
      for (let i = 0; i < expr.elements.length; i++) {
        const el = expr.elements[i]!;
        if (ts.isOmittedExpression(el)) continue;
        let oobTarget: ts.Expression = el;
        let oobInit: ts.Expression | undefined;
        if (ts.isBinaryExpression(el) && el.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
          oobTarget = el.left;
          oobInit = el.right;
        }
        if (oobInit && ts.isIdentifier(oobTarget)) {
          let oobLocal = fctx.localMap.get(oobTarget.text);
          let oobSyncGlobalIdx: number | undefined;
          if (oobLocal === undefined) {
            const globalIdx = ctx.moduleGlobals.get(oobTarget.text);
            if (globalIdx !== undefined) {
              const globalDef = ctx.mod.globals[localGlobalIdx(ctx, globalIdx)];
              const globalType = globalDef?.type ?? {
                kind: "externref" as const,
              };
              oobLocal = allocLocal(fctx, oobTarget.text, globalType);
              oobSyncGlobalIdx = globalIdx;
            }
          }
          if (oobLocal !== undefined) {
            const oobType = getLocalType(fctx, oobLocal);
            const instrs = collectInstrs(fctx, () => {
              compileExpression(ctx, fctx, oobInit!, oobType ?? { kind: "f64" });
              fctx.body.push({ op: "local.set", index: oobLocal! });
            });
            fctx.body.push(...instrs);
            emitGlobalSyncWriteback(ctx, fctx, oobLocal, oobSyncGlobalIdx);
          }
        }
      }
      return;
    }

    if (isTuple) {
      // Tuple assignment destructuring: extract fields directly
      const tupleFields = (innerStructDef as { fields: { name?: string; type: ValType }[] }).fields;
      for (let i = 0; i < expr.elements.length; i++) {
        const el = expr.elements[i]!;
        if (ts.isOmittedExpression(el)) continue;

        if (ts.isSpreadElement(el)) {
          // (#2602) Rest element against a tuple-struct source. Convert the
          // WasmGC tuple to externref so __extern_slice can produce the rest
          // slice (a JS array host / native array standalone), then PutValue it.
          fctx.body.push({ op: "local.get", index: elemLocal });
          fctx.body.push({ op: "extern.convert_any" });
          emitForOfRestAssignment(ctx, fctx, el, i, (name) => ctx.moduleGlobals.get(name), stmt);
          continue;
        }

        // OOB: tuple has fewer fields than destructuring targets
        if (i >= tupleFields.length) {
          // If element has a default initializer, apply it directly (value is undefined/OOB)
          let oobTarget: ts.Expression = el;
          let oobInit: ts.Expression | undefined;
          if (ts.isBinaryExpression(el) && el.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
            oobTarget = el.left;
            oobInit = el.right;
          }
          if (oobInit && ts.isIdentifier(oobTarget)) {
            let oobLocal = fctx.localMap.get(oobTarget.text);
            let oobSyncGlobalIdx: number | undefined;
            if (oobLocal === undefined) {
              const globalIdx = ctx.moduleGlobals.get(oobTarget.text);
              if (globalIdx !== undefined) {
                const globalDef = ctx.mod.globals[localGlobalIdx(ctx, globalIdx)];
                const globalType = globalDef?.type ?? {
                  kind: "externref" as const,
                };
                oobLocal = allocLocal(fctx, oobTarget.text, globalType);
                oobSyncGlobalIdx = globalIdx;
              }
            }
            if (oobLocal !== undefined) {
              const oobType = getLocalType(fctx, oobLocal);
              const instrs = collectInstrs(fctx, () => {
                compileExpression(ctx, fctx, oobInit!, oobType ?? { kind: "f64" });
                fctx.body.push({ op: "local.set", index: oobLocal! });
              });
              fctx.body.push(...instrs);
              emitGlobalSyncWriteback(ctx, fctx, oobLocal, oobSyncGlobalIdx);
            }
          }
          continue;
        }

        const fieldType = tupleFields[i]!.type;

        // Handle nested destructuring: for ([{ a, b }] of arr) or for ([[x, y]] of arr)
        if (ts.isObjectLiteralExpression(el) || ts.isArrayLiteralExpression(el)) {
          const nestedLocal = allocLocal(fctx, `__forof_nested_${fctx.locals.length}`, fieldType);
          fctx.body.push({ op: "local.get", index: elemLocal });
          fctx.body.push({
            op: "struct.get",
            typeIdx: innerVecTypeIdx,
            fieldIdx: i,
          });
          fctx.body.push({ op: "local.set", index: nestedLocal });
          compileForOfAssignDestructuring(ctx, fctx, el, nestedLocal, fieldType, vecTypeIdx, arrTypeIdx, stmt);
          continue;
        }

        // Handle assignment with default: [v = 10]
        let targetEl: ts.Expression = el;
        let defaultInit: ts.Expression | undefined;
        if (ts.isBinaryExpression(el) && el.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
          targetEl = el.left;
          defaultInit = el.right;
        }

        // (#2869) Member-expression target — `for ([x.y] of [[4]])`. Read the
        // tuple field into a temp (applying any default), then route through
        // emitAssignToTarget → the #2664 member-set dispatcher. Emits into the
        // LIVE loop body → no detached-buffer funcIdx repoint hazard.
        if (ts.isPropertyAccessExpression(targetEl) || ts.isElementAccessExpression(targetEl)) {
          const tmpV = allocLocal(fctx, `__forof_memtgt_${fctx.locals.length}`, fieldType);
          fctx.body.push({ op: "local.get", index: elemLocal });
          fctx.body.push({ op: "struct.get", typeIdx: innerVecTypeIdx, fieldIdx: i });
          if (defaultInit) {
            emitDefaultValueCheck(ctx, fctx, fieldType, tmpV, defaultInit, fieldType);
          } else {
            fctx.body.push({ op: "local.set", index: tmpV });
          }
          emitAssignToTarget(ctx, fctx, targetEl, tmpV, fieldType);
          continue;
        }

        if (!ts.isIdentifier(targetEl)) continue;

        let targetLocal = fctx.localMap.get(targetEl.text);
        let tupleSyncGlobalIdx: number | undefined;
        if (targetLocal === undefined) {
          const globalIdx = ctx.moduleGlobals.get(targetEl.text);
          if (globalIdx === undefined) continue;
          const globalDef = ctx.mod.globals[localGlobalIdx(ctx, globalIdx)];
          const globalType = globalDef?.type ?? { kind: "externref" as const };
          targetLocal = allocLocal(fctx, targetEl.text, globalType);
          tupleSyncGlobalIdx = globalIdx;
        }

        // (#2692) Box-aware write when the target is a captured-mutable var
        // (now boxed eagerly at function-top). `targetLocal` is the cell ref —
        // route through `struct.set`, NOT a plain `local.set` (which would clobber
        // the cell pointer → null deref). Tuple path: field read by index `i`.
        const boxedCapTup = fctx.boxedCaptures?.get(targetEl.text);
        const targetType = boxedCapTup ? boxedCapTup.valType : getLocalType(fctx, targetLocal);
        fctx.body.push({ op: "local.get", index: elemLocal });
        fctx.body.push({
          op: "struct.get",
          typeIdx: innerVecTypeIdx,
          fieldIdx: i,
        });

        if (boxedCapTup) {
          if (defaultInit) {
            // Compute value-or-default into a temp of the cell's value type
            // (emitDefaultValueCheck consumes the field value on the stack and
            // stores into the temp), then write the temp through the cell.
            const tmpV = allocLocal(fctx, `__forof_tupdflt_${fctx.locals.length}`, boxedCapTup.valType);
            emitDefaultValueCheck(ctx, fctx, fieldType, tmpV, defaultInit, boxedCapTup.valType);
            fctx.body.push({ op: "local.get", index: targetLocal });
            fctx.body.push({ op: "local.get", index: tmpV });
            fctx.body.push({ op: "struct.set", typeIdx: boxedCapTup.refCellTypeIdx, fieldIdx: 0 });
          } else {
            emitBoxedForOfAssignStore(ctx, fctx, targetLocal, fieldType, boxedCapTup);
          }
          // captured-mutable lives in a cell, not a global → no global sync.
          continue;
        }

        if (defaultInit) {
          // Check for undefined and apply default — BEFORE type coercion
          emitDefaultValueCheck(ctx, fctx, fieldType, targetLocal, defaultInit, targetType ?? undefined);
        } else {
          if (targetType && !valTypesMatch(fieldType, targetType)) {
            coerceType(ctx, fctx, fieldType, targetType);
          }
          fctx.body.push({ op: "local.set", index: targetLocal });
        }

        emitGlobalSyncWriteback(ctx, fctx, targetLocal, tupleSyncGlobalIdx);
      }
    } else {
      // Vec array assignment destructuring
      const innerArrTypeIdx = getArrTypeIdxFromVec(ctx, innerVecTypeIdx);
      const innerArrDef = ctx.mod.types[innerArrTypeIdx];
      if (!innerArrDef || innerArrDef.kind !== "array") return;

      const innerElemType = innerArrDef.element;
      for (let i = 0; i < expr.elements.length; i++) {
        const el = expr.elements[i]!;
        if (ts.isOmittedExpression(el)) continue;

        if (ts.isSpreadElement(el)) {
          // (#2602) Rest element against a WasmGC vec-struct source. Build the
          // rest slice NATIVELY (mirror of the BINDING-form vec rest, loops.ts
          // ~1488): array.new_default(restLen) + array.copy from index `i` +
          // struct.new — no externref/__extern_slice roundtrip (the host
          // __extern_slice can't slice a WasmGC struct externref). The fresh vec
          // has the SAME struct type as the source, then PutValue to the target.
          emitVecRestAssignment(
            ctx,
            fctx,
            el,
            elemLocal,
            i,
            innerVecTypeIdx,
            innerArrTypeIdx,
            innerElemType,
            vecTypeIdx,
            arrTypeIdx,
            stmt,
          );
          continue;
        }

        // Handle nested destructuring: for ([{ a, b }] of arr) or for ([[x, y]] of arr)
        if (ts.isObjectLiteralExpression(el) || ts.isArrayLiteralExpression(el)) {
          const nestedLocal = allocLocal(fctx, `__forof_nested_${fctx.locals.length}`, innerElemType);
          fctx.body.push({ op: "local.get", index: elemLocal });
          fctx.body.push({
            op: "struct.get",
            typeIdx: innerVecTypeIdx,
            fieldIdx: 1,
          });
          fctx.body.push({ op: "i32.const", value: i });
          emitBoundsCheckedArrayGet(fctx, innerArrTypeIdx, innerElemType);
          fctx.body.push({ op: "local.set", index: nestedLocal });
          compileForOfAssignDestructuring(ctx, fctx, el, nestedLocal, innerElemType, vecTypeIdx, arrTypeIdx, stmt);
          continue;
        }

        // Handle assignment with default: [v = 10]
        let targetEl: ts.Expression = el;
        let defaultInit: ts.Expression | undefined;
        if (ts.isBinaryExpression(el) && el.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
          targetEl = el.left;
          defaultInit = el.right;
        }

        // (#2869) Member-expression target — `for ([x.y] of [[4]])` over a vec
        // source. Bounds-checked read of elem.data[i] into a temp (applying any
        // default), then route through emitAssignToTarget → the #2664 member-set
        // dispatcher. Live loop body → no detached-buffer funcIdx hazard.
        if (ts.isPropertyAccessExpression(targetEl) || ts.isElementAccessExpression(targetEl)) {
          const memElemVT: ValType =
            innerElemType.kind === "i8" || innerElemType.kind === "i16" ? { kind: "i32" } : innerElemType;
          const tmpV = allocLocal(fctx, `__forof_memtgt_${fctx.locals.length}`, memElemVT);
          fctx.body.push({ op: "local.get", index: elemLocal });
          fctx.body.push({ op: "struct.get", typeIdx: innerVecTypeIdx, fieldIdx: 1 });
          fctx.body.push({ op: "i32.const", value: i });
          emitBoundsCheckedArrayGet(fctx, innerArrTypeIdx, innerElemType);
          if (defaultInit) {
            emitDefaultValueCheck(ctx, fctx, memElemVT, tmpV, defaultInit, memElemVT);
          } else {
            fctx.body.push({ op: "local.set", index: tmpV });
          }
          emitAssignToTarget(ctx, fctx, targetEl, tmpV, memElemVT);
          continue;
        }

        if (!ts.isIdentifier(targetEl)) continue;

        let targetLocal = fctx.localMap.get(targetEl.text);
        let vecSyncGlobalIdx: number | undefined;
        if (targetLocal === undefined) {
          const globalIdx = ctx.moduleGlobals.get(targetEl.text);
          if (globalIdx === undefined) continue;
          const globalDef = ctx.mod.globals[localGlobalIdx(ctx, globalIdx)];
          const globalType = globalDef?.type ?? { kind: "externref" as const };
          targetLocal = allocLocal(fctx, targetEl.text, globalType);
          vecSyncGlobalIdx = globalIdx;
        }

        const targetType = getLocalType(fctx, targetLocal);

        // #1510 — boxed-capture target with default initializer (vec path).
        // Mirror of the externref-path fix in compileForOfAssignDestructuringExternref.
        // Without this, `emitDefaultValueCheck` does `local.set` on the captured
        // param, overwriting the box-ref. The pre-fix symptom is
        // "dereferencing a null pointer" (when valType is a ref) or silently
        // lost writes (when valType is f64 → coerce mismatch + drop).
        const boxedCapVec = fctx.boxedCaptures?.get(targetEl.text);
        if (boxedCapVec && defaultInit) {
          const valType = boxedCapVec.valType;
          // Read elem.data[i] safely (bounds-checked → produces innerElemType or
          // the type's "undefined" sentinel for OOB). For f64 element types this
          // returns NaN sentinel; for ref/externref it returns null.
          fctx.body.push({ op: "local.get", index: targetLocal });
          fctx.body.push({ op: "local.get", index: elemLocal });
          fctx.body.push({
            op: "struct.get",
            typeIdx: innerVecTypeIdx,
            fieldIdx: 1,
          });
          fctx.body.push({ op: "i32.const", value: i });
          emitBoundsCheckedArrayGet(fctx, innerArrTypeIdx, innerElemType);
          // Now stack: [box-ref, value:innerElemType]. Apply default-on-undefined
          // and coerce to valType before struct.set.
          // For f64: check sNaN sentinel; for ref/null: check ref.is_null;
          // for externref: __extern_is_undefined.
          const tmpVal = allocLocal(fctx, `__forof_dflt_v_${fctx.locals.length}`, innerElemType);
          fctx.body.push({ op: "local.tee", index: tmpVal });
          if (innerElemType.kind === "f64") {
            fctx.body.push({ op: "i64.reinterpret_f64" });
            fctx.body.push({ op: "i64.const", value: 0x7ff00000deadc0den });
            fctx.body.push({ op: "i64.eq" });
          } else if (innerElemType.kind === "externref") {
            const undefIdx = ensureExternIsUndefined(ctx, fctx);
            if (undefIdx !== undefined) {
              fctx.body.push({ op: "call", funcIdx: undefIdx });
            } else {
              fctx.body.push({ op: "ref.is_null" });
            }
          } else if (innerElemType.kind === "ref" || innerElemType.kind === "ref_null") {
            fctx.body.push({ op: "ref.is_null" });
          } else {
            // i32 or other — no reliable undefined sentinel; treat as not-undefined.
            fctx.body.push({ op: "i32.const", value: 0 });
          }
          const thenInstrs = collectInstrs(fctx, () => {
            compileExpression(ctx, fctx, defaultInit!, valType);
          });
          const elseInstrs = collectInstrs(fctx, () => {
            fctx.body.push({ op: "local.get", index: tmpVal });
            if (!valTypesMatch(innerElemType, valType)) {
              coerceType(ctx, fctx, innerElemType, valType);
            }
          });
          fctx.body.push({
            op: "if",
            blockType: { kind: "val", type: valType },
            then: thenInstrs,
            else: elseInstrs,
          });
          fctx.body.push({
            op: "struct.set",
            typeIdx: boxedCapVec.refCellTypeIdx,
            fieldIdx: 0,
          });
          if (vecSyncGlobalIdx !== undefined) {
            fctx.body.push({ op: "local.get", index: targetLocal });
            fctx.body.push({
              op: "struct.get",
              typeIdx: boxedCapVec.refCellTypeIdx,
              fieldIdx: 0,
            });
            fctx.body.push({ op: "global.set", index: vecSyncGlobalIdx });
          }
          continue;
        }

        if (defaultInit && innerElemType.kind === "externref") {
          // For externref elements with defaults, do explicit bounds check.
          // OOB produces ref.null.extern (Wasm null) which is indistinguishable from JS null.
          // We must apply defaults for OOB but NOT for JS null.
          const arrDataLocal = allocLocal(fctx, `__forof_arr_${fctx.locals.length}`, {
            kind: "ref",
            typeIdx: innerArrTypeIdx,
          });
          fctx.body.push({ op: "local.get", index: elemLocal });
          fctx.body.push({
            op: "struct.get",
            typeIdx: innerVecTypeIdx,
            fieldIdx: 1,
          });
          fctx.body.push({ op: "local.tee", index: arrDataLocal });
          fctx.body.push({ op: "array.len" });
          fctx.body.push({ op: "i32.const", value: i });
          fctx.body.push({ op: "i32.gt_s" }); // len > i means in-bounds

          const hintType = targetType ?? innerElemType;
          // Then branch: in-bounds — get element, check for undefined, apply default if needed
          const thenInstrs = collectInstrs(fctx, () => {
            fctx.body.push({ op: "local.get", index: arrDataLocal });
            fctx.body.push({ op: "i32.const", value: i });
            fctx.body.push({
              op: "array.get",
              typeIdx: innerArrTypeIdx,
            });
            emitDefaultValueCheck(ctx, fctx, innerElemType, targetLocal!, defaultInit!, targetType ?? undefined);
          });
          // Else branch: OOB — apply default directly
          const elseInstrs = collectInstrs(fctx, () => {
            compileExpression(ctx, fctx, defaultInit!, hintType);
            fctx.body.push({ op: "local.set", index: targetLocal! });
          });
          fctx.body.push({
            op: "if",
            blockType: { kind: "empty" },
            then: thenInstrs,
            else: elseInstrs,
          });
        } else {
          fctx.body.push({ op: "local.get", index: elemLocal });
          fctx.body.push({
            op: "struct.get",
            typeIdx: innerVecTypeIdx,
            fieldIdx: 1,
          });
          fctx.body.push({ op: "i32.const", value: i });
          emitBoundsCheckedArrayGet(fctx, innerArrTypeIdx, innerElemType);

          if (defaultInit) {
            // Check for undefined and apply default — BEFORE type coercion
            emitDefaultValueCheck(ctx, fctx, innerElemType, targetLocal, defaultInit, targetType ?? undefined);
          } else if (boxedCapVec) {
            // (#2692) Box-aware plain write (boxed+default already handled and
            // `continue`d at the #1510 branch above, so here it is no-default).
            emitBoxedForOfAssignStore(ctx, fctx, targetLocal, innerElemType, boxedCapVec);
          } else {
            if (targetType && !valTypesMatch(innerElemType, targetType)) {
              coerceType(ctx, fctx, innerElemType, targetType);
            }
            fctx.body.push({ op: "local.set", index: targetLocal });
          }
        }

        emitGlobalSyncWriteback(ctx, fctx, targetLocal, vecSyncGlobalIdx);
      }
    }
  }
}

/**
 * (#2602) Emit the rest-element ASSIGNMENT write for a for-of / for-await
 * assignment-destructuring head: `for ([x, ...y] of …)` (and `for await`).
 *
 * Spec §13.15.5.5 ArrayAssignmentPattern (the rest step) requires PutValue on
 * the `...y` target with the remaining iterated elements — the slice from
 * `restStartIndex` to the end. Before this, all for-of assignment-destructuring
 * loops `continue`d on `ts.isSpreadElement`, so `y` was never written and kept a
 * stale value (the source array). This mirrors the BINDING-form rest write
 * (loops.ts ~1375) and the plain `[a, ...rest] = arr` assignment-form rest
 * (assignment.ts ~1628), both of which use `__extern_slice`.
 *
 * The caller must already have pushed the source value onto the stack as an
 * `externref` (an `extern.convert_any` of the loop element for a WasmGC vec/
 * tuple element, or the element local directly for an externref element).
 * `__extern_slice(elem, restStartIndex)` returns the rest as an externref
 * (a JS array host-side / native array standalone); we then PutValue it to the
 * rest target.
 *
 * Only IDENTIFIER rest targets are handled (local OR pre-declared module global
 * — the shape every test262 array-rest case + #2602 uses). A rest target that is
 * a property/element access (`[...obj.x]`) is rare and left as a no-op (matching
 * the pre-#2602 drop — no regression). Returns `true` when the spread element was
 * consumed (the caller should `continue`), `false` to fall through.
 */
function emitForOfRestAssignment(
  ctx: CodegenContext,
  fctx: FunctionContext,
  spread: ts.SpreadElement,
  restStartIndex: number,
  syncGlobalForName: (name: string) => number | undefined,
  /** (#4447) Enclosing for-of — needed to recurse into a nested rest target. */
  stmtForNested?: ts.ForOfStatement,
): boolean {
  const restTarget = spread.expression;

  // (#4447) NESTED rest target — `for ([...{ 1: x }] of …)` / `for ([...[y]] of …)`.
  // §13.15.5.5 AssignmentRestElement PutValue's the remainder into an
  // AssignmentPattern just like any other target, so slice first and then
  // destructure the slice. Previously any non-identifier rest target dropped
  // the source and bound nothing.
  if (
    stmtForNested !== undefined &&
    (ts.isObjectLiteralExpression(restTarget) || ts.isArrayLiteralExpression(restTarget))
  ) {
    let nestedSliceIdx = ctx.funcMap.get("__extern_slice");
    if (nestedSliceIdx === undefined) {
      ensureLateImport(ctx, "__extern_slice", [{ kind: "externref" }, { kind: "f64" }], [{ kind: "externref" }]);
      flushLateImportShifts(ctx, fctx);
      nestedSliceIdx = ctx.funcMap.get("__extern_slice");
    }
    if (nestedSliceIdx === undefined) {
      fctx.body.push({ op: "drop" });
      return true;
    }
    const nestedRestLocal = allocLocal(fctx, `__forof_restnested_${fctx.locals.length}`, { kind: "externref" });
    fctx.body.push({ op: "f64.const", value: restStartIndex });
    fctx.body.push({ op: "call", funcIdx: nestedSliceIdx });
    fctx.body.push({ op: "local.set", index: nestedRestLocal });
    destructureNestedExternrefPattern(ctx, fctx, restTarget, nestedRestLocal, stmtForNested);
    return true;
  }

  // Pop the source externref the caller pushed — we only need it when the target
  // resolves; for an unhandled target shape, drop it to keep the stack balanced.
  if (!ts.isIdentifier(restTarget)) {
    // Unhandled rest target (property/element access). Drop the source externref
    // the caller pushed so the value stack stays balanced, then bail.
    fctx.body.push({ op: "drop" });
    return true;
  }

  // Ensure __extern_slice is available (env import in JS-host mode; #3100 S4:
  // ensureLateImport routes to the NATIVE defined slice under standalone/wasi —
  // the raw `env::` addImport this replaces leaked the host import).
  let sliceIdx = ctx.funcMap.get("__extern_slice");
  if (sliceIdx === undefined) {
    ensureLateImport(ctx, "__extern_slice", [{ kind: "externref" }, { kind: "f64" }], [{ kind: "externref" }]);
    flushLateImportShifts(ctx, fctx);
    sliceIdx = ctx.funcMap.get("__extern_slice");
  }
  if (sliceIdx === undefined) {
    // Could not register the slice helper — drop the source to keep balance.
    fctx.body.push({ op: "drop" });
    return true;
  }

  const restName = restTarget.text;
  let targetLocal = fctx.localMap.get(restName);
  let restSyncGlobalIdx: number | undefined;
  if (targetLocal === undefined) {
    const globalIdx = syncGlobalForName(restName);
    if (globalIdx === undefined) {
      // No local and no module global — nothing to write to. Drop and bail.
      fctx.body.push({ op: "drop" });
      return true;
    }
    const globalDef = ctx.mod.globals[localGlobalIdx(ctx, globalIdx)];
    const globalType = globalDef?.type ?? { kind: "externref" as const };
    targetLocal = allocLocal(fctx, restName, globalType);
    restSyncGlobalIdx = globalIdx;
  }

  // Source externref is on the stack. Compute the rest slice:
  //   __extern_slice(source, restStartIndex) -> externref
  fctx.body.push({ op: "f64.const", value: restStartIndex });
  fctx.body.push({ op: "call", funcIdx: sliceIdx });

  // Coerce externref slice -> the rest target's declared type and store. For an
  // untyped (`any` → externref) target this is a no-op; for `number[]` (a vec
  // ref) coerceType reconstructs the vec from the JS-array externref (its
  // guarded externref→ref arm handles the JS-array case — no trapping cast).
  const targetType = getLocalType(fctx, targetLocal);
  if (targetType && targetType.kind !== "externref") {
    coerceType(ctx, fctx, { kind: "externref" }, targetType);
  }
  fctx.body.push({ op: "local.set", index: targetLocal });

  emitGlobalSyncWriteback(ctx, fctx, targetLocal, restSyncGlobalIdx);
  return true;
}

/**
 * (#2602) Emit the rest-element ASSIGNMENT write when the for-of source element
 * is a WasmGC vec struct (`{ length, data }`) — `for ([x, ...y] of [[1,2,3]])`.
 *
 * Builds the rest slice NATIVELY (no externref / __extern_slice roundtrip — the
 * host __extern_slice cannot slice a WasmGC struct externref): compute
 * `restLen = max(0, srcLen - restStartIndex)`, `array.new_default(restLen)`,
 * `array.copy` the tail from `srcData[restStartIndex..]`, then `struct.new` a
 * fresh vec of the SAME struct type as the source. This mirrors the binding-form
 * vec rest (loops.ts ~1488) so behaviour is byte-identical between
 * `const [a,...r]=…` and `[a,...r]=…`. The fresh vec is PutValue'd to the rest
 * target (identifier local OR pre-declared module global). Only identifier
 * targets are handled (the test262 array-rest shape + #2602); a property/element
 * rest target is left unwritten (matching the pre-#2602 drop — no regression).
 */
function emitVecRestAssignment(
  ctx: CodegenContext,
  fctx: FunctionContext,
  spread: ts.SpreadElement,
  elemLocal: number,
  restStartIndex: number,
  vecTypeIdx: number,
  arrTypeIdx: number,
  innerElemType: ValType,
  outerVecTypeIdx: number,
  outerArrTypeIdx: number,
  stmt: ts.ForOfStatement,
): void {
  const restTarget = spread.expression;
  const restVecType: ValType = { kind: "ref", typeIdx: vecTypeIdx };

  // A nested pattern rest target (`for ([...[x]] of …)`): build the rest vec
  // into a temp, then recurse into the nested assignment pattern with the fresh
  // rest vec as the element (mirror of the binding-form rest recursion,
  // loops.ts ~1551). Identifier targets store directly; property/element rest
  // targets are not handled (matching the pre-#2602 drop — no regression).
  const isNestedPattern = ts.isArrayLiteralExpression(restTarget) || ts.isObjectLiteralExpression(restTarget);
  let targetLocal: number | undefined;
  let restSyncGlobalIdx: number | undefined;
  if (isNestedPattern) {
    targetLocal = allocLocal(fctx, `__forof_rest_${fctx.locals.length}`, restVecType);
  } else {
    if (!ts.isIdentifier(restTarget)) return; // property/element rest target — not handled (no regression)
    targetLocal = fctx.localMap.get(restTarget.text);
    if (targetLocal === undefined) {
      const globalIdx = ctx.moduleGlobals.get(restTarget.text);
      if (globalIdx === undefined) return; // unresolvable identifier — nothing to write
      targetLocal = allocLocal(fctx, restTarget.text, restVecType);
      restSyncGlobalIdx = globalIdx;
    }
  }

  // restLen = max(0, srcLen - restStartIndex)
  const restLenLocal = allocLocal(fctx, `__rest_len_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "local.get", index: elemLocal });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 }); // length
  fctx.body.push({ op: "i32.const", value: restStartIndex });
  fctx.body.push({ op: "i32.sub" });
  fctx.body.push({ op: "local.set", index: restLenLocal });
  // clamp negative to 0: select(0, restLen, restLen < 0)
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "local.get", index: restLenLocal });
  fctx.body.push({ op: "local.get", index: restLenLocal });
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "i32.lt_s" });
  fctx.body.push({ op: "select" });
  fctx.body.push({ op: "local.set", index: restLenLocal });

  // restArr = array.new_default(restLen)
  const restArrLocal = allocLocal(fctx, `__rest_arr_${fctx.locals.length}`, { kind: "ref", typeIdx: arrTypeIdx });
  fctx.body.push({ op: "local.get", index: restLenLocal });
  fctx.body.push({ op: "array.new_default", typeIdx: arrTypeIdx });
  fctx.body.push({ op: "local.set", index: restArrLocal });

  // array.copy(restArr, 0, srcData, restStartIndex, restLen)
  fctx.body.push({ op: "local.get", index: restArrLocal });
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "local.get", index: elemLocal });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 }); // src data
  fctx.body.push({ op: "i32.const", value: restStartIndex });
  fctx.body.push({ op: "local.get", index: restLenLocal });
  fctx.body.push({ op: "array.copy", dstTypeIdx: arrTypeIdx, srcTypeIdx: arrTypeIdx });
  // innerElemType is referenced for symmetry with the binding-form rest (the
  // array element type is already arrTypeIdx's element); no per-element coercion
  // is needed since we copy raw same-typed elements.
  void innerElemType;

  // restVec = struct.new(restLen, restArr)
  fctx.body.push({ op: "local.get", index: restLenLocal });
  fctx.body.push({ op: "local.get", index: restArrLocal });
  fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx });

  if (isNestedPattern) {
    // Store the fresh rest vec into the temp local, then recurse into the
    // nested assignment pattern (`for ([...[x]] of …)`) with it as the element.
    fctx.body.push({ op: "local.set", index: targetLocal });
    compileForOfAssignDestructuring(
      ctx,
      fctx,
      restTarget as ts.ArrayLiteralExpression | ts.ObjectLiteralExpression,
      targetLocal,
      restVecType,
      outerVecTypeIdx,
      outerArrTypeIdx,
      stmt,
    );
    return;
  }

  // PutValue to the identifier rest target.
  const targetType = getLocalType(fctx, targetLocal);
  if (targetType && !valTypesMatch(restVecType, targetType)) {
    coerceType(ctx, fctx, restVecType, targetType);
  }
  fctx.body.push({ op: "local.set", index: targetLocal });

  emitGlobalSyncWriteback(ctx, fctx, targetLocal, restSyncGlobalIdx);
}

/**
 * Handle assignment destructuring of externref arrays in for-of.
 * Uses __extern_get(elem, box(i)) for each element, with default value support.
 *
 * (#4447) The element is first normalised through `__array_from_iter_n` —
 * §13.15.5.2 ArrayAssignmentPattern performs GetIterator(value) and steps the
 * iterator once per element, then IteratorCloses when the pattern did not
 * exhaust it. Reading `elem[i]` directly (what this did before) never touches
 * `@@iterator`/`next`/`return`, so a for-of head assigning FROM a user iterable
 * (`for ([x,] of [iterable])`) observed zero `next()` calls and zero
 * `return()` calls. This mirrors the plain assignment-destructuring path in
 * `expressions/assignment.ts` (#1454/#1592/#3100 S4) exactly: bounded step
 * count from the pattern, `-1` (unbounded drain) when a rest element is
 * present, and carrier-aware `__extern_get_idx` reads on standalone/WASI.
 * Plain arrays with the default `@@iterator` keep the indexed fast path inside
 * the helper, so array sources stay byte-equivalent.
 */
function compileForOfAssignDestructuringExternref(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.ArrayLiteralExpression,
  elemLocal: number,
  /** (#4447) Enclosing for-of — needed to recurse into nested patterns. */
  stmtForNested: ts.ForOfStatement,
): void {
  // (#4447) GetIterator materialisation — must run BEFORE the readers are
  // resolved, since `ensureLateImport` can shift function indices.
  let srcLocal = elemLocal;
  if (expr.elements.length > 0) {
    const matStepCount = patternIteratorStepCount(expr.elements);
    const matIterIdx = ensureLateImport(
      ctx,
      "__array_from_iter_n",
      [{ kind: "externref" }, { kind: "f64" }],
      [{ kind: "externref" }],
    );
    flushLateImportShifts(ctx, fctx);
    if (matIterIdx !== undefined) {
      const matLocal = allocLocal(fctx, `__forof_dstr_mat_${fctx.locals.length}`, { kind: "externref" });
      fctx.body.push({ op: "local.get", index: elemLocal });
      fctx.body.push({ op: "f64.const", value: matStepCount });
      fctx.body.push({ op: "call", funcIdx: matIterIdx });
      fctx.body.push({ op: "local.set", index: matLocal });
      srcLocal = matLocal;
    }
  }

  // (#3100 S4) Standalone/WASI element reads use the carrier-aware native
  // `__extern_get_idx(src, f64 i)` — the native `__extern_get` is string-keyed
  // and misses the `$Vec` carrier `__array_from_iter_n` produces. Host mode
  // keeps `__extern_get` + `__box_number` (byte-identical to pre-#4447).
  const useIdxReads = ctx.standalone || ctx.wasi;
  const readName = useIdxReads ? "__extern_get_idx" : "__extern_get";
  const readKeyType: ValType = useIdxReads ? { kind: "f64" } : { kind: "externref" };
  // Ensure the reader is available (#1866: ensureLateImport routes to the
  // native object-runtime impl under --target standalone — no leaked
  // `env::__extern_get` host import — and to the host import in JS-host mode).
  ensureLateImport(ctx, readName, [{ kind: "externref" }, readKeyType], [{ kind: "externref" }]);
  flushLateImportShifts(ctx, fctx);
  let getIdx = ctx.funcMap.get(readName);
  if (getIdx === undefined) return;

  // Ensure __box_number is available (host mode only — it boxes the index key).
  let boxIdx = ctx.funcMap.get("__box_number");
  if (!useIdxReads && boxIdx === undefined) {
    const importsBefore = ctx.numImportFuncs;
    const boxType = addFuncType(ctx, [{ kind: "f64" }], [{ kind: "externref" }]);
    addImport(ctx, "env", "__box_number", { kind: "func", typeIdx: boxType });
    shiftLateImportIndices(ctx, fctx, importsBefore, ctx.numImportFuncs - importsBefore);
    boxIdx = ctx.funcMap.get("__box_number");
    getIdx = ctx.funcMap.get(readName);
  }
  if ((!useIdxReads && boxIdx === undefined) || getIdx === undefined) return;

  /**
   * Push `src[i]` as an externref — the single read shape this function used to
   * inline five times. Host: `__extern_get(src, __box_number(i))`; standalone:
   * `__extern_get_idx(src, i)`.
   */
  const pushElemRead = (i: number): void => {
    fctx.body.push({ op: "local.get", index: srcLocal });
    fctx.body.push({ op: "f64.const", value: i });
    if (!useIdxReads) fctx.body.push({ op: "call", funcIdx: boxIdx! });
    fctx.body.push({ op: "call", funcIdx: getIdx! });
  };

  // Lazily register __extern_set for property/element-access destructuring
  // targets. We only register if/when we actually need it; that keeps the
  // identifier-only happy path's import surface unchanged.
  let setIdx: number | undefined;
  const ensureExternSet = (): number | undefined => {
    if (setIdx !== undefined) return setIdx;
    setIdx = ctx.funcMap.get("__extern_set");
    if (setIdx === undefined) {
      const importsBefore = ctx.numImportFuncs;
      const setType = addFuncType(ctx, [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }], []);
      addImport(ctx, "env", "__extern_set", { kind: "func", typeIdx: setType });
      shiftLateImportIndices(ctx, fctx, importsBefore, ctx.numImportFuncs - importsBefore);
      setIdx = ctx.funcMap.get("__extern_set");
    }
    return setIdx;
  };

  for (let i = 0; i < expr.elements.length; i++) {
    const el = expr.elements[i]!;
    if (ts.isOmittedExpression(el)) continue;
    if (ts.isSpreadElement(el)) {
      // (#2602) Rest element `...y`: PutValue the slice from index `i` onward.
      // (#4447) Slice the MATERIALISED source — a rest element passes -1 to
      // `__array_from_iter_n`, i.e. an unbounded drain, so `srcLocal` already
      // holds every value the iterator produced.
      fctx.body.push({ op: "local.get", index: srcLocal });
      emitForOfRestAssignment(ctx, fctx, el, i, (name) => ctx.moduleGlobals.get(name), stmtForNested);
      continue;
    }

    // Handle assignment with default: [v = 10]
    let targetEl: ts.Expression = el;
    let defaultInit: ts.Expression | undefined;
    if (ts.isBinaryExpression(el) && el.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      targetEl = el.left;
      defaultInit = el.right;
    }

    // (#4447) Nested pattern element — `for ([[x]] of …)` / `for ([{x}] of …)`.
    // Read the slot, apply any default, then recurse so the nested value runs
    // its own RequireObjectCoercible / GetIterator. Previously a non-identifier,
    // non-member target fell through to the `isIdentifier` bail below and the
    // whole nested pattern was silently dropped.
    if (ts.isObjectLiteralExpression(targetEl) || ts.isArrayLiteralExpression(targetEl)) {
      const nestedLocal = allocLocal(fctx, `__forof_extnested_${fctx.locals.length}`, { kind: "externref" });
      pushElemRead(i);
      if (defaultInit) {
        emitDefaultValueCheck(ctx, fctx, { kind: "externref" }, nestedLocal, defaultInit, { kind: "externref" });
      } else {
        fctx.body.push({ op: "local.set", index: nestedLocal });
      }
      destructureNestedExternrefPattern(ctx, fctx, targetEl, nestedLocal, stmtForNested);
      continue;
    }

    // #1258 — destructure-assignment target may be a property access
    // (`[x.y] of [[4]]`) or element access (`[x[0]] of [[4]]`), not just
    // an identifier. Pre-#1258 the function bailed (`continue`) on any
    // non-identifier target, silently dropping the write. Spec §13.15.5.5
    // ArrayAssignmentPattern requires PutValue on the LHS — for property
    // references that is `__extern_set(receiver, key, value)`.
    if (ts.isPropertyAccessExpression(targetEl) || ts.isElementAccessExpression(targetEl)) {
      const setFnIdx = ensureExternSet();
      if (setFnIdx === undefined) continue;
      // Push receiver (already-existing variable, evaluated each iteration)
      const recvType = compileExpression(ctx, fctx, targetEl.expression, {
        kind: "externref",
      });
      if (recvType && recvType.kind !== "externref") {
        coerceType(ctx, fctx, recvType, { kind: "externref" });
      }
      if (recvType === null) {
        fctx.body.push({ op: "ref.null.extern" });
      }
      // Push key — string literal for `.prop`, computed value for `[expr]`
      if (ts.isPropertyAccessExpression(targetEl)) {
        const propName = targetEl.name.text;
        // (#51) Materialize via the dual-mode helper — nativeStrings stores a
        // `-1` sentinel global so a bare `global.get` crashes binary emit.
        addStringConstantGlobal(ctx, propName);
        for (const instr of stringConstantExternrefInstrs(ctx, propName)) fctx.body.push(instr);
      } else {
        // ElementAccessExpression
        const keyType = compileExpression(ctx, fctx, targetEl.argumentExpression, { kind: "externref" });
        if (keyType && keyType.kind !== "externref") {
          coerceType(ctx, fctx, keyType, { kind: "externref" });
        }
        if (keyType === null) {
          fctx.body.push({ op: "ref.null.extern" });
        }
      }
      // Push value: src[i]
      pushElemRead(i);
      // Defaults on property targets: if the read is undefined, fall back to default.
      // Spec applies to ALL destructure targets identically, but the existing emit
      // path uses `emitDefaultValueCheck` against a local. For property targets
      // we'd need a temp local + the same dispatch. Out of scope for #1258 —
      // the target test cases (put-prop-ref shape) don't use destructure defaults
      // on property targets. If `defaultInit` is present on a property target,
      // skip silently rather than miscompile.
      if (defaultInit) {
        // Drop the value we just pushed; nothing to write without default-handling.
        fctx.body.push({ op: "drop" });
        // Also drop key + receiver — they're still on the stack.
        fctx.body.push({ op: "drop" });
        fctx.body.push({ op: "drop" });
        continue;
      }
      // __extern_set(receiver, key, value) -> void
      fctx.body.push({ op: "call", funcIdx: setFnIdx });
      continue;
    }

    if (!ts.isIdentifier(targetEl)) continue;

    let targetLocal = fctx.localMap.get(targetEl.text);
    let extSyncGlobalIdx: number | undefined;
    if (targetLocal === undefined) {
      const globalIdx = ctx.moduleGlobals.get(targetEl.text);
      if (globalIdx === undefined) continue;
      const globalDef = ctx.mod.globals[localGlobalIdx(ctx, globalIdx)];
      const globalType = globalDef?.type ?? { kind: "externref" as const };
      targetLocal = allocLocal(fctx, targetEl.text, globalType);
      extSyncGlobalIdx = globalIdx;
    }

    // #1258 — if the target identifier is a boxed capture (mutable closure
    // capture re-aimed at a ref-cell), the value must go through `struct.set`
    // on the cell, not a direct `local.set` (which would overwrite the
    // ref-cell ref with the value, breaking the closure's view). Detect via
    // `fctx.boxedCaptures` and emit the boxed-write shape.
    const boxedCap = fctx.boxedCaptures?.get(targetEl.text);
    if (boxedCap && !defaultInit) {
      // Boxed-capture path: <local.get cell-ref> <value> <struct.set 0>
      fctx.body.push({ op: "local.get", index: targetLocal });
      // Push value: src[i]
      pushElemRead(i);
      // Coerce value to the cell's inner type if needed (refCell stores valType)
      if (boxedCap.valType.kind !== "externref") {
        coerceType(ctx, fctx, { kind: "externref" }, boxedCap.valType);
      }
      fctx.body.push({
        op: "struct.set",
        typeIdx: boxedCap.refCellTypeIdx,
        fieldIdx: 0,
      });
      if (extSyncGlobalIdx !== undefined) {
        // Re-load through the cell for global sync
        fctx.body.push({ op: "local.get", index: targetLocal });
        fctx.body.push({
          op: "struct.get",
          typeIdx: boxedCap.refCellTypeIdx,
          fieldIdx: 0,
        });
        fctx.body.push({ op: "global.set", index: extSyncGlobalIdx });
      }
      continue;
    }

    // #1510 — boxed-capture target WITH default initializer.
    // The pre-#1510 code fell through to `emitDefaultValueCheck` which
    // emitted `local.set` directly on the captured param — overwriting
    // the box-ref instead of writing through the cell. The mutation was
    // invisible to the outer scope's box, which silently kept the old
    // value (e.g. -1 from a `let v = -1` decl). Test262 cases:
    //   - language/statements/for-await-of/async-{gen,func}-decl-dstr-
    //     array-elem-init-assignment.js — `[v = expr] of …` where `v` is
    //     a `let`-bound outer variable captured by the async function.
    // Spec §13.15.5.5 ArrayAssignmentPattern requires PutValue on the
    // LHS; for a boxed-capture variable that means `struct.set` on
    // field 0 of the cell.
    if (boxedCap && defaultInit) {
      const valType = boxedCap.valType;
      const undefIdx = ensureExternIsUndefined(ctx, fctx);
      // Push the box-ref for the eventual struct.set.
      fctx.body.push({ op: "local.get", index: targetLocal });
      // Get the extracted value: src[i] -> externref
      pushElemRead(i);
      // Tee into a temp so we can both test-undefined and reuse on else.
      const tmpExt = allocLocal(fctx, `__forof_dflt_ext_${fctx.locals.length}`, { kind: "externref" });
      fctx.body.push({ op: "local.tee", index: tmpExt });
      // Test undefined-ness (using __extern_is_undefined; JS spec applies
      // defaults only on `undefined`, NOT on `null`).
      if (undefIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx: undefIdx });
      } else {
        // Fallback: ref.is_null treats null AS undefined — imprecise but safer
        // than crashing. The runtime always exposes __extern_is_undefined.
        fctx.body.push({ op: "ref.is_null" });
      }
      // Build then-branch (default fires): compile default to valType.
      const thenInstrs = collectInstrs(fctx, () => {
        compileExpression(ctx, fctx, defaultInit, valType);
      });
      // Build else-branch (value used as-is): coerce externref -> valType.
      const elseInstrs = collectInstrs(fctx, () => {
        fctx.body.push({ op: "local.get", index: tmpExt });
        if (valType.kind !== "externref") {
          coerceType(ctx, fctx, { kind: "externref" }, valType);
        }
      });
      fctx.body.push({
        op: "if",
        blockType: { kind: "val", type: valType },
        then: thenInstrs,
        else: elseInstrs,
      });
      // Now stack: [box-ref, value:valType]
      fctx.body.push({
        op: "struct.set",
        typeIdx: boxedCap.refCellTypeIdx,
        fieldIdx: 0,
      });
      if (extSyncGlobalIdx !== undefined) {
        // Re-load through the cell for global sync
        fctx.body.push({ op: "local.get", index: targetLocal });
        fctx.body.push({
          op: "struct.get",
          typeIdx: boxedCap.refCellTypeIdx,
          fieldIdx: 0,
        });
        fctx.body.push({ op: "global.set", index: extSyncGlobalIdx });
      }
      continue;
    }

    // Emit: src[i] -> externref
    pushElemRead(i);

    if (defaultInit) {
      const targetType = getLocalType(fctx, targetLocal);
      emitDefaultValueCheck(ctx, fctx, { kind: "externref" }, targetLocal, defaultInit, targetType ?? undefined);
    } else {
      // Coerce externref to target local's type and set
      emitCoercedLocalSet(ctx, fctx, targetLocal, { kind: "externref" });
    }

    emitGlobalSyncWriteback(ctx, fctx, targetLocal, extSyncGlobalIdx);
  }
}

/**
 * Handle assignment destructuring for the iterator protocol path.
 * Element is externref — use __extern_get(elem, key) to extract properties/indices.
 */
export function compileForOfIteratorAssignDestructuring(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.ObjectLiteralExpression | ts.ArrayLiteralExpression,
  elemLocal: number,
  stmt: ts.ForOfStatement,
): void {
  // Ensure __extern_get is available (#1866: ensureLateImport routes to the
  // native object-runtime impl under --target standalone — no leaked
  // `env::__extern_get` host import — and to the host import in JS-host mode).
  ensureLateImport(ctx, "__extern_get", [{ kind: "externref" }, { kind: "externref" }], [{ kind: "externref" }]);
  flushLateImportShifts(ctx, fctx);
  let getIdx = ctx.funcMap.get("__extern_get");
  if (getIdx === undefined) return;

  if (ts.isObjectLiteralExpression(expr)) {
    // for ({a, b} of iterable) — use __extern_get(elem, "propName") for each property
    for (const prop of expr.properties) {
      if (ts.isSpreadAssignment(prop)) continue;
      if (!ts.isShorthandPropertyAssignment(prop) && !ts.isPropertyAssignment(prop)) continue;

      // (#4447) Numeric-literal keys count: `for ([...{ 1: x }] of [[1,2,3]])`
      // reads index 1 of the rest slice. §13.2.5.5 canonicalises a numeric
      // PropertyName to its string form, which `prop.name.text` already is.
      const propName = ts.isShorthandPropertyAssignment(prop)
        ? prop.name.text
        : ts.isIdentifier(prop.name)
          ? prop.name.text
          : ts.isStringLiteral(prop.name) || ts.isNumericLiteral(prop.name)
            ? prop.name.text
            : undefined;
      if (!propName) continue;

      // (#4447) Same (target, default) split as the struct path — `{ k: t = d }`
      // is a PropertyAssignment over the AssignmentExpression `t = d`, and
      // `{ k = d }` a ShorthandPropertyAssignment with an
      // `objectAssignmentInitializer`. Neither was recognised here: the target
      // fell back to the KEY name and the default was dropped.
      const targetExpr: ts.Expression = ts.isShorthandPropertyAssignment(prop)
        ? prop.name
        : ts.isBinaryExpression(prop.initializer) && prop.initializer.operatorToken.kind === ts.SyntaxKind.EqualsToken
          ? prop.initializer.left
          : prop.initializer;
      const defaultInit: ts.Expression | undefined = ts.isShorthandPropertyAssignment(prop)
        ? prop.objectAssignmentInitializer
        : ts.isBinaryExpression(prop.initializer) && prop.initializer.operatorToken.kind === ts.SyntaxKind.EqualsToken
          ? prop.initializer.right
          : undefined;
      const isMemberTarget = ts.isPropertyAccessExpression(targetExpr) || ts.isElementAccessExpression(targetExpr);
      const targetName = ts.isIdentifier(targetExpr) ? targetExpr.text : propName;

      /** Push `__extern_get(elem, "propName")` — the read shared by every arm. */
      const pushPropRead = (): boolean => {
        // Register string constant for property name.
        addStringConstantGlobal(ctx, propName);
        // Refresh getIdx in case addStringConstantGlobal shifted indices.
        getIdx = ctx.funcMap.get("__extern_get");
        if (getIdx === undefined) return false;
        // (#51) Materialize the key via the dual-mode helper — nativeStrings
        // stores a `-1` sentinel global so a bare `global.get` would crash
        // binary emit.
        fctx.body.push({ op: "local.get", index: elemLocal });
        for (const instr of stringConstantExternrefInstrs(ctx, propName)) fctx.body.push(instr);
        fctx.body.push({ op: "call", funcIdx: getIdx });
        return true;
      };

      // (#4447) Nested pattern in the value position — `for ({ x: { y } } of …)`.
      // Read the property, apply any default, then recurse so the nested value
      // performs its own RequireObjectCoercible / GetIterator (an absent or
      // `undefined`/`null` property must throw TypeError, not bind silently).
      if (ts.isObjectLiteralExpression(targetExpr) || ts.isArrayLiteralExpression(targetExpr)) {
        const nestedLocal = allocLocal(fctx, `__forof_iternested_${fctx.locals.length}`, { kind: "externref" });
        if (!pushPropRead()) continue;
        if (defaultInit) {
          emitDefaultValueCheck(
            ctx,
            fctx,
            { kind: "externref" },
            nestedLocal,
            defaultInit,
            { kind: "externref" },
            true,
          );
        } else {
          fctx.body.push({ op: "local.set", index: nestedLocal });
        }
        destructureNestedExternrefPattern(ctx, fctx, targetExpr, nestedLocal, stmt);
        continue;
      }

      // (#4447) Member-expression target — `for ({k: obj.y} of iterable)`.
      // Route through the #2664 member-set dispatcher via a temp, mirroring
      // the struct path's #2869 arm.
      if (isMemberTarget) {
        const tmpM = allocLocal(fctx, `__forof_itermemtgt_${fctx.locals.length}`, { kind: "externref" });
        if (!pushPropRead()) continue;
        if (defaultInit) {
          emitDefaultValueCheck(ctx, fctx, { kind: "externref" }, tmpM, defaultInit, { kind: "externref" }, true);
        } else {
          fctx.body.push({ op: "local.set", index: tmpM });
        }
        emitAssignToTarget(ctx, fctx, targetExpr, tmpM, { kind: "externref" });
        continue;
      }

      let targetLocal = fctx.localMap.get(targetName);
      let iterObjSyncGlobalIdx: number | undefined;
      if (targetLocal === undefined) {
        const globalIdx = ctx.moduleGlobals.get(targetName);
        if (globalIdx === undefined) continue;
        const globalDef = ctx.mod.globals[localGlobalIdx(ctx, globalIdx)];
        const globalType = globalDef?.type ?? { kind: "externref" as const };
        targetLocal = allocLocal(fctx, targetName, globalType);
        iterObjSyncGlobalIdx = globalIdx;
      }

      // (#4447) Boxed-capture target: write THROUGH the ref cell.
      const boxedCapIter = fctx.boxedCaptures?.get(targetName);
      if (boxedCapIter) {
        const tmpB = allocLocal(fctx, `__forof_iterdflt_${fctx.locals.length}`, { kind: "externref" });
        if (!pushPropRead()) continue;
        if (defaultInit) {
          emitDefaultValueCheck(ctx, fctx, { kind: "externref" }, tmpB, defaultInit, { kind: "externref" }, true);
        } else {
          fctx.body.push({ op: "local.set", index: tmpB });
        }
        fctx.body.push({ op: "local.get", index: tmpB });
        emitBoxedForOfAssignStore(ctx, fctx, targetLocal, { kind: "externref" }, boxedCapIter);
        continue;
      }

      if (!pushPropRead()) continue;

      if (defaultInit) {
        // §13.15.5.4 step 4: the initializer fires only when the read is
        // `undefined` — object-property semantics, so a genuine `null` keeps.
        const targetTypeI = getLocalType(fctx, targetLocal);
        emitDefaultValueCheck(
          ctx,
          fctx,
          { kind: "externref" },
          targetLocal,
          defaultInit,
          targetTypeI ?? undefined,
          true,
        );
      } else {
        // Coerce externref to target local's type and set
        emitCoercedLocalSet(ctx, fctx, targetLocal, { kind: "externref" });
      }

      emitGlobalSyncWritebackByName(ctx, fctx, targetLocal, targetName, iterObjSyncGlobalIdx !== undefined);
    }
  } else if (ts.isArrayLiteralExpression(expr)) {
    // for ([x, y] of iterable) — use __extern_get(elem, box(i)) for each element

    // Ensure __box_number is available
    let boxIdx = ctx.funcMap.get("__box_number");
    if (boxIdx === undefined) {
      const importsBefore = ctx.numImportFuncs;
      const boxType = addFuncType(ctx, [{ kind: "f64" }], [{ kind: "externref" }]);
      addImport(ctx, "env", "__box_number", { kind: "func", typeIdx: boxType });
      shiftLateImportIndices(ctx, fctx, importsBefore, ctx.numImportFuncs - importsBefore);
      boxIdx = ctx.funcMap.get("__box_number");
      // Refresh getIdx since it may have shifted
      getIdx = ctx.funcMap.get("__extern_get");
    }
    if (boxIdx === undefined || getIdx === undefined) return;

    // #1258 — same property-access / boxed-capture handling as
    // compileForOfAssignDestructuringExternref (line 1503). The for-of-of-an-
    // iterable path (any-typed iterable, e.g. `let arr: any = …; for ([x.y] of arr)`)
    // routes through HERE, not the array fast-path; both need the same fixes.
    let setIdxIter: number | undefined;
    const ensureExternSetIter = (): number | undefined => {
      if (setIdxIter !== undefined) return setIdxIter;
      setIdxIter = ctx.funcMap.get("__extern_set");
      if (setIdxIter === undefined) {
        const importsBefore = ctx.numImportFuncs;
        const setType = addFuncType(ctx, [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }], []);
        addImport(ctx, "env", "__extern_set", {
          kind: "func",
          typeIdx: setType,
        });
        shiftLateImportIndices(ctx, fctx, importsBefore, ctx.numImportFuncs - importsBefore);
        setIdxIter = ctx.funcMap.get("__extern_set");
        // Refresh boxIdx/getIdx since they may have shifted.
        boxIdx = ctx.funcMap.get("__box_number");
        getIdx = ctx.funcMap.get("__extern_get");
      }
      return setIdxIter;
    };

    for (let i = 0; i < expr.elements.length; i++) {
      const el = expr.elements[i]!;
      if (ts.isOmittedExpression(el)) continue;
      if (ts.isSpreadElement(el)) {
        // (#2602) Rest element on the generic iterator path (any-typed iterable
        // / generator source, incl. for-await). The element local is externref —
        // push it directly and slice from index `i`.
        fctx.body.push({ op: "local.get", index: elemLocal });
        emitForOfRestAssignment(ctx, fctx, el, i, (name) => ctx.moduleGlobals.get(name), stmt);
        continue;
      }

      // Handle assignment with default: [v = 10]
      let targetElIter: ts.Expression = el;
      let defaultInitIter: ts.Expression | undefined;
      if (ts.isBinaryExpression(el) && el.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        targetElIter = el.left;
        defaultInitIter = el.right;
      }

      // #1258 — Property/element-access target: `[x.y] of iterable`.
      if (ts.isPropertyAccessExpression(targetElIter) || ts.isElementAccessExpression(targetElIter)) {
        const setFnIdx = ensureExternSetIter();
        if (setFnIdx === undefined || boxIdx === undefined || getIdx === undefined) continue;
        const recvType = compileExpression(ctx, fctx, targetElIter.expression, {
          kind: "externref",
        });
        if (recvType && recvType.kind !== "externref") {
          coerceType(ctx, fctx, recvType, { kind: "externref" });
        }
        if (recvType === null) {
          fctx.body.push({ op: "ref.null.extern" });
        }
        if (ts.isPropertyAccessExpression(targetElIter)) {
          const propName = targetElIter.name.text;
          // (#51) Dual-mode key materialization (nativeStrings `-1` sentinel).
          addStringConstantGlobal(ctx, propName);
          for (const instr of stringConstantExternrefInstrs(ctx, propName)) fctx.body.push(instr);
        } else {
          const keyType = compileExpression(ctx, fctx, targetElIter.argumentExpression, { kind: "externref" });
          if (keyType && keyType.kind !== "externref") {
            coerceType(ctx, fctx, keyType, { kind: "externref" });
          }
          if (keyType === null) {
            fctx.body.push({ op: "ref.null.extern" });
          }
        }
        fctx.body.push({ op: "local.get", index: elemLocal });
        fctx.body.push({ op: "f64.const", value: i });
        fctx.body.push({ op: "call", funcIdx: boxIdx });
        fctx.body.push({ op: "call", funcIdx: getIdx! });
        if (defaultInitIter) {
          // Out-of-scope for #1258: defaults on property targets. Drop and skip.
          fctx.body.push({ op: "drop" });
          fctx.body.push({ op: "drop" });
          fctx.body.push({ op: "drop" });
          continue;
        }
        fctx.body.push({ op: "call", funcIdx: setFnIdx });
        continue;
      }

      if (!ts.isIdentifier(targetElIter)) continue;

      let targetLocal = fctx.localMap.get(targetElIter.text);
      let iterArrSyncGlobalIdx: number | undefined;
      if (targetLocal === undefined) {
        const globalIdx = ctx.moduleGlobals.get(targetElIter.text);
        if (globalIdx === undefined) continue;
        const globalDef = ctx.mod.globals[localGlobalIdx(ctx, globalIdx)];
        const globalType = globalDef?.type ?? { kind: "externref" as const };
        targetLocal = allocLocal(fctx, targetElIter.text, globalType);
        iterArrSyncGlobalIdx = globalIdx;
      }

      // #1258 — boxed-capture identifier path: same logic as the typed-array
      // version. See compileForOfAssignDestructuringExternref for full notes.
      const boxedCap = fctx.boxedCaptures?.get(targetElIter.text);
      if (boxedCap && !defaultInitIter) {
        fctx.body.push({ op: "local.get", index: targetLocal });
        fctx.body.push({ op: "local.get", index: elemLocal });
        fctx.body.push({ op: "f64.const", value: i });
        fctx.body.push({ op: "call", funcIdx: boxIdx });
        fctx.body.push({ op: "call", funcIdx: getIdx! });
        if (boxedCap.valType.kind !== "externref") {
          coerceType(ctx, fctx, { kind: "externref" }, boxedCap.valType);
        }
        fctx.body.push({
          op: "struct.set",
          typeIdx: boxedCap.refCellTypeIdx,
          fieldIdx: 0,
        });
        if (iterArrSyncGlobalIdx !== undefined) {
          fctx.body.push({ op: "local.get", index: targetLocal });
          fctx.body.push({
            op: "struct.get",
            typeIdx: boxedCap.refCellTypeIdx,
            fieldIdx: 0,
          });
          fctx.body.push({ op: "global.set", index: iterArrSyncGlobalIdx });
        }
        continue;
      }

      // #1510 — boxed-capture target WITH default initializer (iterator path).
      // Mirror of the array-path fix in compileForOfAssignDestructuringExternref.
      // Without this, defaults on captured `let`-bound targets in for-await-of
      // (over an arbitrary iterable) silently lose the write (overwrites the
      // box-ref) or trap dereferencing a null pointer when coerceType emits
      // ref.as_non_null on a null cell.
      if (boxedCap && defaultInitIter) {
        const valType = boxedCap.valType;
        const undefIdx = ensureExternIsUndefined(ctx, fctx);
        fctx.body.push({ op: "local.get", index: targetLocal });
        fctx.body.push({ op: "local.get", index: elemLocal });
        fctx.body.push({ op: "f64.const", value: i });
        fctx.body.push({ op: "call", funcIdx: boxIdx! });
        fctx.body.push({ op: "call", funcIdx: getIdx! });
        const tmpExt = allocLocal(fctx, `__forit_dflt_ext_${fctx.locals.length}`, { kind: "externref" });
        fctx.body.push({ op: "local.tee", index: tmpExt });
        if (undefIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx: undefIdx });
        } else {
          fctx.body.push({ op: "ref.is_null" });
        }
        const thenInstrs = collectInstrs(fctx, () => {
          compileExpression(ctx, fctx, defaultInitIter!, valType);
        });
        const elseInstrs = collectInstrs(fctx, () => {
          fctx.body.push({ op: "local.get", index: tmpExt });
          if (valType.kind !== "externref") {
            coerceType(ctx, fctx, { kind: "externref" }, valType);
          }
        });
        fctx.body.push({
          op: "if",
          blockType: { kind: "val", type: valType },
          then: thenInstrs,
          else: elseInstrs,
        });
        fctx.body.push({
          op: "struct.set",
          typeIdx: boxedCap.refCellTypeIdx,
          fieldIdx: 0,
        });
        if (iterArrSyncGlobalIdx !== undefined) {
          fctx.body.push({ op: "local.get", index: targetLocal });
          fctx.body.push({
            op: "struct.get",
            typeIdx: boxedCap.refCellTypeIdx,
            fieldIdx: 0,
          });
          fctx.body.push({ op: "global.set", index: iterArrSyncGlobalIdx });
        }
        continue;
      }

      // Emit: __extern_get(elem, box(i)) -> externref
      fctx.body.push({ op: "local.get", index: elemLocal });
      fctx.body.push({ op: "f64.const", value: i });
      fctx.body.push({ op: "call", funcIdx: boxIdx });
      fctx.body.push({ op: "call", funcIdx: getIdx! });

      if (defaultInitIter) {
        const targetType = getLocalType(fctx, targetLocal);
        emitDefaultValueCheck(ctx, fctx, { kind: "externref" }, targetLocal, defaultInitIter, targetType ?? undefined);
      } else {
        // Coerce externref to target local's type and set
        emitCoercedLocalSet(ctx, fctx, targetLocal, { kind: "externref" });
      }

      emitGlobalSyncWriteback(ctx, fctx, targetLocal, iterArrSyncGlobalIdx);
    }
  }
}
