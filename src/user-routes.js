'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const express = require('express');
const { ROLES, ROLE_LABELS } = require('./access');
const { ValidationError } = require('./crm-schema');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Sin caracteres que se confunden al dictarlos (0/O, 1/l/I).
const LOWER = 'abcdefghijkmnpqrstuvwxyz';
const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const DIGITS = '23456789';

// Contraseña temporal de 14 caracteres que cumple la política (mayúscula, minúscula y número).
function temporaryPassword() {
  const all = LOWER + UPPER + DIGITS;
  const pick = (set) => set[crypto.randomInt(set.length)];
  const chars = [pick(LOWER), pick(UPPER), pick(DIGITS)];
  while (chars.length < 14) chars.push(pick(all));
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

const publicUser = (u) => ({
  id: Number(u.id), email: u.email, name: u.name, role: u.role, roleLabel: ROLE_LABELS[u.role] || u.role,
  active: Boolean(u.active), mustChangePassword: Boolean(u.must_change_password),
  lastLoginAt: u.last_login_at || null, createdAt: u.created_at || null
});

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  error.expose = true;
  return error;
}

function createUserRouter(dataStore, { requireRole, destroyUserSessions }) {
  const router = express.Router();
  router.use(requireRole('admin'));

  const wrap = (handler) => async (req, res, next) => {
    try { await handler(req, res); } catch (error) { next(error); }
  };
  const log = (req, action, metadata) => dataStore.logActivity(req.session.user.id, action, req, metadata);

  const cleanName = (value) => {
    const name = String(value ?? '').trim();
    if (!name || name.length > 120) throw new ValidationError('El nombre es obligatorio (máximo 120 caracteres)');
    return name;
  };
  const cleanRole = (value) => {
    if (!ROLES.includes(value)) throw new ValidationError('Rol no válido');
    return value;
  };

  // Debe quedar al menos un administrador activo.
  async function assertAdminRemains(targetId, nextRole, nextActive) {
    const users = await dataStore.listUsers();
    const admins = users.filter((u) => u.active && u.role === 'admin' && u.id !== targetId);
    if (!admins.length && (nextRole !== 'admin' || !nextActive)) {
      throw new ValidationError('Debe quedar al menos un administrador activo');
    }
  }

  router.get('/', wrap(async (_req, res) => {
    res.json({ ok: true, users: (await dataStore.listUsers()).map(publicUser), roles: ROLE_LABELS });
  }));

  router.post('/', wrap(async (req, res) => {
    const body = req.body || {};
    const email = String(body.email ?? '').trim().toLowerCase();
    if (!EMAIL_RE.test(email) || email.length > 254) throw new ValidationError('El correo no es válido');
    const name = cleanName(body.name);
    const role = cleanRole(body.role);
    if (await dataStore.findUserByEmail(email)) throw httpError(409, 'Ya existe un usuario con ese correo');
    const password = temporaryPassword();
    const user = await dataStore.createUser({ email, name, role, passwordHash: await bcrypt.hash(password, 12) });
    await log(req, 'user_create', { id: user.id, role });
    res.status(201).json({ ok: true, user: publicUser(user), temporaryPassword: password });
  }));

  router.patch('/:id', wrap(async (req, res) => {
    const id = Number(req.params.id);
    const user = await dataStore.findUserById(id);
    if (!user) throw httpError(404, 'No se encontró el usuario');
    const body = req.body || {};
    const fields = {};
    if (body.name !== undefined) fields.name = cleanName(body.name);
    if (body.role !== undefined) fields.role = cleanRole(body.role);
    if (body.active !== undefined) fields.active = Boolean(body.active);
    const nextRole = fields.role ?? user.role;
    const nextActive = fields.active ?? Boolean(user.active);
    if (id === req.session.user.id && (nextRole !== 'admin' || !nextActive)) {
      throw new ValidationError('No puedes quitarte el rol de administrador ni desactivar tu propia cuenta');
    }
    if (user.role === 'admin') await assertAdminRemains(id, nextRole, nextActive);
    const updated = await dataStore.updateUser(id, fields);
    if (!nextActive) await destroyUserSessions(id);
    await log(req, 'user_update', { id, ...fields });
    res.json({ ok: true, user: publicUser(updated) });
  }));

  router.post('/:id/reset-password', wrap(async (req, res) => {
    const id = Number(req.params.id);
    const user = await dataStore.findUserById(id);
    if (!user) throw httpError(404, 'No se encontró el usuario');
    if (id === req.session.user.id) throw new ValidationError('Para tu propia cuenta usa “Cambiar contraseña”');
    const password = temporaryPassword();
    await dataStore.setTemporaryPassword(id, await bcrypt.hash(password, 12));
    await destroyUserSessions(id);
    await log(req, 'user_reset_password', { id });
    res.json({ ok: true, temporaryPassword: password });
  }));

  return router;
}

module.exports = { createUserRouter, temporaryPassword, publicUser };
