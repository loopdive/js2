import { parseTest262CompilerPath } from "./test262-compiler-path.mjs";

/** Semantic-provider identity shared by the runner, workers and report tooling. */
export function parseTest262SemanticProviders(raw) {
  if (raw === undefined || raw === "" || raw === "auto") return "auto";
  if (raw === "native-first") return raw;
  throw new Error(`Invalid TEST262_SEMANTIC_PROVIDERS: ${raw}; expected auto or native-first`);
}

export function test262ResultPrefix(
  target = "gc",
  semanticProviders = "auto",
  compilerPath = process.env.TEST262_COMPILER_PATH,
) {
  const provider = parseTest262SemanticProviders(semanticProviders);
  const base = target === "gc" ? "test262" : `test262-${target}`;
  const prefix = provider === "auto" ? base : `${base}-${provider}`;
  return parseTest262CompilerPath(compilerPath) === "ir" ? `${prefix}-ir` : prefix;
}
