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
  bayar:    { label: 'Bayar tagihan', pay: true, fee: true, acc: true },
  isi:      { label: 'Isi saldo agen', fee: false, acc: true },
  keluar:   { label: 'Pengeluaran', fee: false, acc: true },
  sesama:   { label: 'Sesama bank', like: 'transfer', fee: true, acc: true, dest: true },
  elektrik: { label: 'Elektrik (listrik, token)', like: 'bayar', pay: true, fee: true, acc: true },
  online:   { label: 'Pulsa dan data', like: 'bayar', pay: true, fee: true, acc: true },
  kartu:    { label: 'Kartu ATM nasabah', like: 'tarik', onlyAdm: true, fee: true, acc: false },
  jual:     { label: 'Aksesoris (jual barang)', pay: true, fee: false, acc: false, modal: true },
  masuk:    { label: 'Pemasukan', fee: false, acc: true }
};
function lk(t) { return (TYPES[t] && TYPES[t].like) || t; }

var ADM = { luar: 1, dalam: 1, potong: 1 };

var WA_TYPES = {
  tarik: 'tarik', tt: 'tarik', transfer: 'transfer', tranfer: 'transfer', trasfer: 'transfer', transper: 'transfer', tf: 'transfer', trf: 'transfer',
  bayar: 'bayar', tagihan: 'bayar', ppob: 'bayar', isi: 'isi', topup: 'topup', top: 'topup',
  listrik: 'elektrik', pln: 'elektrik', token: 'elektrik', elektrik: 'elektrik',
  pulsa: 'online', data: 'online', paket: 'online', kartu: 'kartu', gesek: 'kartu',
  jual: 'jual', aksesoris: 'jual', penjualan: 'jual', masuk: 'masuk', pemasukan: 'masuk',
  income: 'masuk', keluar: 'keluar', pengeluaran: 'keluar', beli: 'keluar',
  pindah: 'pindah', mutasi: 'pindah',
  setor: 'setor', setortunai: 'setor', sesama: 'sesama'
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
/* dampak transaksi ke saldo rekening (saldo), laci tunai (kas), dan laba -- sama persis dengan aplikasi web.
   accs (opsional): daftar rekening, dipakai untuk memastikan rekening tujuan memang masih ada. */
function hasAcc(accs, id) {
  if (!id || id === KAS) return false;
  if (!accs) return true;
  for (var i = 0; i < accs.length; i++) if (accs[i].id === id) return true;
  return false;
}
function fx0(t, accs) {
  var a = +t.amount || 0, f = +t.fee || 0, k = +t.komisi || 0, b = +t.bf || 0;
  switch (lk(t.type)) {
    case 'transfer': case 'setor': case 'bayar': case 'topup':
      if (t.adm === 'potong') return { saldo: -a + f + k - b, kas: a, laba: f + k - b };
      return { saldo: -a + k - b, kas: a + f, laba: f + k - b };
    case 'tarik':
      if (t.adm === 'dalam') return { saldo: a + f + k - b, kas: -a, laba: f + k - b };
      return { saldo: a + k - b, kas: -a + f, laba: f + k - b };
    case 'isi': return { saldo: a, kas: -a, laba: 0 };
    case 'keluar':
      if (hasAcc(accs, t.acc)) return { saldo: -a, kas: 0, laba: -a };
      return { saldo: 0, kas: -a, laba: -a };
    case 'jual': return { saldo: 0, kas: a, laba: a - (+t.modal || 0) };
    case 'masuk':
      if (hasAcc(accs, t.acc)) return { saldo: a, kas: 0, laba: a };
      return { saldo: 0, kas: a, laba: a };
  }
  return { saldo: 0, kas: 0, laba: 0 };
}
function fx(t, accs) {
  var r = fx0(t, accs), T = TYPES[t.type];
  /* pelanggan bayar transfer: uang masuk ke rekening yang dipilih, TIDAK masuk laci */
  if (t.pay === 'transfer' && t.payAcc && T && T.pay && r.kas > 0 && hasAcc(accs, t.payAcc)) {
    r.ex = [{ acc: t.payAcc, v: r.kas }];
    r.kas = 0;
  }
  /* pelanggan belum bayar (utang): laci tidak bertambah, dicatat sebagai piutang */
  if (t.pay === 'utang') {
    var L = lk(t.type), f = +t.fee || 0;
    if (L === 'tarik') { if (t.adm !== 'potong' && t.adm !== 'dalam') r.kas -= f; }
    else if (L === 'keluar' || L === 'masuk') { r.kas = 0; r.saldo = 0; }
    else if (L === 'isi') r.kas = 0;
    else if (r.kas > 0) r.kas = 0;
  }
  return r;
}
/* jumlah dan arah catatan utang untuk transaksi "utang" (sama dengan aplikasi) */
function debtFor(t, accs) {
  var a = +t.amount || 0, L = lk(t.type);
  if (L === 'keluar' || L === 'isi') return a > 0 ? { kind: 'utang', amount: a } : null;
  if (L === 'masuk') return a > 0 ? { kind: 'piutang', amount: a } : null;
  var d = fx0(t, accs).kas - fx(Object.assign({}, t, { pay: 'utang' }), accs).kas;
  return d > 0 ? { kind: 'piutang', amount: d } : null;
}

/* rekening default bila catatan tidak punya rekening valid: bank pertama, lalu e-wallet pertama (sama dengan aplikasi) */
function defAcc(accs) {
  function first(kind) {
    return (accs || []).filter(function (a) { return a.kind === kind; })
      .sort(function (x, y) { return (x.createdAt || 0) - (y.createdAt || 0) || String(x.name).localeCompare(String(y.name)); })[0] || null;
  }
  return first('bank') || first('ewallet');
}
function txAcc(t, accs) {
  if (t.acc === KAS && t.type === 'kartu') return KAS;
  if (t.acc && (accs || []).some(function (a) { return a.id === t.acc; })) return t.acc;
  var d = defAcc(accs);
  return d ? d.id : null;
}

/* saldo semua rekening + laci tunai, dihitung dari seluruh riwayat (sama seperti kartu "Beranda" di aplikasi) */
function calcBalance(accs, kasAwal, txs, mvs, debts) {
  var bal = {}, kas = +kasAwal || 0;
  (accs || []).forEach(function (a) { bal[a.id] = +a.opening || 0; });
  function add(id, v) {
    if (id === KAS) kas += v;
    else if (Object.prototype.hasOwnProperty.call(bal, id)) bal[id] += v;
  }
  (txs || []).forEach(function (t) {
    var e = fx(t, accs), a = txAcc(t, accs);
    if (a) add(a, e.saldo);
    kas += e.kas;
    if (e.ex) e.ex.forEach(function (x) { add(x.acc, x.v); });
  });
  (mvs || []).forEach(function (m) {
    var v = +m.amount || 0, f = +m.fee || 0;
    if (m.type === 'tambah') add(m.acc, v);
    else if (m.type === 'kurang') add(m.acc, -v);
    else { add(m.from, -v - f); add(m.to, v); }
  });
  /* utang piutang: uang pinjaman keluar/masuk, lalu cicilan yang diterima/dibayar (sama dengan aplikasi) */
  (debts || []).forEach(function (d) {
    var sg = d.kind === 'piutang' ? -1 : 1;
    if (d.acc && d.acc !== 'none') add(d.acc, sg * (+d.amount || 0));
    (d.pays || []).forEach(function (p) { if (p.acc && p.acc !== 'none') add(p.acc, -sg * (+p.amount || 0)); });
  });
  var total = kas; for (var k in bal) total += bal[k];
  return { bal: bal, kas: kas, total: total };
}

function waDate(d, mo, y) {
  var yy = y ? (String(y).length === 2 ? 2000 + (+y) : +y) : new Date().getFullYear();
  var dt = new Date(yy, mo - 1, d);
  return dt.getFullYear() === yy && dt.getMonth() === mo - 1 && dt.getDate() === d ? ymd(dt) : null;
}

/* pesan beberapa baris: satu baris = satu transaksi. Nomor urut di depan baris ("1 tarik...", "2. transfer...",
   "- bayar...") dibuang kalau sesudahnya ada jenis transaksi. */
function splitLines(text) {
  return String(text || '').split(/\r?\n/).map(function (l) { return l.trim(); }).filter(Boolean).map(function (l) {
    var m = /^(?:\d{1,2}\s*[.):\-]?|[-•*])\s*(.+)$/.exec(l);
    if (m) {
      var first = m[1].split(/\s+/)[0].toLowerCase().replace(/[^a-z]/g, '');
      if (WA_TYPES[first]) return m[1];
    }
    return l;
  });
}

