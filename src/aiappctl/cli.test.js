import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseBuildArguments } from "./commands/build/index.js";
import {
  deploy,
  parseDeployArguments,
} from "./commands/deploy/index.js";

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

function helloGeminiValidation() {
  const bundlePath = path.join(examplesPath, "hello-gemini");
  const packagePath = path.join(
    bundlePath,
    "packages/greeter.agentpkg.yaml",
  );
  const resource = {
    id: "greeter",
    kind: "Agent",
    implementation: {
      format: "google.com/managed-agent:v1",
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

function productManagerGeminiValidation() {
  const bundlePath = path.join(examplesPath, "product-manager-gemini");
  const packagePath = path.join(
    bundlePath,
    "packages/product-manager.agentpkg.yaml",
  );
  const agent = {
    id: "product-manager",
    kind: "Agent",
    executionEnvironment: { ref: "product-manager-sandbox" },
    tools: [{ ref: "linear" }],
    implementation: {
      format: "google.com/managed-agent:v1",
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
    authentication: {
      type: "bearer",
      secret: { ref: "linear-access-token" },
    },
  };

  return {
    manifestPath: path.join(bundlePath, "app.yaml"),
    manifest: {
      metadata: { name: "product-manager-gemini" },
      spec: {
        requirements: {
          secrets: [{ id: "linear-access-token" }],
          executionEnvironments: [
            {
              id: "product-manager-sandbox",
              networking: { mcpServers: true },
            },
          ],
        },
        resources: [agent, linear],
      },
    },
    resolvedPackages: new Map([[agent.id, packagePath]]),
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
    authentication: {
      type: "bearer",
      secret: { ref: "linear-access-token" },
    },
  };

  return {
    manifestPath: path.join(bundlePath, "app.yaml"),
    manifest: {
      metadata: { name: "product-manager-claude" },
      spec: {
        requirements: {
          secrets: [{ id: "linear-access-token" }],
        },
        resources: [agent, linear],
      },
    },
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

function withExecutionEnvironment(validation) {
  const agent = validation.manifest.spec.resources.find(
    (resource) => resource.kind === "Agent",
  );
  validation.manifest.spec.requirements ||= {};
  validation.manifest.spec.requirements.executionEnvironments = [
    {
      id: "product-manager-sandbox",
      networking: {
        mcpServers: true,
      },
    },
  ];
  agent.executionEnvironment = { ref: "product-manager-sandbox" };
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

  test("validates the Gemini Managed Agents example", async () => {
    const result = await run(
      "validate",
      "--package",
      path.join(examplesPath, "hello-gemini"),
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("app.yaml is valid");
    expect(result.stderr).toBe("");
  });

  test("validates the Gemini Product Manager example", async () => {
    const result = await run(
      "validate",
      "--package",
      path.join(examplesPath, "product-manager-gemini"),
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("app.yaml is valid");
    expect(result.stderr).toBe("");
  });

  test("validates the Eve Product Manager example", async () => {
    const result = await run(
      "validate",
      "--package",
      path.join(examplesPath, "product-manager-eve"),
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("app.yaml is valid");
    expect(result.stderr).toBe("");
  });

  test("builds an Eve project from an app package", async () => {
    const temporaryDirectory = await mkdtemp(
      path.join(os.tmpdir(), "aiappctl-eve-build-"),
    );
    const outPath = path.join(temporaryDirectory, "product-manager-eve");

    try {
      const result = await run(
        "build",
        "--runtime",
        "eve",
        "--package",
        path.join(examplesPath, "product-manager-eve"),
        "--out",
        outPath,
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(
        `built App 'product-manager-eve' for eve at ${outPath}`,
      );
      expect(result.stderr).toBe("");

      const packageJson = JSON.parse(
        await readFile(path.join(outPath, "package.json"), "utf8"),
      );
      expect(packageJson).toMatchObject({
        name: "product-manager-eve",
        version: "0.1.0",
        engines: { node: ">=24" },
        scripts: {
          build: "eve build",
          deploy: "eve deploy",
        },
        dependencies: {
          ai: "7.0.34",
          eve: "0.27.8",
        },
      });

      expect(
        await readFile(path.join(outPath, "agent/agent.ts"), "utf8"),
      ).toContain('model: "anthropic/claude-opus-4.8"');
      expect(
        await readFile(
          path.join(outPath, "agent/connections/linear.ts"),
          "utf8",
        ),
      ).toContain("process.env.LINEAR_ACCESS_TOKEN");
      expect(
        await readFile(path.join(outPath, ".env.example"), "utf8"),
      ).toBe("LINEAR_ACCESS_TOKEN=\n");

      const buildManifest = JSON.parse(
        await readFile(
          path.join(outPath, "aiappctl.build.json"),
          "utf8",
        ),
      );
      expect(buildManifest).toMatchObject({
        source: {
          app: "product-manager-eve",
          entrypoint: "product-manager",
          implementation: {
            format: "vercel.com/eve:v1",
          },
        },
        runtime: {
          name: "eve",
          version: "0.27.8",
        },
        bindings: {
          secrets: [
            {
              requirementId: "linear-access-token",
              environmentVariable: "LINEAR_ACCESS_TOKEN",
            },
          ],
        },
      });
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  test("does not overwrite an existing Eve build output path", async () => {
    const outPath = await mkdtemp(
      path.join(os.tmpdir(), "aiappctl-eve-existing-"),
    );

    try {
      const result = await run(
        "build",
        "--runtime=eve",
        `--package=${path.join(examplesPath, "product-manager-eve")}`,
        `--out=${outPath}`,
      );

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(
        `output path already exists: ${outPath}; choose a new --out directory`,
      );
    } finally {
      await rm(outPath, { recursive: true, force: true });
    }
  });

  test("parses Eve build arguments", () => {
    expect(
      parseBuildArguments([
        "--runtime=eve",
        "--package=../../examples/product-manager-eve",
        "--out=./dist/product-manager-eve",
      ]),
    ).toEqual({
      runtime: "eve",
      inputPath: "../../examples/product-manager-eve",
      outPath: "./dist/product-manager-eve",
    });
  });

  test("rejects unsupported build formats before writing output", async () => {
    const temporaryDirectory = await mkdtemp(
      path.join(os.tmpdir(), "aiappctl-eve-format-"),
    );
    const outPath = path.join(temporaryDirectory, "hello-claude");

    try {
      const result = await run(
        "build",
        "--runtime",
        "eve",
        "--package",
        path.join(examplesPath, "hello-claude"),
        "--out",
        outPath,
      );

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(
        "build runtime 'eve' does not support implementation format 'anthropic.com/managed-agent:v1'",
      );
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
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
        operation: "created",
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

  test("updates an explicitly selected Anthropic Managed Agent", async () => {
    const requests = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      requests.push({
        url: url.toString(),
        method: init.method,
        body: init.body ? JSON.parse(init.body) : undefined,
      });

      if (init.method === "GET") {
        return Response.json({
          id: "agent_existing123",
          version: 4,
          archived_at: null,
        });
      }
      return Response.json({ id: "agent_existing123", version: 5 });
    };

    let result;
    try {
      result = await deploy(helloClaudeValidation(), {
        runtime: "claude",
        apiKey: "test-api-key",
        baseUrl: "https://api.anthropic.test",
        agentId: "agent_existing123",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(result.errors).toEqual([]);
    expect(result.deployed[0]).toMatchObject({
      providerId: "agent_existing123",
      providerVersion: 5,
      operation: "updated",
    });
    expect(requests.map(({ method, url }) => [method, url])).toEqual([
      ["GET", "https://api.anthropic.test/v1/agents/agent_existing123"],
      ["POST", "https://api.anthropic.test/v1/agents/agent_existing123"],
    ]);
    expect(requests[1].body).toMatchObject({ version: 4 });
  });

  test("rejects a missing explicitly selected Anthropic Managed Agent", async () => {
    let mutationCalls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (_url, init) => {
      if (init.method !== "GET") {
        mutationCalls += 1;
      }
      return Response.json(
        { error: { message: "not found" } },
        { status: 404 },
      );
    };

    let result;
    try {
      result = await deploy(helloClaudeValidation(), {
        runtime: "claude",
        apiKey: "test-api-key",
        baseUrl: "https://api.anthropic.test",
        agentId: "agent_missing123",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(mutationCalls).toBe(0);
    expect(result.errors).toEqual([
      "Anthropic Agent 'agent_missing123' does not exist",
    ]);
  });

  test("rejects --agent-id for a Claude app with multiple Agent resources", async () => {
    const validation = helloClaudeValidation();
    const secondAgent = {
      ...validation.manifest.spec.resources[0],
      id: "second-agent",
    };
    validation.manifest.spec.resources.push(secondAgent);
    validation.resolvedPackages.set(
      secondAgent.id,
      validation.resolvedPackages.get("greeter"),
    );
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
        agentId: "agent_existing123",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(fetchCalls).toBe(0);
    expect(result.errors).toEqual([
      "--agent-id can only be used when the app contains exactly one Agent resource",
    ]);
  });

  test("deploys a Google Managed Agent package", async () => {
    const requests = [];
    let agentGets = 0;
    let operationPolls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      const request = {
        url: url.toString(),
        method: init.method,
        headers: Object.fromEntries(new Headers(init.headers)),
        body: init.body ? JSON.parse(init.body) : undefined,
      };
      requests.push(request);

      const pathname = new URL(url).pathname;
      if (
        pathname ===
        "/v1beta1/projects/test-project/locations/global/agents"
      ) {
        return Response.json({
          name: "projects/test-project/locations/global/agents/greeter/operations/op-123",
        });
      }
      if (pathname.endsWith("/operations/op-123")) {
        operationPolls += 1;
        if (operationPolls === 1) {
          return Response.json({
            name: "projects/test-project/locations/global/agents/greeter/operations/op-123",
          });
        }
        return Response.json({
          name: "projects/test-project/locations/global/agents/greeter/operations/op-123",
          done: true,
          response: {
            name: "projects/test-project/locations/global/agents/greeter",
          },
        });
      }
      if (pathname.endsWith("/agents/greeter")) {
        agentGets += 1;
        if (agentGets === 1) {
          return Response.json(
            { error: { message: "not found" } },
            { status: 404 },
          );
        }
        return Response.json({
          name: "projects/test-project/locations/global/agents/greeter",
          id: "greeter",
        });
      }
      return Response.json(
        { error: { message: "unexpected request" } },
        { status: 404 },
      );
    };

    let result;
    try {
      result = await deploy(helloGeminiValidation(), {
        runtime: "gemini",
        projectId: "test-project",
        accessToken: "test-access-token",
        baseUrl: "https://aiplatform.googleapis.test",
        operationPollIntervalMs: 0,
        operationTimeoutMs: 1_000,
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(result.errors).toEqual([]);
    expect(result.deployed).toEqual([
      {
        id: "greeter",
        kind: "Agent",
        format: "google.com/managed-agent:v1",
        providerId:
          "projects/test-project/locations/global/agents/greeter",
      },
    ]);
    expect(requests.map((request) => [request.method, request.url])).toEqual([
      [
        "GET",
        "https://aiplatform.googleapis.test/v1beta1/projects/test-project/locations/global/agents/greeter",
      ],
      [
        "POST",
        "https://aiplatform.googleapis.test/v1beta1/projects/test-project/locations/global/agents",
      ],
      [
        "GET",
        "https://aiplatform.googleapis.test/v1beta1/projects/test-project/locations/global/agents/greeter/operations/op-123",
      ],
      [
        "GET",
        "https://aiplatform.googleapis.test/v1beta1/projects/test-project/locations/global/agents/greeter/operations/op-123",
      ],
      [
        "GET",
        "https://aiplatform.googleapis.test/v1beta1/projects/test-project/locations/global/agents/greeter",
      ],
    ]);
    const createRequest = requests.find(
      (request) => request.method === "POST",
    );
    expect(createRequest.headers.authorization).toBe(
      "Bearer test-access-token",
    );
    expect(createRequest.body).toEqual({
      base_agent: "antigravity-preview-05-2026",
      description: "A minimal greeting agent.",
      system_instruction: "Respond with exactly: Hello, world!",
      id: "greeter",
    });
  });

  test("deploys Gemini MCP tools with Secret Manager credentials and networking", async () => {
    const requests = [];
    let agentGets = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      const request = {
        url: url.toString(),
        method: init.method,
        headers: Object.fromEntries(new Headers(init.headers)),
        body: init.body ? JSON.parse(init.body) : undefined,
      };
      requests.push(request);

      const parsedUrl = new URL(url);
      if (parsedUrl.hostname === "secretmanager.googleapis.test") {
        return Response.json({
          payload: {
            data: Buffer.from("linear-test-token").toString("base64"),
          },
        });
      }
      if (parsedUrl.pathname.endsWith("/agents/product-manager")) {
        agentGets += 1;
        if (agentGets === 1) {
          return Response.json(
            { error: { message: "not found" } },
            { status: 404 },
          );
        }
        return Response.json({
          name: "projects/test-project/locations/global/agents/product-manager",
          id: "product-manager",
        });
      }
      if (parsedUrl.pathname.endsWith("/agents")) {
        return Response.json({
          name: "projects/test-project/locations/global/agents/product-manager/operations/op-456",
        });
      }
      if (parsedUrl.pathname.endsWith("/operations/op-456")) {
        return Response.json({
          name: "projects/test-project/locations/global/agents/product-manager/operations/op-456",
          done: true,
        });
      }
      return Response.json(
        { error: { message: "unexpected request" } },
        { status: 404 },
      );
    };

    let result;
    try {
      result = await deploy(
        useFixturePackage(
          productManagerGeminiValidation(),
          "gemini-agent-with-tools.agentpkg.yaml",
        ),
        {
          runtime: "gemini",
          projectId: "test-project",
          accessToken: "test-access-token",
          baseUrl: "https://aiplatform.googleapis.test",
          secretManagerBaseUrl: "https://secretmanager.googleapis.test",
          secretBindings: new Map([
            [
              "linear-access-token",
              "projects/test-project/secrets/linear-access-token/versions/latest",
            ],
          ]),
          operationPollIntervalMs: 0,
          operationTimeoutMs: 1_000,
        },
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(result.errors).toEqual([]);
    expect(requests[0].url).toBe(
      "https://secretmanager.googleapis.test/v1/projects/test-project/secrets/linear-access-token/versions/latest:access",
    );
    const createRequest = requests.find(
      (request) =>
        request.method === "POST" &&
        new URL(request.url).pathname.endsWith("/agents"),
    );
    expect(createRequest.body.tools).toEqual([
      {
        type: "google_search",
      },
      {
        type: "mcp_server",
        name: "linear",
        url: "https://mcp.linear.app/mcp",
        headers: {
          Authorization: "Bearer linear-test-token",
        },
      },
    ]);
    expect(createRequest.body.base_environment).toEqual({
      type: "remote",
      network: {
        allowlist: [{ domain: "mcp.linear.app" }],
      },
    });
  });

  test("requires Gemini Secret Manager bindings before provider access", async () => {
    let fetchCalls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      fetchCalls += 1;
      return Response.json({ id: "unexpected" });
    };

    let result;
    try {
      result = await deploy(productManagerGeminiValidation(), {
        runtime: "gemini",
        projectId: "test-project",
        accessToken: "test-access-token",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(fetchCalls).toBe(0);
    expect(result.errors).toEqual([
      "--secret-binding is required for secret requirement 'linear-access-token'",
    ]);
  });

  test("rejects invalid Gemini Secret Manager bindings before provider access", async () => {
    let fetchCalls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      fetchCalls += 1;
      return Response.json({ id: "unexpected" });
    };

    const results = [];
    try {
      for (const resourceName of [
        "linear-access-token",
        "projects/other-project/secrets/linear-access-token/versions/latest",
      ]) {
        results.push(
          await deploy(productManagerGeminiValidation(), {
            runtime: "gemini",
            projectId: "test-project",
            accessToken: "test-access-token",
            secretBindings: new Map([
              ["linear-access-token", resourceName],
            ]),
          }),
        );
      }
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(fetchCalls).toBe(0);
    expect(results[0].errors).toEqual([
      "secret binding 'linear-access-token' must use projects/{project}/secrets/{secret}/versions/{version}",
    ]);
    expect(results[1].errors).toEqual([
      "secret binding 'linear-access-token' must belong to Google Cloud project 'test-project'",
    ]);
  });

  test("rejects package-defined Gemini MCP tools before provider access", async () => {
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
          productManagerGeminiValidation(),
          "gemini-agent-with-mcp-tool.agentpkg.yaml",
        ),
        {
          runtime: "gemini",
          secretBindings: new Map([
            [
              "linear-access-token",
              "projects/test-project/secrets/linear-access-token/versions/latest",
            ],
          ]),
        },
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(fetchCalls).toBe(0);
    expect(result.errors).toEqual([
      "resource 'product-manager': implementation package must not define MCP server tools; reference MCPServer resources in app.yaml",
    ]);
  });

  test("patches an existing Gemini Agent with rotated MCP credentials", async () => {
    const requests = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      const request = {
        url: url.toString(),
        method: init.method,
        body: init.body ? JSON.parse(init.body) : undefined,
      };
      requests.push(request);

      const parsedUrl = new URL(url);
      if (parsedUrl.hostname === "secretmanager.googleapis.test") {
        return Response.json({
          payload: {
            data: Buffer.from("rotated-linear-token").toString("base64"),
          },
        });
      }
      if (
        parsedUrl.pathname.endsWith("/agents/product-manager") &&
        init.method === "GET"
      ) {
        return Response.json({
          name: "projects/test-project/locations/global/agents/product-manager",
          id: "product-manager",
        });
      }
      if (
        parsedUrl.pathname.endsWith("/agents/product-manager") &&
        init.method === "PATCH"
      ) {
        return Response.json({
          name: "projects/test-project/locations/global/agents/product-manager",
          id: "product-manager",
        });
      }
      return Response.json(
        { error: { message: "unexpected request" } },
        { status: 404 },
      );
    };

    let result;
    try {
      result = await deploy(productManagerGeminiValidation(), {
        runtime: "gemini",
        projectId: "test-project",
        accessToken: "test-access-token",
        baseUrl: "https://aiplatform.googleapis.test",
        secretManagerBaseUrl: "https://secretmanager.googleapis.test",
        secretBindings: new Map([
          [
            "linear-access-token",
            "projects/test-project/secrets/linear-access-token/versions/latest",
          ],
        ]),
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(result.errors).toEqual([]);
    expect(requests.some((request) => request.method === "POST")).toBe(false);
    const patchRequest = requests.find(
      (request) => request.method === "PATCH",
    );
    expect(new URL(patchRequest.url).searchParams.get("updateMask")).toBe(
      "description,system_instruction,tools,base_environment",
    );
    expect(patchRequest.body.tools[0].headers.Authorization).toBe(
      "Bearer rotated-linear-token",
    );
  });

  test("deploys an Agent with referenced MCPServer resources", async () => {
    const requests = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      const request = {
        url: url.toString(),
        method: init.method,
        body: init.body ? JSON.parse(init.body) : undefined,
      };
      requests.push(request);

      const pathname = new URL(url).pathname;
      if (pathname === "/v1/environments/env_product_manager") {
        return Response.json({
          id: "env_product_manager",
          archived_at: null,
          config: {
            type: "cloud",
            networking: {
              type: "limited",
              allow_mcp_servers: true,
            },
          },
        });
      }
      if (pathname === "/v1/vaults/vlt_product_manager") {
        return Response.json({
          id: "vlt_product_manager",
          archived_at: null,
        });
      }
      if (pathname.endsWith("/credentials")) {
        return Response.json({
          data: [
            {
              id: "vcrd_linear",
              archived_at: null,
              auth: {
                type: "static_bearer",
                mcp_server_url: "https://mcp.linear.app/mcp/",
              },
            },
          ],
          next_page: null,
        });
      }
      return Response.json({ id: "agent_product_manager", version: 1 });
    };

    let result;
    try {
      result = await deploy(
        withExecutionEnvironment(productManagerValidation()),
        {
          runtime: "claude",
          apiKey: "test-api-key",
          baseUrl: "https://api.anthropic.test",
          environmentId: "env_product_manager",
          vaultId: "vlt_product_manager",
        },
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(result.errors).toEqual([]);
    expect(result.environment).toEqual({
      id: "env_product_manager",
      environmentType: "cloud",
      bindings: [
        {
          requirementId: "product-manager-sandbox",
          resourceIds: ["product-manager"],
        },
      ],
    });
    expect(result.vault).toEqual({
      id: "vlt_product_manager",
      credentials: [
        {
          id: "vcrd_linear",
          resourceId: "linear",
          credentialType: "static_bearer",
        },
      ],
    });
    expect(result.deployed).toEqual([
      {
        id: "product-manager",
        kind: "Agent",
        format: "anthropic.com/managed-agent:v1",
        providerId: "agent_product_manager",
        providerVersion: 1,
      },
    ]);
    expect(requests.map((request) => [request.method, request.url])).toEqual([
      [
        "GET",
        "https://api.anthropic.test/v1/environments/env_product_manager",
      ],
      [
        "GET",
        "https://api.anthropic.test/v1/vaults/vlt_product_manager",
      ],
      [
        "GET",
        "https://api.anthropic.test/v1/vaults/vlt_product_manager/credentials",
      ],
      ["POST", "https://api.anthropic.test/v1/agents"],
    ]);
    expect(requests[0].body).toBeUndefined();
    expect(requests[1].body).toBeUndefined();
    expect(requests[2].body).toBeUndefined();
    expect(requests[3].body.mcp_servers).toEqual([
      {
        type: "url",
        name: "linear",
        url: "https://mcp.linear.app/mcp",
      },
    ]);
    expect(requests[3].body.tools).toEqual([
      {
        type: "mcp_toolset",
        mcp_server_name: "linear",
      },
    ]);
  });

  test("requires an environment id for an execution environment binding", async () => {
    let fetchCalls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      fetchCalls += 1;
      return Response.json({ id: "unexpected" });
    };

    let result;
    try {
      result = await deploy(
        withExecutionEnvironment(helloClaudeValidation()),
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
      "--environment-id is required when Agent resources reference an execution environment",
    ]);
  });

  test("rejects an archived execution environment before deployment", async () => {
    const requests = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      requests.push({ url: url.toString(), method: init.method });
      return Response.json({
        id: "env_archived",
        archived_at: "2026-07-23T12:00:00Z",
        config: { type: "cloud" },
      });
    };

    let result;
    try {
      result = await deploy(
        withExecutionEnvironment(helloClaudeValidation()),
        {
          runtime: "claude",
          apiKey: "test-api-key",
          baseUrl: "https://api.anthropic.test",
          environmentId: "env_archived",
        },
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(requests).toEqual([
      {
        method: "GET",
        url: "https://api.anthropic.test/v1/environments/env_archived",
      },
    ]);
    expect(result.deployed).toEqual([]);
    expect(result.errors).toEqual([
      "Anthropic environment 'env_archived' is archived",
    ]);
  });

  test("accepts unrestricted networking for MCP server access", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const pathname = new URL(url).pathname;
      if (pathname === "/v1/environments/env_unrestricted") {
        return Response.json({
          id: "env_unrestricted",
          archived_at: null,
          config: {
            type: "cloud",
            networking: { type: "unrestricted" },
          },
        });
      }
      return Response.json({ id: "agent_test_123", version: 1 });
    };

    let result;
    try {
      result = await deploy(
        withExecutionEnvironment(helloClaudeValidation()),
        {
          runtime: "claude",
          apiKey: "test-api-key",
          baseUrl: "https://api.anthropic.test",
          environmentId: "env_unrestricted",
        },
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(result.errors).toEqual([]);
    expect(result.deployed).toHaveLength(1);
  });

  test("rejects a cloud environment without MCP server network access", async () => {
    const requests = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      requests.push({ url: url.toString(), method: init.method });
      return Response.json({
        id: "env_mcp_blocked",
        archived_at: null,
        config: {
          type: "cloud",
          networking: {
            type: "limited",
            allow_mcp_servers: false,
          },
        },
      });
    };

    let result;
    try {
      result = await deploy(
        withExecutionEnvironment(helloClaudeValidation()),
        {
          runtime: "claude",
          apiKey: "test-api-key",
          baseUrl: "https://api.anthropic.test",
          environmentId: "env_mcp_blocked",
        },
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(requests).toEqual([
      {
        method: "GET",
        url: "https://api.anthropic.test/v1/environments/env_mcp_blocked",
      },
    ]);
    expect(result.deployed).toEqual([]);
    expect(result.errors).toEqual([
      "Claude environment 'env_mcp_blocked' does not satisfy execution environment requirement 'product-manager-sandbox': MCP server network access is not enabled",
    ]);
  });

  test("rejects unverifiable self-hosted MCP server networking", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      Response.json({
        id: "env_self_hosted",
        archived_at: null,
        config: { type: "self_hosted" },
      });

    let result;
    try {
      result = await deploy(
        withExecutionEnvironment(helloClaudeValidation()),
        {
          runtime: "claude",
          apiKey: "test-api-key",
          baseUrl: "https://api.anthropic.test",
          environmentId: "env_self_hosted",
        },
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(result.deployed).toEqual([]);
    expect(result.errors).toEqual([
      "Claude environment 'env_self_hosted' cannot verify MCP server network access for execution environment requirement 'product-manager-sandbox' because it is self-hosted",
    ]);
  });

  test("does not enforce MCP server networking when it is false", async () => {
    const validation = withExecutionEnvironment(helloClaudeValidation());
    validation.manifest.spec.requirements.executionEnvironments[0].networking.mcpServers =
      false;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const pathname = new URL(url).pathname;
      if (pathname === "/v1/environments/env_self_hosted") {
        return Response.json({
          id: "env_self_hosted",
          archived_at: null,
          config: { type: "self_hosted" },
        });
      }
      return Response.json({ id: "agent_test_123", version: 1 });
    };

    let result;
    try {
      result = await deploy(validation, {
        runtime: "claude",
        apiKey: "test-api-key",
        baseUrl: "https://api.anthropic.test",
        environmentId: "env_self_hosted",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(result.errors).toEqual([]);
    expect(result.deployed).toHaveLength(1);
  });

  test("requires a vault id for authenticated MCP servers", async () => {
    let fetchCalls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      fetchCalls += 1;
      return Response.json({ id: "unexpected" });
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

    expect(fetchCalls).toBe(0);
    expect(result.errors).toEqual([
      "--vault-id is required when authenticated MCPServer resources are referenced",
    ]);
  });

  test("rejects a vault without the required MCP credential", async () => {
    const requests = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      requests.push({ url: url.toString(), method: init.method });
      const pathname = new URL(url).pathname;

      if (pathname === "/v1/vaults/vlt_product_manager") {
        return Response.json({
          id: "vlt_product_manager",
          archived_at: null,
        });
      }
      if (pathname.endsWith("/credentials")) {
        return Response.json({ data: [], next_page: null });
      }
      return Response.json({ id: "unexpected" });
    };

    let result;
    try {
      result = await deploy(productManagerValidation(), {
        runtime: "claude",
        apiKey: "test-api-key",
        baseUrl: "https://api.anthropic.test",
        vaultId: "vlt_product_manager",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(result.deployed).toEqual([]);
    expect(result.errors).toEqual([
      "vault 'vlt_product_manager' does not contain an active MCP credential for resource 'linear' at https://mcp.linear.app/mcp",
    ]);
    expect(requests.every((request) => request.method === "GET")).toBe(true);
  });

  test("parses a vault binding", () => {
    const result = parseDeployArguments([
      "--runtime",
      "claude",
      "--package=./app",
      "--vault-id=vlt_existing",
    ]);

    expect(result.error).toBeUndefined();
    expect(result.vaultId).toBe("vlt_existing");
  });

  test("parses an execution environment binding", () => {
    const result = parseDeployArguments([
      "--runtime",
      "claude",
      "--package=./app",
      "--environment-id=env_existing",
    ]);

    expect(result.error).toBeUndefined();
    expect(result.environmentId).toBe("env_existing");
  });

  test("parses and validates an Anthropic Agent id", () => {
    const parsed = parseDeployArguments([
      "--runtime=claude",
      "--package=./app",
      "--agent-id=agent_existing123",
    ]);
    const invalid = parseDeployArguments([
      "--runtime=claude",
      "--package=./app",
      "--agent-id=production",
    ]);

    expect(parsed.agentId).toBe("agent_existing123");
    expect(invalid.error).toBe(
      "--agent-id must be an Anthropic Agent ID beginning with 'agent_'",
    );
  });

  test("parses a Google Cloud project", () => {
    const result = parseDeployArguments([
      "--runtime",
      "gemini",
      "--package=./app",
      "--project=test-project",
    ]);

    expect(result.error).toBeUndefined();
    expect(result.projectId).toBe("test-project");
  });

  test("parses repeatable provider secret bindings", () => {
    const result = parseDeployArguments([
      "--runtime",
      "gemini",
      "--package=./app",
      "--secret-binding",
      "linear-access-token=projects/test-project/secrets/linear/versions/latest",
      "--secret-binding=notion-token=projects/test-project/secrets/notion/versions/3",
    ]);

    expect(result.error).toBeUndefined();
    expect(result.secretBindings).toEqual(
      new Map([
        [
          "linear-access-token",
          "projects/test-project/secrets/linear/versions/latest",
        ],
        [
          "notion-token",
          "projects/test-project/secrets/notion/versions/3",
        ],
      ]),
    );
  });

  test("rejects the removed secret option", () => {
    const result = parseDeployArguments([
      "--runtime=claude",
      "--package=./app",
      "--secret=linear-access-token=env:LINEAR_API_KEY",
    ]);

    expect(result.error).toBe(
      "unexpected argument '--secret=linear-access-token=env:LINEAR_API_KEY'",
    );
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
    globalThis.fetch = async (url, init) => {
      const pathname = new URL(url).pathname;
      if (pathname === "/v1/vaults/vlt_product_manager") {
        return Response.json({
          id: "vlt_product_manager",
          archived_at: null,
        });
      }
      if (pathname.endsWith("/credentials")) {
        return Response.json({
          data: [
            {
              id: "vcrd_linear",
              archived_at: null,
              auth: {
                type: "static_bearer",
                mcp_server_url: "https://mcp.linear.app/mcp",
              },
            },
          ],
          next_page: null,
        });
      }
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
          vaultId: "vlt_product_manager",
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
      "aiappctl: unsupported runtime 'openai'; supported runtimes: claude, gemini",
    );
  });
});
