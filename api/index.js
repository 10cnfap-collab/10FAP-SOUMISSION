/**
 * API — Plateforme de soumission des résumés, 10ème Congrès National de la FAP
 * Fonction serverless Vercel (Node.js).
 *
 * Base de données : Upstash Redis (Vercel › Storage › Marketplace › Upstash for Redis)
 *   -> variables injectées automatiquement : KV_REST_API_URL / KV_REST_API_TOKEN
 *      (ou UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN)
 * Administration : ADMIN_PASSWORD (obligatoire), SESSION_SECRET (recommandé)
 * E-mails : SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, MAIL_FROM  — ou RESEND_API_KEY + MAIL_FROM
 *
 * Toutes les requêtes : POST /api  { "fn": "<action>", "args": [...] }
 */
const crypto = require('crypto');
const { Redis } = require('@upstash/redis');
const nodemailer = require('nodemailer');

/* ---------------- Configuration ---------------- */
const DEFAULTS = {
  edition: '10ème Congrès National de la Fédération Algérienne de Pharmacie',
  short: '10ème Congrès FAP',
  themeGeneral: '',
  dates: '22 – 23 décembre 2026',
  lieu: 'Centre International de Conférences (CIC), Alger',
  submissionMode: 'auto',
  deadline: '2026-11-30T23:59',
  maxWords: 300,
  ackAuto: true,
  signature: 'Le Comité scientifique'
};
const PREFIX = 'FAP10-';
const NS = process.env.DB_PREFIX || 'fap10';
const K = {
  absSeq: `${NS}:abs:seq`, abs: `${NS}:abs`,
  msgSeq: `${NS}:msg:seq`, msg: `${NS}:msg`,
  log: `${NS}:log`, cfg: `${NS}:cfg`
};
const ABS_FIELDS = ['nom','prenom','email','tel','statut_pro','etablissement','wilaya','titre','type_travail',
  'thematique','mode','auteurs','affiliations','introduction','methodes','resultats','conclusion','motscles','conflits','engagements'];
const REQUIRED = ABS_FIELDS.filter(f => f !== 'engagements');
const STATUS_LABEL = { en_attente: 'En évaluation', revision: 'Révision demandée', orale: 'Accepté – Communication orale', poster: 'Accepté – Poster', refuse: 'Refusé' };
const ACK_FALLBACK = {
  subject: 'Accusé de réception {{ref}} – {{congres_court}}',
  body: 'Bonjour {{prenom}} {{nom}},\n\nNous accusons réception de votre résumé « {{titre}} », enregistré sous la référence {{ref}}.\n\nLe comité scientifique vous communiquera sa décision par e-mail.\n\nBien cordialement,'
};

/* ---------------- Helpers ---------------- */
class UserError extends Error {}
const fail = m => { throw new UserError(m); };
const clean = (s, max = 5000) => String(s == null ? '' : s).trim().slice(0, max);
const words = s => (String(s || '').trim().match(/\S+/g) || []).length;
const validEmail = s => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(s));
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const nowIso = () => new Date().toISOString();
const pad = n => String(n).padStart(4, '0');

let _redis;
function db() {
  if (_redis) return _redis;
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) fail('Base de données non configurée : connectez Upstash Redis au projet dans Vercel › Storage, puis redéployez.');
  _redis = new Redis({ url, token, automaticDeserialization: false });
  return _redis;
}
const parse = v => { if (v == null) return null; if (typeof v === 'object') return v; try { return JSON.parse(v); } catch (e) { return null; } };
async function hAll(key) { const h = await db().hgetall(key); return h ? Object.values(h).map(parse).filter(Boolean) : []; }
async function hGet(key, id) { return parse(await db().hget(key, id)); }
async function hSet(key, id, obj) { await db().hset(key, { [id]: JSON.stringify(obj) }); }

