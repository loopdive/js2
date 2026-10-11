// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6651 VR1) `instanceof` must not fold on the evolving-`any` start state of a
 * binding that is assigned from inside a nested function.
 *
 * `var ctorThis;` with no annotation and no initializer is TypeScript's
 * "evolving any": its type at a reference is whatever control-flow analysis has
 * seen assigned so far, starting at `undefined`. CFA does not cross a function
 * boundary, so for
 *
 *     var cap;
 *     holder.S = function () { cap = this; };
 *     new holder.S();
 *     cap instanceof holder.S           // ← checker says `cap: undefined`
 *
 * the checker answers `undefined` at the reference even though the runtime value
 * is a live object. The #2998 primitive-LHS fold (§7.3.20 OrdinaryHasInstance
 * step 3, "if Type(O) is not Object, return false") then answered a CONSTANT
 * `false` without looking at the value — which is how
 * `built-ins/TypedArray/prototype/{filter,map,slice,subarray}/
 * speciesctor-get-species-custom-ctor-invocation.js` failed their `this`
 * assertion.
 *
 * The narrowing is only unsound in that one direction, so the guard is pinned to
 * it: the LHS must be an auto binding (no type, no initializer), the checker type
 * must be the evolving start state (`undefined` / `null`), and the binding must
 * be assigned inside a function nested in its own scope. The negative controls
 * below pin each of those three conditions, because each one dropped would widen
 * a host-free constant fold into a dynamic operator call.
 *
 * Every case asserts the ANSWER and that the standalone binary carries NO host
 * imports — declining the fold must not reintroduce the `env::__instanceof_check`
 * leak the #2998 fold retired.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

interface Outcome {
  imports: string[];
  result: number;
}

/** Compile a standalone SCRIPT, run `__module_init`, read `result`. */
async function run(body: string): Promise<Outcome> {
  const source = `var result = -1;\n${body}\nexport function test(): number { return result as number; }\n`;
  const compiled = await compile(source, {
    allowJs: true,
    fileName: "issue-6651-vr1-auto-binding-instanceof.ts",
    skipSemanticDiagnostics: true,
    target: "standalone",
    deferTopLevelInit: true,
    inferModuleStrictArguments: false,
  });
  expect(compiled.success, compiled.errors.map((e) => e.message).join("; ")).toBe(true);
  const imports = (compiled.imports ?? []).map((i: unknown) =>
    typeof i === "string" ? i : `${(i as { module: string }).module}::${(i as { name: string }).name}`,
  );
  const { instance } = await WebAssembly.instantiate(compiled.binary, {});
  (instance.exports as Record<string, unknown> & { __module_init?: () => void }).__module_init?.();
  return { imports, result: (instance.exports as Record<string, () => number>).test() };
}

