// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { STABLE_FUNC_BASE } from "../emit/resolve-layout.js";
import type { Instr, WasmExport, WasmFunction } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { definedFuncAt } from "./func-space.js";
import { addFuncType } from "./registry/types.js";

const DATE_HOST_BRIDGE_EXPORT_NAMES = Object.freeze([
  "__\0js2_is_date",
  "__\0js2_date_value",
  "__\0js2_date_set_value",
] as const);

interface PublishedDateHostBridgeExport {
  readonly entry: WasmExport;
  readonly name: (typeof DATE_HOST_BRIDGE_EXPORT_NAMES)[number];
  readonly func: WasmFunction;
}

/**
 * Each CodegenContext issues its own immutable publication record. The record
 * binds the exact descriptor object to its exact allocator object; neither a
 * spelling nor a numeric target can substitute for that provenance.
 */
const publishedDateHostBridgeExports = new WeakMap<CodegenContext, readonly PublishedDateHostBridgeExport[]>();

/** The complete public Date namespace consists of these three names only. */
export function isCoreDateHostBridgePublicName(name: string): boolean {
  return DATE_HOST_BRIDGE_EXPORT_NAMES.includes(name as (typeof DATE_HOST_BRIDGE_EXPORT_NAMES)[number]);
}

/**
 * Resolve one Date export only as validation evidence.
 *
 * Live handles are interpreted against the current import prefix. An invalid
 * live position must fail here rather than accidentally being reconsidered as
 * a stable handle; stable handles are resolved solely through definedFuncAt.
 */
function resolveDateHostBridgeExportTarget(ctx: CodegenContext, entry: WasmExport): WasmFunction | undefined {
  if (entry.desc.kind !== "func") return undefined;
  if (entry.desc.index < STABLE_FUNC_BASE) {
    const numImportFuncs = ctx.mod.imports.filter((candidate) => candidate.desc.kind === "func").length;
    const position = entry.desc.index - numImportFuncs;
    if (!Number.isInteger(position) || position < 0 || position >= ctx.mod.functions.length) return undefined;
    return ctx.mod.functions[position];
  }
  return definedFuncAt(ctx, entry.desc.index);
}

/**
 * The context-bound descriptor object is the sole removal authority.
 *
 * In particular, a same-spelled descriptor, a descriptor with a coincident
 * numeric target, and a descriptor donated from a second context are all
 * unowned. Resolution belongs only to the pre-freeze validation census.
 */
export function isCompilerOwnedDateHostBridgeExport(ctx: CodegenContext, entry: WasmExport): boolean {
  return publishedDateHostBridgeExports.get(ctx)?.some((candidate) => candidate.entry === entry) ?? false;
}

/**
 * Validate the full Date publication census before the index space freezes.
 *
 * This deliberately has no successful-validation cache: a second pre-freeze
 * policy pass must see mutations made after the first one. The function is
 * also directly useful to focused invariant tests; callers enforce the freeze
 * boundary rather than this validator weakening its own checks.
 */
