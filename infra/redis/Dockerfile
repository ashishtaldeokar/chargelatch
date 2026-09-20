FROM redis:8-alpine

COPY redis.conf /usr/local/etc/redis/redis.conf

# Required: Testcontainers under Bun only works reliably with Wait.forHealthCheck().
HEALTHCHECK --interval=2s --timeout=3s --start-period=5s --retries=30 \
  CMD ["redis-cli", "ping"]

CMD ["redis-server", "/usr/local/etc/redis/redis.conf"]
