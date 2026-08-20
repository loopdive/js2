// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import {
  DOM_CALLBACK_DISPATCH_EXPORT,
  DOM_CALLBACK_DISPATCH_PHYSICAL_BASE,
  DOM_STRING_BINDINGS_EXPORT,
  DOM_STRING_BINDINGS_PHYSICAL_BASE,
  DOM_STRING_CHAR_EXPORT,
  DOM_STRING_CHAR_PHYSICAL_BASE,
  DOM_STRING_MANIFEST_EXPORT,
  DOM_STRING_MANIFEST_MAGIC,
  DOM_STRING_MANIFEST_PHYSICAL_BASE,
  DOM_STRING_MARKER_EXPORT,
  DOM_STRING_MARKER_PHYSICAL_BASE,
  DOM_STRING_PREPARE_EXPORT,
  DOM_STRING_PREPARE_PHYSICAL_BASE,
} from "../dom-capability-contract.js";
import type { Instr, WasmFunction } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { materializeStandaloneDomCallbackDispatch } from "./standalone-dom-callback-authority.js";
import { definedFuncHandleOf, mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { ensureNativeStringHelpers } from "./native-strings.js";
import { addFuncType } from "./registry/types.js";

interface DomStringBoundaryAllocation {
  readonly prepare: WasmFunction;
  readonly char: WasmFunction;
}

const allocations = new WeakMap<CodegenContext, DomStringBoundaryAllocation>();
const publishedBindingSizes = new WeakMap<CodegenContext, 3 | 4>();

export interface StandaloneDomStringBoundaryPublishOptions {
  /** Bind the exact certified reusable DOM callback dispatcher as slot three. */
  readonly interactionCallbackDispatch?: boolean;
}

function publishFamily(
  ctx: CodegenContext,
  logicalName: string,
  physicalBase: string,
  desc: { kind: "func" | "global" | "table"; index: number },
): void {
  const occupied = new Set(ctx.mod.exports.map(({ name }) => name));
  if (!occupied.has(logicalName)) {
    ctx.mod.exports.push({ name: logicalName, desc });
    occupied.add(logicalName);
  }
  let maxOccupiedSuffix = -1;
  for (const name of occupied) {
    if (!name.startsWith(physicalBase)) continue;
    const suffix = name.slice(physicalBase.length);
    if (/^\$*$/.test(suffix)) maxOccupiedSuffix = Math.max(maxOccupiedSuffix, suffix.length);
  }
  for (let suffixLength = 0; suffixLength <= maxOccupiedSuffix + 1; suffixLength++) {
    const name = `${physicalBase}${"$".repeat(suffixLength)}`;
    if (occupied.has(name)) continue;
    ctx.mod.exports.push({ name, desc });
    occupied.add(name);
  }
}

/**
 * Publish a zero-import, strict native-string readout for the explicit DOM
 * capability. The prepare call verifies the carrier, flattens it once and
 * retains the flat string; the char call reads UTF-16 code units from it.
 */
export function emitStandaloneDomStringBoundary(ctx: CodegenContext): void {
  if (!ctx.requiresStandaloneDomCapability || !ctx.standalone || !ctx.nativeStrings || allocations.has(ctx)) return;
  ensureNativeStringHelpers(ctx);
  const flattenIdx = ctx.nativeStrHelpers.get("__str_flatten");
  const anyStringTypeIdx = ctx.anyStrTypeIdx;
  const flatStringTypeIdx = ctx.nativeStrTypeIdx;
  const dataTypeIdx = ctx.nativeStrDataTypeIdx;
  if (flattenIdx === undefined || anyStringTypeIdx < 0 || flatStringTypeIdx < 0 || dataTypeIdx < 0) {
    throw new Error("standalone dom@1 native-string boundary dependencies are unavailable");
  }

  const bufferGlobalIdx = ctx.numImportGlobals + ctx.mod.globals.length;
  ctx.mod.globals.push({
    name: "__dom_string_buffer",
    type: { kind: "ref_null", typeIdx: flatStringTypeIdx },
    mutable: true,
    init: [{ op: "ref.null", typeIdx: flatStringTypeIdx }],
  });

  const prepareTypeIdx = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "i32" }], "$dom_string_prepare_type");
  const prepareFuncIdx = mintDefinedFunc(ctx);
  const prepareBody: Instr[] = [
    { op: "local.get", index: 0 },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "i32.const", value: -1 }, { op: "return" }],
    },
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: anyStringTypeIdx },
    { op: "i32.eqz" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "i32.const", value: -1 }, { op: "return" }],
    },
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: anyStringTypeIdx },
    { op: "call", funcIdx: flattenIdx },
    { op: "global.set", index: bufferGlobalIdx },
    { op: "global.get", index: bufferGlobalIdx },
    { op: "struct.get", typeIdx: flatStringTypeIdx, fieldIdx: 0 },
  ];
  const prepare: WasmFunction = {
    name: "__js2_dom_string_prepare_impl",
    typeIdx: prepareTypeIdx,
    locals: [],
    body: prepareBody,
    exported: false,
  };
  pushDefinedFunc(ctx, prepareFuncIdx, prepare);

  const charTypeIdx = addFuncType(ctx, [{ kind: "i32" }], [{ kind: "i32" }], "$dom_string_char_type");
  const charFuncIdx = mintDefinedFunc(ctx);
  const charBody: Instr[] = [
    { op: "global.get", index: bufferGlobalIdx },
    { op: "local.tee", index: 1 },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "i32.const", value: 0 }, { op: "return" }],
    },
    { op: "local.get", index: 0 },
    { op: "i32.const", value: 0 },
    { op: "i32.lt_s" },
    { op: "local.get", index: 0 },
    { op: "local.get", index: 1 },
    { op: "struct.get", typeIdx: flatStringTypeIdx, fieldIdx: 0 },
    { op: "i32.ge_s" },
    { op: "i32.or" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "i32.const", value: 0 }, { op: "return" }],
    },
    { op: "local.get", index: 1 },
    { op: "struct.get", typeIdx: flatStringTypeIdx, fieldIdx: 2 },
    { op: "local.get", index: 1 },
    { op: "struct.get", typeIdx: flatStringTypeIdx, fieldIdx: 1 },
    { op: "local.get", index: 0 },
    { op: "i32.add" },
    { op: "array.get_u", typeIdx: dataTypeIdx },
  ];
  const char: WasmFunction = {
    name: "__js2_dom_string_char_impl",
    typeIdx: charTypeIdx,
    locals: [{ name: "buffer", type: { kind: "ref_null", typeIdx: flatStringTypeIdx } }],
    body: charBody,
    exported: false,
  };
  pushDefinedFunc(ctx, charFuncIdx, char);
  allocations.set(ctx, Object.freeze({ prepare, char }));
}

