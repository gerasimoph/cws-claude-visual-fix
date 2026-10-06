# Install Browser Feedback for Coding Agents

Instructions for a coding agent (Claude Code or any MCP-capable agent) asked by the user to set this up. The user has already installed the Chrome extension; your job is the local companion. Keep it to the steps below and ask the user before doing anything else.

## 1. Run the installer

```bash
npx -y github:gerasimoph/cws-claude-visual-fix setup --yes --extension-id <ID>
```

Use the extension id from the user's message; if there is none, omit `--extension-id`. Requires Node 18+ and git access to the repository. Run it on the user's own machine — the one with Chrome — not in a remote or cloud sandbox.

It installs into `~/.browser-feedback` only:
- the companion runtime and the Chrome native messaging host (Chrome, Chromium, Brave, Edge);
- the MCP server `browser-feedback` for Claude Code at user scope, plus the `/ui-review` command.

It writes nothing into the current project, needs no sudo, and opens no network ports. It waits up to 20 s for the extension to connect.

## 2. Read its output

- `Browser connected: yes` — done.
- `Browser connected: no` — ask the user to click the extension's toolbar icon (or open any `http://localhost` page), then check with the `status` command the installer printed.
- Not using Claude Code? The installer prints the MCP server command and args; add them to your agent's MCP config. Codex also needs `tool_timeout_sec = 3600`, because `wait_for_review` blocks until the user presses Fix all.

## 3. Tell the user what's next

1. Restart Claude Code in the project folder. MCP servers load at session start.
2. Run `/ui-review` there.
3. Open the app in Chrome. The review panel asks which project the page belongs to; click **Connect**.
4. Hold Alt and click an element (↑ selects its parent), write what should change, press Enter. When done, press **Fix all**.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `npx` fails with 404 or `Permission denied (publickey)` | The repository is private. The user needs access to it and git credentials (`gh auth login` or an SSH key). |
| Extension says *native messaging host not found* | Run `setup` again. Chrome reads the host manifest on every connect, so no restart is needed. |
| Extension says *access … forbidden* | Extension id mismatch. Run `setup` again with the `--extension-id` the user gave. |
| `claude mcp add` failed | Run it yourself with the command the installer printed. |

To uninstall: `claude mcp remove browser-feedback`, delete `~/.browser-feedback`, and remove `com.browser_feedback.companion.json` from the browsers' `NativeMessagingHosts` folders (paths printed by the installer).
