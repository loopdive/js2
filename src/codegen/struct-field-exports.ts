// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// struct-field-exports.ts — the `__get_field_*` / `__set_field_*` /
// `__struct_field_names` export subsystem (#3272, extracted verbatim from
// index.ts). Emits ref.test/ref.cast shape-dispatch getters/setters so a JS
// host can read/write WasmGC struct fields that are otherwise opaque, plus the
// per-shape field-name-collision resolution and shape-id patching. The getter
// dispatch builders (buildNestedIfElse / buildGetterExtract) are pulled in here
// since they are used only by this subsystem. Called by the compile driver
// (generateModule), which imports these back.

import type { FieldDef, Instr, ValType, WasmFunction } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { addFuncType } from "./registry/types.js";
import { addStringConstantGlobal, addUnionImports } from "./registry/imports.js";
import { isSyntheticStructName } from "./emit-helpers.js";
import type { PresenceSlot } from "./fnctor-presence-bits.js"; // (#3780) packed own-presence flags
import { presenceSlotOf, presenceTestInstrs } from "./fnctor-presence-bits.js";
import { UNDEF_F64_BITS } from "./value-tags.js";
import { DATA_STRUCT_HOST_BRIDGE_ORDINAL, publishDataStructHostBridge } from "./data-struct-host-bridge.js";
import { ensureLateImport, flushLateImportShifts } from "./shared.js";

/**
 * Emit exported getter/setter helper functions so the JS runtime can read
 * WasmGC struct fields that are otherwise opaque to JavaScript.
 *
 * For each unique field name across all struct types, we emit:
 *   __sget_<name>(externref) -> externref
 * The function converts the externref to anyref, tries ref.test for each
 * struct type that has that field, extracts the field via struct.get,
 * and converts the result to externref.
 *
 * Numeric fields (f64, i32) are boxed via __box_number import.
 * Ref/ref_null fields are converted via extern.convert_any.
 * The runtime discovers these exports and uses them as fallback when
 * direct JS property access on a WasmGC struct returns undefined.
 */
export function emitStructFieldGetters(ctx: CodegenContext): void {
  try {
    _emitStructFieldGettersInner(ctx);
  } catch (e: any) {
    // Non-fatal: if getter emission fails, the module still works
    // (the runtime just can't read struct fields from JS)
  }
}

/**
 * #2847 — emit per-property own-presence queries for conditionally initialized
 * fields. `__shas_<name>(obj) -> i32` returns the hidden presence bit for a
 * tracked shape, 1 for an ordinary always-present shape with that field, and 0
 * for unrelated values. The host filters `__struct_field_names` through these
 * queries, distinguishing an untouched default slot from explicit null/zero.
 */
export function emitStructFieldPresenceGetters(ctx: CodegenContext): void {
  if (ctx.nativeStrings) return;
  const trackedNames = new Set<string>();
  for (const fields of ctx.structFields.values()) {
    for (const field of fields) {
      if (field?.presenceTracked) trackedNames.add(field.name);
    }
  }
  if (trackedNames.size === 0) return;

  const typeIdx = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "i32" }], "$shas_type");
  for (const fieldName of trackedNames) {
    const entries: { structTypeIdx: number; presenceSlot?: PresenceSlot }[] = [];
    for (const [structName, fields] of ctx.structFields) {
      if (isSyntheticStructName(structName)) continue;
      const structTypeIdx = ctx.structMap.get(structName);
      if (structTypeIdx === undefined) continue;
      const fieldIdx = fields.findIndex((field) => field?.name === fieldName);
      if (fieldIdx < 0) continue;
      const presenceSlot = presenceSlotOf(fields, fieldName);
      entries.push({
        structTypeIdx,
        ...(presenceSlot ? { presenceSlot } : {}),
      });
    }
    if (entries.length === 0) continue;

    let dispatch: Instr[] = [{ op: "i32.const", value: 0 }];
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i]!;
      const then: Instr[] =
        entry.presenceSlot !== undefined
          ? [
              { op: "local.get", index: 1 },
              { op: "ref.cast", typeIdx: entry.structTypeIdx },
              ...presenceTestInstrs(entry.structTypeIdx, entry.presenceSlot),
            ]
          : [{ op: "i32.const", value: 1 }];
      dispatch = [
        { op: "local.get", index: 1 },
        { op: "ref.test", typeIdx: entry.structTypeIdx },
        {
          op: "if",
          blockType: { kind: "val", type: { kind: "i32" } },
          then,
          else: dispatch,
        },
      ];
    }

    const funcName = `__shas_${fieldName}`;
    const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
    ctx.mod.functions.push({
      name: funcName,
      typeIdx,
      locals: [{ name: "__any", type: { kind: "anyref" } }],
      body: [{ op: "local.get", index: 0 }, { op: "any.convert_extern" }, { op: "local.set", index: 1 }, ...dispatch],
      exported: true,
    } as WasmFunction);
    ctx.mod.exports.push({ name: funcName, desc: { kind: "func", index: funcIdx } });
  }
}

/**
 * #2847 — export compiler-derived JS-boolean markers for host marshalling.
 * The marker is emitted only when whole-program analysis proved every visible
 * definition/write of the property boolean-producing. It covers both physical
 * struct slots and dynamic sidecar properties, including values that crossed a
 * generic closure bridge as boxed numeric 0/1.
 */
export function emitStructFieldBooleanMarkers(ctx: CodegenContext): void {
  if (ctx.nativeStrings || ctx.booleanPropertyNames.size === 0) return;
  const typeIdx = addFuncType(ctx, [], [{ kind: "i32" }], "$sbool_type");
  for (const fieldName of [...ctx.booleanPropertyNames].sort()) {
    const funcName = `__sbool_${fieldName}`;
    const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
    ctx.mod.functions.push({
      name: funcName,
      typeIdx,
      locals: [],
      body: [{ op: "i32.const", value: 1 }],
      exported: true,
    } as WasmFunction);
    ctx.mod.exports.push({ name: funcName, desc: { kind: "func", index: funcIdx } });
  }
}

