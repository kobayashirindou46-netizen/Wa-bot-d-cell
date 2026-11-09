/* ---------------------------------------------------------------------
   Pengurai pesan WhatsApp -> transaksi, dipindah dari buku-kas-agen.html
   supaya bot dan aplikasi web memakai aturan baca yang persis sama.
   File ini murni logika (tanpa DOM), dipakai oleh index.js.
------------------------------------------------------------------------ */
'use strict';

var KAS = 'kas';

var TYPES = {
  transfer: { label: 'Transfer', fee: true, acc: true, dest: true },
  tarik:    { label: 'Tarik tunai', fee: true, acc: true },
  setor:    { label: 'Setor tunai', fee: true, acc: true },
  topup:    { label: 'Top up e-wallet', fee: true, acc: true },
  bayar:    { label: 'Bayar tagihan', fee: true, acc: true },
  isi:      { label: 'Isi saldo agen', fee: false, acc: true },
  keluar:   { label: 'Pengeluaran', fee: false, acc: false },
  sesama:   { label: 'Sesama bank', like: 'transfer', fee: true, acc: true, dest: true },
  elektrik: { label: 'Elektrik (listrik, token)', like: 'bayar', fee: true, acc: true },
  online:   { label: 'Pulsa dan data', like: 'bayar', fee: true, acc: true },
  kartu:    { label: 'Kartu ATM nasabah', like: 'tarik', onlyAdm: true, fee: true, acc: false },
  jual:     { label: 'Aksesoris (jual barang)', fee: false, acc: false, modal: true },
  masuk:    { label: 'Pemasukan', fee: false, acc: false }
};
function lk(t) { return (TYPES[t] && TYPES[t].like) || t; }

var ADM = { luar: 1, dalam: 1, potong: 1 };

var WA_TYPES = {
  tarik: 'tarik', tt: 'tarik', transfer: 'transfer', tf: 'transfer', trf: 'transfer',
  bayar: 'bayar', tagihan: 'bayar', ppob: 'bayar', isi: 'isi', topup: 'topup', top: 'topup',
  listrik: 'elektrik', pln: 'elektrik', token: 'elektrik', elektrik: 'elektrik',
  pulsa: 'online', data: 'online', paket: 'online', kartu: 'kartu', gesek: 'kartu',
  jual: 'jual', aksesoris: 'jual', penjualan: 'jual', masuk: 'masuk', pemasukan: 'masuk',
  income: 'masuk', keluar: 'keluar', pengeluaran: 'keluar', beli: 'keluar',
  pindah: 'pindah', mutasi: 'pindah'
};
var WA_EW = { dana: 'DANA', ovo: 'OVO', gopay: 'GoPay', shopeepay: 'ShopeePay', shopee: 'ShopeePay', linkaja: 'LinkAja' };
var BANK_ALIAS = {
  bri: 'BRI', bni: 'BNI', bca: 'BCA', mandiri: 'Mandiri', bsi: 'BSI (Syariah Indonesia)', btn: 'BTN',
  cimb: 'CIMB Niaga', permata: 'Permata', danamon: 'Danamon', ocbc: 'OCBC', uob: 'UOB', maybank: 'Maybank',
  panin: 'Panin', jago: 'Bank Jago', jenius: 'Jenius (BTPN)', btpn: 'Jenius (BTPN)', seabank: 'SeaBank',
  neo: 'Neo Commerce', mega: 'Mega', sulselbar: 'Bank Sulselbar', bjb: 'BJB', jatim: 'Bank Jatim', dki: 'Bank DKI',
  muamalat: 'Bank Muamalat', bcas: 'BCA Syariah', bukopin: 'KB Bukopin Syariah', kb: 'KB Bank (Bukopin)',
  mayapada: 'Bank Mayapada', mestika: 'Bank Mestika', sinarmas: 'Bank Sinarmas', nobu: 'Bank Nobu',
  hsbc: 'HSBC', dbs: 'DBS Indonesia', citibank: 'Citibank', allo: 'Bank Harda (Allo Bank)', amar: 'Bank Amar',
  krom: 'Bank Krom', superbank: 'Superbank', blu: 'blu by BCA Digital', aceh: 'Bank Aceh Syariah',
  nagari: 'Bank Nagari', sumut: 'Bank Sumut', jateng: 'Bank Jateng', kalbar: 'Bank Kalbar', kalsel: 'Bank Kalsel',
  kalteng: 'Bank Kalteng', kaltimtara: 'Bank Kaltimtara', sulteng: 'Bank Sulteng', sulutgo: 'Bank Sulutgo',
  sultra: 'Bank Sultra', ntb: 'Bank NTB Syariah', ntt: 'Bank NTT', banten: 'Bank Banten', jambi: 'Bank Jambi',
  bengkulu: 'Bank Bengkulu', lampung: 'Bank Lampung'
};

