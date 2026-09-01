#!/bin/sh
# Prepare two repositories, each reachable by exactly one key, then serve sshd.
#
# Keys arrive on a shared volume written by the test: /keys/alpha.pub and
# /keys/beta.pub. Each is installed as the authorized key for its own user and
# nobody else's, which is what makes "alpha's key cannot reach beta's repo" a
# real refusal from sshd rather than an assertion about our own code.
set -eu

for u in alpha beta; do
  home="/home/$u"
  install -d -o "$u" -g "$u" -m 0700 "$home/.ssh"
  if [ -f "/keys/$u.pub" ]; then
    cp "/keys/$u.pub" "$home/.ssh/authorized_keys"
    chown "$u:$u" "$home/.ssh/authorized_keys"
    chmod 0600 "$home/.ssh/authorized_keys"
  else
    : > "$home/.ssh/authorized_keys"
    chown "$u:$u" "$home/.ssh/authorized_keys"
    chmod 0600 "$home/.ssh/authorized_keys"
  fi
  repo="$home/$u.git"
  if [ ! -d "$repo" ]; then
    git init --bare --initial-branch=main "$repo" >/dev/null
    # A bare repo with no commits has no refs, and `git clone` of an empty repo
    # warns but succeeds — fine for the isolation test, but a seeded commit makes
    # "the clone really has content" assertable too.
    work=$(mktemp -d)
    git -c init.defaultBranch=main init -q "$work"
    echo "$u repository, seeded for the S5 isolation test" > "$work/README.md"
    git -C "$work" add -A
    git -C "$work" -c user.email=dev@jarvis.local -c user.name=Seed commit -q -m "Initial commit"
    git -C "$work" push -q "$repo" main
    rm -rf "$work"
    chown -R "$u:$u" "$repo"
  fi
done

ssh-keygen -A >/dev/null 2>&1 || true
exec /usr/sbin/sshd -D -e