function _emitStructFieldGettersInner(ctx: CodegenContext): void {
  const mod = ctx.mod;

  // Collect all (fieldName → [{structTypeIdx, fieldIdx, fieldType}]) mappings
  type GetterEntry = {
    typeIdx: number;
    fieldIdx: number;
    fieldType: ValType;
    jsBoolean: boolean;
    shapeId?: number;
    shapeFieldIdx?: number;
  };
  const fieldMap = new Map<string, GetterEntry[]>();

  for (const [structName, fields] of ctx.structFields) {
    const typeIdx = ctx.structMap.get(structName);
    if (typeIdx === undefined) continue;

    // Skip internal/wrapper types
    if (isSyntheticStructName(structName)) continue;

    const shapeId = ctx.shapeIdByStructName.get(structName);
    const shapeFieldIdx = shapeId !== undefined ? fields.findIndex((field) => field?.name === "$shape") : -1;

    for (let i = 0; i < fields.length; i++) {
      const field = fields[i];
      if (!field || !field.type) continue;
      // Skip fields with names that would create invalid export names
      if (!field.name || isInternalStructFieldName(ctx, structName, field.name)) continue;

      let entries = fieldMap.get(field.name);
      if (!entries) {
        entries = [];
        fieldMap.set(field.name, entries);
      }
      entries.push({
        typeIdx,
        fieldIdx: i,
        fieldType: field.type,
        jsBoolean: field.jsBoolean === true || (field.type.kind === "i32" && field.type.boolean === true),
        ...(shapeId !== undefined && shapeFieldIdx >= 0 ? { shapeId, shapeFieldIdx } : {}),
      });
    }
  }

  if (fieldMap.size === 0) return;

  const hasSymbolField = [...fieldMap.values()].some((entries) =>
    entries.some((entry) => entry.fieldType.kind === "i32" && entry.fieldType.symbol === true),
  );
  if (hasSymbolField && !ctx.standalone && !ctx.wasi) {
    ensureLateImport(ctx, "__box_symbol", [{ kind: "i32" }], [{ kind: "externref" }]);
    flushLateImportShifts(ctx, null);
  }

  // (#1320) A getter that returns a numeric/boolean field as externref boxes it
  // via __box_number / __box_boolean. Those helpers are registered lazily at
  // boxing call-sites during expression compilation — but a module whose only
  // numeric/boolean struct field is read *exclusively through the host* (e.g. a
  // function returns `{ value, done }` to JS, which then reads `.done`) never
  // hits such a call-site, so the helpers are still absent here. Without them
  // the getter fell through to `drop; ref.null.extern` and `__sget_done`
  // returned null (and `__sget_<num>` would have boxed as a number — #1788).
  // Register the union helpers (which include __box_number / __box_boolean)
  // BEFORE any getter funcIdx is computed, so the emitted getters reference the
  // final post-shift indices. addUnionImports is idempotent (hasUnionImports
  // guard), uses the immediate finalize-phase index shift, and in
  // standalone/WASI mode routes to the Wasm-native helper bodies (no env::*
  // import). We only call it when at least one field bucket would emit a box
  // call (an extern-mode bucket carrying a numeric/boolean field), so a module
  // with no such fields stays byte-identical.
  let needsBox = false;
  for (const entries of fieldMap.values()) {
    const hasF64 = entries.some((e) => e.fieldType.kind === "f64");
    const hasI32 = entries.some((e) => e.fieldType.kind === "i32" && e.fieldType.symbol !== true);
    const hasRef = entries.some((e) => e.fieldType.kind !== "f64" && e.fieldType.kind !== "i32");
    const hasBool = entries.some((e) => e.jsBoolean);
    const hasSymbol = entries.some((e) => e.fieldType.kind === "i32" && e.fieldType.symbol === true);
    const allF64 = hasF64 && !hasI32 && !hasRef && !hasBool;
    const allI32 = hasI32 && !hasF64 && !hasRef && !hasBool && !hasSymbol;
    // f64-only / i32-only buckets return the raw value (no box call). Only a
    // mixed/boolean (extern-mode) bucket carrying a numeric or boolean field
    // emits a __box_number / __box_boolean call.
    if (allF64 || allI32) continue;
    if (hasF64 || hasI32 || hasBool) {
      needsBox = true;
      break;
    }
  }
  if (needsBox) addUnionImports(ctx);

  // Find __box_number import for numeric boxing (may be undefined)
  const boxNumIdx = ctx.funcMap.get("__box_number");
  // (#1788) __box_boolean for boolean-branded i32 fields — boxes the stored i32
  // as a JS boolean so `typeof o.x === "boolean"` and `o.x === true` hold on a
  // dynamic read, instead of the value boxing as the number 1.
  const boxBoolIdx = ctx.funcMap.get("__box_boolean");
  const boxSymbolIdx = ctx.funcMap.get("__box_symbol");
  // (#3032 W6 / #2979) The native-generator IteratorResult `value` field uses
  // the UNDEF_F64 signaling-NaN sentinel as its absent/done marker — the
  // `__sget_value` getter (the host `_safeGet` / `__gen_result_value` shim
  // fallback for raw structs) must canonicalize it to `undefined` instead of
  // boxing it as NaN. Host lane: the REAL `undefined` via `__get_undefined`
  // when some read site already registered it (funcMap-read-only — getters are
  // emitted at finalize and must not add imports); otherwise/standalone: the
  // null externref (the standalone canonical undefined).
  const sentinelValueTypeIdxs = new Set<number>();
  for (const [structName, fields] of ctx.structFields) {
    if (!structName.startsWith("__NativeGeneratorResult_")) continue;
    const typeIdx = ctx.structMap.get(structName);
    if (typeIdx === undefined) continue;
    const valueField = fields[0];
    if (valueField && valueField.name === "value" && valueField.type?.kind === "f64") {
      sentinelValueTypeIdxs.add(typeIdx);
    }
  }
  const getUndefIdx = ctx.nativeStrings ? undefined : ctx.funcMap.get("__get_undefined");
  const sentinelUndefInstrs: Instr[] =
    getUndefIdx !== undefined ? [{ op: "call", funcIdx: getUndefIdx }] : [{ op: "ref.null.extern" }];

  // Two getter types: one for externref result, one for f64 result
  const getterExternTypeIdx = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "externref" }], "$sget_extern_type");
  const getterF64TypeIdx = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "f64" }], "$sget_f64_type");
  const getterI32TypeIdx = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "i32" }], "$sget_i32_type");

  for (const [fieldName, entries] of fieldMap) {
    // Determine the "best" return type — if all entries for this field are
    // the same kind we can use a specific return type; if mixed, use externref.
    const hasF64 = entries.some((e) => e.fieldType.kind === "f64");
    const hasI32 = entries.some((e) => e.fieldType.kind === "i32");
    const hasRef = entries.some((e) => e.fieldType.kind !== "f64" && e.fieldType.kind !== "i32");
    // (#1788) A boolean-branded i32 field must box (so the host sees a JS
    // boolean, not the number 1). The raw-i32 returnMode returns a bare i32,
    // which the host reads back as a number — so an all-i32 bucket that
    // contains any boolean field is forced to externref/box mode instead.
    const hasBool = entries.some((e) => e.jsBoolean);
    const hasSymbol = entries.some((e) => e.fieldType.kind === "i32" && e.fieldType.symbol === true);
    const allF64 = hasF64 && !hasI32 && !hasRef && !hasBool;
    const allI32 = hasI32 && !hasF64 && !hasRef && !hasBool && !hasSymbol;

    let getterTypeIdx: number;
    let returnMode: "extern" | "f64" | "i32";
    if (allF64) {
      getterTypeIdx = getterF64TypeIdx;
      returnMode = "f64";
    } else if (allI32) {
      getterTypeIdx = getterI32TypeIdx;
      returnMode = "i32";
    } else {
      getterTypeIdx = getterExternTypeIdx;
      returnMode = "extern";
    }

    const funcName = `__sget_${fieldName}`;
    const funcIdx = ctx.numImportFuncs + mod.functions.length;
    const anyLocal = 1; // first local after params (local 0 = externref param)

    // (#3032 W6) Sentinel-aware arms only apply to the `value` getter in
    // extern mode; they need an f64 scratch local (index 2).
    const sentinelArms =
      fieldName === "value" && returnMode === "extern" && boxNumIdx !== undefined
        ? { typeIdxs: sentinelValueTypeIdxs, undefInstrs: sentinelUndefInstrs, f64ScratchIdx: 2 }
        : undefined;
    const useSentinel = sentinelArms !== undefined && entries.some((e) => sentinelArms.typeIdxs.has(e.typeIdx));

    const funcBody = buildNestedIfElse(
      entries,
      anyLocal,
      boxNumIdx,
      returnMode,
      boxBoolIdx,
      boxSymbolIdx,
      useSentinel ? sentinelArms : undefined,
    );

    const locals: { name: string; type: ValType }[] = [{ name: "__any", type: { kind: "anyref" } }];
    if (useSentinel) locals.push({ name: "__sent_f64", type: { kind: "f64" } });

    mod.functions.push({
      name: funcName,
      typeIdx: getterTypeIdx,
      locals,
      body: funcBody,
      exported: true,
    } as WasmFunction);

    mod.exports.push({
      name: funcName,
      desc: { kind: "func", index: funcIdx },
    });

    // (#2038) Register in funcMap so the native iterator carrier's USER arm can
    // resolve `__sget_value` / `__sget_done` at finalize-fill time
    // (`fillNativeIteratorLateArms`). No other code looks `__sget_*` up by funcMap
    // key, so this is inert for every other path.
    ctx.funcMap.set(funcName, funcIdx);
  }

  // Emit __struct_field_names(externref) -> externref
  // Returns a comma-separated string of field names for the struct type of the argument.
  // The runtime uses this for Object.keys(), JSON.stringify(), for-in, and spread on opaque structs.
  emitStructFieldNamesExport(ctx, fieldMap);
}

