// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7354 L0a, L0b) Whether the program is lowered on the Prepared dynamic-value lane: the native dynamic carrier with
 * native strings (`source-dynamic-contracts.ts`). There the front end puts what it cannot type into the carrier, whose
 * legalization implements JavaScript's conversions, where the ordinary pipeline refuses. One predicate for every such
 * arm; a site that asks whether closures are function objects asks `createsFunctionObjects` instead.
 */
export function onPreparedDynamicLane(resolver: { preparedDynamicLane?(): boolean } | undefined): boolean {
  return resolver?.preparedDynamicLane?.() === true;
}
