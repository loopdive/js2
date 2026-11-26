// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7487) The source text the Function constructor parses (§20.2.1.1.1 CreateDynamicFunction), shared by the
 * interpreter and the compile-time fold of a literal `Function(...)`. Import-free: the runtime-eval provider build
 * concatenates the interpreter files and strips their imports (`INTERP_FILES` in scripts/runtime-eval-provider.mjs).
 */

/**
 * `function <name>(<params>\n) {\n<body>\n}`. The newlines are intentional: they keep a trailing line comment in the
 * parameter or body text from swallowing the wrapper delimiter. Parameter and body strings have already undergone
 * ToString and comma-flattening at the call site.
 */
export function functionSourceText(name: string, paramString: string, bodyString: string): string {
  return "function " + name + "(" + paramString + "\n) {\n" + bodyString + "\n}";
}
