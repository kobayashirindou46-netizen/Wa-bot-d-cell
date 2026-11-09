#!/data/data/com.termux/files/usr/bin/bash
# Jalankan bot dan otomatis coba lagi kalau berhenti/crash.
cd "$(dirname "$0")"
termux-wake-lock 2>/dev/null
while true; do
  node index.js
  echo "Bot berhenti, mencoba lagi dalam 5 detik..."
  sleep 5
done
