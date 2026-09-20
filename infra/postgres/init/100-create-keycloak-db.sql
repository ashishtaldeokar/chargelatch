-- Keycloak's own database (KC_DB_URL in docker-compose.yml).
--
-- NOTE: Postgres runs the scripts in this directory ONLY on the first boot of an empty data
-- volume. If you add or change a file here later, existing dev environments need the same
-- statements run by hand (docker compose exec postgres psql -U postgres ...) or a full
-- reset with `docker compose down -v`.
--
-- Files are numbered from 100 so they run after the base image's own 000-010 scripts, which
-- install timescaledb into template1 (so every database created here inherits it).
CREATE DATABASE keycloak;
