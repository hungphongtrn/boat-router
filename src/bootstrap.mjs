import { telemetrySetup } from './runner-telemetry.mjs';
import { toolchainMirror } from '../config/policy.mjs';

export const RELEASES = Object.freeze({
  git: {
    url: `${toolchainMirror}/git/2.56.0/git_amd64.deb`,
    sha256: '8681013502ef3b3ab4131c94e43ca89dd133934d0f5dc143cd456a7896b0ba81',
  },
  runner: {
    mirror: `${toolchainMirror}/runner/v2.338.0/actions-runner-linux-x64-2.338.0.tar.gz`,
    url: 'https://github.com/actions/runner/releases/download/v2.338.0/actions-runner-linux-x64-2.338.0.tar.gz',
    sha256: 'af4b794c1bc41d73d40535e3fe092a39f9679cd8d965954c2aca25a05ca41d32',
  },
  powershell: {
    mirror: `${toolchainMirror}/powershell/v7.6.7/powershell-7.6.7-linux-x64.tar.gz`,
    url: 'https://github.com/PowerShell/PowerShell/releases/download/v7.6.7/powershell-7.6.7-linux-x64.tar.gz',
    sha256: '6896f9e3a6b0a354bf470835a96da76d2f801cd50dcf047ad7c4563bf93bf431',
  },
  shellcheck: {
    mirror: `${toolchainMirror}/shellcheck/v0.11.0/shellcheck-v0.11.0.linux.x86_64.tar.xz`,
    url: 'https://github.com/koalaman/shellcheck/releases/download/v0.11.0/shellcheck-v0.11.0.linux.x86_64.tar.xz',
    sha256: '8c3be12b05d5c177a04c29e3c78ce89ac86f1595681cab149b65b97c4e227198',
  },
  // Docker Actions boxes only (`docker: true`): a tool-cache Node, so actions/setup-node finds it, and a pinned FFmpeg.
  node: {
    version: '26.13.0',
    url: 'https://nodejs.org/dist/v26.13.0/node-v26.13.0-linux-x64.tar.xz',
    sha256: 'd28a96af6c38596f6d9d97c0ee531c13d238d757742387d1928de822d959e997',
  },
  ffmpeg: {
    build: 'ffmpeg-n8.1.2-50-g1a748fe2cd-linux64-gpl-8.1',
    url: 'https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-08-31-13-27/ffmpeg-n8.1.2-50-g1a748fe2cd-linux64-gpl-8.1.tar.xz',
    sha256: 'c733b4b2951e5957e15505f788b2c65a7a41b6da4b289e295852cc38079b4d2b',
  },
});
export const RUNNER_WORK_FOLDER = '/tmp/w';
// The Boat command executor runs `user` with CAP_DAC_READ_SEARCH in the ambient set, and ambient capabilities
// survive every execve of a job step: a mode-000 file is then still readable, which GitHub-hosted
// runners never allow (a test that checks an unreadable file fails). The runner and its jobs therefore start with the
// inheritable and ambient sets cleared. The bounding set stays, so `sudo` (setuid) keeps working for lane installs.
export const RUNNER_CAPS_DROP = 'setpriv --inh-caps=-all --ambient-caps=-all --';

// Packages that the example Docker lanes install with apt during a job (edit for your own workflows).
// A Docker-reset box installs them at bootstrap, before its baseline, so the lane steps become no-ops and leave no dpkg drift:
// `npx playwright install --with-deps chromium` (Playwright 1.59.1 and 1.61.1 on Ubuntu 24.04; the list is what
// `playwright install-deps --dry-run chromium` prints, and apt also lifts the mesa packages to their candidate versions),
// `sudo apt-get install -y zsh`, and `ffmpeg -version || sudo apt-get install -y ffmpeg` (satisfied by the pinned FFmpeg).
export const ACTIONS_DOCKER_PACKAGES = Object.freeze({
  playwright: Object.freeze(['libasound2t64', 'libatk-bridge2.0-0t64', 'libatk1.0-0t64', 'libatspi2.0-0t64', 'libcairo2', 'libcups2t64', 'libdbus-1-3', 'libdrm2', 'libgbm1', 'libglib2.0-0t64', 'libnspr4', 'libnss3', 'libpango-1.0-0', 'libx11-6', 'libxcb1', 'libxcomposite1', 'libxdamage1', 'libxext6', 'libxfixes3', 'libxkbcommon0', 'libxrandr2', 'xvfb', 'fonts-noto-color-emoji', 'fonts-unifont', 'libfontconfig1', 'libfreetype6', 'xfonts-cyrillic', 'xfonts-scalable', 'fonts-liberation', 'fonts-ipafont-gothic', 'fonts-wqy-zenhei', 'fonts-tlwg-loma-otf', 'fonts-freefont-ttf']),
  plain: Object.freeze(['zsh']),
});

