// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { forEachChild, ts } from "../../ts-api.js";

type ValueKind = "number" | "string";
type FunctionBody = ts.FunctionLikeDeclaration & { body: ts.ConciseBody };
type Member = ts.PropertyAccessExpression | ts.ElementAccessExpression;

// This is an effect allowance, not intrinsic identity/stability evidence.
// Symbol-dispatching search/match/replace/split and locale hooks are excluded.
const INERT_STRING_CALLS = new Set([
  "charCodeAt",
  "codePointAt",
  "charAt",
  "indexOf",
  "lastIndexOf",
  "includes",
  "startsWith",
  "endsWith",
  "slice",
  "substring",
  "substr",
  "concat",
  "trim",
  "trimStart",
  "trimEnd",
  "toLowerCase",
  "toUpperCase",
  "toString",
  "valueOf",
]);

interface ReceiverPolicy {
  valueDeclarationOf(node: ts.Node): ts.Declaration | undefined;
  unwrap(expr: ts.Expression): ts.Expression;
  assignmentPropertyName(expr: ts.Expression): string | undefined;
  ownReturnExpressions(fn: FunctionBody): ts.Expression[] | undefined;
}

interface ReceiverProofs {
  isNumber(expr: ts.Expression, query: ReceiverQuery): boolean;
  isString(expr: ts.Expression, query: ReceiverQuery): boolean;
  isStableStringMethod(callee: ts.PropertyAccessExpression): boolean;
  isInertIntrinsicCall?(call: ts.CallExpression, query: ReceiverQuery): boolean;
}

interface Callable {
  readonly fn: FunctionBody;
  readonly declaration: ts.Declaration;
  readonly calls: (ts.CallExpression | ts.NewExpression)[];
  closed: boolean;
}

interface Constructor extends Callable {
  readonly methods: Map<string, Callable>;
  readonly initializers: Map<string, ts.Expression[]>;
  readonly writes: Map<string, ts.Expression[]>;
  readonly installs: Set<ts.BinaryExpression>;
}

interface Instance {
  readonly declaration: ts.VariableDeclaration;
  readonly allocation: ts.NewExpression;
  readonly owner: Constructor;
  closed: boolean;
}

/** Structural candidates only: neither Number identity nor effect completion. */
interface MethodInputCandidate {
  readonly parameter: ts.ParameterDeclaration;
  readonly method: ts.FunctionLikeDeclaration;
  readonly constructor: ts.Declaration;
  readonly installation: ts.BinaryExpression;
  readonly calls: readonly ts.CallExpression[];
  readonly arguments: readonly ts.Expression[];
}

function isMember(node: ts.Node): node is Member {
  return ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node);
}

/** Original transparent ancestry only; a callee's annotation is not evidence. */
function transparentCalleeCall(identifier: ts.Identifier, facts: ReceiverFacts): ts.CallExpression | undefined {
  const source = identifier.getSourceFile();
  if (!facts.nodes.includes(identifier) || !facts.sourceFiles.includes(source)) return undefined;
  let expression: ts.Expression = identifier;
  for (let depth = 0; depth <= 48; depth++) {
    const parent = expression.parent;
    if (!parent || parent.getSourceFile() !== source) return undefined;
    if (
      (ts.isParenthesizedExpression(parent) ||
        ts.isAsExpression(parent) ||
        ts.isTypeAssertionExpression(parent) ||
        ts.isSatisfiesExpression(parent) ||
        ts.isNonNullExpression(parent)) &&
      parent.expression === expression
    ) {
      if (depth === 48) return undefined;
      expression = parent;
      continue;
    }
    return ts.isCallExpression(parent) &&
      parent.expression === expression &&
      !parent.questionDotToken &&
      !parent.arguments.some(ts.isSpreadElement) &&
      facts.calls.includes(parent) &&
      facts.policy.unwrap(parent.expression) === identifier
      ? parent
      : undefined;
  }
  return undefined;
}

function enclosingFunction(node: ts.Node): ts.FunctionLikeDeclaration | undefined {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isFunctionLike(parent)) return parent as ts.FunctionLikeDeclaration;
  }
  return undefined;
}

function plainFunction(fn: FunctionBody): boolean {
  return (
    !("asteriskToken" in fn && fn.asteriskToken) &&
    !fn.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) &&
    new Set(fn.parameters.map((parameter) => parameter.name.getText())).size === fn.parameters.length &&
    fn.parameters.every(
      (parameter) =>
        ts.isIdentifier(parameter.name) &&
        !parameter.initializer &&
        !parameter.dotDotDotToken &&
        !parameter.questionToken,
    )
  );
}

