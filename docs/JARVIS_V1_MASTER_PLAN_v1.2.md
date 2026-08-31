# JARVIS V1 MASTER PLAN

**Version:** 1.2 - general OS; V1 seeds only Improvement and Maintenance  
**Date:** 2026-08-31  
**Status:** Current V1 implementation baseline (supersedes 1.1 for product/seed scope); later architectural changes require a versioned decision record  
**Supersedes:** 1.1 (historical). ADR 012.  
**Primary implementation audience:** Cursor, Codex, Claude Code, Vlad, or another senior implementation agent  
**Canonical format:** Markdown committed to the Jarvis Core repository

---

## 0. Purpose of this document

## 0.1 Version 1.2 decisions incorporated

- V1 boots with **only two Jarvis projects**: Jarvis Improvement and Jarvis Maintenance, plus their default schedules. No application, customer, or employer project is pre-created.
- `jarvis-core` and `jarvis-control-center` are the git repositories that implement the OS. They are not seeded as managed work projects; the operator may register them later through chat.
- The first operator loop is Control Center (or WhatsApp) chat with the **global Supervisor**: paste documentation, then ask Jarvis to create projects. Classification (personal vs professional, confidentiality, model accounts, GitHub) happens at project-create time.
- Jarvis must not be fingerprinted for any specific customer project. Professional isolation rules are generic.
- Personal GitHub account administration is a system capability used to create private repositories; each project receives access only to its own repository.
- Personal and professional GitHub connections are completely separated. A professional project never uses the personal GitHub credential.
- Every personal application is its own Jarvis project rather than being grouped into one generic Personal project.
- Jarvis uses a dedicated WhatsApp number/account.
- Provider authentication is scoped by provider account/auth profile as well as by provider. A provider may have several subscriptions with different owners and project allowlists.
- A project-owned subscription (when the operator adds one) is restricted to that project's task agents and is never used by the global Supervisor or another project.
- User-owned Cursor, Codex, and personal Anthropic subscriptions are separate profiles with broader user-approved eligibility.
- Professional-project onboarding must explicitly define model accounts, confidentiality policy, production status, and whether metered API spending is allowed.
- Locally stored raw WhatsApp voice notes and phone audio are retained for seven days by default; transcripts and extracted knowledge follow normal retention rules.
- Proactive outbound calls are prohibited from 7:30 PM through 8:00 AM America/New_York. Weekend calls are allowed outside quiet hours.

This document is the source of truth for Jarvis V1. It consolidates the user's stated requirements and resolves the major architectural gaps required to build a reliable, persistent, project-aware personal AI system.

Jarvis V1 is not a demo chatbot. It is intended to be an always-on personal operating system that:

1. Communicates naturally through WhatsApp, phone, and a professional web control center.
2. Acts as a senior autonomous software engineer.
3. Stores and organizes information durably.
4. Runs scheduled and long-running work.
5. Keeps projects, tools, secrets, and memory isolated.
6. Recovers from failed models, tools, workers, and providers.
7. Surfaces every actionable problem through a durable issue system.
8. Maintains and improves itself under user-governed rules.
9. Remains portable to another VPS or a future local GPU machine.

The system is successful only if it is dependable enough that the user can give Jarvis work, leave it alone, and trust that the input will not be lost and that the task will either complete, recover, or clearly request assistance.

---

# PART I - LOCKED PRODUCT DECISIONS

## 1. Product identity

Jarvis is a persistent personal AI operating system with two equally important responsibilities:

- Personal executive assistant, researcher, organizer, communicator, scheduler, and operator.
- Senior autonomous software engineer capable of investigation, reproduction, implementation, testing, review, QA, pull-request creation, and controlled deployment.

Jarvis is not one LLM. Jarvis identity, memory, permissions, conversations, projects, task state, and personality live outside any particular model.

Models, model providers, coding harnesses, voice services, telephony services, and hosting providers are replaceable components.

## 2. V1 infrastructure

### 2.1 Hosting

Use Netcup on month-to-month billing.

Preferred target at purchase time:

- Netcup RS 2000 G12
- Manassas, Virginia, if available
- Approximately 8 dedicated CPU cores
- 16 GB RAM
- 512 GB NVMe
- Approximately EUR 28.94/month with the one-month option and Manassas location, subject to current availability and pricing

If the preferred server is unavailable, use the closest month-to-month Netcup server with at least:

- 8 shared vCPU or 6-8 dedicated cores
- 16 GB RAM
- 250 GB NVMe minimum
- Expandable storage

Do not use a long-term reservation for V1.

### 2.2 Frontend hosting

- Next.js/React frontend deployed on Netlify.
- Netlify is presentation and preview hosting only.
- Netlify must not contain authoritative Jarvis state or secrets.
- The frontend is its own first-class system project and repository: `jarvis-control-center`.

### 2.3 Backend hosting

The Netcup server hosts:

- OpenClaw Gateway and runtime
- Jarvis API and policy layer
- PostgreSQL
- Docker workers
- Browser workers
- Coding harness CLIs
- Git worktrees
- Local embeddings
- File and artifact storage
- Health monitoring
- Backup tooling
- Reverse proxy and TLS

### 2.4 Supabase

Supabase is explicitly excluded from V1.

The system does not need hosted multi-user authentication, hosted database, or Supabase realtime. Keeping authoritative state on the Netcup machine improves portability and reduces dependencies.

## 3. Agent operating system

Use OpenClaw as the Jarvis operating-system foundation.

OpenClaw should own or provide the native basis for:

- WhatsApp connectivity
- Agent sessions
- Background executions
- Automations and schedules
- Provider authentication profiles
- Low-level model failover
- Voice-call integration
- External coding-harness sessions
- Sandboxed execution
- Browser tooling
- Core runtime health

Jarvis-specific services sit above or beside OpenClaw and add:

- Projects as security and product boundaries
- Durable universal Inbox Events
- Conversations and task relationships
- Product-level queue and lifecycle rules
- Issue and action-request management
- Project-scoped connection broker
- User authorization and task grants
- Configuration versioning
- Model benchmarking and eligibility policy
- Long-term audit and artifact history
- Professional Control Center UI
- Jarvis Improvement and Maintenance projects

Do not create duplicate task schedulers, model fallback engines, or secret systems when OpenClaw already provides the needed behavior. Extend native capabilities only where the product requirements are not met.

## 4. Coding harnesses

Coding harnesses are replaceable workers under Jarvis/OpenClaw.

Initial candidates:

- Codex through the existing ChatGPT subscription, where supported
- Claude Code through the existing Claude subscription
- Cursor Agent through ACP
- OpenCode
- OpenHands only if later tests show a useful specialized advantage

Jarvis benchmarks harness/model combinations on real tasks and may choose different combinations by project or task type.

No single coding harness is allowed to become the sole owner of Jarvis state.

---

# PART II - SYSTEM PROJECTS

## 5. Required V1 system projects

Jarvis **software** is implemented as Core, Control Center, and an Integrations package. Jarvis **projects** in the registry are different: at first boot, seed **only** Improvement and Maintenance (ADR 012). The operator creates every other project through chat or the UI, including optionally registering Core or Control Center as managed engineering projects later.

Jarvis itself is divided into privileged system code and project kinds as follows.

### 5.1 Jarvis Core

Repository: `jarvis-core`

Owns:

- Jarvis API and policy layer
- Durable Inbox
- Project registry
- Conversation/task/issue model
- Queue orchestration
- Connection broker
- Approval/task-grant logic
- Configuration versioning
- Artifact registry
- Audit events
- OpenClaw integration
- System migrations and deployment configuration

### 5.2 Jarvis Control Center

Repository: `jarvis-control-center`

Owns:

- Netlify-hosted frontend
- Command Center
- Projects
- Work and queue views
- Conversations
- Operations and Issues
- Connections
- Schedules
- Models
- Improvement and Maintenance views
- Artifacts and approvals

It receives no master provider secrets and no OpenClaw administrator token.

### 5.3 Jarvis Integrations

Repository: `jarvis-integrations`, or initially a clearly isolated package within Jarvis Core if reducing repository count simplifies V1.

Owns:

- Custom MCP servers
- API adapters
- Composio adapters
- Connection manifests
- Permission schemas
- Integration tests

### 5.4 Jarvis Improvement

**Seeded at first boot.** A privileged system project that runs at least weekly and researches:

- New LLMs
- New free tiers
- Provider changes
- New MCP servers
- GitHub skills and tools
- OpenClaw releases
- Coding harnesses
- Browser and scraping tools
- Memory/RAG systems
- Voice and telephony improvements
- Reliability and security improvements

It may sandbox, inspect, prototype, and benchmark candidates. It may not silently activate a new provider, paid plan, untrusted repository, or weakened security policy.

### 5.5 Jarvis Maintenance

**Seeded at first boot.** A privileged system project that monitors and repairs:

- Server resources
- Database
- Queue
- workers
- browsers
- coding harnesses
- schedules
- backups
- provider health
- credentials
- MCP servers
- disk growth
- stale worktrees
- orphaned containers
- security/isolation checks
- configuration drift

It can perform safe, reversible recovery automatically. Destructive, billing-related, production-impacting, or security-policy changes require user approval.

---

# PART III - AUTHORITATIVE DATA AND SERVICE OWNERSHIP

## 6. Source-of-truth boundaries

### 6.1 OpenClaw owns

- Live agent session runtime
- Channel sessions such as WhatsApp
- Native scheduled-automation execution
- Low-level provider auth profiles
- Low-level model fallback behavior
- Runtime coding-agent sessions
- Native background execution records
- Voice-call runtime

### 6.2 PostgreSQL owns

The long-term Jarvis product state:

- Users and authenticated sessions
- Projects
- Raw Inbox Events
- Conversations and messages
- Tasks and task dependencies
- Product queue
- Issues and action requests
- Approvals and task grants
- Connection metadata and access policies
- Schedules mirrored from OpenClaw
- Artifacts and reviews
- Configuration versions
- Model registry and benchmark history
- Notifications and delivery outbox
- Long-term audit history
- Health incidents

Every OpenClaw session, task, or automation used by Jarvis is linked to the corresponding PostgreSQL entity through stable external IDs.

OpenClaw's runtime history is not sufficient as the only long-term history. Jarvis must retain its own permanent product/audit records.

### 6.3 Queue implementation

Use PostgreSQL as the durable V1 task queue.

Recommended mechanics:

- Row-level leases
- Heartbeats
- `FOR UPDATE SKIP LOCKED`
- Advisory locks where useful
- Task attempt records
- Transactional outbox
- Dead-letter state represented as an Issue

Do not introduce Valkey/Redis in the initial architecture unless implementation testing demonstrates a real need. This reduces operational complexity and removes another service that can fail.

Valkey may be added later for high-frequency ephemeral coordination or caching, but it must not become the only durable record of work.

### 6.4 Files and artifacts

Store hot files on persistent Netcup storage behind a storage abstraction.

Every stored file has:

- Stable artifact/attachment ID
- Project scope
- SHA-256 checksum
- MIME type
- Size
- Creation source
- Quarantine/scanning state where applicable
- Retention class

Use encrypted off-server backup storage for disaster recovery.

---

# PART IV - PROJECTS, CONNECTIONS, AND SECRETS

## 7. Project isolation

Every normal project is a technical security boundary.

Each project has its own:

- Repositories
- Workspaces/worktrees
- Memory
- Knowledge
- Conversations
- Tasks
- Attachments
- Browser profiles
- Connections
- Connection permissions
- Project instructions
- Schedules
- Provider/model eligibility
- Deployment environments

A normal project worker cannot access another project's secret or connection merely by naming it or guessing a path.

Enforce isolation with:

- Sandboxed Docker execution
- Project-specific mounts
- Scoped credential injection or brokered tools
- Project-specific browser profiles
- Explicit network/tool policy
- No host filesystem access by default

OpenClaw workspaces alone are not treated as a hard security boundary. Sandboxing is mandatory for project workers.

### 7.1 Project classification and risk posture

Every application, repository, operational domain, or sustained body of work should be represented as its own project. Do not place unrelated personal applications into one catch-all Personal project.

Every non-system project declares at least:

- `project_type`: `personal` or `professional`
- `production_status`: `non_production`, `staging`, or `production`
- `customer_facing`: yes/no
- `confidentiality`: normal, confidential, or restricted
- repository owner/account and exact repository
- approved connection scopes
- approved model-auth profiles
- default queue priority
- engineering and deployment gates

Personal projects remain fully isolated and carefully handled, but default to normal queue priority and non-customer-facing assumptions unless configured otherwise.

Professional projects default to:

- Higher queue priority than ordinary personal work
- Strict model/provider account allowlists
- Stronger review, testing, audit, and deployment gates
- No use of personal GitHub or unrelated project connections
- No consumer/free endpoint whose data terms are incompatible with the project
- Explicit production and paid-usage policy during onboarding

No customer or employer project is pre-classified. When the operator creates a professional project, onboarding records production status, customer-facing, confidentiality, GitHub, and auth profiles. Production deploy via natural-language grant defaults to off (`nl_grant_may_deploy_production=false`) until the operator enables it on that project.

## 8. Connection scope model

All connections must declare one of four resource scopes and one explicit credential/auth-profile identity.

### 8.1 System connection

Available only through controlled system capabilities.

Examples:

- Personal GitHub account credential used by the broker to create private repositories
- Netlify account administration
- OpenAI/ChatGPT provider authentication
- User-owned Anthropic provider authentication
- Additional Anthropic (or other) provider authentications added later as project or shared profiles, never assumed at boot
- NVIDIA
- Groq
- Google AI
- ElevenLabs
- Telnyx
- Dedicated Jarvis WhatsApp runtime
- Offsite backup storage

A system connection is not automatically exposed to every project worker.

### 8.2 Shared connection

Usable by an explicit allowlist of projects or, only when deliberately configured, by all projects.

Examples:

- User-owned Codex subscription profile
- User-owned Cursor subscription profile
- User-owned Anthropic subscription profile
- A global research API whose privacy policy is approved
- A reusable MCP server

The raw secret remains in the credential broker. Projects receive approved capabilities, not unrestricted plaintext credentials.

### 8.3 Project connection

Usable only by one project.

Examples:

- A professional project's GitHub organization connection and exact repository allowlist
- A project-owned Anthropic/Claude (or other) subscription profile
- That project's production/staging services
- A personal project's repository-specific SSH deploy key
- A supplier API used by one project
- Project-specific Slack workspace
- Project-specific database

### 8.4 Task-ephemeral connection

Temporary authentication or browser state for one task or action.

Examples:

- One-time secure browser login
- Short-lived installation token
- Temporary signed upload
- Human-assisted login session

Ephemeral credentials expire automatically.

### 8.5 Provider account and auth-profile scope

A provider can have several distinct credentials, subscriptions, or accounts. Jarvis must never treat `provider = Anthropic` or `provider = GitHub` as sufficient authorization by itself.

Every provider auth profile stores:

- Provider
- Profile ID
- Human-readable owner
- Billing owner
- Authentication type
- Allowed projects
- Allowed agent roles
- Confidentiality eligibility
- Metered-spend policy
- Quota/plan information
- Expiration and health

Initial required profiles at boot (no customer-named profiles):

