# Pi Teams: Coordinator + Worker Architecture

## Goal

Add a **teams** layer to pi-teams: a coordinator LLM that autonomously
orchestrates worker agents, receives their results, and dynamically decides
next steps. The user says "fix the auth bug" and the coordinator handles
research, synthesis, implementation, and verification across multiple workers
without further user intervention.

## Reference Implementation

Claude Code's coordinator mode (`claude-code-original/src/coordinator/coordinatorMode.ts`)
plus its AgentTool, SendMessageTool, TaskStopTool, and TeamCreateTool.

Studied source files for the parity target:
- `claude-code-original/src/coordinator/coordinatorMode.ts`
- `claude-code-original/src/tools/AgentTool/AgentTool.tsx`
- `claude-code-original/src/tools/AgentTool/prompt.ts`
- `claude-code-original/src/tools/TeamCreateTool/TeamCreateTool.ts`
- `claude-code-original/src/tools/TeamCreateTool/prompt.ts`

### Claude-style parity contract, minus tmux/in-process UI

This project should match the **user experience and public interaction model** of Claude Code Agent Teams as closely as possible, while explicitly omitting tmux panes, split panes, transcript switching, and other heavyweight UI/runtime machinery.

**Important rule:** when our earlier design guesses conflict with the reference UX, the reference UX wins. We should not invent a different public interaction model unless we make that divergence explicit and deliberate.

### Public API reference, target semantics

This is the user-facing contract we should emulate.

1. **Create a team once**
   - There is one active team for the lead session.
   - Team creation establishes shared team state and shared task state.
   - Team names are user-facing handles, not hidden internal IDs.
   - If a requested team name already exists, the UX should stay smooth. The reference implementation generates a unique fallback name instead of hard-failing.

2. **Spawn teammates through the normal worker tool surface**
   - In Claude Code, teammate spawning is not a separate conceptual product. It is the normal Agent tool with additional team context (`team_name`, `name`, optional mode/model).
   - User mental model: “launch teammates into this team”, not “switch to a second orchestration API family”.
   - Internal plumbing may differ here, but the public feel should be unified.

3. **Messages from teammates arrive automatically**
   - The lead does not need to poll an inbox just to learn results.
   - Teammate completion/idle/failure updates are pushed back automatically as user-role/internal notification turns.
   - Visibility commands are supportive, not the primary coordination loop.

4. **Continuing an existing teammate is normal**
   - The lead should prefer continuing a teammate that already has useful context loaded.
   - Idle is normal, not failure.
   - A teammate that finished a turn but is still part of the team should still feel addressable.
   - Stopping and resuming behavior should be designed from this UX first, not from the current process model first.

5. **Shared task list is central, not ornamental**
   - Team creation implies a shared task space.
   - Tasks are a live coordination surface for the team.
   - In the reference UX, teammates can read and update task ownership/completion themselves.
   - The lead coordinates task flow, but the system should feel like one shared board, not a lead-only bookkeeping table.

6. **The lead should not micromanage status checks**
   - The default interaction is: launch teammates, receive their updates automatically, continue or redirect them, synthesize for the user.
   - Explicit inspection commands are secondary.

7. **The user prompt style is natural language first**
   - The intended prompt is: “Create a team with 3 teammates to review this repo... wait for them to finish, then synthesize.”
   - The system should naturally map that to the team workflow without teaching a custom choreography first.

### User interaction reference, target flow

#### User says
```text
Create a team with 3 teammates to review this repo:
- architecture on Claude Sonnet
- testing on Codex
- docs on Haiku
Create tasks for each area, wait for them to finish, then synthesize the results.
```

#### Lead behavior
1. Create the team
2. Spawn the teammates into that team
3. Create or update the shared task list
4. Let teammates work in parallel
5. Receive teammate updates automatically
6. Continue teammates when context reuse is valuable
7. Synthesize results for the user
8. Shut down or end the team cleanly when finished

### User-perspective parity checklist

This is the practical checklist for deciding whether the user experience matches Claude-style Agent Teams. It intentionally ignores internal tool names and implementation details unless they leak into behavior.

| User expectation | Claude-style target behavior | Current pi-teams status |
|---|---|---|
| I can just ask for a team in natural language | The coordinator naturally maps that request into team creation, teammate spawning, shared tasks, waiting, and synthesis | **Mostly aligned**. Prompt + README now teach this flow clearly. |
| I do not need to know internal tool syntax | The user talks naturally, the lead handles orchestration internally | **Aligned** at the prompt/docs layer. This is the intended contract. |
| Creating a team should feel like starting a collaborative mode, not entering a separate admin product | Team creation is first-class, but teammate work still feels like normal agent delegation inside that team | **Not aligned yet**. Our internal surface still splits team management (`team_create`, `spawn_teammate`) from raw worker delegation more than the reference UX. |
| Once teammates are launched, they report back automatically | The lead should receive teammate progress/completion without manual polling | **Aligned enough**. Notifications exist and are the primary return path. |
| The lead should not need to babysit status checks | Inspection commands may exist, but the default loop is notification-first | **Partially aligned**. We have automatic notifications, but the current design and docs still lean on explicit `check_teammate` / `/team` more than the reference UX. |
| If a teammate already has useful context, continuing them should feel normal | Idle/waiting teammates are still naturally addressable; context reuse is a first-class behavior | **Not aligned yet**. Our current documented contract makes `send_message` running-only, which is stricter than the reference UX. |
| The team should share a living task board | Tasks are collaborative coordination state, not just lead bookkeeping | **Not aligned yet**. Our current design keeps task mutation lead-owned in v1. |
| Team context should reduce ceremony | After the lead has an active team, follow-up actions should rely on current team context as much as possible | **Not aligned yet**. We still require explicit `team_name` on the task/team tools everywhere. |
| Common team names should not create awkward friction | If a name collides, the experience should remain smooth | **Not aligned yet**. We currently hard-fail on team-name reuse instead of smoothing collisions. |
| Visibility tooling should feel supportive, not mandatory | `/team`, `/workers`, task listing, etc. are useful, but not the main coordination loop | **Mostly aligned**. Support tooling exists, but we should be careful not to over-teach it as the primary mode. |

### What “done” means from the user perspective

We should consider parity good enough when a user can say:

```text
Create a team with 3 teammates to review this repo, wait for them, then synthesize.
```

and the experience feels like this:
- the coordinator understands the request immediately
- teammates launch naturally without the user learning any internal API
- teammate updates come back automatically
- the coordinator continues or redirects teammates fluidly
- the task board behaves like shared team state
- the user experiences collaboration, not orchestration ceremony

### Explicit non-goals for parity work

We are **not** trying to copy these parts of Claude Code right now:
- tmux pane orchestration
- separate OS windows
- transcript zoom/switch UI
- in-process teammate execution model
- plan approval mode
- team memory
- richer inbox/mailbox systems

Those are implementation and UI complexities. The parity target here is the **interaction model**, not the exact backend.

### Current gap check against the reference UX

This is the checklist we should now use when evaluating the current implementation.

#### Already aligned
- [x] Natural-language “create a team...” prompting is documented and pushed in the coordinator prompt/README.
- [x] There is one active team per lead session.
- [x] Shared task persistence exists.
- [x] Team visibility commands exist as supporting UX.

#### Not yet aligned, still divergent from the reference UX
- [ ] **Teammate spawning is still a separate API family** (`spawn_teammate`) instead of feeling like the normal worker tool with team context.
- [ ] **Task coordination is lead-owned in our current design**, while the reference UX treats the task list as shared mutable coordination state for teammates too.
- [ ] **Our `send_message` contract is stricter than the reference UX**. We currently document running-only continuation, while the reference UX treats idle teammates as normal and still addressable.
- [ ] **Our lead currently checks teammates explicitly** (`check_teammate`) more than the reference UX expects. The reference loop is notification-first, inspection-second.
- [ ] **Our team-name behavior is rougher than the reference UX**. We currently hard-fail on name reuse; the reference UX smooths collisions by generating a unique fallback name.
- [ ] **Task tools require explicit `team_name` everywhere**. The reference UX uses current team context much more aggressively.

