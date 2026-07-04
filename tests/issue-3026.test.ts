// #3026 — early error: trailing comma after a rest element in a destructuring
// pattern is a parse-time SyntaxError.
//
// The pre-existing "rest must be last" check caught `[...x, y]` (an element
// following the rest) but missed the bare trailing-comma case `[...x,]` /
// `({...x,})`. Per ES2015+ grammar, an AssignmentRestElement /
// BindingRestElement / AssignmentRestProperty / BindingRestProperty must be
// the final element, and no trailing comma (elision) may follow it. TypeScript's
// parser accepts the trailing comma silently, so the early-error pass detects it
// via the NodeArray `hasTrailingComma` flag when the last element is the rest.
//
// Guard against false positives: a trailing comma after a NON-rest element
// (`[a,]`, `{a,}`) is valid, and a spread with a trailing comma in an array/
// object literal *value* (`[...x,]`, `{...x,}` on the RHS) is valid.
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

async function isRejected(src: string): Promise<boolean> {
  const r = await compile(src, { fileName: "test.ts" });
  return !r.success;
}

describe("#3026 — trailing comma after rest element in destructuring pattern", () => {
  it("rejects trailing comma after array assignment rest (`[...x,] = y`)", async () => {
    expect(await isRejected("[...x,] = [1, 2];")).toBe(true);
  });

  it("rejects trailing comma after rest in a for-of head (`for ([...x,] of ...)`)", async () => {
    expect(await isRejected("for ([...x,] of [[]]) ;")).toBe(true);
  });

  it("rejects trailing comma after array binding rest (`const [...x,] = y`)", async () => {
    expect(await isRejected("const [...x,] = [1, 2];")).toBe(true);
  });

  it("rejects trailing comma after object assignment rest (`({...x,} = y)`)", async () => {
    expect(await isRejected("({...x,} = {});")).toBe(true);
  });

  it("rejects trailing comma after object binding rest (`const {...x,} = y`)", async () => {
    expect(await isRejected("const {...x,} = {};")).toBe(true);
  });

  // ── Valid controls: must NOT be rejected ──────────────────────────────────
  it("accepts a spread with trailing comma in an array literal value", async () => {
    expect(await isRejected("const x = [1]; const v = [...x,];")).toBe(false);
  });

  it("accepts a spread with trailing comma in an object literal value", async () => {
    expect(await isRejected("const x = {}; const o = {...x,};")).toBe(false);
  });

  it("accepts a rest without a trailing comma (`const [...x] = y`)", async () => {
    expect(await isRejected("const [...x] = [1, 2];")).toBe(false);
  });

  it("accepts a trailing comma after a non-rest array element (`[a,] = y`)", async () => {
    expect(await isRejected("let a; [a,] = [1];")).toBe(false);
  });

  it("accepts a trailing comma after a non-rest object element (`const {a,} = y`)", async () => {
    expect(await isRejected("const {a,} = {a: 1};")).toBe(false);
  });
});

// Slice 2 — early error: `async` is not a valid prefix of a shorthand property.
//
// PropertyDefinition : IdentifierReference (shorthand) admits no modifier;
// `async` is only valid as the prefix of an AsyncMethod (which requires a
// `(` parameter list). TypeScript's parser silently accepts `({async async})`
// and `({async x = 1})` as a ShorthandPropertyAssignment carrying an
// AsyncKeyword modifier with NO parse diagnostic (unlike `get`/`set`/`*`,
// which it already flags), so nothing detected it. Covers test262
// language/expressions/object/prop-def-invalid-async-prefix.
describe("#3026 — 'async' prefix on a shorthand property", () => {
  it("rejects `({async async})`", async () => {
    expect(await isRejected("({async async});")).toBe(true);
  });

  it("rejects `({async x = 1})` (async prefix on a cover-initialized name)", async () => {
    expect(await isRejected("({async x = 1});")).toBe(true);
  });

  // ── Valid controls: must NOT be rejected ──────────────────────────────────
  it("accepts `async` used as a plain shorthand property name", async () => {
    expect(await isRejected("const async = 1; ({async});")).toBe(false);
  });

  it("accepts `async` as a shorthand alongside other properties", async () => {
    expect(await isRejected("const async = 1, x = 2; ({async, x});")).toBe(false);
  });

  it("accepts an actual async method (`({async foo(){}})`)", async () => {
    expect(await isRejected("({async foo(){}});")).toBe(false);
  });

  it("accepts `async` as a normal property key (`({async: 1})`)", async () => {
    expect(await isRejected("({async: 1});")).toBe(false);
  });
});