- `anthropic_personal`: user-owned Pro subscription; eligible for the Supervisor, Improvement, Maintenance, personal projects, and other professional projects only when explicitly approved
- `openai_codex_personal`: user-owned subscription; eligible for personal and explicitly approved professional projects
- `cursor_personal`: user-owned subscription; eligible for personal and explicitly approved professional projects
- `github_personal_admin`: system-only personal GitHub account capability used to create private repositories and bootstrap project-scoped access
- Project-specific GitHub profiles/keys and any project-owned model subscriptions are created at project onboarding, not at boot

A model route therefore resolves to both a model and an eligible auth profile. Jarvis must not substitute a different account merely because it belongs to the same provider.

## 9. Credential broker

Jarvis workers should normally invoke typed capabilities instead of receiving master credentials.

Examples:

- `github.create_repository`
- `github.create_branch`
- `github.open_pull_request`
- `github.merge_pull_request`
- `netlify.create_site`
- `netlify.create_deploy`
- `netlify.promote_deploy`
- `connection.test`

The broker:

1. Identifies the project and task.
2. Checks project classification and risk policy.
3. Resolves the exact connection and provider auth profile, not only the provider name.
4. Checks connection scope, project allowlist, role allowlist, confidentiality, and spending policy.
5. Checks the task grant or approval.
6. Obtains or generates the narrowest practical token/key/session.
7. Performs or proxies the requested action.
8. Redacts secrets.
9. Records an audit event.

Master GitHub, Netlify, provider, and backup credentials must not be injected into arbitrary coding/browser containers. A project worker never receives another project's repository key or subscription profile.

## 10. GitHub architecture

GitHub has two deliberately separate layers.

### 10.1 Personal GitHub system capability

Jarvis has a system-level credential for the user's personal GitHub account whose principal V1 purpose is to:

- Create new private repositories
- Initialize repositories and default settings
- Attach the repository to the project that requested it
- Bootstrap a repository-specific credential for that project

The account-level credential is held only by the credential broker. It is not mounted into project workers and is not a general shared repository credential.

All new repositories default to **private**.

### 10.2 Repository-specific personal project access

Every personal software project is a separate Jarvis project and receives access only to its exact repository.

Preferred V1 implementation:

- Generate a distinct write-enabled SSH deploy key or equivalently narrow repository-scoped credential for each repository.
- Store the private key in that project's secret namespace.
- Mount/inject it only into that project's engineering worker.
- Record the repository ID, owner, default branch, and credential ID in project configuration.

Do not use one machine-wide personal SSH private key inside all project workers. A host-level bootstrap process may provision deploy keys, but ordinary project containers must remain repository-scoped.

Each project may:

- Clone/fetch its repository
- Create branches/worktrees
- Push commits
- Open and update pull requests
- Review checks and actions
- Merge and deploy when the user's natural-language task grant or project policy authorizes it

### 10.3 Professional GitHub separation

Professional projects never use the personal GitHub system credential or another project's repository key.

Each professional project receives its own account/organization and repository connections during onboarding. Those credentials are never made available to personal projects or to other projects except through narrowly defined administrative health checks that do not expose the secret.

### 10.4 High-risk GitHub actions

Repository deletion, visibility change to public, transfer, archive of an active repository, branch-protection weakening, organization-wide permission changes, or installing an app across additional repositories always require point-of-action confirmation.

The phrase "GitHub access" never means every worker receives unrestricted account access. It means the Jarvis control plane can perform an authorized account-level operation and then issue repository-specific capabilities to the correct project.

## 11. Netlify architecture

Netlify is a system-level connection because Jarvis may create and manage multiple sites. It is available to projects only through typed brokered capabilities and each project's explicit site/deployment configuration.

Requirements:

- Store the Netlify credential only in the credential broker.
- Connect Netlify to GitHub using the Netlify GitHub App where appropriate.
- Each deployable project stores:
  - Netlify site/project ID
  - linked GitHub repository
  - production branch
  - preview-deploy policy
  - domain information
  - build command
  - output directory
  - environment-variable references
  - deployment approval policy

Project workers use typed deploy capabilities and do not see the Netlify master token.

Jarvis Control Center itself is a separate project with:

- Private GitHub repository
- Netlify site
- Preview deployments for PRs
- Production deployment policy

## 12. Human connection flow

When Jarvis needs user action, it creates a durable Issue and a `UserActionRequest`.

Jarvis sends a concise WhatsApp deep link to an authenticated, expiring page in the Control Center.

The page shows:

- What is required
- Why it is required
- Project or system scope
- Requested permissions/scopes
- Provider/integration
- Privacy implications
- Cost implications
- API key, OAuth, Composio, MCP, or secure-browser action

Secrets submit directly to Netcup over HTTPS.

Netlify does not store them. They are encrypted at rest and never shown again in full.

After completion, Jarvis tests the connection, updates health, closes or updates the Issue, and resumes blocked work.

---

# PART V - AUTHORIZATION AND PRODUCTION SAFETY

## 13. Authorization levels

### 13.1 Baseline autonomous actions

Jarvis can do these under project policy without asking every time:

- Read files and repositories
- Research
- Create isolated worktrees/branches
- Write code
- Run tests
- Run dev/staging environments
- Perform browser QA
- Create commits
- Open PRs
- Create drafts and artifacts
- Run approved schedules

### 13.2 Natural-language task grants

A clear authenticated user command may pre-authorize named actions for the current task.

Example:

> "Fix this, create the PR, merge it, and deploy it."

This creates a scoped task grant for:

- The named/inferred project
- The specific task
- The expected repository
- The resulting approved branch/commit
- The named environment
- A limited expiration period

Jarvis should not ask for a redundant merge/deploy approval if:

- The user's instruction was clear.
- The task remained within scope.
- Required tests and policies passed.
- The revision being deployed is the one produced under the grant.
- No new high-risk condition appeared.

The task grant becomes invalid if:

- Project or environment is ambiguous.
- Scope materially expands.
- A new destructive database migration appears.
- Security controls must be weakened.
- Paid billing must be enabled.
- Secrets or permissions change materially.
- The branch/commit changes after validation.
- The task is resumed after the grant expires.

### 13.3 Always-confirm actions

The following always require point-of-action confirmation, even if Jarvis has broad technical access:

- Delete repository or project
- Make a private repository public
- Transfer repository ownership
- Destructive production database operation
- Disable authentication, audit, backups, or project isolation
- Reveal/export plaintext secrets
- Enable paid usage or increase a spending ceiling
- Delete large bodies of user data or artifacts outside an approved retention policy
- Give Jarvis or a project materially broader permanent authority

### 13.4 Approval binding

Approvals and task grants must be bound to:

- Action type
- Project
- Target
- Environment
- Commit SHA or resource version
- Expiration
- Requesting task

An approval for SHA A cannot authorize SHA B.

---

# PART VI - INPUT, CONVERSATIONS, AND COMMUNICATION

## 14. Durable Inbox

Every incoming item is persisted before model processing.

Sources include:

- WhatsApp text
- WhatsApp voice note
- WhatsApp image/file/link/forward
- Phone call and transcript
- Web UI submission
- File upload
- Schedule
- Webhook
- System event
- Connection callback

Every event includes:

- Internal ID
- External event ID where available
- Channel/source
- Timestamp
- Raw content or attachment reference
- Checksum
- Deduplication key
- Capture state
- Processing state

Duplicate webhooks or channel deliveries must not create duplicate logical work.

## 15. Conversation and task creation

Jarvis distinguishes:

- Inbox Event: immutable original input
- Conversation: contextual thread
- Task: executable work
- Artifact: output
- Issue: problem or required intervention

Jarvis may:

- Attach an input to an existing conversation
- Create a new conversation
- Split one audio/message into several project conversations/tasks
- Store information as memory without creating work
- Create scheduled work or reminders

The original event remains linked to every derived object.

