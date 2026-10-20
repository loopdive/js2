// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it } from "vitest";
import * as compatibility from "../src/codegen/builtin-tags.js";
import * as canonical from "../src/shared/contracts/js-builtin-tags.js";

it("preserves every exported contract identity through the compiler compatibility path", () => {
  const names = Object.keys(canonical) as (keyof typeof canonical)[];
  expect(names.length).toBe(8);
  expect(Object.keys(compatibility).sort()).toEqual([...names].sort());
  for (const name of names) expect(compatibility[name]).toBe(canonical[name]);
});
it.each(["TypeError", "ReferenceError"])("uses the canonical Error ancestry for %s", (name) => {
  expect(canonical.getBuiltinParent(name)).toBe("Error");
  expect(canonical.isBuiltinSubtype(name, "Error")).toBe(true);
  expect(canonical.isBuiltinSubtype(name, "TypeError")).toBe(name === "TypeError");
});
it("keeps unknown names outside the builtin authority", () => {
  expect(canonical.isBuiltinTypeName("ForeignError")).toBe(false);
  expect(canonical.getBuiltinParent("ForeignError")).toBeUndefined();
  expect(canonical.isBuiltinSubtype("ForeignError", "Error")).toBe(false);
});
