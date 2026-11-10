/* ---------------------------------------------------------------------
   Bot WhatsApp Buku Kas D'Cell
   Membaca pesan yang ANDA KIRIM SENDIRI (bukan dari orang lain) di chat
   langsung (bukan grup), lalu mencatatnya ke Firestore memakai aturan
   penulisan yang sama seperti fitur "Tempel pesan WhatsApp" di aplikasi.
   Juga bisa membalas saldo saat ini kalau Anda ketik "saldo".
------------------------------------------------------------------------ */
'use strict';

var fs = require('fs');
var path = require('path');
var qrcode = require('qrcode-terminal');
var pino = require('pino');
var admin = require('firebase-admin');
var {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');

var WA = require('./waParser');
var TOKO = require('./toko');
var waLine = WA.waLine, TYPES = WA.TYPES, ADM = WA.ADM, calcBalance = WA.calcBalance;

var ROOT = __dirname;
var SESSION_DIR = path.join(ROOT, 'session');
var SA_PATH = path.join(ROOT, 'serviceAccountKey.json');
var TOKO_PATH = path.join(ROOT, 'toko.json');
var logger = pino({ level: 'silent' });

/* ---------- Firebase ---------- */
if (!fs.existsSync(SA_PATH)) {
  console.error('\n[GAGAL] Tidak menemukan serviceAccountKey.json di folder ini.');
  console.error('Unduh dari Firebase Console > Project settings > Service accounts > Generate new private key,');
  console.error('lalu simpan file itu persis dengan nama "serviceAccountKey.json" di folder wa-bot.\n');
  process.exit(1);
}
admin.initializeApp({ credential: admin.credential.cert(require(SA_PATH)) });
var db = admin.firestore();

/* ---------- cari toko (shopId) -----------
   Sejak aplikasi diperbarui ke struktur multi-toko, semua data pindah ke
   shops/{shopId}/tx, shops/{shopId}/acc, dst. Untuk pemilik (owner),
   shopId = uid akun owner itu sendiri. Bot mencari otomatis siapa pemiliknya
   lewat koleksi "users", supaya tidak perlu diisi manual. */
var ownShopId = null;
/* toko.json boleh berupa daftar [ ... ] atau { "utama": {...}, "toko": [ ... ] } */
function readTokoFile() {
  if (!fs.existsSync(TOKO_PATH)) return { utama: null, list: null };
  try {
    var j = JSON.parse(fs.readFileSync(TOKO_PATH, 'utf8'));
    if (Array.isArray(j)) return { utama: null, list: j };
    if (j && typeof j === 'object') return { utama: j.utama || null, list: Array.isArray(j.toko) ? j.toko : [] };
  } catch (e) { console.error('[PERINGATAN] toko.json tidak bisa dibaca (' + e.message + ').'); }
  return { utama: null, list: null };
}
function shopByEmail(email) {
  return db.collection('users').where('email', '==', String(email).trim().toLowerCase()).limit(5).get().then(function (snap) {
    var d = snap.docs.filter(function (x) { return x.data().role === 'owner'; })[0];
    if (!d) throw new Error('akun pemilik dengan email "' + email + '" tidak ditemukan. Pastikan sudah daftar dan login di aplikasi.');
    return d.data().shopId || d.id;
  });
}
function resolveShopId() {
  if (ownShopId) return Promise.resolve(ownShopId);
  var u = readTokoFile().utama;
  if (u && (u.shopId || u.email)) {
    return (u.shopId ? Promise.resolve(u.shopId) : shopByEmail(u.email)).then(function (sid) {
      ownShopId = sid;
      console.log('Toko utama (dari toko.json), shopId:', ownShopId);
      return ownShopId;
    });
  }
  return db.collection('users').where('role', '==', 'owner').limit(2).get().then(function (snap) {
    if (snap.empty) {
      throw new Error('Tidak menemukan akun pemilik (owner) di Firestore. Pastikan aplikasi web sudah pernah dibuka dan login minimal sekali.');
    }
    if (snap.size > 1) {
      console.error('[PERINGATAN] Ada lebih dari satu akun pemilik di Firestore, jadi bot tidak bisa menebak toko utama Anda. ' +
        'Isi bagian "utama" di toko.json dengan email akun Anda (lihat PANDUAN-TOKO-LAIN.txt).');
    }
    var d = snap.docs[0];
    ownShopId = d.data().shopId || d.id;
    console.log('Toko utama ditemukan, shopId:', ownShopId);
    return ownShopId;
  });
}
function P(sid, p) { return 'shops/' + sid + '/' + p; }

/* ---------- toko lain (toko.json) ----------
   Tiap toko lain = satu akun pemilik di aplikasi yang sama (daftar sendiri di aplikasi).
   Bot mengenali pemiliknya lewat nomor WhatsApp, lalu mencatat ke data toko itu saja. */
var tokoIndex = TOKO.buildIndex([]);
var unknownSeen = {};
async function loadToko() {
  var list = readTokoFile().list;
  if (!list) { console.log('toko.json tidak ada: bot hanya melayani toko utama.'); return; }
  var ok = [];
  for (var k = 0; k < list.length; k++) {
    var t = list[k] || {};
    try {
      var sid = t.shopId || null;
      if (!sid) {
        if (!t.email) throw new Error('isi "email" (atau "shopId")');
        sid = await shopByEmail(t.email);
      }
      if (!TOKO.normNum(t.nomor) && !t.lid) throw new Error('isi "nomor"');
      ok.push({ nama: t.nama || t.email || sid, nomor: t.nomor, lid: t.lid, shopId: sid });
      console.log('Toko terdaftar:', t.nama || t.email, '(' + TOKO.normNum(t.nomor) + ')');
    } catch (e) { console.error('[PERINGATAN] Toko #' + (k + 1) + ' dilewati:', e.message); }
  }
  tokoIndex = TOKO.buildIndex(ok);
}

var accsByShop = {};
function refreshAccs(sid) {
  return db.collection(P(sid, 'acc')).get().then(function (snap) {
    accsByShop[sid] = snap.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); });
    return accsByShop[sid];
  }).catch(function (e) { console.error('Gagal membaca daftar rekening:', e.message); return accsByShop[sid] || []; });
}