Use a brief correlation window and semantic analysis so rapid follow-up messages can be grouped without losing the ability to split unrelated topics.

Unscoped Control Center or WhatsApp chat with no project selected attaches to the **global Supervisor conversation**. That is the V1 first-run surface: the operator pastes documentation, asks questions, and instructs Jarvis to create projects. Global chat must not require a pre-existing application project.

## 16. WhatsApp role

WhatsApp is the primary one-on-one conversational channel. V1 uses a dedicated Jarvis WhatsApp number/account, separate from the user's everyday WhatsApp identity.

The dedicated identity should be allowlisted so only the user and explicitly approved contacts can issue commands.

Support:

- Text
- Voice notes
- Images
- Files
- Links
- Forwarded information
- Proactive updates from Jarvis

WhatsApp calling is excluded from V1.

## 17. WhatsApp notification policy

WhatsApp communication should be short and useful.

### 17.1 Trivial capture actions

Examples:

- Store this document
- Transcribe and remember this audio
- Save this note

Default behavior:

- Persist/process silently.
- No completion message unless there is an error, ambiguity, or requested confirmation.
- The action remains visible in the Control Center.

### 17.2 Short executable work

Default behavior:

- Optional one-line acknowledgment if queued or if completion is not immediate.
- Concise completion message only when the result is meaningful.

### 17.3 Long or important work

Default behavior:

1. One short acknowledgment including the task/project.
2. No routine chatter while work is healthy.
3. One useful progress update only for a meaningful milestone or unusually long task.
4. Immediate concise alert if blocked or requiring user action.
5. Short completion message with outcome and direct link.

Example:

> Alpha fix is complete. PR #18 is open, tests and independent review passed, and nothing was deployed. [Open task]

### 17.4 Weekly reports

Jarvis Improvement, Maintenance, and weekly project summaries may be longer and structured.

### 17.5 Notification reliability

All outbound notifications use a transactional outbox.

The outbox records:

- Intended channel
- Message type
- Related object
- Delivery attempts
- Idempotency key
- Delivered/failed state

A failed WhatsApp notification must not mark the underlying task or issue as complete-delivered.

## 18. Phone calls

Use Telnyx with OpenClaw's voice-call integration and ElevenLabs TTS.

V1 supports:

- User calls Jarvis on a dedicated phone number.
- Jarvis calls the user when authorized by notification policy or schedule.
- Multi-turn conversation.
- Streaming transcription.
- Conversation transcript storage.
- Resulting instructions enter the durable Inbox and queue.

Sensitive approval must not rely solely on caller ID.

### 18.1 Proactive outbound calling policy

- Proactive outbound calls are permitted every day, including Saturday and Sunday, from 8:00 AM through 7:29 PM America/New_York.
- Quiet hours are 7:30 PM through 8:00 AM America/New_York.
- Jarvis must not place proactive outbound calls during quiet hours.
- Critical incidents during quiet hours use WhatsApp and Control Center notifications rather than an outbound call.
- User-initiated inbound calls may be accepted at any time.
- The user may change or temporarily override this policy through an explicit instruction.

### 18.2 Raw audio retention

- Jarvis stores its local copy of raw WhatsApp voice notes and phone-call audio for seven days by default.
- A daily retention job permanently deletes raw audio after seven days unless the user explicitly marks that item permanent.
- The local automatic-retention window must never exceed ten days without an explicit preservation instruction.
- Transcripts, metadata, task provenance, and extracted knowledge follow the normal conversation/project retention policy and may remain indefinitely.
- The external WhatsApp chat is not treated as Jarvis's backup or authoritative storage.
- The UI must show the scheduled raw-audio deletion date and provide a `Keep permanently` control.

## 19. Voice

Use ElevenLabs for the permanent signature voice because the user already has a subscription.

Requirements:

- Refined British male voice
- Calm, intelligent, elegant, restrained
- Stable voice ID
- Low-latency model suitable for conversation
- Voice-provider authentication stored at provider level
- Monthly usage monitored
- Automatic paid top-ups disabled or capped unless explicitly authorized

No local Chatterbox/Kokoro deployment in V1.

---

# PART VII - TASK QUEUE, EXECUTION, AND RECOVERY

## 20. Execution lanes

### 20.1 Supervisor lane

Always available for:

- User conversation
- Durable capture acknowledgment
- Routing
- Queue management
- Lightweight questions
- Approvals
- Issues
- Provider/model management

### 20.2 Heavy worker lane

Default V1 heavy concurrency: **1**.

Handles:

- Coding
- Long research
- Browser automation
- Scraping
- Large document processing
- Other long-running tool work

### 20.3 System worker lane

Runs independently:

- Scheduler
- Watchdog
- Notification delivery
- Transcription intake
- Health checks
- Backup
- Maintenance

## 21. Queue rules

Task priorities:

- Critical
- High
- Normal
- Low
- Background

Queue requirements:

- Durable ordering
- Fairness and starvation prevention
- Dependencies between tasks
- Per-project and global limits
- Pause/resume/cancel
- Reprioritization
- Idempotent claims
- Worker leases
- Heartbeats
- Attempt history
- Dead-letter/terminal-failure Issue

Jarvis processes work relentlessly until tasks are:

- Completed
- Waiting for user
- Waiting for approval
- Paused
- Blocked on an external dependency
- Terminally failed with a visible Issue

## 22. User feedback during execution

Every new user instruction is persisted immediately.

Jarvis determines whether it:

- Updates the current task
- Updates a queued task
- Creates a new task
- Changes project/system configuration

The UI shows where the input was routed. The user can correct routing.

## 23. Task state machine

Minimum states:

- captured
- classified
- queued
- preparing
- running
- waiting_for_tool
- waiting_for_provider
- waiting_for_user
- waiting_for_approval
- paused
- stalled
- recovering
- retry_scheduled
- succeeded
- failed_terminal
- cancelled

Every transition is persisted with timestamp, cause, actor, and related event.

## 24. Watchdog and progress detection

Workers emit:

- Heartbeats
- Structured activity events
- Checkpoints
- Child-process state
- Current phase

The watchdog distinguishes legitimate long operations from hangs using:

- Process state
- CPU/network/disk activity
- Output heartbeat
- Tool-specific timeout
- Repeated identical actions
- Lack of meaningful progress

Recovery ladder:

1. Wait within tool-specific threshold.
2. Nudge/re-prompt.
3. Retry failed operation.
4. Reset browser/tool.
5. Restart worker.
6. Restart coding-harness session.
7. Resume from checkpoint.
8. Switch approved model.
9. Switch approved coding harness.
10. Request user assistance.

Retries are bounded with exponential backoff and jitter.

## 25. Checkpointing

Long-running tasks checkpoint at meaningful boundaries and at a maximum interval.

Checkpoint content:

- Objective and constraints
- User instructions
- Project
- Conversation and Inbox references
- Plan
- Progress summary
- Branch/worktree
- Commit SHA
- Modified files
- Commands and important outputs
- Tests and QA state
- Current hypothesis
- Pending actions
- Artifacts
- Approvals/task grant
- Next intended action

A replacement worker must be able to resume without losing the user's context.

## 26. Scheduled work

Use OpenClaw automations for schedule execution and mirror schedule/run state in PostgreSQL.

Default timezone: `America/New_York`.

Every schedule defines:

- Project
- Task template
- Frequency/cron/timezone
- Priority
- Allowed connections
- Model role
- Approval policy
- Overlap policy
- Misfire policy
- Maximum catch-up runs
- Failure threshold

Overlap options:

- queue
- skip
- replace
- parallel

V1 defaults to `queue` or `skip`; parallel heavy runs are disabled by default.

A repeated schedule failure creates or updates an Issue.

---

# PART VIII - SOFTWARE ENGINEERING STANDARD

