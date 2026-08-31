# Netcup bootstrap (Phase 0)

## What I can and cannot do

**I cannot create the server from an API key.** Netcup’s shop/CCP has no public “order a root server” API. The SCP REST API (`servercontrolpanel.de`) only manages **already ordered** servers: power, snapshots, firewall, SSH keys, traffic, disks. Community confirmation: provisioning is shop-only.

**You order once.** After that I (and later Jarvis) use SCP to *see and operate* that instance.

**Jarvis Netcup access:** system connection `netcup_scp` — OAuth refresh token from SCP (not the CCP DNS API key). Broker capabilities: list server, status, metrics/traffic if exposed, snapshots, **no** shop-ordering, **no** account billing changes without always-confirm. Health/Maintenance reads this so Jarvis can see its own box.

CCP API keys (Stammdaten → API) are for **DNS** if the domain is at Netcup. Separate from SCP. Collect later if we use Netcup DNS.

## Sequence (operator does numbered shop steps; agent does the rest)

1. You: Netcup customer account + **order** the VPS (this file, Step 1).
2. You: add my SSH public key (or give me the first root password once over a channel you control) so I can log in.
3. I: harden, Tailscale, Caddy, Compose, bootstrap.
4. You: SCP REST API login once → refresh token stored in Jarvis broker as `netcup_scp`.
5. You: remaining provider keys (Groq, NVIDIA, …) on the Control Center checklist.

Do not paste shop passwords, root passwords, or card/IBAN numbers into chat. Paste only tokens we explicitly ask for, and rotate if this chat is logged.

## This box (provisioned 2026-08-31)

Public facts only. Secrets stay in the password manager, never in git.

| | |
|---|---|
| IPv4 | `159.195.245.62` |
| IPv6 | `2a0a:4cc0:61:1d6a:e81a:deff:fe7f:b34e` |
| Hostname | `v2202608408610510212.bestsrv.de` |
| Location | Vienna (Netcup VIE; Manassas SKU was out of stock) |
| SKU | RS 2000 G12 ip iv — 16 GB RAM, 8 vCPU, 512 GB NVMe |
| OS | Debian 13 Trixie (Netcup “minimal”; plan allows current supported Linux) |
| SSH | keys only (`PermitRootLogin prohibit-password`); host ED25519 `SHA256:NCk6DK4G3MzCHssPjEi6gm71oC0dO6f9emUNewjGeiU` |
| Operator alias | `ssh jarvis-netcup` (key `~/.ssh/id_ed25519_jarvis_netcup`) |
| Public origin | `https://jarvis.enriquecodes.com` |
| DNS | Netlify DNS zone `enriquecodes.com` — A + AAAA for `jarvis` |
| GitHub | `enriquealonso01/jarvis-core`, `enriquealonso01/jarvis-control-center` (private) |

The mailed root password was rotated on first access and SSH password auth is off. Console/rescue password lives in the password manager, not here.
