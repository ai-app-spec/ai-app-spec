import { describe, expect, test } from "bun:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deploy } from "./commands/deploy/index.js";

const cliPath = fileURLToPath(new URL("./cli.js", import.meta.url));
const fixturesPath = fileURLToPath(new URL("./test/fixtures", import.meta.url));
const examplesPath = fileURLToPath(new URL("../../examples", import.meta.url));

async function runWithEnv(environment, ...args) {
  const subprocess = Bun.spawn([process.execPath, cliPath, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...environment },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
    subprocess.exited,
  ]);

  return { stdout, stderr, exitCode };
}

async function run(...args) {
  return runWithEnv({}, ...args);
}

function helloClaudeValidation() {
  const bundlePath = path.join(examplesPath, "hello-claude");
  const packagePath = path.join(
    bundlePath,
    "packages/greeter.agentpkg.yaml",
  );
  const resource = {
    id: "greeter",
    kind: "Agent",
    implementation: {
      format: "anthropic.com/managed-agent:v1",
      package: {
        location: "./packages/greeter.agentpkg.yaml",
      },
    },
  };

  return {
    manifestPath: path.join(bundlePath, "app.yaml"),
    manifest: { spec: { resources: [resource] } },
    resolvedPackages: new Map([[resource.id, packagePath]]),
  };
}

function productManagerValidation() {
  const bundlePath = path.join(examplesPath, "product-manager-claude");
  const packagePath = path.join(
    bundlePath,
    "packages/product-manager.agentpkg.yaml",
  );
  const agent = {
    id: "product-manager",
    kind: "Agent",
    tools: [{ ref: "linear" }],
    implementation: {
      format: "anthropic.com/managed-agent:v1",
      package: {
        location: "./packages/product-manager.agentpkg.yaml",
      },
    },
  };
  const linear = {
    id: "linear",
    kind: "MCPServer",
    connection: {
      type: "url",
      url: "https://mcp.linear.app/mcp",
    },
  };

  return {
    manifestPath: path.join(bundlePath, "app.yaml"),
    manifest: { spec: { resources: [agent, linear] } },
    resolvedPackages: new Map([[agent.id, packagePath]]),
  };
}

function useFixturePackage(validation, filename) {
  const agent = validation.manifest.spec.resources.find(
    (resource) => resource.kind === "Agent",
  );
  validation.resolvedPackages.set(
    agent.id,
    path.join(fixturesPath, filename),
  );
  return validation;
}

