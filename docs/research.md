# Building a self-modifying AI agent from scratch

**A minimal, self-improving AI agent that can safely write and modify its own code is achievable in under 200 lines of Python, costs $15–60/month to run, and requires just five core components: an LLM API call, a bash tool, a while loop, git integration, and a persistent knowledge file.** This blueprint draws directly from Anthropic’s and OpenAI’s official security guidance, real open-source implementations (Mini-SWE-Agent, Live-SWE-Agent, Conway Automaton), and production architectures behind Claude Code and Codex. The critical insight: modern LLMs are capable enough that elaborate scaffolding is unnecessary — Princeton’s Mini-SWE-Agent scores >74% on SWE-bench with just ~100 lines and a single bash tool. What matters is giving the model a shell, clear instructions, strong sandboxing, and a safety net made of git.

-----

## The minimum viable architecture is simpler than you think

The **ReAct loop** (Reason → Act → Observe) is the universally accepted atomic agent pattern. Every production agent — Claude Code, Codex, Devin, Aider — runs a variant of it. Your v0.1 needs exactly five components:

|Component          |What it does                     |Implementation                    |
|-------------------|---------------------------------|----------------------------------|
|**LLM API client** |Reasoning engine                 |`anthropic` or `openai` Python SDK|
|**Bash tool**      |Only tool needed for v0.1        |`subprocess.run()` in a sandbox   |
|**Agent loop**     |Think → Act → Observe → Repeat   |`while not done:` (~50 lines)     |
|**Git integration**|Safety net + memory + rollback   |`subprocess.run(["git", ...])`    |
|**Knowledge file** |Compound learning across sessions|`AGENT.md` on disk                |

This isn’t theoretical minimalism — it’s proven. Mini-SWE-Agent from Princeton demonstrates that **a ~100-line Python agent with only bash access** outperforms complex multi-tool systems. The researchers concluded: “As LMs have become more capable, a lot of [custom tooling] is not needed at all.” Live-SWE-Agent extended this to show that agents can expand and revise their own capabilities at runtime  with “very minimal modifications” to the base agent, achieving **79.2%** on SWE-bench Verified. 

The core loop in pseudocode:

```python
while not done and steps < MAX_STEPS:
    # 1. THINK: Send conversation history + tools to LLM
    response = client.messages.create(
        model="claude-haiku-4-5-20250901",
        system=SYSTEM_PROMPT,
        messages=conversation_history,
        tools=[{"name": "bash", "description": "Execute shell commands",
                "input_schema": {"type": "object", "properties": {"command": {"type": "string"}}}}]
    )
    # 2. ACT: If tool_use, execute in sandbox
    for block in response.content:
        if block.type == "tool_use":
            result = sandbox_execute(block.input["command"])
            conversation_history.append(tool_result(block.id, result))
    # 3. OBSERVE: Feed result back, loop continues
    # 4. REFLECT: After task, update AGENT.md with learnings
    if response.stop_reason == "end_turn":
        done = True
```

OpenAI’s official agent guide confirms this pattern: “Every agent consists of three core components — Model, Tools, and Instructions — running in a while loop until an exit condition.”  They explicitly recommend **starting with a single-agent system** and splitting into multi-agent only when evaluations demonstrate the need.  

-----

## Python is the only serious choice for self-modification

For a self-modifying agent, the language decision is unambiguous. **Python wins on every axis that matters**: SDK support, ecosystem depth, and — critically — the ability to trivially modify its own source code at runtime.

**Python** has first-class SDKs from both Anthropic and OpenAI,  over 300,000 AI/ML packages, and powers roughly 80% of all agent implementations.  It can read, rewrite, and `exec()` its own files. Every major framework (LangChain, LangGraph, CrewAI, AutoGen) is Python-first.  Mini-SWE-Agent, Live-SWE-Agent, Aider, and SWE-agent are all Python. 

**TypeScript** is a credible second choice — Claude Code itself is written in TypeScript with React/Ink,  and Anthropic chose it because “the model is very capable with TypeScript.”  But TypeScript’s compilation step makes self-modification less fluid, and agent framework support is thinner.

**Rust and Go** are fundamentally unsuitable. Both are compiled languages that cannot practically modify and re-execute their own source at runtime. OpenAI rewrote Codex CLI in Rust for distribution performance,  but the agent loop logic doesn’t benefit from this — Rust has no official Anthropic or OpenAI SDKs, and its agent framework ecosystem is nearly nonexistent. Go has lightweight goroutines but the same compilation barrier and sparse LLM tooling.

