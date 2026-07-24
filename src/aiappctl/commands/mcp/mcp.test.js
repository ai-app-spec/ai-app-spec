import { afterEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { fileURLToPath } from "node:url";
import { parseMcpArguments } from "./index.js";
import { executeClaudeManagedAgent } from "./runtimes/claude.js";
import {
  createManagedAgentsMcpHttpHandler,
  createManagedAgentsMcpServer,
} from "./server.js";
import approvalEvents from "../../test/fixtures/claude-mcp-requires-action-events.json";

const originalFetch = globalThis.fetch;
const cliPath = fileURLToPath(new URL("../../cli.js", import.meta.url));
const productManagerPackagePath = fileURLToPath(
  new URL("../../../../examples/product-manager-claude", import.meta.url),
);

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function readToolJson(result) {
  const text = result.content[0].text;
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`expected JSON tool result, received: ${text}`, {
      cause: error,
    });
  }
}

async function waitForRun(client, runId) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await client.callTool({
      name: "product-manager",
      arguments: { operation: "status", runId },
    });
    const run = readToolJson(result);
    if (run.status !== "working") {
      return run;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`run '${runId}' did not finish during the test`);
}

describe("Claude Managed Agent MCP runtime", () => {
  test("parses the local MCP server arguments", () => {
    expect(
      parseMcpArguments([
        "serve",
        "--runtime",
        "claude",
        "--package",
        "package_test",
        "--agent-id=agent_test",
        "--environment-id",
        "env_test",
        "--vault-id",
        "vlt_test",
      ]),
    ).toEqual({
      runtime: "claude",
      transport: "stdio",
      inputPath: "package_test",
      agentId: "agent_test",
      environmentId: "env_test",
      vaultId: "vlt_test",
    });
  });

  test("parses the HTTP transport and port", () => {
    expect(
      parseMcpArguments([
        "serve",
        "--runtime",
        "claude",
        "--transport",
        "http",
        "--port",
        "3100",
        "--package",
        "package_test",
        "--agent-id",
        "agent_test",
        "--environment-id",
        "env_test",
      ]),
    ).toEqual({
      runtime: "claude",
      transport: "http",
      port: 3100,
      inputPath: "package_test",
      agentId: "agent_test",
      environmentId: "env_test",
      vaultId: undefined,
    });
  });

  test("requires the Claude session bindings", () => {
    expect(parseMcpArguments(["serve"])).toEqual({
      error: "--runtime is required",
    });
    expect(
      parseMcpArguments(["serve", "--runtime", "claude"]),
    ).toEqual({
      error: "--package is required",
    });
    expect(
      parseMcpArguments([
        "serve",
        "--runtime",
        "claude",
        "--package",
        "package_test",
      ]),
    ).toEqual({
      error: "--agent-id is required",
    });
    expect(
      parseMcpArguments([
        "serve",
        "--runtime",
        "claude",
        "--package",
        "package_test",
        "--agent-id",
        "agent_test",
      ]),
    ).toEqual({
      error: "--environment-id is required",
    });
  });

  test("creates a session and returns its final text response", async () => {
    const requests = [];
    let sessionPolls = 0;

    globalThis.fetch = async (url, init = {}) => {
      requests.push({
        url: url.toString(),
        method: init.method || "GET",
        headers: Object.fromEntries(new Headers(init.headers)),
        body: init.body ? JSON.parse(init.body) : undefined,
      });

      const endpoint = new URL(url);
      if (
        endpoint.pathname === "/v1/sessions" &&
        init.method === "POST"
      ) {
        return Response.json({
          id: "sesn_test",
          status: "running",
        });
      }
      if (endpoint.pathname === "/v1/sessions/sesn_test") {
        sessionPolls += 1;
        return Response.json({
          id: "sesn_test",
          status: sessionPolls === 1 ? "running" : "idle",
        });
      }
      if (
        endpoint.pathname === "/v1/sessions/sesn_test/events"
      ) {
        return Response.json({
          data: [
            {
              id: "event_user",
              type: "user.message",
              content: [{ type: "text", text: "Say hello." }],
            },
            {
              id: "event_agent",
              type: "agent.message",
              content: [{ type: "text", text: "Hello, world!" }],
            },
            {
              id: "event_idle",
              type: "session.status_idle",
              stop_reason: { type: "end_turn" },
            },
          ],
          next_page: null,
        });
      }

      return Response.json(
        { error: { message: "unexpected request" } },
        { status: 404 },
      );
    };

    const result = await executeClaudeManagedAgent("Say hello.", {
      apiKey: "test-api-key",
      baseUrl: "https://api.anthropic.test",
      agentId: "agent_test",
      environmentId: "env_test",
      vaultId: "vlt_test",
      pollIntervalMs: 0,
      timeoutMs: 1_000,
    });

    expect(result).toEqual({
      sessionId: "sesn_test",
      text: "Hello, world!",
    });
    expect(requests.map(({ method, url }) => [method, url])).toEqual([
      ["POST", "https://api.anthropic.test/v1/sessions"],
      ["GET", "https://api.anthropic.test/v1/sessions/sesn_test"],
      ["GET", "https://api.anthropic.test/v1/sessions/sesn_test"],
      [
        "GET",
        "https://api.anthropic.test/v1/sessions/sesn_test/events?limit=100&order=asc",
      ],
    ]);
    expect(requests[0].headers["x-api-key"]).toBe("test-api-key");
    expect(requests[0].headers["anthropic-version"]).toBe(
      "2023-06-01",
    );
    expect(requests[0].headers["anthropic-beta"]).toBe(
      "managed-agents-2026-04-01",
    );
    expect(requests[0].body).toEqual({
      agent: "agent_test",
      environment_id: "env_test",
      initial_events: [
        {
          type: "user.message",
          content: [{ type: "text", text: "Say hello." }],
        },
      ],
      vault_ids: ["vlt_test"],
    });
  });

  test("asks for approval, allows the tool, and resumes the session", async () => {
    const confirmations = [];
    const approvalRequests = [];
    let confirmed = false;

    globalThis.fetch = async (url, init = {}) => {
      const endpoint = new URL(url);
      if (
        endpoint.pathname === "/v1/sessions" &&
        init.method === "POST"
      ) {
        return Response.json({ id: "sesn_test", status: "idle" });
      }
      if (
        endpoint.pathname === "/v1/sessions/sesn_test/events" &&
        init.method === "POST"
      ) {
        confirmations.push(...JSON.parse(init.body).events);
        confirmed = true;
        return Response.json({ data: confirmations });
      }
      if (endpoint.pathname === "/v1/sessions/sesn_test") {
        return Response.json({ id: "sesn_test", status: "idle" });
      }
      if (endpoint.pathname === "/v1/sessions/sesn_test/events") {
        if (!confirmed) {
          return Response.json({
            ...approvalEvents,
            data: approvalEvents.data.map((event) =>
              event.type === "agent.mcp_tool_use"
                ? {
                    ...event,
                    input: {
                      teamId: "team_test",
                      includeArchived: false,
                    },
                  }
                : event,
            ),
          });
        }
        return Response.json({
          data: [
            {
              id: "event_agent",
              type: "agent.message",
              content: [{ type: "text", text: "The tool ran." }],
            },
            {
              id: "event_final_idle",
              type: "session.status_idle",
              stop_reason: { type: "end_turn" },
            },
          ],
          next_page: null,
        });
      }
      return Response.json({ error: { message: "unexpected request" } }, {
        status: 404,
      });
    };

    const result = await executeClaudeManagedAgent("Use a tool.", {
      apiKey: "test-api-key",
      baseUrl: "https://api.anthropic.test",
      agentId: "agent_test",
      environmentId: "env_test",
      pollIntervalMs: 0,
      requestApproval: async (request) => {
        approvalRequests.push(request);
        return "allow";
      },
    });

    expect(result).toEqual({
      sessionId: "sesn_test",
      text: "The tool ran.",
    });
    expect(approvalRequests).toEqual([
      {
        serverName: "linear",
        toolName: "list_teams",
        argumentKeys: ["teamId", "includeArchived"],
        approvalIndex: 1,
        approvalCount: 1,
      },
    ]);
    expect(confirmations).toEqual([
      {
        type: "user.tool_confirmation",
        tool_use_id: "event_tool",
        result: "allow",
      },
    ]);
  });

  test("denies a tool and returns the Agent's final response", async () => {
    const confirmations = [];
    let confirmed = false;

    globalThis.fetch = async (url, init = {}) => {
      const endpoint = new URL(url);
      if (
        endpoint.pathname === "/v1/sessions" &&
        init.method === "POST"
      ) {
        return Response.json({ id: "sesn_test", status: "idle" });
      }
      if (
        endpoint.pathname === "/v1/sessions/sesn_test/events" &&
        init.method === "POST"
      ) {
        confirmations.push(...JSON.parse(init.body).events);
        confirmed = true;
        return Response.json({ data: confirmations });
      }
      if (endpoint.pathname === "/v1/sessions/sesn_test") {
        return Response.json({ id: "sesn_test", status: "idle" });
      }
      if (endpoint.pathname === "/v1/sessions/sesn_test/events") {
        return confirmed
          ? Response.json({
              data: [
                {
                  id: "event_agent",
                  type: "agent.message",
                  content: [
                    {
                      type: "text",
                      text: "I continued without the tool.",
                    },
                  ],
                },
                {
                  id: "event_final_idle",
                  type: "session.status_idle",
                  stop_reason: { type: "end_turn" },
                },
              ],
              next_page: null,
            })
          : Response.json(approvalEvents);
      }
      return Response.json({ error: { message: "unexpected request" } }, {
        status: 404,
      });
    };

    const result = await executeClaudeManagedAgent("Use a tool.", {
      apiKey: "test-api-key",
      baseUrl: "https://api.anthropic.test",
      agentId: "agent_test",
      environmentId: "env_test",
      pollIntervalMs: 0,
      requestApproval: async () => "deny",
    });

    expect(result.text).toBe("I continued without the tool.");
    expect(confirmations).toEqual([
      {
        type: "user.tool_confirmation",
        tool_use_id: "event_tool",
        result: "deny",
        deny_message: "The user denied this tool call.",
      },
    ]);
  });

  test("supports sequential approval pauses", async () => {
    const decisions = ["allow", "deny"];
    const confirmations = [];
    let completedApprovals = 0;

    globalThis.fetch = async (url, init = {}) => {
      const endpoint = new URL(url);
      if (
        endpoint.pathname === "/v1/sessions" &&
        init.method === "POST"
      ) {
        return Response.json({ id: "sesn_test", status: "idle" });
      }
      if (
        endpoint.pathname === "/v1/sessions/sesn_test/events" &&
        init.method === "POST"
      ) {
        confirmations.push(...JSON.parse(init.body).events);
        completedApprovals += 1;
        return Response.json({ data: confirmations });
      }
      if (endpoint.pathname === "/v1/sessions/sesn_test") {
        return Response.json({ id: "sesn_test", status: "idle" });
      }
      if (endpoint.pathname === "/v1/sessions/sesn_test/events") {
        if (completedApprovals < 2) {
          const eventId = `event_tool_${completedApprovals + 1}`;
          return Response.json({
            data: [
              {
                id: eventId,
                type: "agent.mcp_tool_use",
                mcp_server_name: "linear",
                name:
                  completedApprovals === 0
                    ? "list_teams"
                    : "list_issues",
                input: {},
              },
              {
                id: `event_idle_${completedApprovals + 1}`,
                type: "session.status_idle",
                stop_reason: {
                  type: "requires_action",
                  event_ids: [eventId],
                },
              },
            ],
            next_page: null,
          });
        }
        return Response.json({
          data: [
            {
              id: "event_agent",
              type: "agent.message",
              content: [{ type: "text", text: "Finished." }],
            },
            {
              id: "event_final_idle",
              type: "session.status_idle",
              stop_reason: { type: "end_turn" },
            },
          ],
          next_page: null,
        });
      }
      return Response.json({ error: { message: "unexpected request" } }, {
        status: 404,
      });
    };

    const result = await executeClaudeManagedAgent("Use two tools.", {
      apiKey: "test-api-key",
      baseUrl: "https://api.anthropic.test",
      agentId: "agent_test",
      environmentId: "env_test",
      pollIntervalMs: 0,
      requestApproval: async () => decisions.shift(),
    });

    expect(result.text).toBe("Finished.");
    expect(confirmations.map(({ tool_use_id, result }) => ({
      tool_use_id,
      result,
    }))).toEqual([
      { tool_use_id: "event_tool_1", result: "allow" },
      { tool_use_id: "event_tool_2", result: "deny" },
    ]);
  });

  test("collects decisions for simultaneous calls and resumes once", async () => {
    const confirmations = [];
    const approvalRequests = [];
    const decisions = ["allow", "deny"];
    let confirmed = false;

    globalThis.fetch = async (url, init = {}) => {
      const endpoint = new URL(url);
      if (
        endpoint.pathname === "/v1/sessions" &&
        init.method === "POST"
      ) {
        return Response.json({ id: "sesn_test", status: "idle" });
      }
      if (
        endpoint.pathname === "/v1/sessions/sesn_test/events" &&
        init.method === "POST"
      ) {
        confirmations.push(...JSON.parse(init.body).events);
        confirmed = true;
        return Response.json({ data: confirmations });
      }
      if (endpoint.pathname === "/v1/sessions/sesn_test") {
        return Response.json({ id: "sesn_test", status: "idle" });
      }
      if (endpoint.pathname === "/v1/sessions/sesn_test/events") {
        return confirmed
          ? Response.json({
              data: [
                {
                  id: "event_agent",
                  type: "agent.message",
                  content: [{ type: "text", text: "Finished." }],
                },
                {
                  id: "event_final_idle",
                  type: "session.status_idle",
                  stop_reason: { type: "end_turn" },
                },
              ],
              next_page: null,
            })
          : Response.json({
              data: [
                {
                  id: "event_tool_1",
                  type: "agent.mcp_tool_use",
                  mcp_server_name: "linear",
                  name: "list_teams",
                  input: {},
                },
                {
                  id: "event_tool_2",
                  type: "agent.mcp_tool_use",
                  mcp_server_name: "linear",
                  name: "list_issues",
                  input: { team: "EPD" },
                },
                {
                  id: "event_idle",
                  type: "session.status_idle",
                  stop_reason: {
                    type: "requires_action",
                    event_ids: ["event_tool_1", "event_tool_2"],
                  },
                },
              ],
              next_page: null,
            });
      }
      return Response.json(
        { error: { message: "unexpected request" } },
        { status: 404 },
      );
    };

    const result = await executeClaudeManagedAgent("Use two tools.", {
      apiKey: "test-api-key",
      baseUrl: "https://api.anthropic.test",
      agentId: "agent_test",
      environmentId: "env_test",
      pollIntervalMs: 0,
      requestApproval: async (request) => {
        approvalRequests.push(request);
        return decisions.shift();
      },
    });

    expect(result.text).toBe("Finished.");
    expect(approvalRequests).toEqual([
      {
        serverName: "linear",
        toolName: "list_teams",
        argumentKeys: [],
        approvalIndex: 1,
        approvalCount: 2,
      },
      {
        serverName: "linear",
        toolName: "list_issues",
        argumentKeys: ["team"],
        approvalIndex: 2,
        approvalCount: 2,
      },
    ]);
    expect(confirmations).toEqual([
      {
        type: "user.tool_confirmation",
        tool_use_id: "event_tool_1",
        result: "allow",
      },
      {
        type: "user.tool_confirmation",
        tool_use_id: "event_tool_2",
        result: "deny",
        deny_message: "The user denied this tool call.",
      },
    ]);
  });

  test("denies every pending call if one batch approval fails", async () => {
    const confirmations = [];
    let approvalCount = 0;

    globalThis.fetch = async (url, init = {}) => {
      const endpoint = new URL(url);
      if (
        endpoint.pathname === "/v1/sessions" &&
        init.method === "POST"
      ) {
        return Response.json({ id: "sesn_test", status: "idle" });
      }
      if (
        endpoint.pathname === "/v1/sessions/sesn_test/events" &&
        init.method === "POST"
      ) {
        confirmations.push(...JSON.parse(init.body).events);
        return Response.json({ data: confirmations });
      }
      return Response.json({
        data: [
          {
            id: "event_tool_1",
            type: "agent.mcp_tool_use",
            mcp_server_name: "linear",
            name: "list_teams",
            input: {},
          },
          {
            id: "event_tool_2",
            type: "agent.mcp_tool_use",
            mcp_server_name: "linear",
            name: "list_issues",
            input: {},
          },
          {
            id: "event_idle",
            type: "session.status_idle",
            stop_reason: {
              type: "requires_action",
              event_ids: ["event_tool_1", "event_tool_2"],
            },
          },
        ],
        next_page: null,
      });
    };

    await expect(
      executeClaudeManagedAgent("Use two tools.", {
        apiKey: "test-api-key",
        baseUrl: "https://api.anthropic.test",
        agentId: "agent_test",
        environmentId: "env_test",
        pollIntervalMs: 0,
        requestApproval: async () => {
          approvalCount += 1;
          if (approvalCount === 2) {
            throw new Error("approval client disconnected");
          }
          return "allow";
        },
      }),
    ).rejects.toThrow(
      "Could not request approval for Claude Managed Agent tool 'linear/list_issues'",
    );
    expect(confirmations).toHaveLength(2);
    expect(confirmations.every(({ result }) => result === "deny")).toBe(
      true,
    );
  });

  test("denies the tool when requesting human approval fails", async () => {
    const confirmations = [];

    globalThis.fetch = async (url, init = {}) => {
      const endpoint = new URL(url);
      if (
        endpoint.pathname === "/v1/sessions" &&
        init.method === "POST"
      ) {
        return Response.json({ id: "sesn_test", status: "idle" });
      }
      if (
        endpoint.pathname === "/v1/sessions/sesn_test/events" &&
        init.method === "POST"
      ) {
        confirmations.push(...JSON.parse(init.body).events);
        return Response.json({ data: confirmations });
      }
      return Response.json(approvalEvents);
    };

    await expect(
      executeClaudeManagedAgent("Use a tool.", {
        apiKey: "test-api-key",
        baseUrl: "https://api.anthropic.test",
        agentId: "agent_test",
        environmentId: "env_test",
        pollIntervalMs: 0,
        requestApproval: async () => {
          throw new Error("approval client disconnected");
        },
      }),
    ).rejects.toThrow(
      "Could not request approval for Claude Managed Agent tool 'linear/list_teams'",
    );
    expect(confirmations).toEqual([
      {
        type: "user.tool_confirmation",
        tool_use_id: "event_tool",
        result: "deny",
        deny_message: "The user denied this tool call.",
      },
    ]);
  });

  test("denies a referenced unsupported tool event", async () => {
    const confirmations = [];

    globalThis.fetch = async (url, init = {}) => {
      const endpoint = new URL(url);
      if (
        endpoint.pathname === "/v1/sessions" &&
        init.method === "POST"
      ) {
        return Response.json({ id: "sesn_test", status: "idle" });
      }
      if (
        endpoint.pathname === "/v1/sessions/sesn_test/events" &&
        init.method === "POST"
      ) {
        confirmations.push(...JSON.parse(init.body).events);
        return Response.json({ data: confirmations });
      }
      return Response.json({
        data: [
          {
            id: "event_tool",
            type: "agent.tool_use",
            name: "unsupported_builtin",
            input: {},
          },
          approvalEvents.data.find(
            (event) => event.type === "session.status_idle",
          ),
        ],
        next_page: null,
      });
    };

    await expect(
      executeClaudeManagedAgent("Use a tool.", {
        apiKey: "test-api-key",
        baseUrl: "https://api.anthropic.test",
        agentId: "agent_test",
        environmentId: "env_test",
        pollIntervalMs: 0,
        requestApproval: async () => "allow",
      }),
    ).rejects.toThrow("unsupported or malformed tool approval");
    expect(confirmations).toHaveLength(1);
    expect(confirmations[0].result).toBe("deny");
  });
});