/**
 * Publish the authenticated DOM string boundary after every source export has
 * been allocated. The terminal physical aliases therefore always belong to
 * these exact compiler-owned functions, even when source code occupies the
 * logical labels or any prefix of the short alias families.
 *
 * Slot zero binds the module to this buildImports lifecycle's exact
 * `global_document` import; slots one and two bind the two readout functions.
 * When the caller explicitly requests the DOM-interaction extension, slot
 * three binds the exact compiler-owned DOM callback dispatcher. The base
 * dom@1 path retains its frozen three-slot artifact.
 *
 * That association prevents a genuine-but-unrelated donor instance from
 * establishing DOM string or callback authority.
 */
export function publishStandaloneDomStringBoundary(
  ctx: CodegenContext,
  options: StandaloneDomStringBoundaryPublishOptions = {},
): void {
  const allocation = allocations.get(ctx);
  if (!allocation) return;
  const bindingSize = options.interactionCallbackDispatch === true ? 4 : 3;
  const priorBindingSize = publishedBindingSizes.get(ctx);
  if (priorBindingSize !== undefined) {
    if (priorBindingSize !== bindingSize) {
      throw new Error(
        `standalone dom@1 boundary was already published with ${priorBindingSize} bindings, not ${bindingSize}`,
      );
    }
    return;
  }

  const prepareFuncIdx = definedFuncHandleOf(ctx, allocation.prepare);
  const charFuncIdx = definedFuncHandleOf(ctx, allocation.char);
  if (prepareFuncIdx === undefined || charFuncIdx === undefined) {
    throw new Error("standalone dom@1 native-string boundary lost its compiler-owned functions");
  }

  let globalDocumentFuncIdx: number | undefined;
  let importFuncIdx = 0;
  for (const entry of ctx.mod.imports) {
    if (entry.desc.kind !== "func") continue;
    if (entry.module === "env" && entry.name === "global_document") {
      globalDocumentFuncIdx = importFuncIdx;
      break;
    }
    importFuncIdx++;
  }
  if (globalDocumentFuncIdx === undefined) {
    throw new Error("standalone dom@1 native-string boundary lost env::global_document");
  }

  let callbackDispatcherFuncIdx: number | undefined;
  if (bindingSize === 4) {
    const callbackDispatcher = materializeStandaloneDomCallbackDispatch(ctx);
    callbackDispatcherFuncIdx = definedFuncHandleOf(ctx, callbackDispatcher);
    if (callbackDispatcherFuncIdx === undefined) {
      throw new Error("standalone DOM interaction boundary lost its compiler-owned callback dispatcher");
    }
  }

  const bindingsTableIdx =
    ctx.mod.imports.filter((entry) => entry.desc.kind === "table").length + ctx.mod.tables.length;
  ctx.mod.tables.push({ elementType: "funcref", min: bindingSize, max: bindingSize });
  const markerTableIdx = bindingsTableIdx + 1;
  ctx.mod.tables.push({ elementType: "funcref", min: 0, max: 0 });
  ctx.mod.elements.push({
    tableIdx: bindingsTableIdx,
    offset: [{ op: "i32.const", value: 0 }],
    funcIndices:
      callbackDispatcherFuncIdx === undefined
        ? [globalDocumentFuncIdx, prepareFuncIdx, charFuncIdx]
        : [globalDocumentFuncIdx, prepareFuncIdx, charFuncIdx, callbackDispatcherFuncIdx],
  });

  const manifestGlobalIdx = ctx.numImportGlobals + ctx.mod.globals.length;
  ctx.mod.globals.push({
    name: "__js2_dom_string_manifest",
    type: { kind: "i32" },
    mutable: false,
    init: [{ op: "i32.const", value: DOM_STRING_MANIFEST_MAGIC }],
  });

  publishFamily(ctx, DOM_STRING_PREPARE_EXPORT, DOM_STRING_PREPARE_PHYSICAL_BASE, {
    kind: "func",
    index: prepareFuncIdx,
  });
  publishFamily(ctx, DOM_STRING_CHAR_EXPORT, DOM_STRING_CHAR_PHYSICAL_BASE, {
    kind: "func",
    index: charFuncIdx,
  });
  if (callbackDispatcherFuncIdx !== undefined) {
    publishFamily(ctx, DOM_CALLBACK_DISPATCH_EXPORT, DOM_CALLBACK_DISPATCH_PHYSICAL_BASE, {
      kind: "func",
      index: callbackDispatcherFuncIdx,
    });
  }
  publishFamily(ctx, DOM_STRING_MANIFEST_EXPORT, DOM_STRING_MANIFEST_PHYSICAL_BASE, {
    kind: "global",
    index: manifestGlobalIdx,
  });
  publishFamily(ctx, DOM_STRING_MARKER_EXPORT, DOM_STRING_MARKER_PHYSICAL_BASE, {
    kind: "table",
    index: markerTableIdx,
  });
  publishFamily(ctx, DOM_STRING_BINDINGS_EXPORT, DOM_STRING_BINDINGS_PHYSICAL_BASE, {
    kind: "table",
    index: bindingsTableIdx,
  });
  publishedBindingSizes.set(ctx, bindingSize);
}
