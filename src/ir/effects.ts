// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

export {
  effectsOf,
  effectsArePure,
  effectsConflict,
  verifyEmissionSchedule,
  isSideEffecting,
} from "./analysis/effects.js";
export type { IrEffects, EmissionScheduleViolation } from "./analysis/effects.js";
