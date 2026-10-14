FROM node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-venv python3-pip git build-essential util-linux tini ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && for uid in $(seq 1010 1041); do useradd --uid "$uid" --gid 1000 --no-create-home --shell /bin/bash "aevoren-job-$uid"; done \
    && mkdir -p /workspace /var/lib/aevoren /opt/aevoren-worker \
    && chown 1000:1000 /workspace && chmod 2770 /workspace && chmod 700 /var/lib/aevoren \
    && find /usr /bin /sbin -xdev -type f -perm /6000 -exec chmod a-s {} +

LABEL io.aevoren.role="execution-worker" io.aevoren.worker-version="1.2.0"
COPY . /opt/aevoren-worker/
WORKDIR /opt/aevoren-worker
USER root
EXPOSE 8080
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/node", "/opt/aevoren-worker/index.mjs"]