async function settings() { return parse(await db().get(K.cfg)); }
async function cfg() { return Object.assign({}, DEFAULTS, (await settings()) || {}); }
const deadlineDate = c => new Date(String(c.deadline).length <= 16 ? c.deadline + ':00+01:00' : c.deadline);
const isOpen = c => c.submissionMode === 'open' ? true : c.submissionMode === 'closed' ? false : Date.now() <= deadlineDate(c).getTime();
const deadlineLabel = c => deadlineDate(c).toLocaleString('fr-FR', { timeZone: 'Africa/Algiers', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });

/* ---------------- Anti-abus ---------------- */
async function rateLimit(ctx, bucket, max, windowSec) {
  const key = `${NS}:rl:${bucket}:${ctx.ip}:${Math.floor(Date.now() / 1000 / windowSec)}`;
  const n = await db().incr(key);
  if (n === 1) await db().expire(key, windowSec + 5);
  if (n > max) fail('Trop de tentatives. Patientez quelques minutes avant de réessayer.');
}

/* ---------------- Authentification admin ---------------- */
const secret = () => process.env.SESSION_SECRET || ('fap10:' + (process.env.ADMIN_PASSWORD || ''));
const b64u = b => Buffer.from(b).toString('base64url');
const sign = p => crypto.createHmac('sha256', secret()).update(p).digest('base64url');
function makeToken() { const p = b64u(JSON.stringify({ exp: Date.now() + 8 * 3600e3 })); return p + '.' + sign(p); }
function auth(token) {
  const [p, s] = String(token || '').split('.');
  if (!p || !s) fail('Session expirée. Reconnectez-vous.');
  const a = Buffer.from(sign(p)), b = Buffer.from(s);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) fail('Session expirée. Reconnectez-vous.');
  const { exp } = JSON.parse(Buffer.from(p, 'base64url').toString());
  if (Date.now() > exp) fail('Session expirée. Reconnectez-vous.');
}

