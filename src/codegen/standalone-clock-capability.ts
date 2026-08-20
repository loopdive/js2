// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { Import, ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { ensureLateImport } from "./shared.js";

export const STANDALONE_CLOCK_CAPABILITY_ID = "clock" as const;
export const STANDALONE_CLOCK_PROVIDER_ID = "embedder" as const;
export const STANDALONE_CLOCK_IMPORT_NAME = "__date_now" as const;

const CLOCK_PARAMS: readonly ValType[] = Object.freeze([]);
const CLOCK_RESULTS: readonly ValType[] = Object.freeze([{ kind: "f64" } as const]);

function functionImportAt(ctx: CodegenContext, functionIndex: number): Import | undefined {
  let index = 0;
  for (const imported of ctx.mod.imports) {
    if (imported.desc.kind !== "func") continue;
    if (index++ === functionIndex) return imported;
  }
  return undefined;
}

function exactClockSignature(ctx: CodegenContext, imported: Import | undefined): imported is Import {
  if (
    !imported ||
    imported.module !== "env" ||
    imported.name !== STANDALONE_CLOCK_IMPORT_NAME ||
    imported.desc.kind !== "func"
  ) {
    return false;
  }
  const type = ctx.mod.types[imported.desc.typeIdx];
  return (
    type?.kind === "func" && type.params.length === 0 && type.results.length === 1 && type.results[0]?.kind === "f64"
  );
}

function exactClockProvenance(ctx: CodegenContext, imported: Import): boolean {
  const provenance = ctx.mod.platformCapabilityImportProvenance?.get(imported);
  return (
    provenance?.capabilityId === STANDALONE_CLOCK_CAPABILITY_ID &&
    provenance.providerId === STANDALONE_CLOCK_PROVIDER_ID
  );
}

/** Return the exact compiler-owned clock import, never a same-name occupant. */
export function standaloneClockCapabilityImport(ctx: CodegenContext): Import | undefined {
  const index = ctx.funcMap.get(STANDALONE_CLOCK_IMPORT_NAME);
  if (index === undefined || index < 0 || index >= ctx.numImportFuncs) return undefined;
  const imported = functionImportAt(ctx, index);
  return exactClockSignature(ctx, imported) && exactClockProvenance(ctx, imported) ? imported : undefined;
}

/** Emit the exact certified standalone clock call when this module demanded it. */
export function emitCertifiedStandaloneClockSnapshot(ctx: CodegenContext, fctx: FunctionContext): boolean {
  if (ctx.standalone !== true || ctx.requiresStandaloneClockCapability !== true) return false;
  if (!standaloneClockCapabilityImport(ctx)) {
    throw new Error("standalone clock capability was certified without the __date_now provider");
  }
  fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get(STANDALONE_CLOCK_IMPORT_NAME)! });
  return true;
}

/** Preserve the legacy zero fallback while projecting an exact Date.now f64. */
export function emitStandaloneDateNowValue(ctx: CodegenContext, fctx: FunctionContext): void {
  if (!emitCertifiedStandaloneClockSnapshot(ctx, fctx)) fctx.body.push({ op: "f64.const", value: 0 });
}

/** Preserve the legacy i64-zero Date constructor while accepting clock epochs. */
export function emitStandaloneDateTimestamp(ctx: CodegenContext, fctx: FunctionContext): void {
  if (emitCertifiedStandaloneClockSnapshot(ctx, fctx)) fctx.body.push({ op: "i64.trunc_sat_f64_s" });
  else fctx.body.push({ op: "i64.const", value: 0n });
}

/**
 * Allocate and authenticate clock@1 exactly once.
 *
 * An existing same-name function is not adopted.  Adoption would let an
 * ambient declaration share the certified Date slot and silently inherit the
 * capability leak exemption/Program-ABI identity.
 */
export function ensureStandaloneClockCapabilityImport(ctx: CodegenContext): number {
  const existing = ctx.funcMap.get(STANDALONE_CLOCK_IMPORT_NAME);
  if (existing !== undefined) {
    if (!standaloneClockCapabilityImport(ctx)) {
      throw new Error("standalone clock capability collided with a non-certified __date_now callable");
    }
    return existing;
  }
  const index = ensureLateImport(ctx, STANDALONE_CLOCK_IMPORT_NAME, [...CLOCK_PARAMS], [...CLOCK_RESULTS]);
  if (index === undefined) {
    throw new Error("standalone clock capability could not allocate env.__date_now");
  }
  const imported = functionImportAt(ctx, index);
  if (!exactClockSignature(ctx, imported)) {
    throw new Error("standalone clock capability allocated a malformed env.__date_now import");
  }
  const provenance = (ctx.mod.platformCapabilityImportProvenance ??= new Map());
  if (provenance.has(imported)) {
    throw new Error("standalone clock capability import already has allocator provenance");
  }
  provenance.set(
    imported,
    Object.freeze({
      capabilityId: STANDALONE_CLOCK_CAPABILITY_ID,
      providerId: STANDALONE_CLOCK_PROVIDER_ID,
    }),
  );
  return index;
}
