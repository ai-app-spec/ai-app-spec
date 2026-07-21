#!/usr/bin/env bun

import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { parseDocument } from "yaml";

const manifestFilename = "app.yaml";
const schemaPath = fileURLToPath(
  new URL("../../spec/v0.1/app.schema.json", import.meta.url),
);

function usage() {
  console.error("Usage: aiappctl validate <bundle-directory|app.yaml>");
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

function formatSchemaError(error) {
  let location = error.instancePath || "/";

  if (error.keyword === "required") {
    location = `${location.replace(/\/$/, "")}/${error.params.missingProperty}`;
  }

  return `${location}: ${error.message}`;
}

function validateResourceGraph(manifest) {
  const errors = [];
  const resourceIds = new Set();

  for (const [index, resource] of manifest.spec.resources.entries()) {
    if (resourceIds.has(resource.id)) {
      errors.push(
        `/spec/resources/${index}/id: duplicate resource id '${resource.id}'`,
      );
    }
    resourceIds.add(resource.id);
  }

  if (!resourceIds.has(manifest.spec.entrypoint)) {
    errors.push(
      `/spec/entrypoint: resource '${manifest.spec.entrypoint}' does not exist`,
    );
  }

  return errors;
}

async function validate(inputPath) {
  const manifestPath = await resolveManifestPath(inputPath);
  const [manifestSource, schemaSource] = await Promise.all([
    readFile(manifestPath, "utf8"),
    readFile(schemaPath, "utf8"),
  ]);

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
  const schema = JSON.parse(schemaSource);
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const validateSchema = ajv.compile(schema);

  if (!validateSchema(manifest)) {
    return {
      manifestPath,
      errors: validateSchema.errors.map(formatSchemaError),
    };
  }

  return {
    manifestPath,
    errors: validateResourceGraph(manifest),
  };
}

async function main() {
  const [command, inputPath, ...extraArgs] = process.argv.slice(2);

  if (command !== "validate" || !inputPath || extraArgs.length > 0) {
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
