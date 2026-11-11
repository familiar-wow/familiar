# ADR 0001: Architecture — addon, companion and brains

- **Status:** Accepted (2026-11-11)
- **Date:** 2026-11-10
- **Deciders:** @Smidelis, @hermes-smidelis

## Context

WoW addons run in a sandbox without network or file access, so every AI integration needs a local companion process that talks to the addon through side channels of the game client. Existing projects each bind one kind of brain: Wisp ships its own agent for API providers, wow-ai drives harness CLIs one by one, and Hermes Context calls a single CLI. Familiar promises "bring your own brain": any model via API or any agent harness, with the same game context, links and memory. Most players are not developers. They may have a ChatGPT or Claude subscription or a Google account, but no API key and no command-line tools.

## Decision

Familiar has three parts with narrow interfaces:

1. **Addon (Lua):** in-game chat window, game-state collectors, link hooks and rendering of validated actions. It contains nothing specific to a particular brain.
2. **Companion (local app):** owns the transport, a revisioned game-state cache and two MCP servers: `wow` (character, equipment, talents, bags, quests, professions, spells, lookups) and `memory`.
3. **Brain**, through one of two adapters that use the same MCP tools:
   - **Built-in agent:** a small agent loop with tool calling, for players without a harness. It connects to:
     - a ChatGPT plan through _Sign in with ChatGPT_, OpenAI's ChatGPT plan usage for open-source local apps (currently in preview);
     - API keys for OpenAI, Anthropic, Google AI Studio (which has a free tier) and OpenRouter;
     - local servers such as Ollama and LM Studio.
   - **Harness via ACP** (Agent Client Protocol), for players who already use an agent. Familiar is an ACP client and passes its MCP servers in `session/new`.
     - Hermes, OpenClaw and Gemini CLI speak ACP natively. Gemini CLI also has a free tier when you sign in with a Google account.
     - Codex, Claude Code and Pi do not speak ACP themselves. They connect through open-source adapters: codex-acp and claude-agent-acp from the ACP project, and pi-acp from the community. Familiar ships or downloads these adapters and starts them itself; players never install an adapter.

**Setup:** the desktop app detects installed harnesses and local servers, offers _Continue with ChatGPT_ and Google sign-in as buttons, and walks through API keys in a few steps. The user documentation has one short page per path.

**Provider terms:** Familiar uses a subscription only where the provider allows it.

- OpenAI allows ChatGPT plan usage in open-source local apps through Sign in with ChatGPT.
- Anthropic does not allow Claude Free, Pro or Max subscriptions in third-party products, including tools built on its Agent SDK (Consumer Terms, clarified in February 2026). Claude is therefore supported with an Anthropic API key only, both in the built-in agent and through Claude Code. Familiar never reads or reuses claude.ai credentials.
- Free tiers may let the provider use prompts to improve its products. The setup says so.

Rules for all parts:

- **Transport behind an interface.** A spike decides the concrete channel (ADR 0005). Copy and paste always works as a fallback.
- **Pull, not push.** Each message carries a small header (character, level, zone); the brain fetches everything else through tools. Unchanged data travels as a revision reference.
- **Validated links.** Models write markup such as `[[item:19019]]` or `[[way:1411:52.3:41.2]]`. The companion validates every ID, and the addon renders native links. Unknown IDs appear as plain text with a warning.
- **Advisory only.** No movement, casting, targeting or generated input. Waypoints and macros happen only when the player clicks; macros only out of combat.
- **Game text is untrusted.** Other players' chat is data, never instructions. Familiar sessions use a restricted harness profile without shell or file tools wherever the harness allows it, and permission requests are shown in game or denied.

## Alternatives

- **One CLI adapter per harness** (wow-ai, Hermes Context): many adapters with uneven features and no shared tools.
- **Own agent only** (Wisp): fine for API users, but players cannot reuse harnesses they already pay for and have configured.
- **Driving the official chat apps** (ChatGPT, Claude Desktop): they offer no interface for another program to send prompts and receive answers.
- **Full snapshot with every message:** wastes the very limited bandwidth.

## Consequences

- All harnesses use ACP. Native support (Hermes, OpenClaw, Gemini CLI) needs nothing extra; Codex, Claude Code and Pi depend on adapters that Familiar must keep up to date.
- Claude subscribers need an API key. A later option is to offer Familiar's MCP server to Claude Desktop, which would let them use their subscription with Familiar's game data outside the game.
- Provider terms can change, as Anthropic's did in 2026. Each brain path can be disabled on its own, and the terms are checked before every release.
- The transport remains the fragile part, but it is isolated and replaceable.
- The MCP servers become the single source of game truth and can later be used outside the game too.
