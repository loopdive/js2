#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { loadWorkflow } from "../lib/workflow.mjs";
import { Orchestrator, writeControlCommand } from "../lib/orchestrator.mjs";
import { expandPath } from "../lib/util.mjs";

// The consuming project's root — Symphony is invoked from there (e.g. via a
// `package.json` script), not from this package's own install location.
const ROOT = process.cwd();

function parseArgs(argv) {
  const args = {
    workflow: path.join(ROOT, "WORKFLOW.md"),
    once: false,
    dryRun: false,
    resumeInProgress: false,
    sprint: null,
    max: null,
    status: false,
    json: false,
    noFetch: false,
    control: null,
    issue: null,
    value: null,
    reason: "",
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") continue;
    if (a === "--workflow") args.workflow = expandPath(argv[++i], ROOT);
    else if (a === "--once") args.once = true;
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--resume-in-progress" || a === "--resume-claimed") args.resumeInProgress = true;
    else if (a === "--sprint") args.sprint = argv[++i];
    else if (a === "--max") args.max = Number(argv[++i]);
    else if (a === "--status") args.status = true;
    else if (a === "--json") args.json = true;
    else if (a === "--no-fetch") args.noFetch = true;
    else if (a === "--control") {
      let j = i + 1;
      while (argv[j] === "--") j++;
      args.control = argv[j];
      i = j;
    } else if (a === "--issue") args.issue = argv[++i];
    else if (a === "--value") args.value = argv[++i];
    else if (a === "--reason") args.reason = argv[++i];
    else if (a === "-h" || a === "--help") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${a}`);
    }
  }
  return args;
}

function printHelp() {
  console.log(`Usage: symphony [options]

Runs the Symphony orchestrator daemon against a WORKFLOW.md contract in the
current directory (or --workflow PATH). Claim/complete/release/message/inbox
commands for the dispatch channel live in the companion "symphony-dispatch"
CLI, not here.

Options:
  --workflow PATH   Workflow contract path (default: ./WORKFLOW.md)
  --once            Run one poll/dispatch cycle and wait for launched workers
  --dry-run         Show dispatch plan without creating worktrees or agents
  --resume-in-progress
                  Treat stale in-progress sprint issues as dispatch candidates
  --sprint N        Override tracker.sprint
  --max N           Override agent.max_concurrent_agents
  --status          Print latest runtime state snapshot
  --control ACTION  Queue daemon action: pause, resume, drain, stop, set-max, cancel, release
  --issue ID        Target issue for a --control cancel/release
  --value VALUE     Value for --control set-max
  --reason TEXT     Optional operator reason for the control log
  --json            Emit machine-readable status/dry-run output
  --no-fetch        Skip git fetch before creating a worktree
`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const workflow = loadWorkflow(options.workflow);
  const loggerRoot = expandPath(workflow.config?.logging?.root ?? ".codex/symphony", ROOT);
  if (options.control) {
    writeControlCommand(workflow, options, ROOT);
    return;
  }
  if (options.status) {
    const stateFile = path.join(loggerRoot, "state.json");
    if (!existsSync(stateFile)) {
      console.error("symphony: no state snapshot found");
      process.exit(1);
    }
    const text = readFileSync(stateFile, "utf8");
    if (options.json) process.stdout.write(text);
    else console.log(text);
    return;
  }
  const orchestrator = new Orchestrator(workflow, options, ROOT);
  orchestrator.validate();
  if (options.once || options.dryRun) {
    await orchestrator.tick();
    if (!options.dryRun) await waitUntilIdle(orchestrator);
    return;
  }
  await orchestrator.tick();
  if (orchestrator.shouldExit) return;
  setInterval(() => {
    orchestrator
      .tick()
      .then(() => {
        if (orchestrator.shouldExit) process.exit(0);
      })
      .catch((err) => orchestrator.logger.event("tick_failed", { error: err.message }));
  }, orchestrator.pollInterval());
}

function waitUntilIdle(orchestrator) {
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      orchestrator.writeState();
      if (orchestrator.running.size === 0 && orchestrator.retryAttempts.size === 0) {
        clearInterval(timer);
        resolve();
      }
    }, 1000);
  });
}

main().catch((err) => {
  console.error(`symphony: ${err.message}`);
  process.exit(1);
});
