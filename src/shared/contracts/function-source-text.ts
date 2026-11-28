// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7487) The source text the Function constructor parses (§20.2.1.1.1 CreateDynamicFunction), shared by the
 * interpreter, the compile-time fold of a literal `Function(...)` and the Prepared path's literal function sources.
 * Listed in `INTERP_FILES` (scripts/runtime-eval-provider.mjs), whose build concatenates the interpreter sources and
 * strips their imports: it must stay import-free.
 */

/**
 * `function <name>(<params>\n) {\n<body>\n}`. The newlines are intentional: they keep a trailing line comment in the
 * parameter or body text from swallowing the wrapper delimiter. Parameter and body strings have already undergone
 * ToString and comma-flattening at the call site.
 */
export function functionSourceText(name: string, paramString: string, bodyString: string): string {
  return "function " + name + "(" + paramString + "\n) {\n" + bodyString + "\n}";
}

/** The offset of the `{` that `functionSourceText` writes after the parameters. */
function functionSourceBodyStart(name: string, paramString: string): number {
  return ("function " + name + "(" + paramString + "\n) ").length;
}

/**
 * §20.2.1.1.1 parses the parameters and the body as separate goals before the whole text, so text that only parses
 * once the two run together (`Function("a) { if (1 //", "return 7 }")`, `Function("/*", "*\/){")`,
 * `Function("}; function x(){")`) is a SyntaxError. A parse of the assembled text stands for the two separate parses
 * exactly when it is one declaration whose body opens at the `{` the assembler wrote and closes at the text's end.
 */
export function fitsFunctionSourceText(
  text: string,
  name: string,
  paramString: string,
  statements: number,
  bodyStart: number,
  bodyEnd: number,
): boolean {
  return statements === 1 && bodyStart === functionSourceBodyStart(name, paramString) && bodyEnd === text.length;
}