/* ---------------- E-mails ---------------- */
let _smtp;
const mailReady = () => !!((process.env.RESEND_API_KEY && process.env.MAIL_FROM) || (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS));
function fill(text, a, c) {
  const v = { prenom: a.prenom, nom: a.nom, ref: a.ref, titre: a.titre, thematique: a.thematique, mode_souhaite: a.mode,
    decision: STATUS_LABEL[a.decision] || '', commentaire: a.commentaire || '', congres: c.edition, congres_court: c.short,
    dates: c.dates, lieu: c.lieu, theme_general: c.themeGeneral || '', date_limite: deadlineLabel(c) };
  return String(text || '').replace(/\{\{(\w+)\}\}/g, (m, k) => (k in v ? String(v[k] == null ? '' : v[k]) : m));
}
function frame(bodyText, c, siteUrl) {
  const paras = String(bodyText).replace(/\n{3,}/g, '\n\n').split(/\n\s*\n/).filter(p => p.trim())
    .map(p => '<p style="margin:0 0 12px">' + esc(p).replace(/\n/g, '<br>') + '</p>').join('');
  return '<div style="font-family:Roboto,Arial,sans-serif;max-width:620px;margin:auto;border:1px solid #d3e1ec;border-radius:8px;overflow:hidden">' +
    '<div style="background:#0e87ce;color:#fff;padding:18px 24px"><table role="presentation" cellpadding="0" cellspacing="0"><tr>' +
    (siteUrl ? '<td style="padding-right:16px"><img src="' + esc(siteUrl) + '/logo-email.png" width="130" alt="Fédération Algérienne de Pharmacie" style="display:block"></td>' : '') +
    '<td style="font-size:12px;color:#fff">' + esc(c.dates) + ' · ' + esc(c.lieu) + '<br><b style="font-size:15px">' + esc(c.edition) + '</b>' +
    (c.themeGeneral ? '<br><i>« ' + esc(c.themeGeneral) + ' »</i>' : '') + '</td></tr></table></div>' +
    '<div style="padding:22px 24px;color:#14232f;font-size:15px;line-height:1.6">' + paras +
    '<p style="margin:0">' + esc(c.signature) + '<br>' + esc(c.short) + '</p></div></div>';
}
async function sendMail(ctx, to, subject, text, c) {
  if (!mailReady()) fail("Envoi d'e-mails non configuré (variables SMTP ou RESEND_API_KEY).");
  const from = process.env.MAIL_FROM || `"${c.signature} – ${c.short}" <${process.env.SMTP_USER}>`;
  const replyTo = process.env.MAIL_REPLY_TO || undefined;
  const html = frame(text, c, ctx.siteUrl);
  const fullText = text + '\n\n' + c.signature + '\n' + c.short;
  if (process.env.RESEND_API_KEY) {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: [to], subject, html, text: fullText, reply_to: replyTo })
    });
    if (!r.ok) throw new Error('Resend ' + r.status + ' : ' + (await r.text()).slice(0, 200));
    return;
  }
  if (!_smtp) {
    const port = Number(process.env.SMTP_PORT || 465);
    _smtp = nodemailer.createTransport({ host: process.env.SMTP_HOST, port, secure: port === 465,
      auth: { user: String(process.env.SMTP_USER).trim(), pass: String(process.env.SMTP_PASS).trim() },
      connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 30000 });
  }
  await _smtp.sendMail({ from, to, subject, text: fullText, html, replyTo });
}
function explainMail(e) {
  const m = String((e && (e.response || e.message)) || e);
  if (/EAUTH|535|Authentication failed|Invalid login|5\.7\.8/i.test(m)) return 'Identifiant ou clé SMTP refusés : vérifiez SMTP_USER (identifiant Brevo xxxx@smtp-brevo.com) et SMTP_PASS (clé SMTP xsmtpsib-…), puis redéployez.';
  if (/not yet activated|not activated|account.*(suspend|blocked)|5\.7\.0/i.test(m)) return 'Compte SMTP Brevo non activé ou suspendu : complétez le profil Brevo et attendez la validation, ou contactez le support Brevo.';
  if (/unauthori[sz]ed ip|IP address|not authorised|not authorized/i.test(m)) return 'Adresse IP refusée par Brevo : désactivez « Blocage d\'adresses IP non autorisées » pour les clés SMTP.';
  if (/sender|from address|not.*valid.*sender|unverified/i.test(m)) return 'Expéditeur refusé : l\'adresse de MAIL_FROM doit être un expéditeur vérifié dans Brevo.';
  if (/ETIMEDOUT|ECONNREFUSED|ENOTFOUND|ESOCKET|ECONNECTION/i.test(m)) return 'Serveur SMTP injoignable : vérifiez SMTP_HOST (smtp-relay.brevo.com) et SMTP_PORT (587).';
  return m.slice(0, 250);
}
async function sendTpl(ctx, a, subject, body, c) { await sendMail(ctx, a.email, fill(subject, a, c), fill(body, a, c), c); }
async function addLog(modele, objet, refs, failed) {
  await db().lpush(K.log, JSON.stringify({ date: nowIso(), modele, objet, nb: refs.length - failed.length, refs: refs.join(', '),
    echecs: failed.map(f => f.ref + ' : ' + f.error).join(' | ') }));
  await db().ltrim(K.log, 0, 499);
}

