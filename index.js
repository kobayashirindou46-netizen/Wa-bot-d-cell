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

var WA = require('./waParser.js');
var TOKO = require('./toko.js');
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
  return db.collection('users').where('role', '==', 'owner').limit(50).get().then(function (snap0) {
    var snap = { docs: snap0.docs.filter(function (x) { var st = x.data().status; return !st || st === 'approved'; }) };
    snap.empty = !snap.docs.length; snap.size = snap.docs.length;
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
var tokoIndex = TOKO.buildIndex([]), tokoList = [];
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
      ok.push({ nama: t.nama || t.email || sid, nomor: t.nomor, lid: t.lid, shopId: sid, rekapJam: t.rekapJam });
      console.log('Toko terdaftar:', t.nama || t.email, '(' + TOKO.normNum(t.nomor) + ')');
    } catch (e) { console.error('[PERINGATAN] Toko #' + (k + 1) + ' dilewati:', e.message); }
  }
  tokoIndex = TOKO.buildIndex(ok);
  tokoList = ok;
}

var accsByShop = {}, settingsByShop = {};
function refreshAccs(sid) {
  return Promise.all([db.collection(P(sid, 'acc')).get(), db.doc(P(sid, 'settings/main')).get()]).then(function (r) {
    accsByShop[sid] = r[0].docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); });
    settingsByShop[sid] = r[1].exists ? r[1].data() : {};
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
  /* sama dengan aplikasi: transaksi hari ini ditandai shift yang sedang dibuka */
  if (kind !== 'mv') { var op = todayOpen(sid); if (op && obj.date === todayStr() && !obj.shift) obj.shift = op.shift; }
  return db.collection(P(sid, kind === 'mv' ? 'mv' : 'tx')).add(obj).then(function (ref) {
    /* bayar "utang": buat catatan piutang yang terhubung ke transaksi ini */
    if (kind !== 'mv' && obj.pay === 'utang') {
      var dv = WA.debtFor(obj, accsByShop[sid] || []);
      if (dv) {
        return db.collection(P(sid, 'debts')).add({ kind: dv.kind, name: obj.name || '', hp: obj.hp || '', amount: dv.amount, date: obj.date, due: '', note: (TYPES[obj.type] || {}).label || '', acc: 'none', txId: ref.id, pays: [], createdAt: Date.now(), wa: sig }).then(function () { return ref; });
      }
    }
    return ref;
  });
}

/* ---------- utang piutang ---------- */
function getDebts(sid) {
  return db.collection(P(sid, 'debts')).get().then(function (snap) {
    return snap.docs.map(function (d) { return Object.assign({ id: d.id, ref: d.ref }, d.data()); });
  }).catch(function () { return []; });
}
function debtPaid(d) { return (d.pays || []).reduce(function (a, p) { return a + (+p.amount || 0); }, 0); }
function debtLeft(d) { return Math.max(0, (+d.amount || 0) - debtPaid(d)); }

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

/* kembalian untuk pelanggan yang bayar tunai ke laci: "terima 100rb" di pesan (hanya info, tidak disimpan) */
function kembalianText(o, terima, accs) {
  if (!terima) return '';
  var due;
  if (WA.lk(o.type) === 'tarik') due = (o.adm || 'luar') === 'luar' ? (+o.fee || 0) : 0;   /* tarik/kartu: yang dibayar tunai hanya admin */
  else due = (o.pay === 'transfer' && o.payAcc) ? 0 : WA.fx(o, accs).kas;
  if (!(due > 0)) return '';
  var d = terima - due;
  return '• Pelanggan bayar ' + rp(due) + ', diterima ' + rp(terima) + (d >= 0 ? ' → *Kembalian ' + rp(d) + '*' : ' → *kurang ' + rp(-d) + '*');
}

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
  if (!T.onlyAdm) L2.push('• Nominal: ' + rp(o2.amount));
  if (o2.name) L2.push('• Nama: ' + o2.name);
  if (T.acc && o2.acc) L2.push('• ' + (o2.type === 'topup' ? 'Dari' : 'Rekening') + ': ' + accName(accs, o2.acc));
  if (o2.bt) L2.push('• Bank tujuan: ' + o2.bt + (o2.rek ? ' (' + o2.rek + ')' : ''));
  if (o2.ew) L2.push('• E-wallet tujuan: ' + o2.ew + (o2.hp ? ' (' + o2.hp + ')' : ''));
  if (T.onlyAdm) L2.push('• Masuk laci: ' + rp(o2.fee));
  else if (T.fee && o2.fee) L2.push('• Admin: ' + rp(o2.fee) + (o2.adm ? ' (' + (ADM_LABEL[o2.adm] || o2.adm) + ')' : ''));
  if (o2.komisi) L2.push('• Komisi: ' + rp(o2.komisi));
  if (o2.bf) L2.push('• Potongan bank: ' + rp(o2.bf));
  if (T.modal && o2.modal) L2.push('• Modal: ' + rp(o2.modal));
  if (T.pay || o2.pay === 'utang') L2.push('• Pelanggan bayar: ' + (o2.pay === 'utang' ? 'BELUM (dicatat di utang piutang)' : o2.pay === 'transfer' ? 'transfer ke ' + accName(accs, o2.payAcc) : 'tunai'));
  var kbl = kembalianText(o2, r.terima, accs);
  if (kbl) L2.push(kbl);
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
  return '✅ *' + T.label + '* ' + rp(T.onlyAdm ? o.fee : o.amount) + (P2.length ? ' — ' + P2.join(', ') : '');
}


/* balasan kalau pesan tidak bisa dibaca: alasan + contoh/koreksi yang benar + daftar rekening */
function failText(r, accs) {
  var L = ['⚠️ ' + (r.msg || 'Pesan tidak bisa dibaca.')];
  if (r.corrected) { L.push(''); L.push('Kalau maksudnya ini, kirim ulang:'); L.push(r.corrected); }
  else if (r.example) { L.push(''); L.push('Contoh yang benar:'); L.push(r.example); }
  var names = (accs || []).map(function (a) { return a.name; }).filter(Boolean);
  if (names.length && /rekening|tujuan|pengirim/i.test(r.msg || '')) { L.push(''); L.push('Nama rekening yang ada: ' + names.join(', ')); }
  return L.join('\n');
}

/* ---------- cek saldo ---------- */
var SALDO_RE = /^(cek\s+)?saldo\b/i;
function saldoText(sid, judul) {
  return Promise.all([
    db.collection(P(sid, 'acc')).get(),
    db.collection(P(sid, 'tx')).get(),
    db.collection(P(sid, 'mv')).get(),
    db.doc(P(sid, 'settings/main')).get(),
    getDebts(sid)
  ]).then(function (r) {
    var accs = r[0].docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); });
    var txs = r[1].docs.map(function (d) { return d.data(); });
    var mvs = r[2].docs.map(function (d) { return d.data(); });
    var kasAwal = r[3].exists ? (+r[3].data().kasAwal || 0) : 0;
    accsByShop[sid] = accs;
    var c = calcBalance(accs, kasAwal, txs, mvs, r[4]);
    var now = new Date();
    var L = ['💰 *' + judul + '*'];
    L.push('_per ' + pad2(now.getDate()) + '-' + pad2(now.getMonth() + 1) + '-' + now.getFullYear() + ' ' + pad2(now.getHours()) + ':' + pad2(now.getMinutes()) + '_');
    L.push('');
    var ms = (settingsByShop[sid] && settingsByShop[sid].minSaldo) || {};
    function low(id, v) { return (+ms[id] > 0 && v < +ms[id]) ? ' ⚠️ menipis (batas ' + rp(ms[id]) + ')' : ''; }
    L.push('• Uang tunai laci: ' + rp(c.kas) + low('kas', c.kas));
    accs.slice().sort(function (a, b) { return (a.createdAt || 0) - (b.createdAt || 0); }).forEach(function (a) {
      L.push('• ' + a.name + ': ' + rp(c.bal[a.id]) + low(a.id, c.bal[a.id]));
    });
    L.push('');
    L.push('*Total aset: ' + rp(c.total) + '*');
    var pt = 0, ut = 0;
    r[4].forEach(function (d) { var l = debtLeft(d); if (d.kind === 'piutang') pt += l; else ut += l; });
    if (pt || ut) L.push('_Piutang belum dibayar: ' + rp(pt) + ' · Utang kita: ' + rp(ut) + ' (ketik "cek utang")_');
    return L.join('\n');
  });
}
function pad2(n) { return (n < 10 ? '0' : '') + n; }
function todayStr() { var d = new Date(); return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }

/* ---------- pembukaan kas + shift (sama dengan menu "Buka Kas" di aplikasi) ---------- */
function todayOpen(sid) {
  var st = settingsByShop[sid] || {}, t = todayStr();
  var o = (Array.isArray(st.opens) ? st.opens : []).filter(function (x) { return x && x.date === t; }).sort(function (a, b) { return (a.at || 0) - (b.at || 0); });
  return o.length ? o[o.length - 1] : null;
}
function todayClosed(sid) {
  var st = settingsByShop[sid] || {}, t = todayStr(), o = todayOpen(sid);
  var c = (Array.isArray(st.closings) ? st.closings : []).filter(function (x) { return x && x.date === t; })[0];
  return !!c && (!o || (c.at || 0) >= (o.at || 0));
}
function shiftLbl(x) { return x === 'malam' ? 'Malam' : 'Pagi'; }
function jamStr(ts) { var d = new Date(ts || Date.now()); return pad2(d.getHours()) + ':' + pad2(d.getMinutes()); }
function kasStatusLine(sid) {
  var o = todayOpen(sid);
  if (todayClosed(sid)) return 'Kas sudah ditutup';
  if (o) return 'Kas sedang dibuka (shift ' + shiftLbl(o.shift) + ', modal ' + rp(o.modal) + ', jam ' + jamStr(o.at) + ')';
  return 'Kas belum dibuka';
}

