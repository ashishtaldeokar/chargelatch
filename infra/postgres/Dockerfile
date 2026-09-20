# Postgres 17 + TimescaleDB + PostGIS. The -ha image is Timescale's official build that
# bundles PostGIS; the plain timescale/timescaledb image does not.
FROM timescale/timescaledb-ha:pg17.11-ts2.30.1

COPY init/ /docker-entrypoint-initdb.d/

# -h 127.0.0.1 matters: during first-boot init the entrypoint runs a temporary server on the
# unix socket only, then restarts. Probing TCP means "healthy" is only reported once init
# scripts have finished and the real server is up.
# Required: Testcontainers under Bun only works reliably with Wait.forHealthCheck().
HEALTHCHECK --interval=2s --timeout=3s --start-period=5s --retries=60 \
  CMD ["pg_isready", "-h", "127.0.0.1", "-U", "postgres", "-d", "chargelatch"]
