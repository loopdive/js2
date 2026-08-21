FROM node:25

ARG TZ
ENV TZ="$TZ"

ARG CLAUDE_CODE_VERSION=latest

# Install basic development tools and iptables/ipset
RUN apt-get update && apt-get install -y --no-install-recommends \
  less \
  git \
  procps \
  sudo \
  fzf \
  ripgrep \
  zsh \
  man-db \
  unzip \
  xz-utils \
  gnupg2 \
  gh \
  iptables \
  ipset \
  iproute2 \
  dnsutils \
  aggregate \
  bubblewrap \
  jq \
  nano \
  vim \
  tmux \
  dtach \
  locales \
  openssh-server \
  git-lfs \
  && sed -i '/en_US.UTF-8/s/^# //' /etc/locale.gen \
  && locale-gen en_US.UTF-8 \
  && ln -sf /usr/share/zoneinfo/Europe/Berlin /etc/localtime \
  && apt-get clean && rm -rf /var/lib/apt/lists/*

ENV LANG=en_US.UTF-8
ENV LC_ALL=en_US.UTF-8
ENV TERM=xterm-256color

# Ensure default node user has access to /usr/local/share
RUN mkdir -p /usr/local/share/npm-global && \
  chown -R node:node /usr/local/share

ARG USERNAME=node

# Persist bash history.
RUN SNIPPET="export PROMPT_COMMAND='history -a' && export HISTFILE=/commandhistory/.bash_history" \
  && mkdir /commandhistory \
  && touch /commandhistory/.bash_history \
  && chown -R $USERNAME /commandhistory

# Set `DEVCONTAINER` environment variable to help with orientation
ENV DEVCONTAINER=true

# Create workspace and config directories and set permissions
RUN mkdir -p /workspace /home/node/.claude /home/node/.codex && \
  chown -R node:node /workspace /home/node/.claude /home/node/.codex

WORKDIR /workspace

ARG GIT_DELTA_VERSION=0.18.2
RUN ARCH=$(dpkg --print-architecture) && \
  wget "https://github.com/dandavison/delta/releases/download/${GIT_DELTA_VERSION}/git-delta_${GIT_DELTA_VERSION}_${ARCH}.deb" && \
  sudo dpkg -i "git-delta_${GIT_DELTA_VERSION}_${ARCH}.deb" && \
  rm "git-delta_${GIT_DELTA_VERSION}_${ARCH}.deb"

# wasmtime CLI — runs the warm-runtime perf benchmarks (#1580/#1746) that
# refresh the committed landing-page benchmark JSON, and the native-messaging
# smoke test. Pinned to v46 to match CI
# (.github/workflows/native-messaging-smoke.yml); do NOT switch to
# --all-proposals (it enables stack-switching, which these modules don't use).
# Arch-aware: amd64->x86_64, arm64->aarch64.
ARG WASMTIME_VERSION=v46.0.1
RUN ARCH=$(dpkg --print-architecture) && \
  case "$ARCH" in \
    amd64) WT_ARCH=x86_64 ;; \
    arm64) WT_ARCH=aarch64 ;; \
    *) echo "unsupported arch: $ARCH" && exit 1 ;; \
  esac && \
  WT_DIR="wasmtime-${WASMTIME_VERSION}-${WT_ARCH}-linux" && \
  wget -O- "https://github.com/bytecodealliance/wasmtime/releases/download/${WASMTIME_VERSION}/${WT_DIR}.tar.xz" | tar xJ && \
  mv "${WT_DIR}/wasmtime" /usr/local/bin/wasmtime && \
  rm -rf "${WT_DIR}" && \
  /usr/local/bin/wasmtime --version

# deno CLI — runs the standalone Native Messaging test harnesses (e.g.
# guest271314's nm_standalone_test.js from loopdive/js2wasm#389) and other
# Deno-based standalone-mode checks. Ships release .zip only (unzip is in the
# apt block above). Arch-aware: amd64->x86_64, arm64->aarch64.
ARG DENO_VERSION=v2.8.3
RUN ARCH=$(dpkg --print-architecture) && \
  case "$ARCH" in \
    amd64) DENO_ARCH=x86_64 ;; \
    arm64) DENO_ARCH=aarch64 ;; \
    *) echo "unsupported arch: $ARCH" && exit 1 ;; \
  esac && \
  DENO_ZIP="deno-${DENO_ARCH}-unknown-linux-gnu.zip" && \
  wget -O /tmp/deno.zip "https://github.com/denoland/deno/releases/download/${DENO_VERSION}/${DENO_ZIP}" && \
  unzip -o /tmp/deno.zip -d /usr/local/bin && \
  rm /tmp/deno.zip && \
  chmod +x /usr/local/bin/deno && \
  /usr/local/bin/deno --version

# bun — reproduces the loopdive/js2wasm#389 reporter's exact toolchain: he
# `bun build`s the native-messaging TS to .js, then compiles that .js with
# js2wasm. Baking bun into the image lets CI/agents replay that transpile-to-JS
# flow, which exercises a different, looser-typed compiler path than the direct
# .ts route (e.g. `Deno.stdin.readSync`'s `number | null` return collapsing once
# the type annotation is stripped). Ships a release .zip (unzip is in the apt
# block above). Arch-aware: amd64->x64, arm64->aarch64.
ARG BUN_VERSION=bun-v1.3.14
RUN ARCH=$(dpkg --print-architecture) && \
  case "$ARCH" in \
    amd64) BUN_ARCH=x64 ;; \
    arm64) BUN_ARCH=aarch64 ;; \
    *) echo "unsupported arch: $ARCH" && exit 1 ;; \
  esac && \
  BUN_ZIP="bun-linux-${BUN_ARCH}.zip" && \
  wget -O /tmp/bun.zip "https://github.com/oven-sh/bun/releases/download/${BUN_VERSION}/${BUN_ZIP}" && \
  unzip -o /tmp/bun.zip -d /tmp/bun && \
  mv "/tmp/bun/bun-linux-${BUN_ARCH}/bun" /usr/local/bin/bun && \
  rm -rf /tmp/bun.zip /tmp/bun && \
  chmod +x /usr/local/bin/bun && \
  ln -sf /usr/local/bin/bun /usr/local/bin/bunx && \
  /usr/local/bin/bun --version

COPY .tmux.conf /home/node/.tmux.conf
RUN chown node:node /home/node/.tmux.conf

# Set up non-root user
USER node

# Install global packages
ENV NPM_CONFIG_PREFIX=/usr/local/share/npm-global
ENV PATH=$PATH:/usr/local/share/npm-global/bin

# Debian's /etc/profile HARDCODES PATH for non-root login shells, clobbering the
# ENV PATH set above. Every LOGIN shell - which includes every ssh session and
# any `bash -l` / `zsh -l`, and therefore anything tmux or ttyd starts that way -
# then loses /usr/local/share/npm-global/bin, and `claude` / `pnpm` report
# "command not found" despite being installed. profile.d is sourced after
# /etc/profile has set PATH, so re-adding it there wins; zsh needs the explicit
# hook because it does not read /etc/profile.d on its own.
USER root
RUN printf '%s\n' \
      'case ":$PATH:" in' \
      '  *":/usr/local/share/npm-global/bin:"*) ;;' \
      '  *) PATH="$PATH:/usr/local/share/npm-global/bin" ;;' \
      'esac' \
      'export PATH' \
      > /etc/profile.d/npm-global-path.sh && \
    chmod 644 /etc/profile.d/npm-global-path.sh && \
    mkdir -p /etc/zsh && \
    echo '. /etc/profile.d/npm-global-path.sh' >> /etc/zsh/zshenv
USER node

# Set the default shell to zsh rather than sh
ENV SHELL=/bin/zsh

# Set the default editor and visual
ENV EDITOR=nano
ENV VISUAL=nano

# Default powerline10k theme
ARG ZSH_IN_DOCKER_VERSION=1.2.0
RUN sh -c "$(wget -O- https://github.com/deluan/zsh-in-docker/releases/download/v${ZSH_IN_DOCKER_VERSION}/zsh-in-docker.sh)" -- \
  -p git \
  -p fzf \
  -a "source /usr/share/doc/fzf/examples/key-bindings.zsh" \
  -a "source /usr/share/doc/fzf/examples/completion.zsh" \
  -a "export PROMPT_COMMAND='history -a' && export HISTFILE=/commandhistory/.bash_history" \
  -x

# Install Claude
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} pnpm
RUN npm i -g @openai/codex

# Copy and set up firewall script
COPY init-firewall.sh /usr/local/bin/
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
USER root
RUN chmod +x /usr/local/bin/init-firewall.sh /usr/local/bin/entrypoint.sh && \
  echo "node ALL=(root) NOPASSWD: /usr/local/bin/init-firewall.sh" > /etc/sudoers.d/node-firewall && \
  echo "node ALL=(root) NOPASSWD: /usr/sbin/sshd" >> /etc/sudoers.d/node-firewall && \
  echo "node ALL=(root) NOPASSWD: /usr/bin/chown" >> /etc/sudoers.d/node-firewall && \
  chmod 0440 /etc/sudoers.d/node-firewall

# Configure sshd
RUN mkdir -p /var/run/sshd && \
  sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config && \
  sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config && \
  sed -i 's/^#\?Port .*/Port 2222/' /etc/ssh/sshd_config