function alreadyProcessed(sid, sig) {
  return Promise.all([
    db.collection(P(sid, 'tx')).where('wa', '==', sig).limit(1).get(),
    db.collection(P(sid, 'mv')).where('wa', '==', sig).limit(1).get()
  ]).then(function (r) { return !r[0].empty || !r[1].empty; });
}

function saveTx(sid, kind, obj, sig) {
  obj.wa = sig;
  obj.createdAt = Date.now();
  return db.collection(P(sid, kind === 'mv' ? 'mv' : 'tx')).add(obj);
}

/* ---------- format balasan ---------- */
var nf = new Intl.NumberFormat('id-ID');
function rp(n) { return 'Rp' + nf.format(Math.round(n || 0)); }
function accName(accs, id) {
  if (id === 'kas') return 'uang tunai laci';
  var a = (accs || []).filter(function (x) { return x.id === id; })[0];
  return a ? a.name : id;
}
function tgl(d) {
  if (!d) return '';
  var p = d.split('-'); if (p.length !== 3) return d;
  return p[2] + '-' + p[1] + '-' + p[0];
}
var ADM_LABEL = { luar: 'nasabah bayar tunai', dalam: 'transfer + admin', potong: 'potong dari uang' };

/* satu baris per rincian, hanya tampilkan yang relevan -- supaya balasan rapi dan ringkas */
function successText(r, accs) {
  if (r.kind === 'mv') {
    var o = r.obj, L = ['✅ *Pindah saldo* tercatat'];
    L.push('• Dari: ' + accName(accs, o.from));
    L.push('• Ke: ' + accName(accs, o.to));
    L.push('• Nominal: ' + rp(o.amount));
    if (o.fee) L.push('• Biaya pindah: ' + rp(o.fee));
    L.push('• Tanggal: ' + tgl(o.date));
    return L.join('\n');
  }
  var o2 = r.obj, T = TYPES[o2.type];
  var L2 = ['✅ *' + T.label + '* tercatat'];
  L2.push('• Nominal: ' + rp(o2.amount));
  if (o2.name) L2.push('• Nama: ' + o2.name);
  if (T.acc && o2.acc) L2.push('• ' + (o2.type === 'topup' ? 'Dari' : 'Rekening') + ': ' + accName(accs, o2.acc));
  if (o2.bt) L2.push('• Bank tujuan: ' + o2.bt + (o2.rek ? ' (' + o2.rek + ')' : ''));
  if (o2.ew) L2.push('• E-wallet tujuan: ' + o2.ew + (o2.hp ? ' (' + o2.hp + ')' : ''));
  if (T.fee && o2.fee) L2.push('• Admin: ' + rp(o2.fee) + (o2.adm ? ' (' + (ADM_LABEL[o2.adm] || o2.adm) + ')' : ''));
  if (o2.komisi) L2.push('• Komisi: ' + rp(o2.komisi));
  if (o2.bf) L2.push('• Potongan bank: ' + rp(o2.bf));
  if (T.modal && o2.modal) L2.push('• Modal: ' + rp(o2.modal));
  if (T.pay) L2.push('• Pelanggan bayar: ' + (o2.pay === 'transfer' ? 'transfer ke ' + accName(accs, o2.payAcc) : 'tunai'));
  L2.push('• Tanggal: ' + tgl(o2.date));
  return L2.join('\n');
}

