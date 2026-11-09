#!/data/data/com.termux/files/usr/bin/bash
# Jalankan ini untuk mengambil update terbaru dari GitHub lalu memasangnya.
# Dipakai setelah bot pernah dipasang dengan "git clone" (lihat PANDUAN-TERMUX.txt,
# bagian "UPDATE OTOMATIS LEWAT GITHUB").
cd "$(dirname "$0")"
echo ">> Mengambil perubahan terbaru dari GitHub..."
git pull
if [ $? -ne 0 ]; then
  echo ">> Gagal mengambil update. Pastikan HP terhubung internet dan folder ini hasil 'git clone'."
  exit 1
fi
echo ">> Memasang ulang kebutuhan (kalau ada yang baru)..."
npm install
echo ">> Selesai! Jalankan bot lagi dengan: bash start.sh"
