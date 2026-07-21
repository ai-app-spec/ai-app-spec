import * as z from "zod";

export const apiVersion = "app-spec.ai/v0.1" as const;
export const jsonSchemaId =
  "https://app-spec.ai/spec/v0.1/app.schema.json" as const;

export const apiVersionSchema = z.literal(apiVersion).meta({ id: "ApiVersion" });
export const appKindSchema = z.literal("App").meta({ id: "AppKind" });

export const identifierSchema = z
  .string()
  .max(63)
  .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/)
  .meta({ id: "Identifier" });

export const semanticVersionSchema = z
  .string()
  .max(255)
  .regex(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/,
  )
  .meta({ id: "SemanticVersion" });

export const metadataSchema = z
  .strictObject({
    name: identifierSchema,
    version: semanticVersionSchema,
    description: z.string().min(1).optional(),
  })
  .meta({ id: "Metadata" });

export const implementationFormatSchema = z
  .string()
  .max(255)
  .regex(
    /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\/[a-z][a-z0-9]*(?:-[a-z0-9]+)*:v(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)){0,2}$/,
  )
  .meta({ id: "ImplementationFormat" });

export const packageRelativeLocationSchema = z
  .string()
  .max(2048)
  .regex(
    /^\.\/[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?(?:\/[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)*$/,
  )
  .meta({ id: "PackageRelativeLocation" });

export const absolutePackageLocationSchema = z
  .string()
  .max(2048)
  .regex(
    /^(?![Ff][Ii][Ll][Ee]:)(?![A-Za-z]:[\\/])[A-Za-z][A-Za-z0-9+.-]*:[^\s\\]+$/,
  )
  .meta({ id: "AbsolutePackageLocation" });

export const packageLocationSchema = z
  .union([packageRelativeLocationSchema, absolutePackageLocationSchema], {
    error: "must be a package-relative path (./...) or an absolute URI",
  })
  .meta({ id: "PackageLocation" });

export const sha256DigestSchema = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/)
  .meta({ id: "Sha256Digest" });

export const implementationPackageSchema = z
  .strictObject({
    location: packageLocationSchema,
    digest: sha256DigestSchema,
  })
  .meta({ id: "ImplementationPackage" });

export const agentImplementationSchema = z
  .strictObject({
    format: implementationFormatSchema,
    package: implementationPackageSchema,
  })
  .meta({ id: "AgentImplementation" });

export const agentResourceSchema = z
  .strictObject({
    id: identifierSchema,
    kind: z.literal("Agent"),
    implementation: agentImplementationSchema,
  })
  .meta({ id: "AgentResource" });

export const resourceSchema = agentResourceSchema;

export const appSpecSchema = z
  .strictObject({
    entrypoint: identifierSchema,
    resources: z.array(resourceSchema).min(1),
  })
  .meta({ id: "AppSpec" });

export const appManifestStructuralSchema = z
  .strictObject({
    apiVersion: apiVersionSchema,
    kind: appKindSchema,
    metadata: metadataSchema,
    spec: appSpecSchema,
  })
  .meta({
    title: "AI App Manifest",
    description: "An AI App Spec version 0.1 manifest.",
  });

export const appManifestSchema = appManifestStructuralSchema.superRefine(
  (manifest, context) => {
    const resourceIds = new Set<string>();

    for (const [index, resource] of manifest.spec.resources.entries()) {
      if (resourceIds.has(resource.id)) {
        context.addIssue({
          code: "custom",
          path: ["spec", "resources", index, "id"],
          message: `duplicate resource id '${resource.id}'`,
        });
      }
      resourceIds.add(resource.id);
    }

    if (!resourceIds.has(manifest.spec.entrypoint)) {
      context.addIssue({
        code: "custom",
        path: ["spec", "entrypoint"],
        message: `resource '${manifest.spec.entrypoint}' does not exist`,
      });
    }
  },
);

export type AppManifest = z.infer<typeof appManifestSchema>;