#### Product decision implied by this study

If we want the same UX as Claude Code Agent Teams, we should treat the current Wave 5 API as **provisional plumbing**, not final public canon. The target canon is:
- team creation as a first-class act
- teammate spawning that feels like the normal worker/agent tool in team context
- shared tasks as a real collaborative board
- automatic teammate updates as the primary feedback loop
- explicit inspection commands as secondary support tools

---

## What Already Exists (pi-teams baseline)

| Capability | Files |
|---|---|
| Agent discovery (builtin/user/project, priority layering) | `agents.ts`, `agent-scope.ts`, `agent-selection.ts` |
| Single/chain/parallel sync execution | `execution.ts`, `chain-execution.ts`, `parallel-utils.ts` |
| Async background execution (detached jiti process) | `async-execution.ts`, `team-runner.ts` |
| Result file watcher + coalesced notifications | `result-watcher.ts`, `file-coalescer.ts`, `completion-dedupe.ts` |
| Notification injection (`pi.sendMessage({triggerTurn: true})`) | `notify.ts` |
| Fork context (branch parent session to team) | `fork-context.ts` |
| Per-invocation model override | `schemas.ts` (`model` param), `execution.ts` |
| Process spawning (`--mode json`, `stdin: "ignore"`, stdout pipe) | `execution.ts:133-136`, `pi-spawn.ts`, `pi-args.ts` |
| Tool registration (`team` + `team_status`) | `index.ts:395-396` |
| Event bus (`team:started`, `team:complete`) | `index.ts:399-400` |
| Slash commands (`/run`, `/chain`, `/parallel`, `/agents`) | `slash-commands.ts` |
| Skill injection per step | `skills.ts` |
| Artifact system | `artifacts.ts` |
| Rich TUI rendering with streaming progress | `render.ts`, `render-helpers.ts` |
| Agent manager TUI overlay | `agent-manager*.ts`, `agent-management.ts` |
| Run history tracking | `run-history.ts` |
| Prompt template bridge (interop with pi-prompt-template-model) | `prompt-template-bridge.ts` |

---

## Critical Design Decision: Two Spawn Paths

The existing `async-execution.ts` spawns **detached jiti processes** with
`stdio: "ignore"` that survive parent exit. Coordinator-spawned workers need
a **foreground RPC process** with `stdin: "pipe"` for follow-up messages.
These are fundamentally different:

| | Existing async (`--bg`) | New coordinator workers |
|---|---|---|
| Spawn path | `async-execution.ts` → detached jiti | `execution.ts` → foreground RPC |
| stdio | `["ignore", "ignore", "ignore"]` | `["pipe", "pipe", "pipe"]` |
| Mode | `--mode json` | `--mode rpc` |
| Survives parent exit | Yes | No (dies with coordinator) |
| Accepts follow-up messages | No | Yes (via stdin) |
| Result delivery | File-based (result-watcher) | NDJSON stdout + file-based (crash recovery) |
| SendMessage support | No | Yes |

Both paths coexist. `--bg` keeps working as-is. Coordinator workers use the
new foreground RPC path in `execution.ts`.

---

## Feature 1: Agent Process Registry

### Purpose
Track running/completed agents by name and ID so SendMessage can route
messages and TaskStop can kill processes. Also handles worker lifecycle
(timeouts, cleanup on shutdown).

### Files to create
- **`agent-registry.ts`** (new, ~200 lines)

### Files to modify
- **`index.ts`** — wire `team:started` and `team:complete` events to registry,
  add `session_shutdown` and `session_switch` hooks for cleanup
- **`schemas.ts`** — add optional `name` field to `TeamParams`
- **`team-executor.ts`** — pass `name` through to execution, emit name in `team:started`
- **`types.ts`** — add `name?: string` to `Details` and `AsyncJobState`

### Types

```ts
// agent-registry.ts

export interface RegisteredAgent {
  id: string;                    // unique run ID (existing asyncId or generated)
  name?: string;                 // human-friendly name for SendMessage routing
  agentType: string;             // agent definition name (e.g., "worker", "scout")
  task: string;                  // original prompt
  pid?: number;                  // OS process ID (if known)
  status: "running" | "completed" | "failed" | "stopped" | "timed_out";
  startTime: number;
  endTime?: number;
  rpcHandle?: {                  // only for RPC-mode agents (Feature 2)
    stdin: import("stream").Writable;
    proc: import("child_process").ChildProcess;
  };
  result?: string;               // final output text
  sessionFile?: string;          // for resume via fork-context
  asyncDir?: string;             // for file-based async tracking
  cwd?: string;
}

export class AgentRegistry {
  private agents: Map<string, RegisteredAgent>;     // id → agent
  private nameIndex: Map<string, string>;           // name → id
  private timeoutSweepInterval: ReturnType<typeof setInterval> | null;

  register(agent: RegisteredAgent): void;
  resolve(nameOrId: string): RegisteredAgent | undefined;
  updateStatus(id: string, status: RegisteredAgent["status"], result?: string): void;
  getRunning(): RegisteredAgent[];
  getAll(): RegisteredAgent[];
  remove(id: string): void;

  // Lifecycle
  stopAll(): void;               // SIGTERM all running agents, called on shutdown
  startTimeoutSweeper(timeoutMs: number, intervalMs?: number): void;
  stopTimeoutSweeper(): void;
  dispose(): void;               // stopAll + stopTimeoutSweeper
}
```

### Schema change

```ts
// schemas.ts — add to TeamParams
name: Type.Optional(Type.String({
  description: "Name for the spawned agent. Makes it addressable via send_message while running."
})),
```

### Shutdown and session hooks

```ts
// index.ts
pi.on("session_shutdown", () => {
  registry.dispose();   // kills all workers, cleans up
});

pi.on("session_switch", () => {
  registry.stopAll();   // workers belong to old session
});
```

### Timeout sweeper

```ts
// Runs every 30s, stops workers exceeding workerTimeoutMs
startTimeoutSweeper(timeoutMs: number, intervalMs = 30_000): void {
  this.timeoutSweepInterval = setInterval(() => {
    const now = Date.now();
    for (const agent of this.getRunning()) {
      if (now - agent.startTime > timeoutMs) {
        this.stopAgent(agent.id);   // same as TaskStop logic
        this.updateStatus(agent.id, "timed_out");
        // emit team:complete with timed_out status
      }
    }
  }, intervalMs);
}
```

### Acceptance criteria
- [ ] `AgentRegistry` tracks agents by ID and resolves by name
- [ ] Name collisions return error at spawn time (no silent overwrites)
- [ ] `team:started` event populates registry
- [ ] `team:complete` event updates status and stores result
- [ ] Registry is accessible from SendMessage and TaskStop tools (module export)
- [ ] Optional `name` parameter appears in team tool schema
- [ ] Existing behavior unchanged when `name` is omitted
- [ ] `stopAll()` SIGTERMs all running agents
- [ ] `session_shutdown` calls `dispose()`
- [ ] `session_switch` calls `stopAll()`
- [ ] Timeout sweeper kills overdue workers and emits `timed_out` notification
- [ ] `proc.on("exit", ...)` updates registry status (handles unexpected exits)

### Tests to write
- **`agent-registry.test.ts`** (new):
  - register and resolve by ID
  - register and resolve by name
  - name collision throws
  - updateStatus transitions
  - getRunning filters correctly
  - resolve returns undefined for unknown name/id
  - remove cleans up both maps
  - stopAll kills all running agents
  - timeout sweeper fires for overdue agents
  - dispose cleans up sweeper interval

