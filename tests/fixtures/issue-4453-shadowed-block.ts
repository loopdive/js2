// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Fixture for #4453: the shape of src/import-resolver.ts' two sibling
// `const replacementText` declarations — the first inside a nested if-block,
// the second in the enclosing statement list. Correct code; the TDZ scan used
// to report the inner block's mentions as uses of the outer binding.
export function reduce(kind: number, lines: string[]): string {
  if (kind === 0) {
    const replacementText = lines.length > 0 ? lines[0] : "";
    return replacementText + replacementText;
  }

  const replacementText = lines.length > 0 ? lines[0] : "none";
  return replacementText;
}