/**
 * Emit exported `__sset_<name>(externref obj, externref val) -> ()` setters
 * symmetric to the existing `__sget_<name>` getters (#1630). The runtime
 * `_safeSet` calls these so a host `Object.assign(typedStruct, src)` (and
 * other MOP writes routed through `_wrapForHost` set-trap) reflects back
 * into the real WasmGC struct field rather than only updating the JS-side
 * sidecar. Without these setters, struct.field reads via compiled Wasm see
 * the initial value while sidecar reads via host see the updated value —
 * the asymmetry that masks `Object.assign` and similar writeback cases.
 *
 * Only mutable fields get setters; immutable singleton structs (boxed
 * number / boolean) are skipped to avoid `struct.set` validation errors.
 * Field-name buckets that mix kinds (f64 / i32 / ref) across struct types
 * are skipped so the sidecar still carries the write — homogeneous-kind
 * buckets cover the object-literal cases in test262.
 */
export function emitStructFieldSetters(ctx: CodegenContext): void {
  try {
    _emitStructFieldSettersInner(ctx);
  } catch {
    // Non-fatal: setter emission failure degrades to sidecar-only writeback
    // (the current pre-fix behaviour), the module still runs.
  }
}

function _emitStructFieldSettersInner(ctx: CodegenContext): void {
  const mod = ctx.mod;

  // Collect (fieldName → [{typeIdx, fieldIdx, fieldType, shapeId?, shapeFieldIdx?}])
  // mappings, but ONLY for mutable fields. Mirror the skip rules used by the
  // getter emitter so the two stay in lockstep.
  //
  // (#2009) For COLLIDING structs (those with a `$shape` field, set by
  // resolveSameShapeFieldNameCollisions), record the shape-id + `$shape` field
  // index so `buildSetterStore` can gate the write on the per-instance shape:
  // same-shape canonicalization makes `ref.test typeIdx` match a DIFFERENT
  // struct, so `__sset_b(target {a:1})` would otherwise write slot 0 of the
  // target (its `a`). The guard makes a mismatched write no-op (sidecar carries
  // it). Non-colliding structs leave shapeId undefined → no guard, byte-identical.
  type SetterEntry = {
    typeIdx: number;
    fieldIdx: number;
    fieldType: ValType;
    shapeId?: number;
    shapeFieldIdx?: number;
  };
  const fieldMap = new Map<string, SetterEntry[]>();

  for (const [structName, fields] of ctx.structFields) {
    const typeIdx = ctx.structMap.get(structName);
    if (typeIdx === undefined) continue;

    if (isSyntheticStructName(structName)) continue;

    const shapeId = ctx.shapeIdByStructName.get(structName);
    const shapeFieldIdx = shapeId !== undefined ? fields.findIndex((f) => f && f.name === "$shape") : -1;

    for (let i = 0; i < fields.length; i++) {
      const field = fields[i];
      if (!field || !field.type) continue;
      if (!field.name || isInternalStructFieldName(ctx, structName, field.name)) continue;
      // Only emit setters for mutable fields — `struct.set` on an immutable
      // field is a Wasm validation error (e.g. boxed-number singletons).
      if (!field.mutable) continue;

      let entries = fieldMap.get(field.name);
      if (!entries) {
        entries = [];
        fieldMap.set(field.name, entries);
      }
      entries.push({
        typeIdx,
        fieldIdx: i,
        fieldType: field.type,
        ...(shapeId !== undefined && shapeFieldIdx >= 0 ? { shapeId, shapeFieldIdx } : {}),
      });
    }
  }

  if (fieldMap.size === 0) return;

  const hasSymbolField = [...fieldMap.values()].some((entries) =>
    entries.some((entry) => entry.fieldType.kind === "i32" && entry.fieldType.symbol === true),
  );
  if (hasSymbolField && !ctx.standalone && !ctx.wasi) {
    ensureLateImport(ctx, "__unbox_symbol", [{ kind: "externref" }], [{ kind: "i32", symbol: true }]);
    flushLateImportShifts(ctx, null);
  }

  // Only kinds we can emit a correct `struct.set` for after the externref →
  // anyref convert. Abstract heap types other than `anyref` (eqref / structref /
  // funcref) would need a `ref.cast` to an abstract heap type, which the
  // current Instr encoding does not express — skip those ARMS so the
  // sidecar still carries the write.
  const isRefKind = (k: ValType["kind"]) =>
    k === "ref" || k === "ref_null" || k === "anyref" || k === "externref" || k === "ref_extern";

  // (#2853 bug B) Mixed-kind buckets are NO LONGER skipped. A skipped bucket
  // (e.g. `pos`, whose field kind differs across acorn's Parser /
  // RegExpValidationState structs) meant every HOST write (`state.pos = 0` via
  // a method-parameter access → `__extern_set` → `_safeSet`) landed in the
  // JS sidecar only, while every in-wasm `this.pos` access used the live
  // struct field — two stores for one key. Once the sidecar was seeded, host
  // reads (`_safeGet` first) saw the frozen sidecar value (0) forever, so
  // acorn's regexp validator compared a phantom `state.pos` and raised
  // "Unmatched ')'" on every group. Mixed buckets now use the externref
  // signature with per-arm coercion: numeric fields unbox via __unbox_number.
  // Ensure the union helpers exist BEFORE any setter funcIdx is computed
  // (mirrors the getter emitter's needsBox discipline / #1320).
  let needsUnbox = false;
  for (const entries of fieldMap.values()) {
    const allF64 = entries.every((e) => e.fieldType.kind === "f64");
    const allI32 =
      entries.every((e) => e.fieldType.kind === "i32") &&
      !entries.some((e) => e.fieldType.kind === "i32" && e.fieldType.symbol === true);
    if (allF64 || allI32) continue;
    if (
      entries.some((e) => e.fieldType.kind === "f64" || (e.fieldType.kind === "i32" && e.fieldType.symbol !== true))
    ) {
      needsUnbox = true;
      break;
    }
  }
  if (needsUnbox) addUnionImports(ctx);
  const unboxNumIdx = ctx.funcMap.get("__unbox_number");
  const unboxSymbolIdx = ctx.funcMap.get("__unbox_symbol");

  // Setter signatures: 3 variants by val type. All return i32 (1 = an arm
  // matched and wrote the live struct field, 0 = no arm matched) so the
  // runtime `_safeSet` can decide whether the sidecar must carry the value
  // (expando / unmatched shape) or must NOT shadow the live field (#2853 B).
  const setterExternTypeIdx = addFuncType(
    ctx,
    [{ kind: "externref" }, { kind: "externref" }],
    [{ kind: "i32" }],
    "$sset_extern_type",
  );
  const setterF64TypeIdx = addFuncType(
    ctx,
    [{ kind: "externref" }, { kind: "f64" }],
    [{ kind: "i32" }],
    "$sset_f64_type",
  );
  const setterI32TypeIdx = addFuncType(
    ctx,
    [{ kind: "externref" }, { kind: "i32" }],
    [{ kind: "i32" }],
    "$sset_i32_type",
  );

  for (const [fieldName, entries] of fieldMap) {
    const allF64 = entries.every((e) => e.fieldType.kind === "f64");
    const hasSymbol = entries.some((e) => e.fieldType.kind === "i32" && e.fieldType.symbol === true);
    const allI32 = entries.every((e) => e.fieldType.kind === "i32") && !hasSymbol;

    let setterTypeIdx: number;
    let valMode: "extern" | "f64" | "i32";
    let useEntries = entries;
    if (allF64) {
      setterTypeIdx = setterF64TypeIdx;
      valMode = "f64";
    } else if (allI32) {
      setterTypeIdx = setterI32TypeIdx;
      valMode = "i32";
    } else {
      // Ref-only AND mixed buckets: externref signature, per-arm coercion.
      // Arms whose field kind we cannot coerce from externref (i64 / f32 /
      // v128 / packed i8/i16, or numeric without __unbox_number) are dropped —
      // they return 0 and the sidecar carries those writes, as before.
      useEntries = entries.filter(
        (e) =>
          isRefKind(e.fieldType.kind) ||
          (e.fieldType.kind === "i32" &&
            e.fieldType.symbol === true &&
            (unboxSymbolIdx !== undefined || ((ctx.standalone || ctx.wasi) && ctx.symbolTypeIdx >= 0))) ||
          ((e.fieldType.kind === "f64" || (e.fieldType.kind === "i32" && e.fieldType.symbol !== true)) &&
            unboxNumIdx !== undefined),
      );
      if (useEntries.length === 0) continue;
      setterTypeIdx = setterExternTypeIdx;
      valMode = "extern";
    }

    const funcName = `__sset_${fieldName}`;
    const funcIdx = ctx.numImportFuncs + mod.functions.length;
    const anyLocal = 2; // locals after the two params (local 0 = obj, local 1 = val)
    const wroteLocal = 3; // i32 "an arm matched and wrote" flag (defaults 0)

    const funcBody = buildSetterNestedIfElse(
      ctx,
      useEntries,
      anyLocal,
      valMode,
      wroteLocal,
      unboxNumIdx,
      unboxSymbolIdx,
    );

    mod.functions.push({
      name: funcName,
      typeIdx: setterTypeIdx,
      locals: [
        { name: "__any", type: { kind: "anyref" } },
        { name: "__wrote", type: { kind: "i32" } },
      ],
      body: funcBody,
      exported: true,
    } as WasmFunction);

    mod.exports.push({
      name: funcName,
      desc: { kind: "func", index: funcIdx },
    });
  }
}

