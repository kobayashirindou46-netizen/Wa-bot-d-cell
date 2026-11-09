#!/data/data/com.termux/files/usr/bin/bash
# Dipanggil otomatis oleh Termux:Boot saat HP menyala.
termux-wake-lock 2>/dev/null
cd ~/wa-bot
nohup bash start.sh > ~/wa-bot/bot.log 2>&1 &