describe("#6651 VR1 — instanceof on a cross-function-assigned auto binding", () => {
  it("answers true for a `this` captured into an auto binding from a property-held constructor", async () => {
    // The reduced species shape: an anonymous function expression written into a
    // property (so its `prototype` is vivified lazily, #6651 SP1), constructed,
    // and its `this` observed through BOTH a plain-object property and an auto
    // binding. Before this fix the two answers disagreed — 1 but not 2 — while
    // `===` compared them equal.
    const o = await run(
      `function main() {\n` +
        `  var cap; var obs = {}; var holder = {};\n` +
        `  holder.S = function () { obs.self = this; cap = this; };\n` +
        `  new holder.S();\n` +
        `  var m = 0;\n` +
        `  if (obs.self instanceof holder.S) m += 1;\n` +
        `  if (cap instanceof holder.S) m += 2;\n` +
        `  if (cap === obs.self) m += 4;\n` +
        `  return m;\n` +
        `}\n` +
        `result = main();`,
    );
    expect(o.result).toBe(7);
    expect(o.imports).toEqual([]);
  });

  it("answers true through a named function declaration too", async () => {
    const o = await run(
      `function main() {\n` +
        `  var cap;\n` +
        `  function S() { cap = this; }\n` +
        `  new S();\n` +
        `  return (cap instanceof S) ? 1 : 0;\n` +
        `}\n` +
        `result = main();`,
    );
    expect(o.result).toBe(1);
    expect(o.imports).toEqual([]);
  });

  it("negative control — a never-assigned auto binding still answers false (fold condition 3)", async () => {
    // Nothing assigns `cap`, so the checker's `undefined` IS sound and the
    // #2998 constant fold must survive. §7.3.20 step 3.
    const o = await run(
      `function main() {\n` +
        `  var cap;\n` +
        `  function S() {}\n` +
        `  return (cap instanceof S) ? 1 : 0;\n` +
        `}\n` +
        `result = main();`,
    );
    expect(o.result).toBe(0);
    expect(o.imports).toEqual([]);
  });

  it("negative control — an in-flow-narrowed auto binding still answers false (fold condition 2)", async () => {
    // CFA DID see this assignment, so the narrowed type is not the evolving
    // start state and the guard must not fire. A number LHS is not an object.
    const o = await run(
      `function main() {\n` +
        `  var cap;\n` +
        `  cap = 1;\n` +
        `  function S() {}\n` +
        `  return (cap instanceof S) ? 1 : 0;\n` +
        `}\n` +
        `result = main();`,
    );
    expect(o.result).toBe(0);
    expect(o.imports).toEqual([]);
  });

  it("negative control — a genuine `undefined` assigned across the boundary answers false", async () => {
    // The guard declines the FOLD; it does not assert the value is an object.
    // The dynamic operator must still answer `false` for a real `undefined`.
    const o = await run(
      `function main() {\n` +
        `  var cap;\n` +
        `  function S() {}\n` +
        `  function inner() { cap = undefined; }\n` +
        `  inner();\n` +
        `  return (cap instanceof S) ? 1 : 0;\n` +
        `}\n` +
        `result = main();`,
    );
    expect(o.result).toBe(0);
    expect(o.imports).toEqual([]);
  });

  it("negative control — a primitive assigned across the boundary answers false", async () => {
    const o = await run(
      `function main() {\n` +
        `  var cap;\n` +
        `  function S() {}\n` +
        `  function inner() { cap = 7; }\n` +
        `  inner();\n` +
        `  return (cap instanceof S) ? 1 : 0;\n` +
        `}\n` +
        `result = main();`,
    );
    expect(o.result).toBe(0);
    expect(o.imports).toEqual([]);
  });

  it("shadowing control — a same-named `var` in the nested function is a different binding", async () => {
    // `valueDeclarationOf` identity, not the name, decides. The outer `cap` is
    // never assigned, so the answer is `false` either way; what this pins is
    // that the shape compiles and stays host-free, so a future rewrite that
    // matched on the NAME would still have to keep this row green.
    const o = await run(
      `function main() {\n` +
        `  var cap;\n` +
        `  function S() {}\n` +
        `  function inner() { var cap; cap = new S(); return cap; }\n` +
        `  inner();\n` +
        `  return (cap instanceof S) ? 1 : 0;\n` +
        `}\n` +
        `result = main();`,
    );
    expect(o.result).toBe(0);
    expect(o.imports).toEqual([]);
  });

  it("an auto binding assigned only in a nested function, read as an object, answers its real proto", async () => {
    // Companion to the fold: `Object.getPrototypeOf` and `===` already read the
    // runtime value correctly, so they must stay correct.
    const o = await run(
      `function main() {\n` +
        `  var cap; var holder = {};\n` +
        `  holder.S = function () { cap = this; };\n` +
        `  new holder.S();\n` +
        `  var m = 0;\n` +
        `  if (typeof cap === "object") m += 1;\n` +
        `  if (Object.getPrototypeOf(cap) === holder.S.prototype) m += 2;\n` +
        `  if (cap instanceof holder.S) m += 4;\n` +
        `  return m;\n` +
        `}\n` +
        `result = main();`,
    );
    expect(o.result).toBe(7);
    expect(o.imports).toEqual([]);
  });
});
