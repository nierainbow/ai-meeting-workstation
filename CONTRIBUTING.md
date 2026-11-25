# Contributing

Thanks for taking the time to improve AI Discussion.

## Local Setup

```bash
npm install
cp .env.example .env
npm run doctor
npm run dev
```

## Before Opening a PR

Please run:

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

## Per-Workspace Environment

`orca.yaml` defines a local, loopback-only Orca server recipe and `scripts.setup`. The setup script verifies Node.js 22+, git, npm, and python3, then installs the locked npm dependencies only when needed. Recipe state contains no credentials; pairing output is kept in temporary files.

```bash
orca vm recipe doctor local-orca-server --json
orca vm env doctor --run-setup --json
```

Use a reachable tunnel or remote provider recipe when workspaces must be paired from another machine.

## Pull Requests

- Keep changes focused and explain the user-facing behavior.
- Update docs when changing setup, configuration, API shape, or product flow.
- Do not commit `.env`, `.local-data/`, local recordings, local databases, or personal workspace metadata.

## Issues

Use the issue templates for bug reports, feature requests, and spec tasks. Include reproduction steps and environment details when reporting bugs.
