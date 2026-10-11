// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import ts from "typescript";

export const irAllocationProvenanceLookupReceiptPath = "tests/helpers/ir-allocation-provenance-lookup-successor.json";
export const irAllocationProvenanceLookupBeforePaths = Object.freeze([
  "src/ir/analysis/contracts/allocations.ts",
  "src/ir/analysis/alloc-verification.ts",
  "src/ir/program/allocations.ts",
] as const);
export const irAllocationProvenanceLookupCurrentPaths = Object.freeze([
  ...irAllocationProvenanceLookupBeforePaths,
  "src/ir/program/allocation-body-validation.ts",
] as const);
// ROOT must review the complete helper and receipt before these trust pins are finalized.
const receiptBytes = 11637;
const receiptSha256 = "4528c914b70535665feebbd0f93ed5d43ef0a5fbb9b4a752e056da84f89a2c7d";
const oldReceiptPath = "tests/helpers/ir-validation-analysis-relocation.json";
const oldReceiptSha256 = "9a52664fbba6044d168f428f9398e5d2bff923cf7cac1adc6aae04827431e969";
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
interface Edit {
  readonly role: string;
  readonly before: Span;
  readonly current: Span;
  readonly beforeText: string;
  readonly currentText: string;
}
export interface IrAllocationProvenanceLookupSuccessorReceipt {
  readonly schema: 1;
  readonly kind: "allocation-provenance-lookup-successor";
  readonly predecessor: string;
  readonly provenance: string;
  readonly oldReceipt: Record;
  readonly before: readonly Record[];
  readonly current: readonly Record[];
  readonly verifier: readonly Edit[];
  readonly contract: { readonly beforeOffset: number; readonly current: Span; readonly text: string };
  readonly programImports: readonly Edit[];
  readonly call: { readonly current: Span; readonly text: string };
  readonly transfer: {
    readonly before: Span;
    readonly current: Span;
    readonly renames: readonly { readonly role: string; readonly before: Span; readonly current: Span }[];
  };
  readonly helper: {
    readonly prefix: string;
    readonly invalid: Span;
    readonly programInvalid: Span;
    readonly beforeInvalid: Span;
    readonly suffix: string;
    readonly absentBefore: true;
  };
  readonly inverse: readonly string[];
  readonly forward: readonly string[];
}
const [contractPath, verifierPath, programPath, helperPath] = irAllocationProvenanceLookupCurrentPaths;
const verifierNames = [
  "verifyAllocProvenance",
  "checkId",
  "assertFinalAllocProvenance",
  "assertVerifiedAllocProvenance",
];
const inverse = ["verifier-types", "remove-interface", "program-imports", "restore-moved-body"];
const forward = ["verifier-types", "insert-interface", "program-imports", "replace-moved-body", "build-helper"];
const helperName = "assertPreparedIrFunctionAllocationTypesAndStates";
function fail(detail: string): never {
  throw new Error(`allocation provenance successor: ${detail}`);
}
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const raw: Reader = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
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
function fields(value: unknown, keys: readonly string[]): void {
  if (!value || typeof value !== "object" || !same(Object.keys(value).sort(), [...keys].sort()))
    fail("closed receipt fields");
}
function checkPin(value: unknown): void {
  const p = value as Pin;
  if (
    !Number.isSafeInteger(p.bytes) ||
    p.bytes < 0 ||
    !/^[0-9a-f]{64}$/.test(p.sha256) ||
    !/^[0-9a-f]{40}$/.test(p.gitBlob)
  )
    fail("pin shape");
}
function checkSpan(value: unknown, length: number, insertion = false): void {
  fields(value, ["start", "end", "bytes", "sha256", "gitBlob"]);
  checkPin(value);
  const s = value as Span;
  if (
    !Number.isSafeInteger(s.start) ||
    !Number.isSafeInteger(s.end) ||
    s.start < 0 ||
    s.end < s.start ||
    (!insertion && s.end === s.start) ||
    s.end > length ||
    s.end - s.start !== s.bytes
  )
    fail("span bounds");
}
function source(sources: ReadonlyMap<string, string>, path: string): string {
  const text = sources.get(path);
  if (text === undefined) fail(`missing source ${path}`);
  return text;
}
function authenticateSource(text: string, expected: Pin, label: string): void {
  if (!same(pin(text), { bytes: expected.bytes, sha256: expected.sha256, gitBlob: expected.gitBlob }))
    fail(`source pin ${label}`);
}
function slice(text: string, span: Span, label: string): string {
  checkSpan(span, Buffer.byteLength(text));
  const bytes = Buffer.from(text).subarray(span.start, span.end),
    result = bytes.toString("utf8");
  if (!Buffer.from(result).equals(bytes)) fail(`UTF-8 span ${label}`);
  authenticateSource(result, span, label);
  return result;
}
function parsed(path: string, text: string): ts.SourceFile {
  const tree = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  if ((tree as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics.length)
    fail(`syntax ${path}`);
  return tree;
}
function one<T>(values: readonly T[], label: string): T {
  if (values.length !== 1) fail(`unique role ${label}`);
  return values[0]!;
}
function fn(tree: ts.SourceFile, name: string): ts.FunctionDeclaration & { body: ts.Block } {
  const node = one(
    tree.statements.filter((s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === name),
    name,
  );
  if (!node.body) fail(`function body ${name}`);
  return node as ts.FunctionDeclaration & { body: ts.Block };
}
function importRole(
  tree: ts.SourceFile,
  module: string,
  names: readonly string[],
  typeOnly = false,
): ts.ImportDeclaration {
  const node = one(
    tree.statements.filter(
      (s): s is ts.ImportDeclaration =>
        ts.isImportDeclaration(s) && ts.isStringLiteral(s.moduleSpecifier) && s.moduleSpecifier.text === module,
    ),
    module,
  );
  const clause = node.importClause,
    bindings = clause?.namedBindings;
  if (
    !clause ||
    clause.name ||
    !!clause.isTypeOnly !== typeOnly ||
    !bindings ||
    !ts.isNamedImports(bindings) ||
    bindings.elements.some((e) => e.propertyName) ||
    !same(
      bindings.elements.map((e) => `${e.isTypeOnly ? "type " : ""}${e.name.text}`),
      names,
    )
  )
    fail(`import role ${module}`);
  return node;
}
function parameter(node: ts.FunctionDeclaration, index: number, name: string, type: string): ts.ParameterDeclaration {
  const p = node.parameters[index];
  if (
    !p ||
    p.name.getText() !== name ||
    p.questionToken ||
    p.dotDotDotToken ||
    p.initializer ||
    !p.type ||
    !ts.isTypeReferenceNode(p.type) ||
    !ts.isIdentifier(p.type.typeName) ||
    p.type.typeName.text !== type ||
    p.type.typeArguments
  )
    fail(`parameter role ${node.name?.text}/${name}`);
  return p;
}
function identifiers(tree: ts.Node, name: string): ts.Identifier[] {
  const values: ts.Identifier[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === name) values.push(node);
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return values;
}
function invalid(tree: ts.SourceFile, owner: ts.FunctionDeclaration & { body: ts.Block }): ts.VariableStatement {
  return one(
    owner.body.statements.filter(
      (s): s is ts.VariableStatement =>
        ts.isVariableStatement(s) && s.declarationList.declarations.some((d) => d.name.getText(tree) === "invalid"),
    ),
    "invalid declaration",
  );
}
function programLoop(owner: ts.FunctionDeclaration & { body: ts.Block }): ts.ForOfStatement & { statement: ts.Block } {
  const node = one(
    owner.body.statements.filter(
      (s): s is ts.ForOfStatement =>
        ts.isForOfStatement(s) &&
        s.expression.getText() === "[...program.ir.functions, ...irRuntimeSupportFunctions(program.runtimeSupport)]",
    ),
    "program population loop",
  );
  if (
    !ts.isBlock(node.statement) ||
    node.initializer.getText() !== "const fn" ||
    node.statement.statements.length !== 2 ||
    node.statement.statements[0]?.getText() !== "analyze(fn);" ||
    node.statement.statements[1]?.getText() !== `${helperName}(fn, registry);`
  )
    fail("post-analysis helper role");
  return node as ts.ForOfStatement & { statement: ts.Block };
}
function helperHeader(tree: ts.SourceFile) {
  if (tree.statements.length !== 6 || tree.statements.filter(ts.isImportDeclaration).length !== 5)
    fail("helper declaration population");
  importRole(tree, "../analysis/alloc-verification.js", ["assertFinalAllocProvenance"]);
  importRole(tree, "../analysis/contracts/allocations.js", ["AllocProvenanceLookup"], true);
  importRole(tree, "../core/nodes.js", ["forEachInstrDeep", "type IrFunction"]);
  importRole(tree, "./abi-signatures.js", ["preparedIrTypeKey"]);
  importRole(tree, "./errors.js", ["PreparedIrProgramInvariantError"]);
  const owner = fn(tree, helperName);
  if (
    !owner.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ||
    owner.parameters.length !== 2 ||
    owner.type?.kind !== ts.SyntaxKind.VoidKeyword ||
    owner.typeParameters
  )
    fail("helper signature population");
  parameter(owner, 0, "fn", "IrFunction");
  parameter(owner, 1, "lookup", "AllocProvenanceLookup");
  return owner;
}
function helperRoles(tree: ts.SourceFile) {
  const owner = helperHeader(tree);
  if (owner.body.statements.length !== 3) fail("helper body population");
  const local = invalid(tree, owner),
    loops = owner.body.statements.slice(1);
  if (owner.body.statements[0] !== local || loops.some((n) => !ts.isForOfStatement(n))) fail("helper moved loops");
  const uses = identifiers(owner.body, "lookup");
  if (uses.length !== 2) fail("bound lookup uses");
  const stateUse = uses[0]!,
    receiverUse = uses[1]!;
  if (
    !ts.isCallExpression(stateUse.parent) ||
    stateUse.parent.expression.getText() !== "assertFinalAllocProvenance" ||
    stateUse.parent.arguments.length !== 2 ||
    stateUse.parent.arguments[1] !== stateUse ||
    !ts.isPropertyAccessExpression(receiverUse.parent) ||
    receiverUse.parent.expression !== receiverUse ||
    receiverUse.parent.name.text !== "resolve" ||
    !ts.isCallExpression(receiverUse.parent.parent) ||
    receiverUse.parent.parent.arguments.length !== 1 ||
    receiverUse.parent.parent.arguments[0]?.getText() !== "instruction.alloc"
  )
    fail("lookup lexical role");
  return { owner, local, loops, uses };
}
/** Parsed-role diagnostics only; this function authenticates no receipt or capability. */
export function assertIrAllocationProvenanceLookupSourceRoles(current: ReadonlyMap<string, string>): void {
  const contract = parsed(contractPath, source(current, contractPath));
  importRole(contract, "../../core/nodes.js", ["AllocKind", "AllocSiteId", "IrSiteId"], true);
  importRole(contract, "../../core/types.js", ["IrType"], true);
  const declarations = contract.statements.filter((s) => !ts.isImportDeclaration(s));
  if (
    contract.statements.length !== 7 ||
    !same(
      declarations.map((s) => (ts.isInterfaceDeclaration(s) || ts.isTypeAliasDeclaration(s) ? s.name.text : undefined)),
      [
        "AllocSite",
        "AllocProvenanceLookup",
        "AllocRegistryProvenanceSnapshot",
        "AllocRegistryMetadataSnapshot",
        "AllocRegistrySnapshot",
      ],
    )
  )
    fail("contract complete declaration population");
  const lookup = one(
    declarations.filter(
      (s): s is ts.InterfaceDeclaration => ts.isInterfaceDeclaration(s) && s.name.text === "AllocProvenanceLookup",
    ),
    "lookup interface",
  );
  const index = declarations.indexOf(lookup);
  if (
    (declarations[index - 1] as ts.InterfaceDeclaration)?.name?.text !== "AllocSite" ||
    (declarations[index + 1] as ts.TypeAliasDeclaration)?.name?.text !== "AllocRegistryProvenanceSnapshot" ||
    !lookup.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ||
    lookup.heritageClauses ||
    lookup.typeParameters ||
    lookup.members.length !== 2 ||
    !same(
      lookup.members.map((m) => m.getText()),
      ["isKnown(id: AllocSiteId): boolean;", "resolve(id: AllocSiteId): AllocSite | null;"],
    )
  )
    fail("interface member/position role");
  const verifier = parsed(verifierPath, source(current, verifierPath));
  importRole(verifier, "./contracts/allocations.js", ["AllocProvenanceLookup"], true);
  for (const name of verifierNames) parameter(fn(verifier, name), 1, "registry", "AllocProvenanceLookup");
  if (identifiers(verifier, "AllocProvenanceLookup").length !== 5) fail("exact four verifier type roles");
  const program = parsed(programPath, source(current, programPath)),
    owner = fn(program, "assertPreparedIrProgramAllocations");
  importRole(program, "./allocation-body-validation.js", [helperName]);
  importRole(program, "../core/nodes.js", ["asAllocSiteId", "type IrFunction"]);
  importRole(program, "./abi-signatures.js", ["preparedIrDataKey"]);
  programLoop(owner);
  if (identifiers(program, helperName).length !== 2) fail("unique helper import/call");
  const helper = parsed(helperPath, source(current, helperPath)),
    roles = helperRoles(helper);
  if (invalid(program, owner).getText(program) !== roles.local.getText(helper))
    fail("live local invalid closure equality");
}
function checkRecords(records: readonly Record[], paths: readonly string[]): void {
  if (
    !Array.isArray(records) ||
    !same(
      records.map((r) => r.path),
      paths,
    )
  )
    fail("ordered source population");
  for (const record of records) {
    fields(record, ["path", "bytes", "sha256", "gitBlob"]);
    checkPin(record);
    if (record.bytes === 0) fail("empty complete source record");
  }
}
function editRole(edit: Edit): void {
  if (edit.role.startsWith("registry-type:")) {
    if (edit.beforeText !== "AllocSiteRegistry" || edit.currentText !== "AllocProvenanceLookup")
      fail("fixed parameter type edits");
    return;
  }
  const check = (text: string, module: string, names: readonly string[], typeOnly = false): void => {
    const tree = parsed("import-edit.ts", text);
    if (tree.statements.length !== 1) fail("import-only edit scaffold");
    importRole(tree, module, names, typeOnly);
  };
  if (edit.role === "lookup-import") {
    check(edit.beforeText, "./alloc-registry.js", ["AllocSiteRegistry"], true);
    check(edit.currentText, "./contracts/allocations.js", ["AllocProvenanceLookup"], true);
  } else if (edit.role === "core-import") {
    check(edit.beforeText, "../core/nodes.js", ["asAllocSiteId", "forEachInstrDeep", "type IrFunction"]);
    check(edit.currentText, "../core/nodes.js", ["asAllocSiteId", "type IrFunction"]);
  } else if (edit.role === "type-key-import") {
    check(edit.beforeText, "./abi-signatures.js", ["preparedIrDataKey", "preparedIrTypeKey"]);
    check(edit.currentText, "./abi-signatures.js", ["preparedIrDataKey"]);
  } else if (edit.role === "helper-import") {
    if (edit.beforeText !== "") fail("helper absent import scaffold");
    check(edit.currentText, "./allocation-body-validation.js", [helperName]);
  } else fail("unapproved edit role");
}
function checkEdits(
  edits: readonly Edit[],
  roles: readonly string[],
  beforeLength: number,
  currentLength: number,
): void {
  if (
    !Array.isArray(edits) ||
    !same(
      edits.map((e) => e.role),
      roles,
    )
  )
    fail("ordered edit roles");
  let a = 0,
    b = 0;
  for (const edit of edits) {
    fields(edit, ["role", "before", "current", "beforeText", "currentText"]);
    checkSpan(edit.before, beforeLength, edit.role === "helper-import");
    checkSpan(edit.current, currentLength);
    if (edit.role === "helper-import" && (edit.before.bytes !== 0 || edit.beforeText !== ""))
      fail("exact import insertion role");
    if (edit.before.start < a || edit.current.start < b) fail("edit overlap/order");
    authenticateSource(edit.beforeText, edit.before, edit.role);
    authenticateSource(edit.currentText, edit.current, edit.role);
    editRole(edit);
    a = edit.before.end;
    b = edit.current.end;
  }
}
/** Closed draft structure is a diagnostic, never a substitute for the fixed trust digest. */
export function assertIrAllocationProvenanceLookupReceiptStructure(
  r: IrAllocationProvenanceLookupSuccessorReceipt,
): void {
  fields(r, [
    "schema",
    "kind",
    "predecessor",
    "provenance",
    "oldReceipt",
    "before",
    "current",
    "verifier",
    "contract",
    "programImports",
    "call",
    "transfer",
    "helper",
    "inverse",
    "forward",
  ]);
  if (
    r.schema !== 1 ||
    r.kind !== "allocation-provenance-lookup-successor" ||
    r.predecessor !== "8452732f0b88c14c5c7634ece58f83240970ea4c" ||
    r.provenance !== "uncommitted reviewed J1 source; no commit or delivery asserted" ||
    !same(r.inverse, inverse) ||
    !same(r.forward, forward)
  )
    fail("receipt identity/recipes");
  checkRecords(r.before, irAllocationProvenanceLookupBeforePaths);
  checkRecords(r.current, irAllocationProvenanceLookupCurrentPaths);
  fields(r.oldReceipt, ["path", "bytes", "sha256", "gitBlob"]);
  checkPin(r.oldReceipt);
  if (r.oldReceipt.path !== oldReceiptPath || r.oldReceipt.bytes !== 327660 || r.oldReceipt.sha256 !== oldReceiptSha256)
    fail("old receipt chain identity");
  checkEdits(
    r.verifier,
    ["lookup-import", ...verifierNames.map((n) => `registry-type:${n}`)],
    r.before[1]!.bytes,
    r.current[1]!.bytes,
  );
  checkEdits(
    r.programImports,
    ["core-import", "type-key-import", "helper-import"],
    r.before[2]!.bytes,
    r.current[2]!.bytes,
  );
  fields(r.contract, ["beforeOffset", "current", "text"]);
  checkSpan(r.contract.current, r.current[0]!.bytes);
  if (
    !Number.isSafeInteger(r.contract.beforeOffset) ||
    r.contract.beforeOffset < 0 ||
    r.contract.beforeOffset > r.before[0]!.bytes ||
    r.contract.beforeOffset !== r.contract.current.start ||
    r.contract.current.bytes !== 207
  )
    fail("interface insertion bounds");
  authenticateSource(r.contract.text, r.contract.current, "new interface");
  const insertion = parsed("new-interface.ts", r.contract.text);
  if (insertion.statements.length !== 1 || !ts.isInterfaceDeclaration(insertion.statements[0]!))
    fail("new declaration is not type-only");
  fields(r.call, ["current", "text"]);
  checkSpan(r.call.current, r.current[2]!.bytes);
  authenticateSource(r.call.text, r.call.current, "new helper call");
  if (r.call.text !== `    ${helperName}(fn, registry);\n`) fail("fixed call scaffold");
  fields(r.transfer, ["before", "current", "renames"]);
  checkSpan(r.transfer.before, r.before[2]!.bytes);
  checkSpan(r.transfer.current, r.current[3]!.bytes);
  if (
    !Array.isArray(r.transfer.renames) ||
    !same(
      r.transfer.renames.map((x) => x.role),
      ["state-provenance-lookup", "resolved-site-lookup"],
    )
  )
    fail("two bound rename roles");
  let beforeEnd = r.transfer.before.start,
    currentEnd = r.transfer.current.start;
  for (const rename of r.transfer.renames) {
    fields(rename, ["role", "before", "current"]);
    checkSpan(rename.before, r.before[2]!.bytes);
    checkSpan(rename.current, r.current[3]!.bytes);
    if (
      rename.before.start < r.transfer.before.start ||
      rename.before.end > r.transfer.before.end ||
      rename.current.start < r.transfer.current.start ||
      rename.current.end > r.transfer.current.end
    )
      fail("rename outside moved body");
    if (rename.before.start < beforeEnd || rename.current.start < currentEnd) fail("rename overlap/order");
    authenticateSource("registry", rename.before, "old bound token");
    authenticateSource("lookup", rename.current, "new bound token");
    beforeEnd = rename.before.end;
    currentEnd = rename.current.end;
  }
  fields(r.helper, ["prefix", "invalid", "programInvalid", "beforeInvalid", "suffix", "absentBefore"]);
  checkSpan(r.helper.invalid, r.current[3]!.bytes);
  checkSpan(r.helper.programInvalid, r.current[2]!.bytes);
  checkSpan(r.helper.beforeInvalid, r.before[2]!.bytes);
  if (
    r.helper.absentBefore !== true ||
    r.helper.suffix !== "}\n" ||
    Buffer.byteLength(r.helper.prefix) !== r.helper.invalid.start ||
    r.helper.invalid.end !== r.transfer.current.start ||
    r.transfer.current.end + Buffer.byteLength(r.helper.suffix) !== r.current[3]!.bytes
  )
    fail("complete helper coverage");
  if (helperHeader(parsed("helper-scaffold.ts", r.helper.prefix + r.helper.suffix)).body.statements.length)
    fail("executable helper scaffold");
}
function editText(text: string, edits: readonly { readonly span: Span; readonly replacement: string }[]): string {
  const bytes = Buffer.from(text),
    parts: Buffer[] = [];
  let at = 0;
  for (const edit of [...edits].sort((a, b) => a.span.start - b.span.start)) {
    if (edit.span.start < at) fail("overlapping byte edits");
    if (edit.span.bytes === 0) {
      // Only the structurally checked helper-import before insertion may be empty.
      checkSpan(edit.span, bytes.length, true);
      authenticateSource("", edit.span, "empty insertion");
    } else slice(text, edit.span, "edited span");
    parts.push(bytes.subarray(at, edit.span.start), Buffer.from(edit.replacement));
    at = edit.span.end;
  }
  return Buffer.concat([...parts, bytes.subarray(at)]).toString("utf8");
}
function indent(text: string, delta: 2 | -2): string {
  return text
    .split("\n")
    .map((line, index, all) => {
      if (!line && index === all.length - 1) return line;
      if (!line.startsWith(delta === 2 ? "  " : "    ")) fail("exact moved indentation");
      return delta === 2 ? `  ${line}` : line.slice(2);
    })
    .join("\n");
}
function moved(r: IrAllocationProvenanceLookupSuccessorReceipt, text: string, direction: "before" | "current"): string {
  const span = r.transfer[direction],
    edits = r.transfer.renames.map((rename) => {
      const point = rename[direction];
      if (slice(text, point, rename.role) !== (direction === "current" ? "lookup" : "registry"))
        fail("bound rename token");
      return {
        span: { ...point, start: point.start - span.start, end: point.end - span.start },
        replacement: direction === "current" ? "registry" : "lookup",
      };
    });
  return indent(editText(slice(text, span, "moved loops"), edits), direction === "current" ? 2 : -2);
}
function verifySpans(r: IrAllocationProvenanceLookupSuccessorReceipt, current: ReadonlyMap<string, string>): void {
  const v = parsed(verifierPath, source(current, verifierPath)),
    p = parsed(programPath, source(current, programPath)),
    h = parsed(helperPath, source(current, helperPath));
  const byteSpan = (node: ts.Node, tree: ts.SourceFile) => [
    Buffer.byteLength(tree.text.slice(0, node.getStart(tree))),
    Buffer.byteLength(tree.text.slice(0, node.end)),
  ];
  for (const [i, name] of verifierNames.entries()) {
    if (
      !same(byteSpan(parameter(fn(v, name), 1, "registry", "AllocProvenanceLookup").type!, v), [
        r.verifier[i + 1]!.current.start,
        r.verifier[i + 1]!.current.end,
      ])
    )
      fail("parameter span role");
  }
  const uses = helperRoles(h).uses;
  for (const [i, use] of uses.entries())
    if (!same(byteSpan(use, h), [r.transfer.renames[i]!.current.start, r.transfer.renames[i]!.current.end]))
      fail("lookup span role");
  const local = invalid(p, fn(p, "assertPreparedIrProgramAllocations"));
  if (
    slice(p.text, r.helper.programInvalid, "program invalid").trim() !== local.getText(p) ||
    slice(h.text, r.helper.invalid, "helper invalid") !== slice(p.text, r.helper.programInvalid, "program invalid")
  )
    fail("error closure span role");
  for (const edit of r.verifier)
    if (slice(v.text, edit.current, edit.role) !== edit.currentText) fail("verifier edit text");
  for (const edit of r.programImports)
    if (slice(p.text, edit.current, edit.role) !== edit.currentText) fail("program import text");
  if (
    slice(p.text, r.call.current, "caller") !== r.call.text ||
    slice(source(current, contractPath), r.contract.current, "interface") !== r.contract.text
  )
    fail("call/interface span role");
}
function chain(r: IrAllocationProvenanceLookupSuccessorReceipt, oldText: string): void {
  authenticateSource(oldText, r.oldReceipt, "old Phase B receipt");
  const old = JSON.parse(oldText) as { current: readonly Record[] };
  for (const path of [verifierPath, programPath]) {
    const a = one(
        old.current.filter((x) => x.path === path),
        "old chain owner",
      ),
      b = one(
        r.before.filter((x) => x.path === path),
        "predecessor chain owner",
      );
    if (!same(a.bytes, b.bytes) || a.sha256 !== b.sha256 || a.gitBlob !== b.gitBlob)
      fail("old Phase B exact predecessor join");
  }
}
/** Reciprocal draft diagnostics. A passing draft is explicitly NOT receipt authentication. */
export function replayIrAllocationProvenanceLookupDraft(
  r: IrAllocationProvenanceLookupSuccessorReceipt,
  before: ReadonlyMap<string, string>,
): ReadonlyMap<string, string> {
  assertIrAllocationProvenanceLookupReceiptStructure(r);
  for (const record of r.before) authenticateSource(source(before, record.path), record, record.path);
  const output = new Map<string, string>();
  const contract = source(before, contractPath),
    insertion = r.contract.beforeOffset;
  output.set(
    contractPath,
    Buffer.concat([
      Buffer.from(contract).subarray(0, insertion),
      Buffer.from(r.contract.text),
      Buffer.from(contract).subarray(insertion),
    ]).toString(),
  );
  output.set(
    verifierPath,
    editText(
      source(before, verifierPath),
      r.verifier.map((e) => ({ span: e.before, replacement: e.currentText })),
    ),
  );
  const program = source(before, programPath);
  output.set(
    programPath,
    editText(program, [
      ...r.programImports.map((e) => ({ span: e.before, replacement: e.currentText })),
      { span: r.transfer.before, replacement: r.call.text },
    ]),
  );
  output.set(
    helperPath,
    r.helper.prefix +
      slice(program, r.helper.beforeInvalid, "predecessor invalid") +
      moved(r, program, "before") +
      r.helper.suffix,
  );
  for (const record of r.current) authenticateSource(source(output, record.path), record, `replayed ${record.path}`);
  assertIrAllocationProvenanceLookupSourceRoles(output);
  return output;
}
export function reconstructIrAllocationProvenanceLookupDraft(
  r: IrAllocationProvenanceLookupSuccessorReceipt,
  current: ReadonlyMap<string, string>,
): { readonly before: ReadonlyMap<string, string>; readonly current: ReadonlyMap<string, string> } {
  assertIrAllocationProvenanceLookupReceiptStructure(r);
  for (const record of r.current) authenticateSource(source(current, record.path), record, record.path);
  assertIrAllocationProvenanceLookupSourceRoles(current);
  verifySpans(r, current);
  const before = new Map<string, string>();
  before.set(contractPath, editText(source(current, contractPath), [{ span: r.contract.current, replacement: "" }]));
  before.set(
    verifierPath,
    editText(
      source(current, verifierPath),
      r.verifier.map((e) => ({ span: e.current, replacement: e.beforeText })),
    ),
  );
  before.set(
    programPath,
    editText(source(current, programPath), [
      ...r.programImports.map((e) => ({ span: e.current, replacement: e.beforeText })),
      { span: r.call.current, replacement: moved(r, source(current, helperPath), "current") },
    ]),
  );
  for (const record of r.before) authenticateSource(source(before, record.path), record, `predecessor ${record.path}`);
  const replayed = replayIrAllocationProvenanceLookupDraft(r, before);
  for (const path of irAllocationProvenanceLookupCurrentPaths)
    if (source(replayed, path) !== source(current, path)) fail(`reciprocal bytes ${path}`);
  return { before, current: replayed };
}
/** Fixed trust authority, deliberately unavailable until ROOT reviews both new files. */
export function authenticateIrAllocationProvenanceLookupReceipt(
  text: string,
): IrAllocationProvenanceLookupSuccessorReceipt {
  if (Buffer.byteLength(text) !== receiptBytes || pin(text).sha256 !== receiptSha256)
    fail("fixed receipt digest mismatch (unreviewed drafts are not authority)");
  const receipt = JSON.parse(text) as IrAllocationProvenanceLookupSuccessorReceipt;
  assertIrAllocationProvenanceLookupReceiptStructure(receipt);
  return receipt;
}
export function reconstructBeforeIrAllocationProvenanceLookup(rawReader: Reader = raw): ReadonlyMap<string, string> {
  const receipt = authenticateIrAllocationProvenanceLookupReceipt(rawReader(irAllocationProvenanceLookupReceiptPath));
  const current = new Map(irAllocationProvenanceLookupCurrentPaths.map((path) => [path, rawReader(path)]));
  // The old receipt digest is fixed independently; read only its non-executable chain metadata here.
  chain(receipt, rawReader(oldReceiptPath));
  return reconstructIrAllocationProvenanceLookupDraft(receipt, current).before;
}
export function readBeforeIrAllocationProvenanceLookup(path: string, rawReader: Reader = raw): string {
  if (!irAllocationProvenanceLookupBeforePaths.some((p) => p === path)) return rawReader(path);
  return source(reconstructBeforeIrAllocationProvenanceLookup(rawReader), path);
}