/* ---------- stok barang (produk Kasir, tersimpan di Firebase: shops/{shopId}/products) ---------- */
var STOK_ADD_RE = /^(tambah|kurang)\s+stok\s+(.+?)\s+(\d+)(?:\s*@\s*(\d[\d.]*))?(?:\s+jual\s+(\d[\d.]*))?\s*$/i;
/* ekor opsional: "tanpa kas" (tidak dicatat) atau "dari NAMA REKENING" (bawaan: kas laci) */
function splitTail(ln) {
  var o = { src: 'kas', skip: false, bad: null }, x = String(ln).trim(), m;
  if ((m = x.match(/\s+tanpa\s+kas\s*$/i))) { o.skip = true; x = x.slice(0, m.index); }
  else if ((m = x.match(/(?<=\d)\s+dari\s+(.+?)\s*$/i))) { o.src = m[1].trim().toLowerCase(); x = x.slice(0, m.index); }
  o.line = x; return o;
}
var STOK_MASUK_RE = /^stok\s+masuk\s*(\r?\n|$)/i;
var STOK_LOW_RE = /^(stok\s+(menipis|habis|tipis)|cek\s+stok\s+(menipis|habis))\s*$/i;
var STOK_CEK_RE = /^(cek\s+stok|stok)(?:\s+(.+))?\s*$/i;
function isStokCmd(t) { return STOK_ADD_RE.test(splitTail(t).line) || STOK_MASUK_RE.test(t) || STOK_LOW_RE.test(t) || /^cek\s+stok\b/i.test(t) || /^stok\s+\S/i.test(t) && !/^stok\s+masuk/i.test(t); }
function getProducts(sid) {
  return db.collection(P(sid, 'products')).get().then(function (sn) { return sn.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); }); });
}
function findProd(list, q) {
  var k = String(q).trim().toLowerCase();
  var ex = list.filter(function (p) { return String(p.name || '').toLowerCase() === k || (p.bc && String(p.bc) === k); });
  if (ex.length === 1) return { p: ex[0] };
  var sub = list.filter(function (p) { return String(p.name || '').toLowerCase().indexOf(k) >= 0; });
  if (sub.length === 1) return { p: sub[0] };
  if (sub.length > 1) return { many: sub };
  return { none: true };
}
function stokLine(p) { var low = (+p.stock || 0) <= (+p.min || 0); return (low ? '⚠️ ' : '• ') + p.name + ': ' + (+p.stock || 0) + (low ? ' (menipis)' : ''); }
async function stokLowText(sid) {
  var list = await getProducts(sid);
  var low = list.filter(function (p) { return (+p.stock || 0) <= (+p.min || 0); }).sort(function (a, b) { return (a.stock || 0) - (b.stock || 0); });
  if (!list.length) return '📦 Belum ada produk di Firebase. Buka Kasir di aplikasi sekali agar produknya tersinkron.';
  if (!low.length) return '📦 Semua stok aman (' + list.length + ' produk).';
  return '📦 *Stok menipis / habis (' + low.length + ')*\n' + low.slice(0, 40).map(stokLine).join('\n');
}
async function stokLowWarn(sid) {
  try {
    var list = await getProducts(sid);
    var low = list.filter(function (p) { return (+p.stock || 0) <= (+p.min || 0); }).sort(function (a, b) { return (a.stock || 0) - (b.stock || 0); });
    return low.length ? '📦 *Stok menipis (' + low.length + '):*\n' + low.slice(0, 15).map(stokLine).join('\n') + (low.length > 15 ? '\n…dan ' + (low.length - 15) + ' lagi. Ketik: stok menipis' : '') : '';
  } catch (e) { return ''; }
}
async function stokCommand(sid, text, msgId) {
  var t = text.trim();
  if (STOK_LOW_RE.test(t)) return stokLowText(sid);
  var list = await getProducts(sid);
  if (!list.length) return '📦 Belum ada produk di Firebase. Buka Kasir di aplikasi sekali (pakai akun pemilik) agar produknya tersinkron.';
  var FV = admin.firestore.FieldValue, items = [], accsS = await refreshAccs(sid);
  if (STOK_MASUK_RE.test(t)) {
    var ls = t.split(/\r?\n/).slice(1).map(function (x) { return x.trim(); }).filter(Boolean).slice(0, 40);
    if (!ls.length) return '📦 Contoh stok masuk banyak barang:\nstok masuk\nPulsa 5rb 20\nKabel USB 10\nCharger 5 @35000 jual 50000';
    items = ls.map(function (ln0) { var tl = splitTail(ln0), ln = tl.line; var m = ln.match(/^(.+?)\s+(\d+)(?:\s*@\s*(\d[\d.]*))?(?:\s+jual\s+(\d[\d.]*))?$/i); return m ? { q: m[1], n: +m[2], buy: m[3] ? +String(m[3]).replace(/\./g, '') : null, sell: m[4] ? +String(m[4]).replace(/\./g, '') : null, sign: 1, raw: ln, tail: tl } : { bad: ln0 }; });
  } else if (STOK_ADD_RE.test(splitTail(t).line)) {
    var tl0 = splitTail(t), a = tl0.line.match(STOK_ADD_RE);
    items = [{ q: a[2], n: +a[3], buy: a[4] ? +String(a[4]).replace(/\./g, '') : null, sell: a[5] ? +String(a[5]).replace(/\./g, '') : null, sign: a[1].toLowerCase() === 'kurang' ? -1 : 1, raw: t, tail: tl0 }];
  } else {
    var c = t.match(STOK_CEK_RE), q = c && c[2] ? c[2].trim() : '';
    if (!q) return '📦 *Perintah stok:*\n• stok masuk (lalu satu barang per baris: Nama jumlah)\n• tambah stok NAMA 10 [@harga beli] [jual harga jual] [dari BRI | tanpa kas]\n• kurang stok NAMA 2\n• cek stok NAMA\n• stok menipis';
    var f = findProd(list, q);
    if (f.none) return '📦 Produk "' + q + '" tidak ditemukan.';
    if (f.many) return '📦 Ada beberapa yang cocok:\n' + f.many.slice(0, 10).map(stokLine).join('\n') + '\nTulis nama lebih lengkap.';
    return '📦 ' + f.p.name + '\nStok: ' + (+f.p.stock || 0) + ' (batas minimum ' + (+f.p.min || 0) + ')\nHarga jual: ' + rp(f.p.sell) + ' · beli: ' + rp(f.p.buy);
  }
  var batch = db.batch(), out = [], ok = 0, now = Date.now(), buys = [];
  items.forEach(function (it, i) {
    if (it.bad) { out.push('⚠️ Baris tidak dikenali: ' + shorten(it.bad)); return; }
    if (!(it.n > 0)) { out.push('⚠️ Jumlah harus lebih dari 0: ' + shorten(it.raw)); return; }
    var f = findProd(list, it.q);
    if (f.none) { out.push('⚠️ Tidak ditemukan: ' + it.q); return; }
    if (f.many) { out.push('⚠️ "' + it.q + '" cocok dengan ' + f.many.length + ' produk (' + f.many.slice(0, 3).map(function (x) { return x.name; }).join(', ') + '). Tulis lebih lengkap.'); return; }
    var p = f.p, d = it.sign * it.n, upd = { stock: FV.increment(d), updatedAt: now, by: 'wa-bot' };
    if (it.buy && it.sign > 0) upd.buy = it.buy;
    if (it.sell && it.sign > 0) upd.sell = it.sell;
    batch.update(db.doc(P(sid, 'products/' + p.id)), upd);
    batch.create(db.doc(P(sid, 'stoklog/' + msgId + '_' + i)), { prod: p.id, name: p.name, d: d, at: now, wa: msgId });
    var after = (+p.stock || 0) + d; p.stock = after;
    if (d > 0 && it.buy && it.tail && !it.tail.skip) {
      var src = 'kas', srcLbl = 'kas laci';
      if (it.tail.src !== 'kas') {
        var ac = accsS.filter(function (x) { return String(x.name || '').toLowerCase() === it.tail.src; })[0] || accsS.filter(function (x) { return String(x.name || '').toLowerCase().indexOf(it.tail.src) >= 0; })[0];
        if (ac) { src = ac.id; srcLbl = ac.name; } else { out.push('⚠️ Rekening "' + it.tail.src + '" tidak ditemukan, pembelian tidak dicatat ke kas.'); src = null; }
      }
      if (src) { buys.push({ obj: { date: todayStr(), type: 'keluar', name: 'Beli stok: ' + p.name + ' ×' + it.n, amount: it.buy * it.n, fee: 0, komisi: 0, bf: 0, acc: src, stok: true, note: 'Bot · beli stok' }, i: i }); it.buyLbl = ' · tercatat ' + rp(it.buy * it.n) + ' dari ' + srcLbl; }
    }
    ok++; out.push((d > 0 ? '✅ ' : '➖ ') + p.name + ' ' + (d > 0 ? '+' : '') + d + ' → stok ' + after + (it.buy && d > 0 ? ' · beli ' + rp(it.buy) : '') + (it.sell && d > 0 ? ' · jual ' + rp(it.sell) : '') + (it.buyLbl || '') + (after <= (+p.min || 0) ? ' ⚠️ menipis' : ''));
  });
  if (ok) {
    try { await batch.commit(); }
    catch (e) { if (e && (e.code === 6 || /already exists/i.test(e.message || ''))) return '📦 Pesan ini sudah diproses sebelumnya.'; throw e; }
    for (var bi = 0; bi < buys.length; bi++) await saveTx(sid, 'tx', buys[bi].obj, 'bot:' + msgId + ':stok' + buys[bi].i);
  }
  return (ok ? '📦 *Stok diperbarui (' + ok + ')*\n' : '📦 Tidak ada yang diubah.\n') + out.join('\n');
}

/* ---------- persetujuan pendaftar baru (hanya dari toko utama) ---------- */
var PEND_RE = /^(pendaftar|daftar\s+pendaftar)\s*$/i;
var APPR_RE = /^(setujui|setuju|tolak)\s+(.+)$/i;
async function pendingList() {
  var sn = await db.collection('users').where('status', '==', 'pending').limit(30).get();
  return sn.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); }).sort(function (a, b) { return (a.createdAt || 0) - (b.createdAt || 0); });
}
async function pendingText() {
  var L = await pendingList();
  if (!L.length) return '👤 Tidak ada pendaftar yang menunggu.';
  return '👤 *Pendaftar menunggu (' + L.length + ')*\n' + L.map(function (u, i) { return (i + 1) + '. ' + (u.name || 'Tanpa nama') + ' — ' + (u.email || '') ; }).join('\n') + '\n\nBalas: *setujui 1* atau *tolak 1* (nomor dari daftar), atau *setujui semua*.';
}
async function approveCmd(text) {
  var m = text.match(APPR_RE), yes = m[1].toLowerCase() !== 'tolak', arg = m[2].trim().toLowerCase();
  var L = await pendingList(), pick = [];
  if (arg === 'semua') pick = L;
  else if (/^\d+$/.test(arg)) { var u = L[+arg - 1]; if (u) pick = [u]; }
  else pick = L.filter(function (u) { return String(u.email || '').toLowerCase() === arg; });
  if (!pick.length) return '👤 Tidak ada pendaftar yang cocok. Ketik *pendaftar* untuk melihat daftar terbaru.';
  for (var i = 0; i < pick.length; i++) await db.doc('users/' + pick[i].id).update({ status: yes ? 'approved' : 'rejected', approvedAt: Date.now(), approvedBy: 'wa-bot' });
  return '👤 ' + (yes ? 'Disetujui: ' : 'Ditolak: ') + pick.map(function (u) { return u.name || u.email; }).join(', ');
}
var PEND_SEEN = path.join(ROOT, 'pendaftar-state.json');
var pendBusy = false;
async function cekPendaftar() {
  if (pendBusy || !curSock || !curSock.user || !ownShopId) return;
  pendBusy = true;
  try {
    var L = await pendingList(), seen = {};
    try { seen = JSON.parse(fs.readFileSync(PEND_SEEN, 'utf8')) || {}; } catch (e) {}
    var fresh = L.filter(function (u) { return !seen[u.id]; });
    if (fresh.length) {
      var me = String(curSock.user.id).split(':')[0].split('@')[0] + '@s.whatsapp.net';
      await curSock.sendMessage(me, { text: '👤 *Pendaftar baru menunggu persetujuan (' + fresh.length + ')*\n' + fresh.map(function (u) { return '• ' + (u.name || 'Tanpa nama') + ' — ' + (u.email || ''); }).join('\n') + '\n\nKetik *pendaftar* lalu *setujui 1* atau *tolak 1*.' });
      fresh.forEach(function (u) { seen[u.id] = 1; });
      try { fs.writeFileSync(PEND_SEEN, JSON.stringify(seen)); } catch (e) {}
    }
  } catch (e) { console.error('[PERINGATAN] cek pendaftar gagal:', e && e.message ? e.message : e); }
  pendBusy = false;
}
/* buat meta/admin bila belum ada (pemilik utama = admin yang boleh menyetujui lewat aplikasi) */
async function ensureAdmin() {
  try {
    var sid = await resolveShopId();
    var d = await db.doc('meta/admin').get();
    if (!d.exists) { await db.doc('meta/admin').set({ uid: sid, by: 'wa-bot', at: Date.now() }); console.log('meta/admin dibuat untuk akun utama.'); }
  } catch (e) { console.error('[PERINGATAN] meta/admin belum bisa dibuat:', e && e.message ? e.message : e); }
}

