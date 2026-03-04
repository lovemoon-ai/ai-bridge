#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
NPM_REGISTRY=${NPM_REGISTRY:-https://registry.npmjs.org/}
PACKAGE_JSON="$ROOT_DIR/package.json"

get_current_version() {
  node -e '
    const fs = require("fs");
    const pkg = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    console.log(pkg.version);
  ' "$PACKAGE_JSON"
}

increment_patch() {
  local version=$1
  local major=$(echo "$version" | cut -d. -f1)
  local minor=$(echo "$version" | cut -d. -f2)
  local patch=$(echo "$version" | cut -d. -f3)
  echo "${major}.${minor}.$((patch + 1))"
}

update_package_json_version() {
  local package_json_path=$1
  local version=$2
  node -e '
    const fs = require("fs");
    const path = process.argv[1];
    const version = process.argv[2];
    const pkg = JSON.parse(fs.readFileSync(path, "utf8"));
    pkg.version = version;
    fs.writeFileSync(path, JSON.stringify(pkg, null, 2) + "\n");
  ' "$package_json_path" "$version"
}

TMP_NPMRC=""
cleanup() {
  if [[ -n "$TMP_NPMRC" ]]; then
    rm -f "$TMP_NPMRC"
  fi
}
trap cleanup EXIT

CURRENT_VERSION=$(get_current_version)

if [[ $# -lt 1 ]]; then
  TARGET_VERSION=$(increment_patch "$CURRENT_VERSION")
  echo "No version specified. Auto-incrementing patch version."
  echo "Current: ${CURRENT_VERSION}"
  echo "Target:  ${TARGET_VERSION}"
  echo ""
  read -p "Proceed with ${TARGET_VERSION}? [Y/n] " answer
  if [[ -n "${answer:-}" && "${answer:-}" != "y" && "${answer:-}" != "Y" ]]; then
    echo "Aborted."
    exit 1
  fi
else
  TARGET_VERSION=$1
fi

echo "Updating package version to ${TARGET_VERSION}..."
update_package_json_version "$PACKAGE_JSON" "$TARGET_VERSION"

if [[ -n "${NPM_TOKEN:-}" ]]; then
  TMP_NPMRC=$(mktemp)
  printf "//registry.npmjs.org/:_authToken=%s\n" "$NPM_TOKEN" > "$TMP_NPMRC"
  printf "registry=%s\n" "$NPM_REGISTRY" >> "$TMP_NPMRC"
  export NPM_CONFIG_USERCONFIG="$TMP_NPMRC"
else
  npm whoami >/dev/null
fi

DRY_RUN=${DRY_RUN:-0}
PUBLISH_FLAGS=(--access public)
if [[ -n "${NPM_OTP:-}" ]]; then
  PUBLISH_FLAGS+=(--otp "$NPM_OTP")
fi
if [[ "$DRY_RUN" == "1" ]]; then
  PUBLISH_FLAGS+=(--dry-run)
fi

echo "==> Installing dependencies..."
cd "$ROOT_DIR"
if [[ -f "pnpm-lock.yaml" ]] && command -v pnpm >/dev/null 2>&1; then
  pnpm install
else
  npm install
fi

echo "==> Building..."
npm run build

echo "==> Publishing @love-moon/ai-bridge@${TARGET_VERSION}..."
if ! npm publish "${PUBLISH_FLAGS[@]}"; then
  echo "npm publish failed"
  exit 1
fi

echo "✓ Successfully published @love-moon/ai-bridge@${TARGET_VERSION}"
