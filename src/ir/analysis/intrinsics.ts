// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { IntrinsicSignature, IntrinsicUse, IntrinsicVerificationFailure } from "../core/intrinsic-contracts.js";
import { INTRINSIC_DEFINITIONS, isIntrinsicId } from "../core/intrinsics.js";
import { irTypeEquals, type IrType } from "../core/types.js";
import type { IrInstr, IrInstrIntrinsic, IrValueId } from "../core/nodes.js";
import { effectsArePure, effectsOf } from "./effects.js";

/**
 * Opaque proof that effect classification came from the existing `effectsOf`
 * authority. R6 does not grow a second throw/allocate/suspend table beside it.
 * The future intrinsic IR node can use this seam once M1 owns nodes/effects.
 */
export class IntrinsicEffectEvidence {
  readonly #pure: boolean;

  private constructor(instruction: IrInstr) {
    this.#pure = effectsArePure(effectsOf(instruction));
    Object.freeze(this);
  }

  static fromInstruction(instruction: IrInstr): IntrinsicEffectEvidence {
    return new IntrinsicEffectEvidence(instruction);
  }

  isPure(): boolean {
    return this.#pure;
  }
}

export function intrinsicEffectEvidence(instruction: IrInstr): IntrinsicEffectEvidence {
  return IntrinsicEffectEvidence.fromInstruction(instruction);
}

function signatureMismatch(use: IntrinsicUse, signature: IntrinsicSignature): string | undefined {
  if (use.argumentTypes.length !== signature.params.length) {
    return `${use.id} expects ${signature.params.length} argument(s), received ${use.argumentTypes.length}`;
  }
  for (let index = 0; index < signature.params.length; index++) {
    if (!irTypeEquals(use.argumentTypes[index]!, signature.params[index]!)) {
      return `${use.id} argument ${index} does not match its v${signature.version} signature`;
    }
  }
  if (!irTypeEquals(use.resultType, signature.result)) {
    return `${use.id} result does not match its v${signature.version} signature`;
  }
  return undefined;
}

/** Verify one semantic use before it is admitted to the manifest builder. */
export function verifyIntrinsicUse(
  use: IntrinsicUse,
  effects: IntrinsicEffectEvidence,
): IntrinsicVerificationFailure | undefined {
  if (!isIntrinsicId(use.id)) {
    return { code: "unknown-intrinsic", detail: `unknown intrinsic ${String(use.id)}` };
  }
  if (
    use.location.file.length === 0 ||
    !Number.isInteger(use.location.line) ||
    use.location.line < 1 ||
    !Number.isInteger(use.location.column) ||
    use.location.column < 0
  ) {
    return { code: "invalid-intrinsic-location", detail: `${use.id} has an invalid source location` };
  }
  const definition = INTRINSIC_DEFINITIONS[use.id];
  if (use.version !== definition.signature.version) {
    return {
      code: "intrinsic-version-mismatch",
      detail: `${use.id} uses signature v${use.version}; expected v${definition.signature.version}`,
    };
  }
  const mismatch = signatureMismatch(use, definition.signature);
  if (mismatch) return { code: "intrinsic-signature-mismatch", detail: mismatch };
  if (!(effects instanceof IntrinsicEffectEvidence) || !effects.isPure()) {
    return {
      code: "intrinsic-effect-mismatch",
      detail: `${use.id} is certified pure but its IR effect authority reports observable effects`,
    };
  }
  return undefined;
}

/** Verify the closed semantic signature before runtime provider authentication. */
export function verifyIrIntrinsicSignature(
  instr: IrInstrIntrinsic,
  typeOf: ReadonlyMap<IrValueId, IrType>,
): readonly string[] {
  const errors: string[] = [];
  const definition = INTRINSIC_DEFINITIONS[instr.id];
  if (instr.version !== definition.signature.version) {
    errors.push(`${instr.id} uses signature v${instr.version}; expected v${definition.signature.version}`);
  }
  if (instr.args.length !== definition.signature.params.length) {
    errors.push(`${instr.id} expects ${definition.signature.params.length} argument(s), got ${instr.args.length}`);
  }
  for (let index = 0; index < instr.args.length && index < definition.signature.params.length; index++) {
    const actual = typeOf.get(instr.args[index]!);
    const expected = definition.signature.params[index]!;
    if (actual && !irTypeEquals(actual, expected)) {
      errors.push(`${instr.id} argument ${index} does not match its v${instr.version} signature`);
    }
  }
  if (!instr.resultType || !irTypeEquals(instr.resultType, definition.signature.result)) {
    errors.push(`${instr.id} result does not match its v${instr.version} signature`);
  }
  return errors;
}
