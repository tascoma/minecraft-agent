# Pydantic AI: Agents, Tools, Capabilities, Skills & Harness

How the pieces of the Pydantic AI stack fit together, and how we use them in `agent-app`.

> **Versions:** `pydantic-ai` 2.52 · `pydantic-ai-harness` 0.52. Diagrams are Mermaid. They render on GitHub, and in VS Code with a Mermaid preview extension.

---

## 1. The big picture

Everything is built from one primitive: the **Agent**. Everything else plugs into it.

```mermaid
%%{init: {'theme': 'base', 'themeVariables': {'fontFamily': 'ui-sans-serif, system-ui, sans-serif', 'primaryColor': '#ede9fe', 'primaryTextColor': '#1e1b4b', 'primaryBorderColor': '#7c3aed', 'secondaryColor': '#e0f2fe', 'secondaryTextColor': '#0c4a6e', 'secondaryBorderColor': '#0284c7', 'tertiaryColor': '#f1f5f9', 'tertiaryTextColor': '#0f172a', 'tertiaryBorderColor': '#64748b', 'lineColor': '#8b5cf6', 'textColor': '#8b5cf6', 'clusterBkg': '#f8fafc', 'clusterBorder': '#94a3b8', 'titleColor': '#0f172a', 'edgeLabelBackground': '#ede9fe', 'actorBkg': '#ede9fe', 'actorBorder': '#7c3aed', 'actorTextColor': '#1e1b4b', 'actorLineColor': '#8b5cf6', 'signalColor': '#8b5cf6', 'signalTextColor': '#8b5cf6', 'labelBoxBkgColor': '#ede9fe', 'labelBoxBorderColor': '#7c3aed', 'labelTextColor': '#1e1b4b', 'loopTextColor': '#8b5cf6', 'noteBkgColor': '#fef9c3', 'noteBorderColor': '#ca8a04', 'noteTextColor': '#422006', 'sequenceNumberColor': '#ffffff'}}}%%
flowchart TB
    subgraph APP["Our app (FastAPI)"]
        route["Route / endpoint"]
    end

    subgraph AGENT["Agent"]
        direction TB
        instr["Instructions<br/>(static, dynamic, templated)"]
        deps["Dependencies<br/>(RunContext[Deps])"]
        out["Output type<br/>(Pydantic model, union, text)"]
        loop(("Agent loop"))
    end

    subgraph CAPS["Capabilities (capabilities=[...])"]
        core["Core capabilities<br/>WebSearch · Thinking · MCP · Hooks<br/>LocalWorkspace · ToolSearch · ..."]
        harness["Harness capabilities<br/>FileSystem · Shell · Memory · Planning<br/>Subagents · Guardrails · Compaction · ..."]
        skills["Skills<br/>(SKILL.md, loaded on demand)"]
    end

    subgraph TOOLS["Tools"]
        fn["Function tools<br/>@agent.tool"]
        ts["Toolsets<br/>(filtered, prefixed, combined)"]
        mcp["MCP servers"]
        native["Provider-native tools<br/>(web search, code exec, ...)"]
    end

    subgraph MODELS["Models"]
        m1["Anthropic · OpenAI · Google · Groq<br/>Mistral · Bedrock · xAI · OpenRouter · ..."]
    end

    subgraph RUNTIME["Runtime around the loop"]
        obs["Logfire / OpenTelemetry"]
        dur["Durable execution<br/>Temporal · DBOS · Prefect"]
        evals["pydantic_evals"]
    end

    route -->|"agent.run(prompt, deps=...)"| loop
    instr --> loop
    deps --> loop
    loop --> out
    CAPS -->|"contribute instructions, tools,<br/>settings, hooks, workspace"| AGENT
    TOOLS --> loop
    loop <-->|"requests / responses"| MODELS
    AGENT -.-> RUNTIME
```

**The short version:**

| Concept | What it is | Where it comes from |
|---|---|---|
| **Agent** | A typed loop: send messages to a model, run the tools it calls, validate the output, repeat | `pydantic_ai.Agent` |
| **Tool** | A function the model can call | `@agent.tool`, toolsets, MCP, provider-native |
| **Toolset** | A group of tools you can filter, rename, prefix, or combine | `pydantic_ai.toolsets` |
| **Capability** | A self-contained bundle of agent behavior: instructions + tools + settings + lifecycle hooks | `pydantic_ai.capabilities` (core) and `pydantic_ai_harness` |
| **Skill** | A `SKILL.md` file of procedural instructions that the model loads only when it needs them | `pydantic_ai_harness.skills.Skills` (a capability) |
| **Harness** | A ready-made *stack* of capabilities for long-running autonomous work (e.g. `Coder`, `Researcher`) | `pydantic_ai_harness` |

The key point: **tools, skills, and harnesses are all delivered through capabilities.** A harness is a capability made of capabilities. A skill is a capability that adds instructions on demand. A capability can add tools.