/* raw: teks pesan apa adanya (tanpa header waktu/nama, beda dari file ekspor chat) */
/* tarif otomatis (disimpan pemilik di pengaturan aplikasi): batas nominal -> biaya, sama seperti isian otomatis di formulir aplikasi */
function tierFee(list, a) {
  if (!Array.isArray(list) || !list.length) return 0;
  for (var i = 0; i < list.length; i++) if (list[i].max == null || a <= list[i].max) return +list[i].fee || 0;
  return +list[list.length - 1].fee || 0;
}

function waLine0(raw, defDate, accs, settings) {
  var text = raw, date = null;
  var toks = text.split(/\s+/).filter(Boolean);
  var type = toks.length ? WA_TYPES[toks[0].toLowerCase().replace(/[^a-z]/g, '')] : null;
  if (!type) return { ok: false, skip: true };
  var T = type === 'pindah' ? null : TYPES[type];
  var i = 1, amount = null, fee = 0, kom = 0, bf = 0, modal = 0, bt = '', rek = '', adm = null,
      accIds = [], name = [], err = null, low, v, tok, ew = null, hp = '';
  var recv = null, feeSet = false, bfSet = false, ewSrc = false, ewSrcDone = false, pay = null, payAcc = '', payWait = false;
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
      else if (low === 'pot' || low === 'potongan' || low === 'pajak') { bf = v; bfSet = true; } else { fee = v; feeSet = true; }
      i++; continue;
    }
    /* uang yang diterima dari pelanggan, hanya untuk menghitung kembalian di balasan (tidak disimpan) */
    if ((low === 'terima' || low === 'diterima') && i + 1 < toks.length && waAmount(toks[i + 1]) != null) { recv = waAmount(toks[i + 1]); i++; continue; }
    if (lk(type) === 'tarik' && ADM[low]) { adm = low; continue; }
    /* cara bayar pelanggan: cash/tunai, atau tf/trf/transfer lalu (boleh) nama rekening tujuan */
    if (T && (low === 'utang' || low === 'hutang' || low === 'bon' || low === 'kasbon' || low === 'ngutang')) { pay = 'utang'; continue; }
    if (T && T.pay) {
      if (payWait) {
        payWait = false;
        var two2 = i + 1 < toks.length ? waAcc(low + toks[i + 1].toLowerCase().replace(/[,;]+$/, ''), null, accs) : null;
        if (two2 && !two2.amb && accs.some(function (a) { return a.id === two2.id && waNorm(a.name) === waNorm(low + toks[i + 1]); })) { payAcc = two2.id; i++; continue; }
        var rp2 = waAcc(low, null, accs);
        if (rp2 && rp2.amb) { err = 'rekening-tujuan-ganda'; break; }
        if (rp2) { payAcc = rp2.id; continue; }
      }
      if (low === 'cash' || low === 'tunai') { pay = 'cash'; continue; }
      if (low === 'tf' || low === 'trf' || low === 'tfr' || low === 'transf' || low === 'transfer') { pay = 'transfer'; payWait = true; continue; }
    }
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
      if ((type === 'pindah' || lk(type) === 'keluar' || lk(type) === 'masuk') && (low === 'kas' || low === 'laci' || low === 'tunai') && accIds.length < (type === 'pindah' ? 2 : 1)) { accIds.push(KAS); continue; }
      if (accIds.length < (type === 'pindah' ? 2 : 1)) {
        /* nama rekening dua kata, misalnya "sagara mobile" */
        var two = i + 1 < toks.length ? waAcc(low + toks[i + 1].toLowerCase().replace(/[,;]+$/, ''), type === 'topup' ? 'bank' : null, accs) : null;
        if (two && !two.amb && accs.some(function (a) { return a.id === two.id && waNorm(a.name) === waNorm(low + toks[i + 1]); })) { accIds.push(two.id); i++; continue; }
        var r = waAcc(low, type === 'topup' ? 'bank' : null, accs);
        if (!r && type === 'topup') r = waAcc(low, 'ewallet', accs);
        if (r && r.amb) { err = 'rekening-ganda'; break; }
        if (r) { accIds.push(r.id); continue; }
      }
    }
    name.push(tok.replace(/[,;]+$/, ''));
  }
  if (err) return { ok: false, msg: 'Pesan tidak bisa dibaca (' + err + ').' };
  if (T && T.onlyAdm) {
    /* Kartu ATM nasabah: yang dicatat hanya biaya admin yang masuk laci ("kartu 5000" atau "kartu admin 5000"), tanpa nominal */
    if (!fee && amount) { fee = amount; feeSet = true; }
    amount = 0;
    if (!fee) return { ok: false, msg: 'Tulis biaya admin kartu, misalnya "kartu admin 5000".' };
  } else if (!amount) return { ok: false, msg: 'Nominal tidak ditemukan.' };
  /* admin / potongan bank tidak ditulis -> pakai tarif otomatis dari pengaturan aplikasi (seperti di formulir) */
  if (T && T.fee && !T.onlyAdm && settings) {
    if (!feeSet) fee = tierFee(settings.admTiers, amount);
    if (!bfSet) bf = tierFee(settings.bfTiers, amount);
  }
  date = date || defDate || today();
  if (type === 'pindah') {
    if (accIds.length < 2) return { ok: false, msg: 'Tulis dua rekening, asal lalu tujuan.' };
    if (accIds[0] === accIds[1]) return { ok: false, msg: 'Rekening asal dan tujuan sama.' };
    return { ok: true, kind: 'mv', obj: { date: date, type: 'pindah', from: accIds[0], to: accIds[1], amount: amount, fee: fee, note: "Dari WhatsApp (otomatis)" } };
  }
  var t = { date: date, type: type, name: name.join(' '), amount: amount, fee: T.fee ? fee : 0, komisi: T.fee ? kom : 0, bf: T.fee ? bf : 0, acc: '', note: "Dari WhatsApp (otomatis)" };
  if (T.onlyAdm) { t.acc = KAS; t.adm = 'luar'; }
  if (T.modal) t.modal = modal;
  if (T.pay) {
    t.pay = pay || 'cash';
    if (t.pay === 'utang' && !name.join(' ').trim()) return { ok: false, msg: 'Utang perlu nama pelanggan, misalnya "pulsa 10rb bri admin 2000 utang budi".' };
    if (t.pay === 'transfer') {
      var pid = payAcc;
      if (!pid) { var pl = accs.filter(function (a) { return a.kind === 'bank' || a.kind === 'ewallet'; }); if (pl.length === 1) pid = pl[0].id; }
      if (!pid) return { ok: false, msg: 'Tulis rekening tujuan transfer pelanggan, misalnya "tf bri" atau "trf gopay".' };
      t.payAcc = pid;
    }
  } else if (pay === 'utang') {
    t.pay = 'utang';
    if (!name.join(' ').trim()) return { ok: false, msg: 'Utang perlu nama, misalnya "pulsa 10rb bri admin 2000 utang budi".' };
  }
  if (T.dest && bt) { t.bt = bt; if (rek) t.rek = rek; }
  if (T.acc) {
    var id = accIds[0], pool = accs;
    if (type === 'topup') { var bk = accs.filter(function (a) { return a.kind === 'bank'; }); if (bk.length) pool = bk; }
    if (!id && (lk(type) === 'keluar' || lk(type) === 'masuk')) id = KAS;
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
  return { ok: true, kind: 'tx', obj: t, terima: recv };
}