/** Build nested if/else for struct field setter dispatch. */
function buildSetterNestedIfElse(
  ctx: CodegenContext,
  entries: { typeIdx: number; fieldIdx: number; fieldType: ValType; shapeId?: number; shapeFieldIdx?: number }[],
  anyLocal: number,
  valMode: "extern" | "f64" | "i32",
  wroteLocal: number,
  unboxNumIdx?: number,
  unboxSymbolIdx?: number,
): Instr[] {
  const body: Instr[] = [];

  // Convert obj externref to anyref and store
  body.push({ op: "local.get", index: 0 });
  body.push({ op: "any.convert_extern" });
  body.push({ op: "local.set", index: anyLocal });

  // Chain: if (ref.test T1) { cast + struct.set T1 } else if (ref.test T2) { ... }
  let current: Instr[] = []; // final else: no-op (wrote flag stays 0)

  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!;
    let thenBranch = buildSetterStore(ctx, entry, anyLocal, valMode, wroteLocal, unboxNumIdx, unboxSymbolIdx);

    // (#2009) Colliding struct: `ref.test typeIdx` matched, but same-shape
    // canonicalization means the instance might be a DIFFERENT struct that
    // lacks this field. Gate the store on `struct.get $shape === entry.shapeId`
    // so a mismatched write no-ops (sidecar carries it) instead of corrupting
    // a same-slot field of the wrong struct.
    if (entry.shapeId !== undefined && entry.shapeFieldIdx !== undefined) {
      thenBranch = [
        { op: "local.get", index: anyLocal },
        { op: "ref.cast", typeIdx: entry.typeIdx },
        { op: "struct.get", typeIdx: entry.typeIdx, fieldIdx: entry.shapeFieldIdx },
        { op: "i32.const", value: entry.shapeId },
        { op: "i32.eq" },
        { op: "if", blockType: { kind: "empty" }, then: thenBranch },
      ];
    }

    const ifInstr: Instr = {
      op: "if",
      blockType: { kind: "empty" },
      then: thenBranch,
      else: current,
    };

    current = [{ op: "local.get", index: anyLocal }, { op: "ref.test", typeIdx: entry.typeIdx }, ifInstr];
  }

  body.push(...current);
  // Result: 1 iff an arm matched this receiver's runtime type and wrote.
  body.push({ op: "local.get", index: wroteLocal });
  return body;
}

/** Build the "then" branch that stores `val` (local 1) into a struct field
 *  and sets the `wroteLocal` success flag (#2853 B). */
