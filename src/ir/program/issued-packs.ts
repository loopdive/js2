// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#7354 Perf4, Perf5) The issue record of a requirements planner whose packs are frozen and derived from a frozen
// prepared program: such a pack cannot come to disagree with its program, so a use checks only that the planner
// issued it, never re-derives it. Users: the realm and invocation requirements, and (Perf6) the Promise source
// census.

export interface IssuedPacks<Pack extends object> {
  issue(pack: Pack): Pack;
  assertIssued(pack: Pack): void;
}

/** `refuse` throws the planner's own error for a pack it did not issue (a copy, another planner's pack). */
export function issuedPacks<Pack extends object>(refuse: () => never): IssuedPacks<Pack> {
  const issued = new WeakSet<Pack>();
  return {
    issue: (pack) => {
      issued.add(pack);
      return pack;
    },
    assertIssued: (pack) => {
      if (!issued.has(pack)) refuse();
    },
  };
}
