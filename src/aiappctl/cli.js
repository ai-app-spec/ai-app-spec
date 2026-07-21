#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { appManifestSchema } from "@ai-app-spec/spec/v0.1";
import { parseDocument } from "yaml";

const manifestFilename = "app.yaml";

function usage() {
  console.error(
    "Usage: aiappctl validate --package=<bundle-directory|app.yaml>",
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
    }
  }

  return errors;
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

  const packageErrors = await validateLocalPackages(result.data, manifestPath);

  return {
    manifestPath,
    errors: packageErrors,
  };
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const inputPath = parsePackageArgument(args);

  if (command !== "validate" || !inputPath) {
    usage();
    process.exitCode = 2;
    return;
  }

  try {
    const result = await validate(inputPath);

    if (result.errors.length > 0) {
      console.error(`${result.manifestPath} is invalid:`);
      for (const error of result.errors) {
        console.error(`- ${error}`);
      }
      process.exitCode = 1;
      return;
    }

    console.log(`${result.manifestPath} is valid`);
  } catch (error) {
    console.error(`aiappctl: ${error.message}`);
    process.exitCode = 1;
  }
}

await main();
