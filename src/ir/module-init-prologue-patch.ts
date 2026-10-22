// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7106) Give an IR-claimed `<module-init>` the GlobalDeclarationInstantiation
 * prologue the direct emitter inlines (restricted-global throw, `var`
 * undefined seeds, the script's global-object function/`var` bindings,
 * live-binding seeds — see `codegen/declarations/module-init-prologue.ts`).
 *
 * The patch used to replace the direct body wholesale, prologue included, so a
 * claimed script silently skipped GDI. The prologue is now materialized once
 * per claimed initializer as a private helper, and the patch calls it before
 * the first IR statement.
 *
 * Timing is the load-bearing part. The emitters may register helpers, and a
 * late-import shift reaches only installed functions — never a lowered body
 * still waiting in the patch queue, nor a funcIdx the lowering resolver has
 * already captured. So the helper is built during preparation, before the
 * resolver exists and before any IR body is lowered.
 */
import type { ts } from "../ts-api.js";
import {
  buildModuleInitPrologueCall,
  retireModuleInitPrologueHelper,
} from "../codegen/declarations/module-init-prologue.js";
import type { CodegenContext } from "../codegen/context/types.js";
import type { IrUnitId } from "./identity.js";
import { IrUnsupportedError } from "./outcomes.js";
import type { Instr } from "./types.js";

export { moduleInitPrologueMayEmit } from "../codegen/declarations/module-init-prologue.js";

interface ModuleInitPrologueEntry {
  readonly artifactUnitId: IrUnitId;
  readonly moduleInit?: boolean;
}

/** Exact `call` into a prologue helper, keyed by the claimed initializer's UnitId. */
export type ModuleInitPrologueCalls = ReadonlyMap<IrUnitId, Instr & { readonly op: "call" }>;

/**
 * Build the prologue helper of every claimed initializer in `entries`. An
 * initializer whose prologue is empty gets no helper and no call, so its patch
 * stays byte-identical. An emitter failure withdraws only that initializer's
 * claim (`fail`), always as a soft Unsupported: the direct body, which carries
 * its own prologue, is a correct fallback, so it must never fail the compile.
 */
export function prepareModuleInitPrologueCalls<E extends ModuleInitPrologueEntry>(
  ctx: CodegenContext,
  entries: readonly E[],
  sourceOf: (unitId: IrUnitId) => ts.SourceFile | undefined,
  fail: (entry: E, error: unknown) => void,
): ModuleInitPrologueCalls {
  const calls = new Map<IrUnitId, Instr & { readonly op: "call" }>();
  for (const entry of entries) {
    if (entry.moduleInit !== true) continue;
    const sourceFile = sourceOf(entry.artifactUnitId);
    if (sourceFile === undefined) continue;
    try {
      const call = buildModuleInitPrologueCall(ctx, sourceFile);
      if (call?.op === "call") calls.set(entry.artifactUnitId, call);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      fail(
        entry,
        new IrUnsupportedError(
          "module-init-legacy-coupling",
          "resolve",
          `module-init: GDI prologue could not be replayed (${detail}) — legacy body carries it`,
        ),
      );
    }
  }
  return calls;
}

/** Prepend the prologue call (if any) to a claimed initializer's final body. */
export function withModuleInitPrologue(body: Instr[], calls: ModuleInitPrologueCalls, unitId: IrUnitId): Instr[] {
  const call = calls.get(unitId);
  return call === undefined ? body : [call, ...body];
}

/**
 * Empty the helper of every initializer whose IR body was not installed (its
 * owner failed after preparation). Nothing calls such a helper; emptying it
 * keeps the dead copy out of the binary without disturbing any function index.
 */
export function retireUninstalledModuleInitPrologues(
  ctx: CodegenContext,
  calls: ModuleInitPrologueCalls,
  installed: ReadonlySet<IrUnitId>,
): void {
  for (const [unitId, call] of calls) {
    if (!installed.has(unitId)) retireModuleInitPrologueHelper(ctx, call.funcIdx);
  }
}
