---
name: code-simplify
description: Simplifies and refines code for clarity, consistency, and maintainability while preserving all functionality. Use after implementation for the repository's four-agent simplify pass or when asked to simplify recently modified code.
---

# Code simplification

*Modified for this repository's four-agent review workflow.*

Simplify and improve code without altering its behavior. Prioritize readable, explicit code and apply project-specific best practices.

1. **Preserve Functionality**. All candidate features, outputs, and behaviors must remain intact. Preserve compatibility, error handling, and resource cleanup.
2. **Apply Project Standards**. Follow `AGENTS.md` and the conventions in the affected code. Preserve the Direct Provider contract and the server, client, and shared boundaries.
3. **Enhance Clarity**. Look for the following ways to simplify code structure.
   - Reducing unnecessary complexity and nesting
   - Eliminating redundant code and abstractions
   - Improving readability through clear variable and function names
   - Consolidating related logic and reusing existing implementations
   - Removing comments that describe obvious code
   - Using explicit branches for multiple conditions
4. **Maintain Balance**. Watch for over-simplification with these effects.
   - Reduced code clarity or maintainability
   - Overly clever solutions that are hard to understand
   - Too many concerns in a single function or component
   - Loss of helpful abstractions that improve code organization
   - Code that is harder to debug or extend
5. **Focus Scope**. Start with the candidate diff. Read the callers, existing implementations, and tests needed to understand it. Look for refinements to the recently modified code and obsolete branches or workarounds directly superseded by the change.

## Four-agent review

Follow the section for your assigned role. A subagent reviewing a delegated scope returns its findings directly to the coordinating agent.

### Coordinating agent

Give four independent subagents the same candidate diff, the intended behavior, and these instructions. Run them in parallel. Set their focus based on the code paths affected by the change and allow overlap where the paths interact.

Consolidate overlapping findings, apply the refinements, and verify the affected callers and tests. Record the reviewed commit, each subagent's conclusion, and how the findings were handled. Have the relevant subagents recheck materially changed code before merging. When acceptance testing calls for a live environment, prefer the simplified candidate and rerun previously tested scenarios affected by the refinements.

### Delegated reviewers

Review the code and return findings to the coordinating agent. Keep the review read-only. For each finding, give the file location, the unnecessary complexity it addresses, a concrete refinement, and the behavior or callers to preserve. If you find no worthwhile changes, report what you checked.