### Effort: 0.5 days

---

## Feature 2: RPC Mode Agent Spawning

### Purpose
Spawn teams with `--mode rpc` and `stdin: "pipe"` so we can send
follow-up messages to running agents. This is a NEW foreground spawn path
in `execution.ts`, separate from the existing detached async path.

### How pi RPC works
Pi's RPC mode reads JSON lines from stdin:
- `{"type": "prompt", "message": "..."}` — initial prompt
- `{"type": "steer", "message": "..."}` — inject during streaming
- `{"type": "follow_up", "message": "..."}` — queue for after current turn
- `{"type": "abort"}` — abort current operation

Output is the same NDJSON event stream as `--mode json`.

### Current spawn code (`execution.ts:73, 133-136`)

```ts
// Current: fire-and-forget JSON mode
baseArgs: ["--mode", "json", "-p"],
stdio: ["ignore", "pipe", "pipe"],
```

### Files to modify
- **`execution.ts`** — add `spawnMode` option to `runSync()`, new RPC spawn path
- **`pi-args.ts`** — add RPC args variant (no `-p` flag, no inline prompt)

### NOT modified
- **`async-execution.ts`** — untouched. Detached `--bg` jobs stay as-is.
  They do NOT support SendMessage (no stdin pipe).

### Implementation detail

```ts
// execution.ts — new option
export interface RunSyncOptions {
  // ... existing fields ...
  spawnMode?: "json" | "rpc";   // default: "json"
}

// When spawnMode === "rpc":
const { args, env, tempDir } = buildPiArgs({
  baseArgs: ["--mode", "rpc", "--no-session"],   // no -p (prompt via stdin)
  // task NOT included in args
  // session/model/tools/extensions/skills still passed as args
});

const proc = spawn(spawnSpec.command, spawnSpec.args, {
  cwd,
  env: spawnEnv,
  stdio: ["pipe", "pipe", "pipe"],   // stdin open for follow-ups
});

// Prevent unhandled errors on broken pipe (worker crashes)
proc.stdin.on("error", () => {});

// Send initial prompt via stdin
proc.stdin.write(JSON.stringify({ type: "prompt", message: task }) + "\n");

// Track process exit for registry cleanup
proc.on("exit", (code) => {
  registry.updateStatus(agentId, code === 0 ? "completed" : "failed");
});

// Do NOT call proc.unref() — worker should die with parent

// NDJSON parsing on stdout is identical to json mode
```

### Acceptance criteria
- [ ] `runSync()` accepts `spawnMode: "rpc"` option
- [ ] RPC mode spawns with `--mode rpc` and `stdin: "pipe"`
- [ ] Initial prompt sent via stdin JSON line, not CLI arg
- [ ] NDJSON stdout parsing works identically to JSON mode
- [ ] `proc.stdin` stored in agent registry via `rpcHandle`
- [ ] Default mode remains `"json"` (backwards compatible)
- [ ] RPC mode agents produce same `SingleResult` structure
- [ ] Temp prompt files not created for RPC mode (prompt goes via stdin)
- [ ] `proc.stdin.on("error", ...)` prevents unhandled errors on broken pipe
- [ ] `proc.on("exit", ...)` updates registry status
- [ ] `proc.unref()` NOT called for RPC workers (they die with parent)
- [ ] Existing `--bg` / async path completely untouched

### Tests to write
- **`pi-args.test.ts`** (extend existing):
  - buildPiArgs with rpc baseArgs produces correct args (no `-p`)
- **`test/rpc-spawn.test.ts`** (new):
  - RPC spawn sends prompt via stdin
  - RPC spawn parses NDJSON output correctly
  - RPC stdin reference is accessible after spawn
  - Abort via stdin `{"type": "abort"}` works
  - Process cleanup on exit code
  - Broken pipe handling (worker crashes, stdin error suppressed)

### Effort: 1 day

---

## Feature 3: SendMessage Tool

### Purpose
Let the coordinator send follow-up messages to running or stopped agents.

### Files to create
- **`send-message-tool.ts`** (new, ~200 lines)

### Files to modify
- **`index.ts`** — register tool when coordinator mode is active
- **`render.ts`** — add renderCall/renderResult for send_message

### Tool schema

```ts
const SendMessageParams = Type.Object({
  to: Type.String({
    description: "Agent name or ID to send message to"
  }),
  message: Type.String({
    description: "Message content to send to the agent"
  }),
});
```

### Resolution logic

```
resolve(to) in registry
  → found, status "running", has rpcHandle:
      Write {"type": "follow_up", "message": msg} to stdin
      Return { success: true, delivered: "queued" }

  → found, status "running", no rpcHandle (json/bg mode):
      Return error: "Agent was spawned in background mode and does not
      accept follow-up messages. Spawn with name parameter to enable."

  → found, status "completed" or "stopped":
      If agent has sessionFile:
        Spawn new RPC agent forked from that session
        Register as replacement in registry (same name, new ID)
        Return { success: true, delivered: "resumed" }
      Else:
        Return error: "Agent has no session to resume from."

  → not found:
      Return error with list of known agent names
```

### Rendering

```
send_message @researcher
  "now also check the test coverage"
```

### Acceptance criteria
- [ ] Tool registered as `send_message` with correct schema
- [ ] Routes by name (case-insensitive) and by raw ID
- [ ] Running RPC agent: writes follow_up JSON to stdin
- [ ] Running bg/JSON agent: returns actionable error
- [ ] Completed/stopped agent with session: resumes via fork + new RPC spawn
- [ ] Unknown agent: returns error with available agent names
- [ ] Tool result includes routing info (from/to/status)
- [ ] Rendered in TUI with sender → recipient display

### Tests to write
- **`test/send-message-tool.test.ts`** (new):
  - Routes to running RPC agent by name
  - Routes to running RPC agent by ID
  - Rejects message to bg-mode agent with helpful error
  - Resumes completed agent from session
  - Returns error for unknown agent with available names
  - Case-insensitive name matching
  - Writes correct JSON format to stdin

### Effort: 1.5 days

---

## Feature 4: TaskStop Tool

### Purpose
Let the coordinator stop a running worker agent.

### Files to create
- **`task-stop-tool.ts`** (new, ~100 lines)

### Files to modify
- **`index.ts`** — register tool when coordinator mode is active

### Tool schema

```ts
const TaskStopParams = Type.Object({
  task_id: Type.String({
    description: "Agent name or ID to stop"
  }),
  reason: Type.Optional(Type.String({
    description: "Why stopping (logged, not sent to agent)"
  })),
});
```

### Logic

```
resolve(task_id) in registry
  → found, status "running":
      If rpcHandle: write {"type": "abort"} to stdin, wait 2s, SIGTERM if still alive
      Else: SIGTERM directly
      Update registry status to "stopped"
      Return { success: true, task_id, agent, message: "Stopped" }

  → found, not running:
      Return error: "Agent is not running (status: {status})"

  → not found:
      Return error with available agent names
```

### Acceptance criteria
- [ ] Tool registered as `task_stop` with correct schema
- [ ] Resolves by name or ID (same as SendMessage)
- [ ] RPC agent: sends abort command, waits 2s, SIGTERM if still alive
- [ ] JSON/bg agent: SIGTERM directly
- [ ] Registry updated to "stopped" status
- [ ] Stopped agents can be resumed via SendMessage
- [ ] Returns error for non-running or unknown agents

### Tests to write
- **`test/task-stop-tool.test.ts`** (new):
  - Stops running RPC agent (abort + SIGTERM)
  - Stops running JSON/bg agent (SIGTERM)
  - Updates registry status
  - Rejects stop on already-stopped agent
  - Rejects stop on unknown agent
  - Resolves by name and by ID

