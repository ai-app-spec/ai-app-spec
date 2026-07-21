#!/usr/bin/env bun

import { readFile, stat } from "node:fs/promises";
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

  return {
    manifestPath,
    errors: [],
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
