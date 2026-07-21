# Specification

The authoritative version 0.1 specification is composed from Zod schemas in [`v0.1/app.ts`](v0.1/app.ts). [`v0.1/app.schema.json`](v0.1/app.schema.json) is a generated structural JSON Schema artifact for tools that cannot consume the code package directly. Cross-resource invariants such as unique resource IDs and entrypoint resolution are expressed as Zod refinements.

An unpacked app bundle is a directory with an `app.yaml` manifest at its root:

```text
my-app/
├── app.yaml
└── packages/
    └── agent.pkg
```

The canonical archive encoding will be ZIP, whose archive root has the same layout. Version 0.1 of the CLI validates unpacked directories and individual `app.yaml` files; archive creation and validation are intentionally deferred. For package-relative implementation locations, validation also checks containment, file existence, and SHA-256 integrity. External package locations are not fetched during local validation.

The current schema supports one resource type, `agent`. An agent identifies its implementation with a namespaced format and an immutable package descriptor. A package location may be relative to the app bundle or an absolute URI; `file:` URIs are not portable and are rejected. The format's runtime adapter owns interpretation of the package contents.

The specification does not define build inputs, container implementation details, deployment topology, scaling, or resource-allocation policy. These remain responsibilities of tooling and the target runtime.

Generate and test the specification:

```sh
cd spec
bun install
bun run generate
bun test
```

CI runs `bun run generate:check` to ensure the checked-in JSON Schema matches the Zod source.

Run the reference validator from the repository root:

```sh
cd src/aiappctl
bun install
bun run validate --package=../../examples/hello-oci
```