/* ringkasan satu baris untuk balasan banyak transaksi */
function shorten(s) { s = String(s || ''); return s.length > 40 ? s.slice(0, 37) + '...' : s; }
function shortText(r, accs) {
  if (r.kind === 'mv') {
    var m = r.obj;
    return '✅ *Pindah saldo* ' + rp(m.amount) + ' — ' + accName(accs, m.from) + ' → ' + accName(accs, m.to) + (m.fee ? ', biaya ' + rp(m.fee) : '');
  }
  var o = r.obj, T = TYPES[o.type], P2 = [];
  if (T.acc && o.acc) P2.push(accName(accs, o.acc));
  if (o.name) P2.push(o.name);
  if (o.bt) P2.push('ke ' + o.bt);
  if (o.ew) P2.push('ke ' + o.ew);
  if (T.fee && o.fee) P2.push('admin ' + rp(o.fee));
  if (o.komisi) P2.push('komisi ' + rp(o.komisi));
  if (T.pay && o.pay === 'transfer') P2.push('bayar transfer ke ' + accName(accs, o.payAcc));
  return '✅ *' + T.label + '* ' + rp(o.amount) + (P2.length ? ' — ' + P2.join(', ') : '');
}

/* ---------- cek saldo ---------- */
var SALDO_RE = /^(cek\s+)?saldo\b/i;
function saldoText(sid, judul) {
  return Promise.all([
    db.collection(P(sid, 'acc')).get(),
    db.collection(P(sid, 'tx')).get(),
    db.collection(P(sid, 'mv')).get(),
    db.doc(P(sid, 'settings/main')).get()
  ]).then(function (r) {
    var accs = r[0].docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); });
    var txs = r[1].docs.map(function (d) { return d.data(); });
    var mvs = r[2].docs.map(function (d) { return d.data(); });
    var kasAwal = r[3].exists ? (+r[3].data().kasAwal || 0) : 0;
    accsByShop[sid] = accs;
    var c = calcBalance(accs, kasAwal, txs, mvs);
    var now = new Date();
    var L = ['💰 *' + judul + '*'];
    L.push('_per ' + pad2(now.getDate()) + '-' + pad2(now.getMonth() + 1) + '-' + now.getFullYear() + ' ' + pad2(now.getHours()) + ':' + pad2(now.getMinutes()) + '_');
    L.push('');
    L.push('• Uang tunai laci: ' + rp(c.kas));
    accs.slice().sort(function (a, b) { return (a.createdAt || 0) - (b.createdAt || 0); }).forEach(function (a) {
      L.push('• ' + a.name + ': ' + rp(c.bal[a.id]));
    });
    L.push('');
    L.push('*Total aset: ' + rp(c.total) + '*');
    return L.join('\n');
  });
}
function pad2(n) { return (n < 10 ? '0' : '') + n; }
function todayStr() { var d = new Date(); return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }

/* ---------- transaksi hari ini ---------- */
var TODAY_RE = /^(cek\s+)?transaksi(\s+hari\s*ini)?\s*$/i;
function todayText(sid) {
  var t = todayStr();
  return Promise.all([
    db.collection(P(sid, 'tx')).where('date', '==', t).get(),
    db.collection(P(sid, 'mv')).where('date', '==', t).get()
  ]).then(function (r) {
    var txs = r[0].docs.map(function (d) { return d.data(); });
    var mvs = r[1].docs.map(function (d) { return d.data(); });
    /* sama dengan kartu "Transaksi hari ini" di aplikasi: pemasukan dan pengeluaran
       bukan transaksi layanan, jadi tidak ikut dihitung di jumlah transaksi */
    var n = 0, keluar = 0, masuk = 0, laba = 0, byType = {};
    txs.forEach(function (x) {
      var e = WA.fx(x, accsByShop[sid] || []), ly = WA.lk(x.type);
      laba += e.laba;
      if (ly === 'keluar') { keluar += +x.amount || 0; return; }
      if (ly === 'masuk') { masuk += +x.amount || 0; return; }
      n++;
      var label = (TYPES[x.type] || {}).label || x.type;
      byType[label] = (byType[label] || 0) + 1;
    });
    var moveFee = mvs.reduce(function (a, m) { return a + (m.type === 'pindah' ? (+m.fee || 0) : 0); }, 0);
    keluar += moveFee; laba -= moveFee;
    var L = ['📊 *Transaksi hari ini*'];
    L.push('_' + tgl(t) + '_');
    L.push('');
    L.push('• Jumlah transaksi: ' + n + (mvs.length ? ' (+ ' + mvs.length + ' pindah saldo)' : ''));
    if (masuk) L.push('• Pemasukan: ' + rp(masuk));
    L.push('• Pengeluaran: ' + rp(keluar));
    L.push('• Laba: ' + rp(laba));
    var types = Object.keys(byType);
    if (types.length) {
      L.push('');
      L.push('*Rincian jenis:*');
      types.forEach(function (k) { L.push('• ' + k + ': ' + byType[k]); });
    }
    return L.join('\n');
  });
}

/* ---------- bot WhatsApp ---------- */
async function start() {
  await resolveShopId();
  await refreshAccs(ownShopId);
  await loadToko();
  var auth = await useMultiFileAuthState(SESSION_DIR);
  var state = auth.state, saveCreds = auth.saveCreds;
  var ver = (await fetchLatestBaileysVersion()).version;

  var sock = makeWASocket({
    version: ver,
    auth: state,
    logger: logger,
    printQRInTerminal: false,
    browser: ['Buku Kas D\'Cell Bot', 'Chrome', '1.0']
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', function (u) {
    if (u.qr) {
      console.log('\nScan QR ini dengan WhatsApp yang mau dipakai bot (Linked devices > Link a device):\n');
      qrcode.generate(u.qr, { small: true });
    }
    if (u.connection === 'close') {
      var code = u.lastDisconnect && u.lastDisconnect.error && u.lastDisconnect.error.output && u.lastDisconnect.error.output.statusCode;
      var loggedOut = code === DisconnectReason.loggedOut;
      console.log('Koneksi WhatsApp terputus.', loggedOut ? 'Sesi keluar, hapus folder session lalu scan ulang.' : 'Menyambung ulang...');
      if (!loggedOut) setTimeout(start, 3000);
    } else if (u.connection === 'open') {
      console.log('\n✅ Tersambung ke WhatsApp. Bot siap mencatat transaksi.\n');
    }
  });

  sock.ev.on('messages.upsert', async function (ev) {
    if (ev.type !== 'notify') return;
    for (var i = 0; i < ev.messages.length; i++) {
      var msg = ev.messages[i];
      try { await handleMessage(sock, msg); } catch (e) { console.error('Gagal memproses pesan:', e.message); }
    }
  });
}

