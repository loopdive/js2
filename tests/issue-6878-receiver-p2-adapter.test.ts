// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// Additive adapter evidence only; original P2/R/boundary fixtures stay unchanged.
import { describe, expect, it } from "vitest";
import { analyzeSource } from "../src/checker/index.js";
import { TsCheckerOracle } from "../src/checker/oracle.js";
import { makeLocalNumberReceiverDomain } from "../src/codegen/analysis/local-number-receiver-domain.js";
import { analyzeLocalNumberCarriers } from "../src/codegen/analysis/local-number-carrier-proof.js";
import { analyzeNumericPropertyNames } from "../src/codegen/numeric-property-analysis.js";
import { compile } from "../src/index.js";
import { forEachChild, ts } from "../src/ts-api.js";

type Domain = ReturnType<typeof makeLocalNumberReceiverDomain>;
type Query = Parameters<Parameters<Domain["withQuery"]>[1]>[0];
type Kind = "number" | "string";
type FunctionBody = ts.FunctionLikeDeclaration & { body: ts.ConciseBody };

function unwrap(expr: ts.Expression): ts.Expression {
  while (
    ts.isParenthesizedExpression(expr) ||
    ts.isAsExpression(expr) ||
    ts.isTypeAssertionExpression(expr) ||
    ts.isNonNullExpression(expr)
  )
    expr = expr.expression;
  return expr;
}

function keyOf(expr: ts.Expression): string | undefined {
  const value = unwrap(expr);
  if (ts.isPropertyAccessExpression(value)) return value.name.text;
  if (ts.isElementAccessExpression(value)) {
    const key = unwrap(value.argumentExpression);
    if (ts.isStringLiteral(key) || ts.isNumericLiteral(key)) return key.text;
  }
  return undefined;
}

function returnsOf(fn: FunctionBody): ts.Expression[] | undefined {
  if (!ts.isBlock(fn.body)) return [fn.body];
  const values: ts.Expression[] = [];
  let bare = false;
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionLike(node)) return;
    if (ts.isReturnStatement(node)) {
      if (node.expression) values.push(node.expression);
      else bare = true;
      return;
    }
    forEachChild(node, visit);
  };
  forEachChild(fn.body, visit);
  return !bare && values.length > 0 ? values : undefined;
}

function inspect(source: string, openWorld = false) {
  const { sourceFile, checker } = analyzeSource(source, "issue-6878-receiver-adapter.ts");
  const oracle = new TsCheckerOracle(checker);
  const nodes: ts.Node[] = [];
  const visit = (node: ts.Node): void => {
    nodes.push(node);
    forEachChild(node, visit);
  };
  visit(sourceFile);
  const expression = (text: string): ts.Expression => {
    const matches = nodes.filter((node) => node.getText(sourceFile) === text);
    expect(matches.length, `missing expression ${text}`).toBeGreaterThan(0);
    return matches[matches.length - 1] as ts.Expression;
  };
  const verdicts = analyzeNumericPropertyNames({ oracle, openWorldPropertyReads: openWorld }, [sourceFile]);
  const numeric = (name: string, occurrence = 0): boolean => {
    const declaration = nodes.filter(
      (node): node is ts.VariableDeclaration =>
        ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name,
    )[occurrence];
    expect(declaration, `missing declaration ${name}[${occurrence}]`).toBeDefined();
    return verdicts.isNumericLocal(declaration!.name, name);
  };
  const domain = makeLocalNumberReceiverDomain([sourceFile], {
    unwrap,
    assignmentPropertyName: keyOf,
    ownReturnExpressions: returnsOf,
    valueDeclarationOf: (node) => oracle.valueDeclarationOf(node),
  });
  // Independent specimen callbacks expose provisional/final R differences.
  // Their mutable evidence is deliberately NOT the production P2 predicate.
  const grounded = new Set<ts.Node>();
  const prove = (expr: ts.Expression, kind: Kind, query: Query): boolean => {
    const value = unwrap(expr);
    if (kind === "number" && ts.isNumericLiteral(value)) return grounded.has(value);
    if (kind === "string" && (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value))) return true;
    if (ts.isIdentifier(value)) return query.proveParameter(value, kind) || query.proveBinding(value, kind);
    if (ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value))
      return query.proveField(value, kind);
    if (ts.isBinaryExpression(value) && value.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      if (kind === "number") return prove(value.left, kind, query) && prove(value.right, kind, query);
      return (
        (prove(value.left, "string", query) && prove(value.right, "number", query)) ||
        (prove(value.right, "string", query) && prove(value.left, "number", query))
      );
    }
    if (ts.isCallExpression(value)) {
      if (kind === "string" && query.proveArrayJoin(value)) return true;
      const callee = unwrap(value.expression);
      if (kind === "number" && ts.isPropertyAccessExpression(callee) && callee.name.text === "charCodeAt")
        return prove(callee.expression, "string", query);
      return query.proveMethodCall(value, kind);
    }
    return false;
  };
  nodes.filter(ts.isNumericLiteral).forEach((node) => grounded.add(node));
  const proofs = {
    isNumber: (expr: ts.Expression, query: Query) => prove(expr, "number", query),
    isString: (expr: ts.Expression, query: Query) => prove(expr, "string", query),
    isStableStringMethod: () => true,
  };
  return {
    sourceFile,
    oracle,
    nodes,
    expression,
    numeric,
    verdicts,
    domain,
    proofs,
    grounded,
    raw: (text: string, kind: Kind, query: Query) => prove(expression(text), kind, query),
    completed: (text: string, kind: Kind) => domain.withQuery(proofs, (query) => prove(expression(text), kind, query)),
  };
}

