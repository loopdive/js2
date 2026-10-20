// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { ts } from "./typescript.js";
export { ts };
export { traceTs5Checker, readTs5CheckerTrace, resetTs5CheckerTrace, type Ts5TraceReport } from "./ts5-trace.js";
import { traceTs5Checker } from "./ts5-trace.js";
import {
  invalidProgramOrigin,
  optionsData,
  originData,
  sourceCurrentness,
  methodCurrentness,
} from "./program-origin-census.js";
import { observeProgramHost } from "./program-origin-host.js";

interface Origin {
  readonly program: ts.Program;
  readonly sources: readonly ts.SourceFile[];
  readonly current: () => void;
}
const programs = new WeakMap<ts.Program, Origin>();
const checkers = new WeakMap<ts.TypeChecker, Origin>();
let libraryEpoch = 0;

/** Cache invalidation can revoke authority; it cannot grant authority to any checker. */
export function invalidateCompilerLibraryOrigins(): void {
  libraryEpoch++;
}
export function compilerLibraryEpoch(): number {
  return libraryEpoch;
}

function issue(program: ts.Program, hostCurrent: () => void, active: () => boolean): Origin {
  // Force genuine TypeScript binding before recording syntax flags.
  const checker = program.getTypeChecker();
  const checkerCurrent = methodCurrentness(checker);
  const programCurrent = methodCurrentness(program);
  const sources = [...program.getSourceFiles()];
  const syntax = sources.map(sourceCurrentness);
  const options = optionsData(program.getCompilerOptions());
  const config = program.getCompilerOptions().configFile;
  const configCurrent =
    config && typeof config === "object" && "kind" in config && config.kind === ts.SyntaxKind.SourceFile
      ? sourceCurrentness(config as ts.SourceFile)
      : undefined;
  if (config && !configCurrent) invalidProgramOrigin("invalid config SourceFile");
  const roots = originData(program.getRootFileNames());
  const epoch = libraryEpoch;
  const origin: Origin = {
    program,
    sources,
    current: () => {
      checkerCurrent();
      programCurrent();
      if (!active() || epoch !== libraryEpoch) invalidProgramOrigin("revoked Program generation or library cache");
      const current = program.getSourceFiles();
      if (current.length !== sources.length || current.some((file, index) => file !== sources[index]))
        invalidProgramOrigin("Program source census changed");
      if (
        originData(program.getRootFileNames()) !== roots ||
        optionsData(program.getCompilerOptions()) !== options ||
        program.getCompilerOptions().configFile !== config
      )
        invalidProgramOrigin("Program options or roots changed");
      hostCurrent();
      configCurrent?.();
      for (const check of syntax) check();
    },
  };
  programs.set(program, origin);
  checkers.set(checker, origin);
  return origin;
}

/** Only the real TS constructor issues authority. There is deliberately no register API. */
export function createOriginProgram(
  roots: readonly string[],
  options: ts.CompilerOptions,
  host = ts.createCompilerHost(options),
): ts.Program {
  const observed = observeProgramHost(host);
  const program = ts.createProgram(roots, options, observed.host);
  // Binding itself may query the host; include those answers in the issued record.
  program.getTypeChecker();
  issue(program, observed.currentness(), () => true);
  return program;
}

/** The known tracing wrapper inherits authority solely from its issued real Program. */
export function originTypeChecker(program: ts.Program, traced = false): ts.TypeChecker {
  const origin = programs.get(program);
  if (!origin) return invalidProgramOrigin("Program was not created at an owned source boundary");
  const checker = program.getTypeChecker();
  if (checkers.get(checker) !== origin) return invalidProgramOrigin("Program checker changed");
  const result = traced ? traceTs5Checker(checker) : checker;
  checkers.set(result, origin);
  return result;
}

/** Own getProgram/dispose without changing the service's diagnostics or incremental algorithms. */
export function createOriginLanguageService(
  host: ts.LanguageServiceHost,
  registry: ts.DocumentRegistry,
): ts.LanguageService {
  const observed = observeProgramHost(host);
  const service = ts.createLanguageService(observed.host, registry);
  let disposed = false;
  let generation = 0;
  let latest: ts.Program | undefined;
  const getProgram = service.getProgram.bind(service);
  const dispose = service.dispose.bind(service);
  service.getProgram = () => {
    if (disposed) return invalidProgramOrigin("disposed language service");
    observed.clear();
    const program = getProgram();
    if (!program) return undefined;
    if (program === latest) return program;
    latest = program;
    const issued = ++generation;
    const version = host.getProjectVersion?.();
    const roots = originData(host.getScriptFileNames());
    const options = optionsData(host.getCompilationSettings());
    program.getTypeChecker();
    // A reused dependency may not be reread by TS during an incremental update.
    // Record every actual Program source, not only the newly requested documents.
    const documents = program.getSourceFiles().map((source) => {
      const snapshot = host.getScriptSnapshot(source.fileName);
      if (!snapshot || snapshot.getText(0, snapshot.getLength()) !== source.text)
        return invalidProgramOrigin(`service snapshot differs from Program: ${source.fileName}`);
      return { name: source.fileName, text: source.text, version: host.getScriptVersion(source.fileName) };
    });
    const hostCurrent = observed.currentness();
    issue(
      program,
      () => {
        hostCurrent();
        for (const document of documents) {
          const snapshot = host.getScriptSnapshot(document.name);
          if (
            !snapshot ||
            host.getScriptVersion(document.name) !== document.version ||
            snapshot.getText(0, snapshot.getLength()) !== document.text
          )
            invalidProgramOrigin(`service document changed: ${document.name}`);
        }
      },
      () =>
        !disposed &&
        generation === issued &&
        host.getProjectVersion?.() === version &&
        originData(host.getScriptFileNames()) === roots &&
        optionsData(host.getCompilationSettings()) === options,
    );
    return program;
  };
  service.dispose = () => {
    disposed = true;
    generation++;
    dispose();
  };
  return service;
}

/** Authenticate a complete selected user population against its real, current checker. */
export function assertCurrentProgramSources(
  checker: ts.TypeChecker,
  sources: readonly ts.SourceFile[],
  entry: ts.SourceFile,
): void {
  const origin = checkers.get(checker);
  if (!origin) invalidProgramOrigin("unknown checker or wrapper");
  origin.current();
  const expected = origin.sources.filter(
    (source) => !source.isDeclarationFile && !origin.program.isSourceFileFromExternalLibrary(source),
  );
  if (
    !sources.includes(entry) ||
    sources.length !== expected.length ||
    new Set(sources).size !== sources.length ||
    sources.some((source) => !expected.includes(source))
  )
    invalidProgramOrigin("selected source population differs from Program");
}
