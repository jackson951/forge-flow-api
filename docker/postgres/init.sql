-- Runs once, when the Postgres volume is first initialised (docker-entrypoint-initdb.d).
-- Integration and E2E tests use this separate database (DATABASE_URL + "_test"); their
-- global setup also creates and migrates it if it is missing.
CREATE DATABASE flowforge_test;
