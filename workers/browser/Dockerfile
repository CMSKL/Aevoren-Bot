FROM node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20

WORKDIR /opt/aevoren-browser-worker
COPY package.json ./
RUN npm install --omit=dev --ignore-scripts --no-audit --no-fund \
    && PLAYWRIGHT_BROWSERS_PATH=/opt/aevoren-browsers node node_modules/playwright-core/cli.js install --with-deps chromium \
    && apt-get update && apt-get install -y --no-install-recommends xvfb openbox x11vnc xdotool ffmpeg tini ca-certificates \
    && rm -rf /var/lib/apt/lists/* /root/.npm \
    && mkdir -p /var/lib/aevoren-browser-state /var/lib/aevoren-browser-profile /var/lib/aevoren-browser-downloads \
    && chmod 700 /var/lib/aevoren-browser-state /var/lib/aevoren-browser-profile /var/lib/aevoren-browser-downloads \
    && chown 1000:1000 /var/lib/aevoren-browser-profile /var/lib/aevoren-browser-downloads \
    && find /usr /bin /sbin -xdev -type f -perm /6000 -exec chmod a-s {} +

LABEL io.aevoren.role="browser-worker" io.aevoren.worker-version="1.1.0"
COPY index.mjs engine.mjs ./
USER root
EXPOSE 8081
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/node", "/opt/aevoren-browser-worker/index.mjs"]
