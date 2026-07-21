# Specification

The initial specification uses YAML for app manifests and JSON Schema for structural validation.

An unpacked app bundle is a directory with an `app.yaml` manifest at its root:

```text
my-app/
└── app.yaml
```

The canonical archive encoding will be ZIP, whose archive root has the same layout. Version 0.1 of the CLI validates unpacked directories and individual `app.yaml` files; archive creation and validation are intentionally deferred.

The current schema is [`v0.1/app.schema.json`](v0.1/app.schema.json). It supports one resource type, `agent`, and intentionally relies on the target runtime's default inference configuration.

Run the reference validator from the repository root:

```sh
cd src/aiappctl
bun install
bun run validate:example
```