function pad(n) { return (n < 10 ? '0' : '') + n; }
function ymd(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
function today() { return ymd(new Date()); }

function waNorm(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }

function waAmount(tok) {
  var m = /^(\d+(?:[.,]\d+)*)(rb|ribu|k|jt|juta)?$/.exec(String(tok).toLowerCase().replace(/^rp\.?/, '').replace(/[,;]+$/, ''));
  if (!m) return null;
  if (m[2]) { var v = parseFloat(m[1].replace(',', '.')); return isNaN(v) ? null : Math.round(v * (m[2] === 'jt' || m[2] === 'juta' ? 1e6 : 1e3)); }
  var d = m[1].replace(/[.,]/g, ''); return d ? +d : null;
}
function waAcc(tok, kind, accs) {
  var t = waNorm(tok); if (t.length < 2) return null;
  var pool = kind ? accs.filter(function (a) { return a.kind === kind; }) : accs;
  var ex = pool.filter(function (a) { return waNorm(a.name) === t; });
  if (ex.length === 1) return { id: ex[0].id };
  if (ex.length > 1) return { amb: true };
  if (t.length >= 3) {
    var pre = pool.filter(function (a) { return waNorm(a.name).indexOf(t) === 0; });
    if (pre.length === 1) return { id: pre[0].id };
    if (pre.length > 1) return { amb: true };
  }
  return null;
}
/* dampak transaksi ke saldo rekening (saldo), laci tunai (kas), dan laba -- sama persis dengan aplikasi web */
function fx(t) {
  var a = +t.amount || 0, f = +t.fee || 0, k = +t.komisi || 0, b = +t.bf || 0;
  switch (lk(t.type)) {
    case 'transfer': case 'setor': case 'bayar': case 'topup':
      if (t.adm === 'potong') return { saldo: -a + f + k - b, kas: a, laba: f + k - b };
      return { saldo: -a + k - b, kas: a + f, laba: f + k - b };
    case 'tarik':
      if (t.adm === 'dalam') return { saldo: a + f + k - b, kas: -a, laba: f + k - b };
      return { saldo: a + k - b, kas: -a + f, laba: f + k - b };
    case 'isi': return { saldo: a, kas: -a, laba: 0 };
    case 'keluar': return { saldo: 0, kas: -a, laba: -a };
    case 'jual': return { saldo: 0, kas: a, laba: a - (+t.modal || 0) };
    case 'masuk': return { saldo: 0, kas: a, laba: a };
  }
  return { saldo: 0, kas: 0, laba: 0 };
}

/* saldo semua rekening + laci tunai, dihitung dari seluruh riwayat (sama seperti kartu "Beranda" di aplikasi) */
function calcBalance(accs, kasAwal, txs, mvs) {
  var bal = {}, kas = +kasAwal || 0;
  (accs || []).forEach(function (a) { bal[a.id] = +a.opening || 0; });
  function add(id, v) {
    if (id === KAS) kas += v;
    else if (Object.prototype.hasOwnProperty.call(bal, id)) bal[id] += v;
  }
  (txs || []).forEach(function (t) {
    var e = fx(t), a = t.acc;
    if (a) add(a, e.saldo);
    kas += e.kas;
  });
  (mvs || []).forEach(function (m) {
    var v = +m.amount || 0, f = +m.fee || 0;
    if (m.type === 'tambah') add(m.acc, v);
    else if (m.type === 'kurang') add(m.acc, -v);
    else { add(m.from, -v - f); add(m.to, v); }
  });
  var total = kas; for (var k in bal) total += bal[k];
  return { bal: bal, kas: kas, total: total };
}

function waDate(d, mo, y) {
  var yy = y ? (String(y).length === 2 ? 2000 + (+y) : +y) : new Date().getFullYear();
  var dt = new Date(yy, mo - 1, d);
  return dt.getFullYear() === yy && dt.getMonth() === mo - 1 && dt.getDate() === d ? ymd(dt) : null;
}

/* raw: teks pesan apa adanya (tanpa header waktu/nama, beda dari file ekspor chat) */
function waLine(raw, defDate, accs) {
  var text = raw, date = null;
  var toks = text.split(/\s+/).filter(Boolean);
  var type = toks.length ? WA_TYPES[toks[0].toLowerCase().replace(/[^a-z]/g, '')] : null;
  if (!type) return { ok: false, skip: true };
  var T = type === 'pindah' ? null : TYPES[type];
  var i = 1, amount = null, fee = 0, kom = 0, bf = 0, modal = 0, bt = '', rek = '', adm = null,
      accIds = [], name = [], err = null, low, v, tok, ew = null, hp = '';
  var ewSrc = false, ewSrcDone = false;
  if (type === 'topup') {
    var nb = false, ne = 0;
    toks.slice(1).forEach(function (t0) {
      var l0 = t0.toLowerCase().replace(/[,;]+$/, '');
      if (WA_EW[waNorm(l0)]) ne++;
      var r0 = waAcc(l0, 'bank', accs); if (r0 && !r0.amb) nb = true;
    });
    ewSrc = !nb && ne >= 2;
  }
  var n1 = (toks[1] || '').toLowerCase();
  if (((lk(type) === 'tarik' || type === 'setor') && n1 === 'tunai') || (type === 'isi' && n1 === 'saldo') || (type === 'topup' && n1 === 'up')) i = 2;
  for (; i < toks.length && !err; i++) {
    tok = toks[i]; low = tok.toLowerCase().replace(/[,;]+$/, '');
    if ((low === 'admin' || low === 'adm' || low === 'fee' || low === 'komisi' || low === 'kom' || low === 'pot' || low === 'potongan' || low === 'pajak' || low === 'modal') &&
        (type === 'pindah' ? low === 'fee' : (T.fee || (T.modal && low === 'modal')))) {
      v = i + 1 < toks.length ? waAmount(toks[i + 1]) : null;
      if (v == null) { err = 'nilai'; break; }
      if (low === 'komisi' || low === 'kom') kom = v; else if (low === 'modal') modal = v;
      else if (low === 'pot' || low === 'potongan' || low === 'pajak') bf = v; else fee = v;
      i++; continue;
    }
    if (lk(type) === 'tarik' && ADM[low]) { adm = low; continue; }
    if (low === 'kemarin') { var yd = new Date(); yd.setDate(yd.getDate() - 1); date = ymd(yd); continue; }
    var dm = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/.exec(low);
    if (dm) { date = waDate(+dm[1], +dm[2], dm[3] || ''); if (!date) { err = 'tanggal'; break; } continue; }
    if (T && T.dest && accIds.length >= 1) {
      if (!bt && BANK_ALIAS[waNorm(low)]) { bt = BANK_ALIAS[waNorm(low)]; continue; }
      if (!rek && /^\d{8,18}$/.test(low) && (amount != null || low.length >= 10)) { rek = low; continue; }
    }
    if (type === 'topup') {
      if (waNorm(low) === 'ewallet') continue;
      var en = WA_EW[waNorm(low)];
      if (en && ewSrc && !ewSrcDone) {
        var rs = waAcc(low, 'ewallet', accs);
        if (rs && !rs.amb) { accIds.push(rs.id); ewSrcDone = true; continue; }
        err = 'sumber-ewallet'; break;
      }
      if (en && !ew) { ew = en; continue; }
      if (!hp && /^(\+?62|0)\d{8,13}$/.test(low.replace(/[\s-]/g, ''))) { hp = low.replace(/[^\d+]/g, ''); continue; }
    }
    v = waAmount(low);
    if (v != null && amount == null) { amount = v; continue; }
    if (type === 'pindah' || T.acc) {
      if (type === 'pindah' && (low === 'kas' || low === 'laci' || low === 'tunai') && accIds.length < 2) { accIds.push(KAS); continue; }
      if (accIds.length < (type === 'pindah' ? 2 : 1)) {
        var r = waAcc(low, type === 'topup' ? 'bank' : null, accs);
        if (!r && type === 'topup') r = waAcc(low, 'ewallet', accs);
        if (r && r.amb) { err = 'rekening-ganda'; break; }
        if (r) { accIds.push(r.id); continue; }
      }
    }
    name.push(tok.replace(/[,;]+$/, ''));
  }
  if (err) return { ok: false, msg: 'Pesan tidak bisa dibaca (' + err + ').' };
  if (!amount) return { ok: false, msg: 'Nominal tidak ditemukan.' };
  date = date || defDate || today();
  if (type === 'pindah') {
    if (accIds.length < 2) return { ok: false, msg: 'Tulis dua rekening, asal lalu tujuan.' };
    if (accIds[0] === accIds[1]) return { ok: false, msg: 'Rekening asal dan tujuan sama.' };
    return { ok: true, kind: 'mv', obj: { date: date, type: 'pindah', from: accIds[0], to: accIds[1], amount: amount, fee: fee, note: "Dari WhatsApp (otomatis)" } };
  }
  var t = { date: date, type: type, name: name.join(' '), amount: amount, fee: T.fee ? fee : 0, komisi: T.fee ? kom : 0, bf: T.fee ? bf : 0, acc: '', note: "Dari WhatsApp (otomatis)" };
  if (T.modal) t.modal = modal;
  if (T.dest && bt) { t.bt = bt; if (rek) t.rek = rek; }
  if (T.acc) {
    var id = accIds[0], pool = accs;
    if (type === 'topup') { var bk = accs.filter(function (a) { return a.kind === 'bank'; }); if (bk.length) pool = bk; }
    if (!id) {
      if (!pool.length) return { ok: false, msg: 'Belum ada rekening.' };
      if (pool.length > 1) return { ok: false, msg: 'Nama ' + (type === 'topup' ? 'rekening pengirim (bank atau e-wallet)' : 'rekening') + ' tidak ditemukan.' };
      id = pool[0].id;
    }
    t.acc = id;
  }
  if (type === 'topup') {
    if (!ew) return { ok: false, msg: 'Tulis e-wallet tujuan: dana, ovo, gopay, shopeepay, atau linkaja.' };
    t.ew = ew; t.hp = hp;
  }
  if (lk(type) === 'tarik') {
    t.adm = adm || 'luar';
    if (t.adm === 'potong' && t.fee > t.amount) return { ok: false, msg: 'Biaya admin lebih besar dari nominal.' };
  }
  if (lk(type) === 'keluar' && !t.name) return { ok: false, msg: 'Tulis keperluan pengeluaran, misalnya "keluar 150rb pulsa".' };
  return { ok: true, kind: 'tx', obj: t };
}

module.exports = { waLine: waLine, TYPES: TYPES, ADM: ADM, waNorm: waNorm, fx: fx, calcBalance: calcBalance };
