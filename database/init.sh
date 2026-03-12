#!/bin/bash
set -e

# Create the test database and load the schema into both dev and test DBs
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" <<-EOSQL
  CREATE DATABASE atlantic_referral_test;
EOSQL

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "atlantic_referral_test" -f /docker-entrypoint-initdb.d/01-schema.sql
