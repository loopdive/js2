// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { effectsArePure, effectsConflict, effectsOf, isSideEffecting } from "./effects.js";
import type { IrInstr, IrValueId } from "./nodes.js";

interface LexicalPoint {
  readonly region: number;
  readonly index: number;
}

interface LexicalUsePoint extends LexicalPoint {
  readonly consumer?: IrInstr;
}

export interface NestedStackificationInput {
  readonly crossBlock: Set<IrValueId>;
  readonly needsLocal: Set<IrValueId>;
  readonly anchorEager: ReadonlySet<IrValueId>;
  readonly totalUses: ReadonlyMap<IrValueId, number>;
  readonly definitions: ReadonlyMap<IrValueId, IrInstr>;
  readonly definitionPoints: ReadonlyMap<IrValueId, LexicalPoint>;
  readonly usePoints: ReadonlyMap<IrValueId, readonly LexicalUsePoint[]>;
  readonly instructionsByRegion: ReadonlyMap<number, readonly IrInstr[]>;
}

/** Keep eligible single-use values in nested buffers on the Wasm stack. */
export function stackifyMovableNestedValues(input: NestedStackificationInput): void {
  const {
    crossBlock,
    needsLocal,
    anchorEager,
    totalUses,
    definitions,
    definitionPoints,
    usePoints,
    instructionsByRegion,
  } = input;
  for (const value of [...crossBlock]) {
    const defPoint = definitionPoints.get(value);
    const uses = usePoints.get(value);
    const def = definitions.get(value);
    const usePoint = uses?.length === 1 ? uses[0] : undefined;
    const consumer = usePoint?.consumer;
    if (
      !defPoint ||
      defPoint.region >= 0 ||
      !def ||
      effectsArePure(effectsOf(def)) ||
      !usePoint ||
      usePoint.region !== defPoint.region ||
      usePoint.index <= defPoint.index ||
      !consumer
    ) {
      continue;
    }
    const regionInstrs = instructionsByRegion.get(defPoint.region);
    if (!regionInstrs) continue;
    let terminalConsumer = consumer;
    let terminalIndex = usePoint.index;
    const movableStringSlotRead = def.kind === "slot.read" && def.resultType?.kind === "string";
    const blocksMotion = (between: IrInstr): boolean => {
      const betweenEffects = effectsOf(between);
      if (effectsArePure(betweenEffects)) return false;
      return !movableStringSlotRead || between.kind !== "slot.read" || effectsConflict(effectsOf(def), betweenEffects);
    };
    let terminalAtRegionEnd = false;
    const isInPlace = (candidate: IrInstr): boolean =>
      candidate.result === null ||
      crossBlock.has(candidate.result) ||
      anchorEager.has(candidate.result) ||
      ((totalUses.get(candidate.result) ?? 0) === 0 && isSideEffecting(candidate));
    while (!isInPlace(terminalConsumer)) {
      if (terminalConsumer.result === null || !effectsArePure(effectsOf(terminalConsumer))) break;
      const nextUses = usePoints.get(terminalConsumer.result);
      const next = nextUses?.length === 1 ? nextUses[0] : undefined;
      if (
        !next ||
        next.region !== defPoint.region ||
        next.index <= terminalIndex ||
        regionInstrs.slice(terminalIndex + 1, next.index).some(blocksMotion)
      ) {
        break;
      }
      terminalIndex = next.index;
      if (!next.consumer) {
        terminalAtRegionEnd = movableStringSlotRead && next.index === regionInstrs.length;
        break;
      }
      terminalConsumer = next.consumer;
    }
    if (!terminalAtRegionEnd && !isInPlace(terminalConsumer)) continue;
    if (regionInstrs.slice(defPoint.index + 1, terminalIndex).some(blocksMotion)) continue;
    crossBlock.delete(value);
    needsLocal.delete(value);
  }
}