/* ---------- peringatan saldo menipis (otomatis, tanpa menunggu rekap malam) ---------- */
var SALDO_STATE = path.join(ROOT, 'saldo-state.json');
var saldoBusy = false;
function readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')) || {}; } catch (e) { return {}; } }
function saldoSig(t) { return String(t).replace(/Rp\s?[\d.\-−]+/g, '#').replace(/\d+/g, '#'); }
async function cekSaldo() {
  if (saldoBusy || !curSock || !curSock.user) return;
  var h = new Date().getHours(); if (h < 7 || h >= 22) return;
  saldoBusy = true;
  try {
    var list = rekapTargets().filter(function (t) { return !t.norekap; }), st = readJson(SALDO_STATE), td = todayStr(), seen = {};
    for (var i = 0; i < list.length; i++) {
      var t = list[i], key = t.sid + '|' + t.jid; if (seen[key]) continue; seen[key] = 1;
      await refreshAccs(t.sid);
      var w = await lowWarn(t.sid);
      var rec = st[key] || {};
      if (rec.date !== td) rec = { date: td, sigs: [] };
      if (!w) { st[key] = rec; continue; }
      var sg = saldoSig(w);
      if (rec.sigs.indexOf(sg) < 0 && rec.sigs.length < 3) {
        await curSock.sendMessage(t.jid, { text: w + '\n\n_Pengingat otomatis ' + t.nama + '_' });
        rec.sigs.push(sg);
        console.log(new Date().toLocaleString('id-ID'), '- peringatan saldo terkirim ke', t.nama);
      }
      st[key] = rec;
    }
    try { fs.writeFileSync(SALDO_STATE, JSON.stringify(st)); } catch (e) {}
  } catch (e) { console.error('[PERINGATAN] cek saldo gagal:', e && e.message ? e.message : e); }
  saldoBusy = false;
}

/* ---------- cadangan data (otomatis tiap Minggu malam, atau ketik: cadangan) ---------- */
var BACKUP_RE = /^(cadangan|backup)(\s+data)?\s*$/i;
var BACKUP_STATE = path.join(ROOT, 'cadangan-state.json');
function csvCell(v) { v = v === undefined || v === null ? '' : String(v); return /[",\n\r;]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }
function txCsv(list, accs) {
  var nm = {}; (accs || []).forEach(function (a) { nm[a.id] = a.name; });
  var head = ['Tanggal', 'Jenis', 'Nama', 'Nominal', 'Admin', 'Komisi', 'Akun', 'Shift', 'Catatan'];
  var rows = list.slice().sort(function (a, b) { return (a.date || '') < (b.date || '') ? -1 : (a.date || '') > (b.date || '') ? 1 : (a.createdAt || 0) - (b.createdAt || 0); }).map(function (t) {
    return [t.date, t.type, t.name || '', t.amount || 0, t.fee || 0, t.komisi || 0, nm[t.acc] || (t.acc === 'kas' ? 'Kas laci' : t.acc || ''), t.shift || '', t.note || ''].map(csvCell).join(',');
  });
  return '﻿' + head.join(',') + '\r\n' + rows.join('\r\n') + '\r\n';
}
async function buildBackup(sid) {
  var cols = ['tx', 'acc', 'mv', 'debts', 'products'], out = { dibuat: new Date().toISOString(), shopId: sid, versi: 'bot-v23' };
  for (var i = 0; i < cols.length; i++) {
    var sn = await db.collection(P(sid, cols[i])).get();
    out[cols[i]] = sn.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); });
  }
  var st = await db.doc(P(sid, 'settings/main')).get(); out.settings = st.exists ? st.data() : {};
  return out;
}
async function sendBackup(sock, jid, sid, nama) {
  var b = await buildBackup(sid), td = todayStr();
  await sock.sendMessage(jid, { text: '💾 *Cadangan data ' + nama + '* (' + td + ')\n• Transaksi: ' + b.tx.length + '\n• Rekening: ' + b.acc.length + '\n• Utang piutang: ' + b.debts.length + '\n• Produk: ' + b.products.length + '\n\nSimpan 2 file berikut di tempat aman. Excel: buka file .csv.' });
  await sock.sendMessage(jid, { document: Buffer.from(txCsv(b.tx, b.acc), 'utf8'), mimetype: 'text/csv', fileName: 'transaksi-dcell-' + td + '.csv' });
  await sock.sendMessage(jid, { document: Buffer.from(JSON.stringify(b), 'utf8'), mimetype: 'application/json', fileName: 'cadangan-lengkap-dcell-' + td + '.json' });
}
var backupBusy = false;
async function cekCadangan() {
  if (backupBusy || !curSock || !curSock.user || !ownShopId) return;
  var now = new Date(); if (now.getDay() !== 0 || now.getHours() < 21) return;
  var st = readJson(BACKUP_STATE), td = todayStr(); if (st.last === td) return;
  backupBusy = true;
  try {
    var me = String(curSock.user.id).split(':')[0].split('@')[0] + '@s.whatsapp.net';
    await sendBackup(curSock, me, ownShopId, 'Toko utama');
    st.last = td; try { fs.writeFileSync(BACKUP_STATE, JSON.stringify(st)); } catch (e) {}
    console.log(new Date().toLocaleString('id-ID'), '- cadangan mingguan terkirim');
  } catch (e) { console.error('[PERINGATAN] cadangan gagal:', e && e.message ? e.message : e); }
  backupBusy = false;
}

/* ---------- laporan bulanan (otomatis tanggal 1-3, atau ketik: laporan bulan / laporan bulan lalu) ---------- */
var LAPBLN_RE = /^laporan\s+bulan(\s+(ini|lalu))?\s*$/i;
var LAP_STATE = path.join(ROOT, 'laporan-state.json');
var BLN = ['Januari','Februari','Maret','April','Mei','Juni','Juli','Agustus','September','Oktober','November','Desember'];
function ymAdd(ym, n) { var y = +ym.slice(0, 4), m = +ym.slice(5, 7) - 1 + n; var d = new Date(y, m, 1); return d.getFullYear() + '-' + pad2(d.getMonth() + 1); }
function ymLabel(ym) { return BLN[+ym.slice(5, 7) - 1] + ' ' + ym.slice(0, 4); }
function monthStats(sid, ym) {
  var from = ym + '-01', to = ym + '-31';
  return Promise.all([
    db.collection(P(sid, 'tx')).where('date', '>=', from).where('date', '<=', to).get(),
    db.collection(P(sid, 'mv')).where('date', '>=', from).where('date', '<=', to).get()
  ]).then(function (r) {
    var accs = accsByShop[sid] || [];
    var s = { n: 0, omzet: 0, keluar: 0, stok: 0, retur: 0, masuk: 0, laba: 0, kN: 0, kTot: 0, byType: {}, byDay: {} };
    r[0].docs.forEach(function (d) {
      var x = d.data(), e = WA.fx(x, accs), ly = WA.lk(x.type), a = +x.amount || 0;
      s.laba += e.laba; s.byDay[x.date] = (s.byDay[x.date] || 0) + e.laba;
      if (ly === 'keluar') { if (x.stok) s.stok += a; else if (x.retur) s.retur += a; else s.keluar += a; return; }
      if (ly === 'masuk') { s.masuk += a; return; }
      s.n++;
      if (x.ksr) { s.kN++; s.kTot += a; }
      if (ly !== 'isi' && ly !== 'jual') s.omzet += a;
      var label = (TYPES[x.type] || {}).label || x.type;
      s.byType[label] = (s.byType[label] || 0) + 1;
    });
    r[1].docs.forEach(function (d) { var m = d.data(); if (m.type === 'pindah') { var f = +m.fee || 0; s.keluar += f; s.laba -= f; s.byDay[m.date] = (s.byDay[m.date] || 0) - f; } });
    return s;
  });
}
function monthText(sid, ym) {
  return Promise.all([monthStats(sid, ym), monthStats(sid, ymAdd(ym, -1)), getDebts(sid)]).then(function (r) {
    var s = r[0], pv = r[1], ds = r[2];
    var L = ['📅 *Laporan bulan ' + ymLabel(ym) + '*', ''];
    if (!s.n && !s.keluar && !s.masuk && !s.stok) { L.push('Belum ada transaksi bulan ini.'); return L.join('\n'); }
    L.push('• Jumlah transaksi: ' + s.n);
    L.push('• Omzet layanan: ' + rp(s.omzet));
    if (s.kN) L.push('• Penjualan dari Kasir: ' + s.kN + ' (' + rp(s.kTot) + ')');
    if (s.masuk) L.push('• Pemasukan lain: ' + rp(s.masuk));
    L.push('• Pengeluaran: ' + rp(s.keluar));
    if (s.stok) L.push('• Belanja stok: ' + rp(s.stok) + ' (tidak mengurangi laba)');
    if (s.retur) L.push('• Retur ke pelanggan: ' + rp(s.retur));
    var cmp = '';
    if (pv.laba) { var pc = Math.round((s.laba - pv.laba) / Math.abs(pv.laba) * 100); cmp = ' (' + (pc >= 0 ? '▲ ' : '▼ ') + Math.abs(pc) + '% dari ' + BLN[+ymAdd(ym, -1).slice(5, 7) - 1] + ')'; }
    L.push('• *Laba bersih: ' + rp(s.laba) + '*' + cmp);
    var tp = Object.keys(s.byType).sort(function (a, b) { return s.byType[b] - s.byType[a]; }).slice(0, 3);
    if (tp.length) { L.push(''); L.push('*Jenis terbanyak:*'); tp.forEach(function (k) { L.push('• ' + k + ': ' + s.byType[k]); }); }
    var days = Object.keys(s.byDay).sort(function (a, b) { return s.byDay[b] - s.byDay[a]; });
    if (days.length && s.byDay[days[0]] > 0) { L.push(''); L.push('🏆 Hari terbaik: ' + (+days[0].slice(8, 10)) + ' ' + BLN[+ym.slice(5, 7) - 1] + ' (laba ' + rp(s.byDay[days[0]]) + ')'); }
    var pt = 0, ut = 0; ds.forEach(function (d) { var l = debtLeft(d); if (d.kind === 'piutang') pt += l; else ut += l; });
    if (pt || ut) { L.push(''); L.push('Piutang belum dibayar: ' + rp(pt) + (ut ? ' · Utang kita: ' + rp(ut) : '')); }
    return L.join('\n');
  });
}
var lapBusy = false;
async function cekLaporanBulan() {
  if (lapBusy || !curSock || !curSock.user) return;
  var now = new Date(); if (now.getDate() > 3 || now.getHours() < 8) return;
  lapBusy = true;
  try {
    var ym = ymAdd(now.getFullYear() + '-' + pad2(now.getMonth() + 1), -1), st = readJson(LAP_STATE), seen = {}, list = rekapTargets().filter(function (t) { return !t.norekap; });
    for (var i = 0; i < list.length; i++) {
      var t = list[i], key = t.sid + '|' + t.jid; if (seen[key]) continue; seen[key] = 1;
      if (st[key] === ym) continue;
      await refreshAccs(t.sid);
      var txt = await monthText(t.sid, ym);
      await curSock.sendMessage(t.jid, { text: txt + '\n\n_Laporan otomatis ' + t.nama + '_' });
      st[key] = ym; try { fs.writeFileSync(LAP_STATE, JSON.stringify(st)); } catch (e) {}
      console.log(new Date().toLocaleString('id-ID'), '- laporan bulanan terkirim ke', t.nama);
    }
  } catch (e) { console.error('[PERINGATAN] laporan bulanan gagal:', e && e.message ? e.message : e); }
  lapBusy = false;
}