/* ---------------- Actions publiques ---------------- */
async function getPublicConfig() {
  const s = await settings();
  if (!s) return null;
  delete s.templates;
  return s;
}
async function submitAbstract(ctx, o) {
  o = o || {};
  const c = await cfg();
  if (!isOpen(c)) fail('Les soumissions sont closes.');
  await rateLimit(ctx, 'sub', 8, 3600);
  const a = {};
  ABS_FIELDS.forEach(f => a[f] = clean(o[f], f === 'titre' ? 300 : 4000));
  REQUIRED.forEach(f => { if (!a[f]) fail('Champ obligatoire manquant : ' + f + '.'); });
  if (!validEmail(a.email)) fail('Adresse e-mail non valide.');
  const n = words(a.introduction) + words(a.methodes) + words(a.resultats) + words(a.conclusion);
  if (n > c.maxWords) fail(`Le résumé dépasse ${c.maxWords} mots (${n}).`);
  a.ref = PREFIX + pad(await db().incr(K.absSeq));
  Object.assign(a, { email: a.email.toLowerCase(), date: nowIso(), decision: 'en_attente', commentaire: '', note_interne: '', date_decision: '', notifie: '' });
  await hSet(K.abs, a.ref, a);
  if (c.ackAuto !== false && mailReady()) {
    const t = (c.templates || []).find(x => x.trigger === 'ack') || ACK_FALLBACK;
    try { await sendTpl(ctx, a, t.subject, t.body, c); } catch (e) { _smtp = null; console.error('ack', explainMail(e)); }
  }
  return { ref: a.ref };
}
async function getStatus(ctx, ref, email) {
  await rateLimit(ctx, 'st', 30, 600);
  const a = await hGet(K.abs, clean(ref, 30).toUpperCase());
  if (!a || a.email.toLowerCase() !== clean(email, 200).toLowerCase()) fail('Aucune soumission ne correspond à cette référence et cette adresse e-mail.');
  return { ref: a.ref, titre: a.titre, date: a.date, decision: a.decision || 'en_attente', commentaire: a.commentaire };
}
async function sendContact(ctx, o) {
  o = o || {};
  await rateLimit(ctx, 'ct', 6, 3600);
  const m = { nom: clean(o.nom, 200), email: clean(o.email, 200), objet: clean(o.objet, 100), ref: clean(o.ref, 30), message: clean(o.message, 5000) };
  if (!m.nom || !m.objet || !m.message) fail("Renseignez votre nom, l'objet et votre message.");
  if (!validEmail(m.email)) fail('Adresse e-mail non valide.');
  m.id = 'M-' + pad(await db().incr(K.msgSeq));
  Object.assign(m, { date: nowIso(), lu: '', reponse: '', date_reponse: '' });
  await hSet(K.msg, m.id, m);
  return { ok: true };
}
async function adminLogin(ctx, pw) {
  const real = process.env.ADMIN_PASSWORD;
  if (!real) fail('Mot de passe administrateur non configuré (variable ADMIN_PASSWORD dans Vercel).');
  await rateLimit(ctx, 'login', 10, 900);
  const h = x => crypto.createHash('sha256').update(String(x)).digest();
  if (!crypto.timingSafeEqual(h(pw), h(real))) fail('Mot de passe incorrect.');
  return makeToken();
}

