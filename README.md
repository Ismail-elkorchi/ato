# ATO

ATO is a local-first coordination layer for AI agents.

It is designed to help agents plan work, preserve context, exchange durable state, and verify progress across projects without depending on one specific model, editor, or coding assistant.

## Mission

Make agentic work more reliable by giving agents a small, inspectable operating layer for:

- task state and intent
- project memory
- coordination between tools and agents
- evidence-backed progress
- safe handoff between sessions

## Current Status

ATO is at its public starting point. The repository begins with a minimal TypeScript CLI and will grow in small, testable increments.

## Quick Start

```bash
npm install
npm run build
npm test
node dist/cli/main.js --help
```

## Principles

- Local-first: project state should be inspectable on disk.
- Agent-neutral: useful from Codex, Claude Code, OpenCode, custom agents, and human shells.
- Deterministic: commands should prefer stable ordering and repeatable output.
- Small kernel: product capabilities should earn their place.
- Product-facing by default: repository docs should describe ATO behavior.

## License

Apache-2.0
