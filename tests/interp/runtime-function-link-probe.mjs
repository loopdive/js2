// #2928 E5/E6 — linked runtime Function routing probe.
//
// The provider uses the interpreter's parser-injection boundary with a tiny
// deterministic parser. Acorn owns the production parser artifact; this probe
// isolates the interpreter/compiler ABI and proves that the user module can
// construct and invoke the returned callable through a core-Wasm import.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { compile } from "../../src/index.ts";

const INTERP_FILES = [
  "types.ts",
  "opcodes.ts",
  "encoder.ts",
  "runtime-ops.ts",
  "emitter.ts",
  "loop.ts",
  "dynamic-function.ts",
];

function stripModuleSyntax(source) {
  return source
    .replace(/^import[\s\S]*?;\n/gm, "")
    .replace(/^export \{[^;]+;\n/gm, "")
    .replace(/\bexport (?=(?:type|interface|class|const|function)\b)/g, "");
}

function providerSource() {
  const interpreter = INTERP_FILES.map((name) => stripModuleSyntax(readFileSync(resolve("src/interp", name), "utf8")));
  return [
    ...interpreter,
    `
      function makeEvalAst(): any {
        const left: any = {};
        left.type = "Identifier";
        left.name = "answer";
        const right: any = {};
        right.type = "Literal";
        right.value = 2;
        const binary: any = {};
        binary.type = "BinaryExpression";
        binary.operator = "+";
        binary.left = left;
        binary.right = right;
        const statement: any = {};
        statement.type = "ExpressionStatement";
        statement.expression = binary;
        const ast: any = {};
        ast.type = "Program";
        ast.sourceType = "script";
        ast.body = [statement];
        return ast;
      }

      function makeReverseIdentityEvalAst(): any {
        const callee: any = {};
        callee.type = "Identifier";
        callee.name = "aotIdentity";
        const argument: any = {};
        argument.type = "Identifier";
        argument.name = "globalValue";
        const call: any = {};
        call.type = "CallExpression";
        call.callee = callee;
        call.arguments = [argument];
        call.optional = false;
        const statement: any = {};
        statement.type = "ExpressionStatement";
        statement.expression = call;
        const ast: any = {};
        ast.type = "Program";
        ast.sourceType = "script";
        ast.body = [statement];
        return ast;
      }

      function makeFunctionAst(): any {
        const left: any = {};
        left.type = "Identifier";
        left.name = "a";
        const right: any = {};
        right.type = "Identifier";
        right.name = "b";
        const binary: any = {};
        binary.type = "BinaryExpression";
        binary.operator = "+";
        binary.left = left;
        binary.right = right;
        const ret: any = {};
        ret.type = "ReturnStatement";
        ret.argument = binary;
        const block: any = {};
        block.type = "BlockStatement";
        block.body = [ret];
        const a: any = {};
        a.type = "Identifier";
        a.name = "a";
        const b: any = {};
        b.type = "Identifier";
        b.name = "b";
        const id: any = {};
        id.type = "Identifier";
        id.name = "anonymous";
        const declaration: any = {};
        declaration.type = "FunctionDeclaration";
        declaration.id = id;
        declaration.params = [a, b];
        declaration.body = block;
        const ast: any = {};
        ast.type = "Program";
        ast.sourceType = "script";
        ast.body = [declaration];
        return ast;
      }

      function makeIdentityFunctionAst(): any {
        const value: any = {};
        value.type = "Identifier";
        value.name = "x";
        const ret: any = {};
        ret.type = "ReturnStatement";
        ret.argument = value;
        const block: any = {};
        block.type = "BlockStatement";
        block.body = [ret];
        const param: any = {};
        param.type = "Identifier";
        param.name = "x";
        const id: any = {};
        id.type = "Identifier";
        id.name = "anonymous";
        const declaration: any = {};
        declaration.type = "FunctionDeclaration";
        declaration.id = id;
        declaration.params = [param];
        declaration.body = block;
        const ast: any = {};
        ast.type = "Program";
        ast.sourceType = "script";
        ast.body = [declaration];
        return ast;
      }

      function makeThisFunctionAst(): any {
        const value: any = {};
        value.type = "ThisExpression";
        const ret: any = {};
        ret.type = "ReturnStatement";
        ret.argument = value;
        const block: any = {};
        block.type = "BlockStatement";
        block.body = [ret];
        const id: any = {};
        id.type = "Identifier";
        id.name = "anonymous";
        const declaration: any = {};
        declaration.type = "FunctionDeclaration";
        declaration.id = id;
        declaration.params = [];
        declaration.body = block;
        const ast: any = {};
        ast.type = "Program";
        ast.sourceType = "script";
        ast.body = [declaration];
        return ast;
      }

      function makeStrictThisFunctionAst(): any {
        const directiveValue: any = {};
        directiveValue.type = "Literal";
        directiveValue.value = "use strict";
        const directive: any = {};
        directive.type = "ExpressionStatement";
        directive.expression = directiveValue;
        directive.directive = "use strict";
        const value: any = {};
        value.type = "ThisExpression";
        const ret: any = {};
        ret.type = "ReturnStatement";
        ret.argument = value;
        const block: any = {};
        block.type = "BlockStatement";
        block.body = [directive, ret];
        const id: any = {};
        id.type = "Identifier";
        id.name = "anonymous";
        const declaration: any = {};
        declaration.type = "FunctionDeclaration";
        declaration.id = id;
        declaration.params = [];
        declaration.body = block;
        const ast: any = {};
        ast.type = "Program";
        ast.sourceType = "script";
        ast.body = [declaration];
        return ast;
      }

      function parse(source: string, options: any): any {
        if (options.ecmaVersion !== 2025 || options.sourceType !== "script") {
          throw new TypeError("unexpected parser options");
        }
        if (source === "function anonymous(a,b\\n) {\\nreturn a + b\\n}") {
          return makeFunctionAst();
        }
        if (source === "function anonymous(x\\n) {\\nreturn x\\n}") {
          return makeIdentityFunctionAst();
        }
        if (source === "function anonymous(\\n) {\\nreturn this\\n}") {
          return makeThisFunctionAst();
        }
        if (source === "function anonymous(\\n) {\\n\\"use strict\\"; return this\\n}") {
          return makeStrictThisFunctionAst();
        }
        if (source === "answer + 2") return makeEvalAst();
        if (source === "aotIdentity(globalValue)") {
          return makeReverseIdentityEvalAst();
        }
        throw new SyntaxError("unexpected runtime source");
      }

      function runtimeEvalResult(ok: boolean, value: any): any {
        const result: any[] = [ok, value];
        return result;
      }

      export function __runtime_new_function(
        paramString: any,
        bodyString: any,
        globalObject: any
      ): any {
        try {
          return runtimeEvalResult(
            true,
            createDynamicFunction(
              parse,
              String(paramString),
              String(bodyString),
              globalObject
            )
          );
        } catch (error) {
          return runtimeEvalResult(false, error);
        }
      }

      export function __runtime_indirect_eval(source: any, globalObject: any): any {
        try {
          return runtimeEvalResult(
            true,
            executeIndirectEval(parse, source, globalObject)
          );
        } catch (error) {
          return runtimeEvalResult(false, error);
        }
      }

      export function providerCanary(): number {
        const fn = createDynamicFunction(
          parse,
          "a,b",
          "return a + b",
          globalThis
        );
        return fn(1, 2) as number;
      }
    `,
  ].join("\n");
}

const USER_SOURCE = `
  function dynamic(value: string): string {
    return value;
  }

  function dynamicAny(value: any): any {
    return value;
  }

  export function create(): number {
    const fn: any = new Function(dynamic("a,b"), dynamic("return a + b"));
    return fn === undefined ? 0 : 1;
  }

  export function invokeNew(): number {
    const fn: any = new Function(
      dynamic("a,b"),
      dynamic("return a + b")
    );
    return fn(1, 2) as number;
  }

  export function invokeNewImmediate(): number {
    return new Function(
      dynamic("a"),
      dynamic("b"),
      dynamic("return a + b")
    )(1, 2) as number;
  }

  export function invokeCall(): number {
    const fn: any = Function(
      dynamic("a,b"),
      dynamic("return a + b")
    );
    return fn(2, 3) as number;
  }

  export function invokeCallImmediate(): number {
    return Function(
      dynamic("a"),
      dynamic("b"),
      dynamic("return a + b")
    )(2, 3) as number;
  }

  export function interpretedIdentity(): number {
    const fn: any = new Function(
      dynamic("x"),
      dynamic("return x")
    );
    const value: any = {};
    return fn(value) === value ? 1 : 2;
  }

  export function sloppyThis(): number {
    const fn: any = new Function(dynamic("return this"));
    return fn() === globalThis ? 1 : 2;
  }

  export function strictThis(): number {
    const fn: any = new Function(dynamic('"use strict"; return this'));
    return fn() === undefined ? 1 : 2;
  }

  function aotIdentity(value: any): any {
    return value;
  }

  export function aotIdentityRoundTrip(): number {
    const value: any = {};
    globalThis.globalValue = value;
    globalThis.aotIdentity = aotIdentity;
    const result: any = (0, eval)(dynamic("aotIdentity(globalValue)"));
    return result === value ? 1 : 2;
  }

  export function indirectEval(): number {
    globalThis.answer = 40;
    return (0, eval)(dynamic("answer + 2")) as number;
  }

  export function indirectEvalNonString(): number {
    return (0, eval)(dynamicAny(42)) as number;
  }
`;

function describeDiagnostic(diagnostic) {
  return diagnostic?.messageText ?? diagnostic?.message ?? String(diagnostic);
}

async function main() {
  const runtime = await compile(providerSource(), {
    // Runtime libraries are an internal subcompile and retain the explicit
    // legacy fallback policy used by the existing eval subcompile.
    experimentalIR: false,
    fileName: "runtime-eval-provider.ts",
    skipSemanticDiagnostics: true,
    target: "standalone",
  });
  const user = await compile(USER_SOURCE, {
    fileName: "runtime-eval-user.ts",
    skipSemanticDiagnostics: true,
    target: "standalone",
  });

  const runtimeModule = new WebAssembly.Module(runtime.binary);
  const userModule = new WebAssembly.Module(user.binary);
  const report = {
    runtimeSuccess: runtime.success,
    runtimeErrors: runtime.errors.map(describeDiagnostic),
    runtimeBytes: runtime.binary.length,
    runtimeImports: WebAssembly.Module.imports(runtimeModule),
    userSuccess: user.success,
    userErrors: user.errors.map(describeDiagnostic),
    userImports: WebAssembly.Module.imports(userModule),
    values: {},
    executionErrors: {},
  };

  if (runtime.success && user.success && report.runtimeImports.length === 0) {
    try {
      const runtimeInstance = new WebAssembly.Instance(runtimeModule, {});
      const userInstance = new WebAssembly.Instance(userModule, {
        "js2wasm:runtime-eval": {
          __runtime_new_function: runtimeInstance.exports.__runtime_new_function,
          __runtime_indirect_eval: runtimeInstance.exports.__runtime_indirect_eval,
        },
      });
      for (const [name, fn] of [
        ["provider", runtimeInstance.exports.providerCanary],
        ["create", userInstance.exports.create],
        ["invokeNew", userInstance.exports.invokeNew],
        ["invokeNewImmediate", userInstance.exports.invokeNewImmediate],
        ["invokeCall", userInstance.exports.invokeCall],
        ["invokeCallImmediate", userInstance.exports.invokeCallImmediate],
        ["interpretedIdentity", userInstance.exports.interpretedIdentity],
        ["sloppyThis", userInstance.exports.sloppyThis],
        ["strictThis", userInstance.exports.strictThis],
        ["aotIdentityRoundTrip", userInstance.exports.aotIdentityRoundTrip],
        ["indirectEval", userInstance.exports.indirectEval],
        ["indirectEvalNonString", userInstance.exports.indirectEvalNonString],
      ]) {
        try {
          report.values[name] = fn();
        } catch (error) {
          report.executionErrors[name] = error?.stack ?? error?.message ?? String(error);
        }
      }
    } catch (error) {
      report.executionErrors.instantiate = error?.stack ?? error?.message ?? String(error);
    }
  }

  process.stdout.write(`${JSON.stringify(report)}\n`);
}

main().catch((error) => {
  process.stdout.write(
    `${JSON.stringify({
      runtimeSuccess: false,
      runtimeErrors: [error?.stack ?? error?.message ?? String(error)],
      runtimeBytes: 0,
      runtimeImports: [],
      userSuccess: false,
      userErrors: [],
      userImports: [],
      values: {},
      executionErrors: {},
    })}\n`,
  );
});
