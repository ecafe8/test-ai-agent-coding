FROM node:22-bookworm

RUN npm install --global @opencode/cli@2.2.1
RUN mkdir -p /etc/opencode

COPY config.mjs model-config.mjs runner.mjs cli.mjs /opt/portable-agent/
WORKDIR /workspace
ENTRYPOINT ["node", "/opt/portable-agent/cli.mjs"]
