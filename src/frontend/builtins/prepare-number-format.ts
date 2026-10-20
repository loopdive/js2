// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { IrProgramSourcePreparation } from "../../ir/program-source.js";
import type { RuntimeManifestPolicy } from "../../runtime/contracts/provider-policy.js";
import { RuntimeManifestBuilder } from "../../ir/runtime/manifest.js";
import { nativeAsyncProviderMismatch } from "../../ir/runtime/native-async-callables.js";
import { numberFormatRadixSupportDeclarations } from "../../ir/program/formatter-support.js";
import {
  irNumberFormatDemandOwners,
  irRuntimeSupportOccurrences,
  type IrRuntimeSupport,
} from "../../ir/program/runtime-support.js";
import { numToStringRadixDefForVersion } from "../../stdlib/number-format.js";
import { NATIVE_RADIX_SOURCES, type NativeRadixSourceVersion } from "../../runtime/contracts/number-format-sources.js";
import { buildSelfHostedIrBody } from "./build-ir.js";

/** Build the genuine radix body once, against the source preparation's allocation owner. */
export function prepareNumberFormatRuntimeSupport(
  source: IrProgramSourcePreparation,
  policy: RuntimeManifestPolicy,
  version: NativeRadixSourceVersion = 2,
): IrRuntimeSupport | undefined {
  const demandOwners = irNumberFormatDemandOwners(source.ir.functions);
  if (demandOwners.length === 0) return undefined;
  if (policy.backend !== "wasmgc" || policy.target !== "standalone")
    throw new Error("number-format support requires wasmgc:standalone native policy");
  // Select the actual canonical provider before building or allocating support.
  const manifest = new RuntimeManifestBuilder(policy);
  manifest.requestFeature("async.native.number-to-string");
  manifest.freeze();
  const provider = manifest.resolveProvider("async.native.number-to-string");
  const mismatch = nativeAsyncProviderMismatch(provider);
  if (mismatch !== undefined) throw new Error(mismatch);
  const entries = source.inventory.sources.filter((entry) => entry.kind === "entry");
  if (entries.length !== 1) throw new Error("number-format support requires one entry source anchor");
  const sourceId = entries[0]!.id;
  if (source.allocations === undefined)
    throw new Error("number-format support requires the source allocation registry");
  const declarations = numberFormatRadixSupportDeclarations(sourceId);
  const definition = numToStringRadixDefForVersion(declarations.scratch.type, version);
  if (definition.source !== NATIVE_RADIX_SOURCES[version].source)
    throw Error("native radix definition differs from selected canonical source");
  const body = buildSelfHostedIrBody({
    definition,
    ownerUnitId: declarations.ownerUnitId,
    callees: new Map(
      declarations.kernels.map((kernel) => [
        kernel.ref.name,
        {
          target: kernel.ref,
          signature: { params: kernel.params, returnType: kernel.results[0] ?? null },
        },
      ]),
    ),
    allocRegistry: source.allocations,
  });
  const occurrences = irRuntimeSupportOccurrences(body);
  return {
    schema: "ir-runtime-support-v1",
    batches: [
      {
        ...(version === 1
          ? { kind: "number-format-radix-v1" as const, source: NATIVE_RADIX_SOURCES[1].provenance }
          : { kind: "number-format-radix-v2" as const, source: NATIVE_RADIX_SOURCES[2].provenance }),
        sourceId,
        demandOwners,
        scratch: declarations.scratch,
        kernels: declarations.kernels,
        implementation: { declaration: declarations.implementation, body },
        calls: occurrences.calls,
        literals: occurrences.literals,
      },
    ],
  };
}
