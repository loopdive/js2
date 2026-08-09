// (#743) The two Parser.pos pin-retirement slices measured by the 2026-08-08
// pin census:
//
//  1. builtin-instance receiver carve-out (§4): `var err = new SyntaxError(…);
//     err.pos = p` is attributed NOWHERE instead of dragging every tracked
//     owner's `pos` fact to DYNAMIC through the name-based `"all"` bucket.
//  2. arithmetic F64-producer (`- * / % **`): either operand provably not a
//     BigInt ⇒ the expression is a Number (ToNumeric totality — mixed
//     numeric types throw, so no value flows on the counterexample path).
//
// Negative cases are the load-bearing half: the carve-out must NOT fire when
// the receiver can be anything else, and the producer must NOT fire when both
// operands could be BigInts.

import { describe, expect, it } from "vitest";
import { computeFnctorGraphCtorThisReadFacts } from "../src/ir/fnctor-method-edges.js";
import { ts } from "../src/ts-api.js";

function fixture(source: string): { checker: ts.TypeChecker; file: ts.SourceFile } {
  const files = new Map([
    ["/repo/a.ts", source],
    ["/repo/lib.d.ts", "declare var undefined: undefined;"],
  ]);
  const options: ts.CompilerOptions = {
    allowJs: true,
    checkJs: true,
    noImplicitAny: false,
    strict: false,
    target: ts.ScriptTarget.ES2022,
  };
  const host: ts.CompilerHost = {
    fileExists: (fileName) => files.has(fileName),
    readFile: (fileName) => files.get(fileName),
    getSourceFile: (fileName, languageVersion) => {
      const text = files.get(fileName);
      return text === undefined
        ? undefined
        : ts.createSourceFile(fileName, text, languageVersion, true, ts.ScriptKind.TS);
    },
    getDefaultLibFileName: () => "/repo/lib.d.ts",
    writeFile: () => {},
    getCurrentDirectory: () => "/repo",
    getDirectories: () => [],
    getCanonicalFileName: (fileName) => fileName,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
  };
  const program = ts.createProgram(["/repo/a.ts"], options, host);
  return { checker: program.getTypeChecker(), file: program.getSourceFile("/repo/a.ts")! };
}

/** `this.<name>` ctor-read facts keyed by source text, per the family's idiom. */
function reads(source: string): Map<string, string> {
  const { checker, file } = fixture(source);
  const out = new Map<string, string>();
  for (const [node, t] of computeFnctorGraphCtorThisReadFacts(file, { checker })) {
    out.set(node.getText(), t.kind);
  }
  return out;
}

// A tracked ctor whose `pos` fact is observable through `this.tag = this.pos`,
// plus an exported user so nothing is dead. The carve-out cases vary only the
// `boom` helper that writes `err.pos`.
const TRACKED = `
function Tracked(n) {
  this.pos = 0;
  this.tag = this.pos;
}
Tracked.prototype.bump = function () {
  this.pos = 1;
};
export function mk(n) {
  return new Tracked(n).tag;
}
`;

describe("#743 §4 — builtin-instance receiver carve-out", () => {
  it("drops an all-bucket write whose receiver is a proven builtin instance", () => {
    const facts = reads(`${TRACKED}
function boom(p) {
  var err = new SyntaxError("boom");
  err.pos = p.v;
  throw err;
}
export function b(p) { boom(p); }
`);
    expect(facts.get("this.pos")).toBe("f64");
  });

  it("keeps the write when the receiver is reassigned in-file", () => {
    const facts = reads(`${TRACKED}
function boom(p) {
  var err = new SyntaxError("boom");
  err = p;
  err.pos = p.v;
  throw err;
}
export function b(p) { boom(p); }
`);
    expect(facts.get("this.pos")).toBe("dynamic");
  });

  it("keeps the write when the receiver is reassigned via destructuring", () => {
    const facts = reads(`${TRACKED}
function boom(p) {
  var err = new SyntaxError("boom");
  ({ err } = p);
  err.pos = p.v;
  throw err;
}
export function b(p) { boom(p); }
`);
    expect(facts.get("this.pos")).toBe("dynamic");
  });

  it("keeps the write when the constructor is declared in-file", () => {
    // `new F(…)` on a plain in-file function can return a TRACKED instance
    // (ctor-return-object semantics) — the carve-out demands out-of-file.
    const facts = reads(`${TRACKED}
function Wobble() {}
function boom(p) {
  var err = new Wobble();
  err.pos = p.v;
  throw err;
}
export function b(p) { boom(p); }
`);
    expect(facts.get("this.pos")).toBe("dynamic");
  });
});

describe("#743 — arithmetic F64-producer (`- * / % **` ToNumeric totality)", () => {
  // `v` reaches the ctor param untyped through the exported entrypoint, so the
  // param's fact is DYNAMIC — exactly the operand class the core's
  // both-operands rule gives up on.
  const wrap = (init: string) => `
function T(a, b) {
  this.x = ${init};
  this.y = this.x;
}
export function mk(v, w) {
  return new T(v.a, w.b).y;
}
`;

  it("types `dynamic - literal` as f64 (literal proves not-BigInt)", () => {
    expect(reads(wrap("a - 1")).get("this.x")).toBe("f64");
  });

  it("types `dynamic * string` as f64 (ToNumeric of a string is a Number)", () => {
    expect(reads(wrap('a * "3"')).get("this.x")).toBe("f64");
  });

  it("types `dynamic ** literal` as f64 (core has no `**` arm at all)", () => {
    expect(reads(wrap("a ** 2")).get("this.x")).toBe("f64");
  });

  it("nests: `(a - 1) / b` is f64 via the proven left operand", () => {
    expect(reads(wrap("(a - 1) / b")).get("this.x")).toBe("f64");
  });

  it("stays dynamic when BOTH operands could be BigInts", () => {
    expect(reads(wrap("a - b")).get("this.x")).toBe("dynamic");
  });
});
