// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { TypedAST } from "../checker/index.js";
import type { ts } from "../ts-api.js";
import type { CompileError, CompileOptions } from "../index.js";
import type { CodegenOptions } from "../codegen/context/types.js";
import type { IrProgramPresentationResult } from "./ir-program-presentation.js";
/** Frontend presentation facts only; body generation never consumes this context. */
export interface PipelineOutputContext {
  errors: CompileError[];
  options: CompileOptions;
  entryAst: TypedAST;
  diagnosticAnchor: ts.SourceFile;
  sourcesContent: Map<string, string>;
  readonly codegenOptions: Pick<CodegenOptions, "link">;
  readonly preparedStartup?: Extract<IrProgramPresentationResult, { kind: "prepared-presentation" }>["startup"];
}