// Slice 3 — early errors for two private-name (#x) grammar rules.
//
// (a) A private name referenced inside a class's ClassHeritage (the `extends`
//     clause) is NOT in that class's own private environment — §15.7.14
//     ClassDefinitionEvaluation evaluates the heritage with the OUTER
//     PrivateEnvironment. So `class C extends class { x = this.#foo } { #foo }`
//     is an early SyntaxError: `#foo` (declared in C) is out of scope in C's
//     heritage. Covers test262
//     language/{expressions,statements}/class/elements/syntax/early-errors/
//     grammar-private-environment-on-class-heritage*.
//
// (b) A PrivateIdentifier cannot be a property key in a destructuring pattern —
//     ObjectBindingPattern / ObjectAssignmentPattern property names are
//     PropertyName, which excludes PrivateIdentifier. `const { #x: v } = o` is
//     an early SyntaxError even when `#x` is declared in the enclosing class.
//     Covers grammar-private-field-on-object-destructuring.
//
// TypeScript's parser accepts both silently under skipSemanticDiagnostics (the
// test262 harness mode), so nothing detected them until this slice.
describe("#3026 — private name in class heritage / destructuring pattern", () => {
  it("rejects a private name used in the class heritage (`extends class { x = this.#foo }`)", async () => {
    expect(await isRejected("class C extends class { x = this.#foo; } {\n  #foo;\n}")).toBe(true);
  });

  it("rejects a private name used in a nested/recursive heritage", async () => {
    expect(
      await isRejected("class Base {}\nclass C extends (class extends Base { x = this.#foo; }) {\n  #foo;\n}"),
    ).toBe(true);
  });

  it("rejects a private name as an object binding-pattern key (`const { #x: v } = this`)", async () => {
    expect(await isRejected("class C {\n  #x = 1;\n  m() { const { #x: v } = this; return v; }\n}")).toBe(true);
  });

  it("rejects a private name as an object assignment-pattern key (`({ #x: v } = this)`)", async () => {
    expect(await isRejected("class C {\n  #x = 1;\n  m() { let v; ({ #x: v } = this); return v; }\n}")).toBe(true);
  });

  // ── Valid controls: must NOT be rejected ──────────────────────────────────
  it("accepts a private field read in the class body (`this.#x` in a method)", async () => {
    expect(await isRejected("class C {\n  #x = 1;\n  m() { return this.#x; }\n}")).toBe(false);
  });

  it("accepts `#x in obj` and a normal object destructuring alongside a private class", async () => {
    expect(
      await isRejected(
        "class C {\n  #x = 1;\n  has(o: any) { return #x in o; }\n  m(o: any) { const { a } = o; return a; }\n}",
      ),
    ).toBe(false);
  });

  it("accepts two sibling classes each with their own private field", async () => {
    expect(
      await isRejected(
        "class A {\n  #p = 1;\n  m() { return this.#p; }\n}\nclass B {\n  #q = 2;\n  n() { return this.#q; }\n}",
      ),
    ).toBe(false);
  });
});