/* ---------- koreksi otomatis & contoh format yang benar ---------- */
var EXAMPLES = {
  tarik: 'tarik tunai 500rb bri admin 5000',
  transfer: 'transfer 1jt bri bca 1234567890 ani admin 5000',
  setor: 'setor tunai 1jt bni admin 3000',
  topup: 'topup 100rb dana 081234567890 bri',
  bayar: 'bayar 235rb dana admin 2500 listrik pln',
  isi: 'isi saldo 2jt bri',
  keluar: 'keluar 50rb beli galon',
  sesama: 'sesama 200rb bri bni ani admin 2500',
  elektrik: 'listrik 200rb bri admin 3000 cash',
  online: 'pulsa 10rb bri admin 3rb komisi 1000 pot 2rb cash',
  kartu: 'kartu 500rb admin 5000',
  jual: 'jual 50rb modal 30rb cash',
  masuk: 'masuk 100rb bri hasil dagang',
  pindah: 'pindah 500rb bri dana'
};
var CANON = { tarik: 'tarik', transfer: 'transfer', bayar: 'bayar', isi: 'isi', topup: 'topup', elektrik: 'listrik', online: 'pulsa', kartu: 'kartu', jual: 'jual', masuk: 'masuk', keluar: 'keluar', pindah: 'pindah', setor: 'setor', sesama: 'sesama' };
var CASH_TYPO = { kash: 1, cas: 1, csh: 1, cesh: 1, cashh: 1, casj: 1 };
var KW_ATTACHED = /^(admin|adm|fee|komisi|kom|pot|potongan|pajak|modal)(\d[\d.,]*(?:rb|ribu|k|jt|juta)?)$/i;

