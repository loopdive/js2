// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7363 slice A, A3 — a called eval source neither takes away the entry's script-var homes nor runs ahead of it.
// - Homes: a script `var` keeps its IR-owned home when every other source of the program is a called eval source.
//   A second startup script still takes it away.
// - Order: an eval source is a dependency of nothing and depends on its caller, so the inventory plans and lowers
//   the entry first, although `<eval:N>.js` sorts before it. The entry's gaps come first.
// - Startup: the zero-demand branch of the presentation's startup join is reached by a program with no executable
//   init, never by a called one: the entry holds the site's statement, so it always runs at startup.
// A site after `break` is never lowered, so its program compiles. Since A4 a site lowers while the global `eval` is
// pristine; the rows that show the site's gap first write `eval` after it, so the site refuses by A4's name.
import { describe, expect, it } from "vitest";
import { analyzeMultiSource } from "../src/checker/index.js";
import {
  literalDynamicCodeFileName,
  literalDynamicCodeTexts,
  pairLiteralDynamicCodeSources,
} from "../src/ir/literal-dynamic-code.js";
import { runsAtStartup } from "../src/ir/module-init-plan.js";
import { prepareWholeIrProgram } from "../src/ir/program-preparation.js";
import {
  compile,
  compileMulti,
  requiredPreparedEmission,
  type Test262CompileOptions,
} from "../src/test262/test262-prepared-entry.js";
import { instantiatePreparedArtifact } from "../src/test262/test262-prepared-runtime.js";
import { requireProgram, typedOptions } from "./helpers/typed-program-fixtures.js";

const literalEvalFileName = (index: number) => literalDynamicCodeFileName("eval", index);
const literalEvalTexts = (file: string, text: string) => literalDynamicCodeTexts(file, text).map((row) => row.text);

const options = {
  wholeProgram: Object.freeze({ kind: "prepared-program-required" as const, version: 1 as const }),
  backend: "wasmgc",
  target: "standalone",
  sourceMap: false,
  optimize: false,
  emitWat: false,
  fileName: "test.js",
  allowJs: true,
} as Test262CompileOptions;

const NOT_PRISTINE = "ir/from-ast: eval literal: the global eval is not pristine (#7363 A4)";
/** A write of the global `eval` after the site: the site refuses by A4's name. */
const REBIND = "\neval = 0;";
const NO_HOME = (name: string) => `module binding ${name} has no exact typed storage: not-direct`;
/** A qualifying site of `text` that is never lowered. */
const deadSite = (text: string) => `do { break; eval(${JSON.stringify(text)}); } while (false);`;

type Result = Awaited<ReturnType<typeof compile>>;
const errorsOf = (result: Result) => result.errors.filter((error) => error.severity === "error");
const gaps = async (source: string) => errorsOf(await compile(source, options)).map((error) => error.message);

/** Run a compiled program's startup; report its sources in inventory order and how startup ended. */
function run(result: Result) {
  expect(errorsOf(result).map((error) => error.message)).toEqual([]);
  const sources = requiredPreparedEmission(result)!.units.sources.map((row) => row.file);
  try {
    (instantiatePreparedArtifact(result).instance.exports.__module_init as (() => void) | undefined)?.();
    return { sources, startup: "returned" };
  } catch (error) {
    expect((error as object).constructor.name).toBe("Exception");
    return { sources, startup: "threw" };
  }
}

/** The real relation of `entry`, prepared as the Prepared entry prepares it; `edges` names resolved dependencies. */
function prepare(entry: string, extra: Record<string, string> = {}, edges: readonly [string, string][] = []) {
  const texts = literalEvalTexts("test.js", entry);
  const files: Record<string, string> = { ...extra, "test.js": entry };
  texts.forEach((text, index) => (files[literalEvalFileName(index)] = text));
  const ast = analyzeMultiSource(files, "test.js", undefined, { allowJs: true });
  const fileOf = (name: string) => ast.sourceFiles.find((source) => source.fileName === name)!;
  const resolvedDependencies = new Map(edges.map(([from, to]) => [fileOf(from), [fileOf(to)]]));
  return requireProgram(
    prepareWholeIrProgram({
      sourceFiles: ast.sourceFiles,
      entrySource: ast.entryFile,
      checker: ast.checker,
      policy: typedOptions.policy,
      deferTopLevelInit: false,
      literalDynamicCodeSources: pairLiteralDynamicCodeSources(ast.entryFile, ast.sourceFiles, texts.length),
      inventoryOptions: { resolvedDependencies },
    }),
  );
}

