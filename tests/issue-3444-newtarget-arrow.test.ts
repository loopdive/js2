import { Script } from "node:vm";
import { describe, expect, it } from "vitest";
import { detectEarlyErrors } from "../src/compiler/early-errors/index.js";
import { compile } from "../src/index.js";
import { ts } from "../src/ts-api.js";

const NEW_TARGET_MESSAGE = "new.target is only valid inside functions";

type GrammarCase = {
  readonly name: string;
  readonly source: string;
  readonly accepts: boolean;
};

function nodeAccepts(source: string): boolean {
  try {
    new Script(source, { filename: "newtarget-control.js" });
    return true;
  } catch (error) {
    if (error instanceof SyntaxError) return false;
    throw error;
  }
}

function newTargetEarlyErrors(source: string): string[] {
  const sourceFile = ts.createSourceFile(
    "newtarget-control.js",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  return detectEarlyErrors(sourceFile)
    .filter((error) => error.severity === "error" && error.message.includes("new.target"))
    .map((error) => error.message);
}

const grammarCases: readonly GrammarCase[] = [
  {
    name: "rejects new.target in a global arrow body",
    source: "() => { new.target; };",
    accepts: false,
  },
  {
    name: "rejects new.target in a global arrow parameter initializer",
    source: "(value = new.target) => value;",
    accepts: false,
  },
  {
    name: "rejects new.target in a global computed method name",
    source: "({ [new.target]() {} });",
    accepts: false,
  },
  {
    name: "rejects new.target in a global computed getter name",
    source: "({ get [new.target]() { return 0; } });",
    accepts: false,
  },
  {
    name: "rejects new.target in a global computed setter name",
    source: "({ set [new.target](value) {} });",
    accepts: false,
  },
  {
    name: "rejects an arrow carrying new.target in a global computed method name",
    source: "({ [() => new.target]() {} });",
    accepts: false,
  },
  {
    name: "rejects an arrow carrying new.target in a global computed field name",
    source: "class C { [() => new.target] = 0; }",
    accepts: false,
  },
  {
    name: "accepts an arrow in an ordinary function body",
    source: "function f() { return () => new.target; }",
    accepts: true,
  },
  {
    name: "accepts an arrow in an ordinary function parameter initializer",
    source: "function f(value = () => new.target) {}",
    accepts: true,
  },
  {
    name: "accepts an arrow in a function expression",
    source: "const f = function () { return () => new.target; };",
    accepts: true,
  },
  {
    name: "accepts an arrow in a method body",
    source: "({ method() { return () => new.target; } });",
    accepts: true,
  },
  {
    name: "accepts an arrow in an accessor body",
    source: "({ get value() { return () => new.target; } });",
    accepts: true,
  },
  {
    name: "accepts new.target in a getter body",
    source: "({ get value() { return new.target; } });",
    accepts: true,
  },
  {
    name: "accepts new.target in a setter body",
    source: "({ set value(input) { new.target; } });",
    accepts: true,
  },
  {
    name: "accepts an arrow in a constructor body",
    source: "class C { constructor() { return () => new.target; } }",
    accepts: true,
  },
  {
    name: "accepts new.target in a class field initializer",
    source: "class C { field = new.target; }",
    accepts: true,
  },
  {
    name: "accepts new.target in a static class field initializer",
    source: "class C { static field = new.target; }",
    accepts: true,
  },
  {
    name: "accepts an arrow in a class field initializer",
    source: "class C { field = () => new.target; }",
    accepts: true,
  },
  {
    name: "accepts new.target in a class static block",
    source: "class C { static { new.target; } }",
    accepts: true,
  },
  {
    name: "accepts an arrow in a class static block",
    source: "class C { static { (() => new.target)(); } }",
    accepts: true,
  },
  {
    name: "accepts a computed field name when an outer function supplies new.target",
    source: "function f() { class C { [() => new.target] = 0; } }",
    accepts: true,
  },
];

describe("#3444 — arrow lexical NewTarget environments", () => {
  for (const grammarCase of grammarCases) {
    it(`${grammarCase.name} with the Node parser and early-error pass`, () => {
      // The host parser is an independent grammar oracle for this fixture
      // matrix. Keep it paired with the compiler's isolated early-error pass:
      // a successful code-generation route must not mask a parse error.
      expect(nodeAccepts(grammarCase.source)).toBe(grammarCase.accepts);
      expect(newTargetEarlyErrors(grammarCase.source)).toEqual(grammarCase.accepts ? [] : [NEW_TARGET_MESSAGE]);
    });
  }

  it("returns the global-arrow diagnostic through compile", async () => {
    const result = await compile("() => { new.target; };", { fileName: "newtarget-control.js" });

    expect(result.success).toBe(false);
    expect(result.errors.map((error) => error.message)).toContain(NEW_TARGET_MESSAGE);
  });

  it("does not reject a class field initializer through compile", async () => {
    const result = await compile("class C { field = new.target; }", { fileName: "newtarget-control.js" });

    expect(result.success).toBe(true);
  });
});
