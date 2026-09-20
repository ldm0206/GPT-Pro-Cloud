#!/usr/bin/with-contenv bash
# ChatGPT 在桌面里下载的文件留在容器内。Kasm 会把 ~/Downloads 挂到
# www/Downloads，网页端一旦请求就会把文件存到观看者电脑上。
set -e

mkdir -p /config/gpc-downloads /config/.config /etc/chromium/policies/managed
chown "${PUID:-1000}:${PGID:-1000}" /config/gpc-downloads 2>/dev/null || true
cat > /config/.config/user-dirs.dirs <<'EOF'
XDG_DOWNLOAD_DIR="$HOME/gpc-downloads"
EOF
chown "${PUID:-1000}:${PGID:-1000}" /config/.config/user-dirs.dirs 2>/dev/null || true
cat > /etc/chromium/policies/managed/gpc-downloads.json <<'EOF'
{
  "DefaultDownloadDirectory": "/config/gpc-downloads",
  "DownloadDirectory": "/config/gpc-downloads",
  "PromptForDownloadLocation": false
}
EOF

for root in /usr/share/kasmvnc/www /usr/local/share/kasmvnc/www; do
  [ -d "$root" ] || continue
  rm -f "$root/Downloads/Downloads"
  if [ -e "$root/Downloads" ] || [ -L "$root/Downloads" ]; then
    rm -rf "$root/Downloads"
  fi
  mkdir -p "$root/Downloads"
  printf '%s\n' '<!doctype html><title>ChatGPT</title>' > "$root/Downloads/index.html"
done

echo "[gpc-no-file-leak] Downloads web export disabled"
