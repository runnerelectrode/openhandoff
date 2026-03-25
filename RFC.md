# AHP: Agent Handoff Protocol

```
RFC:            AHP-0001
Title:          Agent Handoff Protocol (AHP)
Status:         Draft
Authors:        Gaurav Shukla
Created:        2026-03-25
Version:        0.2.0
```

## Abstract

The Agent Handoff Protocol (AHP) defines an open protocol for transferring
artifacts and versioned memory between AI agent instances across trust
boundaries. Authorization is delegated to the enterprise Identity Provider
via ID-JAG (Identity Assertion JWT Authorization Grant). The protocol is
intentionally minimal: a thin envelope, versioned memory entries sourced
directly from the agent's memory backend, and a single HTTP transport
binding with an ID-JAG JWT as the auth credential.

---

## 1. Introduction

### 1.1 Problem

An enterprise AI agent and a home AI agent operate in isolation. There is
no standardized way to hand off work — including the semantic memory behind
that work — across the trust boundary between them.

Existing approaches fail because they:
- Require bilateral key exchange between every pair of peers
- Invent their own auth/policy models instead of using enterprise IdPs
- Lack versioning, so repeated handoffs cause duplicates or silent data loss
- Define complex protocol-level authorization that duplicates what IdPs
  already do

### 1.2 Approach

AHP takes the opposite approach:

1. **Auth is not our problem.** ID-JAG lets the enterprise IdP decide who
   can hand off what to whom. AHP carries the JWT; it does not define
   policies, permissions, or redaction rules.
2. **Memory comes from the agent directly.** OpenClaw's `memory_search` /
   `memory_get` tools (or any backend) produce the entries. AHP versions
   and transports them — it does not redefine memory storage.
3. **Versioning is the hard part.** Per-entry content hashes, parent
   pointers, tombstones, and a slice manifest hash enable delta sync
   and conflict detection. This is where the spec adds value.

### 1.3 Terminology