export function gitWrapper(prefix = '/home/user/.local/git') {
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  return `#!/bin/sh
export GIT_EXEC_PATH=${quote(prefix + '/usr/lib/git-core')}
export GIT_TEMPLATE_DIR=${quote(prefix + '/usr/share/git-core/templates')}
exec ${quote(prefix + '/usr/bin/git')} "$@"
`;
}

export function environment() {
  return `umask 022
export PATH="/home/user/.local/bin:$PATH"
export TMPDIR=/tmp
export TZ=UTC
export LANG=en_US.UTF-8
export LC_ALL=en_US.UTF-8
export RUNNER_TOOL_CACHE=/opt/hostedtoolcache
export AGENT_TOOLSDIRECTORY="$RUNNER_TOOL_CACHE"`;
}
// Phase markers go to stdout and stderr: the provider's setupError carries only
// stderr. The ERR trap names the phase and status on the last stderr line, so a
// truncated capture still identifies where setup stopped.
export function setupPhaseHelpers() {
  return `BOAT_PHASE=start
phase() { BOAT_PHASE=$1; printf 'BOAT_SETUP_PHASE %s\\n' "$1"; printf 'BOAT_SETUP_PHASE %s\\n' "$1" >&2; }
trap 'printf "BOAT_SETUP_FAILED phase=%s status=%s line=%s\\n" "$BOAT_PHASE" "$?" "$LINENO" >&2' ERR`;
}
// The body of the bootstrap script, without its shebang and environment. The
// snapshot builder (`src/snapshot-build.mjs`) reuses it, so the runner layout a
// router snapshot carries is the one a plain boot installs.
//
// `git` chooses the VCS: 'mirror' downloads the pinned 2.56.0 package the
// toolchain mirror must host and has no upstream fallback (docs/setup.md);
// 'system' keeps the image's git instead. The builder uses 'system' where no
// mirror is hosted: a snapshot boot verifies the saved layout and never runs
// this script, so the pinned git only matters to a plain boot.
//
// The Docker Actions boxes add the lane packages, a tool-cache Node and the pinned FFmpeg (`docker: true`).
export function bootstrapBody({ docker = false, git = 'mirror' } = {}) {
  const gitCheck = git === 'system' ? 'git --version' : `test "$(git --version)" = 'git version 2.56.0'`;
  const actionsDocker = docker ? `phase actions_apt_install
sudo -n env DEBIAN_FRONTEND=noninteractive apt-get -o Acquire::Retries=3 install -y --no-install-recommends ${ACTIONS_DOCKER_PACKAGES.playwright.join(' ')}
sudo -n env DEBIAN_FRONTEND=noninteractive apt-get -o Acquire::Retries=3 install -y ${ACTIONS_DOCKER_PACKAGES.plain.join(' ')}
command -v zsh
phase node_toolcache
fetch_checked '${RELEASES.node.url}' '${RELEASES.node.sha256}' /home/user/.boat-ci/node.tar.xz
mkdir -p "$RUNNER_TOOL_CACHE/node/${RELEASES.node.version}/x64"
tar xJf /home/user/.boat-ci/node.tar.xz -C "$RUNNER_TOOL_CACHE/node/${RELEASES.node.version}/x64" --strip-components=1
: > "$RUNNER_TOOL_CACHE/node/${RELEASES.node.version}/x64.complete"
rm -f /home/user/.boat-ci/node.tar.xz
test "$("$RUNNER_TOOL_CACHE/node/${RELEASES.node.version}/x64/bin/node" --version)" = 'v${RELEASES.node.version}'
phase ffmpeg_download
fetch_checked '${RELEASES.ffmpeg.url}' '${RELEASES.ffmpeg.sha256}' /home/user/.boat-ci/ffmpeg.tar.xz
sudo -n rm -rf /usr/local/lib/ffmpeg
sudo -n mkdir -p /usr/local/lib/ffmpeg/bin
sudo -n tar xJf /home/user/.boat-ci/ffmpeg.tar.xz -C /usr/local/lib/ffmpeg/bin --strip-components=2 '${RELEASES.ffmpeg.build}/bin/ffmpeg' '${RELEASES.ffmpeg.build}/bin/ffprobe'
rm -f /home/user/.boat-ci/ffmpeg.tar.xz
sudo -n ln -sf /usr/local/lib/ffmpeg/bin/ffmpeg /usr/local/bin/ffmpeg
sudo -n ln -sf /usr/local/lib/ffmpeg/bin/ffprobe /usr/local/bin/ffprobe
ffmpeg -version | head -1
ffprobe -version | head -1
` : '';
  return `mkdir -p /home/user/.local/bin "$RUNNER_TOOL_CACHE" /home/user/boat-ci-runner ${RUNNER_WORK_FOLDER}
(umask 077; mkdir -p /home/user/.boat-ci)
chmod 700 /home/user/.boat-ci
exec 9>/home/user/.boat-ci/bootstrap.lock
flock 9
if test -f /home/user/.boat-ci/ready; then exit 0; fi
phase apt_update
sudo -n apt-get -o Acquire::Retries=3 -o APT::Update::Error-Mode=any update
phase apt_install
sudo -n env DEBIAN_FRONTEND=noninteractive apt-get -o Acquire::Retries=3 install -y --no-install-recommends libgstreamer-plugins-bad1.0-0 git-lfs
fetch_checked() {
  curl --fail --location --silent --show-error --retry 6 --retry-delay 10 --retry-all-errors --max-time 300 "$1" -o "$3"
  printf '%s  %s\\n' "$2" "$3" | sha256sum --check --strict -
}
fetch_mirrored() {
  if curl --fail --location --silent --show-error --retry 2 --retry-delay 2 --retry-all-errors --max-time 60 "$1" -o "$4" &&
    printf '%s  %s\\n' "$3" "$4" | sha256sum --check --strict -; then
    return 0
  fi
  fetch_checked "$2" "$3" "$4"
}
${actionsDocker}if test -w /etc && test -f /usr/share/zoneinfo/UTC; then
  ln -snf /usr/share/zoneinfo/UTC /etc/localtime
fi
if test -w /etc/timezone; then printf 'UTC\\n' > /etc/timezone; fi
command -v git
command -v setpriv
command -v docker
docker compose version
phase docker_ready
timeout 120 bash -c 'until docker info >/dev/null 2>&1; do sleep 2; done'
command -v google-chrome
command -v python3
command -v node
command -v jq
command -v dpkg-deb
${git === 'system' ? `phase git_system
command -v git
git --version
git lfs version
` : `phase git_download
fetch_checked '${RELEASES.git.url}' '${RELEASES.git.sha256}' /home/user/.boat-ci/git.deb
dpkg-deb --extract /home/user/.boat-ci/git.deb /home/user/.local/git
cat > /home/user/.local/bin/git <<'GIT'
${gitWrapper()}GIT
chmod 755 /home/user/.local/bin/git
ln -sf /home/user/.local/bin/git /usr/local/bin/git
git --version
git lfs version
git init -q /home/user/.boat-ci/git-check
GIT_AUTHOR_DATE=2000-01-01T00:00:00Z GIT_COMMITTER_DATE=2000-01-01T00:00:00Z git -C /home/user/.boat-ci/git-check -c user.name=Boat -c user.email=ci@example.com -c commit.gpgsign=false commit --allow-empty -qm bootstrap
test "$(git -C /home/user/.boat-ci/git-check log -1 --format=%aI)" = 2000-01-01T00:00:00Z
`}phase powershell_download
fetch_mirrored '${RELEASES.powershell.mirror}' '${RELEASES.powershell.url}' '${RELEASES.powershell.sha256}' /home/user/.boat-ci/powershell.tar.gz
mkdir -p /home/user/.local/powershell
tar xzf /home/user/.boat-ci/powershell.tar.gz -C /home/user/.local/powershell
chmod 755 /home/user/.local/powershell/pwsh
ln -sf /home/user/.local/powershell/pwsh /home/user/.local/bin/pwsh
ln -sf /home/user/.local/powershell/pwsh /usr/local/bin/pwsh
phase shellcheck_download
fetch_mirrored '${RELEASES.shellcheck.mirror}' '${RELEASES.shellcheck.url}' '${RELEASES.shellcheck.sha256}' /home/user/.boat-ci/shellcheck.tar.xz
tar xJf /home/user/.boat-ci/shellcheck.tar.xz -C /home/user/.boat-ci
install -m 755 /home/user/.boat-ci/shellcheck-v0.11.0/shellcheck /home/user/.local/bin/shellcheck
ln -sf /home/user/.local/bin/shellcheck /usr/local/bin/shellcheck
phase runner_download
fetch_mirrored '${RELEASES.runner.mirror}' '${RELEASES.runner.url}' '${RELEASES.runner.sha256}' /home/user/.boat-ci/runner.tar.gz
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
${gitCheck}
${telemetrySetup('/home/user/.boat-ci/telemetry.sh', RUNNER_WORK_FOLDER)}
${RUNNER_CAPS_DROP} ./run.sh --jitconfig "$(cat /home/user/.boat-ci/jit)" > /home/user/.boat-ci/runner.log 2>&1
START
chmod 700 /home/user/boat-ci-start.sh
: > /home/user/.boat-ci/ready
phase ready
`;
}
export function bootstrap({ docker = false, git = 'mirror' } = {}) {
  return `#!/usr/bin/env bash
set -Eeuo pipefail
${environment()}
${setupPhaseHelpers()}
${bootstrapBody({ docker, git })}`;
}
export function dockerBootstrap() { return bootstrap({ docker: true }); }
export const START_COMMAND = `${RUNNER_CAPS_DROP} bash /home/user/boat-ci-start.sh`;
