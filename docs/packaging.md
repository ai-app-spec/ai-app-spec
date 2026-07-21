# Packaging agent implementations

AI App Spec treats an agent implementation as an immutable package, not as a set of fields that reconstruct its internal logic or deployment procedure. The app manifest identifies the package's format, location, and digest. A format adapter determines how to interpret its bytes.

This boundary keeps agent frameworks and provider APIs out of the core schema. It also keeps container construction, isolation, placement, scaling, and warm capacity under runtime and operator control.

## A canonical portable format

The intended portable target is a standard agent package based on the OCI image format, provisionally identified as `app-spec.ai/agent-container:v1`. Its format specification will define both the OCI representation and the agent invocation contract; an arbitrary OCI image is not sufficient because it does not define how an AI application runtime invokes or communicates with the agent.

OCI supplies a mature, content-addressed distribution format and a practical boundary for untrusted executable code. It does not require AI App Spec to define a container engine. A runtime remains free to use its native isolation technology, admission policy, and operational model when realizing the package.

## Namespaced formats and adapters

Provider- and framework-specific formats remain useful and are identified with namespaced format identifiers, for example `anthropic.com/managed-agent:v1`. Their internal schemas do not become part of AI App Spec.

To participate in the portable ecosystem, a non-core format should provide an adapter that hoists its package into the canonical OCI agent format:

```text
provider or framework package
             |
        format adapter
             |
             v
app-spec.ai/agent-container:v1
             |
     compatible runtimes
```

This lets a runtime provider support only the canonical format while packaging tools handle the diversity of agent frameworks and provider-native definitions. An adapter is a packaging-stage compiler, not a runtime provider: it resolves the source package, validates its format, supplies any required harness and dependencies, and emits an immutable OCI package with a new digest.

Conversion must be explicit and fail closed. An adapter must not silently discard unsupported tools, callbacks, delegation behavior, security constraints, or lifecycle semantics. Some provider-native packages may depend on an external service rather than becoming self-contained; an adapter must preserve that dependency visibly or report that portable conversion is unavailable.

The converted package should retain provenance linking its input package, adapter identity and version, and output digest. Signature trust, admission policy, vulnerability policy, and allowed resource consumption remain runtime or operator concerns.

## Manifest boundary

The manifest carries only the implementation descriptor:

```yaml
implementation:
  format: app-spec.ai/agent-container:v1
  package:
    location: oci://ghcr.io/example/researcher
    digest: sha256:...
```

Package-relative locations may identify bytes shipped inside the app package. Absolute locations may identify content in an external distribution system. The manifest does not contain Dockerfiles, build arguments, runtime topology, container-engine configuration, or capacity settings.

Future tooling may automatically discover adapters and produce a deployment-ready canonical package, but the adapter protocol and OCI agent invocation contract are intentionally deferred until they can be exercised against working runtime implementations.
