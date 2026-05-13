import { join } from "node:path";

export const TEST262_ROOT = join(import.meta.dirname ?? ".", "test262");
export const TEST262_TEST_ROOT = join(TEST262_ROOT, "test");

export function test262Path(...segments: string[]): string {
  return join(TEST262_ROOT, ...segments);
}

export function test262TestPath(...segments: string[]): string {
  return join(TEST262_TEST_ROOT, ...segments);
}
