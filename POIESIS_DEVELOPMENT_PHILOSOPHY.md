# Poiesis Development Philosophy

This document is **maintainer development philosophy** for people building and releasing **Poiesis itself**.

It is packaged with `poiesis-cli` as package source. It is **not** projected into ordinary consumer installs as `.poiesis/DEVELOPMENT_PHILOSOPHY.md`, and Primary Poiesis sessions in ordinary unrelated projects must **not** load it unless the work is developing Poiesis.

Product behavior for Authors lives in `POIESIS_PHILOSOPHY.md` (installed as `.poiesis/PHILOSOPHY.md`). Operational procedure lives in `METHOD.md` and role files. Do not conflate the three.

## Scope

Load this file when:

- changing the Poiesis package, runtime, method, roles, adapters, or release contract;
- deciding how Poiesis acquires dependencies, pins tools, or owns install/update/uninstall;
- reviewing whether a new abstraction belongs in the runtime.

Do **not** load it as ordinary consumer project guidance.

## Native tools and justified machinery

- Prefer standards, Node/package-manager norms, Git, trackers, and OpenCode-native surfaces before inventing a second workflow engine.
- Keep deterministic runtime code authoritative for mutations that must be exact and repeatable.
- Use models for judgment, design, synthesis, and decisions — not for reinventing ownership, hashing, or receipt mechanics.
- A wrapper, journal, or projection earns its place only when it improves reliability, fail-closed safety, or Author clarity.

## Dependencies and environment

- Valuable dependencies are welcome. A useful capability is not rejected merely because a fresh environment lacks it.
- The runtime declares requirements, acquires them deterministically when appropriate, verifies them (`doctor`), and fails closed with typed conditions when they cannot be met.
- Missing tools are setup work the runtime owns — never a reason to weaken Proof, review, privacy, or operator visibility.

## Ownership and packaging

- Package canon and generated projections are ownership-scoped. Update and uninstall must not claim arbitrary project paths.
- Adding a managed template requires authentic predecessor migration with receipt gates — never open path ownership loosely.
- Project instructions (`AGENTS.md` and similar) remain **Author-owned project source**. Install/update/uninstall must not invent, bulk-generate, or destroy semantic instruction files.
- Consumer product philosophy is projected; this maintainer document stays package-source so ordinary projects are not loaded with internal development rules.

## Harness boundary

- OpenCode is the sole currently supported harness. No plugins. No automatic restart of the Author's harness.
- Skills load through native Skill surfaces after Author-controlled restart when installation changed local skills.
- Do not substitute direct skill-body injection for native loading.

## Evidence and recovery

- Internal checkpoints and journals are recovery machinery, not canonical project history.
- Failed attempts and development noise must not become permanent consumer history.
- Focused checks are ticket evidence; whole-change Proof remains the single verification plan gate.

## Roles and tools

- Each role receives the tools required for its owned responsibility, including Bash where useful, under bounded allowlists.
- Deterministic Poiesis operations retain lifecycle authority; raw shell gains no lifecycle evidence.

## UI/UX

- **UI/UX workflow is TODO only.** No product UI/UX implementation is in scope until explicitly authorized as its own work.
- Do not invent dashboards, settings UIs, or alternate Author surfaces as side effects of runtime work.

## Release discipline

- Implement in isolated workspaces from the canonical integration base.
- Production release requires separate explicit authorization.
- After accepted publication, update installed consumer projects through managed operations; preserve their models, tracker, delivery, and mode.
