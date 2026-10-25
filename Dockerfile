# flypi in a container: `docker run` and it is serving — no start command, no shell, no npm install.
#
#   docker build -t flypi .
#   docker run -d --name flypi -p 127.0.0.1:8791:8791 -v flypi-data:/data flypi
#   open http://localhost:8791/
#
# The image installs the published npm package, so an image and `npm install -g @makerstufferupper/flypi`
# cannot drift. `--build-arg FLYPI_VERSION=<version>` pins it.

# 24, not the 22.19 floor in package.json: flypi uses the built-in node:sqlite.
FROM node:24-slim

# The agent has a bash tool, so the tools a turn reaches for are installed the way a developer's shell has
# them: git over https, git-lfs, curl, wget. Slim ships none of them, and git-lfs is only useful with its
# filters registered — the binary alone leaves `git clone` of an LFS repo holding pointer files.
RUN apt-get update \
	&& apt-get install -y --no-install-recommends ca-certificates curl git git-lfs wget \
	&& git lfs install --system \
	&& rm -rf /var/lib/apt/lists/*

ARG FLYPI_VERSION=latest
RUN npm install -g --no-audit --no-fund @makerstufferupper/flypi@${FLYPI_VERSION}

# It does not run as root, though. /data is the state root: FLYPI_ROOT is where an
# installed flypi keeps `.flypi/` — config, sessions, memory db, secrets, and the memory models.
RUN groupadd --gid 10001 flypi \
	&& useradd --uid 10001 --gid 10001 --create-home flypi \
	&& mkdir -p /data \
	&& chown flypi:flypi /data
USER flypi
ENV FLYPI_ROOT=/data

# `--host 0.0.0.0` because a published port cannot reach the container's own loopback, and `--port` so it is
# a number you can map. `--foreground` keeps the daemon under PID 1, so `docker stop` reaches it and it runs
# its own shutdown (pid file removed, sockets closed, an in-flight turn recorded as interrupted).
EXPOSE 8791
CMD ["flypi", "start", "--foreground", "--port", "8791", "--host", "0.0.0.0"]

# /healthz needs no token, so the check needs none either. The first start fetches ~900 MB of memory models
# before it is listening, hence the long grace period; a volume on /data makes that once per machine.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15m --retries=3 \
	CMD node -e "fetch('http://127.0.0.1:8791/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
