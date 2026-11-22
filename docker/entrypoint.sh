#!/bin/sh
# Container start: set the git author FryDay Code commits as, when given, then run core.
# The identity comes from GIT_USER_NAME / GIT_USER_EMAIL (docker-compose.yml), never from the image.
set -eu
if [ -n "${GIT_USER_NAME:-}" ]; then git config --global user.name "$GIT_USER_NAME"; fi
if [ -n "${GIT_USER_EMAIL:-}" ]; then git config --global user.email "$GIT_USER_EMAIL"; fi
exec "$@"
