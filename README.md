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
npx -y usetrail@latest login

# 2. register it with your agent - this example is Claude Code
claude mcp add trail -s user -- npx -y usetrail@latest
```

No account yet? Create one at [usetrail.dev](https://usetrail.dev) - the free plan covers three
projects and three people.

**Not tied to one agent.** This is a plain MCP server over stdio, speaking the three protocol
versions in use today. Any MCP-compatible client can run it; only the registration command
differs, and each client documents its own.

**Prefer a local checkout?** Clone it instead, and the connector keeps itself up to date on its
own (see [Updating](#updating)):

```bash
git clone https://github.com/arsprengel/trail-mcp.git ~/.trail-mcp
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

## Session hook (Claude Code, Gemini CLI, Antigravity)

Installed for you, once, when you log in - and on the connector's first run, which covers people
who paste a token into the registration instead of logging in through the browser. Every session
that starts in a project with a tracker gets the open items and the project memory in context from
the first message - the agent starts knowing, instead of depending on someone remembering to ask.
Fail-silent by design: no login or no network and the hook stays quiet.

Each tool keeps this in its own place, so the connector writes to the one that tool actually reads:

- **Claude Code** - a session-start hook in `~/.claude/settings.json`.
- **Gemini CLI** - a session-start hook in `~/.gemini/settings.json`.
- **Antigravity** - it has no session-start event, so the connector uses the closest one and speaks
  only once per conversation, through a tiny local shortcut that keeps the other turns cheap.
  Antigravity also gets something the other two don't need: **`gemini mcp add` does not connect
  Trail in Antigravity** - that command writes to `~/.gemini/settings.json`, and Antigravity reads
  `~/.gemini/config/mcp_config.json`. The connector registers itself there, so the Trail tools
  actually show up in its MCP panel.

`usetrail status` tells you, per tool found on this machine, whether it is on - so you never have
to go digging through settings files to find out.

It never fights you. A tool that isn't on the machine gets nothing created for it, and
`hooks install` will not fabricate a config for a program you don't have. If you remove it with
`hooks uninstall`, it does not come back on its own - put it back with:

```bash
npx -y usetrail@latest hooks install
```

Clients without a hook mechanism are covered too: the server's own instructions tell the agent
to fetch the summary itself before acting.

## Your own Trail

Point it at your server once and it stays pointed:

```bash
TRAIL_API_URL=https://your-trail npx -y usetrail@latest login
```

Without that variable, `login` goes to the hosted service.

## Commands

```bash
npx -y usetrail@latest            # start the MCP server over stdio - what your agent runs
npx -y usetrail@latest login      # connect this machine (browser confirmation, no token copying)
npx -y usetrail@latest status     # server address, current project, whether a token is present
npx -y usetrail@latest logout     # delete the saved token
npx -y usetrail@latest doctor     # find the install on this machine and unstick auto-updates
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

**The `@latest` is not decoration.** Registered as `npx -y usetrail@latest`, the connector resolves
the published version every time your agent starts a session, so a new release reaches you without
anyone doing anything. Registered as bare `npx usetrail`, npm reuses whatever copy it cached the
first time - and that machine stays on that version forever. Use `@latest`.

The cost of `@latest` is about a second at session start, and a network call. Neither matters in
practice: the connector talks to Trail over the network anyway.

A cloned install updates itself differently: on startup it fires a quiet fast-forward pull in the
background, at most every six hours. The running session keeps the version it loaded; the next one
starts updated. No network or a local conflict and nothing happens, silently.

Stuck on an old version? `npx -y usetrail@latest doctor` finds the install, reports the version and
unsticks it.

## Requirements

Node 18 or newer.

## License

MIT. This package is the client - the connector you run on your own machine. Use it, fork it,
adapt it. The Trail service it talks to is a separate, hosted product.