## 27. Senior-engineer workflow

For a bug or feature request, Jarvis should:

1. Preserve the original report and attachments.
2. Identify the project.
3. Load project instructions and eligible connections.
4. Create an isolated worktree/container.
5. Reproduce the issue when reasonably possible.
6. Inspect code, logs, browser, API, and permitted databases.
7. Gather evidence.
8. Determine likely root cause.
9. Write a plan.
10. Implement the smallest sound change.
11. Add or update meaningful tests.
12. Run lint, type checks, unit, integration, and browser QA as appropriate.
13. Have another model/family review the change where practical.
14. Address valid review findings.
15. Re-run verification.
16. Commit and push.
17. Create an evidence-backed PR.
18. Merge/deploy only under project policy and task grant/approval.
19. Send a concise result update.

If reproduction is impossible, Jarvis documents what it attempted, what evidence is missing, and the confidence of any proposed change.

## 28. Project engineering policy

Each repository should contain or reference an `AGENTS.md`-style project instruction file specifying:

- Architecture
- Setup commands
- Test commands
- Style/lint/type commands
- Safe environments
- Forbidden files/actions
- Deployment process
- Required checks before PR
- Required checks before deployment
- Database/migration rules
- Security/privacy constraints
- Exact repository connection
- Approved model-auth profiles
- Approved external data processors
- Production/customer impact
- Default queue priority

### 28.1 New-project onboarding

When creating or importing a project, Jarvis must establish:

1. Personal or professional classification.
2. Production/customer-facing status.
3. Confidentiality level.
4. Exact GitHub account and repository.
5. Project-specific repository credential.
6. Allowed provider auth profiles and agent roles.
7. Whether metered paid APIs are permitted.
8. Spending ceiling if metered APIs are permitted.
9. Deployment environments and approval rules.
10. Required tests, review, backups, and monitoring.

For a new professional project, Jarvis must ask the user whether paid/metered APIs are allowed and which subscription or provider accounts may process the project's data. The default is **no metered API spending** and no unapproved consumer/free endpoints.

### 28.2 Professional and confidential project policy (generic)

There is no named customer project in V1. When the operator creates a professional and/or confidential project, apply:

- Separate GitHub account/organization connection and exact repository scope; never the personal GitHub admin credential
- Any project-owned model subscription is available only to that project's task agents
- That profile is never used by the global Supervisor, Jarvis Improvement, Maintenance, or another project
- Repository contents, logs, code, and confidential attachments are never sent to a provider/auth profile not approved for that project
- No usage-based metered model API unless separately approved on that project
- Strong engineering checks, independent review where possible, and production task grants/approvals
- Higher default queue priority than ordinary personal work
- `nl_grant_may_deploy_production` defaults to false

The global Supervisor may capture and route such requests, but must minimize exposure: it may process basic routing metadata and user-visible summaries, while repository contents, logs, code, and confidential attachments remain inside that project's eligible task contexts.

## 29. Independent review policy

Prefer a different model family from the implementer.

Review covers:

- Root-cause alignment
- Correctness
- Regression risk
- Test quality
- Security
- Performance
- Architecture fit
- Scope control
- Production implications

## 30. Engineering evaluation suite

Build a private benchmark from previously solved real issues.

Score:

- Reproduction
- Root-cause accuracy
- Correctness
- Hidden tests
- Regression safety
- Test quality
- Tool reliability
- Scope control
- Code quality
- PR quality
- Unnecessary human escalation
- Cost/quota consumption

A model/harness earns the Senior Engineer role through this suite rather than vendor claims.

---

# PART IX - MODEL SYSTEM

## 31. Provider-level authentication

Credentials belong to provider auth profiles, not individual models.

Examples:

- One Groq auth profile covers the eligible Groq-hosted GPT-OSS, Qwen, and Whisper models.
- One NVIDIA auth profile covers eligible NVIDIA-hosted models.
- One Google auth profile covers eligible Gemini services.
- Anthropic (and every provider) may have several profiles: user-owned plus any project-owned subscriptions added later. They are never interchangeable.

A new model from an already authenticated provider can be discovered and benchmarked without requesting another key only when the existing auth profile is eligible for the requesting project, agent role, privacy policy, and billing policy.

Model selection therefore uses:

`role + model + provider + auth_profile + project_policy`

not merely:

`role + model + provider`

## 32. Model roles

- Supervisor
- Utility
- Senior Engineer
- Engineering Reviewer
- Research/Browser
- Vision/Document
- Speech-to-Text
- Voice/TTS
- Embeddings

## 33. Model registry

Store:

- Provider
- Model ID and pinned version where possible
- Capabilities
- Context size
- Tool/vision/structured-output support
- Cost type
- Privacy/data-policy eligibility
- Health
- Quota state
- Benchmark scores
- Approval state
- Deprecation date
- Role assignments

Do not rely on a mutable `latest` alias without testing and promotion.

## 34. Failover

OpenClaw handles low-level auth-profile and configured model fallback.

Jarvis adds:

- Project eligibility filtering
- Role benchmark ranking
- Privacy policy
- Cost ceiling
- Degradation/Issue creation
- Recommendation and promotion workflow

Automatic failover is permitted only among pre-approved eligible options.

## 35. Tentative V1 candidates

These are candidates to discover and verify at deployment, not hard-coded promises.

### Supervisor

- GPT-OSS 120B through Groq
- NVIDIA Nemotron 3 Ultra
- Gemini 3.7 Flash or current strong Gemini agent model
- Current Codex model through ChatGPT subscription
- Claude Sonnet 5 or Opus 5 through Claude subscription

### Senior Engineer / Reviewer

- Current Codex subscription model
- Claude Sonnet 5
- Claude Opus 5
- NVIDIA-hosted DeepSeek V4 Pro candidate
- NVIDIA-hosted Kimi K3 candidate
- Gemini 3.7 Flash or current coding/agent model

### Utility

- Qwen 3.8 27B through Groq
- GPT-OSS 20B through Groq
- NVIDIA Nemotron 3.5 Lightning
- Current eligible Gemini Flash-Lite-class model

### Speech-to-Text

- Whisper Large V3 Turbo through Groq
- Whisper Large V3 through Groq

### Voice

- ElevenLabs

### Embeddings

- Small local embedding model, initially an EmbeddingGemma-class GGUF model if compatibility/quality testing passes

### Credential-aware initial routing

#### Global Supervisor and Jarvis system work (Improvement, Maintenance)

May use eligible free providers and the user's personal subscription profiles according to privacy and quota policy. It must never use a project-owned subscription that was allowlisted only for another project.

#### Personal project engineering

May use the user's personal Codex, Cursor, and personal Anthropic profiles, plus approved free providers where the project's data policy permits. Every personal project still has a separate repository and connection boundary.

#### Professional project engineering

Onboarding must select approved subscription/auth profiles. The user's personal Anthropic profile may be used for orchestration or engineering if explicitly approved. Metered paid APIs remain disabled unless the project policy records user approval and a spending ceiling. If the operator attaches a project-owned subscription, that profile is task-only for that project.

## 36. Free-tier correctness

Do not label a model free merely because the provider has some free-tier offerings.

At setup and weekly thereafter, Jarvis Improvement must verify:

- Exact model availability
- Current free quota
- Rate limits
- Data usage terms
- Expiration or promotional status
- Whether billing is enabled

Professional/confidential projects exclude consumer/free endpoints whose terms permit submitted data to be used for product improvement unless the project has an explicit user-approved exception. Eligibility is evaluated per auth profile, not merely per provider.

## 37. Cost controls

- Paid API billing disabled by default.
- Provider spending ceilings stored in policy.
- Subscription-backed tools used only within the projects and roles permitted by the subscription owner/auth profile.
- Project-owned subscriptions are never consumed by another project or by the global Supervisor.
- No automatic pay-as-you-go activation.
- Quota and billing degradation creates an Issue.

