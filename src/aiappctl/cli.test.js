import { describe, expect, test } from "bun:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const cliPath = fileURLToPath(new URL("./cli.js", import.meta.url));
const fixturesPath = fileURLToPath(new URL("./test/fixtures", import.meta.url));

async function run(...args) {
  const subprocess = Bun.spawn([process.execPath, cliPath, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
    subprocess.exited,
  ]);

  return { stdout, stderr, exitCode };
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
});
