// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { ts } from "../ts-api.js";

/** Script-file extensions recognized by the in-memory multi-source pipeline. */
const KNOWN_SCRIPT_EXTS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"] as const;

/**
 * Exact importer-relative module edges captured by the on-disk project
 * resolver. Keys and targets use the same file names as the virtual file map.
 */
export type ProjectModuleResolutions = Record<string, Record<string, string>>;

export type ProjectModuleResolutionLookup = ReadonlyMap<string, ReadonlyMap<string, string>>;

export function stripMultiFileExtension(name: string): string {
  for (const ext of KNOWN_SCRIPT_EXTS) {
    if (name.endsWith(ext)) return name.slice(0, -ext.length);
  }
  return name;
}

function hasKnownExtension(name: string): boolean {
  return KNOWN_SCRIPT_EXTS.some((ext) => name.endsWith(ext));
}

export function multiFileScriptKind(name: string): ts.ScriptKind {
  if (name.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (name.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (name.endsWith(".js") || name.endsWith(".mjs") || name.endsWith(".cjs")) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

export function multiFileExtension(name: string): ts.Extension {
  if (name.endsWith(".tsx")) return ts.Extension.Tsx;
  if (name.endsWith(".jsx")) return ts.Extension.Jsx;
  if (name.endsWith(".js")) return ts.Extension.Js;
  if (name.endsWith(".mjs")) return ts.Extension.Mjs;
  if (name.endsWith(".cjs")) return ts.Extension.Cjs;
  return ts.Extension.Ts;
}

/**
 * Convert a canonical `file:` module URL into the virtual filesystem spelling
 * used by compileMulti. v8/rusty_v8 module resolvers commonly identify source
 * modules with file URLs while callers provide the corresponding source map
 * under filesystem paths. Those are one module identity, not a bare package
 * named `file:` (#4377).
 */
function multiFilePathFromFileUrl(name: string): string | undefined {
  if (!name.startsWith("file:")) return undefined;
  try {
    const url = new URL(name);
    if (url.protocol !== "file:" || url.search || url.hash) return undefined;
    const host = url.hostname && url.hostname !== "localhost" ? `/${url.hostname}` : "";
    return host + decodeURIComponent(url.pathname);
  } catch {
    return undefined;
  }
}

/**
 * Normalize an in-memory project path to the canonical key used by both the
 * one-shot CompilerHost and the incremental LanguageServiceHost.
 */
export function normalizeMultiFileName(name: string): string {
  let normalized = (multiFilePathFromFileUrl(name) ?? name).replaceAll("\\", "/");
  if (normalized.startsWith("./")) normalized = normalized.slice(2);
  if (normalized.startsWith("/")) normalized = normalized.slice(1);

  const parts = normalized.split("/");
  const resolved: string[] = [];
  for (const part of parts) {
    if (part === "..") {
      resolved.pop();
    } else if (part !== "." && part !== "") {
      resolved.push(part);
    }
  }
  normalized = resolved.join("/");
  return hasKnownExtension(normalized) ? normalized : `${normalized}.ts`;
}

/**
 * Locate a virtual file while accepting extension swaps and directory-index
 * imports, matching the historical compileMulti resolver.
 */
export function probeMultiFileKey(resolved: string, files: ReadonlyMap<string, unknown>): string | undefined {
  if (files.has(resolved)) return resolved;
  if (hasKnownExtension(resolved)) {
    const stem = stripMultiFileExtension(resolved);
    for (const ext of KNOWN_SCRIPT_EXTS) {
      const candidate = stem + ext;
      if (candidate !== resolved && files.has(candidate)) return candidate;
    }
    for (const ext of KNOWN_SCRIPT_EXTS) {
      const candidate = `${stem}/index${ext}`;
      if (files.has(candidate)) return candidate;
    }
  } else {
    for (const ext of KNOWN_SCRIPT_EXTS) {
      const candidate = resolved + ext;
      if (files.has(candidate)) return candidate;
    }
    for (const ext of KNOWN_SCRIPT_EXTS) {
      const candidate = `${resolved}/index${ext}`;
      if (files.has(candidate)) return candidate;
    }
  }
  return undefined;
}

export function buildBareSpecifierLookup(
  files: ReadonlyMap<string, unknown>,
  specifierMap?: Record<string, string>,
): Map<string, string> {
  const lookup = new Map<string, string>();
  for (const normalized of files.keys()) {
    const withoutExt = stripMultiFileExtension(normalized);
    lookup.set(withoutExt, normalized);
    if (!lookup.has(normalized)) lookup.set(normalized, normalized);

    const basename = withoutExt.split("/").pop()!;
    if (basename && !lookup.has(basename)) lookup.set(basename, normalized);
    if (basename === "index") {
      const directory = withoutExt.replace(/\/index$/, "");
      if (directory && !lookup.has(directory)) lookup.set(directory, normalized);
    }
  }

  if (specifierMap) {
    for (const [specifier, fileKey] of Object.entries(specifierMap)) {
      lookup.set(specifier, normalizeMultiFileName(fileKey));
    }
  }
  return lookup;
}

export function buildProjectModuleResolutionLookup(
  projectResolutions?: ProjectModuleResolutions,
): ProjectModuleResolutionLookup {
  const lookup = new Map<string, ReadonlyMap<string, string>>();
  for (const [importer, resolutions] of Object.entries(projectResolutions ?? {})) {
    const targets = new Map<string, string>();
    for (const [specifier, target] of Object.entries(resolutions)) {
      targets.set(specifier, normalizeMultiFileName(target));
    }
    lookup.set(normalizeMultiFileName(importer), targets);
  }
  return lookup;
}

export function resolveMultiFileModule(
  moduleName: string,
  containingFile: string,
  files: ReadonlyMap<string, unknown>,
  bareSpecifierLookup: ReadonlyMap<string, string>,
  projectResolutionLookup?: ProjectModuleResolutionLookup,
): ts.ResolvedModuleFull | undefined {
  const normalizedContainingFile = normalizeMultiFileName(containingFile);
  const exactTarget = projectResolutionLookup?.get(normalizedContainingFile)?.get(moduleName);
  if (exactTarget && files.has(exactTarget)) {
    return {
      resolvedFileName: exactTarget,
      isExternalLibraryImport: false,
      extension: multiFileExtension(exactTarget),
    };
  }

  let resolved: string;
  const fileUrlPath = multiFilePathFromFileUrl(moduleName);
  if (fileUrlPath !== undefined) {
    resolved = normalizeMultiFileName(fileUrlPath);
  } else if (moduleName.startsWith("./") || moduleName.startsWith("../")) {
    const containingDir = normalizedContainingFile.replace(/[^/]*$/, "");
    resolved = normalizeMultiFileName(containingDir + moduleName);
  } else {
    resolved = bareSpecifierLookup.get(moduleName) ?? normalizeMultiFileName(moduleName);
  }

  const key = probeMultiFileKey(resolved, files) ?? resolved;
  if (!files.has(key)) return undefined;
  return {
    resolvedFileName: key,
    isExternalLibraryImport: false,
    extension: multiFileExtension(key),
  };
}