function buildSetterStore(
  ctx: CodegenContext,
  entry: { typeIdx: number; fieldIdx: number; fieldType: ValType },
  anyLocal: number,
  valMode: "extern" | "f64" | "i32",
  wroteLocal: number,
  unboxNumIdx?: number,
  unboxSymbolIdx?: number,
): Instr[] {
  const then: Instr[] = [];
  const ft = entry.fieldType;
  const markWrote: Instr[] = [
    { op: "i32.const", value: 1 },
    { op: "local.set", index: wroteLocal },
  ];

  // Push the cast struct ref onto the stack
  then.push({ op: "local.get", index: anyLocal });
  then.push({ op: "ref.cast", typeIdx: entry.typeIdx });

  // Push the value (typed per valMode; for extern-mode buckets the arm
  // coerces per its own field kind below — mixed buckets are allowed, #2853 B).
  then.push({ op: "local.get", index: 1 });

  if (valMode === "extern") {
    // (#2831) Vec-typed field: the inbound externref may be a HOST-marshalled
    // array (or any externref), NOT a wasm vec — the prior unguarded
    // `any.convert_extern; ref.cast(_null) $vec` traps `illegal cast` (or, under
    // the `_safeSet` try/catch, degrades to a SILENTLY-DROPPED cross-rep write).
    // Route through the reserved host-aware materializer instead, which builds a
    // fresh vec of the exact target type on the slot (empty/non-empty/host/
    // same-rep/null uniformly). Value (local 1, externref) is already on stack.
    // Name-based lookup (funcMap stays in lockstep across late-import shifts);
    // undefined pre-reserve ⇒ falls back to the guarded cast below.
    const vecMatName = ft.kind === "ref" || ft.kind === "ref_null" ? ctx.vecFromExternMap?.get(ft.typeIdx) : undefined;
    const vecMatIdx = vecMatName !== undefined ? ctx.funcMap.get(vecMatName) : undefined;
    if (vecMatIdx !== undefined) {
      then.push({ op: "call", funcIdx: vecMatIdx });
      if (ft.kind === "ref") then.push({ op: "ref.as_non_null" });
      then.push({ op: "struct.set", typeIdx: entry.typeIdx, fieldIdx: entry.fieldIdx });
      then.push(...markWrote);
      return then;
    }
    // (#2853 B) Numeric field in an extern-mode (mixed) bucket: unbox the
    // externref value to f64 (Number coercion host-side), truncating for i32
    // fields. Boolean-branded i32 fields coerce true/false → 1/0 the same way.
    if (ft.kind === "i32" && ft.symbol === true) {
      if ((ctx.standalone || ctx.wasi) && ctx.symbolTypeIdx >= 0) {
        then.push({ op: "any.convert_extern" });
        then.push({ op: "ref.cast", typeIdx: ctx.symbolTypeIdx });
        then.push({ op: "struct.get", typeIdx: ctx.symbolTypeIdx, fieldIdx: 0 });
      } else {
        then.push({ op: "call", funcIdx: unboxSymbolIdx! });
      }
      then.push({ op: "struct.set", typeIdx: entry.typeIdx, fieldIdx: entry.fieldIdx });
      then.push(...markWrote);
      return then;
    }
    if (ft.kind === "f64" || ft.kind === "i32") {
      // Caller guarantees unboxNumIdx is defined for these arms (bucket filter).
      then.push({ op: "call", funcIdx: unboxNumIdx! });
      if (ft.kind === "i32") then.push({ op: "i32.trunc_sat_f64_s" });
      then.push({ op: "struct.set", typeIdx: entry.typeIdx, fieldIdx: entry.fieldIdx });
      then.push(...markWrote);
      return then;
    }
    // Remaining field kinds here: ref / ref_null / anyref / externref /
    // ref_extern (the bucket filter drops i64 / f32 / v128 / packed arms).
    // externref & ref_extern need no conversion; everything else converts
    // externref → anyref first, then typed-ref fields cast down to the
    // field's specific heap type. Cast failures trap; the runtime _safeSet
    // wraps the setter call in try/catch so a wrong-type assign degrades to
    // sidecar-only (the prior behaviour) rather than crashing.
    if (ft.kind === "ref" || ft.kind === "ref_null" || ft.kind === "anyref") {
      then.push({ op: "any.convert_extern" });
    }
    if (ft.kind === "ref") {
      then.push({ op: "ref.cast", typeIdx: ft.typeIdx });
    } else if (ft.kind === "ref_null") {
      then.push({ op: "ref.cast_null", typeIdx: ft.typeIdx });
    }
  }

  then.push({ op: "struct.set", typeIdx: entry.typeIdx, fieldIdx: entry.fieldIdx });
  then.push(...markWrote);
  return then;
}

/**
 * (#2009) Same-structural-shape field-name collision resolution.
 *
 * `{ aa: number }` and `{ bb: number }` compile to DISTINCT anon struct
 * typeIdxs (fieldsHashKey includes field names) — but they are STRUCTURALLY
 * identical (`struct (field (mut f64))`), so WasmGC iso-recursive
 * canonicalization makes them indistinguishable to `ref.test`. The host
 * `__struct_field_names` / `__sset_*` exports therefore mislabel / mis-write
 * every same-shape instance with the first-registered shape's names.
 *
 * Fix (opt-in, minimal blast radius): only structs that ACTUALLY collide — two+
 * anon object-literal structs that share field TYPES but differ in field NAMES —
 * get a hidden trailing `$shape` i32 field retro-stamped per-instance. The host
 * exports then read `$shape` to recover the instance's real names BY VALUE. A
 * struct with a unique field-name-shape is never touched (the common case stays
 * byte-identical, including all IR-path construction).
 *
 * Runs as a post-pass after every function body is final, so the struct.new
 * operand patch is uniform across the legacy AND IR backends (it walks emitted
 * `Instr` streams, not a specific construction path).
 */

/**
 * Is `fieldName` one of the compiler's own hidden slots on `structName`, rather
 * than a property the source actually wrote?
 *
 * The hidden slots (`$shape`, `$arity`, `$func`, `__tag`, …) are all `$`/`__`
 * prefixed, so a bare prefix test was used as the discriminator. But that
 * prefix is legal in a real property name, and the ecosystem uses it: React
 * stamps `$$typeof` on every element it creates, which the prefix test silently
 * erased from `__struct_field_names` / `__sget_*`. The consequence was not a
 * visible error — `Object.keys(element)` just omitted `$$typeof`, `switch
 * (x.$$typeof)` matched nothing and `JSON.stringify` dropped the key, so
 * `React.Children.*` and `isValidElement` quietly returned wrong answers for
 * every element that crossed the host bridge.
 *
 * `ctx.structInsertionOrder` records the keys an object literal literally
 * wrote, so it is the authority when present: a recorded name is a user
 * property no matter how it is spelled. Structs with no recording (named
 * classes, IR-fresh structs) keep the prefix heuristic unchanged.
 */
export function isInternalStructFieldName(ctx: CodegenContext, structName: string, fieldName: string): boolean {
  if (!fieldName.startsWith("$") && !fieldName.startsWith("__")) return false;
  return !ctx.structInsertionOrder.get(structName)?.includes(fieldName);
}

/**
 * (#2009 R3b) Permute a struct's slot-order field names into JS INSERTION order
 * for the host name export, using the per-literal order recorded in
 * `ctx.structInsertionOrder` (see its doc). MEMBERSHIP is preserved exactly:
 * the returned list is `slotNames` reordered, never added to or filtered — every
 * name still resolves to its `__sget_<name>` getter. Names present in the
 * insertion-order list come first in that order; any slot name not in the list
 * (defensive — should not happen for a literal-derived struct) keeps its
 * original relative position at the end. No recorded order ⇒ `slotNames`
 * unchanged (plain literals, IR-fresh structs, named classes).
 */
export function orderNamesByInsertion(ctx: CodegenContext, structName: string, slotNames: string[]): string[] {
  const order = ctx.structInsertionOrder.get(structName);
  if (!order || order.length === 0) return slotNames;
  const slotSet = new Set(slotNames);
  const ordered: string[] = [];
  const placed = new Set<string>();
  for (const name of order) {
    if (slotSet.has(name) && !placed.has(name)) {
      ordered.push(name);
      placed.add(name);
    }
  }
  // Append any slot name the insertion list did not cover, in slot order.
  for (const name of slotNames) {
    if (!placed.has(name)) {
      ordered.push(name);
      placed.add(name);
    }
  }
  return ordered;
}

