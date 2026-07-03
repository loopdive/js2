#!/usr/bin/env node
import { existsSync } from "node:fs";
import path from "node:path";
import { loadWorkflow, loadMarkdownIssues, latestSprint, TERMINAL_DEFAULT } from "../lib/workflow.mjs";
import { get, asArray, normalizeState, expandPath } from "../lib/util.mjs";
import {
  appendDispatchMessage,
  loadDispatchClaims,
  readAllDispatchMessages,
  readMessagesSince,
  receiptOffsetFile,
  setDispatchClaim,
} from "../lib/dispatch-state.mjs";

// The consuming project's root — run this from the project directory (or
// pass --workflow) so tracker.issues_dir resolves the same way it does for
// the "symphony" daemon.
const ROOT = process.cwd();

function parseArgs(argv) {
  const args = {
    command: "",
    workflow: path.join(ROOT, "WORKFLOW.md"),
    sprint: "latest",
    issue: "",
    owner: "",
    from: "dispatch",
    to: "",
    body: "",
    reason: "",
    limit: 20,
    json: false,
    consume: false,
    format: "text",
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") continue;
    if (!args.command && !a.startsWith("-")) args.command = a;
    else if (a === "--workflow") args.workflow = expandPath(argv[++i], ROOT);
    else if (a === "--sprint") args.sprint = argv[++i];
    else if (a === "--issue") args.issue = argv[++i];
    else if (a === "--owner") args.owner = argv[++i];
    else if (a === "--from") args.from = argv[++i];
    else if (a === "--to") args.to = argv[++i];
    else if (a === "--body") args.body = argv[++i];
    else if (a === "--reason") args.reason = argv[++i];
    else if (a === "--limit") args.limit = Number(argv[++i]);
    else if (a === "--json") args.json = true;
    else if (a === "--consume") args.consume = true;
    else if (a === "--format") args.format = argv[++i];
    else if (a === "-h" || a === "--help") {
      help();
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${a}`);
    }
  }
  return args;
}

function help() {
  console.log(`Usage: symphony-dispatch <command> [options]

Commands:
  queue             Show claimable issues from the tracker (default: plan/issues)
  request-claude    Send a Claude-lead request to fill native Claude TaskList
  claim             Claim an issue for a lead/teammate/channel
  complete          Mark a channel claim complete
  release           Release a channel claim
  message           Append an arbitrary channel message
  inbox             Read messages for a recipient
  status            Show claims and recent messages

Options:
  --workflow PATH   Workflow contract path (default: ./WORKFLOW.md, falls back
                     to tracker.issues_dir=plan/issues if absent)
  --sprint N        Sprint number, or latest (default)
  --limit N         Max queue/message rows (default 20)
  --issue ID        Issue id for claim/complete/release
  --owner NAME      Claim owner, e.g. codex-lead or claude-lead
  --from NAME       Message sender
  --to NAME         Message recipient
  --body TEXT       Message body
  --reason TEXT     Claim/release reason
  --consume         Advance inbox read offset
  --format hook     Render inbox as Claude/Codex prompt context
  --json            Emit JSON
`);
}

function loadTrackerConfig(workflowPath) {
  if (!existsSync(workflowPath)) return {};
  try {
    return loadWorkflow(workflowPath).config;
  } catch {
    return {};
  }
}

function activeClaims(claims) {
  return Object.fromEntries(Object.entries(claims).filter(([, claim]) => claim.status === "claimed"));
}

function claimableIssues(args, config) {
  const issues = loadMarkdownIssues(config, ROOT);
  const claimableStates = new Set(asArray(get(config, "tracker.claimable_states"), ["ready"]).map(normalizeState));
  const terminalStates = new Set(asArray(get(config, "tracker.terminal_states"), TERMINAL_DEFAULT).map(normalizeState));
  const sprint = args.sprint === "latest" ? latestSprint(issues, terminalStates) : String(args.sprint);
  const byId = new Map(issues.map((issue) => [String(issue.id), issue]));
  const claims = activeClaims(loadDispatchClaims(ROOT));
  return issues
    .filter((issue) => String(issue.sprint) === sprint)
    .filter((issue) => claimableStates.has(issue.state))
    .filter((issue) => !claims[issue.id])
    .filter((issue) =>
      issue.blocked_by.every((b) => terminalStates.has(normalizeState(byId.get(String(b.id))?.state || ""))),
    )
    .slice(0, args.limit)
    .map((issue) => ({ ...issue, sprint, relFile: path.relative(ROOT, issue.file) }));
}

function renderQueue(rows, json) {
  if (json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  for (const issue of rows) {
    console.log(`#${issue.id} [${issue.priority_raw ?? "priority?"}] ${issue.title}`);
    console.log(`  ${issue.relFile}`);
  }
}

function renderInbox(messages, args) {
  if (args.json) {
    console.log(JSON.stringify(messages, null, 2));
    return;
  }
  if (messages.length === 0) return;
  if (args.format === "hook") {
    console.log("\n<SymphonyDispatchChannel>");
    console.log("Pending dispatch-channel messages:");
    for (const msg of messages) {
      console.log(`- from=${msg.from} type=${msg.type || "message"} at=${msg.created_at}`);
      console.log(`  ${msg.body.replace(/\n/g, "\n  ")}`);
    }
    console.log("</SymphonyDispatchChannel>\n");
    return;
  }
  for (const msg of messages) console.log(`[${msg.created_at}] ${msg.from} -> ${msg.to}: ${msg.body}`);
}

function commandQueue(args, config) {
  renderQueue(claimableIssues(args, config), args.json);
}

function commandRequestClaude(args, config) {
  const rows = claimableIssues(args, config);
  const sprint = rows[0]?.sprint || args.sprint;
  const body = [
    `Please populate the native Claude Code Team TaskList for sprint ${sprint}.`,
    "",
    "Use native Claude Code team/task tools only. Do not edit generated Claude task files directly.",
    "Create tasks for these ready issues, preserving lowest-ID priority unless you see a conflict:",
    "",
    ...rows.map((issue) => `- #${issue.id}: ${issue.title} (${issue.relFile})`),
  ].join("\n");
  const message = {
    id: `${Date.now()}-${process.pid}`,
    type: "claude_tasklist_request",
    from: args.from || "dispatch",
    to: args.to || "claude-lead",
    sprint,
    issues: rows.map((issue) => issue.id),
    body,
    created_at: new Date().toISOString(),
  };
  appendDispatchMessage(ROOT, message);
  if (args.json) console.log(JSON.stringify(message, null, 2));
  else console.log(`queued Claude lead TaskList request for sprint ${sprint}: ${rows.length} issue(s)`);
}

function commandClaim(args) {
  if (!args.issue) throw new Error("claim requires --issue");
  if (!args.owner) throw new Error("claim requires --owner");
  const existing = loadDispatchClaims(ROOT)[args.issue];
  if (existing?.status === "claimed" && existing.owner !== args.owner) {
    throw new Error(`#${args.issue} already claimed by ${existing.owner}`);
  }
  setDispatchClaim(ROOT, args.issue, {
    owner: args.owner,
    status: "claimed",
    reason: args.reason || "",
    claimed_at: new Date().toISOString(),
  });
  console.log(`claimed #${args.issue} for ${args.owner}`);
}

function commandComplete(args) {
  if (!args.issue) throw new Error("complete requires --issue");
  setDispatchClaim(ROOT, args.issue, {
    status: "completed",
    completed_at: new Date().toISOString(),
    reason: args.reason || "",
  });
  console.log(`completed channel claim for #${args.issue}`);
}

function commandRelease(args) {
  if (!args.issue) throw new Error("release requires --issue");
  setDispatchClaim(ROOT, args.issue, {
    status: "released",
    released_at: new Date().toISOString(),
    reason: args.reason || "",
  });
  console.log(`released channel claim for #${args.issue}`);
}

function commandMessage(args) {
  if (!args.to) throw new Error("message requires --to");
  if (!args.body) throw new Error("message requires --body");
  const message = {
    id: `${Date.now()}-${process.pid}`,
    type: "message",
    from: args.from || "dispatch",
    to: args.to,
    body: args.body,
    created_at: new Date().toISOString(),
  };
  appendDispatchMessage(ROOT, message);
  console.log(`queued message to ${message.to}`);
}

function readInbox(args) {
  const to = args.to || "claude-lead";
  const offsetFile = receiptOffsetFile(ROOT, to);
  const messages = readMessagesSince(ROOT, offsetFile, {
    advance: args.consume,
    filter: (msg) => msg.to === to || msg.to === "all",
  });
  return messages.slice(-args.limit);
}

function commandStatus(args) {
  const payload = {
    claims: loadDispatchClaims(ROOT),
    recent_messages: readAllDispatchMessages(ROOT).slice(-args.limit),
  };
  console.log(JSON.stringify(payload, null, 2));
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = loadTrackerConfig(args.workflow);
  switch (args.command) {
    case "queue":
    case "":
      commandQueue(args, config);
      break;
    case "request-claude":
      commandRequestClaude(args, config);
      break;
    case "claim":
      commandClaim(args);
      break;
    case "complete":
      commandComplete(args);
      break;
    case "release":
      commandRelease(args);
      break;
    case "message":
      commandMessage(args);
      break;
    case "inbox":
      renderInbox(readInbox(args), args);
      break;
    case "status":
      commandStatus(args);
      break;
    default:
      throw new Error(`unknown command: ${args.command}`);
  }
}

main();
