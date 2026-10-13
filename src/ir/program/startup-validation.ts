// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { PreparedIrProgramInvariantError } from "./errors.js";

function invalid(detail: string): never {
  throw new PreparedIrProgramInvariantError("invalid-prepared-data", `startup invocation: ${detail}`);
}
function field(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !("value" in descriptor)) return invalid(`missing own DATA field ${key}`);
  return descriptor.value;
}

/** Shared by the codec shape gate and complete program validator; no source or process authority. */
export function assertPreparedStartupInvocation(plan: object): void {
  const executable = field(plan, "executable");
  const invocation = field(plan, "invocation");
  if (typeof executable !== "boolean") invalid("executable must be boolean");
  if (
    !invocation ||
    typeof invocation !== "object" ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(invocation))
  )
    invalid("expected a plain invocation record");
  const keys = ["target", "kind", "deferTopLevelInit", "exactlyOnce"];
  const actual = Reflect.ownKeys(invocation);
  if (actual.length !== keys.length || actual.some((key) => typeof key !== "string" || !keys.includes(key)))
    invalid("invocation fields differ from the semantic contract");
  const target = field(invocation, "target");
  const kind = field(invocation, "kind");
  const defer = field(invocation, "deferTopLevelInit");
  if (target !== "host" && target !== "standalone" && target !== "wasi") invalid("unknown source target");
  if (typeof defer !== "boolean") invalid("deferTopLevelInit must be boolean");
  if (field(invocation, "exactlyOnce") !== true) invalid("exactlyOnce must be true");
  const expected = !executable
    ? "none"
    : target === "wasi"
      ? "wasi-start-export"
      : defer
        ? "deferred-export"
        : "wasm-start";
  if (kind !== expected) invalid("kind contradicts executable/source target/semantic defer intent");
}