/* perbaikan yang aman: "admin5000" -> "admin 5000", "kash" -> "cash" */
function normalizeRaw(raw) {
  var out = [];
  String(raw || '').split(/\s+/).filter(Boolean).forEach(function (t) {
    var m = KW_ATTACHED.exec(t);
    if (m) { out.push(m[1], m[2]); return; }
    if (CASH_TYPO[t.toLowerCase().replace(/[,;]+$/, '')]) { out.push('cash'); return; }
    out.push(t);
  });
  return out.join(' ');
}

/* jarak ketik (hapus/tambah/ganti 1 huruf, atau tukar 2 huruf berdampingan) */
function editDist(a, b) {
  var d = [], i, j;
  for (i = 0; i <= a.length; i++) { d[i] = [i]; }
  for (j = 1; j <= b.length; j++) d[0][j] = j;
  for (i = 1; i <= a.length; i++) for (j = 1; j <= b.length; j++) {
    var c = a[i - 1] === b[j - 1] ? 0 : 1;
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + c);
    if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
  }
  return d[a.length][b.length];
}
function hasBigAmount(toks) {
  return toks.some(function (t) { var l = t.toLowerCase().replace(/[,;]+$/, ''); return /(rb|ribu|k|jt|juta)$/.test(l) ? waAmount(l) != null : /^\d{4,}$/.test(l.replace(/[.,]/g, '')) && waAmount(l) != null; });
}

