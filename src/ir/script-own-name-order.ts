// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/** OrdinaryOwnPropertyKeys string portion: array indices precede other names.
 * Physical IR slots remain alphabetical; reflection must not depend on them. */
export function scriptOwnNameOrder(names: readonly string[]): string[] {
  const indices: { name: string; index: number }[] = [];
  const strings: string[] = [];
  for (const name of names) {
    const index = Number(name);
    if (Number.isInteger(index) && index >= 0 && index < 4294967295 && String(index) === name) {
      indices.push({ name, index });
    } else {
      strings.push(name);
    }
  }
  indices.sort((a, b) => a.index - b.index);
  return [...indices.map(({ name }) => name), ...strings];
}
