# ATO Project Charter

## Position

ATO is an agent coordination substrate, not a coding agent and not a model wrapper.

Its job is to provide durable local structure that many agents can use: task queues, state, memory, protocols, evidence, and handoff records.

## First Product Direction

The first public version should focus on a small reliable kernel:

- repository and store discovery
- explicit task state
- append-only event records
- simple machine-readable commands
- clear boundaries between product features and experiments

## Non-Goals

- Replace coding agents.
- Hide important state behind opaque services.
- Make private evaluation workflows part of the public product surface.
- Add commands before the agent loop that needs them is understood.

## Success Criteria

ATO succeeds when an agent can enter an unfamiliar project, understand the current work state, choose the next safe action, record evidence, and hand off cleanly to another agent or future session.
