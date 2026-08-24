// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { irGlobalBindingKey } from "../ir/abi-bindings.js";
import { irBindingKey, irModuleDeclarations } from "../ir/declared-types.js";
import {
  forEachInstrDeep,
  irTypeEquals,
  irVal,
  type IrGlobalBinding,
  type IrModule,
  type IrModuleDeclarations,
  type IrType,
} from "../ir/nodes.js";
import { ProgramAbiInvariantError } from "../ir/program-abi.js";
import type { Import, ValType, WasmModule } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";

type GlobalImport = Import & { readonly desc: Extract<Import["desc"], { readonly kind: "global" }> };

function expectedOrigin(binding: IrGlobalBinding): "source" | "import" | "runtime" | "support" {
  return binding.kind;
}

function structuralReferenceKey(binding: IrGlobalBinding): string {
  try {
    return irGlobalBindingKey(binding);
  } catch (error) {
    throw new ProgramAbiInvariantError(
      "invalid-binding-reference",
      `declared-global projection received an invalid global reference: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function globalCarrierAt(module: WasmModule, importedGlobals: readonly GlobalImport[], index: number): ValType {
  if (!Number.isSafeInteger(index) || index < 0) {
    throw new ProgramAbiInvariantError(
      "eliminated-required-locator",
      `declared-global projection resolved invalid global index ${index}`,
    );
  }
  if (index < importedGlobals.length) return importedGlobals[index]!.desc.type;
  const defined = module.globals[index - importedGlobals.length];
  if (!defined) {
    throw new ProgramAbiInvariantError(
      "eliminated-required-locator",
      `declared-global projection resolved missing global index ${index}`,
    );
  }
  return defined.type;
}

/**
 * Project the exact allocator carriers referenced by one IR module into the
 * verifier's declared-global vocabulary.
 *
 * The live Program ABI draft proves semantic identity and the current-index
 * resolver proves exact allocator ownership. The allocator object at that
 * index remains the carrier authority: draft `valueType` strings are
 * diagnostic snapshots and can be stale after type-index remapping.
 */
export function programAbiDeclaredGlobals(
  ctx: Pick<CodegenContext, "mod" | "programAbiSession">,
  module: Pick<IrModule, "functions">,
): ReadonlyMap<string, IrType> | undefined {
  const session = ctx.programAbiSession;
  if (!session) return undefined;
  session.assertModule(ctx.mod);

  const importedGlobals = ctx.mod.imports.filter((entry): entry is GlobalImport => entry.desc.kind === "global");
  const declarations = new Map<string, IrType>();

  for (const fn of module.functions) {
    for (const block of fn.blocks) {
      for (const root of block.instrs) {
        forEachInstrDeep(root, (instr) => {
          if (instr.kind !== "global.get" && instr.kind !== "global.set") return;
          const { binding } = instr.target;
          const draft = session.getDraft(binding.bindingId);
          if (draft?.intent.kind !== "global" || draft.intent.origin !== expectedOrigin(binding)) {
            throw new ProgramAbiInvariantError(
              "invalid-binding-reference",
              `global reference ${instr.target.name} does not match a live Program ABI global draft`,
            );
          }

          const structuralKey = structuralReferenceKey(binding);
          const currentIndex = session.resolveCurrentIndex(binding.bindingId, "global", structuralKey, ctx.mod);
          const declarationKey = irBindingKey(binding);
          if (declarationKey === null) {
            throw new ProgramAbiInvariantError(
              "invalid-binding-reference",
              `global reference ${instr.target.name} has no verifier declaration key`,
            );
          }

          const type = irVal(globalCarrierAt(ctx.mod, importedGlobals, currentIndex));
          const previous = declarations.get(declarationKey);
          if (previous && !irTypeEquals(previous, type)) {
            throw new ProgramAbiInvariantError(
              "session-draft-mismatch",
              `global declaration ${declarationKey} resolves to conflicting allocator carriers`,
            );
          }
          declarations.set(declarationKey, type);
        });
      }
    }
  }
  return declarations;
}

/** Add Program ABI global declarations beside the module's own signatures. */
export function programAbiModuleDeclarations(
  ctx: Pick<CodegenContext, "mod" | "programAbiSession">,
  module: IrModule,
): IrModuleDeclarations {
  const projected = programAbiDeclaredGlobals(ctx, module);
  if (projected === undefined) return irModuleDeclarations(module);
  if (module.declaredGlobals === undefined) {
    return irModuleDeclarations({ ...module, declaredGlobals: projected });
  }
  const declaredGlobals = new Map(projected);
  for (const [key, type] of module.declaredGlobals) declaredGlobals.set(key, type);
  return irModuleDeclarations({ ...module, declaredGlobals });
}