const STRING = `
function Tok(input) { this.input = input; this.pos = 0; }
Tok.prototype.nextCode = function () { var c = this.input.charCodeAt(this.pos); this.pos = this.pos + 1; return c; };
function drive(s) { var t = new Tok(s); return t.nextCode(); }
export function main() { return drive("A"); }
`;
const NUMBER = `
function P(v) { this.v = v; }
P.prototype.inc = function () { this.v = this.v + 1; return this.v; };
function drive() { var p = new P(0); var result: any = p.inc(); return result; }
export function main() { return drive(); }
`;
const JOINED = STRING.replace(
  "function drive(s)",
  'const parts = ["A", "B"]; const SRC = parts.join(""); function drive(s)',
).replace('drive("A")', "drive(SRC)");

describe("#6878 adapter — actual primitive identity and both complete perimeters", () => {
  it("admits the unannotated closed String field without checker member resolution", () => {
    const fixture = inspect(STRING);
    const callee = fixture.expression("this.input.charCodeAt") as ts.PropertyAccessExpression;
    expect(fixture.oracle.valueDeclarationOf(callee.name)).toBeUndefined();
    expect(fixture.numeric("c")).toBe(true);
  });

  it.each([
    ["closed String field", STRING, "c"],
    ["joined String input", JOINED, "c"],
    ["initialized Number field", NUMBER, "result"],
    ["all preserving String assignments", STRING.replace("var t = new Tok(s);", 's = "B"; var t = new Tok(s);'), "c"],
    ["every known String input", STRING.replace('return drive("A");', 'drive("B"); return drive("A");'), "c"],
    [
      "exact Number method input",
      NUMBER.replace("function () { this.v = this.v + 1;", "function (step) { this.v = this.v + step;").replace(
        "p.inc()",
        "p.inc(1)",
      ),
      "result",
    ],
    [
      "same-named closed own method",
      STRING.replace("charCodeAt", "slice")
        .replace("this.input.slice(this.pos)", "this.slice()")
        .replace("function drive(s)", "Tok.prototype.slice = function () { return 65; }; function drive(s)"),
      "c",
    ],
  ])("accepts real adapter evidence: %s", (_label, source, name) => {
    expect(inspect(source).numeric(name)).toBe(true);
  });

  it.each([
    ["ambient runtime read", "declare var external: number; const seen = external;"],
    ["unresolved global getter", "const seen = external;"],
    ["opaque getter", "const object = { get value() { return 1; } }; const seen = object.value;"],
  ])("does not publish raw R evidence past P2's effect veto: %s", (_label, tail) => {
    const fixture = inspect(STRING + tail);
    fixture.domain.withQuery(fixture.proofs, (query) => {
      expect(fixture.raw("this.input", "string", query)).toBe(true);
      return false;
    });
    expect(fixture.numeric("c")).toBe(false);
  });

  it("keeps final R completion mandatory when legacy P2 ignores an unused private body", () => {
    const unused = "function unused() { unknown(); }";
    expect(inspect(unused + 'const peer = "A".charCodeAt(0);').numeric("peer")).toBe(true);
    const fixture = inspect(STRING + unused);
    fixture.domain.withQuery(fixture.proofs, (query) => {
      expect(fixture.raw("this.input", "string", query)).toBe(true);
      return false;
    });
    expect(fixture.completed("this.input", "string")).toBe(false);
    expect(fixture.numeric("c")).toBe(false);
  });

  it("retains optional/open-world/accessor terminal guards", () => {
    expect(inspect(STRING, true).numeric("c")).toBe(false);
    expect(inspect(STRING.replace("this.input.charCodeAt", "this.input?.charCodeAt")).numeric("c")).toBe(false);
    expect(
      inspect("const object = { get value(): any { return 1; } }; const result: any = object.value;").numeric("result"),
    ).toBe(false);
  });

  it("keeps the legacy untouched-peer proof despite an unrelated static String key write", () => {
    const fixture = inspect(
      'String.prototype.charCodeAt = function () { return 7; }; const peer = "abc".indexOf("b");',
    );
    expect(fixture.numeric("peer")).toBe(true);
  });
});

