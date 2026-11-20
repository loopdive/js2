// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#7354 Perf) The IR program's settled verdicts: the shared mechanism (`shared/contracts/settled-verdict.ts`) bound
// to the IR's own frozen collections, for the requirement checks under `src/ir/program/`.
import { preparedIrSettledVerdicts } from "../../shared/contracts/settled-verdict.js";
import { preparedIrFrozenCollectionMembers } from "./data.js";

export type { PreparedIrSettlement } from "../../shared/contracts/settled-verdict.js";

export const {
  isImmutable: isImmutablePreparedIrValue,
  checkUnlessSettled,
  settledAtIssue,
  settledChecks,
} = preparedIrSettledVerdicts(preparedIrFrozenCollectionMembers);
