# ADR 0002: Desktop app — Tauri shell with TypeScript core

- **Status:** Accepted (2026-11-11)
- **Date:** 2026-11-10
- **Deciders:** @Smidelis, @hermes-smidelis

## Context

Players need a companion that installs like any other game tool, runs quietly in the tray while they play and behaves the same on Windows, macOS and Linux. A local web UI in the browser was rejected: ports, firewalls and accidentally closed tabs cause support problems for non-technical users. The libraries we depend on (the ACP and MCP SDKs, AI provider SDKs) are TypeScript-first.

## Decision

- **Tauri 2** for the desktop app: native window and tray icon, installers and signed auto-updates.
- **UI** in Svelte 5 with TypeScript.
- **Core** in TypeScript, compiled with Bun into a single sidecar binary that the app starts. It contains the transport, game-state cache, MCP servers, brain adapters and memory.
- UI and core communicate through the app over the sidecar's stdin/stdout. No network port is opened.
- API keys are stored in the operating system's keychain (Windows Credential Manager, macOS Keychain, Secret Service on Linux).
- The **Vercel AI SDK** unifies the API providers: OpenAI, Anthropic, Google, OpenRouter and any OpenAI-compatible server such as Ollama or LM Studio. It is an Apache-2.0 library that runs locally; no Vercel account or service is involved.

## Alternatives

- **Electron:** one language, but it keeps a complete Chromium in memory while the game runs.
- **Local web UI:** rejected, see Context.
- **Core in Rust:** smaller binary, but weaker ACP, MCP and provider libraries and slower iteration.
- **Command line only:** not suitable for players.

## Consequences

- Two languages: a thin Rust shell, TypeScript everywhere else.
- Installers must be signed to avoid SmartScreen and Gatekeeper warnings: the SignPath Foundation (free for open source) on Windows, and the Apple Developer Program (99 USD per year) for notarization on macOS. This is tracked as a risk.
- The walking skeleton validates Bun as the sidecar runtime; a Node single-executable application is the fallback.
