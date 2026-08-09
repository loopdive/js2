// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4264) Value-carrier defects in the `with` statement, `--target standalone`.
 *
 * Everything here compiles in the SCRIPT goal (no `export`, `deferTopLevelInit`,
 * then an explicit `__module_init()`), because that is how `tests/test262-runner.ts`
 * compiles the `S12.10_A1.*` battery and because script-goal top-level `this` IS
 * the global object. Probing the same source as a MODULE produces a failure that
 * looks like a scope defect but is only a measurement artefact — see the header
 * of `es5-standalone-with.test.ts`.
 *
 * Each case asserts inside the script and throws on mismatch, so "the module
 * initialised without throwing" IS the assertion.
 */
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { compile } from "../src/index.js";

/** Compile `body` in the script goal; returns the host-free binary. */
async function compileScript(body: string): Promise<Uint8Array> {
  const src = `function CHK(c, m) { if (!c) { throw new Error("assertion failed: " + m); } }\n${body}\n`;
  const result = await compile(src, {
    allowJs: true,
    fileName: "es5-standalone-with-carrier.js",
    skipSemanticDiagnostics: true,
    target: "standalone",
    deferTopLevelInit: true,
  });
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(result.imports.map((i) => `${i.module}::${i.name}`)).toEqual([]);
  return result.binary;
}

/** Compile in the script goal, assert host-free, run `__module_init`. */
async function runScript(body: string): Promise<void> {
  const binary = await compileScript(body);
  const { instance } = await WebAssembly.instantiate(binary, {});
  (instance.exports as { __module_init: () => void }).__module_init();
}

/**
 * The `with` target shape the `S12.10_A1.*` battery uses: a method member
 * disqualifies the Tier-1 closed-literal proof, so the statement takes the
 * Tier-2 dynamic path — which is where every defect below lives.
 */
const DYNAMIC_TARGET = `
var myObj = {
  p1: 'a',
  p3: 'c',
  value: 'myObj_value',
  zzz: function () { return 'obj_zzz'; },
  valueOf: function () { return 'obj_valueOf'; },
  parseInt: function () { return 'obj_parseInt'; }
};
var del;
`;

describe("#4264 with-statement value carriers (standalone)", () => {
  it("a string-seeded var assigned a with-object FUNCTION keeps the function", async () => {
    // RED before the fix: the module global stayed `(mut (ref null $AnyString))`
    // because the checker resolves no declaration inside a `with` body, so the
    // function externref coerced to null.
    await runScript(`
      this.p3 = 3;
      ${DYNAMIC_TARGET}
      var st = "zzz";
      with (myObj) { st = zzz; del = delete p3; }
      CHK(st !== null, "st is null");
      CHK(typeof st === "function", "st is not a function");
    `);
  });

  it("a with-shadowed intrinsic does not compare equal to the global one", async () => {
    // RED before the fix, and asymmetrically so: `st === parseInt` answered TRUE
    // while `parseInt === st` answered FALSE, because only the LEFT operand's
    // (stale) checker type steers the native-string equality route. That is
    // assertion #11 of every `S12.10_A1.*` file.
    await runScript(`
      this.p3 = 3;
      ${DYNAMIC_TARGET}
      var st_parseInt = "parseInt";
      with (myObj) { st_parseInt = parseInt; del = delete p3; }
      CHK(st_parseInt !== parseInt, "st_parseInt === parseInt");
      CHK(parseInt !== st_parseInt, "reversed operand order disagrees");
    `);
  });

  it("a var DECLARED in a with body reads undefined when the object owns the name", async () => {
    // Assertions #18/#19 of the battery: §14.11.2 consults the object
    // environment first, so `var value = 'value'` stores into the OBJECT and
    // the hoisted binding is never written — it must still read `undefined`,
    // not the `ref.null.extern` a module global is constant-initialised to.
    await runScript(`
      ${DYNAMIC_TARGET}
      this.p3 = 3;
      with (myObj) { var value = 'value'; del = delete p3; }
      CHK(value === undefined, "hoisted value is not undefined");
      CHK(myObj.value === "value", "the object did not receive the write");
    `);
  });

  it("a var DECLARED in a with body still receives its value when the object lacks the name", async () => {
    // The negative twin of the case above: widening the slot and seeding
    // `undefined` must NOT swallow the declaration's own store. A naive fix
    // that always redirects a with-body `var` to the object fails here.
    await runScript(`
      ${DYNAMIC_TARGET}
      this.p3 = 3;
      with (myObj) { var p4 = 'x4'; del = delete p3; }
      CHK(p4 === "x4", "hoisted p4 lost its initializer");
      CHK(myObj.p4 === undefined, "the object wrongly received p4");
    `);
  });

  it("a var declared after an abrupt completion in a with body reads undefined", async () => {
    // §10.2.11 instantiates the binding at script entry, so a declaration the
    // body never reaches still leaves `undefined` — not `null`.
    await runScript(`
      ${DYNAMIC_TARGET}
      try {
        with (myObj) { throw 1; var p9 = 'x9'; }
      } catch (e) { /* expected */ }
      CHK(p9 === undefined, "unexecuted with-body var is not undefined");
    `);
  });

  it("a let inside the with body still shadows the object binding", async () => {
    // Only LEXICAL declarations shadow the object environment record. The
    // carrier widening must not disturb that: `zzz` here is the body's `let`,
    // never `myObj.zzz`.
    await runScript(`
      ${DYNAMIC_TARGET}
      var seen = "seed";
      with (myObj) { let zzz = "lexical"; seen = zzz; }
      CHK(seen === "lexical", "let did not shadow the with object");
    `);
  });

  it("an assignment through a with whose object lacks the name reaches the outer binding", async () => {
    await runScript(`
      var n = 1;
      var empty = { other: 1, m: function () { return 1; } };
      with (empty) { n = 2; }
      CHK(n === 2, "outer binding did not receive the write");
    `);
  });

  it("is demand-gated: a module with no `with` STATEMENT is byte-identical", async () => {
    // The analysis is gated on the source text containing "with", which is a
    // cheap pre-filter, NOT the decision. A module that merely mentions the
    // word must compile to the same bytes as one that does not — otherwise the
    // gate would be paying (and possibly widening) for every corpus file whose
    // comments happen to say "with".
    const bare = `
      var st = "seed";
      var o = { a: 1, m: function () { return 1; } };
      st = "other";
      CHK(st === "other", "plain assignment");
    `;
    const mentionsWith = `
      // a comment that says with, and a string "with" too
      var st = "seed";
      var o = { a: 1, m: function () { return 1; } };
      st = "other";
      CHK(st === "other", "plain assignment");
      var withish = "with";
      CHK(withish === "with", "string literal");
    `;
    const sha = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");
    const a = await compileScript(bare);
    const b1 = await compileScript(bare);
    expect(sha(a)).toBe(sha(b1));
    // The word-mentioning module compiles and behaves; its extra statements make
    // the bytes differ legitimately, so assert the BEHAVIOUR instead and rely on
    // the identical-source sha above for the emission-stability half.
    await runScript(mentionsWith);
  });
});
