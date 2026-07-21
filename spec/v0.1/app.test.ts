import { describe, expect, test } from "bun:test";
import { appManifestSchema } from "./app.ts";

function manifest() {
  return {
    apiVersion: "app-spec.ai/v0.1",
    kind: "App",
    metadata: {
      name: "hello-world",
      version: "0.1.0",
    },
    spec: {
      entrypoint: "greeter",
      resources: [
        {
          id: "greeter",
          type: "agent",
          instructions: "Say hello.",
        },
      ],
    },
  };
}

describe("appManifestSchema", () => {
  test("accepts a minimal app manifest", () => {
    expect(appManifestSchema.safeParse(manifest()).success).toBe(true);
  });

  test("rejects duplicate resource ids", () => {
    const input = manifest();
    input.spec.resources.push({
      id: "greeter",
      type: "agent",
      instructions: "Say hello again.",
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
});

