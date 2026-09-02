#!/usr/bin/env bash
# Give a project its own unix user (ADR 006 step 5, ADR 016).
#
#   sudo /opt/jarvis/core/deploy/provision-project-user.sh <slug>
#
# Run as root, on the host, once per professional or confidential project. It is
# idempotent: running it again on a provisioned project changes nothing.
#
# The ownership model, and why it is this and not a chown at run time:
#
#   /var/lib/jarvis/projects/<slug>   owner jarvis-p-<slug>, group jarvis-p-<slug>, mode 2770
#
# The runner (user `jarvis`) is added to the project's group, so it can prepare
# checkouts and read transcripts. The harness runs as `jarvis-p-<slug>` with
# --clear-groups, so it has exactly one group: its own. Another project's user is
# neither the owner nor in the group, so the directory is 0 to it — the read that
# S12's tripwire used to CATCH now fails at the filesystem layer instead.
#
# setgid (the 2 in 2770) makes every file created inside inherit the group, so a
# worktree the runner creates stays reachable by the project's user without any
# further chowning.
set -euo pipefail

SLUG="${1:-}"
if [ -z "$SLUG" ]; then
  echo "usage: $0 <project-slug>" >&2
  exit 2
fi
if ! printf '%s' "$SLUG" | grep -qE '^[a-z0-9][a-z0-9-]{0,40}$'; then
  echo "refusing: '$SLUG' is not a plausible project slug" >&2
  exit 2
fi
if [ "$(id -u)" != "0" ]; then
  echo "run this as root" >&2
  exit 2
fi

ROOT="${JARVIS_ROOT:-/var/lib/jarvis}"
USER_NAME="jarvis-p-${SLUG}"
if [ "${#USER_NAME}" -gt 32 ]; then
  echo "refusing: '$USER_NAME' is longer than a unix username may be." >&2
  echo "The runner truncates and hashes long slugs; ask it for the name with" >&2
  echo "  node -e \"import('/opt/jarvis/core/dist/unixuser.js').then(m=>console.log(m.projectUnixUser('$SLUG')))\"" >&2
  exit 2
fi

if id -u "$USER_NAME" >/dev/null 2>&1; then
  echo "user $USER_NAME already exists"
else
  useradd --system --no-create-home --shell /usr/sbin/nologin "$USER_NAME"
  echo "created $USER_NAME"
fi

# The runner needs to be in the group to prepare the work; the project's own
# user needs nothing added, it owns the tree.
usermod -aG "$USER_NAME" jarvis
echo "jarvis added to group $USER_NAME"

DIR="$ROOT/projects/$SLUG"
install -d -o "$USER_NAME" -g "$USER_NAME" -m 2770 "$DIR"
chown -R "$USER_NAME:$USER_NAME" "$DIR"
chmod -R g+rwX,o-rwx "$DIR"
find "$DIR" -type d -exec chmod g+s {} +
echo "$DIR is now $USER_NAME:$USER_NAME 2770"

cat <<NOTE

Done. Two things do not take effect on their own:

  1. jarvis's new group membership needs the service restarted:
       systemctl restart jarvis-runner
  2. The sudoers rule must be installed once, from
       deploy/jarvis-runner.sudoers  ->  /etc/sudoers.d/jarvis-runner
     (install with: visudo -c -f deploy/jarvis-runner.sudoers && install -m 0440
      deploy/jarvis-runner.sudoers /etc/sudoers.d/jarvis-runner)
NOTE
