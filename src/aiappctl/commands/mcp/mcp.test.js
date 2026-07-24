import { afterEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { fileURLToPath } from "node:url";
import { parseMcpArguments } from "./index.js";
import { executeClaudeManagedAgent } from "./runtimes/claude.js";
import { createExecMcpServer } from "./server.js";

const originalFetch = globalThis.fetch;
const cliPath = fileURLToPath(new URL("../../cli.js", import.meta.url));

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("Claude Managed Agent MCP runtime", () => {
  test("parses the local MCP server arguments", () => {
    expect(
      parseMcpArguments([
        "serve",
        "--runtime",
        "claude",
        "--agent-id=agent_test",
        "--environment-id",
        "env_test",
        "--vault-id",
        "vlt_test",
      ]),
    ).toEqual({
      runtime: "claude",
      agentId: "agent_test",
      environmentId: "env_test",
      vaultId: "vlt_test",
    });
  });

  test("requires the Claude session bindings", () => {
    expect(parseMcpArguments(["serve"])).toEqual({
      error: "--runtime is required",
    });
    expect(
      parseMcpArguments(["serve", "--runtime", "claude"]),
    ).toEqual({
      error: "--agent-id is required",
    });
    expect(
      parseMcpArguments([
        "serve",
        "--runtime",
        "claude",
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

  test("reports sessions waiting for tool approval", async () => {
    globalThis.fetch = async (url, init = {}) => {
      const endpoint = new URL(url);
      if (endpoint.pathname === "/v1/sessions") {
        return Response.json({ id: "sesn_test", status: "idle" });
      }
      return Response.json({
        data: [
          {
            id: "event_idle",
            type: "session.status_idle",
            stop_reason: {
              type: "requires_action",
              event_ids: ["event_tool"],
            },
          },
        ],
        next_page: null,
      });
    };

    expect(
      executeClaudeManagedAgent("Use a tool.", {
        apiKey: "test-api-key",
        baseUrl: "https://api.anthropic.test",
        agentId: "agent_test",
        environmentId: "env_test",
        pollIntervalMs: 0,
      }),
    ).rejects.toThrow(
      "requires tool approval; this MVP only supports sessions that complete without client-side action",
    );
  });
});

describe("managed Agent MCP server", () => {
  test("exposes only exec and delegates its prompt", async () => {
    const prompts = [];
    const server = createExecMcpServer({
      execute: async (prompt) => {
        prompts.push(prompt);
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
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual(["exec"]);

      const result = await client.callTool({
        name: "exec",
        arguments: { prompt: "Find customer pain points." },
      });
      expect(prompts).toEqual(["Find customer pain points."]);
      expect(result).toMatchObject({
        content: [{ type: "text", text: "Agent response" }],
      });
      expect(result).not.toHaveProperty("structuredContent");
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("serves exec over the CLI stdio transport", async () => {
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
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual(["exec"]);
    } finally {
      await client.close();
    }
  });
});
