#!/usr/bin/env bash
# NOVA Mail CLI - Unix installer (macOS / Linux)
# Downloads the latest nova.mjs and installs a `nova` command.
set -e

BASE="${NOVA_CLI_BASE:-https://nova-email.com}"
DEST="${HOME}/.nova-cli"
BIN="${DEST}/nova.mjs"

printf "\n Installing NOVA Mail CLI...\n"
mkdir -p "${DEST}"

if command -v curl >/dev/null 2>&1; then
  curl -fsSL "${BASE}/cli/nova.mjs" -o "${BIN}"
elif command -v wget >/dev/null 2>&1; then
  wget -q "${BASE}/cli/nova.mjs" -O "${BIN}"
else
  echo "Need curl or wget to download." >&2
  exit 1
fi
chmod +x "${BIN}"

cat > "${DEST}/nova" <<EOF
#!/usr/bin/env bash
exec node "${BIN}" "\$@"
EOF
chmod +x "${DEST}/nova"

# Symlink into a location already on PATH if possible.
for dir in "${HOME}/.local/bin" "${HOME}/bin" "/usr/local/bin"; do
  if printf '%s' "$PATH" | tr ':' '\n' | grep -qx "${dir}" && [ -w "${dir}" ]; then
    ln -sf "${DEST}/nova" "${dir}/nova"
    echo " Installed 'nova' into ${dir}"
    printf "\n Run:  nova login\n"
    exit 0
  fi
done

printf "\n Add %s to your PATH, then run:  nova login\n" "${DEST}"
