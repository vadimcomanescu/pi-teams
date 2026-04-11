# Claude Team Lifecycle Parity Plan (pi-teams)

## Goal
Bring `pi-teams` team lifecycle behavior as close as possible to Claude Code team lifecycle behavior, without adding unrelated abstractions.

Primary parity target:
- Explicit team creation and controlled teammate spawn
- **Fundamental lifecycle guarantees**: auto-disband/cleanup, graceful shutdown semantics, resilient task ownership
- Reliable lead/teammate coordination state

## Scope
This plan focuses on lifecycle + coordination parity and the minimum operator-facing visibility needed to make that lifecycle trustworthy. It does not stop at backend cleanup alone. If a lead cannot clearly see teammate state, current work, and shutdown/disband status in the TUI, the lifecycle work is incomplete.

## Non-goals
- Re-architecting executor/runtime model
- Replacing current task board format with a new system
- Template/predefined team features (can be added later)
- Inventing new auto-disband semantics that diverge from Claude without explicit approval

---

## Gap Summary (Current vs Claude)

### Already strong in current repo
- Coordinator-mode orchestration prompt and process
- Lead ownership enforcement (`one active team`, lead control checks)
- Teammate continuation (`send_message` can resume idle session)
- Session hooks for switch/branch/shutdown

### Missing or weaker vs Claude
1. No hard `team_delete` with full filesystem cleanup semantics
2. No session-created-team registry + automatic cleanup on shutdown
3. No automatic task unassignment when teammate stops/times out
4. No graceful shutdown request/approve/reject protocol
5. No explicit idle/active teammate state management tied to lifecycle
6. No periodic orphan directory cleanup policy tied to team lifecycle integrity
7. No team permission/mode sync protocol parity

### Claude Parity Contracts to Mirror
- `cleanupSessionTeams` semantics: session-created teams are auto-cleaned on session end.
- `TeamDelete` semantics: deterministic physical cleanup after teammate stop.
- `unassignTeammateTasks` semantics: open tasks owned by dead teammate become claimable.
- shutdown mailbox flow semantics: request -> approve/reject -> lifecycle transition.
- lifecycle semantics: running vs idle vs resumable must be explicit and machine-checkable.
- lead visibility semantics: the operator can inspect teammate state and see enough current-work/progress information to decide whether to continue, stop, or delete the team.

### Intended public API shape after parity work
Lead lifecycle surface:
- `team_create({ team_name, description?, agent_type? })`
- `spawn_teammate({ team_name?, name, prompt, cwd, model? })`
- `check_teammate({ team_name?, agent_name })`
- `send_message({ to, summary?, message })`
- `team_shutdown({ team_name? })`
- `team_delete({})` (Claude-parity physical cleanup for the current active team)
- `task_create`, `task_list`, `task_read`, `task_update`

Semantics:
- `team_shutdown` stops teammates and marks the team inactive, but does not guarantee physical deletion.
- `team_delete` is the final disband operation for the current active team. It removes team/task state on disk, unregisters the session-created team, and makes the team unrecoverable, but only after teammates are no longer active, matching Claude `TeamDelete` semantics.
- If there is no current active team, `team_delete` is a successful no-op, matching Claude.
- `team_create` matches Claude creation semantics and shape: it uses Claude-style `agent_type?`, generates a unique name if the requested team name already exists, and fails if the lead is already managing an active team.
- Auto-cleanup matches Claude: if the lead session ends without `team_delete`, session-created teams are cleaned automatically on shutdown/switch/branch. Session cleanup is the path that must stop/kill orphaned teammate runtimes before removing persisted state.
- We do **not** add a novel "auto-delete immediately when tasks reach zero" behavior unless explicitly approved, because that would diverge from Claude.
- For Claude parity, structured shutdown messaging goes through `send_message`; rejection requires a reason.
- For Claude parity, `send_message` requires `summary` when `message` is a plain string.

### Claude Reference Mapping (implementation inspiration, not greenfield invention)
Use these Claude files/symbols as the primary design reference when implementing each PR:

- **PR1 Team Delete**
  - `src/tools/TeamDeleteTool/TeamDeleteTool.ts` (`TeamDeleteTool.call`)
  - `src/utils/swarm/teamHelpers.ts` (`cleanupTeamDirectories`, `destroyWorktree`)

- **PR2 Session Cleanup**
  - `src/tools/TeamCreateTool/TeamCreateTool.ts` (`registerTeamForSessionCleanup` call site)
  - `src/utils/swarm/teamHelpers.ts` (`registerTeamForSessionCleanup`, `unregisterTeamForSessionCleanup`, `cleanupSessionTeams`)
  - `src/entrypoints/init.ts` (shutdown hook registering `cleanupSessionTeams`)
  - `src/bootstrap/state.ts` (`sessionCreatedTeams`)

