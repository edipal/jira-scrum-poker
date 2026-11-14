#!/bin/sh
# lintel-script: setup   contract: 1
#
# Prepares shared environment before test groups or build scripts run.

set -e
cd "$(dirname "$0")/../.."

for d in \
    "$HOME/.local/bin" \
    "$HOME/.local/share/fnm/aliases/default/bin" \
    "$HOME/.local/share/fnm/aliases/default/lib/node_modules/corepack/shims" \
    "$HOME/Library/Application Support/fnm/aliases/default/bin" \
    "$HOME/Library/pnpm" \
    "/opt/homebrew/bin" \
    "/usr/local/bin"; do
    if [ -d "$d" ]; then
        PATH="$d:$PATH"
    fi
done
for nvm_bin in "$HOME"/.nvm/versions/node/*/bin; do
    if [ -d "$nvm_bin" ]; then
        PATH="$nvm_bin:$PATH"
    fi
done
export PATH

MAIN_ROOT="$(git worktree list --porcelain 2>/dev/null | sed -n 's/^worktree //p' | head -n 1)"

if [ ! -d node_modules ]; then
    rm -f node_modules
    if [ -n "$MAIN_ROOT" ] && [ -d "$MAIN_ROOT/node_modules" ]; then
        cp -Rc "$MAIN_ROOT/node_modules" node_modules 2>/dev/null || cp -R "$MAIN_ROOT/node_modules" node_modules
    else
        npm ci
    fi
fi

exit 0
