import { parseTest262CompilerPath } from "./test262-compiler-path.mjs";

/**
 * Semantic-provider identity shared by the runner, workers and report tooling.
 *
 * (#6708 S6) Two lane identities remain:
 * - `"auto"` — the DEFAULT policy, which is native-first in every environment
 *   since S6 (on `gc` that is the native regime in the JS environment). The
 *   spellings `""`, `"auto"` and `"native-first"` all name it: they compile
 *   identically, so they share one identity and one result prefix.
 * - `"host-assisted"` — the explicit control spelling for the retired pre-S6
 *   JS-host profile. Measurement only, never promoted.
 */
export function parseTest262SemanticProviders(raw) {
  if (raw === undefined || raw === "" || raw === "auto" || raw === "native-first") return "auto";
  if (raw === "host-assisted") return raw;
  throw new Error(`Invalid TEST262_SEMANTIC_PROVIDERS: ${raw}; expected native-first, host-assisted or auto`);
}

/**
 * The `semanticProviders` compile option for a lane identity. The default lane
 * passes nothing (so the compiler's own default applies and no deprecated
 * `"auto"` spelling reaches it); the control lane spells `"host-assisted"`.
 */
export function test262CompileSemanticProviders(semanticProviders) {
  return parseTest262SemanticProviders(semanticProviders) === "host-assisted" ? "host-assisted" : undefined;
}

/** Does a lane lower with the native semantic regime? (`gc` default lane or standalone.) */
export function test262LaneUsesNativeRegime(target, semanticProviders) {
  if (target === "standalone") return true;
  return (target === undefined || target === "gc") && parseTest262SemanticProviders(semanticProviders) === "auto";
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
