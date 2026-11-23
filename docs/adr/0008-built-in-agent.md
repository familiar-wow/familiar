# ADR 0008: The built-in agent

- **Status:** Accepted (2026-11-23)
- **Date:** 2026-11-23
- **Deciders:** @Smidelis, @hermes-smidelis

## Context

ADR 0001 gives Familiar two ways to a brain: a built-in agent for API keys, a ChatGPT plan and local models, and the player's own agent through ACP. Only the second exists so far. It serves players who already run an agent such as Hermes, Codex or Claude Code, but most players have none, and for them Familiar does not work yet.

Through ACP, Familiar sets neither the model nor the prompt nor the tools (ADR 0006). A general-purpose agent brings a large prompt, skills and web research, often on a large model with long reasoning. In the maintainers' tests from 2026-11-15 to 2026-11-22, answers through such an agent took 5 to 21 s without tools and 23 to 94 s with web research. Fetching one slice of game state over the transport took 1.6 to 4.3 s of that. The time goes to the brain, not to the transport.

The `wow` tools (ADR 0007) are the same for every brain. A small agent loop around them, with a fast model and Familiar's own rules, is what players without an agent need.

## Decision

- **A small loop, not a general agent.** The app asks the model, runs the tool calls the model makes, and passes the results back, for at most 8 rounds per question. The rules for answering go as the system prompt; each question carries the character header as before. The tools are those of the `wow` server, called in the app's own process. The built-in agent has no web, file or shell tools; the rules tell the model to say when a fact may differ in Forever. Web research or a lookup of Forever game data is a later decision.
- **Providers through the AI SDK** (`ai` and `@ai-sdk/*`, Apache-2.0), which speaks the tool-calling APIs of all of them:
  - `openai`, `anthropic` and `google` (Google AI Studio) with their own SDK packages;
  - `openrouter`, `deepseek`, `ollama`, `lmstudio` and any other server with an OpenAI-compatible API (`openai-compatible` with a `baseUrl`), through one package.
  - Claude stays API-key only (ADR 0001). _Sign in with ChatGPT_ comes as its own step once OpenAI's terms for it are final.
- **Settings.** `brain.use` chooses the brain: `"agent"` (the player's agent through ACP, `brain.command`, the default so that existing settings keep working) or `"model"` (the built-in agent). `brain.model` names `provider`, `name` and optionally `baseUrl`. `brain.timeout` applies to both.
- **API keys.** Until the desktop app keeps them in the system keychain (FAM-6), a key comes from the provider's usual environment variable, such as `OPENAI_API_KEY`, or from `brain.model.apiKey` in the settings file. Familiar never logs or sends a key anywhere but to its provider. Without a key, the window says which variable to set.
- **Memory of the conversation.** Per character, the app keeps the last 12 questions and answers, each answer up to 2000 characters, without tool results, while it runs. Tool results are not kept because the game state changes; the model asks again. Lasting memory is phase 4.
- **No `wow` server for the built-in agent.** The HTTP server from ADR 0007 starts only when the brain is an agent through ACP.
- **Data rules stay.** The model gets the player's questions, the header and what the tools return, nothing else from the game (ADR 0006). The app logs the provider, model, duration, tool names and token counts of each answer, not the text.

## Alternatives

- **Write the provider clients ourselves.** One OpenAI-compatible client covers most providers in a few hundred lines, but Anthropic and Google speak their own APIs, and each provider's tool calling has its own details. The AI SDK keeps those in maintained packages under a compatible license.
- **A full agent of our own,** with planning, skills, web research and lasting memory. That is a second general-purpose agent to build and secure, and it competes with the agents players already have. The players who want that bring one through ACP.
- **Only ACP, with setup guides for a free agent.** Every player would install and configure a general-purpose agent first, which most will not, and answers stay as slow as that agent.
- **Ask the player's model through a hosted service.** Familiar runs no cloud service (AGENTS.md).

## Consequences

- Players without an agent can use Familiar with an API key or a local model. Answers are as fast as the model: in the first tests through the stub client, four small models (from OpenAI, Anthropic, Google and DeepSeek, through OpenRouter) answered in 1.8 to 8.1 s, tool calls over the transport included.
- Familiar now owns a prompt and a loop for this brain. Answer quality depends on the model the player picks; the docs recommend models that are tested.
- Without web access, the built-in agent knows Forever only from the game state and its training. A lookup of Forever game data would help it most, and every agent through ACP as well.
- The app grows by the AI SDK packages.
- API keys sit in an environment variable or a settings file until the desktop app exists. That is the same as for most command-line tools, and only for development builds.
