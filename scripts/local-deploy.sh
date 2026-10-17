#!/usr/bin/env bash
# (Re)deploy the local Teros stack under pm2 from this checkout: backend :10001,
# frontend :10002, container-agent :10011 (see ecosystem.config.cjs).
#
# Builds the shared/core packages the backend imports from dist/, syncs the MCA
# and model catalogues (what `yarn start` does, but pm2 runs tsx directly), then
# starts or reloads the three apps and saves the process list for `pm2 resurrect`.
#
#   scripts/local-deploy.sh            # build + sync + start/reload
#   SKIP_INSTALL=1 scripts/local-deploy.sh
set -euo pipefail

cd "$(dirname "$0")/.."

if [ -z "${SKIP_INSTALL:-}" ]; then
  yarn install --frozen-lockfile
fi
yarn build:shared
yarn build:core
yarn sync

pm2 startOrReload ecosystem.config.cjs --update-env
pm2 save

curl -s --retry 40 --retry-connrefused --retry-delay 2 -o /dev/null -w "backend /health: %{http_code}\n" \
  http://localhost:10001/health
