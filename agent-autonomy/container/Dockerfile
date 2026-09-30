# Agent container image for AgentControl (M10).
# Build with:  python3 agent-autonomy/app.py --build-agent-image
# The build context is the folder that holds your opencode binary, so the container runs
# the same OpenCode version as your host. Nothing here starts a network service.
ARG BASE=debian:bookworm-slim
FROM ${BASE}
ARG OPENCODE=opencode
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git python3 nodejs npm \
      xvfb xdotool imagemagick fonts-dejavu-core procps \
 && rm -rf /var/lib/apt/lists/*
COPY ${OPENCODE} /usr/local/bin/opencode
RUN chmod 0755 /usr/local/bin/opencode && mkdir -p /agentcontrol && chmod 0777 /agentcontrol
# Agents run as your user (rootless runtimes map container root to you); HOME is a mounted folder.
WORKDIR /agentcontrol