describe("#6878 adapter — complete inputs, shape closure and negative key veto", () => {
  it.each([
    ["Boolean input", "false"],
    ["object input", "{}"],
    ["BigInt input", "1n"],
    ["null input", "null"],
    ["undefined input", "undefined"],
    ["unknown input", "dynamic"],
    ["mixed input", 'flag ? "A" : false'],
    ["same-key false object", "{ charCodeAt() { return false; } }"],
  ])("declines missing primitive String identity: %s", (_label, argument) => {
    expect(inspect(STRING.replace('drive("A")', `drive(${argument})`)).numeric("c")).toBe(false);
  });

  it.each([
    [
      "second unknown constructor input",
      STRING.replace("var t = new Tok(s);", "var t = new Tok(s); var other = new Tok(dynamic);"),
    ],
    [
      "annotated String with unknown second allocation",
      STRING.replace("function Tok(input)", "function Tok(input: string)").replace(
        "var t = new Tok(s);",
        "var t = new Tok(s); var other = new Tok(dynamic);",
      ),
    ],
    ["unused unknown helper input", STRING + "function unused() { return drive(dynamic); }"],
    ["mixed helper assignment", STRING.replace("var t = new Tok(s);", "s = false; var t = new Tok(s);")],
    ["mixed field assignment", STRING.replace("return t.nextCode();", "t.input = false; return t.nextCode();")],
    ["constructor alias", STRING + "const C = Tok;"],
    ["instance alias", STRING.replace("return t.nextCode();", "var other = t; return t.nextCode();")],
    ["constructor reassignment", STRING + "Tok = function(input) {};"],
    ["exported constructor", STRING + "export { Tok };"],
    ["exported helper input", STRING.replace("function drive(s)", "export function drive(s)")],
    [
      "own method shadow",
      STRING.replace("this.pos = 0;", "this.pos = 0; this.nextCode = function () { return false; };"),
    ],
    ["duplicate install", STRING + "Tok.prototype.nextCode = function () { return false; };"],
    ["prototype replacement", STRING + "Tok.prototype = {};"],
    ["this escape", STRING.replace("this.pos = 0;", "this.pos = 0; unknown(this);")],
    ["instance escape", STRING.replace("return t.nextCode();", "unknown(t); return t.nextCode();")],
    ["inherited field setter", STRING + "Object.defineProperty(Object.prototype, 'input', { set(v) {} });"],
    ["String member override", STRING + "String.prototype.charCodeAt = function () { return false; };"],
    ["String member deletion", STRING + "delete String.prototype.charCodeAt;"],
    ["String wildcard override", STRING + "String.prototype[key] = function () { return false; };"],
    ["String prototype alias", STRING + "const prototype = String.prototype;"],
    ["String constructor alias", STRING + "const Constructor = String;"],
    ["primitive constructor handle", STRING + 'const Constructor = "".constructor;'],
    ["primitive prototype destructuring", STRING + 'const { __proto__: prototype } = "";'],
    ["legacy getter installation", STRING + "String.prototype.__defineGetter__('charCodeAt', () => () => false);"],
    ["reflective member override", STRING + "Reflect.set(String.prototype, 'charCodeAt', () => false);"],
    ["shadowed String constructor", "function String(v) { return v; }" + STRING],
    ["opaque eval effect", STRING + "eval('String.prototype.charCodeAt = () => false');"],
  ])("declines an incomplete/changed receiver domain: %s", (_label, source) => {
    expect(inspect(source).numeric("c")).toBe(false);
  });

  it.each(["false", '"s"', "null", "undefined", "1n", "dynamic", "flag ? 0 : false"])(
    "does not turn a non-Number field into an f64 local: %s",
    (argument) => {
      expect(inspect(NUMBER.replace("new P(0)", `new P(${argument})`)).numeric("result")).toBe(false);
    },
  );

  it("includes a second unknown incoming method argument even when its result is unused", () => {
    const source = NUMBER.replace(
      "function () { this.v = this.v + 1;",
      "function (step) { this.v = this.v + step;",
    ).replace("var result: any = p.inc();", "p.inc(dynamic); var result: any = p.inc(1);");
    expect(inspect(source).numeric("result")).toBe(false);
  });

  it.each([
    ["search", "this.input.search(this.pos)"],
    ["codePointAt", "this.input.codePointAt(this.pos)"],
    ["replace chain", 'this.input.replace("A", "B").charCodeAt(this.pos)'],
    ["replaceAll chain", 'this.input.replaceAll("A", "B").charCodeAt(this.pos)'],
    ["Symbol search effect", "this.input.search({ [Symbol.search]() { return 1; } })"],
    ["locale effect", "this.input.localeCompare('B')"],
  ])("does not widen protocol/range contracts: %s", (_label, call) => {
    expect(inspect(STRING.replace("this.input.charCodeAt(this.pos)", call)).numeric("c")).toBe(false);
  });

  it.each([
    ["array alias", "const copy = parts;"],
    ["array escape", "unknown(parts);"],
    ["element mutation", 'parts[0] = "C";'],
    ["own join", "parts.join = () => false;"],
    ["prototype join", "Array.prototype.join = () => false;"],
  ])("keeps joined-input stability bounded: %s", (_label, tail) => {
    expect(inspect(JOINED + tail).numeric("c")).toBe(false);
  });

  it.each([
    ["opaque element", '[{ toString() { return "A"; } }, "B"]', 'parts.join("")'],
    ["spread element", "[...unknown]", 'parts.join("")'],
    ["hole", '[, "B"]', 'parts.join("")'],
    ["opaque separator", '["A", "B"]', 'parts.join({ toString() { return ""; } })'],
  ])("does not infer join from an opaque coercion: %s", (_label, elements, call) => {
    expect(inspect(JOINED.replace('["A", "B"]', elements).replace('parts.join("")', call)).numeric("c")).toBe(false);
  });
});

