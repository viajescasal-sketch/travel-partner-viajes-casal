'use strict';

const crypto = require('crypto');

// Utilidades de verificación en dos pasos: códigos TOTP (apps), cifrado del secreto,
// códigos por correo, códigos de respaldo y equipos recordados.

const EMAIL_CODE_MINUTES = 10;
const TRUSTED_DAYS = 30;
const TRUSTED_COOKIE = 'tp.td';
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');

function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32[(value << (5 - bits)) & 31];
  return output;
}

function base32Decode(text) {
  const clean = String(text).toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const char of clean) {
    value = (value << 5) | BASE32.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

const generateTotpSecret = () => base32Encode(crypto.randomBytes(20));

// RFC 6238: 6 dígitos, intervalos de 30 segundos, HMAC-SHA1.
function totpAt(secret, counter) {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', base32Decode(secret)).update(buffer).digest();
  const offset = hmac[hmac.length - 1] & 15;
  const code = ((hmac.readUInt32BE(offset) & 0x7fffffff) % 1000000).toString();
  return code.padStart(6, '0');
}

// Acepta el código actual y uno antes o después (desfase de reloj del celular).
function verifyTotp(secret, code, now = Date.now()) {
  const clean = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(clean)) return false;
  const counter = Math.floor(now / 30000);
  return [-1, 0, 1].some((delta) => crypto.timingSafeEqual(Buffer.from(totpAt(secret, counter + delta)), Buffer.from(clean)));
}

function otpauthUrl(secret, account, issuer = 'Viajes Casal') {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

// El secreto de la app se guarda cifrado (AES-256-GCM) con una llave derivada de SESSION_SECRET.
function keyFrom(sessionSecret) {
  return crypto.createHash('sha256').update(`totp:${sessionSecret}`).digest();
}
function encryptSecret(secret, sessionSecret) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyFrom(sessionSecret), iv);
  const data = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString('base64url')).join('.');
}
function decryptSecret(payload, sessionSecret) {
  try {
    const [iv, tag, data] = String(payload).split('.').map((p) => Buffer.from(p, 'base64url'));
    const decipher = crypto.createDecipheriv('aes-256-gcm', keyFrom(sessionSecret), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

const generateEmailCode = () => String(crypto.randomInt(0, 1000000)).padStart(6, '0');

// 8 códigos de respaldo de un solo uso, formato XXXX-XXXX.
function generateBackupCodes(count = 8) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: count }, () => {
    let code = '';
    for (let i = 0; i < 8; i += 1) code += alphabet[crypto.randomInt(alphabet.length)];
    return `${code.slice(0, 4)}-${code.slice(4)}`;
  });
}
const normalizeBackupCode = (code) => String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const hashBackupCode = (code) => sha256(`backup:${normalizeBackupCode(code)}`);

// p***a@outlook.com
function maskEmail(email) {
  const [user, domain] = String(email).split('@');
  if (!domain) return email;
  const visible = user.length <= 2 ? user[0] : `${user[0]}${'*'.repeat(Math.min(user.length - 2, 6))}${user.at(-1)}`;
  return `${visible}@${domain}`;
}

function readCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

module.exports = {
  EMAIL_CODE_MINUTES,
  TRUSTED_DAYS,
  TRUSTED_COOKIE,
  sha256,
  base32Encode,
  base32Decode,
  generateTotpSecret,
  totpAt,
  verifyTotp,
  otpauthUrl,
  encryptSecret,
  decryptSecret,
  generateEmailCode,
  generateBackupCodes,
  normalizeBackupCode,
  hashBackupCode,
  maskEmail,
  readCookie
};