/* urutan kebalik: "10rb pulsa bri" -> "pulsa 10rb bri", "pulsa 10rb bri 3rb admin" -> "... admin 3rb".
   Hanya memindahkan kata (tidak menambah/mengubah isi), dan hanya kalau kata sebelum jenis transaksi
   berupa nominal / nama rekening / kata admin-cash, supaya obrolan biasa tidak ikut tercatat. */
var KW_VAL = { admin: 1, adm: 1, fee: 1, komisi: 1, kom: 1, pot: 1, potongan: 1, pajak: 1, modal: 1 };
function reorder(text, accs) {
  var toks = text.split(/\s+/).filter(Boolean), changed = false;
  if (!toks.length) return { text: text, changed: false };
  var first = toks[0].toLowerCase().replace(/[^a-z]/g, '');
  if (!WA_TYPES[first]) {
    var idx = -1;
    for (var i = 1; i < Math.min(toks.length, 5); i++) {
      var w = toks[i].toLowerCase().replace(/[,;]+$/, '');
      if (/^[a-z]+$/.test(w) && WA_TYPES[w]) { idx = i; break; }
    }
    if (idx > 0) {
      var okBefore = toks.slice(0, idx).every(function (t) {
        var l = t.toLowerCase().replace(/[,;]+$/, '');
        return waAmount(l) != null || KW_VAL[l] || l === 'cash' || l === 'tunai' || l === 'utang' || l === 'kas' || l === 'laci' || !!waAcc(l, null, accs);
      });
      if (okBefore) {
        var moved = [toks.splice(idx, 1)[0]];
        var nl = (toks[idx] || '').toLowerCase().replace(/[,;]+$/, '');   /* \"tarik tunai\", \"isi saldo\", \"top up\" tetap sepaket */
        if (nl === 'tunai' || nl === 'saldo' || nl === 'up') moved.push(toks.splice(idx, 1)[0]);
        toks = moved.concat(toks); changed = true;
      }
    }
  }
  /* "3rb admin" (nilai di depan kata) -> "admin 3rb", hanya setelah ada nominal utama sebelumnya */
  var seenAmt = false, out = [];
  for (var j = 0; j < toks.length; j++) {
    var cur = toks[j], lc = cur.toLowerCase().replace(/[,;]+$/, ''), nx = (toks[j + 1] || '').toLowerCase().replace(/[,;]+$/, ''), nn = toks[j + 2] ? waAmount(toks[j + 2].toLowerCase().replace(/[,;]+$/, '')) : null;
    if (j > 0 && waAmount(lc) != null && KW_VAL[nx] && nn == null && seenAmt) { out.push(toks[j + 1], cur); j++; changed = true; continue; }
    if (j > 0 && waAmount(lc) != null) seenAmt = true;
    out.push(cur);
  }
  return { text: out.join(' '), changed: changed };
}

