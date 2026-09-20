FROM emqx/emqx:6.3.1

COPY --chown=emqx:emqx emqx.conf /opt/emqx/etc/emqx.conf

# /status is unauthenticated and only reports "running" once the broker accepts connections.
# Required: Testcontainers under Bun only works reliably with Wait.forHealthCheck().
HEALTHCHECK --interval=2s --timeout=3s --start-period=10s --retries=60 \
  CMD curl -fsS http://127.0.0.1:18083/status | grep -q "emqx is running"
