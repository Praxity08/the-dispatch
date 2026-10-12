#!/bin/sh
# Loads secrets kept in the macOS Keychain into the environment, then runs the given command.
# Locally the Gemini key and Gmail app password never live in a file; on Vercel they are encrypted env vars.
if [ -z "$GEMINI_API_KEY" ] && command -v security >/dev/null 2>&1; then
  GEMINI_API_KEY=$(security find-generic-password -a "$USER" -s "the-dispatch.GEMINI_API_KEY" -w 2>/dev/null)
  export GEMINI_API_KEY
fi
if [ -z "$GMAIL_APP_PASSWORD" ] && command -v security >/dev/null 2>&1; then
  GMAIL_APP_PASSWORD=$(security find-generic-password -a "$USER" -s "the-dispatch.GMAIL_APP_PASSWORD" -w 2>/dev/null)
  [ -n "$GMAIL_APP_PASSWORD" ] && export GMAIL_APP_PASSWORD
fi
exec "$@"
