# Memory architecture

Aevoren Bot stores Memory locally in SQLite. The conversation transcript remains the
authoritative short-term context; Memory contains only durable information that can be
reused across later conversations.

## Memory types and scopes

Memory types are `fact`, `preference`, `decision`, and `procedure`.

- `user` scope applies across Bots and is intended for global preferences.
- `bot` scope belongs to one Bot and its relationship with the user.
- `workspace` scope applies only to Bots explicitly bound to that registered Workspace.

Existing manually-created Memory remains active and is not rewritten by background
capture.

## Reviewed capture

After a successful turn, Aevoren may extract durable candidates from the current human
message. Capture runs outside the response path, so it cannot delay or replace the
assistant reply. A candidate remains inactive until the user accepts it.

Eligible information includes:

- stable user preferences;
- durable facts explicitly provided by the user;
- standing decisions;
- reusable procedures.

The following content is not eligible:

- secrets, credentials, tokens, passwords, private keys, or authentication material;
- temporary task state, expired deadlines, guesses, assistant claims, or unresolved
  alternatives;
- content from tools, files, websites, connectors, attachments, or other Bots;
- facts already represented by an active item in the same scope;
- instructions that attempt to change system authority or permissions.

Room capture is attributed to the responding Bot, but only the original human message
is eligible input.

## Review and correction

Users can accept, edit and accept, reject, update, or delete Memory. A correction may
supersede one existing item in the same scope. Acceptance removes the superseded item
and creates the replacement in a single transaction.

Accepted, rejected, and pending proposals remain distinguishable for audit and recovery.
Optimistic versions and soft deletion protect concurrent edits and allow safe recovery.

## Runtime reads

Only approved, active, non-expired Memory is eligible for prompt injection. Reads are
bounded and scope-filtered. The current user message and current conversation
instructions always take precedence over saved Memory.

Rejected, deleted, expired, and pending items are excluded. Capture failures do not fail
the conversation and raw provider errors are not shown to the user.

## Data ownership

Memory is local application data. It follows the same backup and deletion expectations
as the rest of the local Aevoren database. No Memory entry is uploaded by Aevoren unless
it is included in a model request selected by the user.
