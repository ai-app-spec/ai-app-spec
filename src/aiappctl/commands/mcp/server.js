import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

export function createExecMcpServer(options) {
  const server = new McpServer(
    {
      name: options.name || "ai-app-managed-agent",
      version: "0.1.0",
    },
    {
      instructions:
        "Use exec to delegate a task to the configured managed agent.",
    },
  );

  server.registerTool(
    "exec",
    {
      title: "Execute managed agent",
      description:
        "Run a task with the configured managed agent in a fresh session and return its final text response.",
      inputSchema: {
        prompt: z
          .string()
          .min(1)
          .describe("The task or question to send to the managed agent."),
      },
    },
    async ({ prompt }) => {
      try {
        const result = await options.execute(prompt);
        return {
          content: [{ type: "text", text: result.text }],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: error instanceof Error ? error.message : String(error),
            },
          ],
          isError: true,
        };
      }
    },
  );

  return server;
}

export async function serveExecMcpServer(options) {
  const server = createExecMcpServer(options);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return server;
}
