#!/bin/sh
# dumb-init owns PID 1. Keep the pinned upstream bootstrap and privilege drop,
# but do not run s6's persisted-profile reconciler alongside gateway run.
set -eu
export PATH="/command:/package/admin/s6/command:$PATH"
export HERMES_GATEWAY_NO_SUPERVISE=1
/opt/hermes/docker/stage2-hook.sh
exec /opt/hermes/docker/main-wrapper.sh "$@"
