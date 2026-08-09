// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { WasmFunction } from "../ir/types.js";
import type { IrFuncRef } from "../ir/nodes.js";
import type { CodegenContext } from "./context/types.js";
import { definedFuncHandleOf } from "./func-space.js";
import { addStringConstantGlobal } from "./registry/imports.js";
import {
  planProgramAbiEntrySourceSupportCallable,
  PROGRAM_ABI_CALLABLE_ROLE,
  resolveProgramAbiSupportCallableHandle,
} from "./program-abi-planning.js";

export const DATA_STRUCT_HOST_BRIDGE_ROLE = "data-struct-host-bridge";

export const DATA_STRUCT_HOST_BRIDGE_ORDINAL = Object.freeze({
  isDataStruct: 0,
  structFieldNames: 1,
} as const);

const DATA_STRUCT_HOST_BRIDGE_MANIFEST_NAME = "__\0js2_data_struct_host_bridge";
const DATA_STRUCT_HOST_BRIDGE_MANIFEST_PHYSICAL_BASE = "$dm";
const DATA_STRUCT_HOST_BRIDGE_MARKER_NAME = "__\0js2_data_struct_host_bridge_marker";
const DATA_STRUCT_HOST_BRIDGE_MARKER_PHYSICAL_BASE = "$dt";
const DATA_STRUCT_HOST_BRIDGE_BINDINGS_NAME = "__\0js2_data_struct_host_bridge_bindings";
const DATA_STRUCT_HOST_BRIDGE_BINDINGS_PHYSICAL_BASE = "$du";
export const DATA_STRUCT_HOST_BRIDGE_TOKEN = "\0js2_data_struct_host_bridge_token";
const DATA_STRUCT_HOST_BRIDGE_TOKEN_NAME = "__\0js2_data_struct_host_bridge_token";
const DATA_STRUCT_HOST_BRIDGE_TOKEN_PHYSICAL_BASE = "$dv";
const DATA_STRUCT_HOST_BRIDGE_MANIFEST_MAGIC = 0x5a300000;
const publishedDataStructHostBridgeBits = new WeakMap<CodegenContext, number>();
interface DataStructHostBridgeAllocation {
  readonly func: WasmFunction;
  readonly ref: IrFuncRef | undefined;
}

const publishedDataStructHostBridgeFuncs = new WeakMap<CodegenContext, Map<number, DataStructHostBridgeAllocation>>();
const publishedDataStructHostBridgeManifests = new WeakSet<CodegenContext>();

function dataStructHostBridgeDefinition(logicalName: string): { physicalBase: string; bit: number } {
  if (logicalName === "__is_data_struct") return { physicalBase: "$d0", bit: 0 };
  if (logicalName === "__struct_field_names") return { physicalBase: "$d1", bit: 1 };
  throw new Error(`unknown data-struct host bridge ${logicalName}`);
}

function publishCollisionSafeExport(
  ctx: CodegenContext,
  logicalName: string,
  physicalBase: string,
  desc: { kind: "func" | "table" | "global"; index: number },
): void {
  const occupied = new Set(ctx.mod.exports.map((entry) => entry.name));
  let maxOccupiedSuffix = -1;
  for (const name of occupied) {
    if (!name.startsWith(physicalBase)) continue;
    const suffix = name.slice(physicalBase.length);
    if (/^\$*$/.test(suffix)) maxOccupiedSuffix = Math.max(maxOccupiedSuffix, suffix.length);
  }
  if (!occupied.has(logicalName)) {
    ctx.mod.exports.push({ name: logicalName, desc });
    occupied.add(logicalName);
  }
  for (let suffixLength = 0; suffixLength <= maxOccupiedSuffix + 1; suffixLength++) {
    const physicalName = `${physicalBase}${"$".repeat(suffixLength)}`;
    if (occupied.has(physicalName)) continue;
    ctx.mod.exports.push({ name: physicalName, desc });
    occupied.add(physicalName);
  }
}

/**
 * Register one data-struct helper with its exact allocator object.
 *
 * Export publication is deferred until both helpers and every late import have
 * settled. This keeps the early field-name helper on its allocator object
 * instead of baking a shift-sensitive function index.
 */
export function publishDataStructHostBridge(ctx: CodegenContext, func: WasmFunction, derivedOrdinal: number): number {
  // Re-export one per-buildImports immutable string-global object as the
  // association capability. Native-string targets remain import-free.
  addStringConstantGlobal(ctx, DATA_STRUCT_HOST_BRIDGE_TOKEN);
  ctx.mod.functions.push(func);
  const ref = planProgramAbiEntrySourceSupportCallable(ctx, {
    role: DATA_STRUCT_HOST_BRIDGE_ROLE,
    roleOrdinal: PROGRAM_ABI_CALLABLE_ROLE.dataStructHostBridge,
    derivedOrdinal,
    displayName: func.name,
    func,
  });
  const ownedHandle = resolveProgramAbiSupportCallableHandle(ctx, ref, func);
  const funcIdx = definedFuncHandleOf(ctx, func);
  if (ownedHandle === undefined || funcIdx === undefined) {
    throw new Error(`data-struct host bridge ${func.name} lost its exact allocator object`);
  }

  const definition = dataStructHostBridgeDefinition(func.name);
  publishedDataStructHostBridgeBits.set(ctx, (publishedDataStructHostBridgeBits.get(ctx) ?? 0) | (1 << definition.bit));
  let publishedFuncs = publishedDataStructHostBridgeFuncs.get(ctx);
  if (!publishedFuncs) {
    publishedFuncs = new Map();
    publishedDataStructHostBridgeFuncs.set(ctx, publishedFuncs);
  }
  publishedFuncs.set(definition.bit, Object.freeze({ func, ref }));
  return funcIdx;
}