/* ---------------- Actions admin ---------------- */
async function adminData(ctx, token) {
  auth(token);
  const [abstracts, messages, logRaw, s] = await Promise.all([hAll(K.abs), hAll(K.msg), db().lrange(K.log, 0, 199), settings()]);
  return { abstracts, messages, log: (logRaw || []).map(parse).filter(Boolean).reverse(), settings: s, sheetUrl: '', quota: null, mailReady: mailReady() };
}
async function adminSaveSettings(ctx, token, s) {
  auth(token);
  const json = JSON.stringify(s || {});
  if (json.length > 500000) fail('Paramètres trop volumineux.');
  await db().set(K.cfg, json);
  return true;
}
async function adminDecide(ctx, token, ref, decision, commentaire, note, mail) {
  auth(token);
  if (!STATUS_LABEL[decision]) fail('Statut inconnu.');
  const a = await hGet(K.abs, ref);
  if (!a) fail('Résumé introuvable : ' + ref);
  Object.assign(a, { decision, commentaire: clean(commentaire), note_interne: clean(note), date_decision: nowIso() });
  let mailError = '';
  if (mail && mail.subject && mail.body) {
    try {
      const c = await cfg();
      await sendTpl(ctx, a, mail.subject, mail.body, c);
      a.notifie = 'oui – ' + nowIso();
      await addLog(mail.name || STATUS_LABEL[decision], fill(mail.subject, a, c), [ref], []);
    } catch (e) { mailError = explainMail(e); _smtp = null; }
  }
  await hSet(K.abs, ref, a);
  return Object.assign({}, a, mailError ? { mailError } : {});
}
async function adminSendMail(ctx, token, refs, subject, body, modele) {
  auth(token);
  if (!Array.isArray(refs) || !refs.length) fail('Aucun destinataire.');
  if (refs.length > 50) fail('50 destinataires maximum par lot.');
  if (!subject || !body) fail('Objet et message obligatoires.');
  if (!mailReady()) fail("Envoi d'e-mails non configuré (variables SMTP ou RESEND_API_KEY).");
  const c = await cfg();
  const list = (await db().hmget(K.abs, ...refs)) || {};
  const targets = refs.map(r => parse(Array.isArray(list) ? list[refs.indexOf(r)] : list[r])).filter(Boolean);
  let sent = 0; const failed = [];
  for (const a of targets) {
    try { await sendTpl(ctx, a, subject, body, c); sent++; }
    catch (e) { failed.push({ ref: a.ref, error: explainMail(e) }); _smtp = null; }
  }
  await addLog(modele || 'Message libre', subject, targets.map(a => a.ref), failed);
  return { sent, failed, quota: null };
}
async function adminTestMail(ctx, token, to) {
  auth(token);
  to = clean(to, 200);
  if (!validEmail(to)) fail('Adresse e-mail de test non valide.');
  const c = await cfg();
  const info = { host: process.env.SMTP_HOST || '(Resend)', port: process.env.SMTP_PORT || '', user: process.env.SMTP_USER || '', from: process.env.MAIL_FROM || '' };
  try {
    await sendMail(ctx, to, 'Test d\'envoi – ' + c.short, 'Bonjour,\n\nCet e-mail de test confirme que la plateforme des résumés envoie correctement les messages.', c);
    return { ok: true, info };
  } catch (e) {
    _smtp = null;
    return { ok: false, error: explainMail(e), raw: String(e.message || e).slice(0, 300), info };
  }
}
async function adminMarkRead(ctx, token, id) {
  auth(token);
  const m = await hGet(K.msg, id);
  if (m) { m.lu = 'oui'; await hSet(K.msg, id, m); }
  return true;
}
async function adminReply(ctx, token, id, text) {
  auth(token);
  text = clean(text);
  if (!text) fail('Réponse vide.');
  const m = await hGet(K.msg, id);
  if (!m) fail('Message introuvable.');
  const c = await cfg();
  const d = new Date(m.date).toLocaleDateString('fr-FR', { timeZone: 'Africa/Algiers' });
  await sendMail(ctx, m.email, 'Re : ' + m.objet + ' – ' + c.short, 'Bonjour ' + m.nom + ',\n\n' + text + '\n\n———\nVotre message du ' + d + ' :\n' + m.message, c);
  Object.assign(m, { reponse: text, date_reponse: nowIso(), lu: 'oui' });
  await hSet(K.msg, id, m);
  return m;
}

const ACTIONS = { getPublicConfig, submitAbstract, getStatus, sendContact, adminLogin, adminData,
  adminSaveSettings, adminDecide, adminSendMail, adminMarkRead, adminReply, adminTestMail };

/* ---------------- Handler Vercel ---------------- */
module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'GET') {
    return res.status(200).json({ ok: true, service: 'API résumés – 10ème Congrès FAP', db: !!(process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL), mail: mailReady(), admin: !!process.env.ADMIN_PASSWORD });
  }
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Méthode non autorisée.' });
  try {
    let body = req.body;
    if (typeof body === 'string') body = JSON.parse(body || '{}');
    if (Buffer.isBuffer(body)) body = JSON.parse(body.toString('utf8') || '{}');
    const fn = ACTIONS[body && body.fn];
    if (!fn) fail('Action inconnue.');
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const ctx = {
      ip: String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'inconnu').split(',')[0].trim(),
      siteUrl: process.env.SITE_URL || (host ? 'https://' + host : '')
    };
    const data = await fn(ctx, ...(Array.isArray(body.args) ? body.args : []));
    return res.status(200).json({ ok: true, data });
  } catch (e) {
    if (!(e instanceof UserError)) console.error(e);
    return res.status(200).json({ ok: false, error: e instanceof UserError ? e.message : 'Erreur serveur : ' + (e.message || e) });
  }
};
