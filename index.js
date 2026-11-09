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
var waLine = WA.waLine, TYPES = WA.TYPES, ADM = WA.ADM, calcBalance = WA.calcBalance;

var ROOT = __dirname;
var SESSION_DIR = path.join(ROOT, 'session');
var SA_PATH = path.join(ROOT, 'serviceAccountKey.json');
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

var accsCache = [];
function refreshAccs() {
  return db.collection('acc').get().then(function (snap) {
    accsCache = snap.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); });
  }).catch(function (e) { console.error('Gagal membaca daftar rekening:', e.message); });
}

function alreadyProcessed(sig) {
  return Promise.all([
    db.collection('tx').where('wa', '==', sig).limit(1).get(),
    db.collection('mv').where('wa', '==', sig).limit(1).get()
  ]).then(function (r) { return !r[0].empty || !r[1].empty; });
}

function saveTx(kind, obj, sig) {
  obj.wa = sig;
  obj.createdAt = Date.now();
  return db.collection(kind === 'mv' ? 'mv' : 'tx').add(obj);
}

/* ---------- format balasan ---------- */
var nf = new Intl.NumberFormat('id-ID');
function rp(n) { return 'Rp' + nf.format(Math.round(n || 0)); }
function accName(id) {
  if (id === 'kas') return 'uang tunai laci';
  var a = accsCache.filter(function (x) { return x.id === id; })[0];
  return a ? a.name : id;
}
function tgl(d) {
  if (!d) return '';
  var p = d.split('-'); if (p.length !== 3) return d;
  return p[2] + '-' + p[1] + '-' + p[0];
}
var ADM_LABEL = { luar: 'nasabah bayar tunai', dalam: 'transfer + admin', potong: 'potong dari uang' };

/* satu baris per rincian, hanya tampilkan yang relevan -- supaya balasan rapi dan ringkas */
function successText(r) {
  if (r.kind === 'mv') {
    var o = r.obj, L = ['✅ *Pindah saldo* tercatat'];
    L.push('• Dari: ' + accName(o.from));
    L.push('• Ke: ' + accName(o.to));
    L.push('• Nominal: ' + rp(o.amount));
    if (o.fee) L.push('• Biaya pindah: ' + rp(o.fee));
    L.push('• Tanggal: ' + tgl(o.date));
    return L.join('\n');
  }
  var o2 = r.obj, T = TYPES[o2.type];
  var L2 = ['✅ *' + T.label + '* tercatat'];
  L2.push('• Nominal: ' + rp(o2.amount));
  if (o2.name) L2.push('• Nama: ' + o2.name);
  if (T.acc && o2.acc) L2.push('• ' + (o2.type === 'topup' ? 'Dari' : 'Rekening') + ': ' + accName(o2.acc));
  if (o2.bt) L2.push('• Bank tujuan: ' + o2.bt + (o2.rek ? ' (' + o2.rek + ')' : ''));
  if (o2.ew) L2.push('• E-wallet tujuan: ' + o2.ew + (o2.hp ? ' (' + o2.hp + ')' : ''));
  if (T.fee && o2.fee) L2.push('• Admin: ' + rp(o2.fee) + (o2.adm ? ' (' + (ADM_LABEL[o2.adm] || o2.adm) + ')' : ''));
  if (o2.komisi) L2.push('• Komisi: ' + rp(o2.komisi));
  if (o2.bf) L2.push('• Potongan bank: ' + rp(o2.bf));
  if (T.modal && o2.modal) L2.push('• Modal: ' + rp(o2.modal));
  L2.push('• Tanggal: ' + tgl(o2.date));
  return L2.join('\n');
}

