# usetrail

The MCP server for **[Trail](https://usetrail.dev)** - it gives your coding agent your team's
tracker and the project's durable memory, scoped to the folder you have open.

Your agent stops working blind. It reads what is open, writes what it did, and records what it
learned the hard way - in the same board your team looks at, not in a scratch file that only
that session can see.

This package is the **client**. It talks to your Trail account over the REST API; there is no
database here. Dependencies are `@modelcontextprotocol/sdk`, `zod` and the built-in `fetch`.

## Quick start

```bash
# 1. connect this machine to your Trail account (opens your browser; no token to copy)
npx usetrail login

# 2. register it with your agent - this example is Claude Code
claude mcp add trail -s user -- npx usetrail
```

No account yet? Create one at [usetrail.dev](https://usetrail.dev) - the free plan covers one
project and three people.

**Not tied to one agent.** This is a plain MCP server over stdio, speaking the three protocol
versions in use today. Any MCP-compatible client can run it; only the registration command
differs, and each client documents its own.

**Prefer a local checkout?** Clone it instead, and the connector keeps itself up to date on its
own (see [Updating](#updating)):

```bash
git clone https://github.com/arsprengel/tether-mcp.git ~/.trail-mcp
npm --prefix ~/.trail-mcp install --omit=dev
node ~/.trail-mcp/bin.js login
claude mcp add trail -s user -- node ~/.trail-mcp/bin.js
```

On Windows, write the real path instead of `~`: the registration stores the argument verbatim
and Node does not expand it.

## What your agent gets

**The tracker** - `list_items`, `get_item`, `add_item`, `update_item`, `move_item`, `get_next`,
`delete_item`. Real items on your team's board, with type, status, priority, assignees and
history. Work the agent picks up shows as in progress and closes when it is done, so the board
is not a story someone has to retell.

**Project memory** - `list_memory`, `get_memory`, `add_memory`, `update_memory`, `review_memory`.
The durable knowledge of a project: the deploy that has a trap in it, the decision nobody should
relitigate, the command that is not in any README. Shared by everyone on the project, human or
agent. A new session reads it before acting instead of rediscovering it.

**Reminders** - `add_reminder`, `list_reminders`. Things with a date that must not be silently
missed.

**Attachments** - `add_attachment`, `get_attachment`. Files that belong to an item.

## Which project it writes to

Trail holds many projects. The connector uses **the folder you have open** as the project - the
folder name, or whatever a `.trail` file next to it says, or the `TRAIL_PROJECT` variable. So
the agent writes to the right project without being told, and two repositories never bleed into
each other. To reach across, the agent passes `project` explicitly on the tool.

## Session hook (Claude Code)

```bash
npx usetrail hooks install
```

Registers an opening hook in `~/.claude/settings.json` (with a backup, and without duplicating):
every session that starts in a project with a tracker gets the open items and the project memory
in context from the first message - the agent starts knowing, instead of depending on someone
remembering to ask. Fail-silent by design: no login or no network and the hook stays quiet.
`hooks uninstall` reverses it.

Clients without a hook mechanism are covered too: the server's own instructions tell the agent
to fetch the summary itself before acting.

## Your own Trail

Point it at your server once and it stays pointed:

```bash
TRAIL_API_URL=https://your-trail npx usetrail login
```

Without that variable, `login` goes to the hosted service.

## Commands

```bash
npx usetrail            # start the MCP server over stdio - what your agent runs
npx usetrail login      # connect this machine (browser confirmation, no token copying)
npx usetrail status     # server address, current project, whether a token is present
npx usetrail logout     # delete the saved token
npx usetrail doctor     # find the install on this machine and unstick auto-updates
```

The token is stored at `~/.config/trail/token.json` (mode 600). Revoke it whenever you want from
the "AI token" panel in the app.

## Configuration

| Variable | What it does |
| --- | --- |
| `TRAIL_API_URL` | Your own Trail's address. Saved after the first login. Defaults to the hosted service. |
| `TRAIL_PROJECT` | Forces the project name (default: the open folder). |
| `TRAIL_API_TOKEN` | A token directly, skipping the browser login. Useful in CI. |

The former names (`TETHER_*`) keep working, with no deadline - the product used to be called
Tether, and nothing anyone already configured has to change.

## Updating

A cloned install **updates itself**: on startup it fires a quiet fast-forward pull in the
background, at most every six hours. The running session keeps the version it loaded; the next
one starts updated. No network or a local conflict and nothing happens, silently.

An install through `npx` has no such mechanism - npm caches the package. Run `npx usetrail@latest`
to force the current version, or use the clone if you would rather not think about it.

Stuck on an old version? `npx usetrail doctor` finds the install, reports the version and
unsticks it.

## Requirements

Node 18 or newer.
