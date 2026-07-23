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

export const resourceReferenceSchema = z
  .strictObject({
    ref: identifierSchema,
  })
  .meta({ id: "ResourceReference" });

export const secretReferenceSchema = z
  .strictObject({
    ref: identifierSchema,
  })
  .meta({ id: "SecretReference" });

export const secretRequirementSchema = z
  .strictObject({
    id: identifierSchema,
    description: z.string().min(1).optional(),
  })
  .meta({ id: "SecretRequirement" });

export const executionEnvironmentReferenceSchema = z
  .strictObject({
    ref: identifierSchema,
  })
  .meta({ id: "ExecutionEnvironmentReference" });

export const executionEnvironmentRequirementSchema = z
  .strictObject({
    id: identifierSchema,
    description: z.string().min(1).optional(),
  })
  .meta({ id: "ExecutionEnvironmentRequirement" });

export const requirementsSchema = z
  .union([
    z.strictObject({
      secrets: z.array(secretRequirementSchema).min(1),
      executionEnvironments: z
        .array(executionEnvironmentRequirementSchema)
        .min(1)
        .optional(),
    }),
    z.strictObject({
      secrets: z.array(secretRequirementSchema).min(1).optional(),
      executionEnvironments: z
        .array(executionEnvironmentRequirementSchema)
        .min(1),
    }),
  ])
  .meta({ id: "Requirements" });

export const agentResourceSchema = z
  .strictObject({
    id: identifierSchema,
    kind: z.literal("Agent"),
    executionEnvironment: executionEnvironmentReferenceSchema.optional(),
    tools: z.array(resourceReferenceSchema).min(1).optional(),
    implementation: agentImplementationSchema,
  })
  .meta({ id: "AgentResource" });

