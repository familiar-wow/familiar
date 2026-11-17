# Spike: how an agent reaches the MCP server `wow` (FAM-43)

Familiar will serve the game's state to the player's agent as an MCP server named `wow`, handed over per session in `session/new`. The app runs on the player's PC. The agent may run on another machine, started through `ssh`. This spike measures which way to the server works for the agents Familiar names in its docs, before the server is built.

Throwaway code: nothing here reaches `main`, and product code never imports it.

## Result

An MCP server over HTTP on `127.0.0.1`, protected by a token and handed over as `{ type: "http" }`, works for Hermes and for Codex. For an agent behind `ssh`, one `-R` option in the player's command is enough. The server can be written by hand in under 200 lines without a dependency.

| Question                                            | Answer                                                                             | How it was measured                                                                                             |
| --------------------------------------------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Does Hermes take an HTTP server from `session/new`? | Yes, although `initialize` advertises no `mcpCapabilities` at all.                 | The tool was called and the answer had the run's word.                                                          |
| Does Codex?                                         | Yes. It advertises `http: true`.                                                   | The same.                                                                                                       |
| Does Claude Code?                                   | It advertises `http: true` and `sse: true`. Not run with a model: no API key here. | `initialize` only.                                                                                              |
| Do the headers from `session/new` reach the server? | Yes, with both agents.                                                             | Requests passed the token check.                                                                                |
| Is a server written by hand enough?                 | Yes.                                                                               | The official MCP client 1.32.2, Hermes's client and Codex's client all work against it.                         |
| Does it work through `ssh`?                         | Yes, with `-R`. Without it the agent starts and has no tool.                       | A real `ssh` to a real `sshd` on the same machine, with the server on another port than the one the agent sees. |
| Does any agent speak MCP over ACP?                  | No. Codex says `acp: false`; the others say nothing.                               | `initialize`.                                                                                                   |

## What the runs showed

All runs: 2026-11-17 on Linux x64, Bun 1.4.4. Hermes 0.23.1, `@agentclientprotocol/codex-acp` 2.7.0 (its MCP client calls itself `codex-mcp-client/0.166.0`), `@agentclientprotocol/claude-agent-acp` 0.107.3. One run each, so the times are single values, not averages.

| Run                                | Session ready after | Requests the server saw                                                             | Answer                       |
| ---------------------------------- | ------------------- | ----------------------------------------------------------------------------------- | ---------------------------- |
| Hermes, valid token                | 3.7 s               | `initialize` and `tools/list` twice before the session was ready, then `tools/call` | the run's word, after 13.2 s |
| Codex, valid token                 | 1.9 s               | `initialize`, `tools/list`, `tools/call`                                            | the run's word, after 16.4 s |
| Hermes, no token                   | 7.1 s               | seven requests, all 401                                                             | `NO TOOL`                    |
| Hermes, wrong token                | 7.3 s               | seven requests, all 401                                                             | `NO TOOL`                    |
| Hermes, nothing listens at the URL | 8.2 s               | none                                                                                | `NO TOOL`                    |
| Hermes through `ssh -R`            | 3.7 s               | as with a valid token                                                               | the run's word, after 12.6 s |
| Hermes through `ssh` without `-R`  | 7.4 s               | none                                                                                | `NO TOOL`                    |

What follows from them:

- **A server the agent cannot use costs time, not the session.** Hermes starts the session 3 to 5 seconds later and answers without the tool. Familiar can hand the server over without knowing whether the agent reaches it.
- **`mcpCapabilities` cannot be the switch.** Hermes takes the server and advertises nothing. A client that only sends HTTP servers to agents that advertise `http` would leave Hermes without tools.
- **Clients ask for more than the server offers, and take no for an answer.** Hermes and the official client send `GET` to open a stream, Hermes also `HEAD`; `405` is enough. Hermes asked for MCP revision `2025-11-25`, Codex for `2025-06-18`.
- **The player sees the agent's name for the tool.** Hermes: `mcp__editor_wow_161bfe21__character_equipment`. Codex: `mcp.wow.character_equipment`. Hermes first looked the tool up (`tool_describe`), one more step that took 2.0 s in this run.
- **Neither agent asked for permission** to call the tool in these runs. Hermes on the test machine is set up to ask rarely, and Codex ran a review of its own ("Guardian Review") instead. This says nothing about an agent that asks every time.
- **Hermes kept the token in memory.** With a known token, none of the 18 files that changed under Hermes's own folder during the run contained it, logs and session database included.

