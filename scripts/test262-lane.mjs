/** Semantic-provider identity shared by the runner, workers and report tooling. */
export function parseTest262SemanticProviders(raw) {
  if (raw === undefined || raw === "" || raw === "auto") return "auto";
  if (raw === "native-first") return raw;
  throw new Error(`Invalid TEST262_SEMANTIC_PROVIDERS: ${raw}; expected auto or native-first`);
}

export function test262ResultPrefix(target = "gc", semanticProviders = "auto") {
  const provider = parseTest262SemanticProviders(semanticProviders);
  const base = target === "gc" ? "test262" : `test262-${target}`;
  return provider === "auto" ? base : `${base}-${provider}`;
}
