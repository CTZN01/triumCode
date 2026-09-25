# TriumCode Desktop Roadmap

**Purpose:** Deliver a useful Windows preview quickly, then close the remaining product, safety, and release gaps in explicit versions.

**Source of truth:** `docs/desktop-plan.md` remains the full product specification and requirement checklist. This roadmap changes delivery order and version scope; it does not waive any requirement or treat code presence as acceptance.

**Release channel:** No dates are promised. A version moves forward only after its exit evidence is recorded. The first deliverable is a Windows x64 portable preview archive; it is not the v1.0 desktop MVP.

## Product direction

TriumCode Desktop is a local coding-agent workspace for developers who want the Codex-style loop of choosing a project, asking for work, following tool activity, deciding approvals, inspecting changes, and continuing safely. The product shares the existing CLI Agent, providers, tools, permissions, and session format. It does not promise Codex feature parity, cloud workspaces, team features, or hidden model reasoning.

The first release optimizes for a complete, understandable single-user workflow. Later releases add confidence, task isolation, and distribution quality. Each release keeps the CLI usable and preserves existing session data.

## Version 0.1.0-preview.3 - Windows local preview

**Audience:** The developer and a small group of Windows testers who can report issues. This is an early-access preview, not a stable public release.

**Artifact:** `TriumCode-Desktop-0.1.0-preview.3-win-x64.zip`. The archive contains a runnable Electron application and production dependencies. A tester extracts it and runs `TriumCode.exe`; Node.js is not required on the test machine. The release is unsigned and has no installer or automatic update. The application uses the normal Windows user-data directory, so removing the extracted folder does not remove settings, protected credentials, workspaces, or session files.

**Candidate status (2026-09-26):** Electron was upgraded to 44.4.5 to resolve two high-severity advisories in Electron 39's archive-extraction install chain. Full and production `npm audit` both report zero vulnerabilities. Preview.2 exposed a launch blocker: Electron 44 rejected the ESM preload under the enabled renderer sandbox, leaving `window.desktop` undefined and the window blank. Preview.3 switches the preload to CommonJS while keeping the sandbox enabled, and shows a visible recovery message if the bridge is missing. `npm test` passes all 233 core and 8 desktop tests; `npm run desktop:build` succeeded; the 170.2 MiB preview.3 archive was built with Node.js 24. An earlier preview.3 archive was extracted and launched with a clean isolated user-data folder. The packaged renderer exposed `window.desktop` and rendered the first-run workspace and settings UI with no renderer errors. Re-extract and smoke-test the current archive after the final commit; the earlier launch does not prove the current bytes. Project selection, provider setup, a full agent run, approvals, cancellation, reopening, and recovery still need P0 acceptance before the archive is tester-ready. Desktop dependency installation and development now require Node.js 22.12 or later; the CLI remains compatible with Node.js 20.

### Included user workflow

1. Open a local Git or non-Git project, switch among recent projects, and create/open/rename/delete conversations without deleting project files.
2. Configure one of the existing supported provider protocols, protect credentials with Windows storage, optionally import CLI credentials, and keep each conversation's selected model route stable.
3. Send a request, follow streamed assistant text and tool activity, answer questions, approve or reject protected actions, and stop a running request.
4. Reopen a conversation after normal exit or interruption without replaying a tool call automatically.
5. Inspect conversation activity and available per-run file/Git differences, then use the workspace-bound PowerShell terminal when needed.
6. Continue using the existing CLI and its saved conversations.

### Explicit limits

- Windows x64 only; the terminal uses Windows PowerShell. macOS/Linux are not supported by this artifact.
- No account, cloud task, sync, team collaboration, product telemetry, installer, signing, or automatic updates.
- Approval is a user decision, not an OS sandbox. Approved programs may reach outside the project or use the network. Default mode must continue to ask before file writes and program execution.
- Review cannot attribute every shell side effect in a non-Git project, ignored files, or changes committed during a task. A review snapshot is not a full backup.
- Task-center, multiple concurrent runs, worktree creation/merge/removal, and Git write controls are present in the current development branch but remain preview/experimental until their Windows and multi-process acceptance is recorded. Do not use them as the only copy of important work.
- A failed or interrupted run can leave completed file or command side effects. Inspect the workspace before asking the Agent to continue.

### P0 exit checklist

The preview archive is ready to hand to testers only when each item has recorded evidence in the release checklist or issue tracker:

| Gate | Acceptance evidence |
|---|---|
| Reproducible artifact | `npm run desktop:build` and `npm run desktop:package` produce the named Windows x64 zip from the lockfile; extracted app launches without Node.js or repository files. |
| Clean first run | On a clean Windows user profile, app opens, project selection works, missing credentials do not send a request, and setup retains the user's draft. |
| Core task | With a configured test provider, create/reopen a session; stream a reply; approve one write and one command; reject an action; stop a run; observe final status. |
| Data safety | Open a pre-existing CLI session; confirm CLI and desktop can still read their respective saved history; restart after an interrupted run and confirm no tool is replayed. |
| Review and terminal | Inspect a file change and a Git diff; verify existing dirty changes are identified; open PowerShell and confirm its cwd is the selected project. |
| Permission/privacy | Confirm the default mode prompts before writes and process starts; renderer and packaged files do not contain a configured API key; credential storage is unavailable only with a clear blocking message. |
| Shutdown | Close a window with an active task or terminal and follow the explicit stop/return choice; confirm no task or terminal process is left running. |
| Release hygiene | Review the production/development dependency audit, record Electron/runtime risks, verify archive contents, and publish the known-limitations text alongside the zip. |

Any failure in default permission behavior, credential exposure, cross-workspace/session writes, accidental tool replay, or unclean process shutdown blocks handing this preview to testers.

### Next iteration design review

The implementation review found a working build and passing unit tests, but no recorded end-to-end evidence for the complete task loop. The next iteration should close the preview gates before expanding the task center or worktree UI. Code presence and a successful archive build are separate from release acceptance.

| Order | Design seam and decision | Acceptance evidence | Requirements |
|---|---|---|---|
| 1 | Keep the main process authoritative for workspace path, session revision, run ownership, and permission decisions. Validate IPC inputs at the boundary; a stale renderer or second process must fail closed. | Two desktop processes plus a CLI process race to start a run or write Git state; only one writer succeeds per workspace, and a stale session reloads before writing. | WS-04, SES-06, RUN-02, RUN-06, PERM-01, APP-01 |
| 2 | Pin the non-secret model route to each conversation and resolve the credential in the main process by route identity. Missing or renamed presets must produce a recoverable state without silently changing the model or exposing a key. | Restart with two routes, remove one preset, switch current settings, and verify old sessions keep their route, keys stay out of renderer data and logs, and CLI sessions remain readable. | SES-05, SET-02, SET-03, SET-04 |
| 3 | Treat a failed turn as potentially effectful once any tool use is seen. Permit same-request retry only for transient provider failures before tool use; never replay after crash. | Simulate network failure before and after a tool call, cancellation during approval, and process termination during a run; verify visible status, activity, and file effects after reopen. | RUN-03, RUN-04, RUN-05, ACT-01, PERM-09 |
| 4 | Review is a view of the current workspace, with explicit provenance and stale checks. Keep Git writes and worktree operations experimental until their multi-process and dirty-tree cases pass. | Compare pre-existing staged/unstaged/untracked files, mutate a file after review, confirm restore rejects stale content, then test Git writes and worktree cleanup under lock contention. | REV-02, REV-03, REV-04, GIT-02, PAR-03, PAR-05 |
| 5 | Use one neutral palette for light, dark, and system modes. Terminal colors follow the resolved mode without restarting its shell. Preserve keyboard access and readable state labels. | Capture all three modes after restart and a live OS appearance change; check contrast, narrow-window layout, focus order, approval cards, diff colors, and terminal text. | APP-03, APP-04, TERM-02 |
| 6 | Build and test the exact candidate archive after the last code commit. Keep release evidence tied to its checksum and preview version. | Record SHA-256, extracted launch on clean and existing Windows profiles, a complete task loop, shutdown/process cleanup, archive contents, and known limits in the release checklist. | APP-05, SET-01, RUN-05 |

The release candidate remains blocked until rows 1–3 and 6 pass, along with the applicable P0 checklist above. Rows 4–5 must pass for the actions and modes visible in the candidate; disable an unverified advanced action or defer the candidate. Keep queueing, remote run control, and broader worktree workflows in v0.3 rather than using them to mask an incomplete single-task path.

### Deferred from this version

The preview does not claim completion of every WS/SES/CHAT/RUN/ACT/PERM/REV/GIT/TERM/SET/APP/PAR requirement. The authoritative remaining items stay in `docs/desktop-plan.md` and are assigned below rather than removed from the plan.

## Version 0.2 - Desktop beta and reliability

**Goal:** Make the core workflow predictable enough for regular daily use and close the Windows MVP gaps before adding more surface area.

**Work:**

