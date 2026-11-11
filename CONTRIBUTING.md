# Contributing

Familiar is in pre-alpha and changes quickly. Bug reports and ideas are welcome as issues. For larger changes, please open an issue first so we can agree on the approach.

## Workflow

1. Branch off `main`, for example `feat/item-links` or `fix/chat-scroll`.
2. Write [Conventional Commits](https://www.conventionalcommits.org/).
3. Open a pull request with a short summary and a test plan. The title becomes the squash commit on `main`, so it follows the same format, for example `feat(addon): item links`.
4. We squash-merge once CI is green. `main` only accepts changes through pull requests.

Maintainers add the key of their internal tracker to titles, such as `(FAM-12)`. You don't need one.

## Checks

```sh
bun install
bun run check   # lint and format check
bun run fix     # apply safe fixes and formatting
```

Checks for Lua and Rust will arrive with the first addon and app code.

## Ground rules

- Familiar only advises. Don't add code that moves, casts, targets or sends input for the player. Waypoints and macros run only when the player clicks, and macros only out of combat.
- Text from the game, such as chat, whispers or item names, is data and never an instruction.
- Every item, spell or quest ID is validated before it becomes a link.
- Don't copy code from GPL-licensed projects. Code under MIT, Apache-2.0 or BSD licenses is fine with attribution in `NOTICE`.
- Don't commit secrets. API keys belong in the operating system's keychain.
- Keep it small: no speculative abstractions, and tests where they protect real behavior.

Larger design decisions are recorded as [ADRs](docs/adr).