async function handleMessage(sock, msg) {
  var jid = msg.key.remoteJid || '';
  if (jid.endsWith('@g.us')) return;            /* lewati grup */
  if (jid === 'status@broadcast' || jid.endsWith('@broadcast') || jid.endsWith('@newsletter')) return;

  /* siapa pengirimnya, dan toko mana yang dicatat */
  var sid, judul = 'Saldo Buku Kas D\'Cell', toko = null;
  if (msg.key.fromMe) {
    sid = await resolveShopId();                /* pesan yang ANDA ketik sendiri = toko utama */
  } else {
    toko = TOKO.findToko(tokoIndex, msg.key);   /* pesan masuk hanya dari nomor yang terdaftar */
    if (!toko) {
      if (!unknownSeen[jid]) {
        unknownSeen[jid] = 1;
        console.log('Pesan dari ' + jid + ' diabaikan (belum terdaftar di toko.json).' + (jid.endsWith('@lid') ? ' Kalau ini toko Anda, tambahkan "lid": "' + jid.split('@')[0] + '" di toko.json.' : ''));
      }
      return;
    }
    sid = toko.shopId;
    judul = 'Saldo ' + toko.nama;
  }

  var m = msg.message;
  var text = (m && (m.conversation || (m.extendedTextMessage && m.extendedTextMessage.text))) || '';
  text = text.trim();
  if (!text) return;
  var tag = toko ? '[' + toko.nama + '] ' : '';

  if (SALDO_RE.test(text)) {
    try {
      var txt = await saldoText(sid, judul);
      await sock.sendMessage(jid, { text: txt }, { quoted: msg });
      console.log(new Date().toLocaleString('id-ID'), '-', tag + 'cek saldo diminta.');
    } catch (e) {
      await sock.sendMessage(jid, { text: '⚠️ Gagal mengambil saldo: ' + e.message }, { quoted: msg });
    }
    return;
  }

  if (TODAY_RE.test(text)) {
    try {
      await refreshAccs(sid);
      var txt2 = await todayText(sid);
      await sock.sendMessage(jid, { text: txt2 }, { quoted: msg });
      console.log(new Date().toLocaleString('id-ID'), '-', tag + 'cek transaksi hari ini diminta.');
    } catch (e) {
      await sock.sendMessage(jid, { text: '⚠️ Gagal mengambil data transaksi: ' + e.message }, { quoted: msg });
    }
    return;
  }

  var accs = await refreshAccs(sid);
  var lines = WA.splitLines(text);

  /* satu pesan = satu transaksi (cara lama, balasan lengkap) */
  if (lines.length === 1) {
    var r = waLine(lines[0], null, accs);
    if (r.skip) return;                         /* bukan baris transaksi, abaikan diam-diam */
    var sig = 'bot:' + msg.key.id;
    if (!r.ok) {
      await sock.sendMessage(jid, { text: '⚠️ ' + (r.msg || 'Pesan tidak bisa dibaca.') + '\nContoh: "tarik tunai 500rb bri admin 5000"' }, { quoted: msg });
      return;
    }
    if (await alreadyProcessed(sid, sig)) return;
    await saveTx(sid, r.kind, r.obj, sig);
    var reply = successText(r, accs);
    await sock.sendMessage(jid, { text: reply }, { quoted: msg });
    console.log(new Date().toLocaleString('id-ID'), '-', tag + reply.replace(/\n/g, ' | ').replace(/^✅\s*/, ''));
    return;
  }

  /* banyak baris = banyak transaksi sekaligus */
  var MAX_LINES = 30;
  var parsed = lines.slice(0, MAX_LINES).map(function (ln) { return { ln: ln, r: waLine(ln, null, accs) }; });
  if (parsed.every(function (x) { return x.r.skip; })) return;   /* obrolan biasa, abaikan */
  var out = [], okN = 0, badN = 0;
  for (var k = 0; k < parsed.length; k++) {
    var pr = parsed[k], no = (k + 1) + '. ';
    if (pr.r.skip) { badN++; out.push(no + '⚠️ Baris tidak dikenali: ' + shorten(pr.ln)); continue; }
    if (!pr.r.ok) { badN++; out.push(no + '⚠️ ' + (pr.r.msg || 'Tidak bisa dibaca.') + ' (' + shorten(pr.ln) + ')'); continue; }
    var sigK = 'bot:' + msg.key.id + ':' + k;
    try {
      if (!(await alreadyProcessed(sid, sigK))) await saveTx(sid, pr.r.kind, pr.r.obj, sigK);
      okN++; out.push(no + shortText(pr.r, accs));
    } catch (er) { badN++; out.push(no + '⚠️ Gagal menyimpan: ' + er.message); }
  }
  if (lines.length > MAX_LINES) out.push('⚠️ Hanya ' + MAX_LINES + ' baris pertama yang diproses. Kirim sisanya di pesan lain.');
  var head = okN + ' dari ' + parsed.length + ' transaksi tercatat' + (badN ? ', ' + badN + ' perlu dicek' : '');
  var reply2 = (badN ? '⚠️ ' : '✅ ') + '*' + head + '*\n' + out.join('\n');
  await sock.sendMessage(jid, { text: reply2 }, { quoted: msg });
  console.log(new Date().toLocaleString('id-ID'), '-', tag + head);
}

start().catch(function (e) { console.error('Bot gagal jalan:', e); process.exit(1); });