export function finalizeDateHostBridgeExports(ctx: CodegenContext): void {
  const published = publishedDateHostBridgeExports.get(ctx);
  if (!published) return;
  if (published.length !== DATE_HOST_BRIDGE_EXPORT_NAMES.length) {
    throw new Error(
      `Date host bridge publication must contain exactly ${DATE_HOST_BRIDGE_EXPORT_NAMES.length} descriptors, got ${published.length}`,
    );
  }

  const recordedEntries = new Set<WasmExport>();
  const recordedFuncs = new Set<WasmFunction>();
  const recordedNames = new Set<string>();
  for (const { entry, name, func } of published) {
    if (!isCoreDateHostBridgePublicName(name)) {
      throw new Error(`Date host bridge publication recorded unknown name ${name}`);
    }
    if (recordedEntries.has(entry)) {
      throw new Error(`Date host bridge export descriptor ${name} is recorded more than once`);
    }
    recordedEntries.add(entry);
    if (recordedFuncs.has(func)) {
      throw new Error(`Date host bridge allocator function for ${name} is recorded more than once`);
    }
    recordedFuncs.add(func);
    if (recordedNames.has(name)) {
      throw new Error(`Date host bridge publication records ${name} more than once`);
    }
    recordedNames.add(name);
  }
  for (const name of DATE_HOST_BRIDGE_EXPORT_NAMES) {
    if (!recordedNames.has(name)) {
      throw new Error(`Date host bridge publication is missing descriptor ${name}`);
    }
  }

  for (const { entry, name, func } of published) {
    if (ctx.mod.exports.indexOf(entry) < 0) {
      throw new Error(`Date host bridge export descriptor ${name} disappeared before finalization`);
    }
    if (ctx.mod.exports.indexOf(entry) !== ctx.mod.exports.lastIndexOf(entry)) {
      throw new Error(`Date host bridge export descriptor ${name} appears more than once in the module`);
    }
    if (entry.name !== name) {
      throw new Error(`Date host bridge export descriptor ${name} changed its published name to ${entry.name}`);
    }
    if (entry.desc.kind !== "func") {
      throw new Error(`Date host bridge export descriptor ${name} changed kind to ${entry.desc.kind}`);
    }
    if (ctx.mod.functions.indexOf(func) < 0) {
      throw new Error(`Date host bridge export descriptor ${name} lost its allocator function`);
    }
    if (ctx.mod.functions.indexOf(func) !== ctx.mod.functions.lastIndexOf(func)) {
      throw new Error(`Date host bridge allocator function for ${name} appears more than once in the module`);
    }
    if (resolveDateHostBridgeExportTarget(ctx, entry) !== func) {
      throw new Error(`Date host bridge export descriptor ${name} resolves to a different allocator function`);
    }
  }

  for (const entry of ctx.mod.exports) {
    if (recordedEntries.has(entry) || !isCoreDateHostBridgePublicName(entry.name)) continue;
    const target = resolveDateHostBridgeExportTarget(ctx, entry);
    if (target !== undefined && recordedFuncs.has(target)) {
      throw new Error(
        `unrecorded Date host bridge export descriptor ${entry.name} resolves to a recorded allocator function`,
      );
    }
  }
}

/**
 * Expose the native `$__Date` carrier to the JS host method bridge.
 *
 * Dynamic property reads erase the carrier to externref, so a subsequent
 * `value.getTime()` cannot use the statically typed Date lowering. These
 * NUL-named exports let the runtime positively classify and read/write the
 * carrier without mistaking an ordinary `{ timestamp }` object for a Date.
 */
export function emitDateHostBridge(ctx: CodegenContext): void {
  if (publishedDateHostBridgeExports.has(ctx)) return;
  const dateTypeIdx = ctx.structMap.get("__Date");
  if (dateTypeIdx === undefined) return;
  const published: PublishedDateHostBridgeExport[] = [];

  const publish = (
    name: (typeof DATE_HOST_BRIDGE_EXPORT_NAMES)[number],
    params: Parameters<typeof addFuncType>[1],
    results: Parameters<typeof addFuncType>[2],
    body: Instr[],
  ): void => {
    const typeIdx = addFuncType(ctx, params, results, `$${name}_type`);
    const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
    const func: WasmFunction = {
      name,
      typeIdx,
      locals: [],
      body,
      exported: true,
    };
    const entry: WasmExport = { name, desc: { kind: "func", index: funcIdx } };
    ctx.mod.functions.push(func);
    ctx.mod.exports.push(entry);
    published.push(Object.freeze({ entry, name, func }));
  };

  publish(
    "__\0js2_is_date",
    [{ kind: "externref" }],
    [{ kind: "i32" }],
    [{ op: "local.get", index: 0 }, { op: "any.convert_extern" }, { op: "ref.test", typeIdx: dateTypeIdx }],
  );
  publish(
    "__\0js2_date_value",
    [{ kind: "externref" }],
    [{ kind: "i64" }],
    [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.cast", typeIdx: dateTypeIdx },
      { op: "struct.get", typeIdx: dateTypeIdx, fieldIdx: 0 },
    ],
  );
  publish(
    "__\0js2_date_set_value",
    [{ kind: "ref", typeIdx: dateTypeIdx }, { kind: "i64" }],
    [],
    [
      { op: "local.get", index: 0 },
      { op: "local.get", index: 1 },
      { op: "struct.set", typeIdx: dateTypeIdx, fieldIdx: 0 },
    ],
  );
  publishedDateHostBridgeExports.set(ctx, Object.freeze(published));
}
