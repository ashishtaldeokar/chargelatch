FROM quay.io/keycloak/keycloak:26.7.4

ENV KC_HEALTH_ENABLED=true

COPY realms/ /opt/keycloak/data/import/
COPY themes/ /opt/keycloak/themes/

# The image ships neither curl nor wget, and health endpoints live on the management
# port 9000 (not 8080), so probe it with bash's /dev/tcp.
# Required: Testcontainers under Bun only works reliably with Wait.forHealthCheck().
HEALTHCHECK --interval=2s --timeout=5s --start-period=15s --retries=60 \
  CMD ["/bin/bash", "-c", "exec 3<>/dev/tcp/127.0.0.1/9000 && printf 'GET /health/ready HTTP/1.1\\r\\nHost: localhost\\r\\nConnection: close\\r\\n\\r\\n' >&3 && grep -q '200 OK' <&3"]

ENTRYPOINT ["/opt/keycloak/bin/kc.sh"]
CMD ["start-dev", "--import-realm"]
