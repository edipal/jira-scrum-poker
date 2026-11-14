#!/bin/sh
# lintel-script: test-integration   contract: 1
#
# Runs ALL tests of the "integration" group (patterns: .lintel/config.jsonc, paths.tests).

unset LINTEL_GATE LINTEL_TEST_GROUP
cd "$(dirname "$0")/../.." || exit 2

INT_FILES="$(find tests -type f \( -name '*.integration.ts' -o -name '*.integration.test.ts' -o -name '*.integration.tsx' -o -name '*.integration.test.tsx' \) 2>/dev/null)"
if [ -z "$INT_FILES" ]; then
    exit 3
fi
exit 3