```mermaid
%%{init: {'theme': 'base', 'themeVariables': {'fontFamily': 'ui-sans-serif, system-ui, sans-serif', 'primaryColor': '#ede9fe', 'primaryTextColor': '#1e1b4b', 'primaryBorderColor': '#7c3aed', 'secondaryColor': '#e0f2fe', 'secondaryTextColor': '#0c4a6e', 'secondaryBorderColor': '#0284c7', 'tertiaryColor': '#f1f5f9', 'tertiaryTextColor': '#0f172a', 'tertiaryBorderColor': '#64748b', 'lineColor': '#8b5cf6', 'textColor': '#8b5cf6', 'clusterBkg': '#f8fafc', 'clusterBorder': '#94a3b8', 'titleColor': '#0f172a', 'edgeLabelBackground': '#ede9fe', 'actorBkg': '#ede9fe', 'actorBorder': '#7c3aed', 'actorTextColor': '#1e1b4b', 'actorLineColor': '#8b5cf6', 'signalColor': '#8b5cf6', 'signalTextColor': '#8b5cf6', 'labelBoxBkgColor': '#ede9fe', 'labelBoxBorderColor': '#7c3aed', 'labelTextColor': '#1e1b4b', 'loopTextColor': '#8b5cf6', 'noteBkgColor': '#fef9c3', 'noteBorderColor': '#ca8a04', 'noteTextColor': '#422006', 'sequenceNumberColor': '#ffffff'}}}%%
flowchart LR
    H["Harness<br/>(e.g. Coder)"] -->|"is a combined"| C["Capability"]
    C -->|"can contain"| C
    S["Skills"] -->|"is a"| C
    C -->|"contributes"| T["Tools / Toolsets"]
    C -->|"contributes"| I["Instructions"]
    C -->|"contributes"| MS["Model settings"]
    C -->|"contributes"| HK["Lifecycle hooks"]
    C -->|"contributes"| W["Workspace"]
    C -->|"plugs into"| A["Agent"]
    T -->|"called by model inside"| A
```

---

## 2. Agents

An agent is configured once (usually at module level) and run many times.

```python
from dataclasses import dataclass
from pydantic import BaseModel
from pydantic_ai import Agent, RunContext


@dataclass
class Deps:
    user_id: str
    db: "Database"


class Answer(BaseModel):
    summary: str
    confidence: float


support_agent = Agent(
    'anthropic:claude-sonnet-5-5',
    deps_type=Deps,
    output_type=Answer,
    instructions='You are a support agent. Be concise.',
)


@support_agent.instructions
async def user_context(ctx: RunContext[Deps]) -> str:
    user = await ctx.deps.db.get_user(ctx.deps.user_id)
    return f"The user's name is {user.name}."


result = await support_agent.run('Why was I charged twice?', deps=Deps('u_123', db))
result.output  # -> Answer(summary=..., confidence=...)
```

### Ways to run an agent

| Method | Use when |
|---|---|
| `await agent.run(...)` | Normal async call, returns the final result |
| `agent.run_sync(...)` | Scripts / tests without an event loop |
| `async with agent.run_stream(...)` | Stream text or partially-validated structured output to a client |
| `async with agent.iter(...)` | Step through the loop node by node (full control) |

### What happens inside one run

```mermaid
%%{init: {'theme': 'base', 'themeVariables': {'fontFamily': 'ui-sans-serif, system-ui, sans-serif', 'primaryColor': '#ede9fe', 'primaryTextColor': '#1e1b4b', 'primaryBorderColor': '#7c3aed', 'secondaryColor': '#e0f2fe', 'secondaryTextColor': '#0c4a6e', 'secondaryBorderColor': '#0284c7', 'tertiaryColor': '#f1f5f9', 'tertiaryTextColor': '#0f172a', 'tertiaryBorderColor': '#64748b', 'lineColor': '#8b5cf6', 'textColor': '#8b5cf6', 'clusterBkg': '#f8fafc', 'clusterBorder': '#94a3b8', 'titleColor': '#0f172a', 'edgeLabelBackground': '#ede9fe', 'actorBkg': '#ede9fe', 'actorBorder': '#7c3aed', 'actorTextColor': '#1e1b4b', 'actorLineColor': '#8b5cf6', 'signalColor': '#8b5cf6', 'signalTextColor': '#8b5cf6', 'labelBoxBkgColor': '#ede9fe', 'labelBoxBorderColor': '#7c3aed', 'labelTextColor': '#1e1b4b', 'loopTextColor': '#8b5cf6', 'noteBkgColor': '#fef9c3', 'noteBorderColor': '#ca8a04', 'noteTextColor': '#422006', 'sequenceNumberColor': '#ffffff'}}}%%
sequenceDiagram
    autonumber
    participant App as FastAPI route
    participant Agent
    participant Caps as Capabilities (hooks)
    participant Model
    participant Tools

    App->>Agent: run(prompt, deps)
    Agent->>Caps: before_run
    loop until final output
        Agent->>Caps: before_model_request
        Agent->>Model: messages + tool definitions
        Model-->>Agent: text and/or tool calls
        Agent->>Caps: after_model_request
        alt model called tools
            Agent->>Caps: before_tool_validate / before_tool_execute
            Agent->>Tools: execute (with RunContext)
            Tools-->>Agent: result (or ModelRetry)
            Agent->>Caps: after_tool_execute
        else model produced output
            Agent->>Caps: before_output_validate
            Agent->>Agent: validate into output_type
            Note over Agent: validation error → retry prompt to model
        end
    end
    Agent->>Caps: after_run
    Agent-->>App: AgentRunResult(output, messages, usage)
```