- **PR3 Task Unassignment on teammate exit**
  - `src/utils/tasks.ts` (`unassignTeammateTasks`)
  - `src/hooks/useInboxPoller.ts` (shutdown-approved path invoking unassignment)

- **PR4 Graceful shutdown protocol**
  - `src/tools/SendMessageTool/SendMessageTool.ts` (`shutdown_request`, `shutdown_response` structured message schema)
  - `src/utils/teammateMailbox.ts` (serialized shutdown request/response message creation)
  - `src/hooks/useInboxPoller.ts` (request/response handling)
  - `src/tasks/InProcessTeammateTask/InProcessTeammateTask.tsx` + `src/utils/swarm/inProcessRunner.ts` (shutdown request handling path)

- **PR5 Idle/Active lifecycle**
  - `src/utils/swarm/teamHelpers.ts` (`setMemberActive`)
  - `src/utils/swarm/teammateInit.ts` (idle notification + active-state update)
  - `src/utils/swarm/inProcessRunner.ts` (`sendIdleNotification`, idle loop)

- **PR6 TUI visibility and progress parity**
  - `src/components/teams/TeamsDialog.tsx` (team roster/status rendering)
  - `src/components/Spinner/TeammateSpinnerLine.tsx` (compact teammate state rendering)
  - `src/hooks/useBackgroundTaskNavigation.ts` (teammate navigation/view behavior)

- **PR7 Orphan cleanup policy**
  - `src/utils/swarm/teamHelpers.ts` (`cleanupSessionTeams`, pane cleanup, directory cleanup)

- **PR8 Mode sync**
  - `src/utils/teammateMailbox.ts` (`mode_set_request`, team permission update messages)
  - `src/hooks/useInboxPoller.ts` (mode set processing)
  - `src/utils/swarm/teamHelpers.ts` (`setMemberMode`, `setMultipleMemberModes`)

- **PR9 Task dependency parity**
  - `src/utils/tasks.ts` (`blockTask`, dependency updates)
  - `src/tools/TaskUpdateTool/TaskUpdateTool.ts` (dependency mutation contract)

Do-not-invent rule for PR1-PR5:
- First replicate Claude behavior contract and state transitions.
- Only diverge when required by pi runtime differences, and document divergence explicitly in PR notes.

### Remaining Claude differences intentionally deferred (not forgotten)
These are real Claude differences, but they are not required for this lifecycle parity plan:
- broader mailbox/permission flows not directly required by lifecycle parity
- plan approval UX beyond the shutdown-mode parity covered here

If any deferred item becomes necessary during implementation, add it as a real PR, not as an implicit side change.

### Claude parity rule for this plan
Do not invent new lifecycle behavior. If Claude already defines the lifecycle behavior, copy that behavior and adapt only the repo plumbing around it.
- `team_delete` must refuse to delete teams with active non-lead members, as Claude does.
- Session-end cleanup is the place that must stop/kill orphaned teammate runtimes before deleting persisted team state.
- The public structured shutdown contract stays aligned to Claude `send_message`: `shutdown_request`, `shutdown_response`, `request_id`, `approve`, optional rejection `reason`.

---

## Delivery Strategy
Implement in narrow PR slices, each with **enforcement-first tests**:
1. Add failing tests for the class of lifecycle bug
2. Implement minimal behavior to satisfy tests
3. Verify with targeted test runs

All PRs must keep behavior backward-compatible for existing lead tool users unless explicitly documented.

Acceptance criteria interpretation rule:
- A criterion is "met" only if there is at least one automated test that fails before implementation and passes after implementation.
- "Manual only" validation is allowed only for terminal/OS integration behavior that cannot be reliably unit tested, and must be listed explicitly as manual verification.

Cross-cutting constraints (apply to PR1-PR9):
- **Schema evolution safety**: any new persisted fields in team/task state must be backward-compatible and default-safe when missing.
- **Lifecycle message validation**: structured shutdown/mode messages must follow Claude's public routing and payload validation rules.
- **Locking discipline**: team config and task mutations must stay atomic under concurrent updates.
- **No behavior drift on session transitions**: `session_switch`, `session_branch`, and `session_shutdown` must produce deterministic lifecycle outcomes.
- **Public tool contract stability**: existing tool names/required params keep behavior; additive params/fields only unless explicitly approved.

Public contract checklist for every PR:
- Tool request schema changes documented (added/removed/required fields), including Claude parity rules like `team_delete({})`, `team_create.agent_type`, and `send_message.summary` requirements for plain-text messages.
- Tool response `details` changes documented.
- Error text for common failure cases documented and tested.
- For `check_teammate` and team TUI surfaces, newly added lifecycle/progress fields are named and documented before implementation.

