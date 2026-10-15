// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { TsCheckerOracle } from "../src/checker/oracle.js";
import { makeLocalNumberReceiverDomain } from "../src/codegen/analysis/local-number-receiver-domain.js";
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
  const definitelyReturns = (statement: ts.Statement): boolean =>
    ts.isReturnStatement(statement) ||
    ts.isThrowStatement(statement) ||
    (ts.isBlock(statement) && statement.statements.some(definitelyReturns)) ||
    (ts.isIfStatement(statement) &&
      !!statement.elseStatement &&
      definitelyReturns(statement.thenStatement) &&
      definitelyReturns(statement.elseStatement));
  if (!fn.body.statements.some(definitelyReturns)) return undefined;
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

/** The test callbacks deliberately prove only the small specimen expressions. */
function specimen(source: string) {
  const fileName = "/issue-6878-receiver.js";
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    allowJs: true,
    checkJs: false,
    strict: false,
    types: [],
  };
  const host = ts.createCompilerHost(options);
  const readSource = host.getSourceFile.bind(host);
  host.getSourceFile = (name, version, onError, createNew) =>
    name === fileName
      ? ts.createSourceFile(fileName, source, version, true, ts.ScriptKind.JS)
      : readSource(name, version, onError, createNew);
  const program = ts.createProgram([fileName], options, host);
  const sourceFile = program.getSourceFile(fileName)!;
  const oracle = new TsCheckerOracle(program.getTypeChecker());
  const policy = {
    unwrap,
    assignmentPropertyName: keyOf,
    ownReturnExpressions: returnsOf,
    valueDeclarationOf: (node: ts.Node) => oracle.valueDeclarationOf(node),
  };
  const domain = makeLocalNumberReceiverDomain([sourceFile], policy);
  const nodes: ts.Node[] = [];
  const visit = (node: ts.Node): void => {
    nodes.push(node);
    forEachChild(node, visit);
  };
  visit(sourceFile);
  let numberEvidence = true;
  let stringStability = true;
  const stableString = (callee: ts.PropertyAccessExpression): boolean => {
    const declaration = oracle.valueDeclarationOf(callee.name);
    return (
      stringStability &&
      !!declaration &&
      declaration.getSourceFile().isDeclarationFile &&
      ts.isMethodSignature(declaration) &&
      ts.isInterfaceDeclaration(declaration.parent) &&
      declaration.parent.name.text === "String"
    );
  };
  const prove = (expr: ts.Expression, kind: Kind, query: Query): boolean => {
    const value = unwrap(expr);
    if (kind === "number" && ts.isNumericLiteral(value)) return numberEvidence;
    if (kind === "string" && (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value))) return true;
    if (ts.isIdentifier(value)) return query.proveParameter(value, kind) || query.proveBinding(value, kind);
    if (ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value))
      return query.proveField(value, kind);
    if (ts.isBinaryExpression(value) && value.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      if (kind === "number") return prove(value.left, kind, query) && prove(value.right, kind, query);
      return (
        (prove(value.left, "string", query) &&
          (prove(value.right, "number", query) || prove(value.right, "string", query))) ||
        (prove(value.right, "string", query) && prove(value.left, "number", query))
      );
    }
    if (ts.isCallExpression(value)) {
      const callee = unwrap(value.expression);
      if (kind === "string" && query.proveArrayJoin(value)) return true;
      if (
        kind === "number" &&
        ts.isPropertyAccessExpression(callee) &&
        callee.name.text === "charCodeAt" &&
        stableString(callee)
      )
        return prove(callee.expression, "string", query);
      return query.proveMethodCall(value, kind);
    }
    return false;
  };
  const proofs = {
    isNumber: (expr: ts.Expression, query: Query) => prove(expr, "number", query),
    isString: (expr: ts.Expression, query: Query) => prove(expr, "string", query),
    isStableStringMethod: stableString,
  };
  const expression = (text: string): ts.Expression => {
    const matches = nodes.filter((node) => node.getText(sourceFile) === text);
    expect(matches.length, `missing expression ${text}`).toBeGreaterThan(0);
    return matches[matches.length - 1] as ts.Expression;
  };
  return {
    domain,
    nodes,
    sourceFile,
    oracle,
    proofs,
    expression,
    prove: (text: string, kind: Kind) => domain.withQuery(proofs, (query) => prove(expression(text), kind, query)),
    numberEvidence: (allowed: boolean) => {
      numberEvidence = allowed;
    },
    stringStability: (stable: boolean) => {
      stringStability = stable;
    },
  };
}

