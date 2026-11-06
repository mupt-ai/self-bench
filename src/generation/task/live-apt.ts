/**
 * Authors pin apt to a dated snapshot (snapshot.debian.org, snapshot.ubuntu.com) so a task's own
 * packages install the same every time. The image keeps that pin, and E2B makes a template by
 * installing systemd, openssh-server and the like into the image with its apt: a snapshot whose
 * Release files have expired ("is expired"), or that is older than the image's packages ("held
 * broken packages"), fails every template build, and with it every trial. A task's images point
 * apt back at the distribution's live mirrors once its setup has run.
 */

/** Whether a Dockerfile leaves apt on a dated snapshot. */
export function pinsAptSnapshot(dockerfile: string): boolean {
  return /snapshot\.(?:debian\.org|ubuntu\.com)/.test(dockerfile);
}

/** A shell command, for a Dockerfile `RUN` as root, that points apt at the live mirrors. */
export const LIVE_APT_SOURCES = [
  "for file in /etc/apt/sources.list /etc/apt/sources.list.d/*; do",
  '[ -f "$file" ] || continue;',
  // Without sed -i, which takes its argument differently across GNU, BusyBox and BSD sed.
  "sed -E",
  "-e 's#https?://snapshot\\.debian\\.org/archive/(debian|debian-security)/[0-9]{8}T[0-9]{6}Z/?#http://deb.debian.org/\\1#g'",
  "-e 's#https?://snapshot\\.ubuntu\\.com/ubuntu/[0-9]{8}T[0-9]{6}Z/?#http://archive.ubuntu.com/ubuntu#g'",
  '"$file" > /tmp/selfbench-apt-source && cat /tmp/selfbench-apt-source > "$file";',
  "done;",
  "rm -f /tmp/selfbench-apt-source",
].join(" ");
