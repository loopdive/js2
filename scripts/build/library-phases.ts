import { fork } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createFilter, normalizePath, type InlineConfig, type Plugin, type ResolvedConfig } from "vite";

interface ChildRequest {
  inline: InlineConfig;
  root: string;
  mode: string;
  configFile: string;
}
interface ChildResult {
  kind: "library-declarations-result";
  ok: boolean;
  watchFiles: string[];
}
type DeclarationFailure = Error & { watchFiles?: string[] };

// Do not silently discard programmatic functions, regexes, plugins or cycles.
// Normal Vite CLI options are plain data; original config functions are recreated
// by the exact named factory in the child rather than serialized/reimplemented.
function copyPlain(value: unknown, seen = new Set<object>()): unknown {
  if (value === undefined || value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "object") throw new Error("Unsupported non-data inline Vite option");
  if (seen.has(value)) throw new Error("Cyclic inline Vite option");
  if (
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  ) {
    throw new Error("Unsupported non-plain inline Vite option");
  }
  seen.add(value);
  let result: unknown;
  if (Array.isArray(value)) {
    result = value.map((item) => {
      if (item === undefined) throw new Error("Undefined inline array element");
      return copyPlain(item, seen);
    });
  } else {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (item !== undefined) output[key] = copyPlain(item, seen);
    }
    result = output;
  }
  seen.delete(value);
  return result;
}

function isResult(value: unknown): value is ChildResult {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<ChildResult>;
  return (
    row.kind === "library-declarations-result" &&
    typeof row.ok === "boolean" &&
    Array.isArray(row.watchFiles) &&
    row.watchFiles.every((path) => typeof path === "string")
  );
}

function runChild(request: ChildRequest): Promise<string[]> {
  const script = fileURLToPath(new URL("./declarations.mjs", import.meta.url));
  return new Promise((resolve, reject) => {
    const child = fork(script, [], {
      execPath: process.execPath,
      execArgv: process.execArgv,
      cwd: process.cwd(),
      env: process.env,
      stdio: ["inherit", "inherit", "inherit", "ipc"],
      serialization: "json",
    });
    let result: ChildResult | undefined;
    let failure: Error | undefined;
    child.on("message", (message: unknown) => {
      if (result || !isResult(message)) failure = new Error("Invalid declaration child result");
      else result = message;
    });
    child.once("error", (error) => {
      failure = error;
    });
    child.once("close", (status, signal) => {
      if (!failure && status === 0 && !signal && result?.ok) resolve(result.watchFiles);
      else {
        const error: DeclarationFailure = failure ?? new Error(`Library declarations failed: ${signal ?? status}`);
        error.watchFiles = result?.watchFiles ?? [];
        reject(error);
      }
    });
    child.send(request, (error) => {
      if (error) failure = error;
    });
  });
}

export function separateLibraryDeclarations(sources: { include: string[]; exclude: string[] }): Plugin {
  let request: ChildRequest | undefined;
  let current: Promise<string[]> | undefined;
  let watchRoot: string | undefined;
  return {
    name: "library-declarations-separate-process",
    apply: "build",
    applyToEnvironment(environment) {
      return !environment.getTopLevelConfig().isWorker;
    },
    configResolved(config: ResolvedConfig) {
      if (config.isWorker) return;
      watchRoot = config.build.watch ? config.root : undefined;
      const inline = copyPlain(config.inlineConfig) as InlineConfig;
      if (inline.plugins !== undefined) {
        throw new Error("Inline plugins require an explicit cross-process declaration contract");
      }
      request = {
        inline,
        root: config.root,
        mode: config.mode,
        configFile: fileURLToPath(new URL("../../vite.config.declarations.ts", import.meta.url)),
      };
    },
    async buildStart() {
      current = undefined;
      if (!watchRoot) return;
      const root = watchRoot;
      const { default: ts } = await import("typescript");
      const configFile = ts.findConfigFile(root, ts.sys.fileExists);
      if (!configFile) return;
      let parsedFiles: string[];
      try {
        parsedFiles =
          ts.getParsedCommandLineOfConfigFile(configFile, undefined, {
            ...ts.sys,
            onUnRecoverableConfigFileDiagnostic: () => undefined,
          })?.fileNames ?? [];
      } catch {
        // Match the original Vue config parser's empty-root fallback. The
        // authentic declaration child retains its existing diagnostics policy.
        parsedFiles = [];
      }
      const filter = createFilter(
        sources.include.map((pattern) => normalizePath(resolve(root, pattern))),
        sources.exclude.map((pattern) => normalizePath(resolve(root, pattern))),
      );
      // Register the original TS roots before the first watch refresh. The
      // authentic child still owns program diagnostics and the full watch set.
      for (const file of parsedFiles) {
        const normalized = normalizePath(file);
        if (filter(normalized)) this.addWatchFile(normalized);
      }
    },
    writeBundle: {
      sequential: true,
      async handler() {
        if (!request) throw new Error("Missing resolved declaration build context");
        // Parent Vite already performed its original cleanup and wrote real JS.
        // One child per build, including watch rebuilds and multi-output writes.
        current ??= runChild(request);
        try {
          for (const file of await current) this.addWatchFile(file);
        } catch (error) {
          for (const file of (error as DeclarationFailure).watchFiles ?? []) this.addWatchFile(file);
          throw error;
        }
      },
    },
  };
}
