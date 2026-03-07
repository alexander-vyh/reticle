#!/bin/bash
set -euo pipefail

CONFIG_DIR="$HOME/.config/reticle"
mkdir -p "$CONFIG_DIR"

if [ -z "${BW_SESSION:-}" ]; then
  echo "ERROR: BW_SESSION not set. Run: export BW_SESSION=\$(bw unlock --raw)"
  exit 1
fi

ITEM_NAME="Reticle Automation Secrets"
ITEM=$(bw get item "$ITEM_NAME" 2>/dev/null) || {
  echo "ERROR: Bitwarden item '$ITEM_NAME' not found"
  exit 1
}

# Extract fields from Bitwarden item (stored as custom fields)
get_field() { echo "$ITEM" | jq -r ".fields[] | select(.name==\"$1\") | .value // empty"; }

cat > "$CONFIG_DIR/secrets.json" <<EOF
{
  "slackBotToken": "$(get_field slackBotToken)",
  "slackAppToken": "$(get_field slackAppToken)",
  "slackSigningSecret": "$(get_field slackSigningSecret)",
  "slackUserId": "$(get_field slackUserId)",
  "slackUsername": "$(get_field slackUsername)",
  "gmailAccount": "$(get_field gmailAccount)"
}
EOF

chmod 600 "$CONFIG_DIR/secrets.json"
echo "Wrote $CONFIG_DIR/secrets.json"