/**
 * Publish immutable, structurally authenticated availability metadata.
 *
 * A fixed two-slot funcref table binds each set bit to its exact helper. The
 * empty funcref marker and immutable i32 manifest make source-name or
 * externref-table forgeries fail closed in the host runtime.
 */
export function emitDataStructHostBridgeManifest(ctx: CodegenContext): void {
  if (publishedDataStructHostBridgeManifests.has(ctx)) return;
  const bits = publishedDataStructHostBridgeBits.get(ctx) ?? 0;
  if ((bits & (1 << DATA_STRUCT_HOST_BRIDGE_ORDINAL.isDataStruct)) === 0) return;
  publishedDataStructHostBridgeManifests.add(ctx);

  const publishedFuncs = publishedDataStructHostBridgeFuncs.get(ctx) ?? new Map();
  for (const [bit, allocation] of [...publishedFuncs].sort(([left], [right]) => left - right)) {
    const definition = dataStructHostBridgeDefinition(allocation.func.name);
    if (definition.bit !== bit) throw new Error(`data-struct host bridge bit ${bit} changed definition`);
    const ownedHandle = resolveProgramAbiSupportCallableHandle(ctx, allocation.ref, allocation.func);
    const funcIdx = definedFuncHandleOf(ctx, allocation.func);
    if (ownedHandle === undefined || funcIdx === undefined) {
      throw new Error(`data-struct host bridge manifest lost helper bit ${bit}`);
    }
    publishCollisionSafeExport(ctx, allocation.func.name, definition.physicalBase, { kind: "func", index: funcIdx });
  }

  let tokenGlobalIdx: number | undefined;
  let importGlobalIdx = 0;
  for (const entry of ctx.mod.imports) {
    if (entry.desc.kind !== "global") continue;
    if (entry.module === "string_constants" && entry.name === DATA_STRUCT_HOST_BRIDGE_TOKEN) {
      tokenGlobalIdx = importGlobalIdx;
      break;
    }
    importGlobalIdx++;
  }

  const bindingsTableIdx =
    ctx.mod.imports.filter((entry) => entry.desc.kind === "table").length + ctx.mod.tables.length;
  ctx.mod.tables.push({ elementType: "funcref", min: 2, max: 2 });
  const markerTableIdx = bindingsTableIdx + 1;
  ctx.mod.tables.push({ elementType: "funcref", min: 0, max: 0 });
  for (const [bit, allocation] of publishedFuncs) {
    const ownedHandle = resolveProgramAbiSupportCallableHandle(ctx, allocation.ref, allocation.func);
    const funcIdx = definedFuncHandleOf(ctx, allocation.func);
    if (ownedHandle === undefined || funcIdx === undefined) {
      throw new Error(`data-struct host bridge manifest lost helper bit ${bit}`);
    }
    ctx.mod.elements.push({
      tableIdx: bindingsTableIdx,
      offset: [{ op: "i32.const", value: bit }],
      funcIndices: [funcIdx],
    });
  }

  const globalIdx = ctx.numImportGlobals + ctx.mod.globals.length;
  ctx.mod.globals.push({
    name: DATA_STRUCT_HOST_BRIDGE_MANIFEST_NAME,
    type: { kind: "i32" },
    mutable: false,
    init: [{ op: "i32.const", value: DATA_STRUCT_HOST_BRIDGE_MANIFEST_MAGIC | bits }],
  });

  publishCollisionSafeExport(ctx, DATA_STRUCT_HOST_BRIDGE_MARKER_NAME, DATA_STRUCT_HOST_BRIDGE_MARKER_PHYSICAL_BASE, {
    kind: "table",
    index: markerTableIdx,
  });
  publishCollisionSafeExport(
    ctx,
    DATA_STRUCT_HOST_BRIDGE_BINDINGS_NAME,
    DATA_STRUCT_HOST_BRIDGE_BINDINGS_PHYSICAL_BASE,
    {
      kind: "table",
      index: bindingsTableIdx,
    },
  );
  if (tokenGlobalIdx !== undefined) {
    publishCollisionSafeExport(ctx, DATA_STRUCT_HOST_BRIDGE_TOKEN_NAME, DATA_STRUCT_HOST_BRIDGE_TOKEN_PHYSICAL_BASE, {
      kind: "global",
      index: tokenGlobalIdx,
    });
  }
  publishCollisionSafeExport(
    ctx,
    DATA_STRUCT_HOST_BRIDGE_MANIFEST_NAME,
    DATA_STRUCT_HOST_BRIDGE_MANIFEST_PHYSICAL_BASE,
    {
      kind: "global",
      index: globalIdx,
    },
  );
}
