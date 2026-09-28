#!/usr/bin/env bash
# Layer 10-devtools — verify. Non-zero exit = FAIL.
set -euo pipefail
rustc --version
cargo --version
python3 --version
pip --version
cmake --version | head -1
gcc --version | head -1
make --version | head -1