Canonical naming decisions for parity work:
- `team_delete` is the Claude-parity physical cleanup tool for the current active team.
- `team_shutdown` remains a backward-compatible stop/mark-shutdown tool unless explicitly deprecated later.
- Graceful shutdown messaging uses Claude-style `send_message` structured payload names:
  - `shutdown_request`
  - `shutdown_response` with `approve: true|false`
- Structured lifecycle messages follow Claude routing rules:
  - `shutdown_response` targets the lead only
  - structured lifecycle messages are not broadcast
- Internal helper names may use `approved` / `rejected`, but external wire contract should follow Claude naming.

### Execution Order and Hard Gates

| Order | PR | Must pass before next PR |
|---|---|---|
| 1 | PR1 Team Delete, done | delete tests + no regressions in existing team create/spawn/shutdown flows |
| 2 | PR2 Session Cleanup, done | PR1 stable in manual run + shutdown cleanup tests green |
| 3 | PR3 Task Unassign, done | timeout/stop integration verified with registry hooks |
| 4 | PR4 Graceful Shutdown | protocol tests green + no breakage to plain send_message follow-up path |
| 5 | PR5 Idle/Active State | check_teammate output contract frozen and documented |
| 6 | PR6 TUI Visibility | teammate state/progress rendering tests green |
| 7 | PR7 Orphan Cleanup | dry-run safety and active-team preservation tests green |
| 8 | PR8 Mode Sync | invalid update protections tested |
| 9 | PR9 Task Dependencies | dependency mutation tests and blocked-task behavior tests green |

Hard rule: do not start PR4 before PR3 lands, because shutdown-approval semantics must reuse the unassignment path.

### P0 Parity Freeze (must match Claude semantics)
For PR1-PR5, implementation choices are constrained:
- Team delete must be physical cleanup, not state-only shutdown.
- Team delete must refuse deletion while non-lead teammates are still active.
- Session shutdown/switch/branch must clean teams created in the outgoing session.
- Session cleanup must stop/kill orphaned teammate runtimes before removing persisted team state.
- Dead teammate must never retain open task ownership.
- Graceful shutdown must support explicit approve/reject outcomes.
- Lifecycle status must distinguish running vs idle/resumable.

Any deviation requires explicit written exception in the PR description.

---

## PR1 - Team Delete + Full Physical Cleanup (P0) [done]

### Problem class
Teams can be logically shut down but persist physically, causing drift and stale state.

### Enforcement first
Add tests that fail if team delete drifts from Claude semantics:
- `team-manager.delete-team.test.ts` (new)
  - `deleteTeam should remove config and tasks directories for an inactive or shutdown team`
  - `deleteTeam should refuse deletion while non-lead teammates are active`
  - `deleteTeam should succeed as a no-op when there is no active team`
  - `deleteTeam should be safe to retry after cleanup`
  - `deleteTeam should reject non-lead callers`
- `team-tools.test.ts` updates for new `team_delete` tool behavior

### Implementation
- Add `team_delete` tool in `team-tools.ts`
- Keep `team_shutdown` behavior backward-compatible as stop-only/state transition behavior
- Add `deleteTeam(reason?)` in `team-manager.ts`
  - assert lead control
  - operate on the current active team only, matching Claude `TeamDelete`
  - if no active team exists, return a successful no-op and still normalize stale lead-side team state if present
  - allow delete for already-idle/inactive or `shutdown` teams owned by the lead
  - refuse delete when any non-lead teammate is still active, matching Claude `TeamDelete`
  - remove persisted team directory and task store path
  - clear active-team runtime/UI state for the lead session after successful delete, explicitly including lead team context, queued team inbox/messages, teammate color assignments, and leader-team task-list binding state
  - return structured summary (removed paths)
- Wire tool registration in `index.ts`

### Acceptance criteria
- `team_delete` exists and is lead-only
- `team_shutdown` remains available and keeps backward-compatible stop/mark-shutdown behavior
- `team_shutdown` behavior is regression-tested while `team_delete` is added
- `team_delete` refuses deletion while any non-lead teammate is active
- `team_delete` succeeds as a no-op when no active team exists
- After successful delete, `teamManager.getTeam(name)` returns not found
- Team dir and tasks file/dir are gone from disk
- Successful delete clears active lead-side team state so stale team context/inbox/UI rows are not left behind, including teammate color assignments and leader-team task-list binding state
- Already-idle/inactive and already-`shutdown` teams owned by the lead can be physically deleted
- Re-running delete is safe and does not leave partial state
- Non-lead callers cannot delete a team

---

## PR2 - Session-Created Team Registry + Auto Cleanup on Shutdown (P0) [done]

### Problem class
Interrupted sessions leak teams and artifacts indefinitely.

### Enforcement first
Add tests:
- `team-session-cleanup.test.ts` (new)
  - teams created in session are tracked
  - `team_create` generates a unique team name when the requested name already exists, matching Claude
  - `team_create` fails when the lead is already managing an active team, matching Claude's one-team-per-lead rule
  - shutdown hook stops/kills tracked teammate runtimes before deleting tracked team state
  - explicit delete unregisters team from session tracker
  - cleanup is best-effort and continues when one team cleanup or runtime-stop step fails

