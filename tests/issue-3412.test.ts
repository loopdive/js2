// #3412 — Script top-level FunctionDeclarations are var-scoped and may be
// redeclared. The literal Test262 harness relies on this because assert.js and
// testTypedArray.js both declare `isPrimitive`.
import { describe, expect, it } from "vitest";
import { detectEarlyErrors } from "../src/compiler/validation.js";
import { ts } from "../src/ts-api.js";

function hardErrors(source: string): string[] {
  const file = ts.createSourceFile("input.js", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  return detectEarlyErrors(file)
    .filter((error) => error.severity === "error")
    .map((error) => error.message);
}

describe("#3412 Script function redeclarations", () => {
  it("allows the harness-shaped duplicate at Script top level", () => {
    const errors = hardErrors(`
      function isPrimitive(value) { return value === null; }
      function isPrimitive(val) { return typeof val !== "object"; }
    `);
    expect(errors).not.toContain("Duplicate identifier 'isPrimitive'");
  });

  it("allows duplicate top-level functions in a strict Script", () => {
    expect(hardErrors(`"use strict"; function f() {} function f() {}`)).not.toContain("Duplicate identifier 'f'");
  });

  it("allows duplicate functions at the top level of a strict function body", () => {
    expect(hardErrors(`function outer() { "use strict"; function f() {} function f() {} }`)).not.toContain(
      "Duplicate identifier 'f'",
    );
  });

  it("allows Annex B duplicate functions in a sloppy nested block", () => {
    expect(hardErrors(`{ function f() {} function f() {} }`)).not.toContain("Duplicate identifier 'f'");
  });

  it("rejects duplicate functions in a Module", () => {
    expect(hardErrors(`function f() {} function f() {} export {};`)).toContain("Duplicate identifier 'f'");
  });

  it("rejects duplicate functions in a strict nested block", () => {
    expect(hardErrors(`"use strict"; { function f() {} function f() {} }`)).toContain("Duplicate identifier 'f'");
  });

  it("still rejects function versus lexical declaration conflicts", () => {
    expect(hardErrors(`function f() {} let f;`)).toContain("Duplicate identifier 'f'");
    expect(hardErrors(`const g = 1; function g() {}`)).toContain("Duplicate identifier 'g'");
  });
});
