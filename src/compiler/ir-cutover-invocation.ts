// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { SourceFile } from "typescript";
import type { IrBodyRouteAudit, IrLegacyBodyEntry } from "../codegen/legacy-body-audit.js";
import { getDefaultEnvironment } from "../env.js";
import type { CompileOptions, CompileResult } from "../index.js";
import type { IrClassRecord } from "../ir/identity.js";
import type { IrCompileRoute } from "../ir/standalone-route-manifest.js";
import type { PositionMap } from "../position-map.js";

const IR_CUTOVER_ROUTE = Symbol("irCutoverRoute");

export const IR_CUTOVER_AUDIT_SCHEMA = "js2-ir-cutover-audit-v1" as const;

export interface IrCutoverAuditEnvelope {
  readonly schema: typeof IR_CUTOVER_AUDIT_SCHEMA;
  readonly success: boolean;
  readonly audit: IrBodyRouteAudit;
}

type RoutedCompileOptions = CompileOptions & {
  readonly [IR_CUTOVER_ROUTE]?: IrCompileRoute;
};

/** Clone public options with an internal, non-enumerable physical-route label. */
export function withIrCompileRoute(options: CompileOptions | undefined, route: IrCompileRoute): CompileOptions {
  const base = options ?? {};
  const routed = Object.create(Object.getPrototypeOf(base), Object.getOwnPropertyDescriptors(base)) as CompileOptions;
  Object.defineProperty(routed, IR_CUTOVER_ROUTE, { value: route });
  return routed;
}

/** Supply an internal route only when a public wrapper has not already labelled the invocation. */
export function withDefaultIrCompileRoute(options: CompileOptions, route: IrCompileRoute): CompileOptions {
  return readIrCompileRoute(options) === undefined ? withIrCompileRoute(options, route) : options;
}

/** Read the private route marker without exposing it in the public CompileOptions shape. */
export function readIrCompileRoute(options: CompileOptions, fallback?: IrCompileRoute): IrCompileRoute | undefined {
  return (options as RoutedCompileOptions)[IR_CUTOVER_ROUTE] ?? fallback;
}

/**
 * The subprocess sink implicitly enables the otherwise opt-in physical-route ledger.
 * Writing requires synchronous `Environment.fs` from `process.getBuiltinModule`
 * (available in Node 20 from 20.16 and Node 22 from 22.3), CommonJS `require`,
 * or explicit injection.
 */
export function isIrCutoverAuditRequested(): boolean {
  return typeof process !== "undefined" && (process.env?.JS2WASM_IR_CUTOVER_AUDIT?.length ?? 0) > 0;
}

/**
 * Append one versioned subprocess-safe record without adding Node fs to browser module graphs.
 * The stream denominator is generator invocations: failures before codegen cannot emit a record.
 */
function appendIrCutoverAudit(result: CompileResult): void {
  const path = typeof process === "undefined" ? undefined : process.env?.JS2WASM_IR_CUTOVER_AUDIT;
  if (!path || !result.irBodyRouteAudit) return;
  try {
    const fs = getDefaultEnvironment().fs;
    if (!fs) throw new Error("synchronous node:fs is unavailable in this runtime");
    const envelope: IrCutoverAuditEnvelope = Object.freeze({
      schema: IR_CUTOVER_AUDIT_SCHEMA,
      success: result.success,
      audit: result.irBodyRouteAudit,
    });
    fs.appendFileSync(path, `${JSON.stringify(envelope)}\n`);
  } catch (cause) {
    throw new Error(
      `JS2WASM_IR_CUTOVER_AUDIT could not append to ${JSON.stringify(path)}; ` +
        "the opt-in sink requires synchronous Environment.fs via process.getBuiltinModule " +
        "(available in Node 20 from 20.16 and Node 22 from 22.3), CommonJS require, or explicit injection",
      { cause },
    );
  }
}

/** Emit the opt-in subprocess record while preserving the compile result for pipeline composition. */
export function emitIrCutoverAudit(result: CompileResult): CompileResult {
  appendIrCutoverAudit(result);
  return result;
}

function originalLineAndColumn(source: string, offset: number): { line: number; column: number } {
  let line = 1;
  let lastNewline = -1;
  for (let index = 0; index < offset; index++) {
    if (source.charCodeAt(index) === 10) {
      line++;
      lastNewline = index;
    }
  }
  return { line, column: offset - lastNewline };
}

function remapOffset(offset: number, originalSource: string, positionMap: PositionMap): number {
  return Math.min(Math.max(0, positionMap.toInputOffset(offset)), originalSource.length);
}

function remapLocation<T extends { readonly line: number; readonly column: number }>(
  value: T,
  processedFile: SourceFile,
  originalSource: string,
  positionMap: PositionMap,
): T {
  const processedOffset = processedFile.getPositionOfLineAndCharacter(value.line - 1, value.column - 1);
  const originalOffset = remapOffset(processedOffset, originalSource, positionMap);
  return { ...value, ...originalLineAndColumn(originalSource, originalOffset) };
}

/** Restore user-source locations before exposing or writing a single-source audit. */
export function finalizeSingleSourceIrTelemetry(
  result: CompileResult,
  processedFile: SourceFile,
  originalSource: string,
  positionMap: PositionMap,
): CompileResult {
  if (!positionMap.isIdentity && result.irOutcomes) {
    result.irOutcomes = result.irOutcomes.map((outcome) =>
      remapLocation(outcome, processedFile, originalSource, positionMap),
    );
  }
  if (!positionMap.isIdentity && result.irBodyRouteAudit) {
    const audit = result.irBodyRouteAudit;
    const legacyEntries = audit.legacyEntries.map(
      (entry): IrLegacyBodyEntry =>
        audit.sourceCount === 1 && entry.sourceId === audit.sources[0]?.id
          ? Object.freeze(remapLocation(entry, processedFile, originalSource, positionMap))
          : entry,
    );
    const classes = audit.classes.map(
      (record): IrClassRecord =>
        audit.sourceCount === 1 && record.sourceId === audit.sources[0]?.id
          ? Object.freeze({
              ...remapLocation(record, processedFile, originalSource, positionMap),
              declarationStart: remapOffset(record.declarationStart, originalSource, positionMap),
              declarationEnd: remapOffset(record.declarationEnd, originalSource, positionMap),
            })
          : record,
    );
    result.irBodyRouteAudit = Object.freeze({
      ...audit,
      classes: Object.freeze(classes),
      legacyEntries: Object.freeze(legacyEntries),
    });
  }
  return emitIrCutoverAudit(result);
}