---

# PART X - CONTROL CENTER UI

## 38. Product role

The Jarvis Control Center is a professional high-information operations console, not only a chat screen.

Primary navigation:

- Home / Command Center
- Projects
- Work
- Queue
- Conversations
- Operations / Issues
- Approvals
- Connections
- Schedules
- Models
- Artifacts / Knowledge
- Jarvis Improvement
- Jarvis Maintenance
- Settings / Audit

Mobile bottom navigation prioritizes:

- Home
- Work
- Conversations
- Issues
- More

## 39. Command Center

Show:

- Overall system health
- Online/degraded/incident state
- Current heavy task and phase
- Queue/blocked counts
- Approvals and user actions
- Provider/model/channel status
- CPU/RAM/disk/I/O
- Backup state
- Recent conversations
- Recent project activity
- Active schedules
- Open issues
- All projects with type, repo, current work, time, tasks, PRs, schedules, connection health, and failures/recoveries

## 40. Project view

Tabs:

- Overview
- Work
- Conversations
- Activity
- Repository
- Artifacts
- Memory/Knowledge
- Connections
- Schedules
- Issues
- Settings

## 41. Work and queue views

Show:

- Running
- Up Next
- Blocked
- Waiting for User
- Waiting for Approval
- Waiting for Provider
- Recovering
- Recently Completed

Task detail shows observable actions, not hidden chain-of-thought:

- Objective
- Phase
- Agent/model/harness
- Branch/worktree
- Tool actions
- Tests
- Review
- Artifacts
- Errors/recovery
- Active, elapsed, waiting, and paused time
- Checkpoints
- PR/deploy state
- Context input

## 42. Operations and Issues

Health covers:

- Infrastructure
- OpenClaw
- Jarvis API
- PostgreSQL
- queue
- workers
- browsers
- WhatsApp
- Telnyx
- ElevenLabs
- providers/models
- MCP/connections
- schedules
- backups
- security/isolation checks

Issues are first-class durable tickets with:

- Severity
- Category
- Project/service/task
- Status
- Owner
- Evidence
- Remediation attempts
- Required action
- Age
- Related events
- Audit trail

Issue statuses:

- Open
- Investigating
- Auto-resolving
- Waiting for Jarvis
- Waiting for User
- Waiting for Provider
- Resolved
- Ignored/Suppressed with reason

## 43. Design system

- Professional dark graphite default
- Restrained cyan/blue active accents
- Green for healthy/success
- Amber for attention
- Red for incidents/destructive actions
- Purple used sparingly for Improvement
- Dense but readable card/table hybrid
- Accessible contrast
- Keyboard navigation
- Global search and command palette
- Responsive desktop/mobile
- No decorative sci-fi clutter
- No fake progress percentages
- Stale-data indicator after live-update disconnect

Use SSE for most live updates. Use WebSockets only for truly interactive browser/terminal sessions.

## 44. Security boundary

The browser never receives:

- OpenClaw Gateway admin token
- Database credentials
- Provider master secrets
- Master encryption key
- Unrestricted MCP credentials

The Netlify frontend communicates only with the authenticated Jarvis API facade on Netcup.

---

# PART XI - ISSUES, OBSERVABILITY, AND MAINTENANCE

## 45. Error taxonomy

Explicitly classify and handle:

- Model rate limit/outage/removal
- Provider credential expiry
- OAuth expiry
- MCP crash
- Browser crash
- Coding-harness crash
- Worker crash
- Network timeout
- Duplicate webhook/channel delivery
- Git conflict
- Test failure
- Stuck process
- Queue/scheduler restart
- Disk/RAM/I/O pressure
- Database problem
- Corrupted attachment
- Malformed tool/model output
- Repeated loop
- Failed notification delivery
- Backup failure
- Isolation/security alert

Each class has:

- Severity
- Retryability
- Retry limit
- Backoff
- Recovery ladder
- User-notification rule
- Issue-deduplication key

No silent task loss.

## 46. Observability

Monitor:

- CPU, RAM, disk, I/O, network
- Disk growth forecast
- Processes/containers
- OpenClaw
- Jarvis API
- PostgreSQL
- Queue latency and age
- Worker heartbeats
- Browser health
- WhatsApp
- Telnyx
- ElevenLabs
- Provider/model health
- Schedule outcomes
- Backup and restore-test age
- Security/isolation checks

Serious conditions create Issues and concise WhatsApp alerts.

## 47. Log and telemetry policy

- Structured logs with correlation IDs for Inbox Event, Conversation, Task, Execution, and Issue.
- Secret and token redaction before persistence.
- No full user documents/audio in normal application logs.
- Adjustable retention classes.
- Audit logs append-only from the application perspective.
- Health metrics retained long enough to diagnose trends without uncontrolled disk growth.

## 48. Maintenance self-healing

Safe automatic repairs include:

- Restart disposable worker/browser
- Retry bounded external call
- Resume from checkpoint
- Rotate logs by policy
- Clean approved temporary files
- Remove orphaned disposable containers/worktrees after retention period
- Fail over to approved model
- Reconcile missed runtime state

Potentially destructive or authority-expanding changes create a user Issue.

---

# PART XII - SECURITY

## 49. Server hardening

- Ubuntu LTS or current supported Netcup Linux image
- SSH keys only
- Disable password SSH login
- Disable direct root SSH login
- Restrict SSH by VPN/Tailscale or user IP where practical
- Firewall exposes only required HTTP/HTTPS; operator/admin surfaces private
- Automatic security updates for critical packages
- Brute-force protection
- Container version pinning
- Minimal host packages
- Non-root containers where practical
- Caddy or equivalent TLS/reverse proxy

## 50. OpenClaw and browser security

OpenClaw Gateway and browser-control/admin surfaces must not be publicly exposed.

Preferred access:

- Private network/Tailscale for operator-only native admin access
- Public users interact only through the custom Jarvis API and Control Center

Browser profiles are project-scoped sensitive assets.

## 51. Secret encryption

- Envelope encryption or equivalent
- Master key stored outside normal database records
- Documented recovery method
- Encrypted offsite backups
- Secret access audited
- Secrets never returned in full after storage
- Secrets excluded from logs and model prompts unless the exact tool needs them

## 52. Egress and tool policy

Where feasible:

- Project workers get outbound access only to required services.
- System-level admin tools are unavailable in normal project sandboxes.
- New MCP servers declare permissions, network destinations, data access, and connection scope.

## 53. File safety

For uploads and downloaded files:

- Size limits
- MIME validation
- Content sniffing
- Filename normalization
- Quarantine before execution
- Malware scanning where practical
- Never execute downloaded code outside a sandbox

---

# PART XIII - BACKUP, PORTABILITY, AND UPDATES

## 54. Backup destination

Use an encrypted offsite S3-compatible destination such as Backblaze B2.

Recommended tooling:

- Restic or equivalent encrypted incremental backup
- Database-consistent snapshot/dump
- File/artifact backup
- Configuration and OpenClaw state backup

## 55. Backup policy

Recommended initial policy:

- Daily incremental backup
- Weekly retained recovery points
- Monthly longer-retention point
- Backup success health check
- Monthly automated or assisted restoration test into an isolated directory/server

Back up:

- PostgreSQL
- OpenClaw state
- Projects and configuration
- Conversations/tasks/issues
- Schedules
- Encrypted credentials
- Files/artifacts
- Memory/indexes or source data needed to rebuild them
- Model registry/benchmarks
- Voice/telephony configuration
- Deployment configuration

A backup is not considered verified until restoration has succeeded.

## 56. Export and migration

Provide documented commands/workflow equivalent to:

- `jarvis backup`
- `jarvis verify-backup`
- `jarvis export`
- `jarvis restore`

Migration target may be:

- Another Netcup server
- Another VPS
- AWS
- A future local server/GPU workstation

OAuth/provider connections that cannot be migrated cleanly should become post-restore User Action Requests rather than silently failing.

## 57. Updates and rollback

- Pin versions.
- Version all configuration.
- Validate configuration before restart.
- Back up database before migrations.
- Run health checks after deployment.
- Keep previous application image/config available for rollback.
- Use Netlify preview deployments for frontend PRs.
- Test backend changes in an isolated Compose stack before promotion.
- Critical Jarvis control-plane updates require user approval or a clearly scoped task grant.

---

# PART XIV - SELF-IMPROVEMENT GOVERNANCE

## 58. Weekly Improvement workflow

1. Discover new models, providers, free tiers, MCP servers, skills, and tools.
2. Record source, maintainer, license, activity, permissions, and reputation.
3. Inspect code and dependencies.
4. Run static/security checks.
5. Test in an isolated sandbox.
6. Benchmark against current capability.
7. Evaluate privacy, cost, reliability, and maintenance burden.
8. Produce recommendation.
9. Request approval if a new provider/trust/billing/security boundary is introduced.
10. Stage, verify, promote, and retain rollback path.

Jarvis can create a new MCP server or adapter when no suitable one exists.

## 59. Immutable governance boundaries

Jarvis may not silently change:

- Project isolation
- User authentication
- Audit requirements
- Backup requirements
- Spending ceilings
- Always-confirm action list
- Secret scope
- Authority of system projects

It may recommend changes, but the user must approve them.

## 60. User-directed Jarvis changes

Instructions through WhatsApp, phone, or UI can update:

- Global instructions
- Project instructions
- Connection assignments
- Schedules
- Model routing
- Coding workflow
- UI preferences
- Queue policy
- Tool permissions

Changes are:

- Interpreted as configuration tasks
- Versioned
- Validated
- Audited
- Rollback-capable

Jarvis should answer questions such as:

> "What changed in this project's policy last week?"

---

# PART XV - COST MODEL

## 61. Expected recurring incremental costs

- Netcup server: target approximately EUR 22-29/month before any tax/currency differences, depending on selected plan/location
- Telnyx phone number and minutes: usage based, likely low single digits for moderate personal use
- Backblaze B2: likely free initially if stored backup size remains within its free allowance; otherwise low usage-based cost
- ElevenLabs: already subscribed
- ChatGPT: already subscribed
- Claude: already subscribed
- Cursor: already subscribed

No surprise paid model API usage.

## 62. Resource growth

Monitor and forecast:

- Attachments/audio
- Browser downloads
- Git repositories/worktrees
- Docker images
- Logs
- Artifacts
- Backups

Storage cleanup follows explicit retention policy and creates an Issue before destructive cleanup outside that policy.

---

# PART XVI - IMPLEMENTATION ORDER

## 63. Phase 0 - Repository and infrastructure foundation

- Create private `jarvis-core` repository.
- Create private `jarvis-control-center` repository.
- Configure the personal GitHub system credential for private repository creation only.
- Implement per-repository SSH deploy-key or equivalently narrow repository credential provisioning.
- Professional GitHub connections are created at project onboarding, never at boot, and never use the personal GitHub credential.
- Provision Netcup server.
- Harden server.
- Configure domain, DNS, TLS, and Tailscale/private admin access.
- Configure offsite backup destination.

## 64. Phase 1 - Core persistence and auth

- PostgreSQL schema
- Single-user authentication
- Project registry
- Inbox Events
- Conversations
- Tasks and queue
- Issues
- Audit
- Transactional outbox
- Configuration versioning
- Seed **only** Jarvis Improvement and Jarvis Maintenance (plus default schedules). No application projects.

## 65. Phase 2 - OpenClaw and channel integration

- OpenClaw deployment
- Dedicated Jarvis WhatsApp number/account and allowlist
- WhatsApp
- OpenClaw session mapping
- Schedule mapping
- Background-task mapping
- Provider auth-profile integration with owner/project/role allowlists
- Configure personal Anthropic, Codex, and Cursor profiles. Project-owned profiles are added when a project is created, not at boot
- Configure personal Codex and Cursor profiles
- Sandbox policy

## 66. Phase 3 - Control Center

- Netlify frontend
- Home/Projects/Work/Conversations
- Operations/Issues
- Connections/action links
- Approvals
- Schedules
- Models
- Live updates
- Mobile/PWA

## 67. Phase 4 - Engineering capability

- GitHub broker
- Worktrees
- Coding harness adapters
- Project onboarding classification and model-account policy
- Project `AGENTS.md` policy
- Tests/review/PR pipeline
- Netlify deployment broker
- Task grants and deployment policies

## 68. Phase 5 - Voice and phone

- Telnyx number
- Inbound/outbound calls
- ElevenLabs voice
- Transcription
- Call-to-Inbox flow
- Call authentication policy
- Enforce 7:30 PM-8:00 AM quiet hours and weekend calling rules
- Enforce seven-day raw-audio retention

## 69. Phase 6 - Reliability and self-management

- Watchdog
- Checkpoints
- Recovery ladder
- Maintenance project
- Improvement project
- Model benchmark suite
- Backup restore test
- Security/isolation tests

## 70. Phase 7 - Acceptance and freeze

Run the full acceptance suite. V1 is not considered launched until all critical tests pass.

---

# PART XVII - ACCEPTANCE TESTS

## 71. Input durability

Send rapid WhatsApp text, voice, UI, phone, and scheduled inputs while a heavy task is running.

Expected:

- Every input is durably captured.
- No input is dropped.
- Correct conversations/tasks are created.
- Original provenance remains available.

## 72. Queue and restart

Restart the server with queued and running tasks.

Expected:

- Queue survives.
- Running tasks reconcile to recovering/stalled state.
- Work resumes from checkpoint where possible.

## 73. Worker failure

Kill the heavy worker mid-task.

Expected:

- Watchdog detects it.
- Issue/timeline records it.
- Replacement worker resumes from checkpoint.

## 74. Model/provider failure

Disable the Supervisor primary and exhaust an entire role pool.

Expected:

- Approved fallback activates without losing conversation state.
- Role-degradation Issue appears only when materially degraded.
- No paid provider is enabled automatically.

## 75. Connection request

Remove a required GitHub/provider credential.

Expected:

- One deduplicated Issue appears.
- WhatsApp deep link arrives.
- Credential/OAuth setup succeeds.
- Provider-level credential is reused.
- Blocked task resumes.

## 76. GitHub authority and repository isolation

Ask Jarvis to create two new personal projects and repositories.

Expected:

- Both repositories default private.
- Each repository becomes a distinct Jarvis project.
- Each project receives a different repository-specific deploy key or equivalently narrow credential.
- Project A can clone/push only Project A's repository.
- Project A cannot use the personal account-level repository-creation credential.
- Project A cannot access Project B's repository.
- If a professional project exists, it cannot access either personal repository through its project credential, and personal projects cannot access it.
- Audit events exist for repository creation and credential provisioning.

## 77. Natural-language task grant

Ask:

> "Fix this, create the PR, merge it, and deploy it."

Expected:

- Task grant is recorded.
- Tests/review/policies still run.
- Merge/deploy proceed without redundant approval if scope remains unchanged.
- A changed SHA or high-risk migration invalidates/escalates the grant.

## 78. Always-confirm action

Ask a normal project agent to delete a repository or weaken isolation.

Expected:

- Point-of-action confirmation required.
- No implicit grant bypass.

## 79. Project isolation

Attempt cross-project secret, file, browser-profile, and connection access.

Expected:

- Technical denial.
- Security event/audit record.