### Implementation
- Add per-session registry in `TeamManager` (or module-level session state linked to current lead session)
  - `registerCreatedTeam(name)`
  - `unregisterCreatedTeam(name)`
  - `cleanupSessionTeams(reason)`
- Update `team_create` to mirror Claude creation behavior:
  - if the lead already has an active team, fail instead of creating a second team
  - if the requested `team_name` already exists, generate a unique team name instead of failing
  - return the final generated team name in the tool result
- `cleanupSessionTeams(reason)` must mirror Claude ordering:
  - identify tracked teams for the outgoing session
  - stop/kill remaining teammate runtimes best-effort
  - then remove persisted team/task state
  - then clear the session registry entries
- Register cleanup on `session_shutdown` in `index.ts`
- Apply the same outgoing-session cleanup policy on `session_switch` and `session_branch` before the new session boots
- On `team_create`, register
- On `team_delete`, unregister

### Acceptance criteria
- `team_create` generates a unique team name on collision, matching Claude
- `team_create` fails when the lead already has an active team, matching Claude
- Session shutdown removes orphan teams created in that session
- Session cleanup stops/kills lingering teammate runtimes before persisted team/task state is removed
- No double-cleanup for teams explicitly deleted before shutdown
- Cleanup does not crash extension if one deletion or runtime-stop step fails
- Logs include team names cleaned up and failure details
- `session_switch`/`session_branch` behavior stays deterministic and does not resurrect deleted teams

---

## PR3 - Auto-Unassign Tasks on Teammate Stop/Timeout/Shutdown (P0) [done]

### Problem class
Task board stalls when dead teammates retain ownership.

### Enforcement first
Add tests:
- `task-store.unassign-on-teammate-exit.test.ts` (new)
  - `unassignTasksForOwner should reset pending and in_progress tasks to unowned pending`
  - `unassignTasksForOwner should preserve completed task status and owner`
  - `unassignTasksForOwner should not mutate tasks owned by other teammates`
- integrate with timeout/stop events in `index.ts` tests if existing harness allows

### Implementation
- Add helper in `task-store.ts`:
  - `unassignTasksForOwner(ownerName: string, options?)`
- Call helper from lifecycle exits:
  - timeout callback from registry sweeper
  - explicit `team_shutdown`
  - explicit teammate kill/stop paths
- Surface a summary line in completion notification where relevant

### Acceptance criteria
- No open task remains owned by terminated teammate
- Completed tasks keep historical ownership for audit trail
- Task board remains actionable after teammate death
- Unassignment path is idempotent and race-safe

---

## PR4 - Graceful Shutdown Protocol (Request / Approve / Reject) (P0) [done]

### Problem class
Hard-stop only semantics lose work context and diverge from Claude behavior.

### Enforcement first
Add tests:
- `teammate-shutdown-protocol.test.ts` (new)
  - lead can issue `shutdown_request` to teammate
  - teammate can `approve` or `reject`
  - approved -> teammate is stopped + team/member/task state updated
  - rejected -> teammate remains active and reason is surfaced
  - invalid shutdown responses fail Claude-style validation and do not mutate team state
- `send-message.validation.test.ts` or equivalent
  - plain-text `send_message` requires non-empty `summary`, matching Claude
  - structured shutdown messages keep existing routing validation

### Implementation
- Update `send_message` validation to mirror Claude:
  - plain-text `message` requires non-empty `summary`
  - structured shutdown messages keep Claude routing/validation behavior
- Extend `send_message` protocol and teammate continuation path with Claude-style structured payloads:
  - `shutdown_request`
  - `shutdown_response` with `request_id`, `approve`, and optional `reason`
  - include unique request ID on every shutdown request
- Add sender/routing validation:
  - shutdown requests originate from the lead path
  - `shutdown_response` must be routed to the lead
  - rejection responses require a non-empty `reason`, matching Claude validation
- Do not introduce a new public shutdown-request tool unless `send_message` parity proves impossible
- Update `team-manager.ts` with the minimum transition rules required to mirror Claude shutdown handling
- Ensure task unassignment hook from PR3 is invoked on approved shutdown

### Acceptance criteria
- Plain-text `send_message` requires non-empty `summary`, matching Claude
- Lead can request graceful shutdown without immediate kill
- Teammate response drives final state
- Approved shutdown produces deterministic stop + cleanup sequence
- Rejected shutdown preserves running teammate and emits clear status
- Rejection without a reason is rejected at validation time
- `shutdown_response` sent anywhere other than the lead is rejected at validation time
- structured shutdown messages cannot be broadcast

---

## PR5 - Explicit Idle/Active State Tracking (P0)