describe("#7363 A3 — a script var keeps its home beside called eval sources", () => {
  it("stops at the eval site, not at the var, whichever comes first", async () => {
    expect(await gaps(`var x = 1;\neval("x + 1");${REBIND}`)).toEqual([`${NOT_PRISTINE} in <module-init>`]);
    expect(await gaps(`eval("x + 1");\nvar x = 1;${REBIND}`)).toEqual([`${NOT_PRISTINE} in <module-init>`]);
  });

  // (RV7432 B2) A text that writes `x` is no site: the reads proof would not see the write.
  it("compiles the entry's var and the eval text's read of it, and runs the entry", async () => {
    const source = `var x = 1;\n${deadSite("x + 2")}\nx = 3;\nif (x !== 3) throw 1;`;
    expect(run(await compile(source, options))).toEqual({
      sources: ["test.js", literalEvalFileName(0)],
      startup: "returned",
    });
  });

  it("loses the home to a second startup script", async () => {
    const result = await compileMulti({ "other.js": "1;", "test.js": 'var x = 1;\neval("1");' }, "test.js", options);
    expect(errorsOf(result).map((error) => error.message)).toEqual([NO_HOME("x")]);
  });
});

describe("#7363 A3 — function values keep their homes beside called eval sources", () => {
  /** The program's Wasm functions; `body` once with a never-lowered site and once without. */
  const functions = async (body: string, site: string) => {
    const result = await compile(`${body}\ndo { break; ${site} } while (false);`, { ...options, emitWat: true });
    expect(errorsOf(result)).toEqual([]);
    return result.wat!.match(/\(func /g)!.length;
  };

  it("stops at the eval site, not at a declaration read as a value or constructed", async () => {
    expect(await gaps(`function f() {}\nf.x = 1;\neval("1");${REBIND}`)).toEqual([`${NOT_PRISTINE} in <module-init>`]);
    expect(await gaps(`function E() {}\nnew E();\neval("1");${REBIND}`)).toEqual([`${NOT_PRISTINE} in <module-init>`]);
  });

  it("runs a declaration's value beside an eval text that writes its property", async () => {
    const source = `function f() { return 1; }\nf.x = 2;\n${deadSite("f.x = 3")}\nif (f.x !== 2 || f() !== 1) throw 1;`;
    expect(run(await compile(source, options))).toEqual({
      sources: ["test.js", literalEvalFileName(0)],
      startup: "returned",
    });
  });

  // The called source adds its own init and nothing else: it makes no function object, and a call through a static
  // function value stays the closure's direct call.
  it.each([
    ["a declaration read as a value", "function f() { return 1; }\nf.x = 2;\nif (f.x !== 2 || f() !== 1) throw 1;"],
    ["a static function value", "var g = function () { return 1; };\nif (g() !== 1) throw 1;"],
  ])("lowers the entry as without the site: %s", async (_label, body) => {
    expect(await functions(body, 'eval("1");')).toBe((await functions(body, "")) + 1);
  });
});

describe("#7363 A3 — an eval source follows its caller", () => {
  it("is planned after the entry although its name sorts first", async () => {
    expect(literalEvalFileName(0) < "test.js").toBe(true);
    expect(run(await compile(deadSite("1"), options)).sources).toEqual(["test.js", literalEvalFileName(0)]);
  });

  it("keeps every other source in its own order", async () => {
    const result = await compileMulti({ "called.js": "1;", "test.js": deadSite("1") }, "test.js", options);
    expect(run(result).sources).toEqual(["test.js", literalEvalFileName(0), "called.js"]);
  });

  it("lowers the entry first: a gap of the eval text does not come before the site's", async () => {
    // The array literal's dynamic element has no IR lowering yet: lowered first, the eval text would stop at it.
    const [error] = errorsOf(await compile(`var x = 1;\neval("[x];");${REBIND}`, options));
    expect([error!.message, error!.file]).toEqual([`${NOT_PRISTINE} in <module-init>`, "test.js"]);
  });

  it("keeps a caller's resolved dependency edges", () => {
    // Without the edge, `a.js` sorts before `b.js`; the supplied edge puts `b.js` first.
    const order = (edges: readonly [string, string][]) =>
      prepare(deadSite("1"), { "a.js": "1;", "b.js": "2;" }, edges).inventory.sources.map((row) => row.sourceKey);
    expect(order([])).toEqual(["test.js", literalEvalFileName(0), "a.js", "b.js"]);
    expect(order([["a.js", "b.js"]])).toEqual(["test.js", literalEvalFileName(0), "b.js", "a.js"]);
  });
});

describe("#7363 A3 — the startup join's zero-demand branch", () => {
  it("is reached by a program with no executable init, which compiles with no startup", async () => {
    expect(run(await compile("function f() {}", options))).toEqual({ sources: ["test.js"], startup: "returned" });
  });

  it("is never reached with a called init: the entry holding the site always runs at startup", () => {
    for (const entry of [deadSite("1"), `l: { break l; eval("1"); }`]) {
      const program = prepare(entry);
      expect(program.startup.map((plan) => [plan.invocation.kind, runsAtStartup(plan)])).toEqual([
        ["wasm-start", true],
        ["called", false],
      ]);
    }
  });
});