describe("aiappctl", () => {
  test("computes a SHA-256 digest over raw file bytes", async () => {
    const packagePath = path.join(
      fixturesPath,
      "wrong-digest/packages/greeter.pkg",
    );
    const result = await run("digest", packagePath);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(
      "sha256:5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03",
    );
    expect(result.stderr).toBe("");
  });

  test("rejects a package whose digest does not match", async () => {
    const result = await run(
      "validate",
      "--package",
      path.join(fixturesPath, "wrong-digest"),
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "/spec/resources/0/implementation/package/digest: expected sha256:",
    );
    expect(result.stderr).toContain(", got sha256:");
  });

  test("rejects a missing package", async () => {
    const result = await run(
      "validate",
      "--package",
      path.join(fixturesPath, "missing-file"),
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "/spec/resources/0/implementation/package/location: package does not exist",
    );
  });

  test("validates an Agent using an MCPServer", async () => {
    const result = await run(
      "validate",
      "--package",
      path.join(examplesPath, "product-manager-claude"),
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("app.yaml is valid");
    expect(result.stderr).toBe("");
  });

  test("deploys an Anthropic Managed Agent package", async () => {
    let request;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      request = {
        url: url.toString(),
        headers: Object.fromEntries(new Headers(init.headers)),
        body: JSON.parse(init.body),
      };
      return Response.json({ id: "agent_test_123", version: 1 });
    };

    let result;
    try {
      result = await deploy(helloClaudeValidation(), {
        runtime: "claude",
        apiKey: "test-api-key",
        baseUrl: "https://api.anthropic.test",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(result.errors).toEqual([]);
    expect(result.deployed).toEqual([
      {
        id: "greeter",
        kind: "Agent",
        format: "anthropic.com/managed-agent:v1",
        providerId: "agent_test_123",
        providerVersion: 1,
      },
    ]);
    expect(request.url).toBe("https://api.anthropic.test/v1/agents");
    expect(request.headers["x-api-key"]).toBe("test-api-key");
    expect(request.headers["anthropic-version"]).toBe("2023-06-01");
    expect(request.headers["anthropic-beta"]).toBe(
      "managed-agents-2026-04-01",
    );
    expect(request.body).toEqual({
      name: "Hello Claude",
      model: { id: "claude-opus-4-8" },
      system: "Respond with exactly: Hello, world!",
    });
  });

  test("deploys an Agent with referenced MCPServer resources", async () => {
    let request;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      request = {
        url: url.toString(),
        body: JSON.parse(init.body),
      };
      return Response.json({ id: "agent_product_manager", version: 1 });
    };

    let result;
    try {
      result = await deploy(productManagerValidation(), {
        runtime: "claude",
        apiKey: "test-api-key",
        baseUrl: "https://api.anthropic.test",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(result.errors).toEqual([]);
    expect(result.deployed).toEqual([
      {
        id: "product-manager",
        kind: "Agent",
        format: "anthropic.com/managed-agent:v1",
        providerId: "agent_product_manager",
        providerVersion: 1,
      },
    ]);
    expect(request.url).toBe("https://api.anthropic.test/v1/agents");
    expect(request.body.mcp_servers).toEqual([
      {
        type: "url",
        name: "linear",
        url: "https://mcp.linear.app/mcp",
      },
    ]);
    expect(request.body.tools).toEqual([
      {
        type: "mcp_toolset",
        mcp_server_name: "linear",
      },
    ]);
  });

  test("prepares the MCP-backed example through the deploy CLI", async () => {
    const result = await runWithEnv(
      { ANTHROPIC_API_KEY: "" },
      "deploy",
      "--runtime",
      "claude",
      "--package",
      path.join(examplesPath, "product-manager-claude"),
    );

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      "ANTHROPIC_API_KEY is required to deploy Anthropic resources",
    );
    expect(result.stderr).not.toContain("unsupported implementation format");
  });

  test("preserves non-MCP package tools when adding MCP toolsets", async () => {
    let requestBody;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (_url, init) => {
      requestBody = JSON.parse(init.body);
      return Response.json({ id: "agent_product_manager", version: 1 });
    };

    let result;
    try {
      result = await deploy(
        useFixturePackage(
          productManagerValidation(),
          "claude-agent-with-tools.agentpkg.yaml",
        ),
        {
          runtime: "claude",
          apiKey: "test-api-key",
          baseUrl: "https://api.anthropic.test",
        },
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(result.errors).toEqual([]);
    expect(requestBody.tools).toEqual([
      { type: "agent_toolset_20260401" },
      { type: "mcp_toolset", mcp_server_name: "linear" },
    ]);
  });

  test("rejects package-defined MCP configuration before deployment", async () => {
    let fetchCalls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      fetchCalls += 1;
      return Response.json({ id: "unexpected" });
    };

    const results = [];
    try {
      for (const filename of [
        "claude-agent-with-mcp-servers.agentpkg.yaml",
        "claude-agent-with-mcp-toolset.agentpkg.yaml",
      ]) {
        results.push(
          await deploy(
            useFixturePackage(productManagerValidation(), filename),
            {
              runtime: "claude",
              apiKey: "test-api-key",
              baseUrl: "https://api.anthropic.test",
            },
          ),
        );
      }
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(fetchCalls).toBe(0);
    expect(results[0].errors[0]).toContain(
      "implementation package must not define 'mcp_servers'",
    );
    expect(results[1].errors[0]).toContain(
      "implementation package must not define MCP toolsets",
    );
  });

  test("rejects a non-array package tools field before deployment", async () => {
    let fetchCalls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      fetchCalls += 1;
      return Response.json({ id: "unexpected" });
    };

    let result;
    try {
      result = await deploy(
        useFixturePackage(
          productManagerValidation(),
          "claude-agent-with-invalid-tools.agentpkg.yaml",
        ),
        {
          runtime: "claude",
          apiKey: "test-api-key",
          baseUrl: "https://api.anthropic.test",
        },
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(fetchCalls).toBe(0);
    expect(result.errors).toEqual([
      "resource 'product-manager': implementation package field 'tools' must be an array",
    ]);
  });

  test("rejects more than 20 MCP servers before deployment", async () => {
    const validation = helloClaudeValidation();
    const agent = validation.manifest.spec.resources[0];
    agent.tools = [];
    for (let index = 0; index < 21; index += 1) {
      const id = `server-${index}`;
      agent.tools.push({ ref: id });
      validation.manifest.spec.resources.push({
        id,
        kind: "MCPServer",
        connection: {
          type: "url",
          url: `https://mcp-${index}.example.com/mcp`,
        },
      });
    }
    let fetchCalls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      fetchCalls += 1;
      return Response.json({ id: "unexpected" });
    };

    let result;
    try {
      result = await deploy(validation, {
        runtime: "claude",
        apiKey: "test-api-key",
        baseUrl: "https://api.anthropic.test",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(fetchCalls).toBe(0);
    expect(result.errors).toEqual([
      "resource 'greeter': Claude Managed Agents supports at most 20 MCP servers, found 21",
    ]);
  });

  test("requires an Anthropic API key for deployment", async () => {
    const result = await runWithEnv(
      { ANTHROPIC_API_KEY: "" },
      "deploy",
      "--runtime",
      "claude",
      "--package",
      path.join(examplesPath, "hello-claude"),
    );

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      "ANTHROPIC_API_KEY is required to deploy Anthropic resources",
    );
  });

  test("rejects unsupported implementation formats before deployment", async () => {
    const result = await runWithEnv(
      { ANTHROPIC_API_KEY: "test-api-key" },
      "deploy",
      "--runtime",
      "claude",
      "--package",
      path.join(examplesPath, "hello-oci"),
    );

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      "resource 'greeter': runtime 'claude' does not support implementation format 'app-spec.ai/agent-container:v1'; supported formats: anthropic.com/managed-agent:v1",
    );
  });

  test("reports structured Anthropic API errors", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      Response.json(
        {
          type: "error",
          error: {
            type: "invalid_request_error",
            message: "model is unavailable",
          },
          request_id: "req_test_123",
        },
        { status: 400 },
      );

    let result;
    try {
      result = await deploy(helloClaudeValidation(), {
        runtime: "claude",
        apiKey: "test-api-key",
        baseUrl: "https://api.anthropic.test",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(result.deployed).toEqual([]);
    expect(result.errors).toEqual([
      "Anthropic failed to create resource 'greeter' (400: model is unavailable (request req_test_123))",
    ]);
  });

  test("requires a runtime for deployment", async () => {
    const result = await run(
      "deploy",
      "--package",
      path.join(examplesPath, "hello-claude"),
    );

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("aiappctl: --runtime is required");
  });

  test("rejects unsupported deployment runtimes", async () => {
    const result = await run(
      "deploy",
      "--runtime",
      "openai",
      "--package",
      path.join(examplesPath, "hello-claude"),
    );

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      "aiappctl: unsupported runtime 'openai'; supported runtimes: claude",
    );
  });
});
