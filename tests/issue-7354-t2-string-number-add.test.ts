// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7354 slice T, cause 1 — `+` of a string and a number on the Prepared path. The source resolver answered no lane
// capability, so the `+` rule saw no number formatter and refused every string + number, even a typed one
// (`var z = 2; "a" + z`). It now answers `number-to-string` on wasmgc standalone, where the native formatter is
// admitted (Str2-c), and the number is converted as in a template. Each program is checked against node twice: node's
// answer returns, a wrong one throws.
import { describe, expect, it } from "vitest";
import { compile, type Test262CompileOptions } from "../src/test262/test262-prepared-entry.js";
import { agreesWithNode, preparedOptions } from "./helpers/prepared-node-agreement.js";

const EDGES = [
  "NaN",
  "1 / 0",
  "-1 / 0",
  "-0",
  "0",
  "1e21",
  "1e-7",
  "0.1 + 0.2",
  "9007199254740993",
  "-42.5",
  "123456789012345680000",
  "-1e-7",
  "5e-324",
  "1.7976931348623157e308",
];

describe("#7354 T — string + number", () => {
  // One chain in a function: a reassigned string local has no slot yet (a separate gap), and a script `var` holding a
  // string lives in the dynamic home, whose `+` worked before.
  it("formats every edge value on the right of a string", async () => {
    await agreesWithNode(`function f() { return ""${EDGES.map((v) => ` + "|" + (${v})`).join("")}; }\nvar out = f();`);
  });

  it("formats every edge value on the left of a string", async () => {
    await agreesWithNode(`var out = "";\n${EDGES.map((v) => `out = out + ((${v}) + "|");`).join("\n")}`);
  });

  it("formats typed script vars, and every edge value through `+=` (the dynamic home's `+`)", async () => {
    await agreesWithNode(
      `var z = -0; var w = 1e21; var q = 0.1 + 0.2;\nfunction f() { return q + "s" + z + w + -q; }\nvar out = f();\n` +
        `${EDGES.map((v) => `out += (${v});`).join("\n")}`,
    );
  });

  it("keeps the left-to-right grouping of a mixed chain", async () => {
    await agreesWithNode(`var a = 1; var b = 2;\nvar out = a + b + "x" + a + b + (a + b) + true + "y" + -a;`);
  });

  it("converts in a function, in a condition and as an argument", async () => {
    await agreesWithNode(
      `function f() { var k = 0.5; var s = "k" + k; return s + (k * 2) + "!"; }\n` +
        `function g(s) { return s + "."; }\n` +
        `var out = f() + g("n" + 3);\nif (("a" + 1) === "a1") out = out + "c";\nwhile (out + 1 === "") out = "";`,
    );
  });

  it("evaluates both operands of an unused `+`, effects and throws included", async () => {
    await agreesWithNode(
      `var t = 0; var hits = 0;\nfunction n() { hits = hits + 1; if (t === 1) throw 3; return 4; }\n` +
        `"a" + n();\nn() + "b";\nvar unused = "c" + n();\nt = 1;\nvar out = "";\n` +
        `try { "a" + n(); out = "not thrown"; } catch (e) { out = "caught " + e; }\nout = out + hits;`,
    );
  });

  it("still refuses on the gc target, which binds no Prepared number formatter", async () => {
    const options = { ...preparedOptions(), target: "gc" } as Test262CompileOptions;
    const result = await compile('function f() { var z = 2; return "a" + z; }\nf();\n', options, undefined, "refuse");
    expect(result.success).toBe(false);
    expect(result.errors.map((error) => error.message).join("\n")).toContain(
      "'+' operands not provably both-number or string-concatenable (string/number)",
    );
  });
});
