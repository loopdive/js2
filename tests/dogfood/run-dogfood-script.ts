import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Run an opt-in dogfood adapter without blocking Vitest's worker heartbeat.
 *
 * `execFileSync` is tempting for tiny adapters, but the real upstream suites
 * can spend minutes compiling Wasm. Blocking the worker for long enough makes
 * Vitest report a false `onTaskUpdate` timeout even when the child completed
 * successfully. Keep the loader explicit so restricted runners never fall
 * back to tsx's IPC-based `npx` shim.
 */
export async function runDogfoodScript(
  script: string,
  args: readonly string[] = [],
  options: { encoding?: "utf8"; maxBuffer?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<string> {
  const { stdout } = await execFileAsync(process.execPath, ["--import", "tsx", script, ...args], {
    encoding: "utf8",
    maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
    env: options.env,
  });
  return stdout;
}
