#!/usr/bin/env node
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_TIMEOUT = "20m";
const DEFAULT_KILL_GRACE = "5s";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, "..");
const vitestCli = resolve(projectRoot, "node_modules/vitest/dist/cli.js");
const vitestArgs = process.argv.slice(2);
const separatorIndex = vitestArgs.indexOf("--");
if (separatorIndex !== -1) {
  vitestArgs.splice(separatorIndex, 1);
}
const timeoutMs = parseDuration(process.env.VITEST_RUN_TIMEOUT_MS ?? DEFAULT_TIMEOUT, "VITEST_RUN_TIMEOUT_MS");
const killGraceMs = parseDuration(process.env.VITEST_KILL_GRACE_MS ?? DEFAULT_KILL_GRACE, "VITEST_KILL_GRACE_MS");

let timedOut = false;
let childExited = false;
let timeoutTimer;
let killTimer;

const child = spawn(process.execPath, [vitestCli, ...(vitestArgs.length > 0 ? vitestArgs : ["run"])], {
  cwd: projectRoot,
  detached: process.platform !== "win32",
  env: process.env,
  stdio: "inherit",
});

function parseDuration(raw, name) {
  const value = String(raw).trim().toLowerCase();
  if (value === "0" || value === "off" || value === "false") return 0;

  const match = value.match(/^(\d+(?:\.\d+)?)(ms|s|m|h)?$/);
  if (!match) {
    console.error(`[run-vitest] Invalid ${name}=${raw}. Use values like 500ms, 30s, 20m, 1h, or 0 to disable.`);
    process.exit(2);
  }

  const amount = Number(match[1]);
  const unit = match[2] ?? "ms";
  const factor = unit === "h" ? 60 * 60 * 1000 : unit === "m" ? 60 * 1000 : unit === "s" ? 1000 : 1;
  return Math.max(0, Math.round(amount * factor));
}

function formatDuration(ms) {
  if (ms % (60 * 60 * 1000) === 0) return `${ms / (60 * 60 * 1000)}h`;
  if (ms % (60 * 1000) === 0) return `${ms / (60 * 1000)}m`;
  if (ms % 1000 === 0) return `${ms / 1000}s`;
  return `${ms}ms`;
}

function signalExitCode(signal) {
  if (signal === "SIGINT") return 130;
  if (signal === "SIGTERM") return 143;
  if (signal === "SIGKILL") return 137;
  return 1;
}

function signalChild(signal) {
  if (!child.pid || childExited) return;
  try {
    process.kill(process.platform === "win32" ? child.pid : -child.pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") {
      console.error(`[run-vitest] Failed to send ${signal} to vitest: ${error?.message ?? error}`);
    }
  }
}

if (timeoutMs > 0) {
  timeoutTimer = setTimeout(() => {
    timedOut = true;
    console.error(
      `[run-vitest] Vitest exceeded global timeout ${formatDuration(timeoutMs)}; sending SIGTERM to the process group.`,
    );
    signalChild("SIGTERM");
    killTimer = setTimeout(() => {
      console.error(`[run-vitest] Vitest did not exit within ${formatDuration(killGraceMs)}; sending SIGKILL.`);
      signalChild("SIGKILL");
    }, killGraceMs);
  }, timeoutMs);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    signalChild(signal);
  });
}

child.on("exit", (code, signal) => {
  childExited = true;
  if (timeoutTimer) clearTimeout(timeoutTimer);
  if (killTimer) clearTimeout(killTimer);

  if (timedOut) {
    process.exit(124);
  }
  if (typeof code === "number") {
    process.exit(code);
  }
  process.exit(signalExitCode(signal));
});