export const mcpServerUrlSchema = z
  .intersection(
    z.url(),
    z.string().max(2048).regex(/^https:\/\//),
  )
  .superRefine((value, context) => {
    const url = new URL(value);

    if (url.username || url.password) {
      context.addIssue({
        code: "custom",
        message: "must not contain embedded credentials",
      });
    }

    if (url.hash) {
      context.addIssue({
        code: "custom",
        message: "must not contain a fragment",
      });
    }
  })
  .meta({ id: "MCPServerUrl" });

export const mcpServerConnectionSchema = z
  .strictObject({
    type: z.literal("url"),
    url: mcpServerUrlSchema,
  })
  .meta({ id: "MCPServerConnection" });

export const mcpServerAuthenticationSchema = z
  .strictObject({
    type: z.literal("bearer"),
    secret: secretReferenceSchema,
  })
  .meta({ id: "MCPServerAuthentication" });

export const mcpServerResourceSchema = z
  .strictObject({
    id: identifierSchema,
    kind: z.literal("MCPServer"),
    connection: mcpServerConnectionSchema,
    authentication: mcpServerAuthenticationSchema.optional(),
  })
  .meta({ id: "MCPServerResource" });

export const resourceSchema = z
  .discriminatedUnion("kind", [agentResourceSchema, mcpServerResourceSchema])
  .meta({ id: "Resource" });

export const appSpecSchema = z
  .strictObject({
    entrypoint: identifierSchema,
    requirements: requirementsSchema.optional(),
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
    const resourcesById = new Map<
      string,
      (typeof manifest.spec.resources)[number]
    >();
    const secretsById = new Map<
      string,
      NonNullable<
        NonNullable<typeof manifest.spec.requirements>["secrets"]
      >[number]
    >();
    const executionEnvironmentsById = new Map<
      string,
      NonNullable<
        NonNullable<
          typeof manifest.spec.requirements
        >["executionEnvironments"]
      >[number]
    >();

    for (const [index, secret] of (
      manifest.spec.requirements?.secrets || []
    ).entries()) {
      if (secretsById.has(secret.id)) {
        context.addIssue({
          code: "custom",
          path: ["spec", "requirements", "secrets", index, "id"],
          message: `duplicate secret requirement id '${secret.id}'`,
        });
      } else {
        secretsById.set(secret.id, secret);
      }
    }

    for (const [index, executionEnvironment] of (
      manifest.spec.requirements?.executionEnvironments || []
    ).entries()) {
      if (executionEnvironmentsById.has(executionEnvironment.id)) {
        context.addIssue({
          code: "custom",
          path: [
            "spec",
            "requirements",
            "executionEnvironments",
            index,
            "id",
          ],
          message: `duplicate execution environment requirement id '${executionEnvironment.id}'`,
        });
      } else {
        executionEnvironmentsById.set(
          executionEnvironment.id,
          executionEnvironment,
        );
      }
    }

    for (const [index, resource] of manifest.spec.resources.entries()) {
      if (resourcesById.has(resource.id)) {
        context.addIssue({
          code: "custom",
          path: ["spec", "resources", index, "id"],
          message: `duplicate resource id '${resource.id}'`,
        });
      } else {
        resourcesById.set(resource.id, resource);
      }
    }

    const entrypoint = resourcesById.get(manifest.spec.entrypoint);
    // TODO(resource-dispatch): Revisit the Agent-only entrypoint constraint when
    // resource kinds have explicit execution semantics.
    if (!entrypoint) {
      context.addIssue({
        code: "custom",
        path: ["spec", "entrypoint"],
        message: `resource '${manifest.spec.entrypoint}' does not exist`,
      });
    } else if (entrypoint.kind !== "Agent") {
      context.addIssue({
        code: "custom",
        path: ["spec", "entrypoint"],
        message: `resource '${manifest.spec.entrypoint}' is not an Agent`,
      });
    }

    for (const [resourceIndex, resource] of manifest.spec.resources.entries()) {
      // TODO(resource-dispatch): Move MCPServer reference checks into a
      // kind-specific semantic validator instead of branching over all resources.
      if (resource.kind === "MCPServer" && resource.authentication) {
        const secretRef = resource.authentication.secret.ref;
        if (!secretsById.has(secretRef)) {
          context.addIssue({
            code: "custom",
            path: [
              "spec",
              "resources",
              resourceIndex,
              "authentication",
              "secret",
              "ref",
            ],
            message: `secret requirement '${secretRef}' does not exist`,
          });
        }
      }

      // TODO(resource-dispatch): Move Agent reference checks into a
      // kind-specific semantic validator instead of branching over all resources.
      if (resource.kind !== "Agent") {
        continue;
      }

      if (
        resource.executionEnvironment &&
        !executionEnvironmentsById.has(resource.executionEnvironment.ref)
      ) {
        context.addIssue({
          code: "custom",
          path: [
            "spec",
            "resources",
            resourceIndex,
            "executionEnvironment",
            "ref",
          ],
          message: `execution environment requirement '${resource.executionEnvironment.ref}' does not exist`,
        });
      }

      if (!resource.tools) {
        continue;
      }

      const toolReferences = new Set<string>();
      for (const [toolIndex, tool] of resource.tools.entries()) {
        const path = [
          "spec",
          "resources",
          resourceIndex,
          "tools",
          toolIndex,
          "ref",
        ];

        if (toolReferences.has(tool.ref)) {
          context.addIssue({
            code: "custom",
            path,
            message: `duplicate tool resource reference '${tool.ref}'`,
          });
          continue;
        }
        toolReferences.add(tool.ref);

        const target = resourcesById.get(tool.ref);
        if (!target) {
          context.addIssue({
            code: "custom",
            path,
            message: `resource '${tool.ref}' does not exist`,
          });
        } else if (target.kind !== "MCPServer") {
          context.addIssue({
            code: "custom",
            path,
            message: `resource '${tool.ref}' is not an MCPServer`,
          });
        }
      }
    }
  },
);

export type AppManifest = z.infer<typeof appManifestSchema>;