### `ssh`

The player's command gets two options:

```
ssh -o ExitOnForwardFailure=yes -R 127.0.0.1:<port>:127.0.0.1:<port> <host> <agent command>
```

`-R` makes `<port>` on the agent's machine lead back to the app. With the same number on both sides the URL Familiar hands over is right on both machines.

`ExitOnForwardFailure=yes` matters. If the port is taken on the agent's machine:

|                 | `ssh`                                                              |
| --------------- | ------------------------------------------------------------------ |
| with the option | `Error: remote port forwarding failed for listen port …`, exit 255 |
| without         | prints a warning and starts the agent                              |

Without the option the agent would then talk to whatever else listens on that port and send it the token. On a machine with other users that is a way to feed the agent made-up game data.

The forwarded port listens on the agent machine's loopback address, so every user and process on that machine can connect to it. The token is what keeps them out.

### The server's doors

`bun src/conform.ts` checks them without an agent:

| Request                                                  | Status |
| -------------------------------------------------------- | ------ |
| no token, wrong token                                    | 401    |
| any `Origin` header, which every browser sends           | 403    |
| a `Host` that is not `127.0.0.1`, `localhost` or `[::1]` | 403    |
| `GET`                                                    | 405    |
| valid token                                              | 200    |

The same checks pass in a program compiled with `bun build --compile` for Linux. The Windows program compiles; nobody ran it.

## Not measured

- **Windows.** Every run was on Linux. Open: whether the Windows `ssh` client forwards the same way, and whether a listener on `127.0.0.1` makes the Windows firewall ask.
- **Claude Code with a model.**
- **An agent that refuses `session/new`** because it does not know `type: "http"`. None of the three does; what Familiar should do then is untested.
- **An agent that asks for permission on every tool call.** Each request would reach the player in the game.
- **A URL that neither answers nor refuses**, as behind a firewall that drops packets. On the loopback address a closed port refuses at once, which is the case measured.
- **Whether another agent, or a later Hermes, writes the token to disk.**

## Run it

Needs Bun 1.4.4 and, for the probe, an agent that is signed in.

```sh
cd spikes/mcp-access
bun install
bun run typecheck

# The server against the official MCP client and the doors that must stay shut. No agent.
bun src/conform.ts

# What an agent advertises. No model is asked.
bun src/probe.ts --caps -- hermes acp

# The full way: the agent gets the server and a question only the tool can answer.
bun src/probe.ts -- hermes acp
bun src/probe.ts -- npx -y @agentclientprotocol/codex-acp
bun src/probe.ts --token none -- hermes acp
bun src/probe.ts --token wrong -- hermes acp

# Through ssh: the server on 47843, the agent's machine sees it on 47844.
bun src/probe.ts --port 47843 --url http://127.0.0.1:47844/mcp -- \
  ssh -o ExitOnForwardFailure=yes -R 127.0.0.1:47844:127.0.0.1:47843 <host> <full path to>/hermes acp
```

The probe exits with 0 when the tool was called and the answer has the run's word, a random string that only the tool returns. It allows the agent the spike's tool once and denies every other request. Each full run asks the agent's model one short question.

| File             | What it is                                                                       |
| ---------------- | -------------------------------------------------------------------------------- |
| `src/server.ts`  | the server: one `POST` endpoint, JSON answers, tools only, no session, no stream |
| `src/conform.ts` | the official MCP client and plain requests against it                            |
| `src/probe.ts`   | an ACP client that starts an agent, hands it the server and asks                 |
