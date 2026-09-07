// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { PreparedIrProgram } from "./program.js";
import type { IrObservedOutcome } from "./outcomes.js";
import type { RuntimeBackend, RuntimeTarget } from "./runtime-manifest.js";

export interface PreparedIrProgramObservation {
  readonly phase: "prepared" | "accepted" | "emission-started" | "emitted";
  readonly program: PreparedIrProgram;
  readonly programId: string;
  readonly backend: RuntimeBackend;
  readonly target: RuntimeTarget;
}

/** Process-local observation join only; this handle is not semantic or serialized authority. */
export type PreparedIrProgramOutcome = IrObservedOutcome & { readonly preparedProgramId?: string };

const observationIds = new WeakMap<PreparedIrProgram, string>();
let nextObservationId = 0;

export function preparedIrProgramObservationId(program: PreparedIrProgram): string {
  const prior = observationIds.get(program);
  if (prior !== undefined) return prior;
  const id = `prepared-ir-observation:${++nextObservationId}`;
  observationIds.set(program, id);
  return id;
}

const listeners = new Set<(event: PreparedIrProgramObservation) => void>();

/** Internal capture seam for independent compiler-order and replay evidence. */
export function subscribePreparedIrProgram(listener: (event: PreparedIrProgramObservation) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Call at the real preparation/acceptance/emission boundary, never from telemetry row repair. */
export function observePreparedIrProgram(event: Omit<PreparedIrProgramObservation, "programId">): void {
  const observation = Object.freeze({ ...event, programId: preparedIrProgramObservationId(event.program) });
  for (const listener of listeners) listener(observation);
}