describe("#6878 adapter — query lifetime, grounding and original identities", () => {
  it("expires all three original-node effect seams after normal completion", () => {
    const fixture = inspect(NUMBER);
    let retained: Query | undefined;
    const field = fixture.expression("this.v") as ts.PropertyAccessExpression;
    const call = fixture.expression("p.inc()") as ts.CallExpression;
    const assignment = fixture.nodes.find(
      (node): node is ts.BinaryExpression => ts.isBinaryExpression(node) && node.getText() === "this.v = this.v + 1",
    )!;
    expect(assignment).toBeDefined();
    expect(
      fixture.domain.withQuery(fixture.proofs, (query) => {
        retained = query;
        expect(query.permitsReceiverRead(field)).toBe(true);
        expect(query.permitsReceiverWrite(assignment.left, assignment)).toBe(true);
        expect(query.permitsReceiverCall(call)).toBe(true);
        expect(query.permitsReceiverRead(ts.factory.createPropertyAccessExpression(ts.factory.createThis(), "v"))).toBe(
          false,
        );
        return query.proveMethodCall(call, "number");
      }),
    ).toBe(true);
    expect(retained!.permitsReceiverRead(field)).toBe(false);
    expect(retained!.permitsReceiverWrite(assignment.left, assignment)).toBe(false);
    expect(retained!.permitsReceiverCall(call)).toBe(false);
    expect(retained!.proveMethodCall(call, "number")).toBe(false);
  });

  it("expires bridge and value evidence on throw and drains induction guards", () => {
    const fixture = inspect(NUMBER);
    let retained: Query | undefined;
    const call = fixture.expression("p.inc()") as ts.CallExpression;
    expect(() =>
      fixture.domain.withQuery(
        {
          ...fixture.proofs,
          isNumber: () => {
            throw new Error("interrupted strict evidence");
          },
        },
        (query) => {
          retained = query;
          return query.proveMethodCall(call, "number");
        },
      ),
    ).toThrow("interrupted strict evidence");
    expect(retained!.permitsReceiverCall(call)).toBe(false);
    expect(retained!.proveMethodCall(call, "number")).toBe(false);
    const field = fixture.expression("this.v") as ts.PropertyAccessExpression;
    const assignment = fixture.nodes.find(
      (node): node is ts.BinaryExpression => ts.isBinaryExpression(node) && node.getText() === "this.v = this.v + 1",
    )!;
    expect(retained!.permitsReceiverRead(field)).toBe(false);
    expect(retained!.permitsReceiverWrite(assignment.left, assignment)).toBe(false);
    expect(fixture.completed("p.inc()", "number")).toBe(true);
  });

  it("reads the same live grounded Set false→true→false without caching a field verdict", () => {
    const fixture = inspect(NUMBER);
    const originalSet = fixture.grounded;
    const literals = fixture.nodes.filter(ts.isNumericLiteral);
    fixture.grounded.clear();
    expect(fixture.completed("p.inc()", "number")).toBe(false);
    literals.forEach((node) => fixture.grounded.add(node));
    expect(fixture.completed("p.inc()", "number")).toBe(true);
    expect(fixture.completed("p.inc()", "number")).toBe(true);
    fixture.grounded.clear();
    expect(fixture.completed("p.inc()", "number")).toBe(false);
    expect(fixture.grounded).toBe(originalSet);
  });

  it("leaves AST parents, resolver declarations and source text unchanged", () => {
    const fixture = inspect(STRING);
    const parents = fixture.nodes.map((node) => node.parent);
    const declarations = fixture.nodes.map((node) => fixture.oracle.valueDeclarationOf(node));
    const repeated = analyzeNumericPropertyNames({ oracle: fixture.oracle }, [fixture.sourceFile]);
    expect(repeated.isNumericLocal(fixture.expression("c"), "c")).toBe(true);
    expect(fixture.completed("this.input", "string")).toBe(true);
    expect(fixture.sourceFile.getFullText()).toBe(STRING);
    fixture.nodes.forEach((node, index) => {
      expect(node.parent).toBe(parents[index]);
      expect(fixture.oracle.valueDeclarationOf(node)).toBe(declarations[index]);
    });
  });

  it("keeps the actual parent factory Set and Slot identities live across false→true→false queries", () => {
    const fixture = inspect(
      NUMBER.replace(
        "var p = new P(0); var result: any = p.inc(); return result;",
        "var seed: any; var p = new P(seed); var first: any = p.inc(); var middle: any = p.inc(); var last: any = p.inc(); return middle;",
      ),
    );
    type Slot = { isParam: boolean; defs: { expr?: ts.Expression; forcedNumeric?: boolean }[] };
    const slots = new Map<ts.Declaration, Slot>();
    for (const node of fixture.nodes) {
      if (ts.isParameter(node) || ts.isVariableDeclaration(node)) {
        slots.set(node, { isParam: ts.isParameter(node), defs: node.initializer ? [{ expr: node.initializer }] : [] });
      }
    }
    const named = (name: string) =>
      [...slots.entries()].find(
        ([node]) => ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name,
      )!;
    const seed = named("seed")[1];
    const candidates = [named("first")[1], named("middle")[1], named("last")[1]];
    const definitions = candidates.map((slot) => slot.defs);
    let originalSet: ReadonlySet<Slot> | undefined;
    const visits = new Set<ts.Expression>();
    const counts = new Map<ts.Expression, number>();
    const states: boolean[] = [];
    const scopes = {
      frameOf: (node: ts.Node) => node.getSourceFile(),
      resolve: (node: ts.Node, _name: string) => {
        const declaration = fixture.oracle.valueDeclarationOf(node);
        return declaration && slots.get(declaration);
      },
    };
    const admitted = analyzeLocalNumberCarriers(
      { oracle: fixture.oracle },
      [fixture.sourceFile],
      scopes,
      new Set(candidates),
      (grounded) => {
        expect(originalSet).toBeUndefined();
        originalSet = grounded;
        return {
          isNumeric: (expr) => {
            expect(grounded).toBe(originalSet);
            const candidate = candidates.findIndex((slot) => slot.defs[0]?.expr === expr);
            counts.set(expr, (counts.get(expr) ?? 0) + 1);
            // Test-only mutation of the same live set simulates external evidence
            // withdrawal; no production positive cache may survive these queries.
            const live = grounded as Set<Slot>;
            if (candidate === 1) live.add(seed);
            else live.delete(seed);
            if (visits.has(expr)) {
              live.delete(seed);
              return false;
            }
            visits.add(expr);
            states.push(live.has(seed));
            return true;
          },
        };
      },
      {
        unwrap,
        assignmentPropertyName: keyOf,
        ownReturnExpressions: returnsOf,
        isFunctionLikeWithBody: (node): node is FunctionBody =>
          ts.isFunctionLike(node) && "body" in node && !!node.body,
        BOOLEAN_BINARY: new Set(),
        ALWAYS_NUMERIC_BINARY: new Set(),
        ALWAYS_NUMERIC_COMPOUND: new Set(),
        NUMERIC_GLOBAL_CALLS: new Set(),
        STRING_NUMERIC_METHODS: new Set(["charCodeAt"]),
        STRING_STRING_METHODS: new Set(),
      },
    );
    expect(states).toEqual([false, true, false]);
    expect(candidates.map((slot) => counts.get(slot.defs[0]!.expr!))).toEqual([1, 2, 1]);
    expect(admitted.has(candidates[0]!)).toBe(false);
    // The independent grounding revisit also reads the live set. The mocked
    // broad gate declines repeated expressions, so no provisional local escapes.
    expect(admitted.has(candidates[1]!)).toBe(false);
    expect(admitted.has(candidates[2]!)).toBe(false);
    expect(admitted.has(seed)).toBe(false);
    candidates.forEach((slot, index) => expect(slot.defs).toBe(definitions[index]));
  });

  it.each([
    ["self local", "function drive() { var result: any = result + 1; return result; }"],
    ["mutual locals", "function drive() { var a: any = b; var b: any = a; var result: any = a; return result; }"],
    [
      "recursive call",
      "function recur(): any { return recur(); } function drive() { var result: any = recur(); return result; }",
    ],
    ["ungrounded field", NUMBER.replace("this.v = v;", "this.v = this.v + 1;")],
    ["mutual fields", NUMBER.replace("this.v = v;", "this.v = this.other; this.other = this.v;")],
  ])("declines cyclic evidence: %s", (_label, source) => {
    expect(inspect(source).numeric("result")).toBe(false);
  });

  it("declines depth exhaustion without changing an independent Number control", () => {
    const helpers = Array.from(
      { length: 55 },
      (_, index) => `function h${index}(): any { return ${index === 54 ? "37" : `h${index + 1}()`}; }`,
    ).join("\n");
    const fixture = inspect(helpers + "const result: any = h0(); const independent: any = 37;");
    expect(fixture.numeric("result")).toBe(false);
    expect(fixture.numeric("independent")).toBe(true);
  });

  it("grounds an initialized local independently and keeps Boolean arithmetic distinct from identity", () => {
    const fixture = inspect(
      "function f() { var s: any = 0; s = s + 1; const identity: any = true; const arithmetic: any = true + 1; return s; }",
    );
    expect(fixture.numeric("s")).toBe(true);
    expect(fixture.numeric("identity")).toBe(false);
    expect(fixture.numeric("arithmetic")).toBe(true);
  });
});