### Problem class
Lifecycle checks cannot distinguish “running work” from “idle but resumable.”

### Enforcement first
Add tests:
- `team-manager.idle-active-state.test.ts` (new)
  - teammate transitions `running -> idle -> running`
  - `check_teammate` shows correct activity + continuation semantics
  - inactive/shutdown team marks teammate as non-addressable

### Implementation
- Extend `TeamMember` persisted state with Claude-style `isActive`
- Define transition triggers explicitly:
  - set active on start/resume/follow-up dispatch
  - set idle on completion turn boundary
  - set non-addressable on shutdown/orphaned
- Define precedence explicitly:
  - `shutdown`/`orphaned` team state overrides any member activity
  - terminal worker status (`stopped`, `failed`, `timed_out`, `completed`) overrides `isActive=true`
- Update teammate lifecycle updates from runtime events in `index.ts`
- Refine `describeTeammateLifecycle` input to use state directly

### Acceptance criteria
- `check_teammate` accurately reports running vs idle
- Idle teammates with sessions are resumable
- Shutdown team members are never shown as addressable

---

## PR6 - TUI Team Visibility and Progress Parity (P1)

### Problem class
Lifecycle guarantees are not operationally trustworthy if the lead cannot see what teammates are doing. Claude parity here is not just “some status text exists”. It includes the concrete operator experience: a readable team roster, a focused teammate detail view, and a compact live progress view that stays useful on narrow terminals.

### Enforcement first
Add tests:
- `slash-team-view.test.ts` or equivalent (new/updated)
  - team list view renders teammate count subtitle and one row per teammate
  - selected teammate row shows pointer/highlight while idle rows are dimmed when not selected
  - row renders hidden/idle badges when relevant, plus mode symbol, teammate name, and model when available
  - list footer renders the implemented action legend cleanly
  - stopped/shutdown/deleted teams render clearly distinct terminal states
  - deleting a team removes it from active TUI views without stale entries
- `teammate-detail-view.test.tsx` or equivalent (new)
  - teammate detail view renders model + cwd/worktree subtitle
  - teammate detail view renders owned tasks with completed vs incomplete visual distinction
  - teammate detail view renders prompt preview and supports Claude-like truncate/expand behavior for long prompts
  - left-arrow returns to roster and enter opens teammate output/view target when that surface exists
- team-list empty-state test
  - empty team list renders a clean `No teammates` state instead of broken or noisy chrome
- `teammate-spinner-line.test.tsx` or equivalent (new)
  - running teammate renders recent activity summary instead of stale generic label when progress exists
  - idle teammate renders idle/resumable timing state
  - all-idle state freezes completed-duration display instead of continuing to tick idle time
  - shutdown-requested teammate renders stopping state distinctly
  - awaiting-approval teammate renders a distinct approval-needed state
  - spinner line progressively hides name/hints/stats on narrow terminals without breaking layout
  - preview lines show at most the recent meaningful activity lines Claude-style, without flooding the view
- `background-task-navigation.test.ts` or equivalent (new/updated)
  - `shift+up/down` wraps across leader -> teammates -> hide row like Claude
  - first selection step from collapsed state expands teammate view and parks on leader
  - teammate selection order is stable and matches the displayed running-teammate order
  - `enter`/`f` opens teammate-focused view
  - `escape` from focused running teammate aborts current work only, not the whole teammate
  - `escape` otherwise exits focused/selection view without corrupting selection state
  - when no teammates exist but other background tasks do, the same keys fall back to the background-task surface instead of doing nothing

### Implementation
- Mirror the Claude split between:
  - a `/team` dialog-style roster view (`TeamsDialog` parity)
  - a compact live teammate progress view (`TeammateSpinnerLine` parity)
  - keyboard navigation that moves between leader and teammates (`useBackgroundTaskNavigation` parity)
- Team roster/list view must show, with clear visual hierarchy:
  - team title + teammate count subtitle
  - selection pointer/highlight
  - idle dimming for non-selected idle teammates
  - hidden/idle badges when relevant
  - teammate name
  - permission/mode symbol
  - model badge/text when available
  - state labels such as idle/stopping/awaiting approval when relevant
  - a footer legend for implemented actions, including Claude list-view controls such as select, drill-in, kill, shutdown, prune-idle, and backend-dependent hide/show actions when supported
  - a clean empty state when no teammates exist
- Do not overload the roster rows with verbose progress text. Claude keeps the roster compact. Rich activity/progress belongs in the live spinner area and teammate detail view.
- Mode-control affordance in the roster/list view should match Claude semantics: list-level cycle acts on all teammates together, while detail-view cycle acts on one teammate.
- Teammate detail view must show:
  - themed/colorized teammate identity when available
  - mode symbol near identity when relevant
  - model plus cwd/worktree subtitle
  - owned tasks list with completed vs incomplete distinction
  - prompt preview with expand affordance for long prompts
  - action hint footer matching implemented controls
  - Claude-like back/drill-to-output behavior where applicable (`left` to return, `enter` to open teammate output target)