function waLine(raw, defDate, accs, settings) {
  var text = normalizeRaw(raw);
  var ro = reorder(text, accs || []);
  var r = waLine0(ro.text, defDate, accs, settings);
  if (ro.changed && !r.skip) { r.note = ro.text; text = ro.text; }
  var toks = text.split(/\s+/).filter(Boolean);
  var first = toks.length ? toks[0].toLowerCase().replace(/[^a-z]/g, '') : '';
  if (r.skip) {
    /* kata pertama salah ketik (misalnya "pulas", "tranfsr") tapi ada nominal: tawarkan versi yang benar */
    if (first.length >= 4 && hasBigAmount(toks)) {
      var best = null;
      Object.keys(WA_TYPES).forEach(function (k) { if (k.length >= 4 && editDist(first, k) === 1) best = best || k; });
      if (best) {
        var t2 = WA_TYPES[best], canon = CANON[t2] || best;
        return { ok: false, msg: 'Kata "' + toks[0] + '" tidak dikenal, mungkin maksud Anda "' + canon + '".', corrected: [canon].concat(toks.slice(1)).join(' '), type: t2, example: EXAMPLES[t2] };
      }
    }
    return r;
  }
  if (!r.ok) { r.type = WA_TYPES[first]; r.example = EXAMPLES[r.type]; }
  return r;
}

module.exports = { waAcc: waAcc, waAmount: waAmount, KAS: KAS, waLine: waLine, TYPES: TYPES, ADM: ADM, waNorm: waNorm, lk: lk, fx: fx, calcBalance: calcBalance, debtFor: debtFor, splitLines: splitLines };
