# ADR 0007: The `wow` server — MCP over HTTP from the app

- **Status:** Proposed
- **Date:** 2026-11-17
- **Deciders:** @Smidelis, @hermes-smidelis

## Context

Every question carries a small header about the character. Everything larger, such as equipment, bags, talents and quests, the agent is to fetch itself from an MCP server named `wow`, which Familiar hands over per session in `session/new`, so that the player installs nothing (FAM-3).

The app runs on the player's PC, next to the game. The agent may run elsewhere: the docs describe starting it through `ssh`. A server on the player's PC is out of such an agent's reach unless something carries the connection.

A spike measured the ways with real agents (FAM-43, [#13](https://github.com/familiar-wow/familiar/pull/13)):

- Hermes and Codex both took an MCP server over HTTP from `session/new`, sent the headers Familiar gave them and called its tool. The Claude Code adapter advertises the same support; it was not run with a model.
- Hermes advertises no `mcpCapabilities` in `initialize` and takes the server all the same.
- An agent that cannot reach or may not use the server starts its session 3 to 5 seconds later and answers without the tool. The session does not fail.
- Through `ssh`, the option `-R` carries the connection back to the app.
- A server written by hand, with one `POST` endpoint and JSON answers, served the official MCP client, Hermes's client and Codex's client.
- No agent speaks MCP over the ACP connection itself.

All of it ran on Linux. Nothing was measured on Windows.

## Decision

- **The app serves `wow` itself, over HTTP on `127.0.0.1`.** One endpoint, `POST /mcp`, answers JSON-RPC with JSON: tools only, no session, no stream. Familiar writes it by hand; it needs no MCP library.
- **Every session gets it.** Familiar names the server in `session/new` as `type: "http"`, whatever the agent advertises. If an agent refuses `session/new` because of it, Familiar starts the session without the server and tells the player.
- **A token guards it.** The app makes a new one at each start and hands it over as an `Authorization` header in `session/new`. The server refuses requests without it, requests that carry an `Origin` header, as every browser's do, and requests whose `Host` is not this machine. It listens on the loopback address only.
- **The port is fixed and a setting**, so that a player can name it in an `ssh` command.
- **An agent behind `ssh` needs one change by the player:** `-R 127.0.0.1:<port>:127.0.0.1:<port>` and `-o ExitOnForwardFailure=yes` in the command that starts it. Familiar does not rewrite the player's command. Without the change the agent works from the header alone, as today.
- **The server only reads.** Its tools return game state. A tool that acts in the game or on the PC needs its own decision.

## Alternatives

- **A server the agent starts itself (`stdio`):** every agent must support it, but the program would have to exist on the agent's machine, and it would need its own way back to the app. That is the same problem again, with an installation on top.
- **MCP over the ACP connection:** the best fit, because it rides on the connection that already exists, `ssh` included. The SDK has it only as unstable, and none of the three agents supports it. To be looked at again when one does.
- **Sending the server only to agents that advertise `http`:** what the protocol describes. It would leave Hermes without tools, although Hermes takes the server.
- **Familiar adds `-R` itself** when the command starts with `ssh`: guesses at a command that may be a wrapper, use a config file or go through a jump host. A setting could do it later.
- **The official MCP SDK:** 17 direct dependencies, among them two web frameworks, for what the spike's server does in under 200 lines. To be looked at again if the server needs streams, resources or prompts.
- **No server, all state in the prompt:** decided against in FAM-3. The uplink carries 0.9 KB/s at most, and every snapshot would stay in the session's history.

## Consequences

- With an agent on the player's PC, the server works without any setup.
- A player whose agent runs elsewhere changes their command once. The docs explain how, and why `ExitOnForwardFailure` matters: without it, a taken port on the agent's machine lets `ssh` start the agent anyway, and the agent would send the token to whatever listens there.
- Every process on the player's PC can connect to the port, and with `-R` every user on the agent's machine. The token keeps them out. Whoever gets hold of it reads game state and nothing else.
- The token reaches the agent in `session/new`. What the agent does with it is the agent's matter. In the spike, Hermes wrote it to no file.
- Familiar sends `type: "http"` to an agent that does not advertise it. The protocol does not forbid that, and it does not describe it either.
- A second Familiar app on the same PC cannot open the port. That is a way to notice it; today two apps both answer the game.
- Open until measured: Windows as the app's machine, an agent that refuses `session/new`, and an agent that asks the player before every tool call.
