# AI App Spec concepts

> [!NOTE]
> AI App Spec treats an **AI application** as an assembly of resources that is deployable to a compatible **AI application runtime**.

## Goals

- define the conceptual model for an AI application runtime
- identify the portable primitives an AI application runtime provides
- establish what belongs in an app package
- define the boundary between a portable specification and a runtime provider

## Non-goals

- define a universal internal architecture for AI runtimes
- standardize model behavior or guarantee deterministic outputs
- replace existing tool, API, identity, authentication, skill, container, or observability protocols and standard formats
- require every app to run unchanged on every provider
- define marketplace discovery, or any commercial terms between ecosystem participants

## The AI application runtime

An **AI application runtime** turns models, tools, instructions, state, compute, and policy into an application that people and other systems can use over time.

The runtime is the governed environment in which an app operates. It authenticates actors, resolves and marshals configured resources, mediates access to models and external systems, executes attended and background work, persists state and outputs, and makes activity observable. A runtime may be a hosted product, an enterprise control plane, or a local implementation. The specification intends to be agnostic of the provider service topology.

A runtime has two cooperating planes.

1. The **control plane** installs packages, validates capabilities, binds configuration and resources, applies policy, manages versions, and reports deployment status.
1. The **execution plane** runs sessions and jobs, invokes models and tools, manages work contexts, persists results, and emits operational and audit events.

These are responsibility boundaries, not necessarily deployment boundaries.

## Core terms

| Term | Meaning |
| --- | --- |
| **App** | A named product or capability designed by a publisher and expressed as a related set of runtime resources. |
| **Package** | An immutable, versioned distribution of an app definition and associated portable assets. |
| **Resource** | A logical component of an app, such as an agent, workflow, skill, tool, schedule, or artifact definition. |
| **Runtime** | The governed environment that realizes and operates app resources. |
| **Runtime provider** | An implementation of the runtime contract. Providers can differ substantially in architecture and native capabilities. |
| **Target** | A concrete runtime environment into which an app can be deployed, such as an organization, account, project, or local instance. |
| **Installation** | A package deployed to a target with target-specific configuration, permissions, and bindings. |
| **Binding** | The resolution of a logical app requirement to a concrete runtime-managed or customer-managed resource. |
| **Capability** | A feature or semantic contract a runtime advertises and an app may require or optionally use. |
| **Execution** | An individual session, task, run, or scheduled invocation produced by an installed app. |

A package is publisher-authored and reusable. An installation is customer-specific. Executions are protected runtime state.

## The runtime primitive model

AI runtimes are converging on a common set of responsibilities even as their APIs and product surfaces diverge. The specification targets common portable primitives.

| Primitive | App-level intent | Runtime responsibility |
| --- | --- | --- |
| **Agents** | Identify a packaged agent implementation and its portable invocation contract. | Resolve a supported package format, instantiate the implementation, provide scoped access to runtime capabilities, and manage execution, limits, interruption, and telemetry. |
| **Workflows** | Define explicit coordination among agent, tool, human, and deterministic steps, including ordering, branching, and data flow. | Orchestrate steps, persist progress, pass data between them, and enforce retry, timeout, concurrency, and failure policies. |
| **Inference** | Declare required model capabilities or profiles. | Select models, hold provider credentials, route requests, enforce budgets, and handle availability policy. |
| **Tools and connectors** | Declare callable capabilities and the external systems the app expects to reach. | Discover implementations, authenticate and authorize connections, validate inputs, mediate calls, and return typed results. |
| **Skills and context** | Package or reference reusable instructions, domain knowledge, and context-loading behavior. | Resolve, index, scope, and load the right material into an execution. |
| **Memory** | Declare persistent memory requirements and the scopes in which memory may be read or written. | Store, retrieve, and isolate memory while enforcing access, provenance, and retention policy. |
| **Execution environment** | Declare code, filesystem, dependency, network, or isolation requirements. | Provision sandboxes or other logical isolation boundary, constrain resources and egress, collect outputs. |
| **Automation and triggers** | Define events, retries, or conditions that initiate deferred and scheduled work. | Deliver triggers durably, control concurrency, retry safely, and record outcomes. |
| **Artifacts** | Define durable inputs and outputs such as documents, files, generated assets, or structured results. | Store content and metadata, enforce access control, manage provenance and lifecycle. |
| **Interaction and delivery** | Declare human entry points, notifications, approval steps, or supported channels. | Render or route interactions through native clients and connected channels while preserving identity. |
| **Configuration and secrets** | Define typed configuration and secret requirements without embedding customer values. | Collect and validate values, store secrets securely, and inject them only where authorized. |

Not every app needs every primitive, and not every runtime will support every primitive initially. In order to provide value, this specification needs a small common core plus an explicit way to negotiate additional capabilities.

## Apps are resource graphs

An app is a graph of resources and references whose edges express dependencies: an agent uses a skill, a workflow invokes a tool, a schedule starts a workflow, and a generated artifact is delivered through a channel.

Resources can come from different places:

- **Packaged resources** travel with the app, such as implementation packages, schemas, or static skill content.
- **Runtime resources** are supplied by the provider, such as model profiles, sandbox classes, storage, or native interaction surfaces.
- **Bound resources** are selected by the installing organization, such as an app connection, knowledge source, identity group, or secret.
- **External resources** remain outside the runtime but are reached through a governed connector or protocol.