describe("managed Agent MCP server", () => {
  test("uses the shared server name and exposes the Agent entrypoint", async () => {
    const prompts = [];
    const executionContexts = [];
    const server = createManagedAgentsMcpServer({
      agentName: "product-manager",
      execute: async (prompt, executionContext) => {
        prompts.push(prompt);
        executionContexts.push(executionContext);
        return {
          sessionId: "sesn_test",
          text: "Agent response",
        };
      },
    });
    const client = new Client({
      name: "aiappctl-test-client",
      version: "0.1.0",
    });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      expect(client.getServerVersion()?.name).toBe(
        "claude-managed-agents",
      );
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual([
        "product-manager",
      ]);

      const result = await client.callTool({
        name: "product-manager",
        arguments: {
          operation: "start",
          prompt: "Find customer pain points.",
        },
      });
      const startedRun = readToolJson(result);
      expect(startedRun.runId).toStartWith("run_");
      expect(startedRun).toMatchObject({
        status: "working",
        pollAfterMs: 5_000,
      });
      const completedRun = await waitForRun(
        client,
        startedRun.runId,
      );
      expect(prompts).toEqual(["Find customer pain points."]);
      expect(executionContexts[0].requestApproval).toBeFunction();
      expect(completedRun).toMatchObject({
        runId: startedRun.runId,
        status: "completed",
        sessionId: "sesn_test",
        result: "Agent response",
      });
      expect(result).not.toHaveProperty("structuredContent");
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("elicits an explicit approval without exposing argument values", async () => {
    const elicitationRequests = [];
    const server = createManagedAgentsMcpServer({
      agentName: "product-manager",
      execute: async (_prompt, { requestApproval }) => ({
        sessionId: "sesn_test",
        text: await requestApproval({
          serverName: "linear",
          toolName: "create_issue",
          argumentKeys: ["title", "accessToken"],
          approvalIndex: 2,
          approvalCount: 4,
        }),
      }),
    });
    const client = new Client(
      {
        name: "aiappctl-elicitation-test-client",
        version: "0.1.0",
      },
      {
        capabilities: {
          elicitation: { form: {} },
        },
      },
    );
    client.setRequestHandler(ElicitRequestSchema, async (request) => {
      elicitationRequests.push(request.params);
      return {
        action: "accept",
        content: { decision: "allow" },
      };
    });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const result = await client.callTool({
        name: "product-manager",
        arguments: {
          operation: "start",
          prompt: "Create an issue.",
        },
      });
      const completedRun = await waitForRun(
        client,
        readToolJson(result).runId,
      );
      expect(completedRun).toMatchObject({
        status: "completed",
        result: "allow",
      });
      expect(elicitationRequests).toHaveLength(1);
      expect(elicitationRequests[0]).toMatchObject({
        mode: "form",
        requestedSchema: {
          type: "object",
          properties: {
            decision: {
              type: "string",
              enum: ["allow", "deny"],
            },
          },
          required: ["decision"],
        },
      });
      expect(elicitationRequests[0].message).toContain(
        "'create_issue'",
      );
      expect(elicitationRequests[0].message).toContain("'linear'");
      expect(elicitationRequests[0].message).toContain(
        "title, accessToken",
      );
      expect(elicitationRequests[0].message).toStartWith(
        "Call 2 of 4.",
      );
    } finally {
      await client.close();
      await server.close();
    }
  });

  test.each(["decline", "cancel"])(
    "maps elicitation %s to deny",
    async (action) => {
      const server = createManagedAgentsMcpServer({
        agentName: "product-manager",
        execute: async (_prompt, { requestApproval }) => ({
          sessionId: "sesn_test",
          text: await requestApproval({
            serverName: "linear",
            toolName: "list_teams",
            argumentKeys: [],
          }),
        }),
      });
      const client = new Client(
        {
          name: "aiappctl-elicitation-test-client",
          version: "0.1.0",
        },
        {
          capabilities: {
            elicitation: { form: {} },
          },
        },
      );
      client.setRequestHandler(ElicitRequestSchema, async () => ({
        action,
      }));
      const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();

      await server.connect(serverTransport);
      await client.connect(clientTransport);

      try {
        const result = await client.callTool({
          name: "product-manager",
          arguments: {
            operation: "start",
            prompt: "List teams.",
          },
        });
        const completedRun = await waitForRun(
          client,
          readToolJson(result).runId,
        );
        expect(completedRun).toMatchObject({
          status: "completed",
          result: "deny",
        });
      } finally {
        await client.close();
        await server.close();
      }
    },
  );

  test("reports detached run failures and invalid requests", async () => {
    const server = createManagedAgentsMcpServer({
      agentName: "product-manager",
      execute: async () => {
        throw new Error("Agent execution failed");
      },
    });
    const client = new Client({
      name: "aiappctl-failure-test-client",
      version: "0.1.0",
    });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const missingPrompt = await client.callTool({
        name: "product-manager",
        arguments: { operation: "start" },
      });
      expect(missingPrompt.isError).toBe(true);
      expect(readToolJson(missingPrompt)).toEqual({
        error: "prompt is required for operation 'start'",
      });

      const started = await client.callTool({
        name: "product-manager",
        arguments: {
          operation: "start",
          prompt: "Run a failing task.",
        },
      });
      const failedRun = await waitForRun(
        client,
        readToolJson(started).runId,
      );
      expect(failedRun).toMatchObject({
        status: "failed",
        error: "Agent execution failed",
      });

      const unknownRun = await client.callTool({
        name: "product-manager",
        arguments: {
          operation: "status",
          runId: "run_unknown",
        },
      });
      expect(unknownRun.isError).toBe(true);
      expect(readToolJson(unknownRun)).toEqual({
        error: "unknown runId 'run_unknown'",
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("serves the app entrypoint over the CLI stdio transport", async () => {
    const client = new Client({
      name: "aiappctl-stdio-test-client",
      version: "0.1.0",
    });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        cliPath,
        "mcp",
        "serve",
        "--runtime",
        "claude",
        "--package",
        productManagerPackagePath,
        "--agent-id",
        "agent_test",
        "--environment-id",
        "env_test",
      ],
      env: {
        ...process.env,
        ANTHROPIC_API_KEY: "test-api-key",
      },
      stderr: "pipe",
    });

    await client.connect(transport);
    try {
      expect(client.getServerVersion()?.name).toBe(
        "claude-managed-agents",
      );
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual([
        "product-manager",
      ]);
    } finally {
      await client.close();
    }
  });

  test("serves the Agent over Streamable HTTP", async () => {
    const prompts = [];
    const handler = createManagedAgentsMcpHttpHandler({
      agentName: "product-manager",
      execute: async (prompt) => {
        prompts.push(prompt);
        return {
          sessionId: "sesn_test",
          text: "HTTP Agent response",
        };
      },
    });
    const createClient = () => {
      const client = new Client({
        name: "aiappctl-http-test-client",
        version: "0.1.0",
      });
      const transport = new StreamableHTTPClientTransport(
        new URL("http://claude-managed-agents.test/mcp"),
        {
          fetch: (input, init) =>
            handler.fetch(new Request(input, init)),
        },
      );
      return { client, transport };
    };

    const firstConnection = createClient();
    await firstConnection.client.connect(firstConnection.transport);
    try {
      expect(firstConnection.client.getServerVersion()?.name).toBe(
        "claude-managed-agents",
      );
      expect(
        (await firstConnection.client.listTools()).tools.map(
          ({ name }) => name,
        ),
      ).toEqual(["product-manager"]);
      const result = await firstConnection.client.callTool({
        name: "product-manager",
        arguments: {
          operation: "start",
          prompt: "Summarize customer pain points.",
        },
      });
      const runId = readToolJson(result).runId;
      expect(prompts).toEqual(["Summarize customer pain points."]);

      await firstConnection.client.close();

      const secondConnection = createClient();
      await secondConnection.client.connect(secondConnection.transport);
      const completedRun = await waitForRun(
        secondConnection.client,
        runId,
      );
      expect(completedRun).toMatchObject({
        runId,
        status: "completed",
        sessionId: "sesn_test",
        result: "HTTP Agent response",
      });
      await secondConnection.client.close();
    } finally {
      await firstConnection.client.close();
      await handler.close();
    }
  });
});
