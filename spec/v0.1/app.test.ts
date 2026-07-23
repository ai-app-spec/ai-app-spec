import { describe, expect, test } from "bun:test";
import { appManifestSchema } from "./app.ts";

function manifest() {
  return {
    apiVersion: "app-spec.ai/v0.1",
    kind: "App",
    metadata: {
      name: "hello-oci",
      version: "0.1.0",
    },
    spec: {
      entrypoint: "greeter",
      resources: [
        {
          id: "greeter",
          kind: "Agent",
          implementation: {
            format: "app-spec.ai/agent-container:v1",
            package: {
              location: "oci://registry.example.com/ai-app-spec/hello-oci",
              digest:
                "sha256:0000000000000000000000000000000000000000000000000000000000000000",
            },
          },
        },
      ],
    },
  };
}

describe("appManifestSchema", () => {
  test("accepts a minimal app manifest", () => {
    expect(appManifestSchema.safeParse(manifest()).success).toBe(true);
  });

  test("accepts SemVer prerelease and build metadata", () => {
    for (const version of [
      "1.2.3-alpha1",
      "1.2.3-alpha.1",
      "1.2.3-alpha.1+build.5",
    ]) {
      const input = manifest();
      input.metadata.version = version;

      expect(appManifestSchema.safeParse(input).success).toBe(true);
    }
  });

  test("rejects malformed SemVer prereleases", () => {
    for (const version of ["1.0.0-.", "1.0.0-alpha.", "1.0.0-01"]) {
      const input = manifest();
      input.metadata.version = version;

      expect(appManifestSchema.safeParse(input).success).toBe(false);
    }
  });

  test("limits identifiers to 63 characters", () => {
    const accepted = manifest();
    accepted.metadata.name = "a".repeat(63);

    const rejected = manifest();
    rejected.metadata.name = "a".repeat(64);

    expect(appManifestSchema.safeParse(accepted).success).toBe(true);
    expect(appManifestSchema.safeParse(rejected).success).toBe(false);
  });

  test("limits versions to 255 characters", () => {
    const accepted = manifest();
    accepted.metadata.version = `1.0.0-${"a".repeat(249)}`;

    const rejected = manifest();
    rejected.metadata.version = `1.0.0-${"a".repeat(250)}`;

    expect(appManifestSchema.safeParse(accepted).success).toBe(true);
    expect(appManifestSchema.safeParse(rejected).success).toBe(false);
  });

  test("rejects duplicate resource ids", () => {
    const input = manifest();
    input.spec.resources.push({
      id: "greeter",
      kind: "Agent",
      implementation: {
        format: "app-spec.ai/agent-container:v1",
        package: {
          location: "oci://registry.example.com/ai-app-spec/other",
          digest:
            "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        },
      },
    });

    const result = appManifestSchema.safeParse(input);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual([
        "spec",
        "resources",
        1,
        "id",
      ]);
    }
  });

  test("rejects an unresolved entrypoint", () => {
    const input = manifest();
    input.spec.entrypoint = "missing";

    const result = appManifestSchema.safeParse(input);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(["spec", "entrypoint"]);
    }
  });

  test("accepts an Agent using an MCPServer", () => {
    const input: any = manifest();
    input.spec.resources[0].tools = [{ ref: "linear" }];
    input.spec.resources.push({
      id: "linear",
      kind: "MCPServer",
      connection: {
        type: "url",
        url: "https://mcp.linear.app/mcp",
      },
    });

    expect(appManifestSchema.safeParse(input).success).toBe(true);
  });

  test("accepts an MCPServer with a bearer secret requirement", () => {
    const input: any = manifest();
    input.spec.requirements = {
      secrets: [
        {
          id: "linear-access-token",
          description: "Linear API key or OAuth access token.",
        },
      ],
    };
    input.spec.resources[0].tools = [{ ref: "linear" }];
    input.spec.resources.push({
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
    });

    expect(appManifestSchema.safeParse(input).success).toBe(true);
  });

  test("accepts an Agent with an execution environment requirement", () => {
    const input: any = manifest();
    input.spec.requirements = {
      executionEnvironments: [
        {
          id: "agent-sandbox",
          description: "Isolated sandbox for agent execution.",
          networking: {
            mcpServers: true,
          },
        },
      ],
    };
    input.spec.resources[0].executionEnvironment = {
      ref: "agent-sandbox",
    };

    expect(appManifestSchema.safeParse(input).success).toBe(true);
  });

  test("defaults optional MCP server access to false", () => {
    for (const networking of [{}, { mcpServers: false }]) {
      const input: any = manifest();
      input.spec.requirements = {
        executionEnvironments: [
          {
            id: "agent-sandbox",
            networking,
          },
        ],
      };

      const result = appManifestSchema.safeParse(input);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(
          result.data.spec.requirements?.executionEnvironments?.[0]
            ?.networking?.mcpServers ?? false,
        ).toBe(false);
      }
    }
  });

  test("rejects empty requirements", () => {
    const input: any = manifest();
    input.spec.requirements = {};

    expect(appManifestSchema.safeParse(input).success).toBe(false);
  });

  test("rejects unresolved and duplicate execution environment requirements", () => {
    const input: any = manifest();
    input.spec.requirements = {
      executionEnvironments: [
        { id: "agent-sandbox" },
        { id: "agent-sandbox" },
      ],
    };
    input.spec.resources[0].executionEnvironment = {
      ref: "missing-sandbox",
    };

    const result = appManifestSchema.safeParse(input);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.message)).toEqual([
        "duplicate execution environment requirement id 'agent-sandbox'",
        "execution environment requirement 'missing-sandbox' does not exist",
      ]);
    }
  });

  test("rejects unresolved and duplicate secret requirements", () => {
    const input: any = manifest();
    input.spec.requirements = {
      secrets: [{ id: "linear-token" }, { id: "linear-token" }],
    };
    input.spec.resources.push({
      id: "linear",
      kind: "MCPServer",
      connection: {
        type: "url",
        url: "https://mcp.linear.app/mcp",
      },
      authentication: {
        type: "bearer",
        secret: { ref: "missing-token" },
      },
    });

    const result = appManifestSchema.safeParse(input);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.message)).toEqual([
        "duplicate secret requirement id 'linear-token'",
        "secret requirement 'missing-token' does not exist",
      ]);
    }
  });

  test("rejects an MCPServer as the entrypoint", () => {
    const input: any = manifest();
    input.spec.entrypoint = "linear";
    input.spec.resources.push({
      id: "linear",
      kind: "MCPServer",
      connection: {
        type: "url",
        url: "https://mcp.linear.app/mcp",
      },
    });

    const result = appManifestSchema.safeParse(input);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(["spec", "entrypoint"]);
      expect(result.error.issues[0]?.message).toBe(
        "resource 'linear' is not an Agent",
      );
    }
  });

  test("rejects unresolved, mistyped, and duplicate tool references", () => {
    const input: any = manifest();
    input.spec.resources[0].tools = [
      { ref: "missing" },
      { ref: "greeter" },
      { ref: "missing" },
    ];

    const result = appManifestSchema.safeParse(input);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.message)).toEqual([
        "resource 'missing' does not exist",
        "resource 'greeter' is not an MCPServer",
        "duplicate tool resource reference 'missing'",
      ]);
    }
  });

  test("requires secure MCPServer endpoint URLs", () => {
    for (const url of [
      "http://mcp.linear.app/mcp",
      "https://user:password@mcp.linear.app/mcp",
      "https://mcp.linear.app/mcp#tools",
    ]) {
      const input: any = manifest();
      input.spec.resources.push({
        id: "linear",
        kind: "MCPServer",
        connection: { type: "url", url },
      });

      const result = appManifestSchema.safeParse(input);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.path).toEqual([
          "spec",
          "resources",
          1,
          "connection",
          "url",
        ]);
      }
    }
  });

  test("rejects unknown fields", () => {
    const input = { ...manifest(), unknown: true };

    expect(appManifestSchema.safeParse(input).success).toBe(false);
  });

  test("accepts a package-relative implementation location", () => {
    const input = manifest();
    input.spec.resources[0]!.implementation.package.location =
      "./packages/greeter.agentpkg";

    expect(appManifestSchema.safeParse(input).success).toBe(true);
  });

  test("rejects file URIs and package-relative traversal", () => {
    for (const location of [
      "file:///tmp/greeter",
      "FILE:///tmp/greeter",
      "C:\\packages\\greeter.txt",
      "../greeter.txt",
    ]) {
      const input = manifest();
      input.spec.resources[0]!.implementation.package.location = location;

      const result = appManifestSchema.safeParse(input);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.message).toBe(
          "must be a package-relative path (./...) or an absolute URI",
        );
      }
    }
  });

  test("rejects unnamespaced implementation formats", () => {
    const input = manifest();
    input.spec.resources[0]!.implementation.format = "agent:v1";

    expect(appManifestSchema.safeParse(input).success).toBe(false);
  });

  test("rejects malformed package digests", () => {
    const input = manifest();
    input.spec.resources[0]!.implementation.package.digest = "sha256:abc123";

    expect(appManifestSchema.safeParse(input).success).toBe(false);
  });
});
