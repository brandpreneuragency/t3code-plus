# Antigravity

Antigravity is an experimental, disabled-by-default provider in T3 Code +. T3 launches the
official Google Antigravity CLI (`agy`) for each turn; it does not handle Google credentials or
send requests to Google itself.

For the CLI's current headless protocol, see the
[Antigravity documentation](https://antigravity.google/docs/cli/headless/).

## Install and sign in

Install `agy`, then run it in a terminal on the machine that runs the T3 Code server. Complete
the CLI's sign-in flow there before enabling Antigravity in **Settings > Providers**.

```bash
agy
```

T3 does not read, copy, store, or display your Antigravity credentials. If the provider says the
CLI is installed but is not authenticated, run `agy` in a terminal, complete sign-in, then refresh
the provider status.

The default binary name is `agy`. If it is not on the server's `PATH`, set its absolute location
in the provider's **Binary path** setting. Restart T3 Code + after changing `PATH`; a running
server does not receive shell environment changes.

## Local and remote environments

The CLI and its login belong to the environment running the T3 server, not to the browser or
phone you use to connect. For a remote environment, install and authenticate `agy` on that remote
machine. Your local `agy` installation and login are not sent to it.

## Models and continuation

Antigravity models are discovered from `agy models`; T3 shows the exact model slugs reported by
the CLI. Refresh provider status after a CLI update, account change, or model-catalogue change.
T3 keeps the last successful list if refresh fails.

Each T3 thread keeps its own Antigravity conversation ID. Follow-up turns and a restarted T3
server resume that ID explicitly, so T3 never uses `agy --continue`, which could select the
wrong recent conversation. You can select a different discovered model for a continuing thread.

## Permission modes

Headless Antigravity cannot pause for inline approvals. T3 therefore maps restricted modes
conservatively:

- **Supervised** and **Auto** use plan mode with the CLI sandbox. T3 warns that inline approval is
  unavailable, and operations needing approval can be denied by the CLI.
- **Auto-accept edits** uses Antigravity's accept-edits mode. Commands that need approval can
  still be denied.
- **Full access** is the only mode that starts the CLI with its all-permissions flag.
- A thread's **Plan** interaction mode always uses Antigravity plan mode.

See [Permission modes](./permission-modes.md) and Google's
[headless permission behavior](https://antigravity.google/docs/cli/headless/#permissions-in-headless-mode)
before using full access.

## Attachments

Version 1 does not send files, images, or PDFs as native Antigravity content. T3 includes the
existing attachment path in the turn text and grants the CLI access to the exact parent directory
of each attachment. The CLI can read a file only when the selected permission mode allows it.

## Limits of this integration

T3 does not provide Antigravity authentication, inline approvals, slash commands, plugins,
agents, quota-bucket displays, or native image/PDF uploads. Antigravity network traffic remains
inside the official `agy` executable.
