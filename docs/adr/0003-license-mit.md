# ADR 0003: License — MIT

- **Status:** Accepted (2026-11-10)
- **Date:** 2026-11-10
- **Deciders:** @Smidelis, @hermes-smidelis

## Context

Blizzard requires addons to be free of charge with publicly accessible code. Familiar wants to become the default AI companion, so reach and contributions matter more than control. The repository contains both the addon and the desktop app.

## Decision

The whole repository is licensed under **MIT**.

## Alternatives

- **Apache-2.0:** like MIT plus a patent grant, but with more formalities. Patents are not a realistic concern here.
- **GPL-3.0:** derivative works must stay open, which blocks closed forks. It deters some contributors and limits reuse, though it would allow copying code from Wisp (GPL-3.0), which we do not plan to do.
- **All rights reserved with visible source** (Naowh Forever): not open source, and forks and contributions are legally unclear.

## Consequences

- Anyone may fork Familiar, including into closed or paid tools. We compete on quality and community.
- No code is copied from GPL projects such as Wisp, only ideas. MIT-licensed code (for example from wow-ai) may be reused with attribution.
- Dependencies must be MIT-, Apache-2.0- or BSD-compatible. Bundled third-party code is listed in `NOTICE`.