const NUMBER_DOMAIN = `
function P(v) { this.v = v; }
P.prototype.inc = function () { this.v = this.v + 1; return this.v; };
function drive() { var p = new P(0); return p.inc(); }
export function main() { return drive(); }
`;

const STRING_DOMAIN = `
/** @param {string} input */
function Tok(input) { this.input = input; this.pos = 0; }
Tok.prototype.nextCode = function () { var c = this.input.charCodeAt(this.pos); this.pos = this.pos + 1; return c; };
/** @param {string} s */
function drive(s) { var t = new Tok(s); return t.nextCode(); }
export function main() { return drive("A"); }
`;

describe("#6878 — exact private receiver domain", () => {
  it("proves an initialized Number field and its preserving self-update", () => {
    const fixture = specimen(NUMBER_DOMAIN);
    expect(fixture.prove("p.inc()", "number")).toBe(true);
    expect(fixture.prove("this.v", "string")).toBe(false);
  });

  it("follows every exact private constructor/helper input for a String field", () => {
    const fixture = specimen(STRING_DOMAIN);
    expect(fixture.prove("this.input", "string")).toBe(true);
    expect(fixture.prove("t.nextCode()", "number")).toBe(true);
  });

  it("accepts all Number constructor allocations and an external preserving field write", () => {
    const fixture = specimen(
      NUMBER_DOMAIN.replace("return p.inc();", "var other = new P(2); p.v = 3; return p.inc();"),
    );
    expect(fixture.prove("p.inc()", "number")).toBe(true);
  });

  it("accepts an exact helper parameter only when every incoming value and assignment is String", () => {
    const fixture = specimen(STRING_DOMAIN.replace("var t = new Tok(s);", 's = "B"; var t = new Tok(s);'));
    expect(fixture.prove("t.nextCode()", "number")).toBe(true);
  });

  it("keeps a same-spelled unrelated constructor member out of the queried identity", () => {
    const fixture = specimen(
      NUMBER_DOMAIN.replace(
        "function drive()",
        `function Q(v) { this.v = v; }
      Q.prototype.inc = function () { return this.v; };
      function other() { var q = new Q("s"); return q.inc(); }
      function drive()`,
      ),
    );
    expect(fixture.prove("p.inc()", "number")).toBe(true);
    expect(fixture.prove("q.inc()", "number")).toBe(false);
    expect(fixture.prove("q.inc()", "string")).toBe(true);
  });

  it.each([
    ["second Boolean input", NUMBER_DOMAIN.replace("return p.inc();", "var other = new P(true); return p.inc();")],
    [
      "second object input",
      NUMBER_DOMAIN.replace("return p.inc();", "var other = new P({ valueOf() { return 1; } }); return p.inc();"),
    ],
    [
      "apparently unused unknown input",
      NUMBER_DOMAIN + "function unused(dynamic) { var q = new P(dynamic); return q.inc(); }",
    ],
    ["exported constructor", NUMBER_DOMAIN.replace("function P", "export function P")],
    ["named exported constructor", NUMBER_DOMAIN + "export { P };"],
    ["default exported constructor", NUMBER_DOMAIN + "export default P;"],
    ["constructor alias", NUMBER_DOMAIN + "const Alias = P;"],
    ["constructor reassignment", NUMBER_DOMAIN + "P = function(v) { this.v = false; };"],
    ["normal constructor invocation", NUMBER_DOMAIN + "function bad() { P(0); }"],
    ["constructor return", NUMBER_DOMAIN.replace("this.v = v;", "this.v = v; return {}; ")],
    ["conditional initialization", NUMBER_DOMAIN.replace("this.v = v;", "if (v) this.v = v;")],
    ["missing input", NUMBER_DOMAIN.replace("new P(0)", "new P()")],
    ["spread input", NUMBER_DOMAIN.replace("new P(0)", "new P(...[0])")],
    ["default parameter", NUMBER_DOMAIN.replace("P(v)", "P(v = 0)")],
    ["rest parameter", NUMBER_DOMAIN.replace("P(v)", "P(...v)")],
    ["destructured parameter", NUMBER_DOMAIN.replace("P(v)", "P({ v })")],
    ["duplicate parameters", NUMBER_DOMAIN.replace("P(v)", "P(v, v)").replace("new P(0)", "new P(0, false)")],
    ["this escape", NUMBER_DOMAIN.replace("this.v = v;", "this.v = v; escape(this);")],
    ["returned this", NUMBER_DOMAIN.replace("return this.v;", "return this;")],
    ["stored this", NUMBER_DOMAIN.replace("return this.v;", "saved = this; return this.v;")],
    ["returned instance", NUMBER_DOMAIN.replace("return p.inc();", "p.inc(); return p;")],
    ["passed instance", NUMBER_DOMAIN.replace("return p.inc();", "escape(p); return p.inc();")],
    ["instance alias", NUMBER_DOMAIN.replace("return p.inc();", "var alias = p; return p.inc();")],
    ["instance reassignment", NUMBER_DOMAIN.replace("return p.inc();", "p = new P(1); return p.inc();")],
    [
      "conditionally initialized instance",
      NUMBER_DOMAIN.replace("var p = new P(0);", "if (true) { var p = new P(0); }"),
    ],
    ["own method shadow", NUMBER_DOMAIN.replace("this.v = v;", "this.v = v; this.inc = function() { return true; };")],
    ["static override", NUMBER_DOMAIN + "P.prototype.inc = function() { return true; };"],
    ["unknown computed override", NUMBER_DOMAIN + "P.prototype[key] = function() { return true; };"],
    ["method delete", NUMBER_DOMAIN + "delete P.prototype.inc;"],
    ["detached method", NUMBER_DOMAIN.replace("return p.inc();", "var fn = p.inc; return p.inc();")],
    ["bound method", NUMBER_DOMAIN.replace("return p.inc();", "var fn = p.inc.bind(p); return p.inc();")],
    ["call receiver override", NUMBER_DOMAIN.replace("return p.inc();", "p.inc.call({v:false}); return p.inc();")],
    ["optional call", NUMBER_DOMAIN.replace("p.inc()", "p.inc?.()")],
    ["prototype replacement", NUMBER_DOMAIN + "P.prototype = {};"],
    ["prototype alias", NUMBER_DOMAIN + "const proto = P.prototype;"],
    ["reflective replacement", NUMBER_DOMAIN + "Reflect.set(P.prototype, 'inc', function() { return true; });"],
    ["inherited setter", NUMBER_DOMAIN + "Object.defineProperty(Object.prototype, 'v', { set(v) { saved = v; } });"],
    ["altered prototype chain", NUMBER_DOMAIN + "Object.setPrototypeOf(P.prototype, {});"],
    [
      "getter replacement",
      NUMBER_DOMAIN + "Object.defineProperty(P.prototype, 'inc', { get() { return function() { return true; }; } });",
    ],
    ["unknown call", NUMBER_DOMAIN + "unknown();"],
    ["eval", NUMBER_DOMAIN + "eval('P.prototype.inc = function() { return false; }');"],
    ["async return", NUMBER_DOMAIN.replace("= function ()", "= async function ()")],
    ["generator return", NUMBER_DOMAIN.replace("= function ()", "= function* ()")],
    ["fallthrough return", NUMBER_DOMAIN.replace("return this.v;", "if (this.v) return this.v;")],
    ["recursive return", NUMBER_DOMAIN.replace("return this.v;", "return this.inc();")],
    ["read before initialization", NUMBER_DOMAIN.replace("this.v = v;", "this.v = this.v + 1;")],
    ["ungrounded mutual fields", NUMBER_DOMAIN.replace("this.v = v;", "this.v = this.other; this.other = this.v;")],
    ["Boolean field write", NUMBER_DOMAIN.replace("this.v = this.v + 1", "this.v = true")],
    ["String field write", NUMBER_DOMAIN.replace("this.v = this.v + 1", 'this.v = "s"')],
    ["BigInt field write", NUMBER_DOMAIN.replace("this.v = this.v + 1", "this.v = 1n")],
    ["null field write", NUMBER_DOMAIN.replace("this.v = this.v + 1", "this.v = null")],
    ["undefined field write", NUMBER_DOMAIN.replace("this.v = this.v + 1", "this.v = undefined")],
    ["parameter assignment conflict", NUMBER_DOMAIN.replace("this.v = v;", "v = false; this.v = v;")],
    [
      "closed helper assignment conflict",
      NUMBER_DOMAIN.replace(
        "function drive() { var p = new P(0);",
        "function drive(v) { v = false; var p = new P(v);",
      ).replace("return drive();", "return drive(0);"),
    ],
    ["parameter var redeclaration", NUMBER_DOMAIN.replace("this.v = v;", "var v = false; this.v = v;")],
  ])("declines incomplete receiver evidence: %s", (_label, source) => {
    const fixture = specimen(source);
    const queryText = source.includes("p.inc?.()") ? "p.inc?.()" : "p.inc()";
    expect(fixture.prove(queryText, "number")).toBe(false);
  });

  it("requires P stability even for independently proven String inputs", () => {
    const fixture = specimen(STRING_DOMAIN);
    fixture.stringStability(false);
    expect(fixture.prove("t.nextCode()", "number")).toBe(false);
  });

  it.each([
    ["String prototype getter", "String.prototype.__defineGetter__('charCodeAt', () => () => false);"],
    ["primitive prototype alias", "const { __proto__: proto } = 'A'; proto.charCodeAt = () => false;"],
    ["primitive constructor alias", "const { constructor: ctor } = 'A'; ctor.prototype.charCodeAt = () => false;"],
    ["unknown primitive key", "'A'[unknown]();"],
    ["opaque eval effects", "eval(unknown);"],
  ])("withdraws the receiver domain for an unclassified intrinsic effect: %s", (_label, effect) => {
    expect(specimen(STRING_DOMAIN + effect).prove("t.nextCode()", "number")).toBe(false);
  });

  it("preserves the sealed P unresolved-member decline for checker-any fields", () => {
    const fixture = specimen(STRING_DOMAIN.replaceAll("{string}", "{any}"));
    expect(fixture.prove("t.nextCode()", "number")).toBe(false);
  });

  it("declines a repeated var whose later initializer conflicts with the String subject", () => {
    const fixture = specimen(
      STRING_DOMAIN.replace('return drive("A");', 'var subject = "A"; var subject = false; return drive(subject);'),
    );
    expect(fixture.prove("t.nextCode()", "number")).toBe(false);
  });

  it("declines a scalar subject whose initializer does not dominate its read", () => {
    const fixture = specimen(
      STRING_DOMAIN.replace('return drive("A");', 'if (false) { var subject = "A"; } return drive(subject);'),
    );
    expect(fixture.prove("t.nextCode()", "number")).toBe(false);
  });

  it("declines String calls with Symbol dispatch despite a stable member predicate", () => {
    const fixture = specimen(STRING_DOMAIN + '"A".replace("A", "B");');
    expect(fixture.prove("t.nextCode()", "number")).toBe(false);
  });

  it("observes changed live callback truth and clears all query assumptions", () => {
    const fixture = specimen(NUMBER_DOMAIN);
    expect(fixture.prove("p.inc()", "number")).toBe(true);
    fixture.numberEvidence(false);
    expect(fixture.prove("p.inc()", "number")).toBe(false);
    fixture.numberEvidence(true);
    expect(fixture.prove("p.inc()", "number")).toBe(true);
    expect(() =>
      fixture.domain.withQuery(
        {
          ...fixture.proofs,
          isNumber: () => {
            throw new Error("query interrupted");
          },
        },
        (query) => query.proveMethodCall(fixture.expression("p.inc()") as ts.CallExpression, "number"),
      ),
    ).toThrow("query interrupted");
    expect(fixture.prove("p.inc()", "number")).toBe(true);
  });

  it("keeps source text, node parents and resolver identities unchanged", () => {
    const fixture = specimen(NUMBER_DOMAIN);
    const parents = fixture.nodes.map((node) => node.parent);
    const declarations = fixture.nodes.map((node) => fixture.oracle.valueDeclarationOf(node));
    expect(fixture.prove("p.inc()", "number")).toBe(true);
    expect(fixture.sourceFile.getFullText()).toBe(NUMBER_DOMAIN);
    fixture.nodes.forEach((node, index) => {
      expect(node.parent).toBe(parents[index]);
      expect(fixture.oracle.valueDeclarationOf(node)).toBe(declarations[index]);
    });
  });
});