- Compact live progress view must show Claude-like progressive disclosure:
  - responsive layout for wide/medium/narrow terminals
  - selection pointer/tree structure and teammate color cues
  - recent activity summary derived from progress events when available
  - tool/token/duration stats when space allows
  - select/view hints when space allows
  - idle timing (`Idle for ...`) and all-idle completed-duration behavior
  - explicit `[stopping]` and `[awaiting approval]` state rendering where applicable
  - preview lines from recent meaningful content when available
  - fallback to a stable spinner verb only when concrete progress/activity text is unavailable
- Refresh visible teammate state on a short interval while the team dialog is open, matching Claude’s “live enough to trust” feel (Claude currently polls at roughly 1s cadence)
- Ensure delete/shutdown/session cleanup paths clear stale UI state immediately
- Keep visual wording consistent with Claude-like states, avoid contradictory labels such as showing running and idle cues at the same time

### Acceptance criteria
- Lead can visually inspect current teammate state without using raw filesystem inspection
- Team roster view shows teammate count, selection state, hidden/idle badges, mode indicator, and model when available
- Empty teams render a clean `No teammates` state
- Current known work/progress for each teammate is shown in the appropriate Claude-like surface when available, preferring concrete recent activity over generic placeholders
- Idle teammates are visually distinguishable from running teammates, including idle timing semantics
- A shutdown-requested teammate is visibly distinct from merely idle/running teammates
- Teammate detail view exposes owned tasks, prompt preview, cwd/worktree context, and Claude-like back/drill behavior when supported
- Live progress rendering remains readable on narrow terminals via progressive disclosure
- Keyboard navigation for teammate focus behaves like Claude for wraparound selection, hide-row selection, open, escape flows, and fallback to non-teammate background-task navigation when relevant
- Roster/detail controls cover Claude list/detail actions without misleading or stale footer hints
- Deleted teams disappear cleanly from active team views

---

## PR7 - Orphan Runtime/Artifact Cleanup Policy (P1)

### Problem class
Long-running usage accumulates stale team directories and runtime artifacts.

### Enforcement first
Add tests:
- `team-orphan-cleanup.test.ts` (new)
  - stale orphan dirs older than threshold are removed
  - active/current team dirs are preserved
  - malformed team dir does not abort cleanup pass

### Implementation
- Add startup/background cleanup in `index.ts` for old team dirs/artifacts
- Reuse existing artifact cleanup patterns (avoid new subsystem)
- Keep threshold configurable via extension settings

### Acceptance criteria
- Startup cleanup removes stale orphan state only
- Active team state is never deleted
- Cleanup failures are logged, not fatal

---

## PR8 - Team Permission/Mode Sync Protocol (P1)

### Problem class
Lead cannot coordinate teammate permission/mode changes with Claude-like parity.

### Enforcement first
Add tests:
- `teammate-mode-sync.test.ts` (new)
  - lead mode change request reaches teammate
  - teammate applies and persists effective mode
  - invalid mode updates are rejected safely

### Implementation
- Add structured mode update messages in team message protocol
- Extend teammate runtime metadata handling in `coordinator.ts`
- Persist mode in team member state where relevant
- Match Claude mode-control semantics in TUI:
  - list-view cycle updates all teammates together
  - detail-view cycle updates only the selected teammate
  - when teammate modes differ, list-view cycle first normalizes them back to default before cycling onward

### Acceptance criteria
- Lead can apply mode changes to teammate at runtime
- Mode changes are reflected by `check_teammate`
- List-view mode control semantics match Claude for single-mode and mixed-mode teams
- Invalid updates cannot corrupt team state

---

## PR9 - Task Dependency Parity (P1)

### Problem class
Claude task coordination supports richer dependency semantics. Without them, multi-step coordination can become flatter and less expressive than the target parity model.

### Enforcement first
Add tests:
- `task-dependencies.test.ts` (new)
  - task dependency fields round-trip correctly
  - blocked task remains blocked until prerequisites are completed
  - concurrent dependency updates do not corrupt persisted state

### Implementation
- Extend `TaskStore` schema and `task_update` API for dependency fields
- Preserve backward compatibility for existing tasks with default empty dependency arrays
- Keep updates atomic and version-safe

### Acceptance criteria
- Dependency fields persist and load correctly
- Blocked-task behavior is deterministic and visible to the lead
- Existing tasks created before this change still load with safe defaults

---

## Cross-PR Testing Matrix

### Standard command sequence for every PR
1. Targeted tests for changed area:
   - `npx vitest <new-or-modified-tests>`
2. Type safety gate:
   - `npx tsc --noEmit`