- Complete Windows runtime acceptance for workspace switching, session recovery, keyboard-only navigation, screen-reader labels, permissions, diff freshness, PowerShell encoding, and process cleanup.
- Close high-priority security and data-integrity issues: path normalization (including junction/UNC decisions), renderer/IPC fail-closed behavior, same-session writer conflicts, secret redaction, and interrupted approvals.
- Complete the core MVP review contract for pre-existing changes and non-Git projects; clearly mark any change source that cannot be attributed.
- Complete Git status/diff behavior and the intended basic stage/unstage/commit flow, or hide any action that has not passed its target-specific acceptance.
- Decide and document whether Windows OS-level process isolation is feasible. Never label ordinary approval as a sandbox.
- Add release notes, versioned schema/migration checks, backup/recovery instructions, and a reproducible candidate checklist.
- Decide installer, code signing, and update strategy based on actual distribution needs and available signing credentials. The portable preview remains available until that path is verified.

**Exit criteria:** The complete stage C+D MVP path in `desktop-plan.md` passes on a clean Windows profile and an existing CLI profile; no known high-priority security/data-loss issue remains; a candidate can be upgraded or replaced without losing sessions or credentials; unresolved OS isolation limits are visible in-product and in release notes.

## Version 0.3 - Codex-style task workflows

**Goal:** Make multiple related development tasks easy to start, isolate, inspect, and finish.

**Work:**

- Finish task-center ownership and state across process boundaries, including waiting for approval/question, cancellation ownership, long-list navigation, and stale task recovery.
- Finish worktree lifecycle: create from a verified ref, compare against base, inspect dirty state, resolve conflicts through a clear path, merge only under the documented conditions, and remove safely.
- Add run queue/slot visibility and cancellation recovery; prevent two tasks from mutating one session or workspace unsafely.
- Show subagent delegation/status/results as navigable activity while keeping private reasoning hidden.
- Add command palette, discoverable shortcuts, notifications, and task/session search based on observed usage rather than as prerequisites for 0.1.

**Exit criteria:** Multi-workspace and multi-worktree end-to-end flows pass with concurrent CLI/Desktop processes; locks are released after cancel/crash; users can identify each task's workspace, branch, run owner, changes, and next action.

## Version 0.4 - Trust, diagnostics, and platform readiness

**Goal:** Improve recovery and portability without weakening local privacy.

**Work:**

- Finish threat-model-driven Windows isolation work or document the exact protection boundary and keep unsafe claims out of the UI.
- Add user-controlled, secret-redacted diagnostic export and local data cleanup with clearly stated deletion scope.
- Add opt-in crash diagnostics only if the product later adopts a service; no content/key telemetry by default.
- Establish a platform abstraction and run separate macOS/Linux feasibility and terminal/security spikes before promising either platform.
- Add schema migration, disk-full, app-crash, machine-restart, and moved-workspace recovery coverage.

**Exit criteria:** Recovery and privacy deletion are verified; diagnostics cannot include keys; each newly supported OS has a completed permission, credential, terminal, packaging, and accessibility matrix rather than inheriting Windows assumptions.

## Version 1.0 - Supported desktop release

**Goal:** Ship a documented, supportable desktop product for the explicitly named platforms.

**Required before release:**

- All MVP requirements in `desktop-plan.md` are complete or have an explicit, user-visible scope decision approved in the product spec.
- Signed installer/package, verified install/upgrade/rollback/uninstall behavior, and an update channel are ready for each promised platform.
- Clean-install, upgrade-from-preview, CLI compatibility, permission, recovery, accessibility, and end-to-end acceptance evidence is recorded.
- No unresolved high-priority security or data-loss defects; dependency audit results and mitigations are reviewed for every release.
- Support policy, release notes, known limitations, and privacy/data-location documentation are published with the artifacts.

## Cross-version delivery rules

1. Requirements are never marked complete from a build alone. Record implementation, automated coverage, manual steps, result, and known limitation against the existing requirement ID.
2. Resolve P0 privacy, permission, data-loss, and process-lifecycle bugs before adding visible product features.
3. Keep the CLI entry points and old session format compatible; migration is additive and must not delete the source.
4. Do not add a runtime or packaging dependency without following the repository's dependency approval rule. The first portable package uses the existing Electron runtime and OS-provided archive tooling.
5. Do not promise cloud, telemetry, code signing, OS sandboxing, background continuation, or platform support until their implementation and acceptance are complete.

## Current execution order

1. Package the existing Windows-first core into a portable preview without adding a package-manager dependency.
2. Run the P0 acceptance checklist and fix only release-blocking defects; leave unverified advanced flows clearly experimental.
3. Hand off the preview with its limitations and capture tester findings against requirement IDs.
4. Use those findings to drive v0.2 reliability, then v0.3 task workflows, then v0.4 trust/platform work.