### Effort: 0.5 days

---

## Feature 5: Enhanced Notification Format

### Purpose
Structured notifications so the coordinator LLM can make informed decisions.

### Files to modify
- **`notify.ts`** — add structured XML format when coordinator mode is active

### Current format (plain markdown)

```
Background task completed: **scout**

Found the bug at validate.ts:42...
```

### Coordinator format (XML, matches Claude Code's `<task-notification>`)

```xml
<task-notification>
<task-id>abc-123</task-id>
<task-name>researcher</task-name>
<status>completed</status>
<summary>Agent "researcher" completed</summary>
<result>Found the bug at validate.ts:42. The user field is undefined when...</result>
<usage>
  <total_tokens>15420</total_tokens>
  <tool_uses>8</tool_uses>
  <duration_ms>34200</duration_ms>
</usage>
</task-notification>
```

### Notification delivery timing

When the coordinator is mid-turn (streaming), notifications are queued
using `deliverAs: "followUp"`:

```ts
pi.sendMessage(
  { customType: "team-notify", content, display: true },
  { triggerTurn: true, deliverAs: "followUp" },
);
```

This ensures the notification arrives after the coordinator's current turn
completes, preventing mid-stream interruption.

### Acceptance criteria
- [ ] Coordinator mode: notifications use `<task-notification>` XML
- [ ] Non-coordinator mode: existing markdown format unchanged
- [ ] XML includes: task-id, task-name (if set), status, summary, result, usage
- [ ] Agent name from registry included when available
- [ ] Uses `deliverAs: "followUp"` to prevent mid-turn interruption
- [ ] `triggerTurn: true` fires coordinator's next turn

### Tests to write
- **`notify.test.ts`** (new):
  - Coordinator mode produces valid XML with all fields
  - Non-coordinator mode produces existing markdown
  - Missing fields gracefully omitted
  - Name field populated from registry when available
  - `deliverAs: "followUp"` passed in sendMessage options

### Effort: 0.5 days

---

## Feature 6: Coordinator Mode

### Purpose
A system prompt and mode flag that transforms the main LLM into a coordinator
that orchestrates workers instead of coding directly.

### Files to create
- **`coordinator-prompt.ts`** (new, ~300 lines) — the system prompt
- **`coordinator.ts`** (new, ~100 lines) — mode flag, state, settings, helpers
- **`agents/coordinator.md`** (new) — builtin agent definition for on-demand use

### Files to modify
- **`index.ts`** — register flag, hook `before_agent_start` for prompt injection,
  conditionally register `send_message` and `task_stop` tools
- **`team-executor.ts`** — force RPC async mode when coordinator is active
- **`notify.ts`** — check coordinator mode for notification format
- **`schemas.ts`** — update team tool description for coordinator context
- **`settings.ts`** — add coordinator settings

### Coordinator settings

```ts
// coordinator.ts or settings.ts
export interface CoordinatorSettings {
  maxConcurrentWorkers: number;   // default: 8
  workerTimeoutMs: number;        // default: 300000 (5 min)
}
```

Enforced in `team-executor.ts` before spawning:
```ts
if (isCoordinatorMode()) {
  const running = registry.getRunning().length;
  if (running >= settings.maxConcurrentWorkers) {
    return error(`Max concurrent workers (${settings.maxConcurrentWorkers}) reached. 
    ${running} workers running. Stop a worker with task_stop first.`);
  }
}
```

### Coordinator system prompt (adapted from Claude Code)

Key sections:
1. **Role** — "You are a coordinator. Direct workers to research, implement, verify."
2. **Tools** — `team` (spawn), `send_message` (continue), `task_stop` (kill)
3. **Notification format** — How `<task-notification>` arrives as user messages
4. **Worker capabilities** — What tools workers have access to
5. **Task workflow** — Phases: research → synthesis → implementation → verification
6. **Concurrency** — "Parallelism is your superpower. Launch independent workers
   concurrently. Max {maxConcurrentWorkers} workers at once."
7. **Writing prompts** — Self-contained briefings, never "based on your findings"
8. **Continue vs spawn** — Decision guide based on context overlap
9. **Verification** — "Prove code works, don't just confirm it exists"
10. **Example session** — Full multi-turn example with notifications

### Activation

```ts
// coordinator.ts
let coordinatorActive = false;

export function isCoordinatorMode(): boolean {
  return coordinatorActive;
}

export function setCoordinatorMode(active: boolean): void {
  coordinatorActive = active;
}

// index.ts
pi.registerFlag("coordinator", {
  description: "Enable coordinator mode (orchestrate workers instead of coding directly)",
  type: "boolean",
  default: false,
});

pi.on("session_start", () => {
  setCoordinatorMode(pi.getFlag("coordinator") === true);
  if (isCoordinatorMode()) {
    registry.startTimeoutSweeper(settings.workerTimeoutMs);
  }
});

pi.on("before_agent_start", (event, ctx) => {
  if (isCoordinatorMode()) {
    return {
      systemPrompt: getCoordinatorSystemPrompt(event.systemPrompt),
    };
  }
});
```

### Coordinator agent definition (`agents/coordinator.md`)

```markdown
---
name: coordinator
description: Orchestrates multiple workers to accomplish complex tasks
model: claude-sonnet-4
---
You are a coordinator. Break down the task, delegate to workers,
synthesize results, and report back. Do not implement directly.
```

This allows `/run coordinator "fix the auth bug"` without the global flag.

### Ctrl+C / abort behavior