export function resolveSameShapeFieldNameCollisions(ctx: CodegenContext): readonly number[] {
  // Structural-shape key = field TYPES only (the thing WasmGC canonicalizes on),
  // ignoring names and any pre-existing internal `$`/`__` fields. The hidden
  // identity is consumed both by host field-name exports and by standalone
  // closed-struct runtime finalizers; ref.test alone cannot distinguish
  // structurally equivalent anonymous structs.
  const typeKindKey = (t: ValType): string => {
    if (t.kind === "ref" || t.kind === "ref_null") return `${t.kind}:${(t as { typeIdx: number }).typeIdx}`;
    if (t.kind === "i32" && (t as { boolean?: true }).boolean) return "i32:bool";
    if (t.kind === "i32" && t.symbol === true) return "i32:sym";
    return t.kind;
  };
  type Member = { structName: string; typeIdx: number; names: string[] };
  const byShape = new Map<string, Member[]>();

  for (const [structName, fields] of ctx.structFields) {
    // Only anonymous object-literal structs participate. Named classes have
    // nominal types distinct under `ref.test` already; vec/arr/wrapper/union
    // carriers are internal.
    if (!structName.startsWith("__anon_")) continue;
    const typeIdx = ctx.structMap.get(structName);
    if (typeIdx === undefined) continue;

    const names: string[] = [];
    const typeParts: string[] = [];
    for (const f of fields) {
      if (!f || !f.type || !f.name) continue;
      if (isInternalStructFieldName(ctx, structName, f.name)) continue;
      names.push(f.name);
      typeParts.push(typeKindKey(f.type));
    }
    if (names.length === 0) continue; // no host-enumerable fields
    // (#2009 R3b) The structural-shape key (`typeParts`) is built from slot order
    // so same-shape grouping is unaffected, but the enumerated `names` are
    // permuted to JS insertion order — so the shape-id CSV the host reads
    // reflects spec enumeration order, and two colliding structs with the SAME
    // insertion order share a shape-id.
    const orderedNames = orderNamesByInsertion(ctx, structName, names);
    const shapeKey = typeParts.join("|");
    let group = byShape.get(shapeKey);
    if (!group) {
      group = [];
      byShape.set(shapeKey, group);
    }
    group.push({ structName, typeIdx, names: orderedNames });
  }

  // A group "collides" iff it contains 2+ DISTINCT field-name lists. (Two
  // structs that share BOTH types and names are just the same shape registered
  // twice — `ref.test` returning either's identical names is correct, no fix.)
  const shapeIdByCsv = new Map<string, number>();
  const collidingTypeIdxs: { typeIdx: number; structName: string; shapeId: number }[] = [];

  const allocateShapeId = (csv: string): number => {
    const existing = shapeIdByCsv.get(csv);
    if (existing !== undefined) return existing;
    // Shape id zero is the physical default observed when a structurally
    // accepted but logically unrelated receiver reaches a stamped candidate
    // arm. Reserve it as the invalid/miss identity so it can never authorize a
    // field read or write (#4383).
    if (ctx.shapeNameCsvById.length === 0) ctx.shapeNameCsvById.push("");
    const shapeId = ctx.shapeNameCsvById.length;
    ctx.shapeNameCsvById.push(csv);
    shapeIdByCsv.set(csv, shapeId);
    return shapeId;
  };

  for (const group of byShape.values()) {
    const distinctNameCsvs = new Set(group.map((m) => m.names.join(",")));
    if (distinctNameCsvs.size < 2) continue;

    for (const m of group) {
      const csv = m.names.join(",");
      const shapeId = allocateShapeId(csv);
      ctx.shapeIdByStructName.set(m.structName, shapeId);
      collidingTypeIdxs.push({ typeIdx: m.typeIdx, structName: m.structName, shapeId });
    }
  }

  if (collidingTypeIdxs.length === 0) return [];

  // Retro-stamp: append a hidden `$shape` i32 field to each colliding struct
  // type + structFields, then patch every `struct.new <typeIdx>` instruction in
  // every compiled body to insert `i32.const <shapeId>` immediately before it,
  // matching the new operand count. The `$`-prefix excludes `$shape` from name
  // enumeration and getter/setter emission.
  for (const { typeIdx, structName, shapeId } of collidingTypeIdxs) {
    const typeDef = ctx.mod.types[typeIdx] as { kind: string; fields?: FieldDef[] } | undefined;
    if (!typeDef || typeDef.kind !== "struct" || !typeDef.fields) continue;
    // The struct registration stores ONE `fields` array shared by both
    // `ctx.mod.types[typeIdx].fields` and `ctx.structFields.get(structName)`, so
    // push `$shape` exactly once. Guard against a double-append if this somehow
    // re-runs for a type.
    const alreadyStamped = typeDef.fields.some((f) => f && f.name === "$shape");
    if (!alreadyStamped) {
      typeDef.fields.push({ name: "$shape", type: { kind: "i32" }, mutable: false });
      const sf = ctx.structFields.get(structName);
      if (sf && sf !== typeDef.fields) sf.push({ name: "$shape", type: { kind: "i32" }, mutable: false });
    }
    patchStructNewWithShapeId(ctx, typeIdx, shapeId);
  }
  return [...new Set(collidingTypeIdxs.map(({ typeIdx }) => typeIdx))];
}

/**
 * (#2009) Insert `i32.const <shapeId>` immediately before every
 * `struct.new <typeIdx>` in every compiled function body — the retro-stamp that
 * keeps a struct.new's operand count in sync after `$shape` is appended to its
 * type. Backend-agnostic: walks the emitted `Instr` stream, so it covers both
 * the legacy and IR construction paths uniformly. Mirrors the structural walk of
 * `patchStructNewForAddedField` but inserts a specific value, not a default.
 */
function patchStructNewWithShapeId(ctx: CodegenContext, typeIdx: number, shapeId: number): void {
  const patch = (root: Instr[]): void => {
    const work: Instr[][] = [root];
    while (work.length > 0) {
      const arr = work.pop()!;
      for (let i = arr.length - 1; i >= 0; i--) {
        const instr = arr[i]!;
        if (instr.op === "struct.new" && (instr as { typeIdx?: number }).typeIdx === typeIdx) {
          arr.splice(i, 0, { op: "i32.const", value: shapeId });
        }
        const anyInstr = instr as Record<string, unknown>;
        if (Array.isArray(anyInstr.body)) work.push(anyInstr.body);
        if (Array.isArray(anyInstr.then)) work.push(anyInstr.then);
        if (Array.isArray(anyInstr.else)) work.push(anyInstr.else);
        if (Array.isArray(anyInstr.catches)) {
          for (const c of anyInstr.catches as { body?: Instr[] }[]) {
            if (Array.isArray(c.body)) work.push(c.body);
          }
        }
        if (Array.isArray(anyInstr.catchAll)) work.push(anyInstr.catchAll);
      }
    }
  };
  for (const func of ctx.mod.functions) patch(func.body);
}

/**
 * Emit a __struct_field_names(externref) -> externref export.
 * For each struct type, ref.test and return a string constant with comma-separated field names.
 * Falls back to ref.null.extern for non-struct values.
 */