3. Build gate:
   - `npm run build`

No PR advances if any step fails.

### Additional mandatory regression checks (every P0 PR)
- `npx vitest teammate-lifecycle.test.ts`
- `npx vitest task-tools.test.ts team-tools.test.ts`
### PR-specific verification checklist (must be attached to PR description)

Each PR description must include a "Proof bundle" section with:
- Automated test list (exact commands + pass output summary)
- Manual verification steps executed
- Tool contract diff (request/response/error behavior)
- Known limitations (if any)

#### PR1 Team Delete
- Automated:
  - `team_delete` removes team config and task storage from disk for inactive/shutdown teams.
  - `team_delete` refuses deletion while a non-lead teammate is active.
  - successful delete clears lead-side active team context, queued team messages, teammate color assignments, and leader-team task binding state.
  - `team_delete` with no active team returns a successful no-op.
  - delete retry is safe after cleanup.
  - non-lead caller receives authorization error.
  - existing `team_shutdown` behavior remains green under regression tests.
- Manual:
  - create team -> spawn teammate -> `team_delete` -> verify delete is refused while teammate is active.
  - shut teammate down -> run `team_delete` -> verify cleanup succeeds and stale team UI state is cleared.
  - with no active team, run `team_delete` and verify Claude-like no-op success contract.

#### PR2 Session Cleanup
- Automated:
  - teams created in-session are tracked.
  - `team_create` generates a unique team name on collision.
  - `team_create` refuses to create a second active team for the same lead.
  - session shutdown stops/kills remaining teammate runtimes before cleanup for tracked teams.
  - explicitly deleted team is not cleaned twice.
  - cleanup continues if one team cleanup or runtime-stop operation fails.
  - `session_switch` and `session_branch` do not resurrect deleted teams.
- Manual:
  - create an already-existing team name and verify Claude-like unique-name generation.
  - attempt to create a second team while already leading one and verify Claude-like refusal.
  - create team, hard-stop/restart session, confirm leaked team state is not revived and no teammate runtime is left behind.

#### PR3 Task Unassignment
- Automated:
  - pending/in_progress tasks owned by dead teammate become `pending` + owner cleared.
  - completed tasks retain completed status.
  - unrelated tasks remain unchanged.
- Manual:
  - assign task to teammate, force timeout/stop, verify board is actionable without edits.

#### PR4 Graceful Shutdown Protocol
- Automated:
  - plain-text `send_message` requires a non-empty `summary`.
  - `send_message` accepts Claude-style `shutdown_request` payload.
  - `shutdown_response(approve=true)` transitions teammate to stopped and triggers unassignment path.
  - `shutdown_response(approve=false)` keeps teammate running and reports rejection reason.
  - `shutdown_response(approve=false)` without a reason is rejected.
  - `shutdown_response` to non-lead recipient is rejected.
  - structured shutdown messages cannot be broadcast.
  - existing plain `send_message` follow-up path still works when `summary` is provided.
- Manual:
  - send a plain-text follow-up without `summary` and verify Claude-like validation failure.
  - lead sends structured shutdown request via `send_message` to running teammate and observes explicit response path.

#### PR5 Idle/Active State
- Automated:
  - state transitions running->idle->running are persisted and surfaced.
  - `check_teammate` reports correct continuation semantics per state.
  - shutdown team always non-addressable.
- Manual:
  - resume an idle teammate and verify lifecycle flips back to running.

#### PR6 TUI Visibility
- Automated:
  - team list view renders teammate count, selection pointer/highlight, mode indicator, model when available, and compact state badges.
  - teammate detail view renders owned tasks, prompt preview, cwd/worktree/model subtitle, and back/drill behavior.
  - live spinner/progress view renders recent activity, idle timing, stopping/approval state, and preview lines when available.
  - idle/resumable teammate is visually distinct from running teammate.
  - narrow-terminal rendering preserves readability via progressive disclosure.
  - keyboard navigation matches Claude-style teammate selection/open/escape flows.
  - list/detail footer hints match actually implemented controls.
  - deleted team is removed from active view without stale rows.
- Manual:
  - run a team with at least 2 teammates and verify roster view, detail view, and live progress view all stay readable and current.
  - verify drill-in/back/output actions and prune-idle or hide-show controls where supported.
  - verify the same UI on both a wide and narrow terminal width.

#### PR7 Orphan Cleanup
- Automated:
  - stale orphan state older than threshold is removed.
  - active team directories are never removed.
- Manual:
  - run startup cleanup with mixed valid/stale dirs and inspect logs.

#### PR8 Mode Sync
- Automated:
  - valid mode updates are applied and visible in status checks.
  - invalid mode payloads are rejected safely.
  - non-lead/cross-team mode update attempts are rejected.
  - list-view mode cycling updates all teammates together and mixed-mode teams normalize to default first.
  - detail-view mode cycling updates only the selected teammate.
