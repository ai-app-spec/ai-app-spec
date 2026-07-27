import { claudeRuntime } from "./runtimes/claude.js";

const runtimeAdapters = new Map([[claudeRuntime.name, claudeRuntime]]);
const supportedRuntimes = [...runtimeAdapters.keys()].join(", ");

export function parseDeployArguments(args) {
  let inputPath;
  let runtime;
  let environmentId;
  let vaultId;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];

    if (
      argument === "--package" ||
      argument === "--runtime" ||
      argument === "--environment-id" ||
      argument === "--vault-id"
    ) {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        return { error: `${argument} requires a value` };
      }

      if (argument === "--package") {
        if (inputPath !== undefined) {
          return { error: "--package may only be specified once" };
        }
        inputPath = value;
      } else if (argument === "--runtime") {
        if (runtime !== undefined) {
          return { error: "--runtime may only be specified once" };
        }
        runtime = value;
      } else if (argument === "--environment-id") {
        if (environmentId !== undefined) {
          return { error: "--environment-id may only be specified once" };
        }
        environmentId = value;
      } else if (argument === "--vault-id") {
        if (vaultId !== undefined) {
          return { error: "--vault-id may only be specified once" };
        }
        vaultId = value;
      }

      index += 1;
      continue;
    }

    if (argument.startsWith("--package=")) {
      if (inputPath !== undefined) {
        return { error: "--package may only be specified once" };
      }
      inputPath = argument.slice("--package=".length) || undefined;
      if (!inputPath) {
        return { error: "--package requires a value" };
      }
      continue;
    }

    if (argument.startsWith("--runtime=")) {
      if (runtime !== undefined) {
        return { error: "--runtime may only be specified once" };
      }
      runtime = argument.slice("--runtime=".length) || undefined;
      if (!runtime) {
        return { error: "--runtime requires a value" };
      }
      continue;
    }

    if (argument.startsWith("--vault-id=")) {
      if (vaultId !== undefined) {
        return { error: "--vault-id may only be specified once" };
      }
      vaultId = argument.slice("--vault-id=".length) || undefined;
      if (!vaultId) {
        return { error: "--vault-id requires a value" };
      }
      continue;
    }

    if (argument.startsWith("--environment-id=")) {
      if (environmentId !== undefined) {
        return { error: "--environment-id may only be specified once" };
      }
      environmentId =
        argument.slice("--environment-id=".length) || undefined;
      if (!environmentId) {
        return { error: "--environment-id requires a value" };
      }
      continue;
    }

    return { error: `unexpected argument '${argument}'` };
  }

  if (!inputPath) {
    return { error: "--package is required" };
  }
  if (!runtime) {
    return { error: "--runtime is required" };
  }
  if (!runtimeAdapters.has(runtime)) {
    return {
      error: `unsupported runtime '${runtime}'; supported runtimes: ${supportedRuntimes}`,
    };
  }

  return {
    inputPath,
    runtime,
    environmentId,
    vaultId,
  };
}

export async function deploy(validation, options = {}) {
  const runtime = runtimeAdapters.get(options.runtime);
  if (!runtime) {
    const runtimeName = options.runtime || "<missing>";
    return {
      manifestPath: validation.manifestPath,
      errors: [
        `unsupported runtime '${runtimeName}'; supported runtimes: ${supportedRuntimes}`,
      ],
    };
  }

  const formatErrors = validation.manifest.spec.resources.flatMap(
    (resource) => {
      // TODO(resource-dispatch): Delegate preflight to kind-specific deployers
      // instead of filtering a heterogeneous resource collection here.
      if (resource.kind !== "Agent") {
        return [];
      }

      const format = resource.implementation.format;
      if (runtime.formats.has(format)) {
        return [];
      }

      return [
        `resource '${resource.id}': runtime '${runtime.name}' does not support implementation format '${format}'; supported formats: ${[...runtime.formats].join(", ")}`,
      ];
    },
  );
  if (formatErrors.length > 0) {
    return {
      manifestPath: validation.manifestPath,
      errors: formatErrors,
    };
  }

  return runtime.deploy(validation, options);
}