### Output types

| Output | How |
|---|---|
| Plain text | `output_type=str` (default) |
| Validated object | `output_type=MyModel` (Pydantic model, dataclass, TypedDict) |
| One of several shapes | `output_type=[Success, Failure]` |
| Choose the mechanism | `ToolOutput(...)`, `NativeOutput(...)`, `PromptedOutput(...)`, `TextOutput(fn)` |
| Schema built at runtime | `StructuredDict(json_schema)` |

Add `@agent.output_validator` to check the result yourself and raise `ModelRetry('...')` to make the model try again.

---

## 3. Tools & toolsets

A **tool** is a Python function the model can call. Its type hints and docstring become the JSON schema the model sees.

```python
@support_agent.tool
async def lookup_charges(ctx: RunContext[Deps], month: str) -> list[dict]:
    """List the user's charges for a month (YYYY-MM)."""
    return await ctx.deps.db.charges(ctx.deps.user_id, month)


@support_agent.tool_plain  # no RunContext needed
def add(a: int, b: int) -> int:
    return a + b
```

### Where tools come from

```mermaid
%%{init: {'theme': 'base', 'themeVariables': {'fontFamily': 'ui-sans-serif, system-ui, sans-serif', 'primaryColor': '#ede9fe', 'primaryTextColor': '#1e1b4b', 'primaryBorderColor': '#7c3aed', 'secondaryColor': '#e0f2fe', 'secondaryTextColor': '#0c4a6e', 'secondaryBorderColor': '#0284c7', 'tertiaryColor': '#f1f5f9', 'tertiaryTextColor': '#0f172a', 'tertiaryBorderColor': '#64748b', 'lineColor': '#8b5cf6', 'textColor': '#8b5cf6', 'clusterBkg': '#f8fafc', 'clusterBorder': '#94a3b8', 'titleColor': '#0f172a', 'edgeLabelBackground': '#ede9fe', 'actorBkg': '#ede9fe', 'actorBorder': '#7c3aed', 'actorTextColor': '#1e1b4b', 'actorLineColor': '#8b5cf6', 'signalColor': '#8b5cf6', 'signalTextColor': '#8b5cf6', 'labelBoxBkgColor': '#ede9fe', 'labelBoxBorderColor': '#7c3aed', 'labelTextColor': '#1e1b4b', 'loopTextColor': '#8b5cf6', 'noteBkgColor': '#fef9c3', 'noteBorderColor': '#ca8a04', 'noteTextColor': '#422006', 'sequenceNumberColor': '#ffffff'}}}%%
flowchart LR
    subgraph Sources
        A["@agent.tool functions"]
        B["FunctionToolset([...])"]
        C["MCP server<br/>(stdio / HTTP)"]
        D["Common tools<br/>DuckDuckGo · Tavily · Exa · web_fetch"]
        E["Capabilities<br/>(FileSystem, Shell, ...)"]
        F["Provider-native tools<br/>WebSearchTool · CodeExecutionTool · ..."]
    end

    subgraph Transform["Toolset wrappers"]
        filt["filtered()"]
        pre["prefixed()"]
        ren["renamed()"]
        appr["approval_required()"]
        comb["CombinedToolset"]
    end

    A --> comb
    B --> filt --> comb
    C --> pre --> comb
    D --> comb
    E --> comb
    B --> appr --> comb
    comb -->|"tool definitions"| M(("Model"))
    F -.->|"executed by the provider,<br/>not by us"| M
```

### Tool features worth knowing

| Feature | What it does |
|---|---|
| `ModelRetry` | Raise inside a tool to send an error back to the model so it can try again |
| `ApprovalRequired` / `approval_required()` | Pause the run until a human approves the call (human-in-the-loop) |
| `CallDeferred` / `ExternalToolset` | Return control to the caller, who runs the tool elsewhere (e.g. in the browser) |
| `ToolSearch` capability | Load tool definitions on demand instead of sending hundreds in every prompt |
| `prepare=` | Change or hide a tool per step, based on context |

---

## 4. Capabilities

A **capability** is a reusable unit of agent behavior that you add with `capabilities=[...]`. It's the main way to extend an agent without changing its code.

A single capability can contribute any mix of the following:

```mermaid
%%{init: {'theme': 'base', 'themeVariables': {'fontFamily': 'ui-sans-serif, system-ui, sans-serif', 'primaryColor': '#ede9fe', 'primaryTextColor': '#1e1b4b', 'primaryBorderColor': '#7c3aed', 'secondaryColor': '#e0f2fe', 'secondaryTextColor': '#0c4a6e', 'secondaryBorderColor': '#0284c7', 'tertiaryColor': '#f1f5f9', 'tertiaryTextColor': '#0f172a', 'tertiaryBorderColor': '#64748b', 'lineColor': '#8b5cf6', 'textColor': '#8b5cf6', 'clusterBkg': '#f8fafc', 'clusterBorder': '#94a3b8', 'titleColor': '#0f172a', 'edgeLabelBackground': '#ede9fe', 'actorBkg': '#ede9fe', 'actorBorder': '#7c3aed', 'actorTextColor': '#1e1b4b', 'actorLineColor': '#8b5cf6', 'signalColor': '#8b5cf6', 'signalTextColor': '#8b5cf6', 'labelBoxBkgColor': '#ede9fe', 'labelBoxBorderColor': '#7c3aed', 'labelTextColor': '#1e1b4b', 'loopTextColor': '#8b5cf6', 'noteBkgColor': '#fef9c3', 'noteBorderColor': '#ca8a04', 'noteTextColor': '#422006', 'sequenceNumberColor': '#ffffff'}}}%%
flowchart TB
    CAP["AbstractCapability"]
    CAP --> I["get_instructions()<br/>adds to the system prompt"]
    CAP --> T["get_toolset()<br/>adds tools"]
    CAP --> N["get_native_tools()<br/>adds provider-native tools"]
    CAP --> S["get_model_settings()<br/>e.g. thinking effort"]
    CAP --> W["get_workspace()<br/>where files & commands live"]
    CAP --> PT["prepare_tools()<br/>filter / edit tools per step"]
    CAP --> HK["Lifecycle hooks"]
    HK --> h1["before_/after_/wrap_ run"]
    HK --> h2["before_/after_/wrap_ model_request"]
    HK --> h3["before_/after_/wrap_ tool_validate / tool_execute"]
    HK --> h4["before_/after_/wrap_ output_validate"]
    HK --> h5["on_event · on_*_error"]
```

### Core capabilities (ship with `pydantic-ai`)

| Capability | Purpose |
|---|---|
| `WebSearch`, `WebFetch`, `XSearch` | Provider-native where supported, local fallback otherwise |
| `Thinking` | Extended thinking at a configurable effort, adapted to each provider |
| `MCP` | Attach an MCP server's tools |
| `ImageGeneration` | Generate and edit images |
| `LocalWorkspace` | Let the agent read files and run commands in a local directory |
| `ToolSearch` | Load tools on demand |
| `Hooks` | Register lifecycle hooks with decorators (no subclass needed) |
| `ProcessHistory` / `HistoryProcessor` | Trim or summarize message history |
| `ReinjectSystemPrompt` | Re-add the system prompt in long runs |
| `SelectModel`, `ResolveModelId` | Pick or route models per run |
| `PrepareTools`, `PrefixTools`, `SetToolMetadata` | Change tools in bulk |
| `HandleDeferredToolCalls` | Resolve approval-deferred calls in code |
| `Instrumentation` | OpenTelemetry spans (Logfire) |
| `UseThreadExecutor` | Run sync tools on a shared thread pool |

### Using hooks without writing a class

```python
from pydantic_ai.capabilities import Hooks

hooks = Hooks()


@hooks.on.before_model_request
async def log_request(ctx, request_context):
    logger.info('model request', extra={'run_step': ctx.run_step})
    return request_context


agent = Agent('anthropic:claude-sonnet-5-5', capabilities=[hooks])
```

### Writing your own capability

Subclass `AbstractCapability` and override only the parts you need:

```python
from dataclasses import dataclass
from pydantic_ai.capabilities import AbstractCapability


@dataclass
class TenantPolicy(AbstractCapability):
    tenant: str

    def get_instructions(self):
        return f'You act on behalf of tenant {self.tenant}. Never reveal other tenants\' data.'

    async def before_tool_execute(self, ctx, *, call, tool_def, args):
        audit_log(self.tenant, call.tool_name, args)
        return args
```

> Check the exact hook signatures in `pydantic_ai/capabilities/abstract.py` before overriding a hook. They are keyword-heavy and do change between releases.

### Composition order

Capabilities run in list order. `before_*` hooks run first-to-last, `after_*` hooks run last-to-first, and `wrap_*` hooks nest like middleware:

```mermaid
%%{init: {'theme': 'base', 'themeVariables': {'fontFamily': 'ui-sans-serif, system-ui, sans-serif', 'primaryColor': '#ede9fe', 'primaryTextColor': '#1e1b4b', 'primaryBorderColor': '#7c3aed', 'secondaryColor': '#e0f2fe', 'secondaryTextColor': '#0c4a6e', 'secondaryBorderColor': '#0284c7', 'tertiaryColor': '#f1f5f9', 'tertiaryTextColor': '#0f172a', 'tertiaryBorderColor': '#64748b', 'lineColor': '#8b5cf6', 'textColor': '#8b5cf6', 'clusterBkg': '#f8fafc', 'clusterBorder': '#94a3b8', 'titleColor': '#0f172a', 'edgeLabelBackground': '#ede9fe', 'actorBkg': '#ede9fe', 'actorBorder': '#7c3aed', 'actorTextColor': '#1e1b4b', 'actorLineColor': '#8b5cf6', 'signalColor': '#8b5cf6', 'signalTextColor': '#8b5cf6', 'labelBoxBkgColor': '#ede9fe', 'labelBoxBorderColor': '#7c3aed', 'labelTextColor': '#1e1b4b', 'loopTextColor': '#8b5cf6', 'noteBkgColor': '#fef9c3', 'noteBorderColor': '#ca8a04', 'noteTextColor': '#422006', 'sequenceNumberColor': '#ffffff'}}}%%
flowchart LR
    subgraph wrap["capabilities=[A, B, C]"]
        direction LR
        A1["A.wrap ▶"] --> B1["B.wrap ▶"] --> C1["C.wrap ▶"] --> X(("model request /<br/>tool call"))
        X --> C2["◀ C"] --> B2["◀ B"] --> A2["◀ A"]
    end
```

---

## 5. Skills

