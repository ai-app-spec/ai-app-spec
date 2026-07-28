import { eveRuntime } from "./runtimes/eve.js";

const runtimeAdapters = new Map([[eveRuntime.name, eveRuntime]]);
const supportedRuntimes = [...runtimeAdapters.keys()].join(", ");

export function parseBuildArguments(args) {
  let inputPath;
  let outPath;
  let runtime;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];

    if (
      argument === "--package" ||
      argument === "--out" ||
      argument === "--runtime"
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
      } else if (argument === "--out") {
        if (outPath !== undefined) {
          return { error: "--out may only be specified once" };
        }
        outPath = value;
      } else {
        if (runtime !== undefined) {
          return { error: "--runtime may only be specified once" };
        }
        runtime = value;
      }

      index += 1;
      continue;
    }

    const equalsArguments = [
      ["--package=", "inputPath"],
      ["--out=", "outPath"],
      ["--runtime=", "runtime"],
    ];
    const match = equalsArguments.find(([prefix]) =>
      argument.startsWith(prefix),
    );
    if (!match) {
      return { error: `unexpected argument '${argument}'` };
    }

    const [prefix, field] = match;
    const value = argument.slice(prefix.length) || undefined;
    if (!value) {
      return { error: `${prefix.slice(0, -1)} requires a value` };
    }
    if (
      (field === "inputPath" && inputPath !== undefined) ||
      (field === "outPath" && outPath !== undefined) ||
      (field === "runtime" && runtime !== undefined)
    ) {
      return {
        error: `${prefix.slice(0, -1)} may only be specified once`,
      };
    }

    if (field === "inputPath") {
      inputPath = value;
    } else if (field === "outPath") {
      outPath = value;
    } else {
      runtime = value;
    }
  }

  if (!inputPath) {
    return { error: "--package is required" };
  }
  if (!runtime) {
    return { error: "--runtime is required" };
  }
  if (!outPath) {
    return { error: "--out is required" };
  }
  if (!runtimeAdapters.has(runtime)) {
    return {
      error: `unsupported build runtime '${runtime}'; supported runtimes: ${supportedRuntimes}`,
    };
  }

  return { inputPath, outPath, runtime };
}

export async function build(validation, options = {}) {
  const runtime = runtimeAdapters.get(options.runtime);
  if (!runtime) {
    const runtimeName = options.runtime || "<missing>";
    return {
      manifestPath: validation.manifestPath,
      errors: [
        `unsupported build runtime '${runtimeName}'; supported runtimes: ${supportedRuntimes}`,
      ],
    };
  }

  const formatErrors = validation.manifest.spec.resources.flatMap(
    (resource) => {
      if (resource.kind !== "Agent") {
        return [];
      }

      const format = resource.implementation.format;
      if (runtime.formats.has(format)) {
        return [];
      }

      return [
        `resource '${resource.id}': build runtime '${runtime.name}' does not support implementation format '${format}'; supported formats: ${[...runtime.formats].join(", ")}`,
      ];
    },
  );
  if (formatErrors.length > 0) {
    return {
      manifestPath: validation.manifestPath,
      errors: formatErrors,
    };
  }

  return runtime.build(validation, options);
}
