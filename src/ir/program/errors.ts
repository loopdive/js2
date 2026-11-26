// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// The class lives in the foundation layer so the stage 4 module validator (`src/wasm/physical`) throws the same
// error as every other Prepared stage (#7380).
export {
  PreparedIrProgramInvariantError,
  type PreparedIrProgramInvariantCode,
} from "../../shared/contracts/prepared-ir-program-errors.js";
