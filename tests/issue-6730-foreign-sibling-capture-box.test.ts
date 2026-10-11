// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6730 — a nested function's lift-time sibling classification must not take
// a SAME-NAMED nested function declared in ANOTHER frame for a sibling.
//
// `funcMap` / `nestedFuncCaptures` are keyed by bare name. Prettier's minified
// `printDocToString` (`Ce`) has plain `let f, d, c` variables that its nested
// `y()` reads, while `makeIndentation` (`fr`) declares nested helpers with the
// same names that capture a NUMBER `a`. Compiling `y` box-promoted fr's
// transitive captures in Ce's frame with fr's value types, so Ce's ARRAY `a`
// got an f64 ref cell and `a.length` became invalid Wasm
// (`struct.get[0] expected type (ref null N), found if of type f64`).
//
// node is the oracle for every value below (numbers, so both modes read
// them without a string bridge).
import { describe, expect, it } from "vitest";
import { compileMulti } from "../src/index.js";
import { buildImports, wrapExports } from "../src/runtime.js";

type Mode = { readonly name: string; readonly standalone?: boolean };
const MODES: readonly Mode[] = [{ name: "host" }, { name: "standalone", standalone: true }];

async function run(src: string, mode: Mode): Promise<unknown> {
  const result = await compileMulti({ "./main.js": src }, "./main.js", {
    allowJs: true,
    skipSemanticDiagnostics: true,
    deferTopLevelInit: true,
    ...(mode.standalone ? { target: "standalone" as const } : {}),
  });
  expect(result.success, result.errors?.map((e) => e.message).join("; ")).toBe(true);
  expect(WebAssembly.validate(result.binary), "binary should validate").toBe(true);
  const imports = result.importObject ?? buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports as WebAssembly.Imports);
  (imports as { setInstance?: (i: unknown) => void }).setInstance?.(instance);
  (imports as { __setExports?: (e: unknown) => void }).__setExports?.(instance.exports);
  (instance.exports as Record<string, Function>).__module_init?.();
  const wrapped = wrapExports(instance.exports as Record<string, Function>) as Record<string, () => unknown>;
  return wrapped.t!();
}

// `indent` declares a nested `d` capturing the mutable NUMBER `a`; `print` has
// a plain ARRAY `a` and a plain `d` variable its nested `y` reads.
const FOREIGN_SAME_NAME = `
function indent(parts) {
  let a = 0;
  for (const p of parts) d();
  return a;
  function d() { a += 1; }
}
function print(doc) {
  let a = [doc], s = "", d = [];
  while (a.length > 0) { s += a.pop(); y(); }
  return s.length + d.length;
  function y() { d.push(s.length); s = s + "!"; }
}
export function t() { return print("q") + indent([1, 2, 3]) * 100; }
`;

// Control: a GENUINE in-scope sibling still has its transitive captures
// promoted (the lifted body calls `bump`, which writes the frame's `n`).
const GENUINE_SIBLING = `
function outer(xs) {
  let n = 0, seen = [];
  for (const x of xs) visit(x);
  return n * 10 + seen.length;
  function bump() { n += 10; }
  function visit(x) { seen.push(x); bump(); }
}
export function t() { return outer([1, 2]); }
`;

describe("#6730 — foreign same-named nested function is not a sibling", () => {
  for (const mode of MODES) {
    describe(mode.name, () => {
      it("a frame variable shadowing another frame's nested function keeps its own type", async () => {
        expect(await run(FOREIGN_SAME_NAME, mode)).toBe(303);
      });
      it("a genuine in-scope sibling's captures still promote", async () => {
        expect(await run(GENUINE_SIBLING, mode)).toBe(202);
      });
    });
  }
});
