import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

function approvalDisplayValue(value) {
  return String(value)
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .slice(0, 120);
}

function toolResult(value, isError = false) {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    ...(isError ? { isError: true } : {}),
  };
}

export function createManagedAgentRunStore(execute) {
  const runs = new Map();

  return {
    start(prompt, executionContext = {}) {
      const runId = `run_${randomUUID()}`;
      runs.set(runId, {
        runId,
        status: "working",
        pollAfterMs: 5_000,
      });

      void Promise.resolve().then(async () => {
        try {
          const result = await execute(prompt, executionContext);
          runs.set(runId, {
            runId,
            status: "completed",
            sessionId: result.sessionId,
            result: result.text,
          });
        } catch (error) {
          runs.set(runId, {
            runId,
            status: "failed",
            error: error instanceof Error ? error.message : String(error),
          });
        }
      });

      return runs.get(runId);
    },
    get(runId) {
      return runs.get(runId);
    },
  };
}

export function createManagedAgentsMcpServer(options) {
  if (!options.agentName) {
    throw new Error("managed Agent name is required");
  }
  const runStore =
    options.runStore || createManagedAgentRunStore(options.execute);

  const server = new McpServer(
    {
      name: "claude-managed-agents",
      version: "0.1.0",
    },
    {
      instructions:
        `Use ${options.agentName} to delegate a task to the configured managed Agent.`,
    },
  );

  async function requestApproval({
    serverName,
    toolName,
    argumentKeys,
    approvalIndex,
    approvalCount,
  }) {
    const displayedServer = approvalDisplayValue(serverName);
    const displayedTool = approvalDisplayValue(toolName);
    const displayedKeys = argumentKeys.map(approvalDisplayValue);
    const callPosition =
      approvalCount > 1
        ? `Call ${approvalIndex} of ${approvalCount}. `
        : "";
    const response = await server.server.elicitInput({
      mode: "form",
      message:
        callPosition +
        `Claude Managed Agent wants to call MCP tool '${displayedTool}' ` +
        `on server '${displayedServer}'. Argument keys: ` +
        `${displayedKeys.length > 0 ? displayedKeys.join(", ") : "(none)"}. Allow this call?`,
      requestedSchema: {
        type: "object",
        properties: {
          decision: {
            type: "string",
            title: "Decision",
            description: "Allow or deny this MCP tool call.",
            enum: ["allow", "deny"],
          },
        },
        required: ["decision"],
      },
    });

    return response.action === "accept" &&
      response.content?.decision === "allow"
      ? "allow"
      : "deny";
  }

  server.registerTool(
    options.agentName,
    {
      title: `Call ${options.agentName}`,
      description:
        `Start a task with the ${options.agentName} managed Agent or check a previous run. ` +
        "Call operation='start' with a prompt, then poll operation='status' with the returned runId until completed or failed.",
      inputSchema: {
        operation: z
          .enum(["start", "status"])
          .default("start")
          .describe(
            "Use 'start' to begin a run or 'status' to check an existing run.",
          ),
        prompt: z
          .string()
          .min(1)
          .optional()
          .describe(
            "The task or question to send to the managed agent. Required for start.",
          ),
        runId: z
          .string()
          .min(1)
          .optional()
          .describe("The run ID returned by start. Required for status."),
      },
    },
    async ({ operation, prompt, runId }) => {
      if (operation === "start") {
        if (!prompt) {
          return toolResult(
            { error: "prompt is required for operation 'start'" },
            true,
          );
        }
        return toolResult(
          runStore.start(prompt, {
            requestApproval,
          }),
        );
      }

      if (!runId) {
        return toolResult(
          { error: "runId is required for operation 'status'" },
          true,
        );
      }
      const run = runStore.get(runId);
      return run
        ? toolResult(run)
        : toolResult({ error: `unknown runId '${runId}'` }, true);
    },
  );

  return server;
}

export async function serveManagedAgentsMcpServer(options) {
  const server = createManagedAgentsMcpServer({
    ...options,
    runStore: createManagedAgentRunStore(options.execute),
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return server;
}

function jsonRpcError(status, message) {
  return Response.json(
    {
      jsonrpc: "2.0",
      error: { code: -32000, message },
      id: null,
    },
    { status },
  );
}

export function createManagedAgentsMcpHttpHandler(options) {
  const sessions = new Map();
  const runStore = createManagedAgentRunStore(options.execute);

  return {
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/health" && request.method === "GET") {
        return Response.json({ status: "ok" });
      }
      if (url.pathname !== "/mcp") {
        return new Response("Not found", { status: 404 });
      }

      const sessionId = request.headers.get("mcp-session-id");
      let session = sessionId ? sessions.get(sessionId) : undefined;

      if (request.method === "POST") {
        let body;
        try {
          body = await request.json();
        } catch {
          return jsonRpcError(400, "Request body must be valid JSON");
        }

        if (!session && !sessionId && isInitializeRequest(body)) {
          const transport =
            new WebStandardStreamableHTTPServerTransport({
              sessionIdGenerator: randomUUID,
              enableJsonResponse: true,
              onsessioninitialized: (initializedSessionId) => {
                sessions.set(initializedSessionId, session);
              },
            });
          const server = createManagedAgentsMcpServer({
            ...options,
            runStore,
          });
          session = { server, transport };
          transport.onclose = () => {
            if (transport.sessionId) {
              sessions.delete(transport.sessionId);
            }
          };
          await server.connect(transport);
        }

        if (!session) {
          return jsonRpcError(400, "Invalid or missing MCP session");
        }
        return session.transport.handleRequest(request, {
          parsedBody: body,
        });
      }

      if (!session) {
        return jsonRpcError(400, "Invalid or missing MCP session");
      }
      if (request.method !== "GET" && request.method !== "DELETE") {
        return jsonRpcError(405, "Method not allowed");
      }

      return session.transport.handleRequest(request);
    },
    async close() {
      await Promise.all(
        [...sessions.values()].map(({ server }) => server.close()),
      );
      sessions.clear();
    },
  };
}

export function serveManagedAgentsMcpHttp(options) {
  const hostname = options.hostname || "127.0.0.1";
  const port = options.port ?? 3000;
  const handler = createManagedAgentsMcpHttpHandler(options);
  const httpServer = Bun.serve({
    hostname,
    port,
    fetch: handler.fetch,
  });

  console.error(
    `claude-managed-agents listening at http://${hostname}:${httpServer.port}/mcp`,
  );

  return {
    hostname,
    port: httpServer.port,
    async close() {
      await handler.close();
      httpServer.stop(true);
    },
  };
}