function emitStructFieldNamesExport(
  ctx: CodegenContext,
  fieldMap: Map<string, { typeIdx: number; fieldIdx: number; fieldType: ValType }[]>,
): void {
  // The __struct_field_names export is only consumed by a JS host runtime
  // (Object.keys / JSON.stringify / for-in introspection of opaque WasmGC
  // structs). In nativeStrings mode (auto-on for `--target wasi`) there is no
  // JS host, so the export is dead code AND its body uses `global.get` of a
  // string_constants global to push the comma-separated field names — which
  // forces a `string_constants::a,b,c` host import that fails to instantiate
  // under wasmtime (#1174). Skip emission in nativeStrings mode.
  //
  // (#3912) NOTE — this predicate conflates "native strings" with "no JS host",
  // and `fast` is the config where they come apart (nativeStrings + a live JS
  // host). The consequence is real and measured: without this export the host's
  // `_wasmToPlain` cannot enumerate an object's fields, so under `fast`
  // `JSON.stringify({a: 42})` returns `"{}"` rather than `{"a":42}`. It was
  // invisible before #3912 only because reading the result trapped first.
  //
  // It is NOT fixed here because the fix is not the predicate: switching to
  // `ctx.wasi || ctx.standalone` makes this body emit under native strings,
  // where the string-constant globals it reads do not exist — the module then
  // fails to build ("Codegen error: global index out of range"). Making the CSV
  // a native string is a separate piece of work; see the follow-up issue.
  if (ctx.nativeStrings) return;

  const mod = ctx.mod;

  // (#2009) Two arms per struct:
  //  - COLLIDING structs (have a `$shape` field, from
  //    resolveSameShapeFieldNameCollisions): read `struct.get $shape` and pick
  //    the name CSV by shape-id VALUE — disambiguates same-shape types that
  //    `ref.test` cannot tell apart.
  //  - non-colliding structs: legacy `ref.test typeIdx → own CSV` arm.
  type LegacyEntry = { typeIdx: number; names: string[] };
  type ShapeEntry = { typeIdx: number; shapeFieldIdx: number };
  const legacyEntries: LegacyEntry[] = [];
  const shapeEntries: ShapeEntry[] = [];
  for (const [structName, fields] of ctx.structFields) {
    const typeIdx = ctx.structMap.get(structName);
    if (typeIdx === undefined) continue;
    if (isSyntheticStructName(structName)) continue;

    const shapeFieldIdx = fields.findIndex((f) => f && f.name === "$shape");
    if (shapeFieldIdx >= 0 && ctx.shapeIdByStructName.has(structName)) {
      shapeEntries.push({ typeIdx, shapeFieldIdx });
      continue;
    }

    const names: string[] = [];
    for (const field of fields) {
      if (!field || !field.type || !field.name) continue;
      if (isInternalStructFieldName(ctx, structName, field.name)) continue;
      names.push(field.name);
    }
    // (#2009 R3b) Permute to JS insertion order for spec-correct host
    // enumeration; no-op when no literal-derived order was recorded.
    const orderedNames = orderNamesByInsertion(ctx, structName, names);
    if (orderedNames.length > 0) legacyEntries.push({ typeIdx, names: orderedNames });
  }

  if (legacyEntries.length === 0 && shapeEntries.length === 0) return;

  // Register comma-separated field name strings as string constants.
  const legacyTypeIdxToGlobalIdx = new Map<number, number>();
  for (const { typeIdx, names } of legacyEntries) {
    const csv = names.join(",");
    addStringConstantGlobal(ctx, csv);
    const globalIdx = ctx.stringGlobalMap.get(csv);
    if (globalIdx !== undefined) legacyTypeIdxToGlobalIdx.set(typeIdx, globalIdx);
  }
  // One CSV global per shape-id (colliding structs share the table by VALUE).
  const shapeIdToGlobalIdx = new Map<number, number>();
  for (let id = 0; id < ctx.shapeNameCsvById.length; id++) {
    const csv = ctx.shapeNameCsvById[id]!;
    addStringConstantGlobal(ctx, csv);
    const globalIdx = ctx.stringGlobalMap.get(csv);
    if (globalIdx !== undefined) shapeIdToGlobalIdx.set(id, globalIdx);
  }

  // Build the function body: chain of ref.test / if-else returning the right string
  const getterExternTypeIdx = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "externref" }], "$sfnames_type");
  const anyLocal = 1; // local 0 = externref param, local 1 = anyref conversion
  const shapeLocal = 2; // i32 scratch for the read shape-id (colliding arms)

  const body: Instr[] = [];
  body.push({ op: "local.get", index: 0 });
  body.push({ op: "any.convert_extern" });
  body.push({ op: "local.set", index: anyLocal });

  // Helper: dispatch on a shape-id value (on stack) → CSV global.
  const buildShapeIdDispatch = (): Instr[] => {
    const ids = [...shapeIdToGlobalIdx.entries()];
    let chain: Instr[] = [{ op: "ref.null.extern" }];
    for (let i = ids.length - 1; i >= 0; i--) {
      const [shapeId, globalIdx] = ids[i]!;
      chain = [
        { op: "local.get", index: shapeLocal },
        { op: "i32.const", value: shapeId },
        { op: "i32.eq" },
        {
          op: "if",
          blockType: { kind: "val", type: { kind: "externref" } },
          then: [{ op: "global.get", index: globalIdx }],
          else: chain,
        },
      ];
    }
    return [{ op: "local.set", index: shapeLocal }, ...chain];
  };

  // Build nested if-else chain: legacy arms first, then colliding $shape arms.
  let fallback: Instr[] = [{ op: "ref.null.extern" }];

  for (let i = legacyEntries.length - 1; i >= 0; i--) {
    const typeIdx = legacyEntries[i]!.typeIdx;
    const globalIdx = legacyTypeIdxToGlobalIdx.get(typeIdx);
    if (globalIdx === undefined) continue;
    fallback = [
      { op: "local.get", index: anyLocal },
      { op: "ref.test", typeIdx },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "externref" } },
        then: [{ op: "global.get", index: globalIdx }],
        else: fallback,
      },
    ];
  }

  for (let i = shapeEntries.length - 1; i >= 0; i--) {
    const { typeIdx, shapeFieldIdx } = shapeEntries[i]!;
    const thenBranch: Instr[] = [
      { op: "local.get", index: anyLocal },
      { op: "ref.cast", typeIdx },
      { op: "struct.get", typeIdx, fieldIdx: shapeFieldIdx },
      ...buildShapeIdDispatch(),
    ];
    fallback = [
      { op: "local.get", index: anyLocal },
      { op: "ref.test", typeIdx },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "externref" } },
        then: thenBranch,
        else: fallback,
      },
    ];
  }

  body.push(...fallback);

  const locals: { name: string; type: ValType }[] = [{ name: "__any", type: { kind: "anyref" } }];
  if (shapeEntries.length > 0) locals.push({ name: "__shapeId", type: { kind: "i32" } });

  publishDataStructHostBridge(
    ctx,
    {
      name: "__struct_field_names",
      typeIdx: getterExternTypeIdx,
      locals,
      body,
      exported: true,
    } as WasmFunction,
    DATA_STRUCT_HOST_BRIDGE_ORDINAL.structFieldNames,
  );
}

/** (#3032 W6) Sentinel-canonicalizing arm config for the `value` getter. */
interface SentinelArmConfig {
  typeIdxs: Set<number>;
  undefInstrs: Instr[];
  f64ScratchIdx: number;
}

