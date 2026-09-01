# ADR 008 — Secret storage (single-user)

- Status: accepted
- Date: 2026-08-31
- Plan sections: §9, §51, §54–56
- Affects isolation / billing / always-confirm: no

## Decision

No Vault, no cloud KMS in V1.

**Envelope encryption:**

- Master key: 32 random bytes at `/var/lib/jarvis/keys/master.key`, mode `0400`, owner root, readable by `jarvis` via group or capability as needed.
- Data-encryption keys (DEKs) in Postgres, encrypted with the master key (AES-256-GCM). Rotate DEK by re-encrypting credential rows; master rotation is a Maintenance task with backup first.
- `credentials.ciphertext` never stored in logs or sent to models.
- After submit, UI shows last4 / fingerprint only.

**Recovery:**

- Restic backup includes `master.key` **inside the encrypted restic repository**.
- Restic password lives in Enrique’s password manager, not on the server in plaintext (prompt on restore, or a second USB/offline copy). Restore docs: `docs/SERVER_LAYOUT.md`.
- A backup is not verified until restore test decrypted a credential and connected with it (or a canary secret).

**Broker:** workers get typed actions or short-lived tokens, not the master key.

**OpenClaw secrets:** WhatsApp Baileys creds stay in OpenClaw state dir; that dir is restic-backed. Jarvis does not duplicate WhatsApp session keys into Postgres.

## Why

Plan requires envelope encryption, key outside normal rows, documented recovery. One operator does not need HSM.

## Alternatives rejected

- **SOPS-only files, no DB ciphertext** — Control Center connection health and rotation are harder.
- **Master key only in B2** — server cannot boot secrets at reboot without Enrique.

## Consequences

- Losing both server disk and restic password is unrecoverable. Restore runbook says this plainly.
- `jarvis export` redacts secrets; `jarvis restore` needs master key + restic.
- **Rollback:** moving to Vault or a cloud KMS is additive — decrypt with the master key, re-encrypt under the new root — but it must happen while the master key still exists. There is no rollback from a lost master key plus a lost restic password; the runbook says so plainly.

## User approval required

No.
