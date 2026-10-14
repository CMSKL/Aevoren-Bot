# Script Skills

This guide describes the v0.3.0-beta.30 development candidate. Package and real Docker validation are recorded in the [implementation plan](IMPLEMENTATION_PLAN.md); this document does not imply a published installer.

## Select, authorize and run

Import a Skill directory through **Contacts → Skill**, or the group's **Skill** tab. Bash (`.sh`/`.bash`), Python (`.py`) and Node (`.js`/`.mjs`/`.cjs`) entries must be inside `scripts/`. The application owns the saved files; moving the source directory does not change a saved revision.

The script section uses the displayed saved revision. Review its source and checksum, select the executing group member when applicable, and choose the intended environment. Initialize/start the environment first. Existing environments using Worker 1.1.0 require an explicit rebuild to enable script execution; upgrading the app does not rebuild running services.

A grant fixes the conversation, executing Bot, environment image, Skill revision, entry checksum and interpreter. Review this target before confirming the grant. A newer Skill revision needs its own grant. Revoking a grant cancels its pending/active runs while retaining siblings and independent background services.

Before running, review the argument array, workspace-relative working directory and timeout. Arguments are passed directly to the fixed interpreter, without constructing a Shell command. Runs use foreground execution: Runtime completion or cancellation stops that Runtime's unfinished work. Use the existing execution panel for actual stdout/stderr, exit status and cancellation. An uncertain result retains its original intent; query it before deciding what to do next.

## AI operations and approvals

Models discover these operations with `product_catalog → product_describe → product_execute`:

| Operation | Purpose |
| --- | --- |
| `skills.scripts` | Verify and list entries from an authorized fixed revision |
| `skills.executionGrants` | List grants within the current conversation/executor scope |
| `skills.grantExecution` | Request approval of an exact entry and environment |
| `skills.revokeExecution` | Revoke one grant and cancel its unfinished runs |
| `skills.runScript` | Request approval of one run's fixed target and parameters |
| `skills.scriptExecution` | Query the original version provenance and current execution |

The host supplies the AI's conversation and executor. Each AI run stores an immutable approval review in SQLite before asking the user. The approval dialog displays that record, and checks whether the grant and environment remain valid. Denying or stopping one member's approval leaves other group members running. The group footer can still stop the full batch.

`skills.load` only loads authorized text instructions. YAML tool declarations do not grant script, connector or other product permissions. Disabling/deleting the Skill, removing its conversation binding or revoking its grant blocks later execution. Editing creates a new revision and does not replace a running task's original files.

## Storage and limits

Packages include the original saved `SKILL.md` body and accepted auxiliary bytes, with at most 251 entries including the main file, 1 MiB per file and 4 MiB total. The Worker validates lengths, portable paths and SHA-256 before publishing a package. Cancellation or invalid content does not publish a partial installation.

The Worker keeps a private package cache and creates a root-owned, read-only snapshot for each job UID. Generic commands cannot modify that snapshot or read private packages. The interpreter receives a clean environment and the workspace's shared supplementary group. The snapshot and all UID descendants are removed before reusing that UID.

Execution remains inside the configured local Docker environment. Browser profiles, host HOME, Docker socket and host GUI are outside its access. Script jobs retain the environment's outbound network access and workspace permissions. Secrets are not copied into Skill metadata or job environments.

Demonstration recording, native Gmail/Drive/Notion, writable MCP and interactive Apps are separate remaining Stage 4 deliveries. Third-party writes require a concrete approved target and are not verified by controlled adapter tests.
