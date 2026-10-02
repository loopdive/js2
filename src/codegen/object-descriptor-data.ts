// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { Instr } from "../wasm/model/instructions.js";
import type { OrdinaryDescriptorResources } from "../runtime/wasmgc/values/ordinary-object-descriptor-common.js";
import { buildOrdinaryObjectDataDescriptorBody } from "../runtime/wasmgc/values/ordinary-object-descriptor-data.js";
import type { CodegenContext } from "./context/types.js";
import { canonicalUndefinedExternInstrs } from "./any-helpers.js";

/** Acquire the real undefined operand at the original descriptor-body call. */
export function buildObjectDataDescriptorBody(ctx: CodegenContext, resources: OrdinaryDescriptorResources): Instr[] {
  return buildOrdinaryObjectDataDescriptorBody(resources, [
    ...canonicalUndefinedExternInstrs(ctx),
    { op: "any.convert_extern" },
  ]);
}
