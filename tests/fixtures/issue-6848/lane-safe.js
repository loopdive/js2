// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Anti-vacuity control (#6848): a reference-element callback that captures
// nothing typed `any` stays on the NATIVE lowering. The host delegation must
// only take calls the native lane declined.

export function nativeForEach() {
  const out = [];
  [
    ["a", 1],
    ["b", 2],
  ].forEach((pair) => {
    out.push(pair[0]);
  });
  return out.join(",");
}
