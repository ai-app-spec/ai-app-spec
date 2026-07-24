import { claudeMcpRuntime } from "./runtimes/claude.js";
import {
  serveManagedAgentsMcpHttp,
  serveManagedAgentsMcpServer,
} from "./server.js";

const runtimeAdapters = new Map([
  [claudeMcpRuntime.name, claudeMcpRuntime],
]);
const supportedRuntimes = [...runtimeAdapters.keys()].join(", ");

export function parseMcpArguments(args) {
  if (args[0] !== "serve") {
    return { error: "mcp requires the 'serve' subcommand" };
  }

  let runtime;
  let transport = "stdio";
  let inputPath;
  let agentId;
  let environmentId;
  let vaultId;
  let port;

  const values = new Map([
    ["--runtime", (value) => (runtime = value)],
    ["--transport", (value) => (transport = value)],
    ["--package", (value) => (inputPath = value)],
    ["--agent-id", (value) => (agentId = value)],
    ["--environment-id", (value) => (environmentId = value)],
    ["--vault-id", (value) => (vaultId = value)],
    ["--port", (value) => (port = value)],
  ]);
  const seen = new Set();

  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index];
    const separator = argument.indexOf("=");
    const flag = separator === -1 ? argument : argument.slice(0, separator);
    const setValue = values.get(flag);

    if (!setValue) {
      return { error: `unexpected argument '${argument}'` };
    }
    if (seen.has(flag)) {
      return { error: `${flag} may only be specified once` };
    }

    const value =
      separator === -1 ? args[index + 1] : argument.slice(separator + 1);
    if (!value || value.startsWith("--")) {
      return { error: `${flag} requires a value` };
    }

    seen.add(flag);
    setValue(value);
    if (separator === -1) {
      index += 1;
    }
  }

  if (!runtime) {
    return { error: "--runtime is required" };
  }
  if (!runtimeAdapters.has(runtime)) {
    return {
      error: `unsupported MCP runtime '${runtime}'; supported runtimes: ${supportedRuntimes}`,
    };
  }
  if (transport !== "stdio" && transport !== "http") {
    return {
      error: `unsupported MCP transport '${transport}'; supported transports: stdio, http`,
    };
  }
  if (port !== undefined) {
    if (
      transport !== "http" ||
      !/^\d+$/.test(port) ||
      Number(port) < 1 ||
      Number(port) > 65_535
    ) {
      return {
        error:
          "--port requires the http transport and an integer from 1 to 65535",
      };
    }
    port = Number(port);
  }
  if (!inputPath) {
    return { error: "--package is required" };
  }
  if (!agentId) {
    return { error: "--agent-id is required" };
  }
  if (!environmentId) {
    return { error: "--environment-id is required" };
  }

  return {
    runtime,
    transport,
    inputPath,
    agentId,
    environmentId,
    vaultId,
    ...(port === undefined ? {} : { port }),
  };
}

export async function serveMcp(options) {
  const runtime = runtimeAdapters.get(options.runtime);
  if (!runtime) {
    throw new Error(
      `unsupported MCP runtime '${options.runtime || "<missing>"}'; supported runtimes: ${supportedRuntimes}`,
    );
  }

  const serverOptions = {
    agentName: options.agentName,
    execute: runtime.createExecutor(options),
  };
  if (options.transport === "http") {
    return serveManagedAgentsMcpHttp({
      ...serverOptions,
      port: options.port,
    });
  }
  return serveManagedAgentsMcpServer(serverOptions);
}