When the user aborts (Ctrl+C) the coordinator:
1. Pi aborts the coordinator's current turn
2. Workers continue running (they're independent processes)
3. User can type new instructions to the coordinator
4. To kill all workers: coordinator calls `task_stop` or user uses `/stop-all`

To abort everything:
```ts
// index.ts — hook pi's abort
pi.on("session_shutdown", () => {
  registry.dispose();   // kills all workers
});
```

### Progress visibility

Running workers shown in the status widget via `render.ts`:
```ts
// render.ts — extend renderWidget()
// Show: agent name, duration, last tool call, status
// Example: "🔄 researcher (45s) — reading auth/validate.ts"
```

### Acceptance criteria
- [ ] `--coordinator` flag activates coordinator mode
- [ ] System prompt injected via `before_agent_start` hook
- [ ] System prompt covers all 10 sections from Claude Code's coordinator prompt
- [ ] `send_message` and `task_stop` tools only registered in coordinator mode
- [ ] All team spawns use RPC foreground mode when coordinator mode active
- [ ] Max concurrent workers enforced (default 8)
- [ ] Worker timeout enforced (default 5 min)
- [ ] `team` tool description simplified in coordinator mode
- [ ] `/run coordinator` works as on-demand coordinator via agent definition
- [ ] Running workers visible in status widget
- [ ] Ctrl+C aborts coordinator turn but workers survive
- [ ] `session_shutdown` kills all workers
- [ ] Existing non-coordinator behavior completely unchanged

### Tests to write
- **`test/coordinator.test.ts`** (new):
  - `isCoordinatorMode()` returns false by default
  - Flag activation sets coordinator mode
  - System prompt includes key sections (tools, workflow, notifications)
  - Tool descriptions adapted for coordinator context
  - Team forced to RPC async in coordinator mode
  - Max concurrent workers rejects when limit reached
  - Timeout sweeper starts on session_start in coordinator mode

### Effort: 1.5 days

---

## Execution Phases

```
Phase 0: Preparation (0.5 days)
├── package.json rename (pi-teams → pi-teams)
├── install.mjs update (clone URL, banner text)
├── Coordinator prompt FIRST DRAFT (iterate while building infra)
├── agents/coordinator.md + agents/worker.md updates
└── Settings additions (coordinator.maxWorkers, coordinator.workerTimeout)

Phase 1: Foundation (2 days)
├── Feature 1: Agent Registry + stopAll + timeout sweeper       (0.5d)
├── Feature 2: RPC Foreground Spawn (new path in execution.ts)  (1d)
└── Feature 5: Enhanced Notifications (with deliverAs)          (0.5d)

Phase 2: Tools (2 days)
├── Feature 4: TaskStop Tool (simpler, build first)             (0.5d)
├── Feature 3: SendMessage Tool (depends on registry + RPC)     (1.5d)
└── Ctrl+C / abort-all wiring

Phase 3: Coordinator (1.5 days)
├── Feature 6: Coordinator Mode (flag + prompt injection + tool gating)
├── Coordinator prompt refinement
└── /team, /workers, /stop slash commands

Phase 4: Polish (1 day)
├── Integration test: full coordinator loop (test/coordinator-e2e.test.ts)
├── team_status tool updates (show coordinator workers)
├── Widget showing running workers with progress
├── README rewrite with teams documentation
└── CHANGELOG
```

**Total: ~7 days**

**Minimum viable demo** (Phase 0 + Phase 1 + Feature 4 + Feature 6, skip SendMessage):
The coordinator can spawn workers and get notifications, but can't send
follow-ups. Still useful: coordinator plans, spawns workers in parallel,
synthesizes results, reports back. Proves the architecture. ~4 days.

---

## Status: Phases 0-4 Complete (Waves 1-4)

All phases above are **implemented and merged**. See commits:
- `8818e7f` Wave 1: Agent Registry, RPC Spawn, Enhanced Notifications
- `a26c403` Wave 2: TaskStop and SendMessage tools
- `173a307` Wave 3: Coordinator Mode integration
- `b8ea1c9` Wave 4: Polish + always-on coordinator
- `dd8a9f4` Fix package metadata

### What we have now
| Capability | Status | Files |
|---|---|---|
| Agent registry (name/ID tracking, lifecycle) | ✅ Done | `agent-registry.ts` |
| RPC foreground spawn (`--mode rpc`, stdin pipe) | ✅ Done | `execution.ts`, `team-executor.ts` |
| `send_message` tool (follow-up to running workers) | ✅ Done | `send-message-tool.ts` |
| `task_stop` tool (stop running workers) | ✅ Done | `task-stop-tool.ts` |
| Coordinator system prompt (10-section Claude-style) | ✅ Done | `coordinator-prompt.ts` |
| Coordinator mode (always-on, `before_agent_start` hook) | ✅ Done | `coordinator.ts`, `index.ts` |
| Enhanced notifications (XML `<task-notification>`) | ✅ Done | `notify.ts`, `notify-format.ts` |
| `/workers` and `/stop-all` slash commands | ✅ Done | `slash-commands.ts` |
| Timeout sweeper + max concurrent workers | ✅ Done | `agent-registry.ts`, `coordinator.ts` |

### What this gives us
The user says "fix the auth bug" and the coordinator LLM spawns named
workers, receives their notifications, sends follow-ups, stops bad workers,
and synthesizes results. This is the **coordinator/worker** model from
Claude Code's `coordinatorMode.ts`.

### What's missing: lean Claude Agent Teams parity
We do **not** need every Claude Agent Teams capability to get the right
behavior. The minimum useful parity is:

1. **Team lifecycle** — create a team, spawn named teammates, inspect them, shut the team down
2. **Shared task list** — explicit tasks the lead can create and teammates can work through
3. **Team-aware prompts/docs** — the lead should naturally use the team surface first
4. **Reuse existing worker plumbing** — registry, RPC spawn, `send_message`, `task_stop`, notifications

We are explicitly **not** building mailbox/inbox, templates, split panes,
or approval workflows in this pass. Those can come later only if the lean
version proves insufficient.

---

## Wave 5: First-Class Team API + Shared Tasks (~3 days)

### Purpose
Make pi-teams feel like Claude Agent Teams without adding a second big
architecture. The lead creates a team, spawns teammates with different
models, creates tasks, checks progress, and shuts the team down. Under the
hood we keep using the worker infrastructure from Waves 1-4.

### Scope
Add just these first-class tools:
- `team_create`
- `spawn_teammate`
- `check_teammate`
- `team_shutdown`
- `task_create`
- `task_list`
- `task_read`
- `task_update`

No mailbox, no broadcast, no plan approval, no template system.

### Public contract decisions (must be enforced)
To avoid the drift already present in the repo, this pass makes these
explicit contract decisions:

- **`team`** remains the low-level advanced worker-execution tool.
- **`team_status`** remains the low-level advanced worker-status tool.
- **`team_create` / `spawn_teammate` / `check_teammate` / `team_shutdown`** are the
  first-class Agent Teams surface.
- **`send_message`** supports **running teammates only** in the lean pass.
  Resuming completed/stopped teammates is out of scope.
- **Teams are session-scoped in behavior**, even though config/tasks are persisted
  on disk for visibility and cleanup.
- **Exactly one active team is allowed per lead session** in the lean pass.
  Starting a second active team in the same session must fail clearly.
- **Teammate names must be unique across all active named agents in the session**,
  not just inside the team.
- **`send_message`** and **`task_stop`** operate on running teammates only.
- **Task mutation is lead-owned in v1**. Teammates may read assigned tasks and
  report progress, but the lead is responsible for calling `task_update`.
- **One canonical lifecycle event family must be used end-to-end** for named
  teammate start/completion notifications, registry updates, and status widgets.
- **Lead and teammate roles must be runtime-distinct**. A spawned teammate must
  not receive the lead coordinator prompt or lead-only team lifecycle behavior.

If any of these decisions change, the plan, prompt, README, and tests must
be updated in the same change.

### Files to create
- **`team-manager.ts`** (new, ~250 lines) — runtime + persistence for teams
- **`task-store.ts`** (new, ~180 lines) — simple task persistence per team
- **`team-tools.ts`** (new, ~250 lines) — create/spawn/check/shutdown tools
- **`task-tools.ts`** (new, ~200 lines) — create/list/read/update tools

### Files to modify
- **`index.ts`** — register team/task tools, clean up active teams on shutdown, gate behavior by runtime role
- **`coordinator-prompt.ts`** — teach the lead to use teams/tasks as the primary surface
- **`schemas.ts`** — add team/task tool schemas if shared schema module is preferred
- **`slash-commands.ts`** — optional lightweight `/team` command for visibility
- **`team-executor.ts`** — allow teammate spawns to reuse current RPC worker path cleanly
- **`execution.ts`** or spawn metadata path — pass explicit runtime role/team metadata into spawned teammates
- **`notify.ts`** — listen to the canonical teammate completion event family
- **`notify-format.ts`** — support `completed|failed|stopped|timed_out` status explicitly
- **`send-message-tool.ts`** — keep descriptions and failure behavior aligned with running-only teammate continuation

### Team model
Keep it minimal:

```ts
export interface Team {
  name: string;
  description?: string;
  leadSessionId: string;
  defaultModel?: string;
  members: Array<{
    name: string;
    agentId: string;
    agentType: string;
    model?: string;
    status: "running" | "completed" | "failed" | "stopped";
    cwd: string;
  }>;
  createdAt: number;
}
```

Persist to:
- `~/.pi/teams/{team-name}/config.json`
- `~/.pi/teams/{team-name}/tasks.json`

No per-message mailbox files.

Add `state: "active" | "shutdown" | "orphaned"` to persisted team metadata so
stale teams from old sessions are distinguishable from live teams.

### Session lifecycle rules
Lean pass rules must be explicit:
- `session_start`: persisted teams whose `leadSessionId` does not match the current
  live session are treated as `shutdown` or `orphaned`, never as live teammates.
- `session_switch`: active team is shut down and marked non-active.
- `session_branch` / fork: no active team is inherited into the new branch.
- process crash / abrupt exit: persisted active team is reconciled to `orphaned`
  on next startup if its teammates are no longer alive.
- `team_shutdown`: stops teammates and marks metadata non-active. Deleting team
  files is out of scope for the lean pass.

### Task model
Also minimal:

```ts
export interface TeamTask {
  id: string;
  subject: string;
  description: string;
  status: "pending" | "in_progress" | "completed" | "deleted";
  owner?: string;
  createdAt: number;
  updatedAt: number;
  version: number;
}
```

No dependency graph or approval state in v1.
The lead assigns and updates tasks explicitly. Teammates can read task state
but do not directly mutate it in the lean pass.

### Task store write rules
- Writes must be atomic (`write temp` → `rename`).
- Task updates must check `version` to prevent lost updates.
- Corrupt or partial `tasks.json` must fail clearly, not silently reset.

### Tool schemas

| Tool | Parameters | Purpose |
|---|---|---|
| `team_create` | `{ team_name, description?, default_model? }` | Create a team |
| `spawn_teammate` | `{ team_name, name, prompt, cwd, model? }` | Spawn a teammate |
| `check_teammate` | `{ team_name, agent_name }` | Check teammate status |
| `team_shutdown` | `{ team_name }` | Stop all teammates and clean up runtime state |
| `task_create` | `{ team_name, subject, description }` | Create a task |
| `task_list` | `{ team_name }` | List tasks |
| `task_read` | `{ team_name, task_id }` | Read one task |
| `task_update` | `{ team_name, task_id, status?, owner? }` | Update task state or owner |

### Runtime role model
Lean parity uses three runtime roles:
- **lead** — the main session. Gets team lifecycle tools and team-first prompt behavior.
- **teammate** — a spawned named RPC worker inside a team. Does not get lead-only behavior.
- **raw-worker** — existing low-level worker path outside the first-class team lifecycle.

### Spawn behavior
`spawn_teammate` should:
1. Resolve the target team
2. Always create a **named RPC teammate** (never the blocking single-agent path)
3. Reuse current RPC teammate spawn path
4. Pass explicit role/team metadata into the spawned session
5. Register the spawned process in both `AgentRegistry` and `TeamManager`
6. Inject a lightweight teammate system prompt block
7. Return the teammate name, id, effective model, and team name

### Teammate system prompt block
Keep it simple:

```txt
You are a teammate in team "{team_name}".
Other teammates: {names}.
The lead manages the team and may send you follow-up messages.
Assigned task ids: {task_ids}.
Team config path: {config_path}.
Tasks file path: {tasks_path}.
Read task state to understand assigned work.
Do not mutate team lifecycle or task state unless explicitly allowed.
When you finish, report clearly so the lead can synthesize and update tasks.
```

This preserves the current lead-driven architecture while giving the right
mental model.

### Acceptance criteria
- [ ] `team_create` writes `config.json` under `~/.pi/teams/{team-name}/`
- [ ] `team_create` fails cleanly if a second active team is created in the same lead session
- [ ] `team_create` fails cleanly on duplicate active team names
- [ ] `spawn_teammate` always creates a named RPC teammate using existing worker infra
- [ ] `spawn_teammate` fails cleanly on duplicate active named-agent names in the session
- [ ] spawned teammates are runtime-role-isolated from the lead (no lead-only prompt/tool behavior)
- [ ] `check_teammate` returns effective model, team name, current status, and last known summary
- [ ] `team_shutdown` stops that team's members, marks team state `shutdown`, and is not overwritten by later process-exit races
- [ ] `task_create`, `task_list`, `task_read`, `task_update` persist to `tasks.json`
- [ ] only the lead session can mutate team lifecycle and task state in the lean pass
- [ ] task-store writes are atomic and version-checked
- [ ] stale active teams are reconciled to `shutdown` or `orphaned` on startup/resume
- [ ] `session_switch` and `session_branch` do not leave inherited active teammates behind
- [ ] `send_message` is documented and tested as **running-teammate-only** in this pass
- [ ] Lead prompt prefers team/task tools before raw worker spawning
- [ ] `team`, `team_status`, `send_message`, and `task_stop` remain available as advanced worker plumbing
- [ ] One canonical teammate lifecycle event family is used (or intentionally aliased) for spawn, completion, stop, timeout, notifications, registry updates, and widgets
- [ ] Existing coordinator/worker flow remains valid underneath

### Tests to write
- **`test/team-manager.test.ts`** (new):
  - create team
  - reject second active team in the same session
  - reject duplicate team name
  - spawn teammate
  - reject duplicate active named-agent name
  - check teammate status includes effective model
  - shutdown team
  - persistence round-trip including `state`
  - stale active team becomes `orphaned` or `shutdown` on bootstrap
- **`test/task-store.test.ts`** (new):
  - create/list/read/update tasks
  - owner assignment
  - status transitions
  - atomic write behavior
  - version mismatch rejects stale update
  - corrupt `tasks.json` fails clearly
- **`test/team-tools.integration.test.ts`** (new):
  - `team_create` + `spawn_teammate` + `check_teammate` + `team_shutdown` happy path
  - only the lead session can mutate team/task state
  - teammates are role-isolated from lead-only behavior
  - running teammate completion updates visible team state
  - `team_shutdown` / timeout terminal states are not overwritten by later exit races
  - teammate completion triggers the canonical notification path
  - stopped and timed-out teammates surface correct lifecycle status
- **`test/coordinator-integration.test.ts`** (extend):
  - coordinator prompt/tool surface prefers `team_create`/`spawn_teammate`/`task_create`
  - prompt does not promise completed-teammate resume
  - prompt/examples do not imply unnamed teammates in the first-class team path
- **`test/e2e-sandbox.test.ts`** (extend or add focused team-flow smoke test):
  - a user-style request to create a team exposes the correct team/task tool surface
  - headline flow: create team, spawn 3 teammates with different models, create tasks, wait/check, synthesize

### Effort: 3 days

---

## Wave 6: Prompt, Docs, and Thin UX Layer (~1.5 days)

### Purpose
Make the feature actually feel like Claude Agent Teams to the user.
The main missing piece after Wave 5 is not backend plumbing, it is the
public contract: prompt behavior, naming, docs, and a small amount of UI.

### Files to modify
- **`coordinator-prompt.ts`** — make team tools the default coordination path
- **`README.md`** — lead with natural-language team creation examples
- **`CHANGELOG.md`** — record the new team/task surface
- **`package.json`** — align package description/keywords with the public team contract
- **`agents/coordinator.md`** — update examples to use `team_create` and `spawn_teammate`
- **`agents/worker.md`** — add teammate framing
- **`install.mjs`** — align installer/help text with the actual public team contract
- **`slash-commands.ts`** — optional `/team` command to show active team + tasks
- **`render.ts`** — optional small widget showing current team members and status

### Prompt goals
The lead should naturally interpret prompts like:
- "Create a team with 3 teammates to review this repo"
- "Use Sonnet for one teammate and Codex for another"
- "Assign one teammate architecture, one testing, one DX"
- "Wait for teammates to finish, then synthesize"

The lead should prefer:
1. `team_create`
2. `spawn_teammate`
3. `task_create`
4. `check_teammate`
5. `send_message` only as a follow-up mechanism
6. `team_shutdown` when done

### README goals
Document only the lean mental model first:
1. Create a team
2. Spawn teammates
3. Create tasks
4. Let the lead coordinate
5. Shut the team down

Keep team/chain/parallel docs, but move them below the new team section.

### Examples to include (required)
Every example must be labeled by actor: **User says**, **Lead calls**, or
**Operator command**.

**User says**
```text
Create a team with 3 teammates to review this repo:
- architecture on Claude Sonnet
- testing on Codex
- docs on Haiku
Create tasks for each area, wait for them to finish, then synthesize the results.
```

**Lead calls**
```ts
team_create({
  team_name: "repo-review",
  description: "Review pi-teams for architecture, tests, and docs",
  default_model: "anthropic/claude-sonnet-4.6"
})

spawn_teammate({
  team_name: "repo-review",
  name: "architecture",
  prompt: "Review repository architecture and identify structural risks.",
  cwd: "/home/vadim/Code/pi-teams",
  model: "anthropic/claude-sonnet-4.6"
})

spawn_teammate({
  team_name: "repo-review",
  name: "testing",
  prompt: "Review tests, missing coverage, and regression risks.",
  cwd: "/home/vadim/Code/pi-teams",
  model: "openai/gpt-5.3-codex"
})

spawn_teammate({
  team_name: "repo-review",
  name: "docs",
  prompt: "Review docs drift, README accuracy, and user contract clarity.",
  cwd: "/home/vadim/Code/pi-teams"
  // Uses default_model fallback
})

task_create({
  team_name: "repo-review",
  subject: "Architecture review",
  description: "Assess boundaries, naming, and rollout risks."
})

task_create({
  team_name: "repo-review",
  subject: "Testing review",
  description: "Find missing tests, weak assertions, and integration gaps."
})

task_create({
  team_name: "repo-review",
  subject: "Docs review",
  description: "Check README/help/install output against the real tool surface."
})

check_teammate({ team_name: "repo-review", agent_name: "architecture" })
check_teammate({ team_name: "repo-review", agent_name: "testing" })
check_teammate({ team_name: "repo-review", agent_name: "docs" })

// Wait for teammates to finish, then synthesize their results for the user.
```

**Operator command**
```text
/workers
/stop-all
/team repo-review
```

If `/team` does not ship in Wave 6, remove that example and replace it with
`task_list({ team_name: "repo-review" })` + `check_teammate(...)` as the
canonical visibility path.

### Acceptance criteria
- [ ] Natural-language examples in prompt and README match Claude-style invocation
- [ ] Team tools are described as the primary surface
- [ ] Existing raw worker/team concepts are described as implementation detail or advanced mode
- [ ] README, installer/help text, builtin agent prompts, package metadata, and coordinator prompt all use the same public tool names
- [ ] No user-facing copy instructs users to use `--coordinator` if coordinator stays always-on
- [ ] A full example shows 3 teammates, distinct model choices, task creation, waiting/checking, and synthesis
- [ ] `default_model` fallback and per-teammate model override are both documented
- [ ] Optional `/team` visibility command shows current team and tasks, or the docs explicitly present `task_list` + `check_teammate` as the supported alternative
- [ ] Optional widget shows active teammates cleanly
- [ ] Every top-level example is actor-labeled and copy-pasteable for that actor

### Integration tests to add/extend
- **`test/e2e-sandbox-install.test.ts`** (extend): installer/help output matches the new public contract
- **`test/e2e-sandbox.test.ts`** (extend): README-style team examples map to available tools/commands
- **`test/coordinator-integration.test.ts`** (extend): builtin coordinator prompt and `agents/coordinator.md` stay aligned
- **`test/public-contract.test.ts`** (new or extend existing integration coverage):
  - top-level docs/help/prompts do not mention removed or deferred behavior
  - no top-level docs require `--coordinator`
  - `send_message` contract is consistently documented as running-only

### Effort: 1.5 days

---

## Post-Wave 6: Claude-style parity waves

Wave 5 and Wave 6 gave us a working first pass, but they should now be treated as
**provisional plumbing plus first-pass UX**, not final canon. The remaining work
should be organized around user experience parity, not around preserving the
current internal API shape.

### Parity Wave A: Canonical interaction model + public contract (~1 day)

**Purpose**
Freeze what the user experience should be, based on the reference behavior.
This wave is about deciding the contract before changing more runtime logic.

**Decisions to make and record in the plan/docs/tests**
- Is teammate spawning still a separate public tool family, or should it be taught as normal worker delegation inside team context?
- Should active team context remove the need to pass `team_name` on every follow-up action?
- Are `check_teammate` and `/team` primary coordination surfaces, or explicitly secondary visibility tools?
- Is `send_message` allowed for idle teammates, or only actively running ones?
- Should team name collisions smooth to a unique fallback, matching the reference UX?

**Acceptance criteria**
- [ ] One canonical user interaction model is written down with no contradictions across plan, README, prompt, and tests
- [ ] The plan explicitly marks which current Wave 5 APIs are canonical vs provisional plumbing
- [ ] A user-perspective checklist exists and is used as the review bar
- [ ] No docs accidentally teach a coordinator workflow we intend to remove

### Parity Wave B: Runtime semantics and teammate lifecycle (~2 days)

**Purpose**
Make the coordinator behave like the intended collaboration model, not just
sound like it in the docs.

**Focus**
- Teammate continuation semantics (`send_message`, idle vs running, stop vs resume)
- Notification-first loop, explicit inspection second
- Team lifecycle correctness (stop, timeout, shutdown, late exits)
- Lead/session ownership correctness
- Smooth team-name handling

**Acceptance criteria**
- [ ] Continuing a teammate with useful loaded context feels natural and predictable
- [ ] Idle is not treated like failure
- [ ] Automatic teammate updates are the primary coordination loop
- [ ] Team stop/timeout/shutdown semantics are race-safe and user-legible
- [ ] Team creation/reuse behavior is smooth and reference-aligned

### Parity Wave C: Shared task board + current-team context (~2 days)

**Purpose**
Make tasks feel like shared team coordination state instead of lead-only bookkeeping.

**Focus**
- Decide and implement whether teammates can mutate task ownership/completion
- Reduce explicit `team_name` ceremony where current team context exists
- Make task flow feel like one shared board
- Ensure lead and teammates see the same coordination state

**Acceptance criteria**
- [ ] The task board behaves like shared team state
- [ ] Common follow-up actions do not require repeated explicit team naming when current team context is already known
- [ ] Teammate/task ownership semantics are clear, enforced, and documented
- [ ] The user experience feels collaborative, not like manual orchestration bookkeeping

### Review gate after Parity Wave C

Re-check the user-perspective parity checklist. The project is in a good spot when
this user request works naturally and predictably:

```text
Create a team with 3 teammates to review this repo, wait for them, then synthesize.
```

The user should not need to know internal tool syntax, and the coordinator should
not need to over-rely on explicit status inspection to make progress.

---

## Deferred until proven necessary
These are **not** part of lean parity:
- Inbox/mailbox persistence
- Broadcast messaging
- Plan approval workflow
- Task dependency graphs / self-claim locking
- Predefined team templates
- In-process teammate switching / Shift+Down
- tmux or iTerm2 split-pane orchestration
- Graceful shutdown negotiation

If Wave 5 + Wave 6 still feel materially worse than Claude Agent Teams,
we can add the smallest missing piece next instead of pre-building all of them.

---

## Revised Execution Timeline

```text
Phases 0-4: COMPLETE (Waves 1-4)                      ✅
├── Agent Registry, RPC Spawn, Notifications
├── TaskStop + SendMessage tools
├── Coordinator Mode + prompt
└── Polish + always-on coordinator

Wave 5: First-Class Team API + Shared Tasks           ✅ implemented
├── team_create / spawn_teammate / check_teammate / team_shutdown
├── task_create / task_list / task_read / task_update
├── Persist team config + tasks
└── Reuse existing RPC worker infrastructure

Wave 6: Prompt, Docs, and Thin UX Layer               ✅ implemented
├── Coordinator prompt becomes team-first
├── README examples become Claude-style
├── /team visibility command added
└── Terminology cleanup

Parity Wave A: Canonical interaction model            (~1d)
├── Freeze public contract from the reference UX
├── Mark current APIs canonical vs provisional
└── Align plan/docs/tests to the same model

Parity Wave B: Runtime semantics + lifecycle          (~2d)
├── Teammate continuation semantics
├── Notification-first coordination loop
├── Race-safe lifecycle transitions
└── Smooth team-name behavior

Parity Wave C: Shared task board + team context       (~2d)
├── Shared task ownership/mutation model
├── Reduce repeated team_name ceremony
├── Make current-team context first-class
└── Final parity re-check against user-perspective checklist
```

**Remaining for Claude-style parity: ~5 days**

**Minimum useful parity target:** the user can say
"Create a team with 3 teammates to review this repo, wait for them, then synthesize"
and the coordinator handles that in a way that feels like collaborative agent teamwork, not manual orchestration bookkeeping.

---

## Lean Agent Teams Architecture Diagram

```text
┌──────────────────────────────────────────────────────┐
│ User                                                 │
│ "Create a team with 3 teammates to review pi-teams" │
└─────────────────────────┬────────────────────────────┘
                          │
                          ▼
┌──────────────────────────────────────────────────────┐
│ Team Lead (pi)                                       │
│ Tools:                                               │
│   team_create, spawn_teammate, check_teammate,       │
│   team_shutdown, task_create, task_list,             │
│   task_read, task_update, send_message, task_stop    │
└──────────┬───────────────┬───────────────┬───────────┘
           │               │               │
           ▼               ▼               ▼
      teammate A      teammate B      teammate C
       (RPC worker)    (RPC worker)    (RPC worker)
           │               │               │
           └───────────────┴───────────────┘
                           │
                           ▼
              ~/.pi/teams/{team-name}/
                ├── config.json
                └── tasks.json
```

### How it differs from current coordinator/worker mode

| Aspect | Current (Waves 1-4) | Lean parity target (Waves 5-6) |
|---|---|---|
| Lead surface | raw worker delegation | first-class team + teammate tools |
| Task tracking | implicit in prompts | explicit shared task list, lead-updated in v1 |
| Team concept | none | persisted team config, one active team per lead session |
| Worker continuation | `send_message` for running workers | same mechanism for running teammates only |
| User prompt style | coordinator-ish | Claude-style "create a team..." |

---

## Waves 1-4 Worker Plumbing Architecture Diagram

```
┌─────────────────────────────────────────────────────┐
│                      User                            │
│              "fix the auth bug"                      │
└──────────────────────┬──────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────┐
│              Coordinator LLM                         │
│  (system prompt from coordinator-prompt.ts)          │
│                                                      │
│  Tools: team, send_message, task_stop                │
│  + all standard tools (bash, read, edit, etc.)       │
│                                                      │
│  Receives: <task-notification> XML as user messages   │
│  Decides:  spawn, continue, stop, synthesize, report │
│                                                      │
│  Limits: max 8 workers, 5 min timeout per worker     │
└───┬──────────┬──────────┬───────────────────────────┘
    │          │          │
    ▼          ▼          ▼
┌────────┐ ┌────────┐ ┌────────┐
│Worker A│ │Worker B│ │Worker C│   (pi --mode rpc, foreground)
│research│ │ tests  │ │  impl  │
│        │ │        │ │        │
│ stdin ◄┤ │ stdin ◄┤ │ stdin ◄┤   ← send_message writes here
│ stdout─┤ │ stdout─┤ │ stdout─┤   → NDJSON events (progress)
└────┬───┘ └────┬───┘ └────┬───┘
     │          │          │
     ▼          ▼          ▼
  result     result     result     (file-based, for crash recovery)
  .json      .json      .json
     │          │          │
     └──────────┴──────────┘
                │
                ▼
     ┌──────────────────┐
     │  result-watcher   │  (fs.watch, coalesced)
     │  → notify.ts      │  (formats <task-notification>)
     │  → pi.sendMessage │  (deliverAs: "followUp")
     └──────────────────┘
                │
                ▼
        Back to Coordinator
        (next turn triggered)
```

---

## Waves 1-4 New Files Summary

| File | Purpose | Lines (est) |
|---|---|---|
| `agent-registry.ts` | Track agents by name/ID, lifecycle management | ~200 |
| `send-message-tool.ts` | SendMessage tool | ~200 |
| `task-stop-tool.ts` | TaskStop tool | ~100 |
| `coordinator-prompt.ts` | Coordinator system prompt | ~300 |
| `coordinator.ts` | Mode flag, settings, helpers | ~100 |
| `agents/coordinator.md` | Builtin coordinator agent definition | ~20 |
| `agent-registry.test.ts` | Registry unit tests | ~120 |
| `notify.test.ts` | Notification format tests | ~60 |
| `test/send-message-tool.test.ts` | SendMessage integration tests | ~120 |
| `test/task-stop-tool.test.ts` | TaskStop integration tests | ~80 |
| `test/coordinator.test.ts` | Coordinator mode tests | ~100 |
| `test/rpc-spawn.test.ts` | RPC spawn tests | ~100 |
| `test/coordinator-e2e.test.ts` | Full coordinator loop integration test | ~150 |

## Waves 1-4 Modified Files Summary

| File | Changes |
|---|---|
| `index.ts` | Register flag, wire registry to events, conditionally register new tools, `before_agent_start` hook, `session_shutdown`/`session_switch` cleanup |
| `schemas.ts` | Add `name` parameter to `TeamParams`, slim coordinator description |
| `execution.ts` | Add `spawnMode: "rpc"` option, RPC spawn path with `stdin: "pipe"`, process exit tracking |
| `pi-args.ts` | Add RPC args variant (no `-p`, no inline prompt) |
| `team-executor.ts` | Pass `name` through, force RPC mode in coordinator, enforce max workers |
| `notify.ts` | Structured XML format when coordinator active, `deliverAs: "followUp"` |
| `types.ts` | Add `name` to Details/AsyncJobState |
| `render.ts` | Render send_message/task_stop tool calls, running workers widget |
| `settings.ts` | Add `coordinator.maxWorkers`, `coordinator.workerTimeout` |
| `package.json` | Rename to `pi-teams`, update description/URLs |
| `install.mjs` | Update clone URL and banner text |
| `agents/worker.md` | Add coordinator context guidance |
| `slash-commands.ts` | Add `/workers`, `/stop-all`; `/team` is optional in lean Wave 6 |
| `README.md` | Full rewrite with teams documentation |

---

## Non-Goals (lean parity pass)

Explicitly deferred until the lean team/task model proves insufficient:

- File-based inbox/mailbox persistence
- Broadcast messaging
- Plan approval workflow
- Task dependency graphs and self-claim locking
- Predefined team templates
- tmux/iTerm2 split panes
- In-process teammate switching / direct teammate UI
- Graceful shutdown negotiation
- Fork/clone mode with cache sharing
- Disk-based agent resume beyond existing fork-context behavior
- Custom tool pool per worker
- Cross-worker shared scratchpad directory
- Progress summarization / transcript condensation
- Token budget / cost tracking for team runs
- Nested teams
- Cross-session team transfer

## Backwards Compatibility

- Low-level `team` and `team_status` tools remain for advanced worker execution/status
- New `team_*` and `task_*` tools become the primary public Agent Teams surface
- Single/chain/parallel modes unchanged
- Async/background (`--bg`) mode unchanged
- Slash commands unchanged except for optional team visibility additions
- `name` parameter remains optional for low-level worker usage, but `spawn_teammate` always creates named RPC teammates
- Existing coordinator/worker flow continues to work as-is underneath the team layer
- `send_message` and `task_stop` work with standalone workers and with **running** teammates in the lean pass
- Completed/stopped teammate resume is explicitly out of scope for this pass
- One active team per lead session is an intentional v1 limitation, not a regression
