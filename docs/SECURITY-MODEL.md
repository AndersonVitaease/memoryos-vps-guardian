# Security Model

This document describes the public security principles of MemoryOS VPS Guardian. It documents principles only — not internal implementation details.

## Principles

1. **No unrestricted shell by default.** Tools never expose a general-purpose command channel. Capability is bounded per tool and per goal.

2. **No unrestricted SSH credentials exposed to AI agents.** Agents operate through scoped MCP tools; direct remote-login material is not part of the public surface.

3. **Goal-oriented tools.** Each tool answers one operational question ("is it healthy?", "why is it down?", "is it safe to deploy?") instead of offering arbitrary power.

4. **Read-only by default where possible.** Observation tools perform zero mutation. Where mutation exists, it is an explicit, named capability.

5. **Explicit mutation boundaries.** Any changing operation requires explicit confirmation, operates from a fixed allowlist, and can never be steered into arbitrary commands, targets or payloads.

6. **Deterministic evidence before AI interpretation.** Structured evidence is collected and classified deterministically first; interpretation layers build on that evidence rather than replacing it.

7. **No fabricated evidence.** Missing or inconclusive evidence is reported as such (for example UNKNOWN or insufficient evidence). Findings are never invented to fill gaps.

8. **Least privilege.** Each tool requests and exposes only the minimum capability needed to answer its question.

9. **Validation after controlled actions.** Controlled actions are followed by post-validation; accepted or queued work is never counted as success without verified outcome evidence.

10. **Separation between public MCP surface and private orchestration/intelligence.** This repository publishes a tool surface and its contracts; coordination and intelligence layers remain separate and are not part of the public surface.

## What this means in practice

- An AI agent using this surface can ask operational questions and, where explicitly enabled, trigger narrowly defined, validated operations.
- The agent cannot pivot into arbitrary command execution through the public surface.
- Evidence gaps stay visible instead of hidden, keeping human operators in control.
