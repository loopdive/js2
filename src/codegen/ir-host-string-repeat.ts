// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { CodegenContext } from "./context/types.js";
import { funcSignatureOf } from "./func-space.js";
import { ensureLateImport, flushLateImportShifts } from "./shared.js";

export function hasExactIrStringRepeatProviderAbi(ctx: CodegenContext, funcIdx: number): boolean {
  const signature = funcSignatureOf(ctx, funcIdx);
  const stringCarrier = signature?.params[0];
  const resultCarrier = signature?.results[0];
  const exactCarrier = ctx.nativeStrings
    ? stringCarrier?.kind === "ref_null" &&
      resultCarrier?.kind === "ref_null" &&
      stringCarrier.typeIdx === ctx.anyStrTypeIdx &&
      resultCarrier.typeIdx === ctx.anyStrTypeIdx
    : stringCarrier?.kind === "externref" && resultCarrier?.kind === "externref";
  return (
    signature?.params.length === 2 &&
    signature.params[1]?.kind === "f64" &&
    signature.results.length === 1 &&
    exactCarrier
  );
}

function exactEnvStringRepeatIndex(ctx: CodegenContext): number | undefined {
  let functionIndex = 0;
  for (const imported of ctx.mod.imports) {
    if (imported.desc.kind !== "func") continue;
    if (imported.module === "env" && imported.name === "string_repeat") return functionIndex;
    functionIndex++;
  }
  return undefined;
}

/** Prepare the exact host `(externref,f64)->externref` provider. */
export function ensureIrHostStringRepeatProvider(ctx: CodegenContext): number {
  const ensured = ensureLateImport(
    ctx,
    "string_repeat",
    [{ kind: "externref" }, { kind: "f64" }],
    [{ kind: "externref" }],
    "env",
  );
  flushLateImportShifts(ctx, null);
  const exact = exactEnvStringRepeatIndex(ctx);
  if (
    ensured === undefined ||
    exact === undefined ||
    ensured !== exact ||
    !hasExactIrStringRepeatProviderAbi(ctx, exact)
  ) {
    throw new Error("prepared string.repeat has no exact env.string_repeat import");
  }
  return exact;
}