**Skills** are folders of `SKILL.md` files ([Agent Skills spec](https://agentskills.io/specification)). They hold procedural knowledge that's too long to put in every prompt. The model sees only each skill's **name + description** until it decides it needs one.

### Layout

```text
.agents/skills/
  refund-policy/
    SKILL.md
  write-sql-migration/
    SKILL.md
```

```markdown
---
name: refund-policy
description: Rules for deciding whether a customer is eligible for a refund.
---

1. Check the purchase date against the 30-day window.
2. ...
```

### Wiring it up

```python
from pydantic_ai import Agent
from pydantic_ai_harness.skills import Skills

agent = Agent(
    'anthropic:claude-sonnet-5-5',
    capabilities=[
        Skills('.agents/skills'),                          # all skills
        # Skills('.agents/skills', include=['refund-policy']),  # or a subset
    ],
)
```

### How a skill gets loaded

```mermaid
%%{init: {'theme': 'base', 'themeVariables': {'fontFamily': 'ui-sans-serif, system-ui, sans-serif', 'primaryColor': '#ede9fe', 'primaryTextColor': '#1e1b4b', 'primaryBorderColor': '#7c3aed', 'secondaryColor': '#e0f2fe', 'secondaryTextColor': '#0c4a6e', 'secondaryBorderColor': '#0284c7', 'tertiaryColor': '#f1f5f9', 'tertiaryTextColor': '#0f172a', 'tertiaryBorderColor': '#64748b', 'lineColor': '#8b5cf6', 'textColor': '#8b5cf6', 'clusterBkg': '#f8fafc', 'clusterBorder': '#94a3b8', 'titleColor': '#0f172a', 'edgeLabelBackground': '#ede9fe', 'actorBkg': '#ede9fe', 'actorBorder': '#7c3aed', 'actorTextColor': '#1e1b4b', 'actorLineColor': '#8b5cf6', 'signalColor': '#8b5cf6', 'signalTextColor': '#8b5cf6', 'labelBoxBkgColor': '#ede9fe', 'labelBoxBorderColor': '#7c3aed', 'labelTextColor': '#1e1b4b', 'loopTextColor': '#8b5cf6', 'noteBkgColor': '#fef9c3', 'noteBorderColor': '#ca8a04', 'noteTextColor': '#422006', 'sequenceNumberColor': '#ffffff'}}}%%
sequenceDiagram
    autonumber
    participant Init as Skills(...) at startup
    participant Agent
    participant Model

    Init->>Init: scan .agents/skills/*/SKILL.md
    Init->>Agent: one deferred capability per skill
    Agent->>Model: prompt + catalog (names + descriptions only)
    Model->>Agent: call load_capability("refund-policy")
    Agent->>Agent: append skill body to instructions (heading Skill: refund-policy)
    Agent->>Model: continue with the skill's instructions now in context
```

**Notes:**
- Skills are scanned **once at construction**. Create a new `Skills(...)` to pick up changes.
- `Skills` loads only the instructions from `SKILL.md`. It does **not** run scripts or load bundled files.
- A skill's body becomes model instructions, so **load only skills you trust**.
- Requires the `skills` extra (`pydantic-ai-harness[skills]`).

### Skill vs. tool vs. capability: which do I use?

```mermaid
%%{init: {'theme': 'base', 'themeVariables': {'fontFamily': 'ui-sans-serif, system-ui, sans-serif', 'primaryColor': '#ede9fe', 'primaryTextColor': '#1e1b4b', 'primaryBorderColor': '#7c3aed', 'secondaryColor': '#e0f2fe', 'secondaryTextColor': '#0c4a6e', 'secondaryBorderColor': '#0284c7', 'tertiaryColor': '#f1f5f9', 'tertiaryTextColor': '#0f172a', 'tertiaryBorderColor': '#64748b', 'lineColor': '#8b5cf6', 'textColor': '#8b5cf6', 'clusterBkg': '#f8fafc', 'clusterBorder': '#94a3b8', 'titleColor': '#0f172a', 'edgeLabelBackground': '#ede9fe', 'actorBkg': '#ede9fe', 'actorBorder': '#7c3aed', 'actorTextColor': '#1e1b4b', 'actorLineColor': '#8b5cf6', 'signalColor': '#8b5cf6', 'signalTextColor': '#8b5cf6', 'labelBoxBkgColor': '#ede9fe', 'labelBoxBorderColor': '#7c3aed', 'labelTextColor': '#1e1b4b', 'loopTextColor': '#8b5cf6', 'noteBkgColor': '#fef9c3', 'noteBorderColor': '#ca8a04', 'noteTextColor': '#422006', 'sequenceNumberColor': '#ffffff'}}}%%
flowchart TD
    Q{"What are you adding?"}
    Q -->|"The model needs to DO something<br/>(query DB, call API)"| T["Tool"]
    Q -->|"The model needs to KNOW a procedure<br/>(policy, playbook, style guide)"| S["Skill"]
    Q -->|"Cross-cutting BEHAVIOR<br/>(logging, guardrails, limits,<br/>tools + instructions together)"| C["Capability"]
    Q -->|"A whole autonomous working setup<br/>(code, research)"| H["Harness"]
```

---

## 6. The harness (`pydantic-ai-harness`)

Every agent already has a basic harness: the loop, tools, and typed output. For **long-running, autonomous work** (hours, many files, unattended), the agent needs more around it: somewhere to work, a plan, memory, sub-agents, and context management. `pydantic-ai-harness` provides these as 50+ capabilities, plus two complete pre-built agents.

### A harness is just combined capabilities

```mermaid
%%{init: {'theme': 'base', 'themeVariables': {'fontFamily': 'ui-sans-serif, system-ui, sans-serif', 'primaryColor': '#ede9fe', 'primaryTextColor': '#1e1b4b', 'primaryBorderColor': '#7c3aed', 'secondaryColor': '#e0f2fe', 'secondaryTextColor': '#0c4a6e', 'secondaryBorderColor': '#0284c7', 'tertiaryColor': '#f1f5f9', 'tertiaryTextColor': '#0f172a', 'tertiaryBorderColor': '#64748b', 'lineColor': '#8b5cf6', 'textColor': '#8b5cf6', 'clusterBkg': '#f8fafc', 'clusterBorder': '#94a3b8', 'titleColor': '#0f172a', 'edgeLabelBackground': '#ede9fe', 'actorBkg': '#ede9fe', 'actorBorder': '#7c3aed', 'actorTextColor': '#1e1b4b', 'actorLineColor': '#8b5cf6', 'signalColor': '#8b5cf6', 'signalTextColor': '#8b5cf6', 'labelBoxBkgColor': '#ede9fe', 'labelBoxBorderColor': '#7c3aed', 'labelTextColor': '#1e1b4b', 'loopTextColor': '#8b5cf6', 'noteBkgColor': '#fef9c3', 'noteBorderColor': '#ca8a04', 'noteTextColor': '#422006', 'sequenceNumberColor': '#ffffff'}}}%%
flowchart TB
    Coder["Coder (harness)"]
    Coder --> FS["FileSystem<br/>read · write · edit · list · grep"]
    Coder --> SH["Shell<br/>persistent shell"]
    Coder --> RC["RepoContext<br/>AGENTS.md / CLAUDE.md + tree"]
    Coder --> SA["SubAgents<br/>delegate_task → itself"]
    Coder --> CP["Compaction<br/>ClearToolResults · WarnNearLimits"]
    Coder --> TOL["ToolOutputLimits"]

    WS["Workspace (required)<br/>LocalWorkspace · ModalSandbox<br/>E2BSandbox · SpritesSandbox · SSH"]
    FS -.->|"acts in"| WS
    SH -.->|"acts in"| WS

    Researcher["Researcher (harness)"]
    Researcher --> WSr["Web search"]
    Researcher --> WF["Web fetch"]
    Researcher --> SR["Sub-researcher"]
    Researcher --> TOL2["Tool output limits"]
```

```python
from pydantic_ai import Agent
from pydantic_ai.capabilities import LocalWorkspace, WebSearch
from pydantic_ai_harness import Coder, Memory
from pydantic_ai_harness.memory import FileStore
from pydantic_ai_harness.skills import Skills

agent = Agent(
    'anthropic:claude-opus-5-5',
    capabilities=[
        LocalWorkspace('.'),                  # where files/commands live (NOT a sandbox)
        Coder(),                              # the coding harness
        WebSearch(),                          # core capability
        Memory(FileStore('.agent-memory')),   # remembers across sessions
        Skills('.agents/skills'),             # on-demand procedures
    ],
)
```

> Harness capabilities never pick a workspace for you. If you attach none, the run fails at start and tells you what to add. `LocalWorkspace` runs commands on the host machine, so use a sandbox capability for untrusted work.

### Harness capability catalog

| Group | Capabilities |
|---|---|
| **Harnesses** | `Coder`, `Researcher` |
| **Execution environments** | `FileSystem`, `Shell`, Modal / E2B / Sprites sandboxes, SSH workspace, Bubblewrap |
| **Integrations** | GitHub, Linear, Notion, Google Workspace, Slack, StackOne, PostHog, Pylon, Grain, Day AI, Ordinal, LocalStack, Macroscope |
| **Web & research** | Exa Search / Agent, You.com Search / Research, Playwright Browser, Browser Use |
| **Reasoning & delegation** | `Planning`, `SubAgents`, Dynamic Workflow, `Advisor`, Background Tools |
| **Context management** | Code Mode, `Compaction` (clear / sliding window / summarize), `ToolOutputLimits`, Warn On Cache Busts |
| **Knowledge & memory** | `Memory`, Conversation Search, `Skills`, `RepoContext`, Pydantic AI Docs |
| **Control & safety** | `Guardrails`, Prompt Injection Defender, Spend Limits, Ask User, Repair Tool Arguments, System Reminders, Trajectory Judge |
| **Self-extension** | Capability Creation (the agent writes new capabilities for its next run) |
| **Runtime** | Step Persistence (save / resume / fork runs), AWS Lambda durability, Managed Prompt (Logfire), Logfire MCP |

---

## 7. Multi-agent patterns

```mermaid
%%{init: {'theme': 'base', 'themeVariables': {'fontFamily': 'ui-sans-serif, system-ui, sans-serif', 'primaryColor': '#ede9fe', 'primaryTextColor': '#1e1b4b', 'primaryBorderColor': '#7c3aed', 'secondaryColor': '#e0f2fe', 'secondaryTextColor': '#0c4a6e', 'secondaryBorderColor': '#0284c7', 'tertiaryColor': '#f1f5f9', 'tertiaryTextColor': '#0f172a', 'tertiaryBorderColor': '#64748b', 'lineColor': '#8b5cf6', 'textColor': '#8b5cf6', 'clusterBkg': '#f8fafc', 'clusterBorder': '#94a3b8', 'titleColor': '#0f172a', 'edgeLabelBackground': '#ede9fe', 'actorBkg': '#ede9fe', 'actorBorder': '#7c3aed', 'actorTextColor': '#1e1b4b', 'actorLineColor': '#8b5cf6', 'signalColor': '#8b5cf6', 'signalTextColor': '#8b5cf6', 'labelBoxBkgColor': '#ede9fe', 'labelBoxBorderColor': '#7c3aed', 'labelTextColor': '#1e1b4b', 'loopTextColor': '#8b5cf6', 'noteBkgColor': '#fef9c3', 'noteBorderColor': '#ca8a04', 'noteTextColor': '#422006', 'sequenceNumberColor': '#ffffff'}}}%%
flowchart LR
    subgraph P1["Delegation via tool"]
        parent["Router agent"] -->|"@tool calls"| child["Specialist agent"]
        child -->|"result + usage=ctx.usage"| parent
    end

    subgraph P2["SubAgents capability"]
        main["Main agent"] -->|"delegate_task"| sub1["Named child A"]
        main -->|"delegate_task"| sub2["Named child B"]
    end

    subgraph P3["pydantic_graph"]
        n1["Node: classify"] --> n2{"decision"}
        n2 --> n3["Node: answer"]
        n2 --> n4["Node: escalate"]
    end
```

| Pattern | When |
|---|---|
| **Agent delegation** (call another agent inside a tool) | One specialist; pass `usage=ctx.usage` so usage limits apply across both |
| **`SubAgents` / Dynamic Workflow** (harness) | The model decides when and how to fan work out |
| **Programmatic hand-off** (your code picks the next agent) | Deterministic flows |
| **`pydantic_graph`** | Explicit state machines with typed state, branching, fork / join, and resumable persistence |

---

## 8. Around the loop: runtime, observability, testing

```mermaid
%%{init: {'theme': 'base', 'themeVariables': {'fontFamily': 'ui-sans-serif, system-ui, sans-serif', 'primaryColor': '#ede9fe', 'primaryTextColor': '#1e1b4b', 'primaryBorderColor': '#7c3aed', 'secondaryColor': '#e0f2fe', 'secondaryTextColor': '#0c4a6e', 'secondaryBorderColor': '#0284c7', 'tertiaryColor': '#f1f5f9', 'tertiaryTextColor': '#0f172a', 'tertiaryBorderColor': '#64748b', 'lineColor': '#8b5cf6', 'textColor': '#8b5cf6', 'clusterBkg': '#f8fafc', 'clusterBorder': '#94a3b8', 'titleColor': '#0f172a', 'edgeLabelBackground': '#ede9fe', 'actorBkg': '#ede9fe', 'actorBorder': '#7c3aed', 'actorTextColor': '#1e1b4b', 'actorLineColor': '#8b5cf6', 'signalColor': '#8b5cf6', 'signalTextColor': '#8b5cf6', 'labelBoxBkgColor': '#ede9fe', 'labelBoxBorderColor': '#7c3aed', 'labelTextColor': '#1e1b4b', 'loopTextColor': '#8b5cf6', 'noteBkgColor': '#fef9c3', 'noteBorderColor': '#ca8a04', 'noteTextColor': '#422006', 'sequenceNumberColor': '#ffffff'}}}%%
flowchart LR
    A["Agent"] --> L["Logfire / OTel<br/>traces every model + tool call"]
    A --> D["Durable execution<br/>TemporalAgent · DBOSAgent · PrefectAgent"]
    A --> U["UI adapters<br/>Vercel AI SDK · AG-UI"]
    A --> E["pydantic_evals<br/>datasets · evaluators · reports"]
    A --> TM["Testing<br/>TestModel · FunctionModel · agent.override()"]
```

| Area | What to use |
|---|---|
| Observability | `logfire.configure(); logfire.instrument_pydantic_ai()` |
| Cost / usage | `result.usage()`, `UsageLimits(...)`, harness Spend Limits |
| Streaming to the frontend | `pydantic_ai.ui.vercel_ai` (Vercel `useChat`) or `pydantic_ai.ui.ag_ui` |
| Survive restarts | `pydantic_ai.durable_exec.temporal` / `dbos` / `prefect` |
| Unit tests | `agent.override(model=TestModel())`. `TestModel` makes no real API calls |
| Quality evals | `pydantic_evals.Dataset` + evaluators (incl. LLM-as-judge) |

---

## 9. How this maps onto `agent-app`

```mermaid
%%{init: {'theme': 'base', 'themeVariables': {'fontFamily': 'ui-sans-serif, system-ui, sans-serif', 'primaryColor': '#ede9fe', 'primaryTextColor': '#1e1b4b', 'primaryBorderColor': '#7c3aed', 'secondaryColor': '#e0f2fe', 'secondaryTextColor': '#0c4a6e', 'secondaryBorderColor': '#0284c7', 'tertiaryColor': '#f1f5f9', 'tertiaryTextColor': '#0f172a', 'tertiaryBorderColor': '#64748b', 'lineColor': '#8b5cf6', 'textColor': '#8b5cf6', 'clusterBkg': '#f8fafc', 'clusterBorder': '#94a3b8', 'titleColor': '#0f172a', 'edgeLabelBackground': '#ede9fe', 'actorBkg': '#ede9fe', 'actorBorder': '#7c3aed', 'actorTextColor': '#1e1b4b', 'actorLineColor': '#8b5cf6', 'signalColor': '#8b5cf6', 'signalTextColor': '#8b5cf6', 'labelBoxBkgColor': '#ede9fe', 'labelBoxBorderColor': '#7c3aed', 'labelTextColor': '#1e1b4b', 'loopTextColor': '#8b5cf6', 'noteBkgColor': '#fef9c3', 'noteBorderColor': '#ca8a04', 'noteTextColor': '#422006', 'sequenceNumberColor': '#ffffff'}}}%%
flowchart TB
    FE["frontend/"] -->|"HTTP / SSE"| R["backend/app/routes/"]
    R --> SVC["backend/app/services/"]
    SVC --> AG["backend/app/agents/<br/>Agent definitions + tools"]
    AG --> CAPS["Capabilities<br/>(core + harness)"]
    AG --> SK["skills/<br/>SKILL.md files"]
    R -.->|"FastAPI Depends()"| DEP["backend/app/dependencies/"]
    DEP -->|"build Deps"| AG
    AG --> DB["backend/app/databases/"]
    AG --> SCH["backend/app/schema/<br/>output types (Pydantic)"]
    CFG["backend/app/core/config.py<br/>model ids, API keys"] --> AG
```

**Conventions:**
- **One agent per module** in `backend/app/agents/`, defined at module level and reused across requests.
- **Request-specific state goes in `deps`**, never in globals. Build `Deps` from FastAPI dependencies.
- **Output types live in `backend/app/schema/`** so routes and agents share them.
- **Use a capability when behavior repeats** across agents (guardrails, logging, tenant policy). Don't copy hooks into each agent.
- **Use a skill when it's knowledge**, a tool when it's an action.
- **Tests use `TestModel` / `FunctionModel`.** No real model calls in CI.

---

## References

- Pydantic AI docs: https://ai.pydantic.dev/
- Capabilities: https://ai.pydantic.dev/capabilities/overview/
- Harness docs: https://pydantic.dev/docs/ai/harness/
- On-demand capabilities & skills: https://pydantic.dev/docs/ai/capabilities/on-demand/
- Agent Skills spec: https://agentskills.io/specification