The self-modification advantage is Python’s killer feature here. Your agent can `open(__file__, 'r')` to read its own source, modify it, write it back, and reload modules with `importlib.reload()` — all within a running process. No other mainstream language makes this so natural.

-----

## Sandboxing is non-negotiable, and here’s exactly how to do it

Both Anthropic and OpenAI are emphatic: **autonomous code execution requires hardware-level isolation**. Anthropic’s computer use docs state: “Use a dedicated virtual machine or container with minimal privileges to prevent direct system attacks or accidents.”   Their engineering blog reveals Claude Code uses a **two-boundary sandboxing model** — filesystem isolation plus network isolation — built on Linux bubblewrap and seccomp BPF.  This architecture “safely reduces permission prompts by 84%”  while ensuring “even a successful prompt injection is fully isolated.” 

For your v0.1, here is the recommended sandboxing stack, ordered from simplest to most secure:

**Development/prototyping: Docker Sandboxes (free).** Docker Desktop 4.58+ provides microVM-based isolation with built-in network allow/deny lists.  Run `docker sandbox run` with a deny-all network policy, allowlisting only your LLM API endpoint and package registries. The agent’s workspace mounts at the same absolute path.  This blocks private networks (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16), localhost, and cloud metadata services by default.

**Production: E2B or Fly.io Sprites.** E2B provides Firecracker microVM sandboxes purpose-built for AI agents,  with Python/JS SDKs and sub-second boot times.   Used by approximately half the Fortune 500.  Fly.io’s Sprites are persistent Firecracker VMs designed specifically for coding agents, with **1–12 second startup**, checkpoint/restore for rollback, automatic shutdown when idle, and hardware-level isolation. Both provide the strongest practical isolation without requiring you to manage infrastructure.

**Self-hosted production: Firecracker + jailer.** The strongest isolation available — dedicated kernel per VM, ~125ms boot, <5 MiB memory overhead. But complex to operate; most teams should access Firecracker through E2B or Fly.io rather than managing it directly.

Anthropic’s key insight applies directly: **“Effective sandboxing requires BOTH filesystem and network isolation.”** Without network isolation, a compromised agent exfiltrates SSH keys. Without filesystem isolation, it escapes the sandbox entirely.  Your Docker/E2B configuration must enforce both:

```bash
# Docker sandbox with deny-all network + allowlist
docker sandbox network proxy agent-sandbox \
  --policy deny \
  --allow-host "api.anthropic.com" \
  --allow-host "*.pypi.org" \
  --allow-host "files.pythonhosted.org"
```

-----

## Self-modification needs git, approval gates, and rate limits

The most dangerous capability of a self-modifying agent is also its core purpose. The research reveals three production-proven safety mechanisms that work together to make self-modification survivable.

**Git-based versioning is the universal safety net.** Every production coding agent — Claude Code, Codex, Aider, Conway Automaton — auto-commits changes with descriptive messages before applying them. Aider’s `/undo` command reverts the last AI change instantly. Your v0.1 should commit to a local git repo after every successful modification, tag working versions, and auto-revert on test failure. This creates an immutable audit trail and instant rollback path. The compound-product pattern takes this further: the agent updates an `AGENT.md` knowledge file after each session, recording patterns, gotchas, and learnings that compound over time  — “each improvement makes future improvements easier.” 

**Human-in-the-loop approval gates for high-risk actions.** Both Anthropic and OpenAI mandate human confirmation for irreversible operations.  Claude Code’s permission system is deny-first: read-only by default, explicit approval required for file edits and command execution.  For self-modification specifically, **always require human approval before any code change to the agent itself is applied to the production loop**. Classify actions into three tiers:

- **Auto-approve**: Read-only operations, safe queries, git status checks
- **Conditional**: File edits within the workspace, test execution, package installation
- **Always-require-approval**: Modifications to agent core code, system prompt changes, network configuration changes, any destructive operation 

**Rate limiting prevents runaway self-modification.** Cap self-modifications to a maximum number per session (start with **3 per session, 10 per day**). Enforce mandatory test suite execution after every modification. Implement automatic rollback triggers when tests fail or benchmark scores regress. Conway Automaton demonstrates this well: it allows self-modification of skills and tools but protects immutable “constitution” files that can never be changed.  Your agent’s core safety logic, permission system, and rate limits should be similarly immutable.

-----

## Defending against prompt injection in a self-modifying agent

Prompt injection is the highest-risk vector for self-modifying systems. Research shows **89% attack success on GPT-4o and 78% on Claude 3.5 Sonnet** with sufficient attempts. No complete defense exists, but Anthropic’s layered approach reduces successful attacks to approximately 1% in browser-use scenarios.