var BUKA_RE = /^buka\s+kas\b/i;
var STATUSKAS_RE = /^(status\s+kas|cek\s+kas)\s*$/i;
function bukuLaci(sid) {
  return Promise.all([
    db.collection(P(sid, 'acc')).get(), db.collection(P(sid, 'tx')).get(), db.collection(P(sid, 'mv')).get(),
    db.doc(P(sid, 'settings/main')).get(), getDebts(sid)
  ]).then(function (r) {
    var accs = r[0].docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); });
    var kasAwal = r[3].exists ? (+r[3].data().kasAwal || 0) : 0;
    var c = WA.calcBalance(accs, kasAwal, r[1].docs.map(function (d) { return d.data(); }), r[2].docs.map(function (d) { return d.data(); }), r[4]);
    return { kas: c.kas, st: r[3].exists ? r[3].data() : {} };
  });
}
async function statusKasText(sid) {
  await refreshAccs(sid);
  var b = await bukuLaci(sid);
  return ['💰 *Status kas*', '_' + tgl(todayStr()) + '_', '', '• ' + kasStatusLine(sid), '• Uang di laci (menurut buku): ' + rp(b.kas), '',
    'Untuk membuka kas: buka kas 500rb pagi'].join('\n');
}
async function bukaKas(sid, text) {
  var toks = text.replace(BUKA_RE, '').trim().split(/\s+/).filter(Boolean);
  var amt = null, shf = '', samakan = false;
  toks.forEach(function (t) {
    var l = t.toLowerCase();
    if (l === 'pagi' || l === 'malam') shf = l;
    else if (l === 'samakan' || l === 'sesuaikan') samakan = true;
    else if (amt === null) amt = WA.waAmount(l);
  });
  await refreshAccs(sid);
  var b = await bukuLaci(sid);
  if (amt === null || !(amt >= 0)) {
    return ['🛠️ *Buka kas*', 'Tulis modal awal (uang di laci) dan shift, contoh:', '', 'buka kas 500rb pagi', 'buka kas 300rb malam', '',
      'Uang di laci menurut buku sekarang: ' + rp(b.kas), 'Tambahkan kata "samakan" bila catatan buku mau disamakan dengan modal awal.'].join('\n');
  }
  if (!shf) shf = new Date().getHours() < 15 ? 'pagi' : 'malam';
  var td = todayStr(), st = b.st, old = Array.isArray(st.opens) ? st.opens : [];
  var nu = old.filter(function (x) { return !(x && x.date === td && x.shift === shf); })
    .concat([{ date: td, shift: shf, modal: amt, buku: Math.round(b.kas), by: 'WhatsApp', at: Date.now() }]).slice(-60);
  var patch = { opens: nu };
  var d = amt - Math.round(b.kas);
  if (samakan && d !== 0) patch.kasAwal = (+st.kasAwal || 0) + d;
  await db.doc(P(sid, 'settings/main')).set(patch, { merge: true });
  settingsByShop[sid] = Object.assign({}, settingsByShop[sid] || {}, { opens: nu });
  var L = ['✅ *Kas dibuka*', '_' + tgl(td) + ' · ' + jamStr() + '_', '', '• Shift: ' + shiftLbl(shf), '• Modal awal: ' + rp(amt)];
  if (d === 0) L.push('• Sama dengan catatan buku (' + rp(b.kas) + ')');
  else if (samakan) L.push('• Catatan buku disamakan: dari ' + rp(b.kas) + ' menjadi ' + rp(amt));
  else L.push('• Beda ' + rpS(d) + ' dari catatan buku (' + rp(b.kas) + '). Buku tidak diubah. Kirim "buka kas ' + amt + ' ' + shf + ' samakan" bila mau disamakan.');
  L.push('', 'Transaksi berikutnya hari ini otomatis ditandai shift ' + shiftLbl(shf) + '.');
  return L.join('\n');
}

/* ---------- koreksi saldo (samakan catatan dengan uang/saldo yang sebenarnya) ----------
   Sama seperti "Ubah saldo" di aplikasi: selisih dicatat sebagai koreksi saldo awal,
   jadi tidak muncul sebagai transaksi dan tidak mengubah laba. Memakai nilai tujuan (bukan
   selisih), jadi kalau pesan terproses dua kali hasilnya tetap sama. */
var KOREKSI_RE = /^(koreksi|samakan|sesuaikan)\b/i;
var KAS_WORDS = { laci: 1, kas: 1, tunai: 1, cash: 1 };
function rpS(n) { return (n > 0 ? '+' : n < 0 ? '−' : '') + rp(Math.abs(n)); }

function koreksiSaldo(sid, text, judul) {
  return Promise.all([
    db.collection(P(sid, 'acc')).get(),
    db.collection(P(sid, 'tx')).get(),
    db.collection(P(sid, 'mv')).get(),
    db.doc(P(sid, 'settings/main')).get(),
    getDebts(sid)
  ]).then(function (r) {
    var accs = r[0].docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); });
    var txs = r[1].docs.map(function (d) { return d.data(); });
    var mvs = r[2].docs.map(function (d) { return d.data(); });
    var kasAwal = r[3].exists ? (+r[3].data().kasAwal || 0) : 0;
    accsByShop[sid] = accs;
    var c = calcBalance(accs, kasAwal, txs, mvs, r[4]);

    var lines = text.split(/\r?\n/).map(function (l) { return l.replace(KOREKSI_RE, '').trim(); }).filter(Boolean);
    if (!lines.length) {
      /* tanpa isi: kirim contoh yang tinggal disalin dan diubah angkanya */
      var T = ['🛠️ *Koreksi saldo*', 'Salin pesan di bawah, ubah angkanya sesuai saldo/uang yang sebenarnya, lalu kirim:', '', 'koreksi', 'laci ' + Math.round(c.kas)];
      accs.slice().sort(function (a, b) { return (a.createdAt || 0) - (b.createdAt || 0); }).forEach(function (a) {
        T.push(String(a.name).toLowerCase().replace(/\s+/g, '') + ' ' + Math.round(c.bal[a.id] || 0));
      });
      T.push('', 'Boleh satu per satu (contoh: "koreksi bri 5jt") atau hanya yang perlu dikoreksi.');
      return T.join('\n');
    }

    var targets = {}, order = [], bad = [];
    lines.forEach(function (ln) {
      var toks = ln.split(/\s+/).filter(Boolean), amount = null, name = [];
      toks.forEach(function (t) {
        var v = WA.waAmount(t.toLowerCase());
        if (v != null && amount == null) amount = v; else name.push(t);
      });
      if (amount == null) { bad.push('⚠️ Nominal tidak ditemukan: ' + shorten(ln)); return; }
      if (!name.length) { bad.push('⚠️ Nama rekening tidak ditulis: ' + shorten(ln)); return; }
      var id = null, amb = false;
      if (name.length === 1 && KAS_WORDS[name[0].toLowerCase().replace(/[^a-z]/g, '')]) id = WA.KAS;
      else if (name.every(function (w) { return KAS_WORDS[w.toLowerCase().replace(/[^a-z]/g, '')]; })) id = WA.KAS;
      else {
        var cands = [name.join('')].concat(name);
        for (var i = 0; i < cands.length && !id && !amb; i++) {
          var m = WA.waAcc(cands[i], null, accs);
          if (m && m.amb) amb = true; else if (m) id = m.id;
        }
      }
      if (amb) { bad.push('⚠️ Nama "' + name.join(' ') + '" cocok dengan lebih dari satu rekening, tulis lebih lengkap.'); return; }
      if (!id) { bad.push('⚠️ Rekening "' + name.join(' ') + '" tidak ditemukan.'); return; }
      if (!Object.prototype.hasOwnProperty.call(targets, id)) order.push(id);
      targets[id] = amount;
    });

    var jobs = [], out = [];
    order.forEach(function (id) {
      var cur = id === WA.KAS ? c.kas : (c.bal[id] || 0), now = targets[id], d = now - cur;
      var nm = id === WA.KAS ? 'Uang tunai laci' : accName(accs, id);
      if (!d) { out.push('• ' + nm + ': ' + rp(now) + ' (sudah sesuai)'); return; }
      if (id === WA.KAS) jobs.push(db.doc(P(sid, 'settings/main')).set({ kasAwal: kasAwal + d, example: false }, { merge: true }));
      else {
        var acc = accs.filter(function (a) { return a.id === id; })[0];
        jobs.push(db.doc(P(sid, 'acc/' + id)).update({ opening: (+acc.opening || 0) + d, example: false }));
      }
      out.push('• ' + nm + ': ' + rp(cur) + ' → ' + rp(now) + ' (' + rpS(d) + ')');
    });
    return Promise.all(jobs).then(function () {
      var head = order.length ? (bad.length ? '⚠️ ' : '✅ ') + '*Koreksi saldo' + (judul && judul.indexOf('Saldo ') === 0 ? ' ' + judul.slice(6) : '') + '*' : '⚠️ *Tidak ada yang dikoreksi*';
      var L = [head].concat(out);
      if (bad.length) L.push('', bad.join('\n'));
      if (order.length) L.push('', 'Salah angka? Kirim ulang dengan angka yang benar, hasilnya langsung diganti.');
      return L.join('\n');
    });
  });
}

/* ---------- peringatan saldo menipis (hanya bila batasnya diatur di aplikasi) ---------- */
function lowWarn(sid) {
  var ms = (settingsByShop[sid] && settingsByShop[sid].minSaldo) || {};
  if (!Object.keys(ms).some(function (k) { return +ms[k] > 0; })) return Promise.resolve('');
  return Promise.all([
    db.collection(P(sid, 'acc')).get(), db.collection(P(sid, 'tx')).get(), db.collection(P(sid, 'mv')).get(),
    db.doc(P(sid, 'settings/main')).get(), getDebts(sid)
  ]).then(function (r) {
    var accs = r[0].docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); });
    var kasAwal = r[3].exists ? (+r[3].data().kasAwal || 0) : 0;
    var c = WA.calcBalance(accs, kasAwal, r[1].docs.map(function (d) { return d.data(); }), r[2].docs.map(function (d) { return d.data(); }), r[4]);
    var L = [];
    Object.keys(ms).forEach(function (k) {
      var lim = +ms[k]; if (!(lim > 0)) return;
      var v = k === 'kas' ? c.kas : c.bal[k]; if (v === undefined) return;
      if (v < lim) L.push('• ' + accName(accs, k) + ': ' + rp(v) + ' (batas ' + rp(lim) + ')');
    });
    return L.length ? '⚠️ *Saldo menipis, segera isi:*\n' + L.join('\n') : '';
  }).catch(function () { return ''; });
}

