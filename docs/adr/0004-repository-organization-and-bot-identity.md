# ADR 0004: Repository, organization and bot identity

- **Status:** Accepted (2026-11-11)
- **Date:** 2026-11-10
- **Deciders:** @Smidelis, @hermes-smidelis

## Context

Familiar is a product, not a private experiment. Its home must survive changes in the team, and the update URL compiled into released apps must never change. Hermes writes most of the code, so its contributions should be attributable and verifiable.

## Decision

- **Organization** `familiar-wow` on GitHub (Free plan, owner @Smidelis) with one public monorepo, `familiar`:
  - `addon/`: the Lua addon (CurseForge package)
  - `app/`: the Tauri desktop app
  - `core/`: the TypeScript companion core
  - `docs/`: architecture, ADRs and user docs
- **Public from day one**, labelled pre-alpha. Branch rules on the Free plan only work for public repositories, and Blizzard requires visible addon code anyway.
- **Bot identity:** the GitHub machine account `hermes-smidelis` (display name "Hermes Agent") is an org member with write access. Its commits are signed with an SSH signing key so GitHub shows them as Verified, and they use the account's noreply email address.
- **Flow:** short-lived branches (`feat/…`, `fix/…`); Conventional Commits that include the YouTrack key, such as `feat(addon): item links (FAM-12)`; a pull request with a summary and test plan; squash merge after green CI; branch deleted afterwards.
- **Merging:** Hermes merges its own pull requests once @Smidelis has given an explicit go, in chat or as a GitHub review, and notes where the go came from in the pull request. GitHub does not require an approval.
- **Protected `main`:** changes only through pull requests with green CI; no force pushes and no deletion.
- **Language:** English for code, docs, commits and GitHub issues. Planning happens in YouTrack FAM, private notes live in Outline.
- **Releases:** a version tag builds the addon zip (CurseForge and GitHub Releases) and signed app installers.

## Alternatives

- **Repository under a personal account:** simpler, but moving it later puts the update URL at risk and mixes the product with private repositories.
- **Commits as the maintainer:** no separation between human and agent work, and no real review.
- **Unsigned bot commits:** no Verified badge, and with vigilant mode they show as Unverified.
- **A required GitHub approval for every pull request:** rejected in review. It slows work down without adding safety, because the go is given in chat.

## Consequences

- GitHub allows one free machine account per person, so `hermes-smidelis` is the maintainer's agent for all his repositories, not only Familiar. Product automation such as releases or issue triage would use a GitHub App later.
- @Smidelis can review any pull request on GitHub, but he does not have to: his go is enough. The same rules apply to his own pull requests.
