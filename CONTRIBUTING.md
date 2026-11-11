# Contributing

Familiar is pre-alpha and changes quickly. Bug reports and ideas are welcome as issues. For larger changes, please open an issue first so we can agree on the approach.

[AGENTS.md](AGENTS.md) has the complete rules, including what game code may and may not do. It is written for AI agents, and it applies to people as well.

## Pull requests

1. Fork the repository and create a branch such as `feat/item-links` or `fix/chat-scroll`. Team members with write access branch in the repository itself.
2. Write [Conventional Commits](https://www.conventionalcommits.org/).
3. Open a pull request and fill in the template. The title becomes the squash commit on `main`, so it follows the same format, for example `feat(addon): item links`.
4. Once CI is green and @Smidelis has given his go, a maintainer squash-merges it.

Team members add the key of the team's internal tracker to titles, such as `(FAM-12)`. You don't need one. Larger design decisions are recorded as [ADRs](docs/adr), proposed as a pull request.

## Working with an AI agent

Most of Familiar is written by an agent, and yours is welcome too. Point it at [AGENTS.md](AGENTS.md).

- A person is responsible for every issue and pull request. Read what your agent wrote before you send it.
- Name the agent in the pull request.
- The test plan lists commands that were actually run, with their results.
- We close pull requests that nobody has read, and batches of generated issues.

## Checks

```sh
bun install
bun run check   # lint and format check
bun run fix     # apply safe fixes and formatting
```

Checks for Lua and Rust will arrive with the first addon and app code.

## Security

Please report vulnerabilities privately, as described in [SECURITY.md](SECURITY.md).
