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
          type: "agent",
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
      type: "agent",
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

      expect(appManifestSchema.safeParse(input).success).toBe(false);
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