function hasExport(fn: ts.FunctionDeclaration): boolean {
  return !!fn.modifiers?.some(
    (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword || modifier.kind === ts.SyntaxKind.DefaultKeyword,
  );
}

function literalPrimitive(expr: ts.Expression): boolean {
  return (
    ts.isStringLiteral(expr) ||
    ts.isNoSubstitutionTemplateLiteral(expr) ||
    ts.isNumericLiteral(expr) ||
    expr.kind === ts.SyntaxKind.TrueKeyword ||
    expr.kind === ts.SyntaxKind.FalseKeyword ||
    expr.kind === ts.SyntaxKind.NullKeyword
  );
}

function isDeclarationName(node: ts.Identifier): boolean {
  const parent = node.parent;
  return (
    (ts.isVariableDeclaration(parent) || ts.isParameter(parent) || ts.isFunctionDeclaration(parent)) &&
    parent.name === node
  );
}

function unconditionalVariable(declaration: ts.VariableDeclaration): boolean {
  const statement = declaration.parent.parent;
  if (!ts.isVariableDeclarationList(declaration.parent) || !ts.isVariableStatement(statement)) return false;
  if (ts.isSourceFile(statement.parent)) return true;
  const fn = enclosingFunction(declaration);
  return !!fn && "body" in fn && fn.body === statement.parent;
}

function standardMember(policy: ReceiverPolicy, node: ts.Node, owner: string, key: string): boolean {
  const declaration = policy.valueDeclarationOf(node);
  if (!declaration || !declaration.getSourceFile().isDeclarationFile) return false;
  if (!/(?:^|\/)lib(?:\.[\w-]+)*\.d\.ts$/.test(declaration.getSourceFile().fileName)) return false;
  return (
    ts.isMethodSignature(declaration) &&
    declaration.name.getText() === key &&
    ts.isInterfaceDeclaration(declaration.parent) &&
    declaration.parent.name.text === owner
  );
}

/** Immutable after construction; every AST and binding identity remains original. */
class ReceiverFacts {
  readonly nodes: ts.Node[] = [];
  readonly functions = new Map<ts.Declaration, Callable>();
  readonly constructors = new Map<ts.Declaration, Constructor>();
  readonly methodOwners = new Map<ts.FunctionLikeDeclaration, Constructor>();
  readonly instances = new Map<ts.Declaration, Instance>();
  readonly references = new Map<ts.Declaration, ts.Identifier[]>();
  readonly assignments = new Map<ts.Declaration, ts.Expression[]>();
  readonly changed = new Set<ts.Declaration>();
  readonly invalidAssignments = new Set<ts.Declaration>();
  readonly exported = new Set<ts.Declaration>();
  readonly writes: { target: ts.Expression; node: ts.Node; value?: ts.Expression }[] = [];
  readonly calls: ts.CallExpression[] = [];
  readonly allocations: ts.NewExpression[] = [];
  readonly arrayBindings = new Map<ts.Declaration, ts.ArrayLiteralExpression>();
  readonly arrayEscapes = new Set<ts.Declaration>();
  unsafeSyntax = false;

  constructor(
    readonly sourceFiles: readonly ts.SourceFile[],
    readonly policy: ReceiverPolicy,
  ) {
    this.collect();
    this.collectConstructors();
    this.collectInstances();
    this.closeReferences();
    this.collectFields();
    this.closeCycles();
  }

  binding(expr: ts.Expression): ts.Declaration | undefined {
    const value = this.policy.unwrap(expr);
    return ts.isIdentifier(value) ? this.policy.valueDeclarationOf(value) : undefined;
  }

  private collect(): void {
    const visit = (node: ts.Node): void => {
      this.nodes.push(node);
      if (ts.isIdentifier(node)) {
        const declaration = this.policy.valueDeclarationOf(node);
        if (declaration) {
          let references = this.references.get(declaration);
          if (!references) this.references.set(declaration, (references = []));
          references.push(node);
        }
      }
      if (ts.isFunctionDeclaration(node) && node.name && node.body) {
        const declaration = this.policy.valueDeclarationOf(node.name);
        if (declaration === node) {
          this.functions.set(declaration, {
            fn: node as FunctionBody,
            declaration,
            calls: [],
            closed: plainFunction(node as FunctionBody),
          });
          if (hasExport(node)) this.exported.add(declaration);
        }
      }
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
        const declaration = this.policy.valueDeclarationOf(node.name);
        const statement = node.parent.parent;
        if (
          declaration &&
          ts.isVariableStatement(statement) &&
          statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
        ) {
          this.exported.add(declaration);
        }
        if (declaration && declaration !== node) {
          // A repeated var or parameter redeclaration is a second definition,
          // never an invisible initializer outside the exact binding population.
          this.changed.add(declaration);
          this.invalidAssignments.add(declaration);
        }
        if (node.initializer) {
          const value = this.policy.unwrap(node.initializer);
          if (declaration === node && ts.isArrayLiteralExpression(value) && unconditionalVariable(node)) {
            this.arrayBindings.set(declaration, value);
          }
        }
      }
      if (ts.isCallExpression(node)) this.calls.push(node);
      if (ts.isNewExpression(node)) this.allocations.push(node);
      const target =
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
          ? this.policy.unwrap(node.left)
          : ts.isDeleteExpression(node)
            ? this.policy.unwrap(node.expression)
            : (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
                (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)
              ? this.policy.unwrap(node.operand)
              : undefined;
      if (target) {
        const value =
          ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken ? node.right : undefined;
        this.writes.push({ target, node, value });
        const declaration = this.binding(target);
        if (declaration) {
          this.changed.add(declaration);
          if (value) {
            let definitions = this.assignments.get(declaration);
            if (!definitions) this.assignments.set(declaration, (definitions = []));
            definitions.push(value);
          } else this.invalidAssignments.add(declaration);
        }
      }
      if (
        ts.isWithStatement(node) ||
        ts.isTaggedTemplateExpression(node) ||
        ts.isClassDeclaration(node) ||
        ts.isClassExpression(node) ||
        ts.isImportDeclaration(node) ||
        ts.isImportEqualsDeclaration(node) ||
        ts.isExportAssignment(node) ||
        (ts.isVariableDeclaration(node) && !ts.isIdentifier(node.name)) ||
        (ts.isParameter(node) && !ts.isIdentifier(node.name))
      ) {
        this.unsafeSyntax = true;
      }
      if (ts.isExportDeclaration(node)) {
        if (node.moduleSpecifier || !node.exportClause || !ts.isNamedExports(node.exportClause))
          this.unsafeSyntax = true;
        else {
          for (const item of node.exportClause.elements) {
            const name = (item.propertyName ?? item.name).text;
            for (const callable of this.functions.values()) {
              if (callable.fn.getSourceFile() === node.getSourceFile() && callable.fn.name?.getText() === name) {
                this.exported.add(callable.declaration);
              }
            }
            // Exports are revisited after all declarations have been collected.
          }
        }
      }
      forEachChild(node, visit);
    };
    for (const file of this.sourceFiles) visit(file);
    for (const node of this.nodes) {
      if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) {
        for (const item of node.exportClause.elements) {
          const name = (item.propertyName ?? item.name).text;
          for (const [declaration, references] of this.references) {
            if (
              references.some(
                (ref) => isDeclarationName(ref) && ref.text === name && ref.getSourceFile() === node.getSourceFile(),
              )
            ) {
              this.exported.add(declaration);
            }
          }
        }
      }
    }
  }

  private installation(
    node: ts.Node,
  ): { declaration: ts.Declaration; key: string; fn: ts.FunctionExpression } | undefined {
    if (!ts.isBinaryExpression(node) || node.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return undefined;
    if (!ts.isExpressionStatement(node.parent) || !ts.isSourceFile(node.parent.parent)) return undefined;
    const left = this.policy.unwrap(node.left);
    const right = this.policy.unwrap(node.right);
    if (!isMember(left) || !ts.isFunctionExpression(right) || !right.body || right.name) return undefined;
    const prototype = this.policy.unwrap(left.expression);
    if (!ts.isPropertyAccessExpression(prototype) || prototype.name.text !== "prototype") return undefined;
    const declaration = this.binding(prototype.expression);
    const key = this.policy.assignmentPropertyName(left);
    return declaration && key !== undefined && key !== "__proto__" && key !== "constructor"
      ? { declaration, key, fn: right }
      : undefined;
  }

  private collectConstructors(): void {
    for (const allocation of this.allocations) {
      const declaration = this.binding(allocation.expression);
      const callable = declaration && this.functions.get(declaration);
      if (!callable || this.constructors.has(callable.declaration)) continue;
      const owner: Constructor = {
        ...callable,
        calls: [],
        methods: new Map(),
        initializers: new Map(),
        writes: new Map(),
        installs: new Set(),
      };
      this.constructors.set(callable.declaration, owner);
    }
    for (const node of this.nodes) {
      const install = this.installation(node);
      const owner = install && this.constructors.get(install.declaration);
      if (!owner || !install || !ts.isBinaryExpression(node)) continue;
      if (owner.methods.has(install.key) || !plainFunction(install.fn as FunctionBody)) owner.closed = false;
      owner.methods.set(install.key, {
        fn: install.fn as FunctionBody,
        declaration: install.fn,
        calls: [],
        closed: plainFunction(install.fn as FunctionBody),
      });
      owner.installs.add(node);
      this.methodOwners.set(install.fn, owner);
    }
  }

  private collectInstances(): void {
    for (const allocation of this.allocations) {
      const declaration = this.binding(allocation.expression);
      const owner = declaration && this.constructors.get(declaration);
      if (!owner) continue;
      owner.calls.push(allocation);
      const variable = allocation.parent;
      if (
        !ts.isVariableDeclaration(variable) ||
        variable.initializer !== allocation ||
        !ts.isIdentifier(variable.name) ||
        !unconditionalVariable(variable)
      ) {
        owner.closed = false;
        continue;
      }
      const binding = this.policy.valueDeclarationOf(variable.name);
      if (binding !== variable || variable.getSourceFile() !== owner.fn.getSourceFile()) {
        owner.closed = false;
        continue;
      }
      this.instances.set(binding, {
        declaration: variable,
        allocation,
        owner,
        closed: !this.changed.has(binding) && !this.exported.has(binding),
      });
      if (
        !allocation.arguments ||
        allocation.arguments.some(ts.isSpreadElement) ||
        allocation.arguments.length !== owner.fn.parameters.length
      ) {
        owner.closed = false;
      }
      if ([...owner.installs].some((install) => install.pos > allocation.pos)) owner.closed = false;
      if (
        this.calls.some(
          (call) => !enclosingFunction(call) && [...owner.installs].some((install) => call.pos < install.pos),
        )
      ) {
        owner.closed = false;
      }
    }
  }

  receiver(expr: ts.Expression): Constructor | undefined {
    const value = this.policy.unwrap(expr);
    if (value.kind === ts.SyntaxKind.ThisKeyword) {
      const fn = enclosingFunction(value);
      if (!fn) return undefined;
      const owner = this.methodOwners.get(fn) ?? [...this.constructors.values()].find((entry) => entry.fn === fn);
      return owner?.closed ? owner : undefined;
    }
    const binding = this.binding(value);
    const instance = binding && this.instances.get(binding);
    return instance?.closed && instance.owner.closed ? instance.owner : undefined;
  }

  private closeReferences(): void {
    for (const [declaration, callable] of this.functions) {
      const owner = this.constructors.get(declaration);
      if (this.changed.has(declaration) || this.exported.has(declaration)) callable.closed = false;
      if (owner && !callable.closed) owner.closed = false;
      for (const reference of this.references.get(declaration) ?? []) {
        if (reference === callable.fn.name) continue;
        const parent = reference.parent;
        if (owner) {
          const install =
            ts.isPropertyAccessExpression(parent) &&
            parent.expression === reference &&
            parent.name.text === "prototype" &&
            isMember(parent.parent) &&
            ts.isBinaryExpression(parent.parent.parent)
              ? parent.parent.parent
              : undefined;
          if (
            !(ts.isNewExpression(parent) && parent.expression === reference) &&
            !(install && owner.installs.has(install))
          ) {
            owner.closed = false;
          }
        } else if (
          ts.isCallExpression(parent) &&
          parent.expression === reference &&
          !parent.questionDotToken &&
          parent.getSourceFile() === callable.fn.getSourceFile()
        ) {
          callable.calls.push(parent);
        } else {
          callable.closed = false;
        }
      }
      if (
        !owner &&
        callable.calls.some(
          (call) =>
            call.arguments?.some(ts.isSpreadElement) || call.arguments?.length !== callable.fn.parameters.length,
        )
      ) {
        callable.closed = false;
      }
    }
    for (const [declaration, instance] of this.instances) {
      for (const reference of this.references.get(declaration) ?? []) {
        if (reference === instance.declaration.name) continue;
        const parent = reference.parent;
        if (
          !isMember(parent) ||
          parent.expression !== reference ||
          parent.questionDotToken ||
          this.policy.assignmentPropertyName(parent) === undefined ||
          reference.pos < instance.declaration.pos ||
          enclosingFunction(reference) !== enclosingFunction(instance.declaration)
        ) {
          instance.closed = false;
        }
      }
      if (!instance.closed) instance.owner.closed = false;
    }
    for (const [declaration] of this.arrayBindings) {
      if (this.changed.has(declaration) || this.exported.has(declaration)) this.arrayEscapes.add(declaration);
      for (const reference of this.references.get(declaration) ?? []) {
        if (isDeclarationName(reference)) continue;
        const parent = reference.parent;
        if (
          !ts.isPropertyAccessExpression(parent) ||
          parent.expression !== reference ||
          parent.name.text !== "join" ||
          parent.questionDotToken ||
          !ts.isCallExpression(parent.parent) ||
          parent.parent.expression !== parent ||
          parent.parent.questionDotToken
        ) {
          this.arrayEscapes.add(declaration);
        }
      }
    }
    // An unresolved same-spelled use is missing population evidence, not zero references.
    for (const node of this.nodes) {
      if (
        !ts.isIdentifier(node) ||
        this.policy.valueDeclarationOf(node) ||
        (ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)
      ) {
        continue;
      }
      for (const owner of this.constructors.values()) if (owner.fn.name?.getText() === node.text) owner.closed = false;
      for (const callable of this.functions.values())
        if (callable.fn.name?.getText() === node.text) callable.closed = false;
    }
  }

  private collectFields(): void {
    for (const owner of this.constructors.values()) {
      if (!ts.isBlock(owner.fn.body) || owner.calls.length === 0) {
        owner.closed = false;
        continue;
      }
      const initialized = new Set<string>();
      for (const statement of owner.fn.body.statements) {
        if (
          !ts.isExpressionStatement(statement) ||
          !ts.isBinaryExpression(statement.expression) ||
          statement.expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken
        ) {
          owner.closed = false;
          continue;
        }
        const assignment = statement.expression;
        const left = this.policy.unwrap(assignment.left);
        const key =
          isMember(left) && this.policy.unwrap(left.expression).kind === ts.SyntaxKind.ThisKeyword
            ? this.policy.assignmentPropertyName(left)
            : undefined;
        if (key === undefined || key === "__proto__" || key === "constructor" || owner.methods.has(key)) {
          owner.closed = false;
          continue;
        }
        const scan = (node: ts.Node): void => {
          if (node.kind === ts.SyntaxKind.ThisKeyword) {
            const member = node.parent;
            const readKey =
              isMember(member) && member.expression === node ? this.policy.assignmentPropertyName(member) : undefined;
            if (readKey === undefined || !initialized.has(readKey)) owner.closed = false;
          }
          forEachChild(node, scan);
        };
        scan(assignment.right);
        let definitions = owner.initializers.get(key);
        if (!definitions) owner.initializers.set(key, (definitions = []));
        definitions.push(assignment.right);
        initialized.add(key);
      }
    }
    for (const node of this.nodes) {
      if (node.kind === ts.SyntaxKind.ThisKeyword) {
        const owner = this.receiver(node as ts.Expression);
        const parent = node.parent;
        if (
          !owner ||
          !isMember(parent) ||
          parent.expression !== node ||
          parent.questionDotToken ||
          this.policy.assignmentPropertyName(parent) === undefined
        ) {
          const fn = enclosingFunction(node);
          const candidate =
            fn && (this.methodOwners.get(fn) ?? [...this.constructors.values()].find((entry) => entry.fn === fn));
          if (candidate) candidate.closed = false;
          else this.unsafeSyntax = true;
        }
      }
      if (!isMember(node)) continue;
      const owner = this.receiver(node.expression);
      if (!owner) continue;
      const key = this.policy.assignmentPropertyName(node);
      if (key === undefined || node.questionDotToken || key === "__proto__" || key === "constructor") {
        owner.closed = false;
        continue;
      }
      const method = owner.methods.get(key);
      if (method) {
        const parent = node.parent;
        if (
          !ts.isCallExpression(parent) ||
          parent.expression !== node ||
          parent.questionDotToken ||
          parent.arguments.some(ts.isSpreadElement) ||
          parent.arguments.length !== method.fn.parameters.length
        ) {
          owner.closed = false;
        } else {
          method.calls.push(parent);
        }
      } else if (!owner.initializers.has(key)) owner.closed = false;
    }
    for (const write of this.writes) {
      if (!isMember(write.target)) continue;
      const owner = this.receiver(write.target.expression);
      if (!owner) continue;
      const key = this.policy.assignmentPropertyName(write.target);
      if (!write.value || key === undefined || owner.methods.has(key) || !owner.initializers.has(key)) {
        owner.closed = false;
        continue;
      }
      if (enclosingFunction(write.node) === owner.fn) continue;
      let values = owner.writes.get(key);
      if (!values) owner.writes.set(key, (values = []));
      values.push(write.value);
    }
  }

  private closeCycles(): void {
    const callables = [
      ...this.functions.values(),
      ...this.constructors.values(),
      ...[...this.constructors.values()].flatMap((owner) => [...owner.methods.values()]),
    ];
    const outgoing = new Map<FunctionBody, Set<Callable>>();
    for (const call of this.calls) {
      const caller = enclosingFunction(call);
      if (!caller) continue;
      const callee = this.policy.unwrap(call.expression);
      const declaration = this.binding(callee);
      let target = declaration && this.functions.get(declaration);
      if (isMember(callee)) {
        const key = this.policy.assignmentPropertyName(callee);
        const owner = this.receiver(callee.expression);
        target = key !== undefined && owner ? owner.methods.get(key) : undefined;
      }
      if (!target) continue;
      let edges = outgoing.get(caller as FunctionBody);
      if (!edges) outgoing.set(caller as FunctionBody, (edges = new Set()));
      edges.add(target);
    }
    const cyclic = (fn: FunctionBody, path: Set<FunctionBody>, depth: number): boolean => {
      if (depth > 48 || path.has(fn)) return true;
      path.add(fn);
      try {
        return [...(outgoing.get(fn) ?? [])].some((callee) => cyclic(callee.fn, path, depth + 1));
      } finally {
        path.delete(fn);
      }
    };
    for (const callable of callables) {
      if (cyclic(callable.fn, new Set(), 0)) callable.closed = false;
    }
  }

  methodInputCandidates(): readonly MethodInputCandidate[] {
    if (this.unsafeSyntax) return Object.freeze([]);
    const candidates: MethodInputCandidate[] = [];
    for (const owner of this.constructors.values()) {
      if (!owner.closed || this.exported.has(owner.declaration)) continue;
      for (const method of owner.methods.values()) {
        if (!method.closed || !plainFunction(method.fn) || method.calls.length === 0) continue;
        const installation = [...owner.installs].find((node) => this.installation(node)?.fn === method.fn);
        if (!installation || !this.sourceFiles.includes(method.fn.getSourceFile())) continue;
        const calls = method.calls.filter((call): call is ts.CallExpression => ts.isCallExpression(call));
        if (
          calls.length !== method.calls.length ||
          calls.some((call) => {
            const member = this.policy.unwrap(call.expression);
            return (
              !this.calls.includes(call) ||
              !isMember(member) ||
              member.questionDotToken ||
              call.questionDotToken ||
              this.receiver(member.expression) !== owner ||
              owner.methods.get(this.policy.assignmentPropertyName(member) ?? "") !== method ||
              call.arguments.length !== method.fn.parameters.length ||
              call.arguments.some(ts.isSpreadElement)
            );
          })
        )
          continue;
        for (const [index, parameter] of method.fn.parameters.entries()) {
          if (
            !ts.isIdentifier(parameter.name) ||
            this.policy.valueDeclarationOf(parameter.name) !== parameter ||
            this.invalidAssignments.has(parameter) ||
            !this.nodes.includes(parameter)
          )
            continue;
          const arguments_ = calls.flatMap((call) => {
            const argument = call.arguments[index];
            return argument ? [argument] : [];
          });
          if (arguments_.length !== calls.length || arguments_.some((argument) => !this.nodes.includes(argument)))
            continue;
          candidates.push(
            Object.freeze({
              parameter,
              method: method.fn,
              constructor: owner.declaration,
              installation,
              calls: Object.freeze([...calls]),
              arguments: Object.freeze(arguments_),
            }),
          );
        }
      }
    }
    return Object.freeze(candidates);
  }
}

/** No truth cache: these guards and induction assumptions belong to one query. */
class ReceiverQuery {
  private readonly inFlight = new Set<ts.Node>();
  private readonly intrinsicCallsInFlight = new Set<ts.CallExpression>();
  private readonly fieldInFlight = new Map<Constructor, Set<string>>();
  private readonly assumptions = new Map<Constructor, Map<string, ValueKind>>();
  private checkingEffects = false;
  private depth = 0;
  private active = true;

  constructor(
    private readonly facts: ReceiverFacts,
    private readonly proofs: ReceiverProofs,
  ) {}

  complete(run: (query: ReceiverQuery) => boolean): boolean {
    // Evaluate the requested value before the perimeter. A perimeter may need
    // the same independently initialized field; validating it while that field
    // is in flight would turn supported induction into a spurious cycle.
    return this.active && run(this) && this.effectsSafe();
  }

  dispose(): void {
    this.active = false;
    this.inFlight.clear();
    this.intrinsicCallsInFlight.clear();
    this.fieldInFlight.clear();
    this.assumptions.clear();
    this.checkingEffects = false;
  }

  private prove(expr: ts.Expression, kind: ValueKind): boolean {
    if (++this.depth > 48) {
      this.depth--;
      return false;
    }
    try {
      return kind === "number" ? this.proofs.isNumber(expr, this) : this.proofs.isString(expr, this);
    } finally {
      this.depth--;
    }
  }

  private guarded(node: ts.Node, run: () => boolean): boolean {
    if (this.inFlight.has(node)) return false;
    this.inFlight.add(node);
    try {
      return run();
    } finally {
      this.inFlight.delete(node);
    }
  }

  proveParameter(identifier: ts.Identifier, kind: ValueKind): boolean {
    if (!this.active) return false;
    const declaration = this.facts.policy.valueDeclarationOf(identifier);
    if (!declaration || !ts.isParameter(declaration) || !ts.isIdentifier(declaration.name)) return false;
    const fn = declaration.parent;
    const owner = this.facts.methodOwners.get(fn as ts.FunctionLikeDeclaration);
    const callable = owner
      ? [...owner.methods.values()].find((entry) => entry.fn === fn)
      : (this.facts.constructors.get(fn as ts.Declaration) ?? this.facts.functions.get(fn as ts.Declaration));
    if (
      !callable?.closed ||
      (owner && !owner.closed) ||
      this.facts.exported.has(callable.declaration) ||
      callable.calls.length === 0
    ) {
      return false;
    }
    if (!plainFunction(callable.fn) || this.facts.invalidAssignments.has(declaration)) return false;
    const index = callable.fn.parameters.indexOf(declaration);
    return this.guarded(declaration, () => {
      for (const call of callable.calls) {
        const argument = call.arguments?.[index];
        if (
          !argument ||
          call.arguments?.some(ts.isSpreadElement) ||
          call.arguments?.length !== callable.fn.parameters.length ||
          !this.prove(argument, kind)
        ) {
          return false;
        }
      }
      return (this.facts.assignments.get(declaration) ?? []).every((value) => this.prove(value, kind));
    });
  }

  proveBinding(identifier: ts.Identifier, kind: ValueKind): boolean {
    if (!this.active) return false;
    const declaration = this.facts.policy.valueDeclarationOf(identifier);
    if (
      !declaration ||
      !ts.isVariableDeclaration(declaration) ||
      !declaration.initializer ||
      !ts.isIdentifier(declaration.name) ||
      this.facts.invalidAssignments.has(declaration) ||
      this.facts.exported.has(declaration)
    ) {
      return false;
    }
    if (!unconditionalVariable(declaration)) return false;
    // Reads preceding a declaration are never supplied by this extra proof.
    if (
      (this.facts.references.get(declaration) ?? []).some((ref) => !isDeclarationName(ref) && ref.pos < declaration.pos)
    ) {
      return false;
    }
    const frame = enclosingFunction(declaration);
    if (frame && (this.facts.references.get(declaration) ?? []).some((ref) => enclosingFunction(ref) !== frame)) {
      return false;
    }
    if (
      !frame &&
      [...this.facts.calls, ...this.facts.allocations].some(
        (call) => !enclosingFunction(call) && call.pos < declaration.pos,
      )
    ) {
      return false;
    }
    return this.guarded(
      declaration,
      () =>
        this.prove(declaration.initializer!, kind) &&
        (this.facts.assignments.get(declaration) ?? []).every((value) => this.prove(value, kind)),
    );
  }

  proveField(property: Member, kind: ValueKind): boolean {
    if (!this.active) return false;
    const owner = this.facts.receiver(property.expression);
    const key = this.facts.policy.assignmentPropertyName(property);
    if (!owner || key === undefined || property.questionDotToken) return false;
    if (this.assumptions.get(owner)?.get(key) === kind) return true;
    let fields = this.fieldInFlight.get(owner);
    if (!fields) this.fieldInFlight.set(owner, (fields = new Set()));
    if (fields.has(key)) return false;
    fields.add(key);
    try {
      const initializers = owner.initializers.get(key);
      if (!initializers?.length || !this.prove(initializers[0]!, kind)) return false;
      let assumptions = this.assumptions.get(owner);
      if (!assumptions) this.assumptions.set(owner, (assumptions = new Map()));
      assumptions.set(key, kind);
      try {
        return (
          initializers.slice(1).every((value) => this.prove(value, kind)) &&
          (owner.writes.get(key) ?? []).every((value) => this.prove(value, kind))
        );
      } finally {
        assumptions.delete(key);
      }
    } finally {
      fields.delete(key);
    }
  }

  proveMethodCall(call: ts.CallExpression, kind: ValueKind): boolean {
    if (!this.active) return false;
    const callee = this.facts.policy.unwrap(call.expression);
    if (!isMember(callee) || call.questionDotToken || callee.questionDotToken) return false;
    const owner = this.facts.receiver(callee.expression);
    const key = this.facts.policy.assignmentPropertyName(callee);
    const method = key !== undefined && owner?.methods.get(key);
    if (!owner || !method || !method.closed || !method.calls.includes(call)) return false;
    const returns = this.facts.policy.ownReturnExpressions(method.fn);
    if (!returns?.length) return false;
    return this.guarded(method.fn, () => returns.every((value) => this.prove(value, kind)));
  }

  private arrayJoinShape(call: ts.CallExpression): boolean {
    const callee = this.facts.policy.unwrap(call.expression);
    if (
      !ts.isPropertyAccessExpression(callee) ||
      callee.name.text !== "join" ||
      call.questionDotToken ||
      callee.questionDotToken
    ) {
      return false;
    }
    if (!standardMember(this.facts.policy, callee.name, "Array", "join")) return false;
    const declaration = this.facts.binding(callee.expression);
    const array = declaration && this.facts.arrayBindings.get(declaration);
    if (
      !array ||
      this.facts.arrayEscapes.has(declaration!) ||
      call.pos < declaration!.pos ||
      enclosingFunction(call) !== enclosingFunction(declaration!)
    ) {
      return false;
    }
    if (call.arguments.length > 1 || call.arguments.some(ts.isSpreadElement)) return false;
    return (
      array.elements.every((element) => literalPrimitive(this.facts.policy.unwrap(element))) &&
      call.arguments.every((argument) => literalPrimitive(this.facts.policy.unwrap(argument)))
    );
  }

  proveArrayJoin(call: ts.CallExpression): boolean {
    if (!this.active) return false;
    return this.arrayJoinShape(call);
  }

  /** Provisional effect seams: original closed receivers only, never completion. */
  permitsReceiverRead(member: Member): boolean {
    if (!this.active || !this.facts.nodes.includes(member) || member.questionDotToken) return false;
    const owner = this.facts.receiver(member.expression);
    const key = this.facts.policy.assignmentPropertyName(member);
    if (owner && key !== undefined && owner.initializers.has(key)) return true;
    const parent = member.parent;
    return (
      isMember(parent) &&
      parent.expression === member &&
      ts.isBinaryExpression(parent.parent) &&
      [...this.facts.constructors.values()].some(
        (entry) => entry.closed && entry.installs.has(parent.parent as ts.BinaryExpression),
      )
    );
  }

  permitsReceiverWrite(target: ts.Expression, node: ts.Node): boolean {
    return (
      this.active &&
      this.facts.nodes.includes(target) &&
      this.facts.writes.some((write) => write.target === target && write.node === node) &&
      isMember(target) &&
      !target.questionDotToken &&
      this.facts.policy.assignmentPropertyName(target) !== undefined &&
      this.safeWrite(target, node)
    );
  }

  permitsReceiverCall(call: ts.CallExpression): boolean {
    if (!this.active || !this.facts.calls.includes(call) || call.questionDotToken) return false;
    const callee = this.facts.policy.unwrap(call.expression);
    if (!isMember(callee) || callee.questionDotToken) return false;
    const owner = this.facts.receiver(callee.expression);
    const key = this.facts.policy.assignmentPropertyName(callee);
    if (!owner || key === undefined) return false;
    const method = owner.methods.get(key);
    if (!method || !method.closed) return false;
    return method.calls.includes(call);
  }

  private inert(expr: ts.Expression): boolean {
    const value = this.facts.policy.unwrap(expr);
    // Primitive String length is inert even when the original field was any.
    // This is an effect check, not a new expression/representation verdict.
    const stringLength =
      isMember(value) &&
      !value.questionDotToken &&
      this.facts.policy.assignmentPropertyName(value) === "length" &&
      this.prove(value.expression, "string");
    return literalPrimitive(value) || stringLength || this.prove(value, "number") || this.prove(value, "string");
  }

  private inertIntrinsicCall(call: ts.CallExpression): boolean {
    if (
      !this.active ||
      !this.facts.calls.includes(call) ||
      this.intrinsicCallsInFlight.has(call) ||
      call.questionDotToken ||
      call.arguments.some(ts.isSpreadElement)
    )
      return false;
    this.intrinsicCallsInFlight.add(call);
    try {
      return this.proofs.isInertIntrinsicCall?.(call, this) === true;
    } finally {
      this.intrinsicCallsInFlight.delete(call);
    }
  }

  private safeCall(call: ts.CallExpression): boolean {
    if (call.questionDotToken || call.arguments.some(ts.isSpreadElement)) return false;
    if (this.inertIntrinsicCall(call)) return true;
    const callee = this.facts.policy.unwrap(call.expression);
    const declaration = this.facts.binding(callee);
    if (declaration) {
      const callable = this.facts.functions.get(declaration);
      // The complete source body is scanned separately, including unused bodies.
      return !!callable?.closed && !this.facts.constructors.has(declaration);
    }
    if (!ts.isPropertyAccessExpression(callee) || callee.questionDotToken) return false;
    const owner = this.facts.receiver(callee.expression);
    const method = owner?.methods.get(callee.name.text);
    if (method) return method.closed && method.calls.includes(call);
    if (this.arrayJoinShape(call)) return true;
    return (
      INERT_STRING_CALLS.has(callee.name.text) &&
      this.proofs.isStableStringMethod(callee) &&
      this.prove(callee.expression, "string") &&
      call.arguments.every((argument) => this.inert(argument))
    );
  }

  private safeWrite(target: ts.Expression, node: ts.Node): boolean {
    if (ts.isIdentifier(target)) return !!this.facts.binding(target);
    if (!isMember(target)) return false;
    if (
      ts.isBinaryExpression(node) &&
      [...this.facts.constructors.values()].some((owner) => owner.closed && owner.installs.has(node))
    ) {
      return true;
    }
    const owner = this.facts.receiver(target.expression);
    const key = this.facts.policy.assignmentPropertyName(target);
    return (
      !!owner &&
      key !== undefined &&
      owner.initializers.has(key) &&
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken
    );
  }

  private safeRead(member: Member): boolean {
    const parent = member.parent;
    if (
      ts.isBinaryExpression(parent) &&
      this.facts.writes.some((write) => write.node === parent && write.target === member)
    ) {
      return this.safeWrite(member, parent);
    }
    // Constructor prototype accesses occur only inside exact installations.
    if (
      isMember(parent) &&
      parent.expression === member &&
      ts.isBinaryExpression(parent.parent) &&
      [...this.facts.constructors.values()].some(
        (owner) => owner.closed && owner.installs.has(parent.parent as ts.BinaryExpression),
      )
    ) {
      return true;
    }
    const owner = this.facts.receiver(member.expression);
    if (owner) return !member.questionDotToken && this.facts.policy.assignmentPropertyName(member) !== undefined;
    if (ts.isCallExpression(parent) && parent.expression === member) return this.safeCall(parent);
    const key = this.facts.policy.assignmentPropertyName(member);
    return !member.questionDotToken && key === "length" && this.prove(member.expression, "string");
  }

  private effectsSafe(): boolean {
    if (this.checkingEffects) return true;
    if (this.facts.unsafeSyntax) return false;
    this.checkingEffects = true;
    try {
      if (this.facts.writes.some((write) => !this.safeWrite(write.target, write.node))) return false;
      if (
        this.facts.allocations.some((allocation) => {
          const declaration = this.facts.binding(allocation.expression);
          return !declaration || !this.facts.constructors.get(declaration)?.closed;
        })
      ) {
        return false;
      }
      for (const node of this.facts.nodes) {
        if (
          ts.isIdentifier(node) &&
          ["Array", "Object", "String", "Reflect"].includes(node.text) &&
          !isDeclarationName(node) &&
          !(isMember(node.parent) && node.parent.expression === node)
        ) {
          // A bare intrinsic namespace/constructor alias can escape and mutate
          // the lookup domain without a syntactic write through its old name.
          const call = node.text === "String" ? transparentCalleeCall(node, this.facts) : undefined;
          if (!call || !this.inertIntrinsicCall(call)) return false;
        }
        if (ts.isCallExpression(node) && !this.safeCall(node)) return false;
        if (isMember(node) && !this.safeRead(node)) return false;
        if (ts.isTemplateExpression(node) && node.templateSpans.some((span) => !this.inert(span.expression)))
          return false;
        if (ts.isBinaryExpression(node)) {
          const operator = node.operatorToken.kind;
          if (
            operator >= ts.SyntaxKind.FirstBinaryOperator &&
            operator <= ts.SyntaxKind.LastBinaryOperator &&
            ![
              ts.SyntaxKind.EqualsEqualsEqualsToken,
              ts.SyntaxKind.ExclamationEqualsEqualsToken,
              ts.SyntaxKind.AmpersandAmpersandToken,
              ts.SyntaxKind.BarBarToken,
              ts.SyntaxKind.QuestionQuestionToken,
              ts.SyntaxKind.CommaToken,
              ts.SyntaxKind.EqualsToken,
            ].includes(operator) &&
            (!this.inert(node.left) || !this.inert(node.right))
          ) {
            return false;
          }
        }
        if (
          (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
          node.operator !== ts.SyntaxKind.ExclamationToken &&
          !this.inert(node.operand)
        ) {
          return false;
        }
        if (
          ts.isAwaitExpression(node) ||
          ts.isYieldExpression(node) ||
          ts.isSpreadAssignment(node) ||
          ts.isSpreadElement(node) ||
          ts.isForInStatement(node) ||
          ts.isForOfStatement(node) ||
          ts.isDeleteExpression(node)
        ) {
          return false;
        }
      }
      return true;
    } finally {
      this.checkingEffects = false;
    }
  }
}

/**
 * Additional private evidence only; broad admission/publication stay in the caller.
 * Query methods are provisional recursion helpers. Only withQuery's returned
 * boolean includes the mandatory effect perimeter. A retained query expires.
 */
export function makeLocalNumberReceiverDomain(sourceFiles: readonly ts.SourceFile[], policy: ReceiverPolicy) {
  const facts = new ReceiverFacts(sourceFiles, policy);
  return {
    methodInputCandidates: () => facts.methodInputCandidates(),
    withQuery(proofs: ReceiverProofs, run: (query: ReceiverQuery) => boolean): boolean {
      const query = new ReceiverQuery(facts, proofs);
      try {
        return query.complete(run);
      } finally {
        query.dispose();
      }
    },
  };
}
