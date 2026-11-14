#!/bin/sh
# lintel-script: build   contract: 1
#
# Compiles and validates the project without running tests (used by QA and DEV personas).

cd "$(dirname "$0")/../.." || exit 2

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

if [ ! -d node_modules ]; then
    sh ./.lintel/scripts/setup.sh || exit 2
fi

if ! command -v node >/dev/null 2>&1; then
    echo "lintel: node not found on PATH" >&2
    exit 2
fi

for bin in biome tsc vite; do
    if [ ! -x "./node_modules/.bin/$bin" ]; then
        echo "lintel: ./node_modules/.bin/$bin not found" >&2
        exit 2
    fi
done

if [ ! -f manifest.yml ]; then
    echo "error: manifest.yml is missing" >&2
    exit 1
fi

if grep -Eq '^[[:space:]]*external:' manifest.yml; then
    echo "error: manifest.yml declares external egress; app must remain Runs on Atlassian compliant" >&2
    exit 1
fi

./node_modules/.bin/biome lint || exit 1
./node_modules/.bin/biome format || exit 1
./node_modules/.bin/tsc --noEmit || exit 1
./node_modules/.bin/vite build || exit 1

exit 0