// Slice 4 — "rest must be last" completion: an element following a rest is a
// SyntaxError. Slice 1 caught the trailing-comma-after-rest cases; this slice
// adds the element-after-rest cases that TS's parser drops as semantic
// diagnostics under skipSemanticDiagnostics:
//   - object binding pattern:   const {...rest, b} = y
//   - object assignment pattern: ({...rest, b} = y)
//   - rest parameter not last:   function f(a, ...b, c) {}  /  (a, ...b, c) => 0
// Covers test262 language/expressions/assignment/dstr/obj-rest-not-last-element-invalid,
// language/statements/for-of/dstr/obj-rest-not-last-element-invalid, language/rest-parameters/position-invalid.
describe("#3026 — rest element / parameter must be last (element after rest)", () => {
  it("rejects an object binding rest followed by an element (`const {...rest, b} = y`)", async () => {
    expect(await isRejected("const {...rest, b} = {};")).toBe(true);
  });

  it("rejects an object assignment rest followed by an element (`({...rest, b} = y)`)", async () => {
    expect(await isRejected("var rest, b; 0, ({...rest, b} = {});")).toBe(true);
  });

  it("rejects a rest parameter that is not last (`function f(a, ...b, c) {}`)", async () => {
    expect(await isRejected("function f(a, ...b, c) {}")).toBe(true);
  });

  it("rejects a non-last rest parameter in an arrow function (`(a, ...b, c) => a`)", async () => {
    expect(await isRejected("const g = (a: any, ...b: any[], c: any) => a;")).toBe(true);
  });

  // ── Valid controls: must NOT be rejected ──────────────────────────────────
  it("accepts an object rest as the last element (`const {a, ...rest} = o`)", async () => {
    expect(await isRejected("const {a, ...rest} = {a: 1};")).toBe(false);
  });

  it("accepts a rest parameter as the last parameter (`function f(a, ...b)`)", async () => {
    expect(await isRejected("function f(a: any, ...b: any[]) { return b; }")).toBe(false);
  });

  it("accepts an object spread in a value position (`const o = {...x, b: 1}`)", async () => {
    expect(await isRejected("const x = {}; const o = {...x, b: 1};")).toBe(false);
  });
});

// Slice 5 — early error: a parameter list with a non-simple (destructuring /
// default / rest) parameter, or any arrow/method/strict function, may not bind
// the same name twice. BoundNames of the FormalParameterList must contain no
// duplicates. The pre-existing check caught INTER-parameter duplicates
// (`(x, x) => …`) but collapsed INTRA-parameter duplicates that a single
// destructuring pattern binds twice — a plain Set deduped `([x, x])` down to one
// `x`. Now uses the duplicate-aware collector so both are caught. Covers test262
// language/expressions/arrow-function/syntax/early-errors/arrowparameters-cover-no-duplicates-*.
describe("#3026 — duplicate binding names within a destructuring parameter", () => {
  it("rejects a duplicate name in an array-pattern arrow parameter (`([x, x]) => 1`)", async () => {
    expect(await isRejected("var af = ([x, x]) => 1;")).toBe(true);
  });

  it("rejects a duplicate name in an object-pattern arrow parameter (`({y: x, x}) => 1`)", async () => {
    expect(await isRejected("var af = ({y: x, x}) => 1;")).toBe(true);
  });

  it("rejects a duplicate name in a destructuring function parameter (`function f([x, x]) {}`)", async () => {
    expect(await isRejected("function f([x, x]) { return 1; }")).toBe(true);
  });

  it("rejects a duplicate across a simple + destructuring parameter (`function f(x, [x]) {}`)", async () => {
    expect(await isRejected("function f(x, [x]) { return 1; }")).toBe(true);
  });

  // ── Valid controls: must NOT be rejected ──────────────────────────────────
  it("accepts distinct names in an array-pattern arrow parameter (`([x, y]) => x + y`)", async () => {
    expect(await isRejected("var af = ([x, y]: any[]) => x + y;")).toBe(false);
  });

  it("accepts distinct names in an object-pattern arrow parameter (`({y, x}) => x`)", async () => {
    expect(await isRejected("var af = ({y, x}: any) => x;")).toBe(false);
  });

  it("accepts the same name across two separate destructuring bindings (not params)", async () => {
    expect(await isRejected("const [a] = [1]; const {a: b} = {a: 2}; void b;")).toBe(false);
  });
});
