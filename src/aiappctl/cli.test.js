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