## 80. WhatsApp brevity

Test trivial and long tasks.

Expected:

- Trivial store/transcribe task generates no unnecessary completion message.
- Long task generates concise acknowledgment, blockers if any, and concise completion update.

## 80.1 Provider-account isolation

Create a temporary professional project with a dedicated auth profile. Attempt to route a personal or system task through that profile, and attempt to route that professional project's code through a personal/free profile that is not approved for it.

Expected:

- Both attempts are technically denied before content is sent.
- The correct eligible auth profile is selected or the task becomes blocked.
- No silent substitution between provider accounts occurs.
- An audit/security event records the denied attempt.

## 80.2 Raw-audio retention

Ingest WhatsApp and phone audio, preserve transcripts, and advance the retention job past seven days.

Expected:

- Raw local audio is deleted after seven days unless marked permanent.
- Transcripts, tasks, provenance, and extracted knowledge remain.
- No unapproved local raw audio remains beyond ten days.

## 80.3 Phone quiet hours

Trigger normal, high-severity, and weekend proactive call events inside and outside quiet hours.

Expected:

- No proactive outbound call occurs from 7:30 PM through 8:00 AM America/New_York.
- Quiet-hour incidents create WhatsApp/UI alerts instead.
- Weekend proactive calls work outside quiet hours.
- User-initiated inbound calls remain available.

## 81. Schedule behavior

Test overlap, missed run, restart, and repeated failure.

Expected:

- Configured overlap/misfire policy is honored.
- Duplicate runs are prevented.
- Repeated failure creates an Issue.

## 82. Backup disaster recovery

Destroy an isolated test deployment and restore.

Expected:

- Projects, conversations, tasks, issues, schedules, encrypted credentials, artifacts, model registry, and configuration return.
- Unportable OAuth connections become action requests.

## 83. UI security

Inspect browser storage and network.

Expected:

- No provider master secrets.
- No OpenClaw admin token.
- No DB credentials.
- Expired action links fail.
- Used links cannot replay.

## 84. Mobile and accessibility

On a phone-sized viewport and keyboard-only desktop flow:

- See health
- Add context
- Resolve an API-key issue
- Approve/reject an action
- Reprioritize work
- Review artifact

Expected:

- No desktop-only blocker.
- Accessible focus, labels, contrast, and status semantics.

## 85. Self-improvement

Run weekly Improvement job.

Expected:

- Candidate model/tool/MCP discovered.
- Code is sandboxed and evaluated.
- Recommendation includes benefit/cost/privacy/risk.
- Risky activation waits for approval.

## 86. Maintenance

Simulate low disk, expired credential, missed backup, and stuck browser.

Expected:

- Safe recoveries happen automatically.
- Risky decisions produce Issues.
- Full audit history is visible.

---

# PART XVIII - RESOLVED USER PREFERENCE DECISIONS

## 87. GitHub account and repository scope

Decision:

- Jarvis receives a personal GitHub system capability used to create new private repositories and bootstrap projects.
- Every personal application is a separate Jarvis project.
- Every project has access only to its exact repository through a repository-specific key/token.
- Personal project workers never receive the personal account-level GitHub credential.
- Professional projects use separate GitHub accounts/organizations/connections created at onboarding.
- No professional project uses the personal GitHub credential.

## 88. WhatsApp number

Decision:

- Use a dedicated Jarvis WhatsApp number/account.
- Keep WhatsApp calling out of V1.
- Support text, files, images, forwarded content, and voice notes.

## 89. Confidential-project model and subscription policy

Decision:

- Professional/confidential projects cannot use consumer/free endpoints whose terms are incompatible with confidential code unless explicitly approved.
- New professional-project onboarding asks which subscription/provider accounts may be used and whether metered paid APIs are permitted.
- Metered API spending defaults to disabled.
- A project-owned subscription, when added, is used only by that project's task agents and not by the global Supervisor or any other project.
- The user's personal Cursor and Codex subscriptions may be used by personal and other explicitly approved projects.
- The user's separate personal Anthropic Pro profile may be used for Supervisor/orchestration, personal projects, Jarvis system work, and other professional projects when approved.
- Subscription/account ownership and project eligibility are mandatory model-routing constraints.

## 90. Raw audio retention

Decision:

- Store local raw WhatsApp voice-note and phone-call audio for seven days by default.
- Delete it automatically after seven days unless explicitly marked permanent.
- Never retain it automatically beyond ten days.
- Keep transcripts, metadata, provenance, and extracted knowledge according to normal project retention policy.

## 91. Proactive phone-call policy and quiet hours

Decision:

- Proactive calls are allowed seven days per week, including Saturday and Sunday.
- Permitted calling window: 8:00 AM through 7:29 PM America/New_York.
- Quiet hours: 7:30 PM through 8:00 AM America/New_York.
- No proactive outbound calls during quiet hours; use WhatsApp and Control Center alerts instead.
- User-initiated inbound calls may be accepted at any time.

---

# PART XIX - VERIFIED PLATFORM ASSUMPTIONS

These external assumptions must be rechecked at implementation because platforms and pricing change.

- OpenClaw WhatsApp documentation: https://docs.openclaw.ai/channels/whatsapp
- OpenClaw ACP coding agents: https://docs.openclaw.ai/tools/acp-agents
- OpenClaw background tasks: https://docs.openclaw.ai/automation/tasks
- OpenClaw automations: https://docs.openclaw.ai/automation
- OpenClaw model failover: https://docs.openclaw.ai/model-failover
- OpenClaw multi-agent/workspace isolation: https://docs.openclaw.ai/concepts/multi-agent
- OpenClaw sandboxing: https://docs.openclaw.ai/sandboxing
- OpenClaw voice-call plugin: https://docs.openclaw.ai/plugins/voice-call
- Netcup RS 2000 G12: https://www.netcup.com/en/server/root-server/rs-2000-g12
- Netcup VPS options: https://www.netcup.com/en/server/vps
- GitHub App permission model: https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app
- GitHub repository creation API: https://docs.github.com/en/rest/repos/repos#create-a-repository-for-the-authenticated-user
- Netlify API authentication: https://docs.netlify.com/api-and-cli-guides/api-guides/get-started-with-api/
- Netlify continuous deployment: https://docs.netlify.com/build/configure-builds/repo-permissions-linking/
- Backblaze B2 pricing: https://www.backblaze.com/cloud-storage/pricing
- Groq rate limits: https://console.groq.com/docs/rate-limits
- NVIDIA model catalog: https://build.nvidia.com/models
- Google AI pricing/data terms: https://ai.google.dev/gemini-api/docs/pricing
- Claude Code subscription login: https://docs.anthropic.com/en/docs/claude-code/getting-started
- Cursor ACP: https://cursor.com/docs/cli/acp

---

# PART XX - IMPLEMENTATION BASELINE AND CHANGE CONTROL

Version 1.2 is the current Jarvis V1 architecture baseline (ADR 012). Implementation agents must not silently reinterpret or weaken it. Version 1.1 is historical.

Before production launch, implementation must still revalidate external facts that can change, including:

1. Current Netcup availability/pricing.
2. Exact OpenClaw WhatsApp onboarding and reconnection behavior.
3. Current provider model catalogs, free tiers, data terms, and subscription authentication support.
4. Exact GitHub credential mechanisms available for personal repository creation and repository-scoped write access.
5. Current Telnyx and ElevenLabs integration details.

Revalidation may change implementation details but not the locked product/security policy. Any architectural change after this version requires a formal Architecture Decision Record containing:

- Proposed change
- Reason
- Alternatives
- Security/privacy/cost effect
- Migration and rollback plan
- User approval when the change affects preferences, trust boundaries, billing, production permissions, or project isolation

The canonical plan should be committed to the private `jarvis-core` repository before implementation begins.