The package identifies and references resources using stable logical names. The runtime provider resolves the graph for each installation and maintains the mapping between portable identifiers and provider-native object identifiers.

## Implementation packages

The app manifest does not reproduce an agent's logic, framework configuration, dependencies, or deployment procedure. An agent resource instead identifies an immutable implementation package using:

- a namespaced, versioned **format** that selects a compatible runtime adapter
- a **location** that is either package-relative or an absolute URI
- a content **digest** that establishes identity and integrity

The package format defines how its bytes are interpreted. A portable container format can use an OCI image together with a standard agent invocation contract. Provider-native formats can package concepts such as a managed-agent definition without adding their fields to the core app schema. Implementations built with agent frameworks can be distributed through either kind of format.

Package-relative locations resolve only within the app package. Absolute filesystem paths and `file:` URIs are not portable package references. External locations remain subject to runtime resolution and admission policy.

The specification does not define container construction or isolation, compute allocation, placement, scaling, warm capacity, or provider deployment topology. Those are runtime and operator concerns. An app may eventually declare portable capability requirements, but cannot commit runtime resources through its implementation descriptor.

See [Packaging agent implementations](packaging.md) for the canonical OCI package direction and the role of provider- and framework-format adapters.

## Runtime provider bindings

A runtime provider binding translates the portable contract into a provider's native concepts.

Bindings must support:

- capability discovery
- package and target validation
- deployment planning
- creation or reconciliation of an installation
- inspection of installation status and outputs
- suspension or removal with explicit state handling

A provider may implement a core resource directly, map it to several native resources, or reject it as unsupported. Provider-specific behavior lives behind declared capabilities and namespaced extensions, validated through conformance testing.

## The package-runtime contract

The package describes **what** constitutes the app and **what** it requires. The runtime decides **how** to realize those requirements safely on a target.

The package is responsible for declaring:

- app identity, version, and compatibility information
- the logical resource graph and its entry points
- immutable implementation packages, their formats, locations, and digests
- required and optional runtime capabilities
- typed configuration and secret requirements
- requested permissions and human-approval points
- portable assets, defaults, and provider extensions
- lifecycle constraints that affect safe installation or upgrade

The end user operator is responsible for supplying:

- environment-specific configuration
- bindings to data, connectors, identity groups, and secrets
- grants for requested permissions
- policy choices and allowed overrides
- the decision to install, activate, upgrade, suspend, or remove the app.

The runtime (runtime provider) is responsible for:

- validating the package and resolving its capabilities before mutations are committed
- translating logical resources into provider-native resources
- resolving implementation packages through supported format adapters
- securely storing configuration, bindings, credentials, and state
- enforcing identity, authorization, approval, isolation, and resource policy
- reconciling the installation toward its declared state
- operating executions and reporting their status
- preserving or disposing of state according to explicit lifecycle and retention rules

## Capability negotiation and portability

A runtime provider must be able to state which resource kinds, versions, behaviors, and limits it implements. An app package must distinguish requirements from enhancements.

- If a **required capability** is unavailable, validation should fail before deployment changes the target.
- If an **optional capability** is unavailable, the app can omit or degrade the associated behavior only when the package defines that path explicitly.
- If an app uses a **provider extension**, the extension must be namespaced and its portability implications must be visible before installation.

Portability includes the following concerns:

1. **Format portability:** another implementation can parse and inspect the package.
2. **Deployment portability:** another runtime can satisfy the declared requirements and create an equivalent resource graph.
3. **Behavioral portability:** executions produce meaningfully equivalent behavior across runtimes.

## Installation lifecycle

1. **Inspect:** read package metadata, resources, requested permissions, and provenance without executing app content.
2. **Validate:** check package integrity, schema compatibility, runtime capabilities, policy, and required bindings.
3. **Plan:** show the resources, permissions, configuration, and changes that deployment would introduce.
4. **Configure and approve:** resolve bindings, provide values, and grant or reject requested authority.
5. **Deploy:** create or update provider-native resources and record an installation revision.
6. **Run:** expose entry points, run work, surface health, and retain an auditable relationship between executions and the installed revision.
7. **Upgrade, or roll back:** compare revisions, migrate compatible state deliberately, and avoid replacing active behavior ambiguously.
8. **Suspend or remove:** stop new work and handle runtime resources, customer data, and durable artifacts according to explicit policy.

Deployment must be convergent (applying the same package and config does not create duplicate resources or untracked side effects.)

## Security and trust

App packages may contain untrusted executable code or provider-native definitions, request access to sensitive systems, and cause long-running or autonomous work. The runtime must treat package content as untrusted input while still giving operators enough information to make informed decisions.

- Permission requests are explicit, reviewable, least-privilege, and denied until granted.
- The initiating user, service, or schedule remains attributable through delegated work and tool calls. Ambient runtime credentials must not erase the acting principal.
- Packages contain secret declarations or references, never secret values.
- Tools, model calls, code execution, and network access are mediated by runtime policy and produce audit events.
- Installation, upgrade, and removal expose their effects on data retention, external resources, and in-flight work.
- Package provenance and integrity are inspectable so ecosystems can add signing, verification, and publisher policy without changing app semantics.