- Manual:
  - lead changes teammate mode from both list and detail views and confirms the Claude-like behavior updates.

#### PR9 Task Dependencies
- Automated:
  - dependency fields persist and update correctly.
  - blocked task logic behaves deterministically.
  - dependency updates remain lock-safe under concurrent mutation attempts.
- Manual:
  - create dependent tasks and verify blocked work becomes available only after prerequisite completion.

### Final parity signoff suite
- Full relevant tests:
  - `npm test` (or documented subset if full suite is unstable)
- End-to-end lifecycle script:
  1. create team
  2. spawn teammate
  3. create + assign task
  4. request graceful shutdown
  5. verify task unassignment
  6. inspect TUI and confirm teammate state/progress visibility
  7. delete team
  8. verify disk cleanup
  9. restart session and verify no stale team resurrection
  10. create dependent tasks and verify blocked-task behavior

Release gate (all must be true):
- No active teammate remains after `team_delete` or `session_shutdown`
- No open task remains assigned to non-running teammate
- `check_teammate` continuation text matches real behavior in all terminal states
- Session restart does not recover deleted team state
- `team_create` collision behavior matches Claude unique-name generation
- `team_create` preserves Claude's one-team-per-lead rule
- Existing plain follow-up messaging (`send_message`) remains backward-compatible
- Claude-style structured shutdown messaging is accepted through `send_message`
- `send_message` enforces Claude plain-text `summary` requirements
- Team TUI view shows teammate roster, detail context, and current known work/progress without stale rows after shutdown/delete
- Team TUI remains readable and navigable on both wide and narrow terminal widths
- Task dependency behavior is deterministic once PR9 lands
- Persisted teams/tasks created before these changes still load without migration failures
- Proof bundle is present for each merged PR (tests, manual checks, tool contract diff)

---

## Risks and Mitigations

1. **Race conditions in state files**
   - Mitigation: keep lock-based writes, add concurrency tests for new paths
2. **Breaking existing send_message behavior**
   - Mitigation: keep plain follow-up path default, add structured shutdown as additive
3. **Over-deletion on cleanup**
   - Mitigation: strict ownership checks + age threshold + never-delete-active-team guard
4. **State drift between registry and team config**
   - Mitigation: centralize terminal state transitions in `TeamManager`
5. **Protocol fragmentation (`send_message` plain text vs shutdown payloads)**
   - Mitigation: strict message envelope parser with backward-compatible plain-text fallback
6. **Unexpected compatibility breaks for existing automations**
   - Mitigation: keep existing tool names/args stable, add only backward-compatible fields, document behavior changes in README/CHANGELOG

## Rollback Strategy
- Each PR must be independently reversible.
- If regression appears in P0 PRs, revert only that PR and keep prior landed contracts.
- Do not partially roll back cleanup logic (team delete + session cleanup must stay consistent).

---

## Definition of Done

- PR1 through PR9 are complete with tests
- Team create/delete/shutdown + session cleanup are deterministic and proven against Claude semantics
- `team_create` collision handling, one-team-per-lead behavior, and `send_message` plain-text summary validation all match Claude
- Task ownership cannot stay stuck on dead teammates
- Graceful shutdown protocol is Claude-compatible through `send_message` without invented extra state-machine or sender-correlation rules
- `check_teammate` lifecycle output is trustworthy for coordinator decisions
- Team TUI visibility shows teammate roster, detail context, and current known work/progress clearly enough for lead decisions
- Team TUI interaction and visual hierarchy feel Claude-like rather than generic status dumping
- Task dependency behavior is implemented and documented
- Behavior and docs reflect Claude-like lifecycle expectations
- CHANGELOG and README coordinator sections updated for new lifecycle contracts

---

## Final Audit Summary

This plan has been normalized to the current `claude-code-original` reference for the lifecycle and TUI surfaces covered here.

Final audit outcomes locked into the plan:
- `team_delete` now matches Claude semantics for the current active team, including refusal while non-lead teammates are active, success no-op when no active team exists, and lead-side cleanup of team context/message/color/task-binding state.
- `team_create` now matches Claude creation behavior and shape by using `agent_type?`, generating a unique team name on collision, and refusing to create a second active team for the same lead.
- `send_message` now matches Claude plain-text validation by requiring `summary` when `message` is a string.
- Graceful shutdown parity now stays limited to Claude-shaped `shutdown_request` / `shutdown_response` behavior, without invented timeout, outstanding-request, or sender-correlation state machines.
- Idle/active lifecycle parity now uses Claude-style `isActive` state only.
- TUI parity now explicitly covers Claude roster, detail, spinner/progress, navigation, and mode-control behavior.

Deferred on purpose:
- broader mailbox/permission flows outside this lifecycle parity scope
- plan approval UX beyond the shutdown-related parity covered here