/** Build nested if/else for struct field getter dispatch. */
function buildNestedIfElse(
  entries: {
    typeIdx: number;
    fieldIdx: number;
    fieldType: ValType;
    jsBoolean: boolean;
    shapeId?: number;
    shapeFieldIdx?: number;
  }[],
  anyLocal: number,
  boxNumIdx: number | undefined,
  returnMode: "extern" | "f64" | "i32" = "extern",
  boxBoolIdx?: number,
  boxSymbolIdx?: number,
  sentinelArms?: SentinelArmConfig,
): Instr[] {
  const body: Instr[] = [];

  // Convert externref to anyref and store
  body.push({ op: "local.get", index: 0 });
  body.push({ op: "any.convert_extern" });
  body.push({ op: "local.set", index: anyLocal });

  // Default return value for the final else
  let defaultVal: Instr;
  let blockRetType: ValType;
  if (returnMode === "f64") {
    defaultVal = { op: "f64.const", value: 0 };
    blockRetType = { kind: "f64" };
  } else if (returnMode === "i32") {
    defaultVal = { op: "i32.const", value: 0 };
    blockRetType = { kind: "i32" };
  } else {
    defaultVal = { op: "ref.null.extern" };
    blockRetType = { kind: "externref" };
  }

  // Build a chain: if (ref.test T1) { get from T1 } else if (ref.test T2) { ... } else { default }
  let current: Instr[] = [defaultVal];

  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!;
    const extractBranch = buildGetterExtract(
      entry,
      anyLocal,
      boxNumIdx,
      returnMode,
      boxBoolIdx,
      boxSymbolIdx,
      sentinelArms,
    );
    const thenBranch: Instr[] =
      entry.shapeId !== undefined && entry.shapeFieldIdx !== undefined
        ? [
            { op: "local.get", index: anyLocal },
            { op: "ref.cast", typeIdx: entry.typeIdx },
            { op: "struct.get", typeIdx: entry.typeIdx, fieldIdx: entry.shapeFieldIdx },
            { op: "i32.const", value: entry.shapeId },
            { op: "i32.eq" },
            {
              op: "if",
              blockType: { kind: "val", type: blockRetType },
              then: extractBranch,
              else: current,
            },
          ]
        : extractBranch;

    const ifInstr: Instr = {
      op: "if",
      blockType: { kind: "val", type: blockRetType },
      then: thenBranch,
      else: current,
    };

    current = [{ op: "local.get", index: anyLocal }, { op: "ref.test", typeIdx: entry.typeIdx }, ifInstr];
  }

  body.push(...current);
  return body;
}

/** Build the "then" branch that extracts a field from a cast struct. */
function buildGetterExtract(
  entry: { typeIdx: number; fieldIdx: number; fieldType: ValType; jsBoolean: boolean },
  anyLocal: number,
  boxNumIdx: number | undefined,
  returnMode: "extern" | "f64" | "i32" = "extern",
  boxBoolIdx?: number,
  boxSymbolIdx?: number,
  sentinelArms?: SentinelArmConfig,
): Instr[] {
  const then: Instr[] = [];

  // Cast anyref to the struct type
  then.push({ op: "local.get", index: anyLocal });
  then.push({ op: "ref.cast", typeIdx: entry.typeIdx });
  then.push({ op: "struct.get", typeIdx: entry.typeIdx, fieldIdx: entry.fieldIdx });

  const ft = entry.fieldType;

  // (#3032 W6 / #2979) Native-generator result `value` arm: canonicalize the
  // UNDEF_F64 sentinel to `undefined` instead of boxing it as NaN.
  if (
    returnMode === "extern" &&
    ft.kind === "f64" &&
    boxNumIdx !== undefined &&
    sentinelArms !== undefined &&
    sentinelArms.typeIdxs.has(entry.typeIdx)
  ) {
    then.push(
      { op: "local.tee", index: sentinelArms.f64ScratchIdx },
      { op: "i64.reinterpret_f64" },
      { op: "i64.const", value: UNDEF_F64_BITS },
      { op: "i64.eq" },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "externref" } },
        then: [...sentinelArms.undefInstrs],
        else: [
          { op: "local.get", index: sentinelArms.f64ScratchIdx },
          { op: "call", funcIdx: boxNumIdx },
        ],
      },
    );
    return then;
  }

  if (returnMode === "f64") {
    // Return f64 directly
    if (ft.kind === "f64") {
      // Already f64 — nothing to do
    } else if (ft.kind === "i32") {
      then.push({ op: "f64.convert_i32_s" });
    } else {
      then.push({ op: "drop" });
      then.push({ op: "f64.const", value: 0 });
    }
  } else if (returnMode === "i32") {
    // Return i32 directly
    if (ft.kind === "i32") {
      // Already i32
    } else if (ft.kind === "f64") {
      then.push({ op: "i32.trunc_sat_f64_s" });
    } else {
      then.push({ op: "drop" });
      then.push({ op: "i32.const", value: 0 });
    }
  } else {
    // Return externref
    if (entry.jsBoolean && boxBoolIdx !== undefined && ft.kind === "f64") {
      // #2847: late shape inference chose an f64 carrier for an untyped
      // boolean-only field. Convert 0/non-zero to i32 before boolean boxing;
      // the struct storage ABI remains unchanged.
      then.push({ op: "f64.const", value: 0 });
      then.push({ op: "f64.ne" });
      then.push({ op: "call", funcIdx: boxBoolIdx });
    } else if (ft.kind === "f64") {
      if (boxNumIdx !== undefined) {
        then.push({ op: "call", funcIdx: boxNumIdx });
      } else {
        then.push({ op: "drop" });
        then.push({ op: "ref.null.extern" });
      }
    } else if (ft.kind === "i32" && ft.symbol === true && boxSymbolIdx !== undefined) {
      // (#3961) Symbol handles are i32 internally but cross the host boundary
      // as genuine identity-stable JS Symbols.
      then.push({ op: "call", funcIdx: boxSymbolIdx });
    } else if (ft.kind === "i32" && entry.jsBoolean && boxBoolIdx !== undefined) {
      // (#1788) Boolean-branded i32 field — box as a JS boolean (not a number)
      // so `typeof o.x === "boolean"` and `o.x === true` hold on a dynamic read.
      // The raw i32 is already on the stack; `__box_boolean(i32) -> externref`.
      then.push({ op: "call", funcIdx: boxBoolIdx });
    } else if (ft.kind === "i32") {
      then.push({ op: "f64.convert_i32_s" });
      if (boxNumIdx !== undefined) {
        then.push({ op: "call", funcIdx: boxNumIdx });
      } else {
        then.push({ op: "drop" });
        then.push({ op: "ref.null.extern" });
      }
    } else if (ft.kind === "i64") {
      then.push({ op: "drop" });
      then.push({ op: "ref.null.extern" });
    } else if (ft.kind === "externref" || ft.kind === "ref_extern") {
      // Already externref
    } else if (ft.kind === "ref" || ft.kind === "ref_null" || ft.kind === "anyref" || ft.kind === "eqref") {
      then.push({ op: "extern.convert_any" });
    } else {
      then.push({ op: "drop" });
      then.push({ op: "ref.null.extern" });
    }
  }

  return then;
}
