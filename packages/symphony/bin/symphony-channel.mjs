#!/usr/bin/env node
import readline from "node:readline";
import {
  appendDispatchMessage,
  readMessagesSince,
  receiptOffsetFile,
  setDispatchClaim,
} from "../lib/dispatch-state.mjs";

// The consuming project's root — this MCP server is launched from there
// (Claude Code sets cwd to the project directory that owns .mcp.json).
const ROOT = process.cwd();
const OFFSET_FILE = receiptOffsetFile(ROOT, "claude-channel");

let nextNotificationId = 1;

function send(message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
}

function respond(id, result) {
  send({ id, result });
}

function error(id, code, message) {
  send({ id, error: { code, message } });
}

function notifyClaude(message) {
  const content = [
    `Symphony dispatch event: ${message.type || "message"}`,
    "",
    message.body || "",
    "",
    "Expected Claude lead action:",
    "- Use native Claude Code Team/TaskList tools for Claude teammates.",
    "- Do not edit generated Claude team/task files directly.",
    "- Reply through the symphony channel tools if an acknowledgement or release is needed.",
  ].join("\n");
  send({
    method: "notifications/claude/channel",
    params: {
      content,
      meta: {
        event_id: String(message.id || `event-${nextNotificationId++}`),
        kind: String(message.type || "message").replace(/[^A-Za-z0-9_]/g, "_"),
        from: String(message.from || "dispatch").replace(/[^A-Za-z0-9_]/g, "_"),
        sprint: String(message.sprint || "").replace(/[^A-Za-z0-9_]/g, "_"),
      },
    },
  });
}

function pump() {
  const messages = readMessagesSince(ROOT, OFFSET_FILE, {
    advance: true,
    filter: (msg) => msg.to === "claude-lead" || msg.to === "all",
  });
  for (const message of messages) notifyClaude(message);
}

function toolList() {
  return {
    tools: [
      {
        name: "reply",
        description: "Send a reply/status message back through the Symphony dispatch channel.",
        inputSchema: {
          type: "object",
          properties: {
            text: { type: "string" },
            to: { type: "string", default: "dispatch" },
          },
          required: ["text"],
        },
      },
      {
        name: "claim_issue",
        description: "Record that Claude lead/Team has accepted ownership for a Symphony issue.",
        inputSchema: {
          type: "object",
          properties: {
            issue: { type: "string" },
            owner: { type: "string", default: "claude-lead" },
            reason: { type: "string" },
          },
          required: ["issue"],
        },
      },
      {
        name: "complete_issue",
        description: "Mark the Symphony channel claim complete after the native Claude workflow has finished it.",
        inputSchema: {
          type: "object",
          properties: {
            issue: { type: "string" },
            reason: { type: "string" },
          },
          required: ["issue"],
        },
      },
      {
        name: "release_issue",
        description: "Release a Symphony channel claim so another lane can take it.",
        inputSchema: {
          type: "object",
          properties: {
            issue: { type: "string" },
            reason: { type: "string" },
          },
          required: ["issue"],
        },
      },
    ],
  };
}

function callTool(name, args) {
  const now = new Date().toISOString();
  if (name === "reply") {
    appendDispatchMessage(ROOT, {
      id: `${Date.now()}-${process.pid}`,
      type: "reply",
      from: "claude-lead",
      to: args.to || "dispatch",
      body: args.text,
      created_at: now,
    });
    return { content: [{ type: "text", text: "sent" }] };
  }
  if (name === "claim_issue") {
    setDispatchClaim(ROOT, args.issue, {
      owner: args.owner || "claude-lead",
      status: "claimed",
      reason: args.reason || "",
      claimed_at: now,
    });
    return { content: [{ type: "text", text: `claimed #${args.issue}` }] };
  }
  if (name === "complete_issue") {
    setDispatchClaim(ROOT, args.issue, {
      status: "completed",
      reason: args.reason || "",
      completed_at: now,
    });
    return { content: [{ type: "text", text: `completed #${args.issue}` }] };
  }
  if (name === "release_issue") {
    setDispatchClaim(ROOT, args.issue, {
      status: "released",
      reason: args.reason || "",
      released_at: now,
    });
    return { content: [{ type: "text", text: `released #${args.issue}` }] };
  }
  throw new Error(`unknown tool: ${name}`);
}

function handle(request) {
  const id = request.id;
  if (request.method === "initialize") {
    respond(id, {
      protocolVersion: request.params?.protocolVersion || "2025-06-18",
      capabilities: {
        experimental: { "claude/channel": {} },
        tools: {},
      },
      serverInfo: { name: "symphony", version: "0.1.0" },
      instructions:
        'Symphony dispatch events arrive as <channel source="symphony" ...>. Treat them as requests to the Claude Code team lead. Use native Claude Code Teams/TaskList tools for Claude teammates. Use this channel server tools to reply, claim, complete, or release Symphony issue claims.',
    });
    setTimeout(pump, 0);
    return;
  }
  if (request.method === "tools/list") {
    respond(id, toolList());
    return;
  }
  if (request.method === "tools/call") {
    try {
      respond(id, callTool(request.params?.name, request.params?.arguments || {}));
    } catch (err) {
      error(id, -32000, err.message);
    }
    return;
  }
  if (id != null) respond(id, {});
}

readline
  .createInterface({ input: process.stdin })
  .on("line", (line) => {
    if (!line.trim()) return;
    try {
      handle(JSON.parse(line));
    } catch (err) {
      error(null, -32700, err.message);
    }
  })
  .on("close", () => process.exit(0));

setInterval(pump, 2000).unref();
