// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { STABLE_FUNC_BASE } from "../emit/resolve-layout.js";
import type { Instr, WasmExport, WasmFunction } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { definedFuncAt } from "./func-space.js";
import { addFuncType } from "./registry/types.js";

const DATE_HOST_BRIDGE_NAMES = Object.freeze(["__\0js2_is_date", "__\0js2_date_value", "__\0js2_date_set_value"]);

interface DateHostBridgePublishedExport {
  readonly entry: WasmExport;
  readonly name: string;
  readonly func: WasmFunction;
}

const dateHostBridgePublishedExports = new WeakMap<CodegenContext, readonly DateHostBridgePublishedExport[]>();
const dateHostBridgeFinalized = new WeakSet<CodegenContext>();

/**
 * Expose the native `$__Date` carrier to the JS host method bridge.
 *
 * Dynamic property reads erase the carrier to externref, so a subsequent
 * `value.getTime()` cannot use the statically typed Date lowering. These
 * NUL-named exports let the runtime positively classify and read/write the
 * carrier without mistaking an ordinary `{ timestamp }` object for a Date.
 */
export function emitDateHostBridge(ctx: CodegenContext): void {
  if (dateHostBridgePublishedExports.has(ctx)) return;
  const dateTypeIdx = ctx.structMap.get("__Date");
  if (dateTypeIdx === undefined) return;

  const publish = (
    name: string,
    params: Parameters<typeof addFuncType>[1],
    results: Parameters<typeof addFuncType>[2],
    body: Instr[],
    published: DateHostBridgePublishedExport[],
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
    published.push({ entry, name, func });
  };

  const published: DateHostBridgePublishedExport[] = [];
  publish(
    "__\0js2_is_date",
    [{ kind: "externref" }],
    [{ kind: "i32" }],
    [{ op: "local.get", index: 0 }, { op: "any.convert_extern" }, { op: "ref.test", typeIdx: dateTypeIdx }],
    published,
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
    published,
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
    published,
  );
  if (published.length !== DATE_HOST_BRIDGE_NAMES.length) {
    throw new Error(
      `Date host bridge published ${published.length} entries, expected ${DATE_HOST_BRIDGE_NAMES.length}`,
    );
  }
  dateHostBridgePublishedExports.set(ctx, Object.freeze(published));
}

/** Exact logical and compact names owned by the three-entry Date bridge. */
export function isCoreDateHostBridgePublicName(name: string): boolean {
  return DATE_HOST_BRIDGE_NAMES.includes(name);
}

/**
 * Resolve a Date bridge export through its current descriptor regime.
 *
 * Live handles are interpreted against the CURRENT function-import prefix. A
 * failed live lookup is deliberately terminal: it must not fall through to a
 * stable lookup or a name-keyed reconstruction. Stable handles use the
 * registry-owned `definedFuncAt` path instead.
 */
function resolveDateHostBridgeExportTarget(ctx: CodegenContext, entry: WasmExport): WasmFunction | undefined {
  if (entry.desc.kind !== "func") return undefined;
  if (entry.desc.index >= STABLE_FUNC_BASE) return definedFuncAt(ctx, entry.desc.index);
  const currentImportCount = ctx.mod.imports.filter((candidate) => candidate.desc.kind === "func").length;
  const currentPosition = entry.desc.index - currentImportCount;
  return currentPosition < 0 ? undefined : ctx.mod.functions[currentPosition];
}

/**
 * Authenticate a Date bridge export by exact descriptor provenance.
 *
 * The recorded descriptor object is authoritative. A copied descriptor is
 * removable only in the bounded Date namespace and only when its live/stable
 * target resolves to the exact allocator captured at publication.
 */
export function isCompilerOwnedDateHostBridgeExport(ctx: CodegenContext, entry: WasmExport): boolean {
  const published = dateHostBridgePublishedExports.get(ctx);
  if (!published) return false;
  if (published.some((candidate) => candidate.entry === entry)) return true;
  if (!isCoreDateHostBridgePublicName(entry.name)) return false;
  const target = resolveDateHostBridgeExportTarget(ctx, entry);
  return target !== undefined && published.some((candidate) => candidate.func === target);
}

/**
 * Validate the complete Date provenance census before host-bridge policy runs.
 * This is an authentication-only boundary: a malformed descriptor cannot be
 * repaired or leave a partially rewritten export section behind.
 */
export function finalizeDateHostBridgeExports(ctx: CodegenContext): void {
  const published = dateHostBridgePublishedExports.get(ctx);
  if (!published) return;
  if (dateHostBridgeFinalized.has(ctx)) return;
  if (published.length !== DATE_HOST_BRIDGE_NAMES.length) {
    throw new Error(`Date host bridge census is incomplete: ${published.length} of ${DATE_HOST_BRIDGE_NAMES.length}`);
  }

  const seenEntries = new Set<WasmExport>();
  const seenNames = new Set<string>();

  for (const { entry, name, func } of published) {
    if (seenEntries.has(entry)) {
      throw new Error(`Date host bridge descriptor ${name} is recorded more than once`);
    }
    seenEntries.add(entry);
    if (seenNames.has(name)) {
      throw new Error(`Date host bridge census records name ${name} more than once`);
    }
    seenNames.add(name);
    if (!isCoreDateHostBridgePublicName(name)) {
      throw new Error(`Date host bridge census contains unknown name ${name}`);
    }
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
      throw new Error(`Date host bridge allocator for ${name} appears more than once in the module`);
    }
    if (resolveDateHostBridgeExportTarget(ctx, entry) !== func) {
      throw new Error(`Date host bridge export descriptor ${name} resolves to a different allocator function`);
    }
  }

  if (seenNames.size !== DATE_HOST_BRIDGE_NAMES.length || DATE_HOST_BRIDGE_NAMES.some((name) => !seenNames.has(name))) {
    throw new Error("Date host bridge census is incomplete or contains duplicate names");
  }
  // The live descriptor is already maintained by the normal import-shifting
  // machinery. This provenance sink authenticates it; it must never repair an
  // index or substitute a reconstructed one after validation.
  dateHostBridgeFinalized.add(ctx);
}