const JOIN_DOMAIN = 'const parts = ["A", "B"]; const subject = parts.join("");';

describe("#6878 — bounded exact Array join domain", () => {
  it("proves a standard join on an exact nonescaping literal array", () => {
    expect(specimen(JOIN_DOMAIN).prove('parts.join("")', "string")).toBe(true);
  });

  it("validates the perimeter at completion and expires retained provisional queries", () => {
    const fixture = specimen(JOIN_DOMAIN + "unknown();");
    const call = fixture.expression('parts.join("")') as ts.CallExpression;
    let retained: Query | undefined;
    const result = fixture.domain.withQuery(fixture.proofs, (query) => {
      retained = query;
      expect(query.proveArrayJoin(call)).toBe(true);
      return true;
    });
    expect(result).toBe(false);
    expect(retained!.proveArrayJoin(call)).toBe(false);
  });

  it.each([
    ["own join replacement", JOIN_DOMAIN + "parts.join = function() { return true; };"],
    ["Array prototype replacement", JOIN_DOMAIN + "Array.prototype.join = function() { return true; };"],
    ["Array prototype deletion", JOIN_DOMAIN + "delete Array.prototype.join;"],
    ["Array prototype alias", JOIN_DOMAIN + "const proto = Array.prototype;"],
    ["Array constructor alias", JOIN_DOMAIN + "const Constructor = Array;"],
    ["exported Array constructor alias", JOIN_DOMAIN + "export const Constructor = Array;"],
    ["destructured primitive prototype", JOIN_DOMAIN + "const { __proto__: proto } = 'A';"],
    ["Array prototype getter", JOIN_DOMAIN + "Array.prototype.__defineGetter__('join', () => () => false);"],
    ["wildcard mutation", JOIN_DOMAIN + "Array.prototype[key] = function() { return true; };"],
    ["reflective mutation", JOIN_DOMAIN + "Reflect.set(Array.prototype, 'join', function() { return true; });"],
    ["inherited setter", JOIN_DOMAIN + "Object.defineProperty(Object.prototype, 'join', { set(v) {} });"],
    ["changed prototype", JOIN_DOMAIN + "Object.setPrototypeOf(parts, {});"],
    ["array alias", JOIN_DOMAIN + "const copy = parts;"],
    ["array escape", JOIN_DOMAIN + "unknown(parts);"],
    ["array element mutation", JOIN_DOMAIN + 'parts[0] = "C";'],
    ["array binding mutation", JOIN_DOMAIN + 'parts = ["C"];'],
    ["unknown effect", JOIN_DOMAIN + "unknown();"],
    ["opaque element coercion", JOIN_DOMAIN.replace('["A", "B"]', '[{ toString() { return "A"; } }]')],
    ["unknown element spread", JOIN_DOMAIN.replace('["A", "B"]', "[...unknown]")],
    ["missing array element", JOIN_DOMAIN.replace('["A", "B"]', '[,"B"]')],
    ["opaque separator coercion", JOIN_DOMAIN.replace('parts.join("")', 'parts.join({ toString() { return ""; } })')],
    ["exported array", JOIN_DOMAIN + "export { parts };"],
    ["String prototype mutation", JOIN_DOMAIN + "String.prototype.charCodeAt = function() { return false; };"],
  ])("declines an unstable/opaque join: %s", (_label, source) => {
    const fixture = specimen(source);
    const text = source.includes("parts.join({") ? 'parts.join({ toString() { return ""; } })' : 'parts.join("")';
    expect(fixture.prove(text, "string")).toBe(false);
  });
});

