# ATO Agent Guide

ATO is a public TypeScript project for agent coordination. Keep the product surface small, deterministic, and easy for other agents to inspect.

## Working Rules

- Prefer focused changes with tests.
- Keep generated output out of source control unless it is part of a release artifact.
- Treat public docs as product promises.
- Do not add hidden runtime state to the repository root.
- Make CLI output stable by default and machine-readable where practical.

## Useful Commands

- Build: `npm run build`
- Test: `npm test`
- Check: `npm run check`
