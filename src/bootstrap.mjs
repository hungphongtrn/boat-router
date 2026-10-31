export const RELEASES = Object.freeze({
  git: {
    url: 'https://launchpad.net/~git-core/+archive/ubuntu/candidate/+build/33485947/+files/git_2.55.0-0ppa1~ubuntu24.04.2_amd64.deb',
    sha256: '6238a37c11c1bd4b18a5194f766ccfcb2f26c116e7d8ecd07bac143863b69498',
  },
  runner: {
    url: 'https://github.com/actions/runner/releases/download/v2.338.0/actions-runner-linux-x64-2.338.0.tar.gz',
    sha256: 'af4b794c1bc41d73d40535e3fe092a39f9679cd8d965954c2aca25a05ca41d32',
  },
  powershell: {
    url: 'https://github.com/PowerShell/PowerShell/releases/download/v7.6.7/powershell-7.6.7-linux-x64.tar.gz',
    sha256: '6896f9e3a6b0a354bf470835a96da76d2f801cd50dcf047ad7c4563bf93bf431',
  },
  shellcheck: {
    url: 'https://github.com/koalaman/shellcheck/releases/download/v0.11.0/shellcheck-v0.11.0.linux.x86_64.tar.xz',
    sha256: '8c3be12b05d5c177a04c29e3c78ce89ac86f1595681cab149b65b97c4e227198',
  },
});
export const RUNNER_WORK_FOLDER = '/tmp/w';

export function gitWrapper(prefix = '/home/user/.local/git') {
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  return `#!/bin/sh
export GIT_EXEC_PATH=${quote(prefix + '/usr/lib/git-core')}
export GIT_TEMPLATE_DIR=${quote(prefix + '/usr/share/git-core/templates')}
exec ${quote(prefix + '/usr/bin/git')} "$@"
`;
}

function environment() {
  return `umask 022
export PATH="/home/user/.local/bin:$PATH"
export TMPDIR=/tmp
export TZ=UTC
export LANG=en_US.UTF-8
export LC_ALL=en_US.UTF-8
export RUNNER_TOOL_CACHE=/opt/hostedtoolcache
export AGENT_TOOLSDIRECTORY="$RUNNER_TOOL_CACHE"`;
}
export function bootstrap() {
  return `#!/usr/bin/env bash
set -euo pipefail
${environment()}
mkdir -p /home/user/.local/bin "$RUNNER_TOOL_CACHE" /home/user/boat-ci-runner ${RUNNER_WORK_FOLDER}
(umask 077; mkdir -p /home/user/.boat-ci)
chmod 700 /home/user/.boat-ci
exec 9>/home/user/.boat-ci/bootstrap.lock
flock 9
if test -f /home/user/.boat-ci/ready; then exit 0; fi
sudo -n apt-get update
sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends libgstreamer-plugins-bad1.0-0
fetch_checked() {
  curl --fail --location --silent --show-error --retry 3 --max-time 300 "$1" -o "$3"
  printf '%s  %s\\n' "$2" "$3" | sha256sum --check --strict -
}
if test -w /etc && test -f /usr/share/zoneinfo/UTC; then
  ln -snf /usr/share/zoneinfo/UTC /etc/localtime
fi
if test -w /etc/timezone; then printf 'UTC\\n' > /etc/timezone; fi
command -v git
command -v docker
docker compose version
timeout 120 bash -c 'until docker info >/dev/null 2>&1; do sleep 2; done'
command -v google-chrome
command -v python3
command -v node
command -v jq
command -v dpkg-deb
fetch_checked '${RELEASES.git.url}' '${RELEASES.git.sha256}' /home/user/.boat-ci/git.deb
dpkg-deb --extract /home/user/.boat-ci/git.deb /home/user/.local/git
cat > /home/user/.local/bin/git <<'GIT'
${gitWrapper()}GIT
chmod 755 /home/user/.local/bin/git
ln -sf /home/user/.local/bin/git /usr/local/bin/git
git --version
git init -q /home/user/.boat-ci/git-check
GIT_AUTHOR_DATE=2000-01-01T00:00:00Z GIT_COMMITTER_DATE=2000-01-01T00:00:00Z git -C /home/user/.boat-ci/git-check -c user.name=Boat -c user.email=ci@example.com -c commit.gpgsign=false commit --allow-empty -qm bootstrap
test "$(git -C /home/user/.boat-ci/git-check log -1 --format=%aI)" = 2000-01-01T00:00:00Z
fetch_checked '${RELEASES.powershell.url}' '${RELEASES.powershell.sha256}' /home/user/.boat-ci/powershell.tar.gz
mkdir -p /home/user/.local/powershell
tar xzf /home/user/.boat-ci/powershell.tar.gz -C /home/user/.local/powershell
chmod 755 /home/user/.local/powershell/pwsh
ln -sf /home/user/.local/powershell/pwsh /home/user/.local/bin/pwsh
ln -sf /home/user/.local/powershell/pwsh /usr/local/bin/pwsh
fetch_checked '${RELEASES.shellcheck.url}' '${RELEASES.shellcheck.sha256}' /home/user/.boat-ci/shellcheck.tar.xz
tar xJf /home/user/.boat-ci/shellcheck.tar.xz -C /home/user/.boat-ci
install -m 755 /home/user/.boat-ci/shellcheck-v0.11.0/shellcheck /home/user/.local/bin/shellcheck
ln -sf /home/user/.local/bin/shellcheck /usr/local/bin/shellcheck
fetch_checked '${RELEASES.runner.url}' '${RELEASES.runner.sha256}' /home/user/.boat-ci/runner.tar.gz
tar xzf /home/user/.boat-ci/runner.tar.gz -C /home/user/boat-ci-runner
pwsh -NoLogo -NoProfile -NonInteractive -Command '$PSVersionTable.PSVersion.ToString()'
shellcheck --version
cat > /home/user/boat-ci-start.sh <<'START'
#!/usr/bin/env bash
set -euo pipefail
${environment()}
exec 8>/home/user/.boat-ci/runner.lock
flock -n 8 || exit 0
if test -f /home/user/.boat-ci/started; then exit 0; fi
chmod 600 /home/user/.boat-ci/jit
: > /home/user/.boat-ci/started
cd /home/user/boat-ci-runner
test "$(git --version)" = 'git version 2.55.0'
./run.sh --jitconfig "$(cat /home/user/.boat-ci/jit)" > /home/user/.boat-ci/runner.log 2>&1
START
chmod 700 /home/user/boat-ci-start.sh
: > /home/user/.boat-ci/ready
`;
}
export const START_COMMAND = 'bash /home/user/boat-ci-start.sh';