Your v0.1 must implement these defenses from day one. **Separate control flow from data flow** — never let raw external input (user prompts, fetched documentation, API responses) directly influence self-modification decisions. Claude Code achieves this by using isolated context windows for web fetch, running URL content through a separate conversation that cannot inject instructions into the main agent context.   **Treat ALL external input as untrusted**, including content from documentation sites the agent ingests for self-improvement.

Anthropic’s Claude Code blocks `curl` and `wget` by default, requires approval for any network-making tool, and runs command injection detection that flags suspicious bash commands even if previously allowlisted.   OpenAI recommends never injecting untrusted input into developer/system messages, and extracting only structured fields (enums, validated JSON) from external sources.   For your self-modification pipeline, this means: the agent proposes code changes as structured diffs, a separate validation step checks them against security rules, and only then are they applied — never in a single unguarded step.

-----

## Deploy on Fly.io for the best security-to-simplicity ratio

**Fly.io is the recommended deployment platform**, beating Railway on security and AWS Lambda on practicality. Fly.io runs every app inside a Firecracker microVM — the same hardware-level isolation technology behind AWS Lambda — providing genuine VM boundaries rather than just container isolation.  Their new **Sprites** feature is purpose-built for AI coding agents, offering persistent VMs with checkpoint/restore, NVMe storage, and automatic idle shutdown.

Railway is fine for prototyping but provides weaker isolation (container-level, not VM-level) and fewer network control options. AWS Lambda’s **hard 15-minute execution timeout** is a fundamental dealbreaker for long-running agent loops.   A self-hosted VPS on Hetzner (€3.79/month for 2 vCPU, 2GB RAM) offers the best cost-to-control ratio but requires managing everything yourself.

Fly.io’s scale-to-zero capability means **your agent costs near-zero when idle**  — a shared-cpu-1x machine with 256MB RAM running 24/7 costs approximately $3–7/month, and with `auto_stop_machines` enabled, you pay only for active time. Deploy with a Dockerfile, configure private networking, and the Firecracker boundary handles the rest. 

-----

## A multi-model strategy cuts LLM costs by 70%+

Budget-conscious operation demands routing different tasks to different-priced models. The data strongly supports a **three-tier strategy** using prompt caching aggressively:

**Tier 1 — Routine tasks (80% of calls): Claude Haiku 4.5 at $1/$5 per million tokens.** Haiku 4.5 scores **73.3% on SWE-bench Verified** — within 5 points of Sonnet 4.5 — at one-third the cost and 4–5× the speed. Use it for code formatting, simple edits, file reading, classification, and most agent reasoning steps. OpenAI’s GPT-4o mini ($0.15/$0.60) is even cheaper for trivial tasks like routing decisions. 

**Tier 2 — Complex reasoning (15% of calls): Claude Sonnet 4.5 at $3/$15 per million tokens.** Reserve for multi-file refactoring, architectural decisions, and the actual self-modification code generation where quality directly impacts safety. OpenAI’s GPT-4.1 ($2/$8) is a viable alternative.

**Tier 3 — Bulk processing: DeepSeek V3.2 at $0.28/$0.42 per million tokens.**  For documentation ingestion, test generation, and bulk code analysis where cost matters more than peak quality.

**Prompt caching is the single biggest cost lever.** Anthropic’s caching gives a **90% discount on cached reads** (cache write costs 25% premium, but breaks even after just 2 hits).   Structure every request with static content first — system prompt, then tool definitions, then cached documentation, then the dynamic query. OpenAI’s caching is automatic and provides 50% savings.   For an agent that makes repeated calls with the same system prompt and tool definitions, caching alone can cut input costs by 60–80%.

Realistic monthly costs for a moderately active self-modifying agent:

|Component                      |Low activity|Medium activity|
|-------------------------------|------------|---------------|
|LLM API (multi-model + caching)|$7–12       |$25–50         |
|Infrastructure (Fly.io)        |$3–7        |$7–15          |
|**Total**                      |**$10–19**  |**$32–65**     |

-----

## Step-by-step blueprint for version 0.1

Here is the concrete build plan for the smallest viable self-improving agent, incorporating every security recommendation from Anthropic and OpenAI.

**Step 1: Set up the project skeleton (30 minutes).** Create a Python project with `pyproject.toml`, install `anthropic` SDK, initialize a git repo. Create four files: `agent.py` (core loop), `sandbox.py` (execution wrapper), `tools.py` (tool definitions), and `AGENT.md` (knowledge file). This is your entire codebase for v0.1.