/* ---------- cek saldo ---------- */
var SALDO_RE = /^(cek\s+)?saldo\b/i;
function saldoText() {
  return Promise.all([
    db.collection('acc').get(),
    db.collection('tx').get(),
    db.collection('mv').get(),
    db.doc('settings/main').get()
  ]).then(function (r) {
    var accs = r[0].docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); });
    var txs = r[1].docs.map(function (d) { return d.data(); });
    var mvs = r[2].docs.map(function (d) { return d.data(); });
    var kasAwal = r[3].exists ? (+r[3].data().kasAwal || 0) : 0;
    accsCache = accs;
    var c = calcBalance(accs, kasAwal, txs, mvs);
    var now = new Date();
    var L = ['💰 *Saldo Buku Kas D\'Cell*'];
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
function todayText() {
  var t = todayStr();
  return Promise.all([
    db.collection('tx').where('date', '==', t).get(),
    db.collection('mv').where('date', '==', t).get()
  ]).then(function (r) {
    var txs = r[0].docs.map(function (d) { return d.data(); });
    var mvs = r[1].docs.map(function (d) { return d.data(); });
    var masuk = 0, keluar = 0, laba = 0, byType = {};
    txs.forEach(function (x) {
      var e = WA.fx(x);
      laba += e.laba;
      if (e.kas > 0) masuk += e.kas; else keluar += -e.kas;
      var label = (TYPES[x.type] || {}).label || x.type;
      byType[label] = (byType[label] || 0) + 1;
    });
    var moveFee = mvs.reduce(function (a, m) { return a + (m.type === 'pindah' ? (+m.fee || 0) : 0); }, 0);
    keluar += moveFee; laba -= moveFee;
    var L = ['📊 *Transaksi hari ini*'];
    L.push('_' + tgl(t) + '_');
    L.push('');
    L.push('• Jumlah transaksi: ' + txs.length + (mvs.length ? ' (+ ' + mvs.length + ' pindah saldo)' : ''));
    L.push('• Pemasukan: ' + rp(masuk));
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
  await refreshAccs();
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
  if (!msg.key.fromMe) return;                 /* hanya pesan yang ANDA ketik sendiri */
  if (jid.endsWith('@g.us')) return;            /* lewati grup */
  if (jid === 'status@broadcast') return;

  var m = msg.message;
  var text = (m && (m.conversation || (m.extendedTextMessage && m.extendedTextMessage.text))) || '';
  text = text.trim();
  if (!text) return;

  if (SALDO_RE.test(text)) {
    try {
      var txt = await saldoText();
      await sock.sendMessage(jid, { text: txt }, { quoted: msg });
      console.log(new Date().toLocaleString('id-ID'), '- cek saldo diminta.');
    } catch (e) {
      await sock.sendMessage(jid, { text: '⚠️ Gagal mengambil saldo: ' + e.message }, { quoted: msg });
    }
    return;
  }

  if (TODAY_RE.test(text)) {
    try {
      var txt2 = await todayText();
      await sock.sendMessage(jid, { text: txt2 }, { quoted: msg });
      console.log(new Date().toLocaleString('id-ID'), '- cek transaksi hari ini diminta.');
    } catch (e) {
      await sock.sendMessage(jid, { text: '⚠️ Gagal mengambil data transaksi: ' + e.message }, { quoted: msg });
    }
    return;
  }

  await refreshAccs();
  var r = waLine(text, null, accsCache);
  if (r.skip) return;                           /* bukan baris transaksi, abaikan diam-diam */

  var sig = 'bot:' + msg.key.id;
  if (!r.ok) {
    await sock.sendMessage(jid, { text: '⚠️ ' + (r.msg || 'Pesan tidak bisa dibaca.') + '\nContoh: "tarik tunai 500rb bri admin 5000"' }, { quoted: msg });
    return;
  }
  if (await alreadyProcessed(sig)) return;
  await saveTx(r.kind, r.obj, sig);
  var reply = successText(r);
  await sock.sendMessage(jid, { text: reply }, { quoted: msg });
  console.log(new Date().toLocaleString('id-ID'), '-', reply.replace(/\n/g, ' | ').replace(/^✅\s*/, ''));
}

start().catch(function (e) { console.error('Bot gagal jalan:', e); process.exit(1); });
