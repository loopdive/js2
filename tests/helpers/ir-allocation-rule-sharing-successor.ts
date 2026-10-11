// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import ts from "typescript";

export const irAllocationRuleSharingReceiptPath = "tests/helpers/ir-allocation-rule-sharing-successor.json";
export const irAllocationRuleSharingPaths = Object.freeze([
  "src/ir/analysis/ownership.ts",
  "src/ir/analysis/escape.ts",
  "src/ir/analysis/encoding.ts",
  "src/ir/analysis/allocation-evidence/effect-rules.ts",
  "src/ir/analysis/allocation-evidence/census.ts",
] as const);
export const irAllocationRuleSharingAnchorPaths = Object.freeze([
  "tests/helpers/ir-validation-analysis-relocation.json",
  "tests/helpers/ir-allocation-provenance-lookup-successor.json",
  "tests/helpers/ir-allocation-provenance-lookup-successor.ts",
  "tests/helpers/ir-validation-analysis-relocation.ts",
] as const);
// Fixed live authority is unavailable until ROOT reviews the complete new helper and receipt.
const receiptBytes = 45797;
const receiptSha256 = "7b947e08fab9d09418b3431f0f638f2f8e0278cc5af40ac1d979d7ed2064d8b2";
const predecessor = "1e388ef647c9827102b87e869f7526f8c928f11e";
const anchorSha256 = [
  "9a52664fbba6044d168f428f9398e5d2bff923cf7cac1adc6aae04827431e969",
  "4528c914b70535665feebbd0f93ed5d43ef0a5fbb9b4a752e056da84f89a2c7d",
  "7f818067a0ecb8963f582e232f1692af9d3ca9283b9596f42e9ab8846f1f6443",
];
const roles = [
  ["ownership-import", "ownership-vector-loop", "ownership-vector-close", "ownership-old-write-removal"],
  ["escape-import", "escape-vector-guard"],
  ["encoding-import", "encoding-no-write"],
  [
    "static-rule-definitions",
    "static-read-return",
    "static-write-return",
    "static-binary-guard",
    "static-default",
    "resolver-compatibility",
  ],
  ["census-import", "census-facets-loop", "census-access-counts"],
] as const;
type Reader = (path: string) => string;
interface Pin {
  readonly bytes: number;
  readonly sha256: string;
  readonly gitBlob: string;
}
interface Record extends Pin {
  readonly path: string;
}
interface Span extends Pin {
  readonly start: number;
  readonly end: number;
}
interface Payload extends Pin {
  readonly text: string;
}
interface Step {
  readonly path: string;
  readonly role: string;
  readonly span: Span;
  readonly expected: Payload;
  readonly replacement: Payload;
}
export interface IrAllocationRuleSharingSuccessorReceipt {
  readonly schema: 1;
  readonly kind: "allocation-rule-sharing-successor";
  readonly predecessor: string;
  readonly provenance: string;
  readonly before: readonly Record[];
  readonly current: readonly Record[];
  readonly anchors: readonly Record[];
  readonly inverse: readonly Step[];
  readonly forward: readonly Step[];
  readonly readerBefore: Record;
  readonly readerEdits: readonly Step[];
}
const raw: Reader = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
function fail(detail: string): never {
  throw new Error(`allocation rule sharing successor: ${detail}`);
}
function pin(value: string | Uint8Array): Pin {
  return {
    bytes: Buffer.byteLength(value),
    sha256: createHash("sha256").update(value).digest("hex"),
    gitBlob: createHash("sha1")
      .update(`blob ${Buffer.byteLength(value)}\0`)
      .update(value)
      .digest("hex"),
  };
}
function fields(value: unknown, names: readonly string[]): void {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !same(Object.keys(value).sort(), [...names].sort())
  )
    fail("closed receipt fields");
}
function checkPin(p: Pin): void {
  if (
    !Number.isSafeInteger(p.bytes) ||
    p.bytes < 0 ||
    !/^[0-9a-f]{64}$/.test(p.sha256) ||
    !/^[0-9a-f]{40}$/.test(p.gitBlob)
  )
    fail("pin shape");
}
function authenticateSource(text: string, expected: Pin, label: string): void {
  if (!same(pin(text), { bytes: expected.bytes, sha256: expected.sha256, gitBlob: expected.gitBlob }))
    fail(`complete source pin ${label}`);
}
function source(sources: ReadonlyMap<string, string>, path: string): string {
  const text = sources.get(path);
  if (text === undefined) return fail(`missing source ${path}`);
  return text;
}
function checkRecords(records: readonly Record[], paths: readonly string[]): void {
  if (
    !Array.isArray(records) ||
    !same(
      records.map((r) => r.path),
      paths,
    )
  )
    fail("fixed ordered file population");
  for (const r of records) {
    fields(r, ["path", "bytes", "sha256", "gitBlob"]);
    checkPin(r);
  }
}
function checkPayload(p: Payload): void {
  fields(p, ["text", "bytes", "sha256", "gitBlob"]);
  checkPin(p);
  if (typeof p.text !== "string") fail("payload text");
  authenticateSource(p.text, p, "payload");
}
function checkSteps(
  steps: readonly Step[],
  records: readonly Record[],
  roleGroups: readonly (readonly string[])[],
): void {
  const ordered = records.flatMap((r, i) => roleGroups[i]!.map((role) => [r.path, role]));
  if (
    !Array.isArray(steps) ||
    !same(
      steps.map((s) => [s.path, s.role]),
      ordered,
    )
  )
    fail("ordered recipe roles/population");
  let owner = "",
    end = 0;
  for (const s of steps) {
    fields(s, ["path", "role", "span", "expected", "replacement"]);
    fields(s.span, ["start", "end", "bytes", "sha256", "gitBlob"]);
    checkPin(s.span);
    checkPayload(s.expected);
    checkPayload(s.replacement);
    const r = records.find((r) => r.path === s.path)!;
    if (owner !== s.path) {
      owner = s.path;
      end = 0;
    }
    const emptyRoles = [
      "ownership-import",
      "ownership-old-write-removal",
      "escape-import",
      "escape-vector-guard",
      "encoding-import",
      "encoding-no-write",
      "reader-import",
    ];
    if (
      !Number.isSafeInteger(s.span.start) ||
      !Number.isSafeInteger(s.span.end) ||
      s.span.start < end ||
      s.span.end < s.span.start ||
      s.span.end > r.bytes ||
      s.span.end - s.span.start !== s.span.bytes ||
      (s.span.bytes === 0 && !emptyRoles.includes(s.role))
    )
      fail("recipe span bounds/order");
    if (
      s.expected.bytes !== s.span.bytes ||
      s.expected.sha256 !== s.span.sha256 ||
      s.expected.gitBlob !== s.span.gitBlob
    )
      fail("expected span identity");
    end = s.span.end;
  }
}
/** Closed transformation diagnostic. Caller records and repins are never live authority. */
export function assertIrAllocationRuleSharingReceiptStructure(r: IrAllocationRuleSharingSuccessorReceipt): void {
  fields(r, [
    "schema",
    "kind",
    "predecessor",
    "provenance",
    "before",
    "current",
    "anchors",
    "inverse",
    "forward",
    "readerBefore",
    "readerEdits",
  ]);
  if (
    r.schema !== 1 ||
    r.kind !== "allocation-rule-sharing-successor" ||
    r.predecessor !== predecessor ||
    r.provenance !== "ROOT-reviewed uncommitted AE28 V2 source; no commit or delivery asserted"
  )
    fail("receipt identity");
  checkRecords(r.before, irAllocationRuleSharingPaths);
  checkRecords(r.current, irAllocationRuleSharingPaths);
  checkRecords(r.anchors, irAllocationRuleSharingAnchorPaths);
  for (const [i, sha] of anchorSha256.entries())
    if (r.anchors[i]!.sha256 !== sha) fail("fixed historical anchor identity");
  checkSteps(r.inverse, r.current, roles);
  checkSteps(r.forward, r.before, roles);
  // Both directions are complete independent programs; do not derive either from the other or overwrite a draft's forward payload.
  for (const [i, record] of r.before.entries()) {
    const delta = r.forward
      .filter((s) => s.path === record.path)
      .reduce((n, s) => n + s.replacement.bytes - s.span.bytes, 0);
    const inverseDelta = r.inverse
      .filter((s) => s.path === record.path)
      .reduce((n, s) => n + s.replacement.bytes - s.span.bytes, 0);
    if (record.bytes + delta !== r.current[i]!.bytes || r.current[i]!.bytes + inverseDelta !== record.bytes)
      fail("complete recipe lengths");
  }
  checkRecords([r.readerBefore], [irAllocationRuleSharingAnchorPaths[3]]);
  if (
    r.readerBefore.bytes !== 18566 ||
    r.readerBefore.sha256 !== "69a9f38de63cf98321189e4e2928fa04af784244faa9732961751a66a96da0f1"
  )
    fail("reader predecessor identity");
  checkSteps(r.readerEdits, [r.anchors[3]!], [["reader-import", "reader-composition"]]);
}
function parsed(path: string, text: string): ts.SourceFile {
  const tree = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  if ((tree as ts.SourceFile & { readonly parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics.length)
    fail(`syntax ${path}`);
  return tree;
}
function nodes<T extends ts.Node>(root: ts.Node, test: (node: ts.Node) => node is T): T[] {
  const result: T[] = [];
  function visit(node: ts.Node): void {
    if (test(node)) result.push(node);
    ts.forEachChild(node, visit);
  }
  visit(root);
  return result;
}
function one<T>(values: readonly T[], label: string): T {
  if (values.length !== 1) return fail(`unique role ${label}`);
  return values[0]!;
}
function requireRole(ok: unknown, label: string): asserts ok {
  if (!ok) fail(`parsed role ${label}`);
}
function fn(tree: ts.SourceFile, name: string): ts.FunctionDeclaration & { body: ts.Block } {
  const node = one(
    tree.statements.filter((s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === name),
    name,
  );
  requireRole(node.body, `${name} body`);
  return node as ts.FunctionDeclaration & { body: ts.Block };
}
function expr(node: ts.Node | undefined, tree: ts.SourceFile, text: string, label: string): void {
  requireRole(node && node.getText(tree) === text, label);
}
function noShadow(tree: ts.Node, names: readonly string[]): void {
  for (const node of nodes(
    tree,
    (n): n is ts.NamedDeclaration =>
      ts.isVariableDeclaration(n) || ts.isParameter(n) || ts.isFunctionDeclaration(n) || ts.isBindingElement(n),
  )) {
    if (node.name && ts.isIdentifier(node.name) && names.includes(node.name.text))
      fail(`parsed role shadowed binding ${node.name.text}`);
  }
}
function importRole(tree: ts.SourceFile, module: string, names: readonly string[], watched: readonly string[]): void {
  const node = one(
    tree.statements.filter(
      (s): s is ts.ImportDeclaration =>
        ts.isImportDeclaration(s) && ts.isStringLiteral(s.moduleSpecifier) && s.moduleSpecifier.text === module,
    ),
    module,
  );
  const clause = node.importClause,
    bindings = clause?.namedBindings;
  requireRole(
    clause && !clause.isTypeOnly && !clause.name && bindings && ts.isNamedImports(bindings),
    `${module} named live import`,
  );
  const relevant = bindings.elements.filter(
    (e) => watched.includes(e.name.text) || (e.propertyName && watched.includes(e.propertyName.text)),
  );
  requireRole(
    relevant.every((e) => !e.isTypeOnly && !e.propertyName) &&
      same(
        relevant.map((e) => e.name.text),
        names,
      ),
    `${module} exact binding`,
  );
  const all = nodes(tree, ts.isImportSpecifier).filter(
    (e) => watched.includes(e.name.text) || (e.propertyName && watched.includes(e.propertyName.text)),
  );
  requireRole(all.length === relevant.length, "duplicate shared imports");
  noShadow(tree, watched);
}
function call(root: ts.Node, name: string): ts.CallExpression[] {
  return nodes(root, ts.isCallExpression).filter((n) => ts.isIdentifier(n.expression) && n.expression.text === name);
}
function variable(root: ts.Node, name: string): ts.VariableDeclaration {
  return one(
    nodes(root, ts.isVariableDeclaration).filter((n) => ts.isIdentifier(n.name) && n.name.text === name),
    name,
  );
}
function vectorBlock(tree: ts.SourceFile, root: ts.Node): ts.Block {
  const statement = one(
    nodes(root, ts.isSwitchStatement).filter((s) => s.expression.getText(tree) === "instr.kind"),
    "instruction switch",
  );
  const clauses = statement.caseBlock.clauses;
  const vector = clauses.filter(
    (c): c is ts.CaseClause =>
      ts.isCaseClause(c) && ts.isStringLiteral(c.expression) && c.expression.text.startsWith("vec."),
  );
  requireRole(
    same(
      vector.map((c) => (c.expression as ts.StringLiteral).text),
      ["vec.get", "vec.len", "vec.set"],
    ),
    "exact three vector labels",
  );
  const at = clauses.indexOf(vector[0]!);
  requireRole(
    clauses[at + 1] === vector[1] &&
      clauses[at + 2] === vector[2] &&
      !vector[0]!.statements.length &&
      !vector[1]!.statements.length &&
      vector[2]!.statements.length === 1 &&
      ts.isBlock(vector[2]!.statements[0]!),
    "vector-only grouped block",
  );
  return vector[2]!.statements[0] as ts.Block;
}
function indexedEvents(tree: ts.SourceFile, root: ts.Node): ts.ForStatement {
  const loop = one(nodes(root, ts.isForStatement), "indexed event loop");
  requireRole(
    loop.initializer &&
      ts.isVariableDeclarationList(loop.initializer) &&
      loop.initializer.declarations.length === 1 &&
      loop.initializer.flags === ts.NodeFlags.Let,
    "event loop declaration",
  );
  expr(loop.initializer, tree, "let index = 0", "event loop seed");
  expr(loop.condition, tree, "index < rule.ownership.length", "event loop condition");
  expr(loop.incrementor, tree, "index++", "event loop order");
  requireRole(ts.isBlock(loop.statement), "event loop block");
  expr(variable(loop.statement, "event").initializer, tree, "rule.ownership[index]!", "bound event lookup");
  requireRole(nodes(loop.statement, ts.isForOfStatement).length === 0, "no iterator event dispatch");
  return loop;
}
function unchangedTraversal(tree: ts.SourceFile, root: ts.Node, name: string): void {
  const statement = one(
    nodes(root, ts.isSwitchStatement).filter((n) => n.expression.getText(tree) === "instr.kind"),
    "traversal switch",
  );
  const clause = one(
    statement.caseBlock.clauses.filter(
      (n): n is ts.CaseClause => ts.isCaseClause(n) && ts.isStringLiteral(n.expression) && n.expression.text === "if",
    ),
    "if traversal",
  );
  requireRole(
    clause.statements.length === 3 &&
      ts.isForOfStatement(clause.statements[0]!) &&
      ts.isForOfStatement(clause.statements[1]!) &&
      ts.isBreakStatement(clause.statements[2]!),
    "if child traversal shape",
  );
  for (const [i, arm] of ["then", "else"].entries()) {
    const loop = clause.statements[i] as ts.ForOfStatement;
    expr(loop.expression, tree, `instr.${arm}`, "if child buffer");
    requireRole(call(loop.statement, name).length === 1, "if child recursive binding");
  }
}
function ownershipRoles(tree: ts.SourceFile): void {
  const f = fn(tree, "applyInstrEffect"),
    block = vectorBlock(tree, f);
  noShadow(f, ["touch", "markEscaped"]);
  requireRole(
    same(
      f.parameters.map((p) => p.name.getText(tree)),
      ["instr", "state", "allocOf", "aliasDerived"],
    ),
    "ownership parameter bindings",
  );
  requireRole(
    f.body.statements.length === 2 &&
      ts.isIfStatement(f.body.statements[0]!) &&
      ts.isSwitchStatement(f.body.statements[1]!),
    "ownership seeding precedes switch",
  );
  const seed = f.body.statements[0] as ts.IfStatement;
  expr(
    seed.expression,
    tree,
    "instr.result !== null && aliasDerived.has(instr.result) && !state.has(instr.result)",
    "ownership alias-derived seed",
  );
  expr(
    one(call(block, "allocationEvidenceRule"), "ownership rule call"),
    tree,
    "allocationEvidenceRule(instr)",
    "ownership current instruction",
  );
  requireRole(call(f, "allocationEvidenceRule").length === 1, "ownership vector-only route");
  requireRole(
    block.statements.length === 4 &&
      ts.isIfStatement(block.statements[1]!) &&
      ts.isBreakStatement(block.statements[3]!),
    "ownership guard before loop",
  );
  expr(
    (block.statements[1] as ts.IfStatement).expression,
    tree,
    'rule.kind !== "effects"',
    "ownership recognized guard",
  );
  requireRole(ts.isThrowStatement((block.statements[1] as ts.IfStatement).thenStatement), "ownership mismatch throws");
  const loop = indexedEvents(tree, block),
    body = loop.statement as ts.Block;
  requireRole(
    body.statements.length === 3 && ts.isIfStatement(body.statements[2]!),
    "immediate resolved event application",
  );
  expr(
    variable(body, "value").initializer,
    tree,
    "allocationEvidenceOperand(instr, event.operand)",
    "ownership resolver binding",
  );
  const dispatch = body.statements[2] as ts.IfStatement;
  expr(dispatch.expression, tree, 'event.op === "escape"', "ownership escape event");
  expr(dispatch.thenStatement, tree, "markEscaped(state, value, allocOf);", "ownership escaped application");
  expr(dispatch.elseStatement, tree, "touch(state, value, allocOf, null, event.op);", "ownership access application");
  requireRole(
    call(f, "allocationEvidenceOperand").length === 1 && !call(f, "allocationEvidenceEffect").length,
    "ownership static hot route",
  );
  unchangedTraversal(tree, f, "applyInstrEffect");
}
function escapeRoles(tree: ts.SourceFile): void {
  const f = fn(tree, "analyzeEscape"),
    visit = variable(f, "visitInstr").initializer;
  requireRole(visit && ts.isArrowFunction(visit), "local escape visitor");
  const block = vectorBlock(tree, visit);
  expr(
    one(call(visit, "allocationEvidenceRule"), "escape rule call"),
    tree,
    "allocationEvidenceRule(instr)",
    "escape current instruction",
  );
  requireRole(
    block.statements.length === 3 &&
      ts.isIfStatement(block.statements[1]!) &&
      ts.isBreakStatement(block.statements[2]!),
    "escape zero-edge block",
  );
  expr(
    (block.statements[1] as ts.IfStatement).expression,
    tree,
    'rule.kind !== "effects" || rule.directEscape.length !== 0',
    "escape zero direct edge guard",
  );
  requireRole(ts.isThrowStatement((block.statements[1] as ts.IfStatement).thenStatement), "escape mismatch throws");
  requireRole(
    !call(visit, "allocationEvidenceOperand").length && !call(visit, "allocationEvidenceEffect").length,
    "escape does not resolve ownership operands",
  );
  unchangedTraversal(tree, visit, "visitInstr");
  const backstop = one(
    nodes(f, ts.isIfStatement).filter(
      (n) => n.expression.getText(tree) === 'c === "local" && !ownership.isStackAllocatable(v)',
    ),
    "escape ownership backstop",
  );
  requireRole(backstop.pos > visit.end, "escape backstop after edge traversal");
  expr(backstop.thenStatement, tree, '{\n      cls.set(v, "opaque");\n    }', "escape opaque backstop");
}
function encodingRoles(tree: ts.SourceFile): void {
  const f = fn(tree, "classifyInstr"),
    body = f.body.statements;
  requireRole(
    body.length === 3 && ts.isIfStatement(body[1]!) && ts.isSwitchStatement(body[2]!),
    "encoding local dispatch placement",
  );
  expr(variable(body[0]!, "rule").initializer, tree, "allocationEvidenceRule(instr)", "encoding rule binding");
  const guard = body[1] as ts.IfStatement;
  expr(guard.expression, tree, 'rule.kind === "effects"', "encoding recognized route");
  requireRole(
    ts.isBlock(guard.thenStatement) &&
      guard.thenStatement.statements.length === 2 &&
      ts.isIfStatement(guard.thenStatement.statements[0]!) &&
      ts.isReturnStatement(guard.thenStatement.statements[1]!),
    "encoding no-write return",
  );
  const mismatch = guard.thenStatement.statements[0] as ts.IfStatement;
  expr(mismatch.expression, tree, 'rule.encoding !== "no-write"', "encoding facet guard");
  requireRole(ts.isThrowStatement(mismatch.thenStatement), "encoding mismatch throws");
  const outer = fn(tree, "analyzeEncoding");
  expr(
    one(call(outer, "forEachInstrDeep"), "encoding deep traversal"),
    tree,
    "forEachInstrDeep(instr, (nested) => classifyInstr(nested, enc, record))",
    "encoding every child classified",
  );
  requireRole(
    !call(tree, "allocationEvidenceOperand").length && !call(tree, "allocationEvidenceEffect").length,
    "encoding operand-free static route",
  );
}
function unwrap(node: ts.Expression): ts.Expression {
  while (ts.isAsExpression(node) || ts.isParenthesizedExpression(node)) node = node.expression;
  return node;
}
function frozen(node: ts.Expression | undefined): ts.Expression {
  requireRole(
    node && ts.isCallExpression(node) && node.expression.getText() === "Object.freeze" && node.arguments.length === 1,
    "deep frozen static value",
  );
  return unwrap(node.arguments[0]!);
}
function props(node: ts.Expression, keys: readonly string[]): Map<string, ts.Expression> {
  requireRole(ts.isObjectLiteralExpression(node), "static rule object");
  requireRole(
    node.properties.every((p) => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name)),
    "static direct properties",
  );
  const map = new Map(
    node.properties.map((p) => {
      const property = p as ts.PropertyAssignment;
      return [property.name.getText(), property.initializer];
    }),
  );
  requireRole(same([...map.keys()], keys), "closed static properties");
  return map;
}
function ruleObjects(tree: ts.SourceFile): void {
  noShadow(tree, ["Object"]);
  const names = ["UNSUPPORTED_RULE", "NO_LOCAL_EFFECT_RULE", "VECTOR_READ_RULE", "VECTOR_WRITE_RULE"];
  const variables = tree.statements.filter(ts.isVariableStatement).flatMap((s) => [...s.declarationList.declarations]);
  requireRole(
    same(
      variables.map((v) => v.name.getText(tree)),
      names,
    ),
    "exact four private static rules",
  );
  for (const [i, v] of variables.entries()) {
    requireRole(
      !(v.parent.parent as ts.VariableStatement).modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword),
      "private static rule",
    );
    const map = props(frozen(v.initializer), i === 0 ? ["kind"] : ["kind", "ownership", "directEscape", "encoding"]);
    expr(map.get("kind"), tree, i === 0 ? '"unsupported"' : '"effects"', "static rule recognition");
    if (i === 0) continue;
    const events = frozen(map.get("ownership")),
      edges = frozen(map.get("directEscape"));
    requireRole(
      ts.isArrayLiteralExpression(events) && ts.isArrayLiteralExpression(edges) && !edges.elements.length,
      "frozen ownership/direct edge arrays",
    );
    const expected =
      i === 1
        ? []
        : i === 2
          ? [["read", "vec"]]
          : [
              ["write", "vec"],
              ["escape", "newValue"],
            ];
    requireRole(events.elements.length === expected.length, "static event population");
    for (const [at, event] of events.elements.entries()) {
      const entry = props(frozen(event), ["op", "operand"]);
      expr(entry.get("op"), tree, JSON.stringify(expected[at]![0]), "static ordered event op");
      expr(entry.get("operand"), tree, JSON.stringify(expected[at]![1]), "static current operand role");
    }
    expr(map.get("encoding"), tree, '"no-write"', "static encoding facet");
  }
  for (const name of ["OwnershipRuleEvent", "AllocationEvidenceRule"]) {
    const type = one(
      tree.statements.filter((n): n is ts.TypeAliasDeclaration => ts.isTypeAliasDeclaration(n) && n.name.text === name),
      name,
    );
    requireRole(!type.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword), "private rule types");
  }
}
function descriptorRoles(tree: ts.SourceFile): void {
  ruleObjects(tree);
  const rule = fn(tree, "allocationEvidenceRule");
  requireRole(
    same(
      rule.parameters.map((p) => p.name.getText(tree)),
      ["instr"],
    ),
    "rule parameter binding",
  );
  requireRole(
    rule.body.statements.length === 2 && ts.isSwitchStatement(rule.body.statements[0]!),
    "sole recognition switch",
  );
  const s = rule.body.statements[0] as ts.SwitchStatement;
  expr(s.expression, tree, "instr.kind", "rule instruction kind");
  requireRole(
    same(
      s.caseBlock.clauses.map((c) =>
        ts.isCaseClause(c) && ts.isStringLiteral(c.expression) ? c.expression.text : "default",
      ),
      ["vec.get", "vec.len", "vec.set", "binary", "const", "vec.new_fixed", "if", "default"],
    ),
    "exact rule domain",
  );
  for (const [i, result] of [
    [1, "VECTOR_READ_RULE"],
    [2, "VECTOR_WRITE_RULE"],
    [7, "UNSUPPORTED_RULE"],
  ] as const) {
    const c = s.caseBlock.clauses[i]!;
    requireRole(c.statements.length === 1 && ts.isReturnStatement(c.statements[0]!), "static rule return");
    expr((c.statements[0] as ts.ReturnStatement).expression, tree, result, "static return identity");
  }
  const binary = s.caseBlock.clauses[3]!;
  requireRole(
    binary.statements.length === 2 &&
      ts.isIfStatement(binary.statements[0]!) &&
      ts.isBreakStatement(binary.statements[1]!),
    "binary domain guard",
  );
  expr(
    (binary.statements[0] as ts.IfStatement).expression,
    tree,
    'instr.op !== "i32.lt_u" && instr.op !== "f64.add"',
    "closed numeric opcodes",
  );
  expr(
    (binary.statements[0] as ts.IfStatement).thenStatement,
    tree,
    "return UNSUPPORTED_RULE;",
    "unsupported binary route",
  );
  expr(rule.body.statements[1], tree, "return NO_LOCAL_EFFECT_RULE;", "empty rule identity");
  requireRole(
    !nodes(rule, ts.isObjectLiteralExpression).length &&
      !nodes(rule, ts.isArrayLiteralExpression).length &&
      !nodes(rule, ts.isNewExpression).length &&
      !nodes(rule, ts.isCallExpression).length,
    "lookup has no construction/cache/calls",
  );
  const resolver = fn(tree, "allocationEvidenceOperand");
  requireRole(
    same(
      resolver.parameters.map((p) => p.name.getText(tree)),
      ["instr", "operand"],
    ),
    "resolver parameter bindings",
  );
  requireRole(
    resolver.body.statements.length === 2 &&
      ts.isSwitchStatement(resolver.body.statements[0]!) &&
      ts.isThrowStatement(resolver.body.statements[1]!),
    "closed operand resolver",
  );
  const rs = resolver.body.statements[0] as ts.SwitchStatement;
  expr(rs.expression, tree, "operand", "resolver role");
  requireRole(
    same(
      rs.caseBlock.clauses.map((c) =>
        ts.isCaseClause(c) && ts.isStringLiteral(c.expression) ? c.expression.text : "default",
      ),
      ["vec", "newValue"],
    ),
    "resolver closed roles",
  );
  for (const [i, condition, result] of [
    [0, 'instr.kind === "vec.get" || instr.kind === "vec.len" || instr.kind === "vec.set"', "instr.vec"],
    [1, 'instr.kind === "vec.set"', "instr.newValue"],
  ] as const) {
    const c = rs.caseBlock.clauses[i]!;
    requireRole(
      c.statements.length === 2 && ts.isIfStatement(c.statements[0]!) && ts.isBreakStatement(c.statements[1]!),
      "resolver kind guard",
    );
    const guard = c.statements[0] as ts.IfStatement;
    expr(guard.expression, tree, condition, "resolver legal instruction");
    expr(guard.thenStatement, tree, `return ${result};`, "current operand read");
  }
  const adapter = fn(tree, "allocationEvidenceEffect");
  requireRole(
    same(
      adapter.parameters.map((p) => p.name.getText(tree)),
      ["instr"],
    ),
    "compatibility parameter binding",
  );
  const statements = adapter.body.statements;
  requireRole(statements.length === 5, "five ordered compatibility statements");
  for (const [index, name] of [
    [0, "rule"],
    [2, "ownership"],
  ] as const) {
    const statement = statements[index]!;
    requireRole(
      ts.isVariableStatement(statement) &&
        statement.declarationList.flags === ts.NodeFlags.Const &&
        statement.declarationList.declarations.length === 1 &&
        ts.isIdentifier(statement.declarationList.declarations[0]!.name) &&
        statement.declarationList.declarations[0]!.name.getText(tree) === name,
      `compatibility const ${name} binding/order`,
    );
  }
  expr(
    variable(statements[0]!, "rule").initializer,
    tree,
    "allocationEvidenceRule(instr)",
    "compatibility true rule binding",
  );
  const unsupported = statements[1]!;
  requireRole(
    ts.isIfStatement(unsupported) &&
      !unsupported.elseStatement &&
      ts.isReturnStatement(unsupported.thenStatement) &&
      unsupported.thenStatement.expression &&
      ts.isObjectLiteralExpression(unsupported.thenStatement.expression),
    "fresh compatibility unsupported branch",
  );
  expr(unsupported.expression, tree, 'rule.kind === "unsupported"', "compatibility unsupported condition");
  const unsupportedFields = props(unsupported.thenStatement.expression, ["kind"]);
  expr(unsupportedFields.get("kind"), tree, '"unsupported"', "fresh unsupported literal result");
  expr(variable(statements[2]!, "ownership").initializer, tree, "[]", "fresh compatibility events");
  const loop = indexedEvents(tree, adapter);
  requireRole(loop === statements[3], "compatibility indexed loop order");
  const loopBody = loop.statement as ts.Block;
  requireRole(
    loopBody.statements.length === 2 &&
      ts.isVariableStatement(loopBody.statements[0]!) &&
      loopBody.statements[0]!.declarationList.flags === ts.NodeFlags.Const &&
      loopBody.statements[0]!.declarationList.declarations.length === 1 &&
      loopBody.statements[0]!.declarationList.declarations[0] === variable(loopBody, "event") &&
      ts.isExpressionStatement(loopBody.statements[1]!),
    "compatibility event then exactly one push",
  );
  const operation = loopBody.statements[1].expression;
  requireRole(
    ts.isCallExpression(operation) &&
      ts.isPropertyAccessExpression(operation.expression) &&
      operation.arguments.length === 1 &&
      ts.isObjectLiteralExpression(operation.arguments[0]!),
    "compatibility fresh pushed event object",
  );
  expr(operation.expression, tree, "ownership.push", "compatibility ordered array push binding");
  const pushed = props(operation.arguments[0]!, ["value", "op"]);
  expr(
    pushed.get("value"),
    tree,
    "allocationEvidenceOperand(instr, event.operand)",
    "compatibility current operand projection",
  );
  expr(pushed.get("op"), tree, "event.op", "compatibility event op projection");
  requireRole(call(loop, "allocationEvidenceOperand").length === 1, "compatibility sole operand resolver");
  const returned = statements[4]!;
  requireRole(
    ts.isReturnStatement(returned) && returned.expression && ts.isObjectLiteralExpression(returned.expression),
    "fresh compatibility final result",
  );
  const members = returned.expression.properties;
  requireRole(
    members.length === 4 &&
      ts.isPropertyAssignment(members[0]!) &&
      ts.isIdentifier(members[0]!.name) &&
      members[0]!.name.text === "kind" &&
      ts.isShorthandPropertyAssignment(members[1]!) &&
      members[1]!.name.text === "ownership" &&
      !members[1]!.objectAssignmentInitializer &&
      ts.isPropertyAssignment(members[2]!) &&
      ts.isIdentifier(members[2]!.name) &&
      members[2]!.name.text === "directEscape" &&
      ts.isPropertyAssignment(members[3]!) &&
      ts.isIdentifier(members[3]!.name) &&
      members[3]!.name.text === "encoding",
    "compatibility exact final fields and fresh ownership shorthand binding",
  );
  expr(members[0]!.initializer, tree, '"effects"', "compatibility effects literal");
  expr(members[2]!.initializer, tree, "[]", "fresh compatibility direct edges");
  expr(members[3]!.initializer, tree, "rule.encoding", "compatibility encoding projection");
  const carrier = fn(tree, "profileInstructionExclusion");
  requireRole(ts.isIfStatement(carrier.body.statements[0]!), "finite allocation carrier guard");
  expr(
    (carrier.body.statements[0] as ts.IfStatement).expression,
    tree,
    'instr.kind !== "vec.new_fixed" && instr.alloc !== undefined',
    "finite carrier exclusion retained",
  );
}
function censusRoles(tree: ts.SourceFile): void {
  const f = fn(tree, "applyEffects"),
    statements = f.body.statements;
  requireRole(
    statements.length === 5 &&
      ts.isIfStatement(statements[1]!) &&
      ts.isIfStatement(statements[2]!) &&
      ts.isForStatement(statements[3]!),
    "census recognized/facets before accumulation",
  );
  expr(
    variable(statements[0]!, "rule").initializer,
    tree,
    "allocationEvidenceRule(at.instr)",
    "census current instruction",
  );
  expr((statements[1] as ts.IfStatement).expression, tree, 'rule.kind === "unsupported"', "census recognized guard");
  expr(
    (statements[2] as ts.IfStatement).expression,
    tree,
    'rule.directEscape.length !== 0 || rule.encoding !== "no-write"',
    "census both facet guards",
  );
  expr(
    (statements[2] as ts.IfStatement).thenStatement,
    tree,
    'return uncovered("instruction-kind", at);',
    "census facet refusal",
  );
  const loop = indexedEvents(tree, f),
    body = loop.statement as ts.Block;
  requireRole(
    ts.isIfStatement(body.statements[1]!) &&
      ts.isContinueStatement((body.statements[1] as ts.IfStatement).thenStatement),
    "census primitive escape omission",
  );
  expr(
    (body.statements[1] as ts.IfStatement).expression,
    tree,
    'event.op === "escape"',
    "census skip before operand read",
  );
  expr(
    variable(body, "value").initializer,
    tree,
    "allocationEvidenceOperand(at.instr, event.operand)",
    "census current receiver binding",
  );
  expr(variable(body, "root").initializer, tree, "state.roots.get(value)", "census earlier root lookup");
  const visit = fn(tree, "visitInstruction");
  expr(
    variable(visit, "failure").initializer,
    tree,
    "checkOperands(state, at) ?? registerAllocation(state, at) ?? applyEffects(state, at)",
    "finite guards before shared effects",
  );
  requireRole(
    nodes(fn(tree, "registerAllocation"), ts.isIfStatement).some(
      (n) => n.expression.getText(tree) === "state.allocations.has(id)",
    ),
    "finite site reuse guard",
  );
  requireRole(!call(tree, "allocationEvidenceEffect").length, "census static hot route");
}
/** Independent syntax/binding/placement diagnostics; this function performs no whole-file hashing. */
export function assertIrAllocationRuleSharingSourceRoles(current: ReadonlyMap<string, string>): void {
  const trees = irAllocationRuleSharingPaths.map((path) => parsed(path, source(current, path)));
  const watched = ["allocationEvidenceRule", "allocationEvidenceOperand", "allocationEvidenceEffect"];
  for (const [i, names] of [
    [0, watched.slice(0, 2)],
    [1, [watched[0]!]],
    [2, [watched[0]!]],
    [4, watched.slice(0, 2)],
  ] as const)
    importRole(trees[i]!, i === 4 ? "./effect-rules.js" : "./allocation-evidence/effect-rules.js", names, watched);
  ownershipRoles(trees[0]!);
  escapeRoles(trees[1]!);
  encodingRoles(trees[2]!);
  descriptorRoles(trees[3]!);
  censusRoles(trees[4]!);
}
function edit(text: string, steps: readonly Step[]): string {
  const bytes = Buffer.from(text),
    parts: Buffer[] = [];
  let at = 0;
  for (const step of steps) {
    const piece = bytes.subarray(step.span.start, step.span.end),
      expected = piece.toString("utf8");
    if (!Buffer.from(expected).equals(piece)) fail("split UTF-8 span");
    authenticateSource(expected, step.span, `edited ${step.role}`);
    if (expected !== step.expected.text) fail(`expected edit text ${step.role}`);
    parts.push(bytes.subarray(at, step.span.start), Buffer.from(step.replacement.text));
    at = step.span.end;
  }
  return Buffer.concat([...parts, bytes.subarray(at)]).toString("utf8");
}
function checkSources(records: readonly Record[], sources: ReadonlyMap<string, string>, label: string): void {
  requireRole(
    same(
      [...sources.keys()],
      records.map((r) => r.path),
    ),
    `${label} exact map population`,
  );
  for (const record of records) authenticateSource(source(sources, record.path), record, `${label} ${record.path}`);
}
/** Independent forward program diagnostic; never use this with caller repins as live authority. */
export function replayIrAllocationRuleSharingDraft(
  r: IrAllocationRuleSharingSuccessorReceipt,
  before: ReadonlyMap<string, string>,
): ReadonlyMap<string, string> {
  assertIrAllocationRuleSharingReceiptStructure(r);
  checkSources(r.before, before, "before");
  const replayed = new Map(
    r.current.map((record) => [
      record.path,
      edit(
        source(before, record.path),
        r.forward.filter((s) => s.path === record.path),
      ),
    ]),
  );
  checkSources(r.current, replayed, "replayed");
  assertIrAllocationRuleSharingSourceRoles(replayed);
  return replayed;
}
/** Exact inverse diagnostic is exposed separately so wrong-forward controls can establish which stage failed. */
export function inverseIrAllocationRuleSharingDraft(
  r: IrAllocationRuleSharingSuccessorReceipt,
  current: ReadonlyMap<string, string>,
): ReadonlyMap<string, string> {
  assertIrAllocationRuleSharingReceiptStructure(r);
  checkSources(r.current, current, "current");
  assertIrAllocationRuleSharingSourceRoles(current);
  const before = new Map(
    r.before.map((record) => [
      record.path,
      edit(
        source(current, record.path),
        r.inverse.filter((s) => s.path === record.path),
      ),
    ]),
  );
  checkSources(r.before, before, "predecessor");
  return before;
}
export function reconstructIrAllocationRuleSharingDraft(
  r: IrAllocationRuleSharingSuccessorReceipt,
  current: ReadonlyMap<string, string>,
): { readonly before: ReadonlyMap<string, string>; readonly current: ReadonlyMap<string, string> } {
  const before = inverseIrAllocationRuleSharingDraft(r, current),
    replayed = replayIrAllocationRuleSharingDraft(r, before);
  for (const path of irAllocationRuleSharingPaths)
    if (source(replayed, path) !== source(current, path)) fail(`reciprocal bytes ${path}`);
  return { before, current: replayed };
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
/** Only exact ROOT-approved fixed bytes are authority, independent of caller-provided source/receipt pins. */
export function authenticateIrAllocationRuleSharingReceipt(text: string): IrAllocationRuleSharingSuccessorReceipt {
  if (Buffer.byteLength(text) !== receiptBytes || pin(text).sha256 !== receiptSha256)
    fail("fixed receipt digest mismatch (unreviewed drafts are not authority)");
  const r = JSON.parse(text) as IrAllocationRuleSharingSuccessorReceipt;
  assertIrAllocationRuleSharingReceiptStructure(r);
  return freeze(r);
}
function chain(r: IrAllocationRuleSharingSuccessorReceipt, anchors: ReadonlyMap<string, string>): void {
  checkSources(r.anchors, anchors, "anchor");
  const old = JSON.parse(source(anchors, irAllocationRuleSharingAnchorPaths[0])) as { current: readonly Record[] };
  for (const path of irAllocationRuleSharingPaths.slice(0, 3)) {
    const a = one(
        old.current.filter((x) => x.path === path),
        "Phase B donor",
      ),
      b = one(
        r.before.filter((x) => x.path === path),
        "AE28 predecessor",
      );
    if (
      !same(
        { bytes: a.bytes, sha256: a.sha256, gitBlob: a.gitBlob },
        { bytes: b.bytes, sha256: b.sha256, gitBlob: b.gitBlob },
      )
    )
      fail("exact Phase B predecessor join");
  }
  const reader = source(anchors, irAllocationRuleSharingAnchorPaths[3]);
  authenticateSource(edit(reader, r.readerEdits), r.readerBefore, "original reader contract");
}
/** Ten fresh supplied-reader reads per invocation; no success cache or historical executable fallback. */
export function reconstructBeforeIrAllocationRuleSharing(rawReader: Reader = raw): ReadonlyMap<string, string> {
  const receipt = authenticateIrAllocationRuleSharingReceipt(rawReader(irAllocationRuleSharingReceiptPath));
  const current = new Map(irAllocationRuleSharingPaths.map((path) => [path, rawReader(path)]));
  const anchors = new Map(irAllocationRuleSharingAnchorPaths.map((path) => [path, rawReader(path)]));
  chain(receipt, anchors);
  return reconstructIrAllocationRuleSharingDraft(receipt, current).before;
}
export function readBeforeIrAllocationRuleSharing(path: string, rawReader: Reader = raw): string {
  if (!irAllocationRuleSharingPaths.some((p) => p === path)) return rawReader(path);
  return source(reconstructBeforeIrAllocationRuleSharing(rawReader), path);
}