**Step 2: Implement the sandboxed executor (1 hour).** Write `sandbox.py` to execute bash commands inside a Docker container with deny-all networking (allowlisting only `api.anthropic.com` and package registries). Use Docker’s Python SDK or shell out to `docker exec`. Every command runs with a **timeout** (default 30 seconds), **memory limit** (512MB), and **no-new-privileges** security option. For development, Docker Desktop’s sandbox mode works;  for production, switch to E2B’s `Sandbox.create()`  or Fly.io Sprites.

**Step 3: Build the agent loop (2 hours).** Implement the ReAct loop in `agent.py`: load `AGENT.md` into the system prompt, send messages to Claude Haiku 4.5, parse tool_use responses, route bash commands through the sandbox, append tool_result messages, and loop. Add a `MAX_STEPS` limit (start at 25). Add a `SELF_MODIFY_LIMIT` counter (start at 3 per session). When the agent’s task involves modifying its own files, require explicit confirmation via stdin before applying changes.

**Step 4: Add git-based safety (1 hour).** After every successful file modification, auto-commit with a descriptive message. Before any self-modification attempt, create a tagged checkpoint. If tests fail after modification, auto-revert to the checkpoint. Store the agent’s version history as `git log --oneline` in a format the agent can read and reason about.

**Step 5: Implement the self-improvement loop (2 hours).** Give the agent a task list in `tasks.json`. The improvement cycle: pick next task → read relevant documentation (from cached local copies or allowlisted URLs) → plan the modification → write code → run tests → if pass, commit and update `AGENT.md` with learnings → if fail, rollback and log. After each task, reset the conversation context to prevent confusion accumulation.  The agent reads its own source files via bash (`cat agent.py`), proposes changes, writes them to disk, runs validation, and the outer loop decides whether to accept.

**Step 6: Add documentation ingestion (1 hour).** Allow the agent to fetch and cache documentation from `docs.anthropic.com` and `platform.openai.com` within the sandbox (these domains are allowlisted). Store fetched docs as markdown files in a `docs/` directory. The agent reads these via bash to learn new API patterns and capabilities, then proposes tool additions or code improvements based on what it learns.

**Step 7: Deploy to Fly.io (1 hour).** Write a `Dockerfile` and `fly.toml`. Configure a persistent volume for the git repo and knowledge files. Set environment variables for API keys (never in code). Enable `auto_stop_machines` for scale-to-zero. Set up a simple webhook or CLI trigger to start agent sessions.

**Total estimated build time: 8–10 hours for a working v0.1.**

-----

## What to build after v0.1

Once the minimal loop works, the agent itself should help you build these improvements — that’s the whole point. Priority order for v0.2+:

The first upgrade is **multi-model routing**: add logic to classify task complexity and route to Haiku, Sonnet, or DeepSeek accordingly. This is a straightforward self-modification task the agent can tackle using its own documentation ingestion capability. Second, add **structured tool definitions** beyond bash — file read, file write, and web fetch as separate tools with schema validation, following Anthropic’s tool-use API patterns. Third, implement **persistent memory** using a vector store or structured index of past sessions, enabling the agent to recall solutions to previously-solved problems. Fourth, add **automated benchmarking** — the agent runs a test suite after each self-modification and tracks scores over time, accepting changes only when benchmarks improve.

The key architectural principle from Live-SWE-Agent applies: “Software agents are themselves software systems, and modern LLM-based agents already possess the intrinsic capability to extend or modify their own behavior at runtime.”  You don’t need to build elaborate self-modification infrastructure. You need to give a capable LLM access to its own source code, a shell, version control, and clear guardrails — then get out of the way.

-----

## Conclusion

The gap between “concept” and “working self-modifying agent” is far smaller than most assume. **Mini-SWE-Agent proved that ~100 lines of Python with bash access rivals complex agent frameworks.**  The real engineering challenge isn’t the agent loop — it’s the security boundary. Anthropic’s two-boundary sandbox model (filesystem + network isolation)  and OpenAI’s Codex sandbox architecture  both converge on the same answer: hardware-level isolation via Firecracker microVMs,  default-deny networking,   git-based rollback, and human approval for irreversible actions.

Your v0.1 should be ruthlessly minimal. Python, one LLM API call in a while loop, bash as the only tool, Docker for sandboxing, git for safety. The agent will tell you what it needs next — that’s the self-improvement loop working as designed. Start with Claude Haiku 4.5 for cost efficiency ($1/$5 per million tokens),   deploy on Fly.io for Firecracker isolation   at $3–7/month, and budget $15–60/month total. The three immovable constraints: **never skip sandboxing, never skip git commits, never let the agent approve its own modifications to production code.** Everything else is negotiable and improvable — preferably by the agent itself.