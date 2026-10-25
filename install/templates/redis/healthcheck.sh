#!/bin/sh
# Redis HEALTHCHECK. The password goes to redis-cli through REDISCLI_AUTH (environment), not argv.
REDISCLI_AUTH="$(sed -n 's/^requirepass //p' /opt/app/cflex/secrets/auth.conf)"
export REDISCLI_AUTH
redis-cli -h 127.0.0.1 -p 6379 ping | grep -q PONG
