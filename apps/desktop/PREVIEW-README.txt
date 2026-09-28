TriumCode Desktop 0.1.0-preview.3 - Windows x64 preview

Start
1. Extract the entire archive to a folder you can write to.
2. Run TriumCode.exe.
3. Open a project folder, configure a provider and API key, then create a conversation.

The app uses the normal Windows user-data folder. Removing the extracted app folder does not remove its settings, protected credentials, recent workspaces, or conversation data. Existing CLI sessions remain in the CLI session directory and can be opened by the desktop app.

Preview limits
- This archive is unsigned, has no installer, and does not update itself.
- Windows x64 only. The integrated terminal uses Windows PowerShell.
- The default permission mode asks before file writes and starting programs. Approval does not sandbox a program; it may access files outside the project or use the network.
- Check workspace changes after a failed or interrupted run. The app never replays a tool automatically, but completed side effects may remain.
- Task center, concurrent runs, worktrees, and Git write actions are experimental until Windows and multi-process acceptance is complete.
- File review cannot attribute every shell side effect in non-Git projects, ignored files, or files committed during a task. Review snapshots are not a full backup.

Keep a separate backup of important work. Report problems with the affected workspace, conversation, and visible task status; remove API keys and other secrets from any report.
