# ADR 0006: Brains — a bridge to the player's agent

- **Status:** Accepted (2026-11-15)
- **Date:** 2026-11-15
- **Deciders:** @Smidelis, @hermes-smidelis
- **Supersedes:** in [ADR 0001](0001-architecture-addon-companion-and-brains.md), the second sentence of "Game text is untrusted"

## Context

ADR 0001 has Familiar run its sessions in a restricted harness profile without shell or file tools wherever the harness allows it, and show permission requests in game or deny them. Building the ACP client (FAM-24) showed that this rule does not hold up:

- Restrictions exist only in each agent's own settings: per profile in Hermes (`platform_toolsets.acp`), through modes in Codex and Claude Code. A separate profile also leaves behind what makes the player's agent theirs: its skills, its memory and its MCP servers.
- Declining permission requests stops only agents that ask. In its default mode, Codex writes files and runs commands without asking.
- The rule was meant against other players' text that steers the agent. Familiar decides what reaches the agent, and the addon reads no chat, whispers or mail.

## Decision

- **Familiar is a bridge.** It starts the agent the player chose and carries questions and answers. The player sets the agent up in the agent itself: model, tools, skills, MCP servers and what it may do without asking. Familiar's settings cover only the bridge: the command that starts the agent, the answer to permission requests, the timeout and the working folder.
- **Permission requests:** Familiar answers each one once, `deny` by default or `allow` if the player sets it, and never "always", so it never changes the agent's own settings. Once the chat window exists, Familiar can ask the player instead. Familiar lends the agent no file system or terminal through ACP; the agent uses its own tools.
- **Other players' text stays out.** The agent gets the player's questions, a header about the character and, from phase 2, game state from the `wow` server. Names of players, guilds and pets are data in that state. Chat, whispers, mail and guild notes do not reach the agent; a feature that wants to pass such text on needs its own decision.

## Alternatives

- **A restricted profile per agent** (ADR 0001): only Hermes sets tools per profile, the player loses skills, memory and MCP servers, and Codex shows that declined requests do not bound an agent.
- **Familiar sets modes and options through ACP** (`session/set_mode`, `session/set_config_option`): works with any agent, but becomes a second place for settings that the agent already has.
- **Allow every request by default:** the agent would do more from the game than in the player's own terminal, where it asks first.

## Consequences

- Any agent that speaks ACP works without code of its own: Hermes natively, Codex and Claude Code through the adapters from ADR 0001.
- What an agent may do on the player's computer is the player's setting, as everywhere else they use it. The setup says so.
- With `deny`, an agent that asks before a risky step cannot take that step from the game until the player sets `allow` or the chat window asks.
- Web pages that an agent reads can carry instructions, inside Familiar as outside; that stays with the agent.