# Set up authorized_keys for the node user
RUN mkdir -p /home/node/.ssh && \
  echo "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILMHAw2zZFdfHrwm1rMkZwnbyyxwrpAFBVqdoNKy+vxL thomas@loopdive" > /home/node/.ssh/authorized_keys && \
  echo "ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBFcvGGPtofV8AJzI504ynCSq2/zTzXojlNavftdhVtu196tJ6Oo3A1lm8PpK2ijHRhrJAoJ4rrMVcTnolO5Guac=" >> /home/node/.ssh/authorized_keys && \
  chmod 700 /home/node/.ssh && \
  chmod 600 /home/node/.ssh/authorized_keys && \
  chown -R node:node /home/node/.ssh

# Auto-attach/create tmux session on SSH login
RUN echo 'if [ -n "$SSH_CONNECTION" ] && [ -z "$TMUX" ] && [ -t 0 ]; then tmux ls 2>/dev/null; fi' >> /home/node/.bashrc

# Install ttyd for web-based terminal access (phone/remote)
RUN wget -q "https://github.com/tsl0922/ttyd/releases/latest/download/ttyd.$(uname -m)" -O /usr/local/bin/ttyd && \
  chmod +x /usr/local/bin/ttyd

USER node

# Starts sshd on every container boot/restart (not just via devcontainer
# postStartCommand, which doesn't re-fire on a bare `docker restart`).
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
