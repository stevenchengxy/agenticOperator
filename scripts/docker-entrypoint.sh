#!/bin/sh
set -eu

role="${1:-web}"
if [ "$#" -gt 0 ]; then
  shift
fi

run_env_check() {
  if [ "${DEPLOY_SKIP_ENV_CHECK:-0}" = "1" ]; then
    echo "[entrypoint] WARNING: production env check skipped by DEPLOY_SKIP_ENV_CHECK=1"
    return
  fi
  echo "[entrypoint] validating production environment"
  /app/node_modules/.bin/tsx /app/scripts/check-env.ts
}

sync_schema() {
  if [ "${DATABASE_SCHEMA_SYNC:-1}" = "0" ]; then
    echo "[entrypoint] schema sync disabled (DATABASE_SCHEMA_SYNC=0)"
    return
  fi
  echo "[entrypoint] applying additive Prisma schema changes"
  # Intentionally omit --accept-data-loss and --force-reset. A destructive
  # drift makes the container fail closed so an operator can inspect it.
  /app/node_modules/.bin/prisma db push
}

case "$role" in
  web)
    run_env_check
    sync_schema
    echo "[entrypoint] starting Agentic Operator on ${HOSTNAME:-0.0.0.0}:${PORT:-3002}"
    exec /app/node_modules/.bin/next start -H "${HOSTNAME:-0.0.0.0}" -p "${PORT:-3002}" "$@"
    ;;
  archiver)
    echo "[entrypoint] starting durable Inngest archiver"
    exec /app/node_modules/.bin/tsx /app/scripts/inngest-archiver.ts "$@"
    ;;
  monitor-sweeper)
    echo "[entrypoint] starting monitor sweeper"
    exec /app/node_modules/.bin/tsx /app/scripts/monitor-sweeper.ts "$@"
    ;;
  db-push)
    sync_schema
    ;;
  env-check)
    run_env_check
    ;;
  *)
    exec "$role" "$@"
    ;;
esac