/* ---------- hapus / ubah transaksi terakhir yang dicatat bot ---------- */
var HAPUS_RE = /^(hapus|batal|batalkan)\s+(transaksi\s+)?terakhir\s*$/i;
var UBAH_RE = /^(ubah|edit|ganti)\s+(transaksi\s+)?terakhir\b/i;
function lastBotDoc(sid) {
  return Promise.all(['tx', 'mv'].map(function (c) {
    return db.collection(P(sid, c)).orderBy('createdAt', 'desc').limit(15).get().then(function (snap) {
      return snap.docs.filter(function (d) { var w = d.data().wa; return typeof w === 'string' && w.indexOf('bot:') === 0; })
        .map(function (d) { return { ref: d.ref, col: c, data: d.data() }; });
    });
  })).then(function (r) {
    var all = r[0].concat(r[1]);
    all.sort(function (a, b) { return (b.data.createdAt || 0) - (a.data.createdAt || 0); });
    return all[0] || null;
  });
}
function describeDoc(d, accs) {
  var o = d.data;
  if (d.col === 'mv') return 'Pindah saldo ' + rp(o.amount) + ' dari ' + accName(accs, o.from) + ' ke ' + accName(accs, o.to) + (o.fee ? ', fee ' + rp(o.fee) : '');
  var T = TYPES[o.type] || {};
  return (T.label || o.type) + (T.onlyAdm ? ' admin ' + rp(o.fee) : ' ' + rp(o.amount)) + (!T.onlyAdm && o.fee ? ', admin ' + rp(o.fee) : '') + (o.name ? ' (' + o.name + ')' : '') + ' · ' + tgl(o.date);
}
function hapusTerakhir(sid) {
  return lastBotDoc(sid).then(function (d) {
    if (!d) return 'Tidak ada transaksi dari bot yang bisa dihapus.';
    return refreshAccs(sid).then(function (accs) {
      var linked = d.col === 'tx' && d.data.pay === 'utang' ? getDebts(sid).then(function (ds) { return ds.filter(function (x) { return x.txId === d.ref.id; })[0] || null; }) : Promise.resolve(null);
      return linked.then(function (ld) {
        if (ld && (ld.pays || []).length) return Promise.reject(new Error('piutang transaksi ini sudah dicicil. Hapus dulu lewat menu Utang piutang di aplikasi.'));
        return d.ref.delete().then(function () { return ld ? ld.ref.delete() : null; });
      }).then(function () { return '🗑️ *Transaksi terakhir dihapus*\n• ' + describeDoc(d, accs) + '\n\nSalah hapus? Kirim ulang pesan transaksinya.'; });
    });
  });
}
function ubahTerakhir(sid, text) {
  var rest = text.replace(UBAH_RE, '').trim();
  var EX = 'Contoh: ubah terakhir admin 3000\nubah terakhir nominal 150rb\nubah terakhir tf bri\nubah terakhir cash';
  if (!rest) return Promise.resolve('Tulis apa yang diubah.\n' + EX);
  return Promise.all([lastBotDoc(sid), refreshAccs(sid)]).then(function (r) {
    var d = r[0], accs = r[1];
    if (!d) return 'Tidak ada transaksi dari bot yang bisa diubah.';
    if (d.col === 'tx' && d.data.pay === 'utang') return 'Transaksi utang tidak bisa diubah. Kirim "hapus terakhir" lalu kirim ulang pesan yang benar.';
    if (d.col === 'mv') return 'Pindah saldo tidak bisa diubah. Kirim "hapus terakhir" lalu kirim ulang pesan yang benar.';
    var o = d.data, T = TYPES[o.type] || {}, toks = rest.split(/\s+/), upd = {}, ch = [], err = '';
    for (var i = 0; i < toks.length && !err; i++) {
      var w = toks[i].toLowerCase();
      var nextAmt = i + 1 < toks.length ? WA.waAmount(toks[i + 1]) : null;
      if (w === 'admin' || w === 'adm' || w === 'fee') { if (nextAmt == null) err = 'Nilai admin belum ditulis.'; else { upd.fee = nextAmt; ch.push('Admin: ' + rp(o.fee) + ' → ' + rp(nextAmt)); i++; } }
      else if (w === 'komisi' || w === 'kom') { if (nextAmt == null) err = 'Nilai komisi belum ditulis.'; else { upd.komisi = nextAmt; ch.push('Komisi: ' + rp(o.komisi) + ' → ' + rp(nextAmt)); i++; } }
      else if (w === 'pot' || w === 'potongan') { if (nextAmt == null) err = 'Nilai potongan belum ditulis.'; else { upd.bf = nextAmt; ch.push('Potongan bank: ' + rp(o.bf) + ' → ' + rp(nextAmt)); i++; } }
      else if (w === 'nominal' || w === 'jumlah') { if (nextAmt == null) err = 'Nominal belum ditulis.'; else if (T.onlyAdm) err = 'Kartu ATM tidak punya nominal. Ubah adminnya.'; else { upd.amount = nextAmt; ch.push('Nominal: ' + rp(o.amount) + ' → ' + rp(nextAmt)); i++; } }
      else if (w === 'cash' || w === 'tunai') { if (!T.pay) err = 'Jenis ini tidak punya pilihan cash/transfer.'; else { upd.pay = 'cash'; upd.payAcc = admin.firestore.FieldValue.delete(); ch.push('Pelanggan bayar: tunai (cash)'); } }
      else if (w === 'tf' || w === 'trf' || w === 'transfer') {
        if (!T.pay) { err = 'Jenis ini tidak punya pilihan cash/transfer.'; break; }
        var ra = i + 1 < toks.length ? WA.waAcc(toks[i + 1].toLowerCase(), null, accs) : null;
        if (ra && ra.amb) { err = 'Nama rekening cocok dengan lebih dari satu rekening.'; break; }
        var pid = ra ? ra.id : null; if (ra) i++;
        if (!pid) { var pl = accs.filter(function (a) { return a.kind === 'bank' || a.kind === 'ewallet'; }); if (pl.length === 1) pid = pl[0].id; }
        if (!pid) err = 'Tulis rekening tujuan transfer, misalnya "ubah terakhir tf bri".';
        else { upd.pay = 'transfer'; upd.payAcc = pid; ch.push('Pelanggan bayar: transfer ke ' + accName(accs, pid)); }
      }
      else err = 'Bagian "' + toks[i] + '" tidak dikenali.';
    }
    if (err) return '⚠️ ' + err + '\n' + EX;
    if (!ch.length) return '⚠️ Tidak ada yang diubah.\n' + EX;
    return d.ref.update(upd).then(function () { return '✅ *Transaksi terakhir diubah*\n• ' + describeDoc(d, accs) + '\n' + ch.map(function (x) { return '• ' + x; }).join('\n'); });
  });
}

/* ---------- rekap harian otomatis ---------- */
var REKAP_PATH = path.join(ROOT, 'rekap-state.json');
function readRekapState() { try { return JSON.parse(fs.readFileSync(REKAP_PATH, 'utf8')) || {}; } catch (e) { return {}; } }
function writeRekapState(st) { try { fs.writeFileSync(REKAP_PATH, JSON.stringify(st)); } catch (e) { console.error('[PERINGATAN] rekap-state.json tidak bisa ditulis:', e.message); } }
/* jam pengingat utang piutang: bawaan 08.00; tulis "ingatJam": false di toko.json untuk mematikan */
function ingatOf(o) {
  var j = o ? o.ingatJam : undefined;
  if (j === false || j === null) return false;
  if (j === undefined || isNaN(+j)) return 8;
  return +j;
}
function rekapTargets() {
  var out = [], u = readTokoFile().utama, jamU = (u && u.rekapJam !== undefined) ? u.rekapJam : 23;
  /* pengingat boleh jalan tanpa rekap harian: baris dengan rekapJam false tetap dipakai kalau ingatJam (angka) atau ingatPelanggan diisi */
  function ingatEksplisit(o) { return !!(o && ((o.ingatJam !== undefined && o.ingatJam !== null && o.ingatJam !== false && !isNaN(+o.ingatJam)) || o.ingatPelanggan === true)); }
  if (ownShopId && curSock && curSock.user && curSock.user.id) {
    var recapOnU = jamU !== false && jamU !== null && !isNaN(+jamU);
    if (recapOnU || ingatEksplisit(u)) {
      var me = String(curSock.user.id).split(':')[0].split('@')[0];
      out.push({ sid: ownShopId, jid: me + '@s.whatsapp.net', jam: recapOnU ? +jamU : 99, norekap: !recapOnU, nama: 'Toko utama', ingat: ingatOf(u), cust: !!(u && u.ingatPelanggan === true), namaToko: (u && u.namaToko) || '', kontak: (u && u.kontak) ? String(u.kontak) : '' });
    }
  }
  tokoList.forEach(function (t) {
    var recapOn = !(t.rekapJam === undefined || t.rekapJam === null || t.rekapJam === false || isNaN(+t.rekapJam));
    if (!recapOn && !ingatEksplisit(t)) return;
    var n = TOKO.normNum(t.nomor); if (!n) return;
    out.push({ sid: t.shopId, jid: n + '@s.whatsapp.net', jam: recapOn ? +t.rekapJam : 99, norekap: !recapOn, nama: t.nama, ingat: ingatOf(t), cust: t.ingatPelanggan === true, namaToko: t.namaToko || t.nama || '', kontak: t.kontak ? String(t.kontak) : (hpOf(t.nomor) || '') });
  });
  return out;
}
var rekapBusy = false;
function cekRekap() {
  if (rekapBusy || !curSock) return;
  var now = new Date(), today = todayStr(), st = readRekapState(), list = rekapTargets();
  var due = list.filter(function (t) { return !t.norekap && now.getHours() >= t.jam && st[t.sid + '|' + t.jid] !== today; });
  if (!due.length) return;
  rekapBusy = true;
  var sock = curSock;
  due.reduce(function (p, t) {
    return p.then(function () {
      return refreshAccs(t.sid).then(function () { return Promise.all([todayText(t.sid), saldoText(t.sid, 'Saldo ' + t.nama)]); }).then(function (r) {
        return Promise.all([lowWarn(t.sid), stokLowWarn(t.sid)]).then(function (ws) {
          var w = ws[0], w2 = ws[1];
          return sock.sendMessage(t.jid, { text: '🌙 *Rekap harian ' + t.nama + '*\n\n' + r[0] + '\n\n' + r[1] + (w ? '\n\n' + w : '') + (w2 ? '\n\n' + w2 : '') });
        });
      }).then(function () { st[t.sid + '|' + t.jid] = today; writeRekapState(st); console.log(new Date().toLocaleString('id-ID'), '- rekap harian terkirim ke', t.nama); })
        .catch(function (e) { console.error('[PERINGATAN] Rekap harian ' + t.nama + ' gagal:', e && e.message ? e.message : e); });
    });
  }, Promise.resolve()).then(function () { rekapBusy = false; }, function () { rekapBusy = false; });
}
var rekapTimer = null;

/* ---------- pengingat utang piutang jatuh tempo ---------- */
var ingatBusy = false;
function ingatText(ds) {
  var td = todayStr(), soon = new Date(); soon.setDate(soon.getDate() + 3);
  var lim = soon.getFullYear() + '-' + pad2(soon.getMonth() + 1) + '-' + pad2(soon.getDate());
  var open = ds.filter(function (d) { return debtLeft(d) > 0 && d.due && d.due <= lim; });
  if (!open.length) return '';
  open.sort(function (a, b) { return a.due < b.due ? -1 : 1; });
  function line(d) {
    var n = Math.round((new Date(d.due + 'T00:00:00') - new Date(td + 'T00:00:00')) / 864e5);
    var tag = n < 0 ? 'terlambat ' + (-n) + ' hari' : n === 0 ? 'jatuh tempo HARI INI' : 'tempo ' + n + ' hari lagi';
    return '• ' + (d.name || 'Tanpa nama') + ': ' + rp(debtLeft(d)) + ' (' + tag + ')';
  }
  var P1 = open.filter(function (d) { return d.kind === 'piutang'; }), U1 = open.filter(function (d) { return d.kind !== 'piutang'; });
  var L = ['⏰ *Pengingat utang piutang*', ''];
  if (P1.length) { L.push('*Tagih (piutang)*'); P1.forEach(function (d) { L.push(line(d)); }); L.push(''); }
  if (U1.length) { L.push('*Bayar (utang kita)*'); U1.forEach(function (d) { L.push(line(d)); }); L.push(''); }
  L.push('_Bayar: "bayar piutang budi 50rb" · Lunas: "lunas budi"_');
  return L.join('\n');
}
/* ---------- pengingat ke pelanggan yang berutang (bot v21) ----------
   Hanya jalan kalau di toko.json ditulis "ingatPelanggan": true. Dikirim ke nomor HP yang tersimpan di catatan piutang. */