const TOKENIZER = `
function Tok(input) { this.input = input; this.pos = 0; this.acc = 0; }
Tok.prototype.nextCode = function () { var c = this.input.charCodeAt(this.pos); this.pos = this.pos + 1; return c; };
Tok.prototype.run = function () { while (this.pos < this.input.length) { this.acc = this.acc + this.nextCode(); } return this.acc; };
function drive(s) { var t = new Tok(s); return t.run(); }
export function main() { return drive("hello world"); }
`;
const PER_SLOT = `
function Tok(input) { this.input = input; this.pos = 0; }
Tok.prototype.nextCode = function () { var c = this.input.charCodeAt(this.pos); this.pos = this.pos + 1; return c; };
Tok.prototype.label = function () { var c = "tok:" + this.pos; return c; };
function drive(s) { var t = new Tok(s); return t.nextCode() + t.label().length; }
export function main() { return drive("A"); }
`;
const JOINED = `
function Tok(input) { this.input = input; this.pos = 0; }
Tok.prototype.nextCode = function () { var c = this.input.charCodeAt(this.pos); this.pos = this.pos + 1; return c; };
const parts = ["A", "B"]; const SRC = parts.join("");
function drive(s) { var t = new Tok(s); return t.nextCode(); }
export function main() { return drive(SRC); }
`;
const ACCUMULATOR = `
function P(v) { this.v = v; }
P.prototype.inc = function () { this.v = this.v + 1; return this.v; };
function benchMethod() { var p = new P(0); var s = 0; for (var i = 0; i < 1000; i++) { s = s + p.inc(); } return s; }
export function main() { return benchMethod(); }
`;

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
  const functions: { name: string; body: string }[] = [];
  const starts = [...wat.matchAll(/^\s*\(func \$(\S+)/gm)];
  for (let index = 0; index < starts.length; index++) {
    const start = starts[index]!;
    functions.push({ name: start[1]!, body: wat.slice(start.index!, starts[index + 1]?.index ?? wat.length) });
  }
  return functions;
}

