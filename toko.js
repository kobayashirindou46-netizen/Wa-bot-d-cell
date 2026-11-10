/* ---------------------------------------------------------------------
   Daftar toko lain yang boleh memakai bot ini (lewat WhatsApp masing-masing).
   Murni logika (tanpa Firebase/WhatsApp) supaya mudah diuji.
------------------------------------------------------------------------ */
'use strict';

/* nomor ke bentuk 62xxxxxxxxxx (tanpa +, spasi, strip) */
function normNum(s) {
  var d = String(s || '').replace(/\D/g, '');
  if (!d) return '';
  if (d.indexOf('0') === 0) d = '62' + d.slice(1);
  else if (d.indexOf('8') === 0) d = '62' + d;
  return d;
}

/* list: isi toko.json. Hasil: { byNum: {628..: toko}, byLid: {angka: toko} } */
function buildIndex(list) {
  var byNum = {}, byLid = {};
  (Array.isArray(list) ? list : []).forEach(function (t) {
    if (!t || typeof t !== 'object') return;
    var n = normNum(t.nomor);
    if (n) byNum[n] = t;
    if (t.lid) byLid[String(t.lid).replace(/\D/g, '')] = t;
  });
  return { byNum: byNum, byLid: byLid };
}

/* cari toko dari pesan masuk. WhatsApp kadang memakai ID "@lid" alih-alih nomor,
   dan nomor aslinya ada di key.remoteJidAlt / key.senderPn (tergantung versi Baileys). */
function findToko(index, key) {
  var jid = (key && key.remoteJid) || '';
  var cands = [key && key.remoteJidAlt, key && key.senderPn, key && key.participantPn, jid];
  for (var i = 0; i < cands.length; i++) {
    var c = cands[i];
    if (typeof c === 'string' && /@s\.whatsapp\.net$/.test(c)) {
      var t = index.byNum[normNum(c.split('@')[0].split(':')[0])];
      if (t) return t;
    }
  }
  if (/@lid$/.test(jid)) {
    var l = index.byLid[jid.split('@')[0].split(':')[0]];
    if (l) return l;
  }
  return null;
}

module.exports = { normNum: normNum, buildIndex: buildIndex, findToko: findToko };