const TOKENIZER = STRING.replace("this.pos = 0;", "this.pos = 0; this.acc = 0;")
  .replace(
    "function drive(s)",
    "Tok.prototype.run = function () { while (this.pos < this.input.length) { this.acc = this.acc + this.nextCode(); } return this.acc; }; function drive(s)",
  )
  .replace("return t.nextCode();", "return t.run();")
  .replace('drive("A")', 'drive("hello world")');
const PER_SLOT = STRING.replace(
  "function drive(s)",
  'Tok.prototype.label = function () { var c = "tok:" + this.pos; return c; }; function drive(s)',
).replace("return t.nextCode();", "return t.nextCode() + t.label().length;");
const ACCUMULATOR = NUMBER.replace(
  "function drive() { var p = new P(0); var result: any = p.inc(); return result; }",
  "function benchMethod() { var p = new P(0); var s = 0; for (var i = 0; i < 1000; i++) { s = s + p.inc(); } return s; }",
).replace("drive()", "benchMethod()");

async function build(source: string, env: Record<string, string> = {}) {
  const saved = new Map(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  try {
    const result = await compile(source, {
      fileName: "t.mjs",
      skipSemanticDiagnostics: true,
      target: "standalone",
      emitWat: true,
    });
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    return result;
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
  }
}

function bodies(wat: string): { name: string; body: string }[] {
  const starts = [...wat.matchAll(/^\s*\(func \$(\S+)/gm)];
  return starts.map((start, index) => ({
    name: start[1]!,
    body: wat.slice(start.index!, starts[index + 1]?.index ?? wat.length),
  }));
}

function twinCarriers(wat: string, local: string) {
  const twins = bodies(wat).filter((fn) => fn.name.endsWith("__typed_this"));
  expect(twins.length).toBeGreaterThan(0);
  const carriers = twins.filter((fn) => fn.body.includes(`(local $${local} `));
  expect(carriers.length).toBeGreaterThan(0);
  return carriers;
}

/** Full emitWat text only: top-level module forms, not nested type signatures. */
function topLevelWatForms(wat: string): string[] {
  const unknown = (reason: string): never => {
    throw new Error(`UNKNOWN WAT inventory: ${reason}`);
  };
  if (!wat.trim()) return unknown("empty WAT");
  const forms: string[] = [];
  let depth = 0;
  let start = -1;
  let moduleSeen = false;
  let moduleClosed = false;
  let quoted = false;
  let escaped = false;
  let commentDepth = 0;
  for (let index = 0; index < wat.length; index++) {
    const char = wat[index]!;
    const next = wat[index + 1];
    if (commentDepth) {
      if (char === "(" && next === ";") {
        commentDepth++;
        index++;
      } else if (char === ";" && next === ")") {
        commentDepth--;
        index++;
      }
      continue;
    }
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === ";" && next === ";") {
      const end = wat.indexOf("\n", index);
      index = end < 0 ? wat.length : end;
      continue;
    }
    if (char === "(" && next === ";") {
      commentDepth = 1;
      index++;
      continue;
    }
    if (char === '"') {
      if (depth === 0) return unknown("string outside module");
      quoted = true;
    } else if (char === "(") {
      if (depth === 0) {
        if (moduleSeen || moduleClosed || !/^\(module(?=\s|\))/.test(wat.slice(index)))
          return unknown("not one complete module");
        moduleSeen = true;
      } else if (depth === 1) start = index;
      depth++;
    } else if (char === ")") {
      if (depth === 0) return unknown("unmatched closing parenthesis");
      if (depth === 2) {
        if (start < 0) return unknown("missing top-level form start");
        forms.push(wat.slice(start, index + 1));
        start = -1;
      }
      if (--depth === 0) moduleClosed = true;
    } else if (depth === 0 && !/\s/.test(char)) return unknown("text outside module");
  }
  if (!moduleSeen || !moduleClosed || depth || quoted || commentDepth || start !== -1)
    return unknown("incomplete module/string/comment");
  return forms;
}

function watFunctionInventory(wat: string) {
  const imported: string[] = [];
  const definitions: { name: string; body: string }[] = [];
  const unknown = (reason: string): never => {
    throw new Error(`UNKNOWN WAT inventory: ${reason}`);
  };
  const nameOf = (form: string): string => {
    const name = /^\(func\s+\$([^\s()]+)(?=\s|\))/.exec(form)?.[1];
    return name ?? unknown("unnamed/ambiguous function");
  };
  for (const form of topLevelWatForms(wat)) {
    const kind = /^\(\s*([^\s()]+)/.exec(form)?.[1];
    if (kind === "import") {
      if (definitions.length) return unknown("import after definitions");
      // The production emitter quotes module/name, then emits one descriptor.
      const descriptor = /^\(import\s+"(?:\\.|[^"\\])*"\s+"(?:\\.|[^"\\])*"\s+(\([\s\S]*\))\)$/.exec(form)?.[1];
      if (!descriptor) return unknown("unrecognized import descriptor");
      const importedKind = /^\(([^\s()]+)/.exec(descriptor)?.[1];
      if (importedKind === "func") imported.push(nameOf(descriptor));
      else if (!["global", "table", "memory", "tag"].includes(importedKind ?? ""))
        return unknown("unknown import kind");
    } else if (kind === "func") definitions.push({ name: nameOf(form), body: form });
  }
  if (!definitions.length) return unknown("empty defined-function/body inventory");
  const indices = new Map<string, number>();
  const register = (name: string, index: number): void => {
    if (indices.has(name) || !Number.isSafeInteger(index)) unknown(`duplicate/invalid function ${name}`);
    indices.set(name, index);
  };
  imported.forEach(register);
  const functions = definitions.map((fn, ordinal) => {
    const index = imported.length + ordinal;
    register(fn.name, index);
    return { ...fn, index };
  });
  return { indices, functions, importCount: imported.length };
}

const FORMER_NUMERIC_HELPERS = ["__box_number", "__to_primitive", "__unbox_number"];

function forbiddenNumericHelperCalls(wat: string) {
  const inventory = watFunctionInventory(wat);
  const unknown = (reason: string): never => {
    throw new Error(`UNKNOWN WAT inventory: ${reason}`);
  };
  const helpers = new Map<number, string>();
  const instructionsOf = (body: string) =>
    body
      .split("\n")
      .slice(1, -1)
      .map((line) => line.trim())
      .filter((line) => line && line !== ")" && !/^\((?:local|param|result|type)\b/.test(line));
  for (const name of FORMER_NUMERIC_HELPERS) {
    const index = inventory.indices.get(name);
    if (index === undefined) return unknown(`missing required helper ${name}`);
    const definition = inventory.functions.find((fn) => fn.index === index);
    if (definition && !instructionsOf(definition.body).length) return unknown(`empty required helper body ${name}`);
    helpers.set(index, name);
  }
  const twins = inventory.functions.filter((fn) => fn.name.endsWith("__typed_this"));
  if (!twins.length) return unknown("missing actual typed-this bodies");
  const hits: { function: string; op: string; index: number; helper: string }[] = [];
  for (const twin of twins) {
    const instructions = instructionsOf(twin.body);
    if (!instructions.length) return unknown(`empty target body ${twin.name}`);
    for (const line of instructions) {
      const call = /^(call|return_call)\b(.*)$/.exec(line);
      if (!call) {
        if (/(?:^|[\s(])(?:call|return_call)(?=\s|$)/.test(line))
          return unknown(`non-emitter direct-call format in ${twin.name}`);
        continue;
      }
      const operand = /^\s+([0-9]+)\s*$/.exec(call[2]!)?.[1];
      if (operand === undefined) return unknown(`non-numeric/ambiguous ${call[1]} in ${twin.name}`);
      const index = Number(operand);
      if (!Number.isSafeInteger(index) || index >= inventory.indices.size)
        return unknown(`unmapped call index ${operand}`);
      const helper = helpers.get(index);
      if (helper) hits.push({ function: twin.name, op: call[1]!, index, helper });
    }
  }
  return hits;
}

// Literal source-faithful emitWat formatting, not an emitter/compiler execution
// receipt. Function imports alone occupy indices; types and other imports don't.
const INDEXED_WAT_CONTROL = `(module
  (type $type0 (func))
  (rec
    (type $nested (func (param i32)))
  )
  (import "env" "one" (func $one_import (type 0)))
  (import "env" "memory" (memory 1))
  (import "env" "global" (global $global i32))
  (import "env" "two" (func $two_import (type 0)))
  (import "env" "table" (table 1  funcref))
  (import "env" "tag" (tag (type 0)))
  (func $__box_number (type 0)
    nop
  )
  (func $__to_primitive (type 0)
    nop
  )
  (func $__unbox_number (type 0)
    nop
  )
  (func $peer (type 0)
    nop
  )
  (func $nextCode__typed_this (type 0)
    (local $c f64)
    call 5
  )
  (export "next" (func 6))
  (data (i32.const 0) "(func $not_a_definition) call 4 ((")
)`;

describe("#6878 adapter — fail-closed full-WAT indexed helper instrument", () => {
  it("counts only ordered function imports and top-level defined functions", () => {
    const inventory = watFunctionInventory(INDEXED_WAT_CONTROL);
    expect(inventory.importCount).toBe(2);
    expect([...inventory.indices.entries()]).toEqual([
      ["one_import", 0],
      ["two_import", 1],
      ["__box_number", 2],
      ["__to_primitive", 3],
      ["__unbox_number", 4],
      ["peer", 5],
      ["nextCode__typed_this", 6],
    ]);
    expect(inventory.functions).toHaveLength(5);
    expect(forbiddenNumericHelperCalls(INDEXED_WAT_CONTROL)).toEqual([]);
  });
  it.each(["call", "return_call"])("detects a surviving forbidden numeric %s", (op) => {
    expect(forbiddenNumericHelperCalls(INDEXED_WAT_CONTROL.replace("call 5", `${op} 4`))).toEqual([
      { function: "nextCode__typed_this", op, index: 4, helper: "__unbox_number" },
    ]);
  });
  it("permits nonforbidden numeric call and return_call while ignoring indirect/reference opcodes", () => {
    const wat = INDEXED_WAT_CONTROL.replace(
      "call 5",
      "call 5\n    call_indirect (type 0)\n    call_ref 0\n    return_call_ref 0\n    return_call 5",
    );
    expect(forbiddenNumericHelperCalls(wat)).toEqual([]);
  });
  it.each([
    ["empty WAT", ""],
    ["blank WAT", " \n"],
    ["empty module", "(module)"],
    ["imports without definitions", '(module (import "env" "one" (func $one_import (type 0))))'],
    ["missing helper", INDEXED_WAT_CONTROL.replace("$__box_number", "$other")],
    ["duplicate helper", INDEXED_WAT_CONTROL.replace("$__to_primitive", "$__box_number")],
    ["duplicate import/definition name", INDEXED_WAT_CONTROL.replace("$one_import", "$__box_number")],
    ["duplicate import name", INDEXED_WAT_CONTROL.replace("$two_import", "$one_import")],
    ["missing actual twin", INDEXED_WAT_CONTROL.replace("$nextCode__typed_this", "$nextCode")],
    ["empty actual twin", INDEXED_WAT_CONTROL.replace("    (local $c f64)\n    call 5\n", "")],
    [
      "empty required helper body",
      INDEXED_WAT_CONTROL.replace("(func $__box_number (type 0)\n    nop\n", "(func $__box_number (type 0)\n"),
    ],
    ["unmapped call index", INDEXED_WAT_CONTROL.replace("call 5", "call 99")],
    ["named call operand", INDEXED_WAT_CONTROL.replace("call 5", "call $peer")],
    ["missing call operand", INDEXED_WAT_CONTROL.replace("call 5", "return_call")],
    ["negative call operand", INDEXED_WAT_CONTROL.replace("call 5", "call -1")],
    ["folded direct call", INDEXED_WAT_CONTROL.replace("call 5", "(call 4)")],
    ["inline direct call", INDEXED_WAT_CONTROL.replace("call 5", "nop call 4")],
    ["unnamed definition", INDEXED_WAT_CONTROL.replace("(func $peer", "(func")],
    ["unnamed function import", INDEXED_WAT_CONTROL.replace("(func $one_import", "(func")],
    ["truncated module", INDEXED_WAT_CONTROL.slice(0, -1)],
    ["multiple modules", INDEXED_WAT_CONTROL + "\n(module)"],
    [
      "late import",
      INDEXED_WAT_CONTROL.replace(
        '  (export "next"',
        '  (import "env" "late" (func $late_import (type 0)))\n  (export "next"',
      ),
    ],
  ])("reports UNKNOWN rather than absence for %s", (_label, wat) => {
    expect(() => forbiddenNumericHelperCalls(wat)).toThrow("UNKNOWN WAT inventory");
  });
});

describe("#6878 adapter — six separate restoration candidates and four R routes", () => {
  it("candidate 1: tokenizer's actual typed-this c is f64", async () => {
    expect(twinCarriers((await build(TOKENIZER)).wat!, "c").some((fn) => fn.body.includes("(local $c f64)"))).toBe(
      true,
    );
  });
  it("candidate 2: tokenizer typed-this bodies omit the former box/unbox helpers", async () => {
    const result = await build(TOKENIZER);
    const carriers = twinCarriers(result.wat!, "c");
    expect(carriers.some((fn) => fn.body.includes("(local $c f64)"))).toBe(true);
    expect(forbiddenNumericHelperCalls(result.wat!)).toEqual([]);
  });
  it("candidate 3: numeric c and same-spelled String c remain separate", async () => {
    const carriers = twinCarriers((await build(PER_SLOT)).wat!, "c");
    expect(carriers.some((fn) => fn.body.includes("(local $c f64)"))).toBe(true);
    expect(carriers.some((fn) => !fn.body.includes("(local $c f64)"))).toBe(true);
  });
  it("candidate 4: literal Array join supplies the closed tokenizer subject", async () => {
    expect(twinCarriers((await build(JOINED)).wat!, "c").some((fn) => fn.body.includes("(local $c f64)"))).toBe(true);
  });
  it("candidate 5: actual accumulator body carries f64 s", async () => {
    const body = bodies((await build(ACCUMULATOR)).wat!).find((fn) => fn.name === "benchMethod");
    expect(body).toBeDefined();
    expect(body!.body).toContain("(local $s f64)");
  });
  it("candidate 6: accumulator has independent zero grounding in the analysis", () => {
    expect(inspect(ACCUMULATOR).numeric("s")).toBe(true);
  });
  it.each([
    ["tokenizer", TOKENIZER, "c"],
    ["per-slot", PER_SLOT, "c"],
    ["joined", JOINED, "c"],
    ["accumulator", ACCUMULATOR, "s"],
  ])("retains the separate direct R route: %s", (_label, source, name) => {
    const fixture = inspect(source);
    expect(fixture.numeric(name)).toBe(true);
    if (_label === "per-slot") expect(fixture.numeric("c", 1)).toBe(false);
  });
});

describe("#6878 adapter — independent native values (not representation evidence)", () => {
  it.each([
    ["tokenizer", TOKENIZER, 1116],
    ["per-slot", PER_SLOT, 70],
    ["joined", JOINED, 65],
    ["accumulator", ACCUMULATOR, 500500],
  ])("computes the native value with all four switches: %s", async (_label, source, expected) => {
    const environments: Record<string, string>[] = [
      {},
      { JS2WASM_NUMERIC_LOCALS: "0" },
      { JS2WASM_MIXED_CARRIER_NUMERIC: "0" },
      { JS2WASM_NUMERIC_RETURNS: "0" },
      { JS2WASM_NUMERIC_ADMISSION: "0" },
    ];
    for (const env of environments) {
      const result = await build(source as string, env);
      const instance = await WebAssembly.instantiate(await WebAssembly.compile(result.binary!), {});
      expect((instance.exports.main as () => number)()).toBe(expected);
    }
  });
});
