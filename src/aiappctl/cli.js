#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { appManifestSchema } from "@ai-app-spec/spec/v0.1";
import { parseDocument } from "yaml";
import { deploy, parseDeployArguments } from "./commands/deploy/index.js";

const manifestFilename = "app.yaml";

function usage() {
  console.error(
    [
      "Usage:",
      "  aiappctl validate --package=<bundle-directory|app.yaml>",
      "  aiappctl deploy --runtime <claude> --package=<bundle-directory|app.yaml>",
      "  aiappctl digest <file>",
    ].join("\n"),
  );
}

function parsePackageArgument(args) {
  if (args.length === 1 && args[0].startsWith("--package=")) {
    return args[0].slice("--package=".length) || undefined;
  }

  if (args.length === 2 && args[0] === "--package") {
    return args[1] || undefined;
  }

  return undefined;
}

async function resolveManifestPath(inputPath) {
  const resolvedPath = path.resolve(inputPath);
  const inputStat = await stat(resolvedPath);

  if (inputStat.isDirectory()) {
    return path.join(resolvedPath, manifestFilename);
  }

  if (inputStat.isFile()) {
    return resolvedPath;
  }

  throw new Error(`unsupported input: ${inputPath}`);
}

function formatIssue(issue) {
  const location =
    issue.path.length === 0
      ? "/"
      : `/${issue.path
          .map((segment) =>
            String(segment).replaceAll("~", "~0").replaceAll("/", "~1"),
          )
          .join("/")}`;

  return `${location}: ${issue.message}`;
}

function isWithin(directory, candidate) {
  const relative = path.relative(directory, candidate);
  return (
    relative !== "" &&
    !relative.startsWith(`..${path.sep}`) &&
    relative !== ".." &&
    !path.isAbsolute(relative)
  );
}

async function validateLocalPackages(manifest, manifestPath) {
  const packageRoot = await realpath(path.dirname(manifestPath));
  const errors = [];
  const resolvedPackages = new Map();

  for (const [index, resource] of manifest.spec.resources.entries()) {
    const descriptor = resource.implementation.package;
    if (!descriptor.location.startsWith("./")) {
      continue;
    }

    const issuePath = `/spec/resources/${index}/implementation/package`;
    const unresolvedPath = path.resolve(packageRoot, descriptor.location);
    let resolvedPath;

    try {
      resolvedPath = await realpath(unresolvedPath);
    } catch {
      errors.push(`${issuePath}/location: package does not exist`);
      continue;
    }

    if (!isWithin(packageRoot, resolvedPath)) {
      errors.push(
        `${issuePath}/location: package resolves outside the app package`,
      );
      continue;
    }

    const packageStat = await stat(resolvedPath);
    if (!packageStat.isFile()) {
      errors.push(`${issuePath}/location: package must be a file`);
      continue;
    }

    const bytes = await readFile(resolvedPath);
    const actualDigest = `sha256:${createHash("sha256")
      .update(bytes)
      .digest("hex")}`;
    if (actualDigest !== descriptor.digest) {
      errors.push(
        `${issuePath}/digest: expected ${descriptor.digest}, got ${actualDigest}`,
      );
      continue;
    }

    resolvedPackages.set(resource.id, resolvedPath);
  }

  return { errors, resolvedPackages };
}

async function validate(inputPath) {
  const manifestPath = await resolveManifestPath(inputPath);
  const manifestSource = await readFile(manifestPath, "utf8");

  const document = parseDocument(manifestSource, {
    prettyErrors: true,
    uniqueKeys: true,
  });

  if (document.errors.length > 0) {
    return {
      manifestPath,
      errors: document.errors.map((error) => error.message),
    };
  }

  const manifest = document.toJS();
  const result = appManifestSchema.safeParse(manifest);

  if (!result.success) {
    return {
      manifestPath,
      errors: result.error.issues.map(formatIssue),
    };
  }

  const { errors, resolvedPackages } = await validateLocalPackages(
    result.data,
    manifestPath,
  );

  return {
    manifestPath,
    manifest: result.data,
    resolvedPackages,
    errors,
  };
}

async function digest(inputPath) {
  const resolvedPath = path.resolve(inputPath);
  const inputStat = await stat(resolvedPath);

  if (!inputStat.isFile()) {
    throw new Error(`not a file: ${inputPath}`);
  }

  const bytes = await readFile(resolvedPath);
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

async function main() {
  const [command, ...args] = process.argv.slice(2);

  if (command === "digest" && args.length === 1) {
    try {
      console.log(await digest(args[0]));
    } catch (error) {
      console.error(`aiappctl: ${error.message}`);
      process.exitCode = 1;
    }
    return;
  }

  if (!new Set(["validate", "deploy"]).has(command)) {
    usage();
    process.exitCode = 2;
    return;
  }

  let inputPath;
  let runtime;
  if (command === "deploy") {
    const parsed = parseDeployArguments(args);
    if (parsed.error) {
      console.error(`aiappctl: ${parsed.error}`);
      usage();
      process.exitCode = 2;
      return;
    }
    ({ inputPath, runtime } = parsed);
  } else {
    inputPath = parsePackageArgument(args);
    if (!inputPath) {
      usage();
      process.exitCode = 2;
      return;
    }
  }

  try {
    let result = await validate(inputPath);
    if (command === "deploy" && result.errors.length === 0) {
      result = await deploy(result, { runtime });
    }

    if (result.errors.length > 0) {
      const action = command === "deploy" ? "could not be deployed" : "is invalid";
      console.error(`${result.manifestPath} ${action}:`);
      for (const resource of result.deployed || []) {
        console.error(
          `- resource '${resource.id}' was already deployed as ${resource.providerId}`,
        );
      }
      for (const error of result.errors) {
        console.error(`- ${error}`);
      }
      process.exitCode = 1;
      return;
    }

    if (command === "validate") {
      console.log(`${result.manifestPath} is valid`);
      return;
    }

    for (const resource of result.deployed) {
      const version =
        resource.providerVersion === undefined
          ? ""
          : ` at version ${resource.providerVersion}`;
      console.log(
        `deployed ${resource.kind} '${resource.id}' as ${resource.providerId}${version}`,
      );
    }
  } catch (error) {
    console.error(`aiappctl: ${error.message}`);
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  await main();
}