var CUST_PATH = path.join(ROOT, 'ingat-pelanggan-state.json');
function readCustState() { try { return JSON.parse(fs.readFileSync(CUST_PATH, 'utf8')) || {}; } catch (e) { return {}; } }
function writeCustState(st) { try { fs.writeFileSync(CUST_PATH, JSON.stringify(st)); } catch (e) { console.error('[PERINGATAN] ingat-pelanggan-state.json tidak bisa ditulis:', e.message); } }
function dayDiff(a, b) { return Math.round((new Date(b + 'T00:00:00') - new Date(a + 'T00:00:00')) / 864e5); }
/* nomor WhatsApp Indonesia (08..., 628..., +628...). Hasil 08xxxxxxxxx, atau '' kalau bukan nomor */
function hpOf(t) {
  var d = String(t || '').replace(/[^\d]/g, '');
  if (!/^(62|0)8\d{8,12}$/.test(d)) return '';
  return d.indexOf('62') === 0 ? '0' + d.slice(2) : d;
}
function custText(d, namaToko, kontak) {
  var td = todayStr(), n = dayDiff(td, d.due), left = debtLeft(d);
  var tag = n < 0 ? 'sudah lewat jatuh tempo ' + (-n) + ' hari (tempo ' + tgl(d.due) + ')' : n === 0 ? 'jatuh tempo hari ini' : 'jatuh tempo besok (' + tgl(d.due) + ')';
  return 'Halo ' + (d.name || 'Kak') + ', ini pengingat dari ' + (namaToko || 'toko kami') + '.\n\nPiutang Anda ' + rp(left) + (debtPaid(d) ? ' (sisa dari ' + rp(d.amount) + ')' : '') + ' ' + tag + '.\n\nMohon segera diselesaikan ya. Abaikan pesan ini kalau Anda sudah membayar.' + (kontak ? '\nHubungi kami di ' + kontak + ' kalau ada pertanyaan.' : '') + '\nTerima kasih 🙏';
}
/* kirim pengingat: mulai sehari sebelum jatuh tempo, lalu tiap 3 hari selama belum lunas, paling banyak 5 kali per catatan, paling banyak 15 pesan per hari */
async function kirimPengingatPelanggan(sock, t, ds) {
  var out = { ok: [], gagal: [] };
  if (!t.cust) return out;
  var today = todayStr(), st = readCustState();
  var owner = String(t.jid || '').split('@')[0];
  var cand = ds.filter(function (d) { return d.kind === 'piutang' && debtLeft(d) > 0 && d.due && hpOf(d.hp); });
  for (var i = 0; i < cand.length; i++) {
    var d = cand[i], key = t.sid + '|' + d.id, s = st[key] || { n: 0, last: '' };
    if (dayDiff(today, d.due) > 1) continue;
    if (s.n >= 5) continue;
    if (s.last && dayDiff(s.last, today) < 3) continue;
    if (out.ok.length >= 15) break;
    var num = TOKO.normNum(hpOf(d.hp));
    if (num === owner) continue;
    try {
      try { var ex = await sock.onWhatsApp(num); if (ex && ex[0] && ex[0].exists === false) { out.gagal.push(d.name + ' (nomor tidak memakai WhatsApp)'); st[key] = { n: 5, last: today }; continue; } } catch (e0) { /* lanjut kirim saja */ }
      await sock.sendMessage(num + '@s.whatsapp.net', { text: custText(d, t.namaToko, t.kontak) });
      st[key] = { n: s.n + 1, last: today };
      out.ok.push({ name: d.name || 'Tanpa nama', left: debtLeft(d), hp: hpOf(d.hp) });
      console.log(new Date().toLocaleString('id-ID'), '- pengingat ke pelanggan terkirim:', d.name);
    } catch (e) { out.gagal.push((d.name || 'Tanpa nama') + ' (' + (e && e.message ? e.message : 'gagal') + ')'); }
    writeCustState(st);
    await new Promise(function (r) { setTimeout(r, 3000 + Math.floor(Math.random() * 3000)); });
  }
  writeCustState(st);
  return out;
}
function custSummary(r) {
  if (!r.ok.length && !r.gagal.length) return '';
  var L = ['📨 *Pengingat ke pelanggan*'];
  r.ok.forEach(function (x) { L.push('• Terkirim: ' + x.name + ' (' + x.hp + ') ' + rp(x.left)); });
  r.gagal.forEach(function (x) { L.push('• Gagal: ' + x); });
  return L.join('\n');
}
function cekIngat() {
  if (ingatBusy || !curSock) return;
  var now = new Date(), today = todayStr(), st = readRekapState(), list = rekapTargets();
  var due = list.filter(function (t) { return t.ingat !== false && now.getHours() >= t.ingat && st['ingat|' + t.sid + '|' + t.jid] !== today; });
  if (!due.length) return;
  ingatBusy = true;
  var sock = curSock;
  due.reduce(function (p, t) {
    return p.then(function () {
      return getDebts(t.sid).then(function (ds) {
        var txt = ingatText(ds);
        return (txt ? sock.sendMessage(t.jid, { text: txt }) : Promise.resolve()).then(function () {
          var st2 = readRekapState(); st2['ingat|' + t.sid + '|' + t.jid] = today; writeRekapState(st2);
          if (txt) console.log(new Date().toLocaleString('id-ID'), '- pengingat utang terkirim ke', t.nama);
          return kirimPengingatPelanggan(sock, t, ds).then(function (r) { var sm = custSummary(r); return sm ? sock.sendMessage(t.jid, { text: sm }) : null; });
        });
      }).catch(function (e) { console.error('[PERINGATAN] Pengingat utang ' + t.nama + ' gagal:', e && e.message ? e.message : e); });
    });
  }, Promise.resolve()).then(function () { ingatBusy = false; }, function () { ingatBusy = false; });
}

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
    var n = 0, keluar = 0, masuk = 0, laba = 0, omzet = 0, byType = {}, kN = 0, kTot = 0;
    txs.forEach(function (x) {
      var e = WA.fx(x, accsByShop[sid] || []), ly = WA.lk(x.type);
      laba += e.laba;
      if (ly === 'keluar') { keluar += +x.amount || 0; return; }
      if (ly === 'masuk') { masuk += +x.amount || 0; return; }
      n++;
      if (x.ksr) { kN++; kTot += +x.amount || 0; }
      if (ly !== 'isi' && ly !== 'jual') omzet += +x.amount || 0;
      var label = (TYPES[x.type] || {}).label || x.type;
      byType[label] = (byType[label] || 0) + 1;
    });
    var moveFee = mvs.reduce(function (a, m) { return a + (m.type === 'pindah' ? (+m.fee || 0) : 0); }, 0);
    keluar += moveFee; laba -= moveFee;
    var L = ['📊 *Transaksi hari ini*'];
    L.push('_' + tgl(t) + '_');
    L.push('');
    L.push('• ' + kasStatusLine(sid));
    L.push('• Jumlah transaksi: ' + n + (mvs.length ? ' (+ ' + mvs.length + ' pindah saldo)' : ''));
    if (kN) L.push('• Penjualan dari Kasir: ' + kN + ' (' + rp(kTot) + ')');
    if (masuk) L.push('• Pemasukan: ' + rp(masuk));
    L.push('• Omzet: ' + rp(omzet));
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
var curSock = null, tokoLoaded = false, reconnTimer = null;
var ownEnabled = true;
process.on('unhandledRejection', function (e) { console.error('[PERINGATAN] Error tidak tertangkap:', e && e.message ? e.message : e); });
process.on('uncaughtException', function (e) { console.error('[PERINGATAN] Error:', e && e.message ? e.message : e); });
function scheduleReconnect(ms) {
  if (reconnTimer) return;                      /* cegah banyak sambungan menumpuk */
  reconnTimer = setTimeout(function () {
    reconnTimer = null;
    start().catch(function (e) { console.error('Gagal menyambung ulang:', e && e.message ? e.message : e); scheduleReconnect(10000); });
  }, ms);
}
async function start() {
  /* tutup sambungan lama dulu supaya tidak ada dua sambungan dengan sesi yang sama */
  if (curSock) {
    try { curSock.ev.removeAllListeners(); } catch (e) {}
    try { curSock.end(undefined); } catch (e) {}
    curSock = null;
  }
  await resolveShopId();
  await refreshAccs(ownShopId);
  if (!tokoLoaded) {
    await loadToko(); tokoLoaded = true;
    var uCfg = readTokoFile().utama;
    ownEnabled = !(uCfg && uCfg.pesanSendiri === false);
    console.log(ownEnabled ? 'Pesan yang diketik dari HP bot ini ikut dicatat.' : 'Pesan yang diketik dari HP bot ini DIABAIKAN. Hanya nomor terdaftar di toko.json yang dicatat.');
  }
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

  curSock = sock;
  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', function (u) {
    if (u.qr) {
      console.log('\nScan QR ini dengan WhatsApp yang mau dipakai bot (Linked devices > Link a device):\n');
      qrcode.generate(u.qr, { small: true });
    }
    if (u.connection === 'close') {
      var err = u.lastDisconnect && u.lastDisconnect.error;
      var code = err && err.output && err.output.statusCode;
      var loggedOut = code === DisconnectReason.loggedOut;
      var replaced = code === DisconnectReason.connectionReplaced;
      console.log('Koneksi WhatsApp terputus. Kode:', code, '|', (err && err.message) || '-');
      if (loggedOut) {
        console.log('Sesi keluar. Hapus folder session lalu scan ulang: rm -rf session');
      } else if (replaced) {
        console.log('SESI DIPAKAI DI TEMPAT LAIN (kode 440). Kemungkinan ada bot kedua yang masih jalan. Jalankan: pkill -f index.js lalu start ulang SATU saja. Mencoba lagi 30 detik...');
        scheduleReconnect(30000);
      } else {
        scheduleReconnect(code === 428 || code === 408 ? 8000 : 3000);
      }
    } else if (u.connection === 'open') {
      console.log('\n✅ Tersambung ke WhatsApp. Bot siap mencatat transaksi.\n');
      if (!rekapTimer) { rekapTimer = setInterval(function () { cekRekap(); cekIngat(); }, 60000); setInterval(cekPendaftar, 120000); setInterval(cekSaldo, 600000); setInterval(cekCadangan, 900000); setInterval(cekLaporanBulan, 1800000); setTimeout(cekLaporanBulan, 70000); setTimeout(cekSaldo, 45000); setTimeout(cekRekap, 15000); setTimeout(cekIngat, 25000); setTimeout(ensureAdmin, 5000); setTimeout(cekPendaftar, 35000); }
    }
  });

  sock.ev.on('messages.upsert', async function (ev) {
    if (ev.type !== 'notify') return;
    for (var i = 0; i < ev.messages.length; i++) {
      var msg = ev.messages[i];
      try { await handleMessage(sock, msg); } catch (e) {
        console.error('Gagal memproses pesan:', e && e.stack ? e.stack : e);
        /* beri tahu pengirim kenapa gagal, supaya tidak hening (kecuali balasan bot sendiri) */
        try {
          var mm = msg.message, tt = ((mm && (mm.conversation || (mm.extendedTextMessage && mm.extendedTextMessage.text))) || '').trim();
          if (tt && !/^(✅|⚠️|💰|📊)/.test(tt) && msg.key.remoteJid && !msg.key.remoteJid.endsWith('@g.us')) {
            await sock.sendMessage(msg.key.remoteJid, { text: '⚠️ Bot gagal mencatat: ' + String((e && e.message) || e).slice(0, 200) }, { quoted: msg });
          }
        } catch (e2) { /* abaikan */ }
      }
    }
  });
}