describe("#6878 — positive restoration carrier routes (requires R consumer wiring)", () => {
  it.each([
    ["tokenizer", TOKENIZER],
    ["per-slot", PER_SLOT],
    ["joined subject", JOINED],
  ])("has an actual typed-this twin with f64 c: %s", async (_label, source) => {
    const result = await build(source);
    const twins = bodies(result.wat!).filter((fn) => fn.name.endsWith("__typed_this"));
    expect(twins.length).toBeGreaterThan(0);
    const carrierBodies = twins.filter((fn) => /\(local \$c /.test(fn.body));
    expect(carrierBodies.length).toBeGreaterThan(0);
    expect(carrierBodies.some((fn) => /\(local \$c f64\)/.test(fn.body))).toBe(true);
    if (_label === "per-slot") expect(carrierBodies.some((fn) => !/\(local \$c f64\)/.test(fn.body))).toBe(true);
  });

  it("has an actual accumulator body with an f64 s", async () => {
    const result = await build(ACCUMULATOR);
    const body = bodies(result.wat!).find((fn) => fn.name === "benchMethod");
    expect(body).toBeDefined();
    expect(body!.body).toMatch(/\(local \$s f64\)/);
  });
});

describe("#6878 — independent native runtime controls", () => {
  it.each([
    ["tokenizer", TOKENIZER, 1116],
    ["per-slot", PER_SLOT, 70],
    ["joined subject", JOINED, 65],
    ["accumulator", ACCUMULATOR, 500500],
  ])("computes the exact native value independently of carrier assertions: %s", async (_label, source, expected) => {
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

  it.each([
    ["Boolean identity", "true", 'typeof value === "boolean" && value === true'],
    ["String identity", '"s"', 'typeof value === "string" && value === "s"'],
    ["null identity", "null", "value === null"],
    ["undefined identity", "undefined", 'typeof value === "undefined" && value === undefined'],
    ["signed zero", "-0", "1 / value === -Infinity"],
    ["NaN", "NaN", "value !== value"],
    ["positive infinity", "Infinity", "value === Infinity"],
    ["negative infinity", "-Infinity", "value === -Infinity"],
  ])("preserves exact JavaScript field result: %s", async (_label, value, predicate) => {
    const source = `function P(v) { this.v = v; }
      P.prototype.read = function() { return this.v; };
      function read() { var p = new P(${value}); var value = p.read(); return ${predicate} ? 1 : 0; }
      export function main() { return read(); }`;
    const environments: Record<string, string>[] = [{}, { JS2WASM_NUMERIC_LOCALS: "0" }];
    for (const env of environments) {
      const result = await build(source, env);
      const instance = await WebAssembly.instantiate(await WebAssembly.compile(result.binary!), {});
      expect((instance.exports.main as () => number)()).toBe(1);
    }
  });

  it("keeps out-of-range charCodeAt NaN and codePointAt undefined", async () => {
    const source = `function read(input) { var code = input.charCodeAt(99); var point = input.codePointAt(99); return code !== code && point === undefined ? 1 : 0; }
      export function main() { return read("A"); }`;
    const result = await build(source);
    const instance = await WebAssembly.instantiate(await WebAssembly.compile(result.binary!), {});
    expect((instance.exports.main as () => number)()).toBe(1);
  });

  it("preserves opaque value coercion count and operand evaluation order", async () => {
    const source = `
      var calls = 0; var order = 0;
      function P(v) { this.v = v; }
      P.prototype.read = function() { return this.v; };
      function rhs() { order = order * 10 + 2; return 3; }
      function read() {
        var p = new P({ valueOf: function() { calls = calls + 1; order = order * 10 + 1; return 2; } });
        var value = p.read() + rhs();
        return value === 5 && calls === 1 && order === 21 ? 1 : 0;
      }
      export function main() { return read(); }
    `;
    const environments: Record<string, string>[] = [{}, { JS2WASM_NUMERIC_LOCALS: "0" }];
    for (const env of environments) {
      const result = await build(source, env);
      const instance = await WebAssembly.instantiate(await WebAssembly.compile(result.binary!), {});
      expect((instance.exports.main as () => number)()).toBe(1);
    }
  });
});
