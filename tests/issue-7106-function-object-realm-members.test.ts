// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7106 — a function object's realm members are not its expandos.
//
// In the native regime the IR lowers a receiver-only use of a top-level
// function `F` (`F.x(…)`, `F.x = v`, `var v = F.x`) to the boxed function
// object plus a dynamic member operation, and that operation resolves only
// `F`'s own expandos. A member the realm defines for every function went wrong:
// `F.bind()` threw "Value is not callable" (test262
// `built-ins/Function/prototype/bind/15.3.4.5-2-16.js`), `var v = F.valueOf`
// read undefined, and a strict function's poisoned `F.caller = v` stored where
// it must throw a TypeError (`language/statements/function/13.2-22-s.js`,
// `13.2-19-b-3gs.js`). The selector now refuses those uses, so legacy keeps
// them; an ordinary expando stays IR. Every case is checked against node.
import vm from "node:vm";
import { describe, expect, it } from "vitest";

import { compile, type CompileResult } from "../src/index.js";
import { assembleOriginalHarness } from "./test262-original-harness.js";
import { extractWasmExceptionMessage, parseMeta } from "./test262-runner.js";

const HARNESS_OPTIONS = {
  fileName: "test.js",
  allowJs: true,
  skipSemanticDiagnostics: true,
  target: "standalone",
  inferModuleStrictArguments: false,
  scriptGoal: true,
  deferTopLevelInit: true,
  hostBridge: "always",
  trackIrOutcomes: true,
} as Parameters<typeof compile>[1];

/** `ok`, or the name of the error the program throws. */
type Verdict = string;

function nodeVerdict(run: () => void): Verdict {
  try {
    run();
    return "ok";
  } catch (error) {
    return (error as Error).constructor.name;
  }
}

async function moduleVerdict(result: CompileResult): Promise<Verdict> {
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  let instance: WebAssembly.Instance | null = null;
  try {
    instance = (await WebAssembly.instantiate(result.binary, {})).instance;
    const exports = instance.exports as Record<string, (() => unknown) | undefined>;
    exports.__module_init?.();
    exports.test?.();
    return "ok";
  } catch (error) {
    return /^\w+/.exec(extractWasmExceptionMessage(error, instance))![0];
  }
}

function row(result: CompileResult, displayName: string) {
  return (result.irOutcomes ?? []).find((entry) => entry.displayName === displayName);
}

async function compileHarness(body: string): Promise<{ assembled: string; result: CompileResult }> {
  const source = `/*---\ndescription: function-object realm member\n---*/\n${body}`;
  const assembled = assembleOriginalHarness(source, parseMeta(source) as never).primary.source;
  return { assembled, result: await compile(assembled, HARNESS_OPTIONS) };
}

/** Refused at selection, so the IR never claims (and never demotes) the unit. */
const REFUSED = { kind: "unsupported", stage: "select", irBodyEmitted: false };

describe("#7106 — realm members of a function object in a harness <module-init>", () => {
  const REALM_MEMBER_CASES: readonly (readonly [string, string, Verdict])[] = [
    [
      "a strict function's poisoned `caller` write throws (13.2-22-s)",
      `function foo() {"use strict";}\nassert.throws(TypeError, function () {\n  foo.caller = 41;\n});\n`,
      "ok",
    ],
    [
      "a strict function's poisoned `arguments` read throws",
      `function foo() {"use strict";}\nvar v = foo.arguments;\n`,
      "TypeError",
    ],
    ["`F.bind()` binds (15.3.4.5-2-16)", `function testFunc() {}\ntestFunc.bind();\n`, "ok"],
    ["`F.valueOf()` resolves %Object.prototype.valueOf%", `function F() {}\nF.valueOf();\n`, "ok"],
    [
      "`var v = F.valueOf` reads %Object.prototype.valueOf%",
      `function F() {}\nvar v = F.valueOf;\nassert.sameValue(typeof v, "function");\n`,
      "ok",
    ],
  ];

  for (const [name, body, expected] of REALM_MEMBER_CASES) {
    it(
      name,
      async () => {
        const { assembled, result } = await compileHarness(body);
        expect(nodeVerdict(() => vm.runInContext(assembled, vm.createContext({})))).toBe(expected);
        expect(row(result, "<module-init>"), JSON.stringify(row(result, "<module-init>"))).toMatchObject(REFUSED);
        expect(await moduleVerdict(result)).toBe(expected);
      },
      60_000,
    );
  }

  it("an ordinary expando member call and the own `prototype` stay IR", async () => {
    const body = `function F() {}
F.helper = function (x) {
  assert.sameValue(x, 2);
};
F.helper(2);
var p = F.prototype;
assert.sameValue(typeof p, "object");
`;
    const { assembled, result } = await compileHarness(body);
    expect(nodeVerdict(() => vm.runInContext(assembled, vm.createContext({})))).toBe("ok");
    expect(row(result, "<module-init>"), JSON.stringify(row(result, "<module-init>"))).toMatchObject({
      irBodyEmitted: true,
    });
    expect(await moduleVerdict(result)).toBe("ok");
    // The member call really runs: a wrong argument fails its assertion.
    const wrong = await compileHarness(body.replace("F.helper(2)", "F.helper(3)"));
    expect(row(wrong.result, "<module-init>")?.irBodyEmitted).toBe(true);
    expect(await moduleVerdict(wrong.result)).toBe("Test262Error");
  }, 60_000);
});

describe("#7106 — realm members of a function object in a plain function", () => {
  const PLAIN_CASES: readonly (readonly [string, string, Verdict])[] = [
    ["`F.bind()`", `function F() {}\nexport function test() {\n  F.bind();\n  return 1;\n}\n`, "ok"],
    [
      "a strict function's `caller` write",
      `function F() {"use strict";}\nexport function test() {\n  F.caller = 1;\n  return 0;\n}\n`,
      "TypeError",
    ],
  ];

  for (const [name, source, expected] of PLAIN_CASES) {
    it(
      name,
      async () => {
        const result = await compile(source, {
          fileName: "test.js",
          allowJs: true,
          skipSemanticDiagnostics: true,
          target: "standalone",
          trackIrOutcomes: true,
        } as Parameters<typeof compile>[1]);
        expect(nodeVerdict(() => new Function(`${source.replace("export ", "")}\nreturn test();`)())).toBe(expected);
        expect(row(result, "test"), JSON.stringify(row(result, "test"))).toMatchObject(REFUSED);
        expect(await moduleVerdict(result)).toBe(expected);
      },
      60_000,
    );
  }
});