/* ---------- perintah utang piutang lewat WhatsApp ---------- */
var DEBT_RE = /^(piutang|utang|hutang|daftar\s+(utang|piutang|hutang)|cek\s+(utang|piutang|hutang)|bayar\s+(piutang|utang|hutang)|lunas|nomor|tempo)\b/i;
function nrm(x) { return String(x || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }
function tglPendek(d) { return d ? tgl(d) : ''; }
function debtList(ds, judul) {
  var open = ds.filter(function (d) { return debtLeft(d) > 0; });
  open.sort(function (a, b) { var x = a.due || '9999', y = b.due || '9999'; return x < y ? -1 : x > y ? 1 : 0; });
  var td = todayStr();
  function line(d) { return '• ' + (d.name || 'Tanpa nama') + ': ' + rp(debtLeft(d)) + (debtPaid(d) ? ' (dari ' + rp(d.amount) + ')' : '') + (d.due ? ' · tempo ' + tglPendek(d.due) + (d.due < td ? ' ⚠️ terlambat' : '') : ''); }
  var P1 = open.filter(function (d) { return d.kind === 'piutang'; }), U1 = open.filter(function (d) { return d.kind !== 'piutang'; });
  var tp = P1.reduce(function (a, d) { return a + debtLeft(d); }, 0), tu = U1.reduce(function (a, d) { return a + debtLeft(d); }, 0);
  var L = ['📊 *' + judul + '*', ''];
  if (!open.length) return L.concat(['Tidak ada utang atau piutang yang belum lunas.']).join('\n');
  if (P1.length) { L.push('*Piutang (belum dibayar ke kita): ' + rp(tp) + '*'); P1.forEach(function (d) { L.push(line(d)); }); L.push(''); }
  if (U1.length) { L.push('*Utang kita: ' + rp(tu) + '*'); U1.forEach(function (d) { L.push(line(d)); }); L.push(''); }
  L.push('_Bayar: "bayar piutang budi 50rb"  ·  Lunas: "lunas budi"_');
  return L.join('\n');
}
function findDebt(ds, name, kind) {
  var q = nrm(name);
  var pool = ds.filter(function (d) { return debtLeft(d) > 0 && (!kind || (kind === 'piutang') === (d.kind === 'piutang')); });
  var ex = pool.filter(function (d) { return nrm(d.name) === q; });
  var hit = ex.length ? ex : pool.filter(function (d) { return q && nrm(d.name).indexOf(q) >= 0; });
  return hit;
}
function pickAccTok(toks, accs) {
  /* cari kata kunci rekening setelah dari/ke/masuk, atau "tanpa kas". Mengembalikan {acc, rest} */
  var acc = null, rest = [], bad = null;
  for (var i = 0; i < toks.length; i++) {
    var w = toks[i].toLowerCase();
    if (w === 'tanpa' || w === 'notrx') { acc = 'none'; if (toks[i + 1] && /^(kas|laci|saldo)$/i.test(toks[i + 1])) i++; continue; }
    if ((w === 'dari' || w === 'ke' || w === 'masuk' || w === 'via') && toks[i + 1]) {
      var nx = toks[i + 1].toLowerCase();
      if (KAS_WORDS[nx]) { acc = 'kas'; i++; continue; }
      var a = WA.waAcc(nx, null, accs);
      if (a && a.amb) { bad = 'Nama rekening "' + toks[i + 1] + '" cocok dengan lebih dari satu rekening. Tulis lebih lengkap.'; i++; continue; }
      if (a) { acc = a.id; i++; continue; }
      bad = 'Rekening "' + toks[i + 1] + '" tidak ditemukan.'; i++; continue;
    }
    rest.push(toks[i]);
  }
  return { acc: acc, rest: rest, bad: bad };
}
async function debtCommand(sid, text, msgId, judul) {
  var accs = await refreshAccs(sid);
  var ds = await getDebts(sid);
  var toks = text.replace(/[,;]+/g, ' ').split(/\s+/).filter(Boolean);
  var w0 = toks[0].toLowerCase(), w1 = (toks[1] || '').toLowerCase();
  var HELP = 'Contoh:\n• piutang budi 150rb  (Budi berutang ke kita; uang keluar dari laci)\n• piutang budi 150rb tanpa kas  (tidak mengubah saldo)\n• utang toko abc 300rb masuk bri  (kita berutang; uang masuk ke BRI)\n• bayar piutang budi 50rb  (Budi nyicil)\n• bayar utang abc 100rb dari kas\n• piutang budi 150rb tempo 7 081234567890  (dengan nomor WhatsApp Budi, untuk pengingat ke pelanggan)\n• nomor budi 081234567890  (simpan atau ganti nomor Budi)\n• tempo budi 7  (jatuh tempo Budi jadi 7 hari lagi dari hari ini)\n• lunas budi\n• cek utang';
  if (w0 === 'nomor') {
    var hpN = hpOf(toks[toks.length - 1]), nmN = toks.slice(1, -1).join(' ');
    if (!hpN || !nmN) return '⚠️ Tulis nama dan nomor WhatsApp yang benar.\nContoh: nomor budi 081234567890';
    var hitN = findDebt(ds, nmN, null);
    if (!hitN.length) return '⚠️ Tidak ada utang atau piutang yang belum lunas atas nama "' + nmN + '". Ketik "cek utang" untuk melihat daftar.';
    if (hitN.length > 1) return '⚠️ Ada ' + hitN.length + ' catatan yang cocok dengan "' + nmN + '". Tulis nama lebih lengkap.';
    await hitN[0].ref.update({ hp: hpN });
    return '✅ *Nomor tersimpan*\n• Nama: ' + hitN[0].name + '\n• HP: ' + hpN;
  }
  if (w0 === 'tempo') {
    var dT = toks[toks.length - 1].replace(/hari$/i, ''), nmT = toks.slice(1, -1).join(' ');
    if (!/^\d{1,3}$/.test(dT) || +dT < 1 || +dT > 365 || !nmT) return '⚠️ Tulis nama dan jumlah hari (1 sampai 365).\nContoh: tempo budi 7  (jatuh tempo jadi 7 hari lagi dari hari ini)';
    var hitT = findDebt(ds, nmT, null);
    if (!hitT.length) return '⚠️ Tidak ada utang atau piutang yang belum lunas atas nama "' + nmT + '". Ketik "cek utang" untuk melihat daftar.';
    if (hitT.length > 1) return '⚠️ Ada ' + hitT.length + ' catatan yang cocok dengan "' + nmT + '". Tulis nama lebih lengkap.';
    var ddT = new Date(); ddT.setDate(ddT.getDate() + parseInt(dT, 10));
    var dueT = ddT.getFullYear() + '-' + pad2(ddT.getMonth() + 1) + '-' + pad2(ddT.getDate());
    await hitT[0].ref.update({ due: dueT });
    var stT = readCustState(); if (stT[sid + '|' + hitT[0].id]) { delete stT[sid + '|' + hitT[0].id]; writeCustState(stT); }
    return '✅ *Jatuh tempo diperpanjang*\n• Nama: ' + hitT[0].name + '\n• Sisa: ' + rp(debtLeft(hitT[0])) + '\n• Jatuh tempo baru: ' + tgl(dueT) + ' (' + dT + ' hari lagi)';
  }
  var isBayar = w0 === 'bayar', isLunas = w0 === 'lunas';
  var isList = (w0 === 'cek' || w0 === 'daftar') || ((w0 === 'utang' || w0 === 'hutang' || w0 === 'piutang') && toks.length === 1);
  if (isList) {
    var which = w0 === 'cek' || w0 === 'daftar' ? w1 : w0;
    var sel = ds;
    var kindOnly = (w0 === 'piutang' || w1 === 'piutang') ? 'piutang' : (w0 === 'utang' || w0 === 'hutang') ? 'utang' : null;
    if (kindOnly === 'piutang') sel = ds.filter(function (d) { return d.kind === 'piutang'; });
    else if (kindOnly === 'utang') sel = ds.filter(function (d) { return d.kind !== 'piutang'; });
    return debtList(sel, kindOnly === 'piutang' ? 'Piutang' : kindOnly === 'utang' ? 'Utang kita' : 'Utang piutang');
  }
  var td = todayStr();
  if (isBayar || isLunas) {
    var kind = null, args = toks.slice(1);
    if (isBayar) { var k1 = (args[0] || '').toLowerCase(); kind = k1 === 'piutang' ? 'piutang' : 'utang'; args = args.slice(1); }
    var pa = pickAccTok(args, accs);
    if (pa.bad) return '⚠️ ' + pa.bad;
    var amt = null, nameT = [];
    pa.rest.forEach(function (t) { var v = WA.waAmount(t); if (amt === null && v != null && /\d/.test(t)) amt = v; else nameT.push(t); });
    var nm = nameT.join(' ');
    if (!nm) return '⚠️ Tulis nama orangnya.\n' + HELP;
    var hit = findDebt(ds, nm, kind);
    if (!hit.length) return '⚠️ Tidak ada ' + (kind === 'piutang' ? 'piutang' : kind === 'utang' ? 'utang' : 'utang atau piutang') + ' yang belum lunas atas nama "' + nm + '". Ketik "cek utang" untuk melihat daftar.';
    if (hit.length > 1) return '⚠️ Ada ' + hit.length + ' catatan yang cocok dengan "' + nm + '":\n' + hit.map(function (d) { return '• ' + d.name + ' (' + (d.kind === 'piutang' ? 'piutang ' : 'utang ') + rp(debtLeft(d)) + ')'; }).join('\n') + '\nTulis nama lebih lengkap' + (kind ? '.' : ', atau pakai "bayar piutang ..." / "bayar utang ...".');
    var d = hit[0], left = debtLeft(d), isP = d.kind === 'piutang';
    if (isLunas && amt === null) amt = left;
    if (amt === null) return '⚠️ Tulis jumlahnya.\nContoh: bayar ' + (isP ? 'piutang' : 'utang') + ' ' + (d.name || 'budi').toLowerCase() + ' 50rb';
    if (amt > left) return '⚠️ Jumlah ' + rp(amt) + ' melebihi sisa ' + rp(left) + ' (' + d.name + ').';
    var payId = 'bot:' + msgId;
    if ((d.pays || []).some(function (p) { return p.id === payId; })) return '';
    var acc = pa.acc || 'kas';
    if (acc !== 'none' && acc !== 'kas' && !accs.some(function (a) { return a.id === acc; })) acc = 'kas';
    await d.ref.update({ pays: admin.firestore.FieldValue.arrayUnion({ id: payId, date: td, amount: amt, acc: acc, note: 'Dari WhatsApp', at: Date.now() }) });
    var after = left - amt;
    return '✅ *' + (isP ? 'Pembayaran diterima' : 'Utang dibayar') + '*\n• Nama: ' + d.name + '\n• Jumlah: ' + rp(amt) + (acc === 'none' ? '' : '\n• ' + (isP ? 'Masuk ke: ' : 'Dibayar dari: ') + accName(accs, acc)) + '\n• ' + (after > 0 ? 'Sisa: ' + rp(after) : '*LUNAS* 🎉');
  }
  /* catat baru: piutang / utang */
  var kind2 = (w0 === 'piutang') ? 'piutang' : 'utang';
  var hp2 = '';
  var rest0 = toks.slice(1).filter(function (t) { var h = hpOf(t); if (h && !hp2) { hp2 = h; return false; } return true; });
  var pb = pickAccTok(rest0, accs);
  if (pb.bad) return '⚠️ ' + pb.bad;
  var amt2 = null, nm2 = [], tempo = 0;
  for (var i = 0; i < pb.rest.length; i++) {
    var t = pb.rest[i], tl = t.toLowerCase();
    if (tl === 'tempo' && pb.rest[i + 1] && /^\d{1,3}(hari)?$/i.test(pb.rest[i + 1])) { tempo = parseInt(pb.rest[i + 1], 10); i++; continue; }
    var v = WA.waAmount(t);
    if (amt2 === null && v != null && /\d/.test(t)) { amt2 = v; continue; }
    nm2.push(t);
  }
  var name2 = nm2.join(' ').replace(/(^|\s)([a-z])/g, function (m0, a, b) { return a + b.toUpperCase(); });
  if (!name2) return '⚠️ Tulis nama orangnya.\n' + HELP;
  if (!amt2 || amt2 <= 0) return '⚠️ Tulis jumlahnya.\n' + HELP;
  var sigD = 'bot:' + msgId;
  if (ds.some(function (x) { return x.wa === sigD; })) return '';
  var acc2 = pb.acc || 'kas';
  var due = '';
  if (tempo > 0) { var dd = new Date(); dd.setDate(dd.getDate() + tempo); due = dd.getFullYear() + '-' + pad2(dd.getMonth() + 1) + '-' + pad2(dd.getDate()); }
  await db.collection(P(sid, 'debts')).add({ kind: kind2, name: name2, hp: hp2, amount: amt2, date: td, due: due, note: 'Dari WhatsApp', acc: acc2, pays: [], createdAt: Date.now(), wa: sigD });
  return '✅ *' + (kind2 === 'piutang' ? 'Piutang' : 'Utang') + ' tercatat*\n• Nama: ' + name2 + '\n• Jumlah: ' + rp(amt2) + (due ? '\n• Jatuh tempo: ' + tgl(due) : '') + (hp2 ? '\n• HP: ' + hp2 : '') + '\n• ' + (acc2 === 'none' ? 'Saldo tidak berubah' : (kind2 === 'piutang' ? 'Uang keluar dari: ' : 'Uang masuk ke: ') + accName(accs, acc2));
}

async function handleMessage(sock, msg) {
  var jid = msg.key.remoteJid || '';
  if (jid.endsWith('@g.us')) return;            /* lewati grup */
  if (jid === 'status@broadcast' || jid.endsWith('@broadcast') || jid.endsWith('@newsletter')) return;

  /* siapa pengirimnya, dan toko mana yang dicatat */
  var sid, judul = 'Saldo Buku Kas D\'Cell', toko = null;
  if (msg.key.fromMe) {
    if (!ownEnabled) return;                    /* pengaturan "pesanSendiri": false di toko.json */
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
  if (/^(🌙|💰|📊|✅|⚠️|🗑️|🛠️|📦|👤)/.test(text)) return;   /* balasan/rekap dari bot sendiri, jangan dibaca sebagai transaksi */
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

  if (HAPUS_RE.test(text) || UBAH_RE.test(text)) {
    try {
      var txh = HAPUS_RE.test(text) ? await hapusTerakhir(sid) : await ubahTerakhir(sid, text);
      await sock.sendMessage(jid, { text: txh }, { quoted: msg });
      console.log(new Date().toLocaleString('id-ID'), '-', tag + (HAPUS_RE.test(text) ? 'hapus terakhir.' : 'ubah terakhir.'));
    } catch (e) {
      await sock.sendMessage(jid, { text: '⚠️ Gagal: ' + e.message }, { quoted: msg });
    }
    return;
  }

  if ((BUKA_RE.test(text) || STATUSKAS_RE.test(text)) && text.split(/\r?\n/).length === 1) {
    try {
      var txb = BUKA_RE.test(text) ? await bukaKas(sid, text) : await statusKasText(sid);
      await sock.sendMessage(jid, { text: txb }, { quoted: msg });
      console.log(new Date().toLocaleString('id-ID'), '-', tag + (BUKA_RE.test(text) ? 'buka kas.' : 'status kas.'));
    } catch (e) {
      await sock.sendMessage(jid, { text: '⚠️ Gagal: ' + e.message }, { quoted: msg });
    }
    return;
  }

  if (LAPBLN_RE.test(text)) {
    try {
      var lm = text.match(LAPBLN_RE), nowL = new Date(), cur = nowL.getFullYear() + '-' + pad2(nowL.getMonth() + 1);
      var ymL = lm[2] && lm[2].toLowerCase() === 'lalu' ? ymAdd(cur, -1) : cur;
      await refreshAccs(sid);
      await sock.sendMessage(jid, { text: await monthText(sid, ymL) }, { quoted: msg });
    } catch (e) { await sock.sendMessage(jid, { text: '⚠️ Gagal: ' + e.message }, { quoted: msg }); }
    return;
  }

  if (BACKUP_RE.test(text) && sid === ownShopId) {
    try { await sock.sendMessage(jid, { text: '💾 Menyiapkan cadangan...' }, { quoted: msg }); await sendBackup(sock, jid, sid, 'Toko utama'); }
    catch (e) { await sock.sendMessage(jid, { text: '⚠️ Gagal: ' + e.message }, { quoted: msg }); }
    return;
  }

  if (isStokCmd(text) && (STOK_MASUK_RE.test(text) || text.split(/\r?\n/).length === 1)) {
    try {
      var txs = await stokCommand(sid, text, msg.key.id);
      await sock.sendMessage(jid, { text: txs }, { quoted: msg });
      console.log(new Date().toLocaleString('id-ID'), '-', tag + 'stok: ' + text.split(/\r?\n/)[0].slice(0, 40));
    } catch (e) {
      await sock.sendMessage(jid, { text: '⚠️ Gagal: ' + e.message }, { quoted: msg });
    }
    return;
  }

  if (sid === ownShopId && text.split(/\r?\n/).length === 1 && (PEND_RE.test(text) || APPR_RE.test(text))) {
    try {
      var txp = PEND_RE.test(text) ? await pendingText() : await approveCmd(text);
      await sock.sendMessage(jid, { text: txp }, { quoted: msg });
      console.log(new Date().toLocaleString('id-ID'), '-', tag + 'pendaftar: ' + text.slice(0, 30));
    } catch (e) {
      await sock.sendMessage(jid, { text: '⚠️ Gagal: ' + e.message }, { quoted: msg });
    }
    return;
  }

  if (DEBT_RE.test(text) && text.split(/\r?\n/).length === 1) {
    try {
      var txd = await debtCommand(sid, text, msg.key.id, judul);
      if (txd) await sock.sendMessage(jid, { text: txd }, { quoted: msg });
      console.log(new Date().toLocaleString('id-ID'), '-', tag + 'utang piutang: ' + text.slice(0, 40));
    } catch (e) {
      await sock.sendMessage(jid, { text: '⚠️ Gagal mencatat utang piutang: ' + e.message }, { quoted: msg });
    }
    return;
  }

  if (KOREKSI_RE.test(text)) {
    try {
      var txk = await koreksiSaldo(sid, text, judul);
      await refreshAccs(sid);
      await sock.sendMessage(jid, { text: txk }, { quoted: msg });
      console.log(new Date().toLocaleString('id-ID'), '-', tag + 'koreksi saldo.');
    } catch (e) {
      await sock.sendMessage(jid, { text: '⚠️ Gagal mengoreksi saldo: ' + e.message }, { quoted: msg });
    }
    return;
  }

  var accs = await refreshAccs(sid);
  var lines = WA.splitLines(text);

  /* satu pesan = satu transaksi (cara lama, balasan lengkap) */
  if (lines.length === 1) {
    var r = waLine(lines[0], null, accs, settingsByShop[sid]);
    if (r.skip) return;                         /* bukan baris transaksi, abaikan diam-diam */
    var sig = 'bot:' + msg.key.id;
    if (!r.ok) {
      await sock.sendMessage(jid, { text: failText(r, accs) }, { quoted: msg });
      return;
    }
    if (await alreadyProcessed(sid, sig)) return;
    await saveTx(sid, r.kind, r.obj, sig);
    var reply = successText(r, accs) + (r.note ? '\n\nℹ️ Urutan pesan dikoreksi: ' + r.note : '');
    var lw1 = await lowWarn(sid); if (lw1) reply += '\n\n' + lw1;
    await sock.sendMessage(jid, { text: reply }, { quoted: msg });
    console.log(new Date().toLocaleString('id-ID'), '-', tag + reply.replace(/\n/g, ' | ').replace(/^✅\s*/, ''));
    return;
  }

  /* banyak baris = banyak transaksi sekaligus */
  var MAX_LINES = 30;
  var defDate = null, hdrN = 0, parsed = [];
  lines.slice(0, MAX_LINES).forEach(function (ln) {
    var hd = WA.headerDate(ln);
    if (hd && hd !== 'invalid') { defDate = hd; hdrN++; return; }          /* baris tanggal: berlaku untuk baris di bawahnya */
    if (hd === 'invalid') { parsed.push({ ln: ln, r: { ok: false, msg: 'Tanggal tidak valid.' } }); return; }
    parsed.push({ ln: ln, r: waLine(ln, defDate, accs, settingsByShop[sid]) });
  });
  if (!parsed.length || parsed.every(function (x) { return x.r.skip; })) return;   /* obrolan biasa, abaikan */
  var out = [], okN = 0, badN = 0;
  for (var k = 0; k < parsed.length; k++) {
    var pr = parsed[k], no = (k + 1) + '. ';
    if (pr.r.skip) { badN++; out.push(no + '⚠️ Baris tidak dikenali: ' + shorten(pr.ln)); continue; }
    if (!pr.r.ok) { badN++; out.push(no + '⚠️ ' + (pr.r.msg || 'Tidak bisa dibaca.') + ' (' + shorten(pr.ln) + ')' + (pr.r.corrected ? '\n   → ' + pr.r.corrected : (pr.r.example ? '\n   Contoh: ' + pr.r.example : ''))); continue; }
    var sigK = 'bot:' + msg.key.id + ':' + k;
    try {
      if (!(await alreadyProcessed(sid, sigK))) await saveTx(sid, pr.r.kind, pr.r.obj, sigK);
      okN++; out.push(no + shortText(pr.r, accs));
    } catch (er) { badN++; out.push(no + '⚠️ Gagal menyimpan: ' + er.message); }
  }
  if (lines.length > MAX_LINES) out.push('⚠️ Hanya ' + MAX_LINES + ' baris pertama yang diproses. Kirim sisanya di pesan lain.');
  var head = okN + ' dari ' + parsed.length + ' transaksi tercatat' + (badN ? ', ' + badN + ' perlu dicek' : '');
  var reply2 = (badN ? '⚠️ ' : '✅ ') + '*' + head + '*\n' + out.join('\n');
  if (okN) { var lw2 = await lowWarn(sid); if (lw2) reply2 += '\n\n' + lw2; }
  await sock.sendMessage(jid, { text: reply2 }, { quoted: msg });
  console.log(new Date().toLocaleString('id-ID'), '-', tag + head);
}

start().catch(function (e) { console.error('Bot gagal jalan:', e); process.exit(1); });