The key words "MUST", "MUST NOT", "REQUIRED", "SHOULD", "SHOULD NOT",
"MAY", and "OPTIONAL" are interpreted as described in
[RFC 2119](https://datatracker.ietf.org/doc/html/rfc2119).

| Term | Definition |
|------|-----------|
| **Peer** | An AI agent instance participating in a handoff |
| **Initiator** | The Peer that sends a handoff |
| **Receiver** | The Peer that accepts a handoff |
| **Artifact** | A unit of content (code, document, task brief) |
| **MemorySlice** | A versioned set of memory entries crossing the boundary |
| **MemoryEntry** | A single memory item with its own version hash |
| **IdP** | The enterprise Identity Provider (Okta, Entra, Auth0, etc.) |

---

## 2. Architecture

```
┌──────────────────┐                         ┌──────────────────┐
│ Enterprise Agent │                         │    Home Agent    │
│                  │                         │                  │
│  memory_search ──┼──► MemorySlice          │                  │
│                  │    + Artifacts           │  ◄── import &    │
│  IdP ◄── token   │    + ID-JAG JWT         │      re-embed    │
│     exchange     │ ──────────────────────► │                  │
│                  │     HTTP POST           │  memory_search ──┼──►
└──────────────────┘                         └──────────────────┘
         │              Trust Boundary                │
         └────────────────────────────────────────────┘
```

**Roles are symmetric.** Either Peer can initiate. The Initiator
assembles the envelope, obtains an ID-JAG JWT, and sends. The Receiver
validates the JWT, checks versions, imports, and acknowledges.

---

## 3. Authentication: ID-JAG

AHP delegates all authentication and authorization to the enterprise IdP
via [ID-JAG](https://datatracker.ietf.org/doc/draft-ietf-oauth-identity-assertion-authz-grant/)
(Identity Assertion JWT Authorization Grant).

### 3.1 Flow

```
1. Initiator authenticates to IdP via existing SSO session.

2. Initiator requests Token Exchange (RFC 8693):
     subject_token:  user's ID token
     audience:       Receiver's peer_id
     scope:          AHP scopes (see 3.2)

3. IdP evaluates admin-defined policy → issues signed ID-JAG JWT:
     iss:            IdP issuer URI
     sub:            user identifier
     aud:            Receiver's peer_id
     client_id:      Initiator's peer_id
     scope:          granted AHP scopes
     exp:            short-lived (RECOMMENDED: 5-15 minutes)
     jti:            unique token ID
     ahp:            OPTIONAL constraint claims (see 3.3)

4. Initiator sends Handoff Envelope with JWT in Authorization header.

5. Receiver validates:
     - JWT signature via IdP JWKS
     - aud matches own peer_id
     - exp is not past
     - jti not previously seen
```

No shared secrets. No bilateral key exchange. The IdP is the sole
trust broker.

### 3.2 AHP Scopes

| Scope | Controls |
|-------|----------|
| `ahp:handoff` | Permission to initiate a handoff |
| `ahp:artifacts` | May include artifacts |
| `ahp:memory` | May include any memory category |
| `ahp:memory:preference` | May include preference entries only |
| `ahp:memory:decision` | May include decision entries only |
| `ahp:memory:fact` | May include fact entries only |
| `ahp:memory:entity` | May include entity entries only |
| `ahp:memory:procedure` | May include procedure entries only |
| `ahp:memory:context` | May include context entries only |
| `ahp:memory:write` | May return modified memory |

Category-specific scopes take precedence. If the JWT grants only
`ahp:memory:preference` and `ahp:memory:decision`, only those
categories may be included. Entries outside the granted scopes
MUST NOT be included in the envelope — the scope IS the redaction.

### 3.3 Constraint Claims

The IdP MAY include an `ahp` claim in the JWT:

```json
{
  "ahp": {
    "max_ttl_seconds": 604800,
    "no_reshare": true,
    "require_encryption_at_rest": true,
    "allowed_namespaces": ["acme-corp"],
    "scope_lock": {
      "namespace": "acme-corp",
      "agent_scope": "project-x"
    }
  }
}
```

| Claim | Meaning |
|-------|---------|
| `max_ttl_seconds` | Receiver MUST delete imported memory after this duration |
| `no_reshare` | Receiver MUST NOT include this memory in further handoffs |
| `require_encryption_at_rest` | Receiver MUST encrypt stored memory |
| `allowed_namespaces` | Only memory from these namespaces may be included |
| `scope_lock` | Receiver MUST import into this scope, MUST NOT move it |

These are IdP-enforced. The Initiator does not define constraints —
the admin does, in the IdP policy console.

### 3.4 Fallback for Non-Enterprise Use

For personal or development use without an IdP, implementations MAY
support `Ed25519` signed envelopes as a fallback:

- Initiator signs the envelope hash with its Ed25519 private key.
- Receiver verifies using Initiator's public key from a local trust
  store or prior key exchange.

This is NOT RECOMMENDED for production cross-boundary handoffs.

---

## 4. Handoff Envelope

The envelope is a thin wrapper. It carries routing metadata, the JWT,
and the payload.

```
HandoffEnvelope {
  // Routing
  handoff_id:         string      REQUIRED  Globally unique
  protocol_version:   string      REQUIRED  "0.2.0"
  timestamp:          datetime    REQUIRED  ISO 8601 UTC
  thread_id:          string      OPTIONAL  Groups related handoffs
  parent_handoff_id:  string      OPTIONAL  Previous handoff in thread

  // Peers
  initiator:          PeerIdentity  REQUIRED
  receiver:           PeerIdentity  REQUIRED

  // Payload
  artifacts:          Artifact[]    OPTIONAL
  memory:             MemorySlice   OPTIONAL

  // Human context
  message:            string      OPTIONAL  Why this handoff is happening
}
```

At least one of `artifacts` or `memory` MUST be present.

### 4.1 PeerIdentity

```
PeerIdentity {
  peer_id:            string      REQUIRED  Stable across sessions
  name:               string      OPTIONAL  Human-readable
  framework:          string      OPTIONAL  "openclaw", "claude-code", etc.
  endpoint:           string      OPTIONAL  AHP endpoint URI
}
```

---

## 5. Artifacts

```
Artifact {
  artifact_id:        string      REQUIRED  Globally unique
  type:               string      REQUIRED  MIME type or AHP type
  title:              string      OPTIONAL
  content:            string      REQUIRED
  encoding:           string      REQUIRED  "utf-8", "base64"
  version:            string      REQUIRED  SHA-256 of content
  parent_version:     string      OPTIONAL  Previous version hash
  metadata:           map         OPTIONAL
}
```

Standard types: `ahp/task-brief`, `ahp/code-patch`, `ahp/document`,
`ahp/review`, `ahp/thread-transcript`, or any MIME type.

---

## 6. Versioned Memory

This is where the spec adds value beyond "just send JSON."

### 6.1 MemorySlice

A MemorySlice is a set of versioned entries from the agent's memory
backend, packaged for handoff.

```
MemorySlice {
  slice_id:           string          REQUIRED  Globally unique
  source_peer:        string          REQUIRED  peer_id that produced this
  namespace:          string          REQUIRED  Source namespace
  agent_scope:        string          OPTIONAL  Source agent scope
  entries:            MemoryEntry[]   REQUIRED  The memory entries
  manifest_hash:      string          REQUIRED  Slice-level integrity hash
  tombstones:         Tombstone[]     OPTIONAL  Deleted entries
}
```

### 6.2 MemoryEntry

```
MemoryEntry {
  entry_id:           string      REQUIRED  Globally unique (format: {peer_id}:{id})
  category:           string      REQUIRED  preference|fact|decision|entity|procedure|context
  content:            string      REQUIRED  The memory content
  entry_version:      string      REQUIRED  SHA-256 of (entry_id + category + content)
  parent_version:     string      OPTIONAL  Previous entry_version (null if new)
  confidence:         float       OPTIONAL  0.0 to 1.0
  created_at:         datetime    REQUIRED
  updated_at:         datetime    OPTIONAL
}
```

**`entry_id`** MUST be globally unique. Implementations SHOULD use
`{peer_id}:{uuid}` format.

**`entry_version`** is the SHA-256 hash of the entry's `entry_id` +
`category` + `content`. This enables per-entry change detection.

**`parent_version`** links a modified entry to its prior version. When
a Peer modifies an imported entry, it creates a new `entry_version`
with `parent_version` pointing to the version it modified.

### 6.3 Tombstones

```
Tombstone {
  entry_id:           string      REQUIRED  The deleted entry
  entry_version:      string      REQUIRED  Last known version before deletion
  deleted_at:         datetime    REQUIRED
}
```

When a MemoryEntry is deleted at source, subsequent handoffs include
a Tombstone. Receivers MUST delete their local copy.

This enables GDPR right-to-erasure: a deletion at the enterprise
propagates to the home agent on the next handoff.

### 6.4 Manifest Hash

The `manifest_hash` is computed from the slice's entries:

```
manifest_hash = SHA-256(
  sort(entries.map(e => e.entry_id + ":" + e.entry_version)).join("\n")
)
```

This provides slice-level integrity verification from entry-level data.

### 6.5 Delta Sync

On follow-up handoffs in the same thread, the Initiator SHOULD include
only entries that changed since the last handoff.

The Receiver processes each incoming entry by `entry_id`:

| Case | Action |
|------|--------|
| New `entry_id` | Import |
| Known, same `entry_version` | Skip (no change) |
| Known, different `entry_version`, `parent_version` matches local | Clean update — apply |
| Known, different `entry_version`, `parent_version` does NOT match | Conflict (Section 6.6) |
| Tombstone | Delete local copy |

After applying changes, the Receiver recomputes its local manifest hash.

### 6.6 Conflicts

A conflict occurs when both Peers modified the same entry — both created
new `entry_version` values with the same `parent_version`.

```
ConflictDetail {
  entry_id:           string      The conflicting entry
  local_version:      string      Receiver's current entry_version
  remote_version:     string      Initiator's incoming entry_version
  common_ancestor:    string      Shared parent_version
}
```

Resolution strategies (configured by the Receiver):

| Strategy | Behavior |
|----------|----------|
| `latest_wins` | Entry with later `updated_at` wins |
| `source_priority` | Configured peer_id ordering decides |
| `keep_both` | Both retained with distinct entry_ids |
| `reject` | Handoff returns 409 with ConflictDetail |

Default: `reject`. Other strategies MUST be explicitly configured.

### 6.7 Provenance

Each handoff implicitly records provenance: the `handoff_id`,
`timestamp`, `initiator.peer_id`, and `receiver.peer_id` form the
audit trail. Implementations SHOULD maintain a local handoff log for
auditability. The protocol does not mandate provenance within the
memory entries themselves — the handoff envelope chain provides it.

---

## 7. Transport: HTTP

AHP defines a single transport binding: HTTP POST with the ID-JAG
JWT in the Authorization header.

### 7.1 Sending a Handoff

```http
POST /ahp HTTP/1.1
Host: home.example.com
Content-Type: application/ahp+json
Authorization: Bearer <ID-JAG JWT>
AHP-Protocol-Version: 0.2.0

{ ...HandoffEnvelope... }
```

### 7.2 Responses

```
HandoffResult {
  handoff_id:         string      REQUIRED  Echoed from envelope
  status:             string      REQUIRED  accepted|partial|conflict|rejected|queued
  imported_entries:   string[]    OPTIONAL  entry_ids imported
  imported_artifacts: string[]    OPTIONAL  artifact_ids imported
  conflicts:          ConflictDetail[]  OPTIONAL
  message:            string      OPTIONAL
}
```

| HTTP Status | AHP Status | Meaning |
|-------------|-----------|---------|
| 200 | `accepted` or `partial` | Processed synchronously |
| 202 | `queued` | Accepted for async processing |
| 400 | — | Malformed envelope |
| 401 | — | JWT missing or invalid signature |
| 403 | `rejected` | JWT valid but policy/scope denies handoff |
| 409 | `conflict` | Version conflicts, body contains ConflictDetail |
| 413 | — | Payload too large |
| 429 | — | Rate limited |

### 7.3 Discovery

Peers MAY advertise their endpoint via well-known URI:

```
GET /.well-known/ahp.json

{
  "ahp_version": "0.2.0",
  "endpoint": "/ahp",
  "peer_id": "home-agent-001",
  "categories": ["preference", "fact", "decision", "context"]
}
```

### 7.4 Store-and-Forward

For async delivery when the Receiver is offline, a **Relay Node** MAY
accept envelopes on behalf of Receivers. Relay Nodes:

- MUST NOT inspect envelope payload
- MAY validate the JWT signature and audience for routing
- MUST forward the envelope intact
- MUST discard undelivered envelopes after a configurable TTL
  (default: 72 hours)

Receivers MUST be idempotent: redelivery of the same `handoff_id`
MUST NOT cause duplicate imports.

### 7.5 Other Transports

Implementations MAY define additional transport bindings (stdio, file
system, MQTT, etc.). Custom transports MUST preserve envelope format
and delivery semantics. The HTTP binding defined above is the REQUIRED
baseline.

---

## 8. Lifecycle

```
Initiator                                    Receiver
    │                                            │
    │  1. memory_search (local)                  │
    │  2. Filter entries by JWT scopes           │
    │  3. Stamp entry_versions                   │
    │  4. Compute manifest_hash                  │
    │  5. Build HandoffEnvelope                  │
    │                                            │
    │  POST /ahp  [JWT + Envelope]               │
    │ ──────────────────────────────────────────► │
    │                                            │  6. Validate JWT (sig, aud, exp, jti)
    │                                            │  7. Check JWT scopes vs envelope categories
    │                                            │  8. Apply ahp constraint claims
    │                                            │  9. Delta sync entries (Section 6.5)
    │                                            │ 10. Import artifacts
    │                                            │ 11. Re-embed imported memories
    │  HandoffResult                             │
    │ ◄──────────────────────────────────────────│
    │                                            │
```

---

## 9. Example

Enterprise agent hands off a task with two memory entries. The IdP
granted `ahp:handoff ahp:artifacts ahp:memory:decision ahp:memory:preference`
and set `max_ttl_seconds: 604800`.

```json
{
  "handoff_id": "h_20260325_a1b2c3",
  "protocol_version": "0.2.0",
  "timestamp": "2026-03-25T17:00:00Z",
  "thread_id": "thread_projectx",
  "initiator": {
    "peer_id": "enterprise-agent-001",
    "name": "Work Assistant",
    "framework": "openclaw"
  },
  "receiver": {
    "peer_id": "home-agent-001",
    "name": "Home Assistant",
    "framework": "openclaw"
  },
  "artifacts": [
    {
      "artifact_id": "art_001",
      "type": "ahp/task-brief",
      "title": "Continue API review for Project X",
      "content": "Review the auth middleware changes in PR #427...",
      "encoding": "utf-8",
      "version": "sha256:a1b2c3d4..."
    }
  ],
  "memory": {
    "slice_id": "ms_001",
    "source_peer": "enterprise-agent-001",
    "namespace": "acme-corp",
    "agent_scope": "project-x",
    "entries": [
      {
        "entry_id": "enterprise-agent-001:mem_001",
        "category": "decision",
        "content": "Team decided to remove ORM in auth service — use raw SQL for performance",
        "entry_version": "sha256:1a2b3c...",
        "confidence": 0.95,
        "created_at": "2026-03-20T14:00:00Z"
      },
      {
        "entry_id": "enterprise-agent-001:mem_002",
        "category": "preference",
        "content": "User prefers small PRs under 200 lines. Split large changes.",
        "entry_version": "sha256:4d5e6f...",
        "confidence": 0.90,
        "created_at": "2026-03-18T09:00:00Z"
      }
    ],
    "manifest_hash": "sha256:f7e8d9...",
    "tombstones": []
  },
  "message": "Continuing the PR #427 review at home. Legal review still pending."
}
```

**HTTP request:**

```http
POST /ahp HTTP/1.1
Host: home.example.com
Content-Type: application/ahp+json
Authorization: Bearer eyJhbGciOiJSUzI1NiIs...
AHP-Protocol-Version: 0.2.0
```

**Response:**

```json
{
  "handoff_id": "h_20260325_a1b2c3",
  "status": "accepted",
  "imported_entries": [
    "enterprise-agent-001:mem_001",
    "enterprise-agent-001:mem_002"
  ],
  "imported_artifacts": ["art_001"],
  "message": "Imported. TTL constraint noted: 7 days."
}
```

---

## 10. Security Considerations

| Threat | Mitigation |
|--------|-----------|
| Unauthorized handoff | ID-JAG JWT — IdP controls who can hand off to whom |
| Memory exfiltration | JWT scopes control which categories cross. No scope = not included. |
| Replay | `jti` claim uniqueness + `exp` short-lived + Receiver idempotency on `handoff_id` |
| Tampering | JWT signature covers the auth chain; manifest hash covers memory integrity |
| Relay snooping | Relay validates JWT only (sig + aud). Implementations SHOULD encrypt memory content end-to-end for relay scenarios. |
| Stale memory | `max_ttl_seconds` in JWT `ahp` claim. Receiver MUST delete on expiry. |
| GDPR erasure | Tombstones propagate deletion across the boundary |
| Man-in-the-middle | TLS 1.3+ REQUIRED for non-local HTTP transport |

---

## 11. OpenClaw Integration

The AHP plugin for OpenClaw (>= 2026.3.0) uses:

- **`memory_search` / `memory_get`** — backend-agnostic memory retrieval.
  Works with `memory-core` (SQLite/Markdown) or `openclaw-redis-agent-memory`
  (Redis vector search). This is the data source, NOT
  `registerMemoryPromptSection` (which is the prompt-injection surface,
  truncated for context window).
- **`api.registerCommand(...)`** — registers `/handoff` as a chat command.
- **`api.on("before_prompt_build", ...)`** — injects incoming handoff
  memory into the agent's prompt via `{ prependContext }`.
- **`api.registerService(...)`** — background HTTP listener or file
  watcher for incoming handoffs.
- **Plugin SDK** — `openclaw/plugin-sdk/*` public surface (v2026.3.22+).

---

## 12. References

- [RFC 2119](https://datatracker.ietf.org/doc/html/rfc2119) — Key words
- [RFC 8693](https://datatracker.ietf.org/doc/html/rfc8693) — OAuth 2.0 Token Exchange
- [RFC 7523](https://datatracker.ietf.org/doc/html/rfc7523) — JWT Bearer Grant
- [ID-JAG](https://datatracker.ietf.org/doc/draft-ietf-oauth-identity-assertion-authz-grant/) — Identity Assertion JWT Authorization Grant
- [MCP SEP-990](https://github.com/modelcontextprotocol/modelcontextprotocol/issues/990) — Enterprise IdP Policy Controls for MCP
- [MCP Specification](https://modelcontextprotocol.io/specification/2025-06-18) — Model Context Protocol
- [Ed25519](https://ed25519.cr.yp.to/) — Signatures (fallback auth)
- [RFC 8446](https://datatracker.ietf.org/doc/html/rfc8446) — TLS 1.3

---

*Draft v0.2.0. Comments welcome.*
