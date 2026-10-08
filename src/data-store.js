'use strict';

const bcrypt = require('bcryptjs');
const mysql = require('mysql2/promise');
const { ENTITIES, ENTITY_ORDER, createTableSql, nowCancun } = require('./crm-schema');

const phoneKey = (value) => String(value || '').replace(/\D/g, '').slice(-10);

// Convierte una fila de base de datos al formato que usa la página.
function normalizeRow(entityName, row) {
  if (!row) return null;
  const out = { ...row };
  for (const [name, spec] of Object.entries(ENTITIES[entityName].fields)) {
    if (spec.type === 'bool') out[name] = Boolean(out[name]);
    if ((spec.type === 'money' || spec.type === 'int' || spec.type === 'ref') && out[name] !== null && out[name] !== undefined) out[name] = Number(out[name]);
  }
  out.id = Number(out.id);
  if (out.owner_id !== null && out.owner_id !== undefined) out.owner_id = Number(out.owner_id);
  return out;
}

function databaseConfigFromEnv(env) {
  return {
    host: env.DB_HOST,
    port: Number(env.DB_PORT || 3306),
    database: env.DB_NAME,
    user: env.DB_USER,
    password: env.DB_PASSWORD,
    charset: 'utf8mb4'
  };
}

function requiredProductionVariables(env) {
  return ['SESSION_SECRET', 'DB_HOST', 'DB_NAME', 'DB_USER', 'DB_PASSWORD', 'ADMIN_EMAIL', 'PARTNER_EMAIL']
    .filter((name) => !env[name]);
}

class MySQLDataStore {
  constructor(env) {
    this.env = env;
    this.pool = mysql.createPool({ ...databaseConfigFromEnv(env), waitForConnections: true, connectionLimit: 5, queueLimit: 0, dateStrings: true, decimalNumbers: true });
  }

  async initialize() {
    await this.pool.execute(`CREATE TABLE IF NOT EXISTS users (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      email VARCHAR(254) NOT NULL UNIQUE,
      name VARCHAR(120) NOT NULL,
      role ENUM('admin','travel_partner','consulta') NOT NULL,
      password_hash VARCHAR(100) NOT NULL,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      must_change_password BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    await this.pool.execute(`CREATE TABLE IF NOT EXISTS activity_logs (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      user_id BIGINT UNSIGNED NULL,
      action VARCHAR(80) NOT NULL,
      ip_address VARCHAR(64) NULL,
      user_agent VARCHAR(500) NULL,
      metadata JSON NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_activity_user (user_id), INDEX idx_activity_created (created_at),
      CONSTRAINT fk_activity_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    for (const entityName of ENTITY_ORDER) {
      await this.pool.query(createTableSql(entityName));
    }
    await this.pool.query(`CREATE TABLE IF NOT EXISTS crm_settings (
      setting_key VARCHAR(60) NOT NULL PRIMARY KEY,
      setting_value TEXT NOT NULL,
      updated_at DATETIME NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    await this.bootstrapUser(this.env.ADMIN_EMAIL, 'Administrador', 'admin', this.env.ADMIN_INITIAL_PASSWORD);
    await this.bootstrapUser(this.env.PARTNER_EMAIL, 'Paulina', 'travel_partner', this.env.PARTNER_INITIAL_PASSWORD);
  }

  async listRecords(entityName) {
    const { table } = ENTITIES[entityName];
    const [rows] = await this.pool.query(`SELECT * FROM \`${table}\` ORDER BY id DESC LIMIT 5000`);
    return rows.map((row) => normalizeRow(entityName, row));
  }

  async getRecord(entityName, id) {
    const { table } = ENTITIES[entityName];
    const [rows] = await this.pool.execute(`SELECT * FROM \`${table}\` WHERE id = ? LIMIT 1`, [id]);
    return normalizeRow(entityName, rows[0]);
  }

  async insertRecord(entityName, data, ownerId) {
    const { table } = ENTITIES[entityName];
    const now = nowCancun();
    const record = { ...data, owner_id: ownerId ?? null, created_at: now, updated_at: now };
    const columns = Object.keys(record);
    const [result] = await this.pool.execute(
      `INSERT INTO \`${table}\` (${columns.map((c) => `\`${c}\``).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
      columns.map((c) => record[c])
    );
    return this.getRecord(entityName, result.insertId);
  }

  async updateRecord(entityName, id, data) {
    const { table } = ENTITIES[entityName];
    const record = { ...data, updated_at: nowCancun() };
    const columns = Object.keys(record);
    const [result] = await this.pool.execute(
      `UPDATE \`${table}\` SET ${columns.map((c) => `\`${c}\` = ?`).join(', ')} WHERE id = ?`,
      [...columns.map((c) => record[c]), id]
    );
    return result.affectedRows ? this.getRecord(entityName, id) : null;
  }

  async deleteRecord(entityName, id) {
    const { table } = ENTITIES[entityName];
    const [result] = await this.pool.execute(`DELETE FROM \`${table}\` WHERE id = ?`, [id]);
    return result.affectedRows > 0;
  }

  async findClientByPhone(phone) {
    const key = phoneKey(phone);
    if (key.length < 7) return null;
    const [rows] = await this.pool.query('SELECT * FROM crm_clients WHERE phone IS NOT NULL');
    return normalizeRow('clients', rows.find((row) => phoneKey(row.phone) === key));
  }

  async listFolios(prefix) {
    const [rows] = await this.pool.execute('SELECT folio FROM crm_quotes WHERE folio LIKE ?', [`${prefix}%`]);
    return rows.map((row) => row.folio);
  }

  async getSetting(key) {
    const [rows] = await this.pool.execute('SELECT setting_value FROM crm_settings WHERE setting_key = ? LIMIT 1', [key]);
    return rows[0] ? JSON.parse(rows[0].setting_value) : null;
  }

  async setSetting(key, value) {
    await this.pool.execute(
      'INSERT INTO crm_settings (setting_key, setting_value, updated_at) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value), updated_at = VALUES(updated_at)',
      [key, JSON.stringify(value), nowCancun()]
    );
  }

  async bootstrapUser(email, name, role, password) {
    const normalized = email.trim().toLowerCase();
    const [rows] = await this.pool.execute('SELECT id FROM users WHERE email = ? LIMIT 1', [normalized]);
    if (rows.length) return;
    if (!password) throw new Error(`Falta la contraseña inicial para crear ${normalized}`);
    const passwordHash = await bcrypt.hash(password, 12);
    await this.pool.execute('INSERT INTO users (email, name, role, password_hash) VALUES (?, ?, ?, ?)', [normalized, name, role, passwordHash]);
  }

  async findUserByEmail(email) {
    const [rows] = await this.pool.execute('SELECT * FROM users WHERE email = ? LIMIT 1', [email]);
    return rows[0] || null;
  }

  async findUserById(id) {
    const [rows] = await this.pool.execute('SELECT * FROM users WHERE id = ? LIMIT 1', [id]);
    return rows[0] || null;
  }

  async updatePassword(id, passwordHash) {
    await this.pool.execute('UPDATE users SET password_hash = ?, must_change_password = FALSE WHERE id = ?', [passwordHash, id]);
  }

  async logActivity(userId, action, req, metadata = null) {
    await this.pool.execute('INSERT INTO activity_logs (user_id, action, ip_address, user_agent, metadata) VALUES (?, ?, ?, ?, ?)', [userId, action, req.ip, req.get('user-agent') || null, metadata ? JSON.stringify(metadata) : null]);
  }

  async listUsers() {
    const [rows] = await this.pool.execute('SELECT id, email, name, role, active, must_change_password, created_at FROM users ORDER BY created_at');
    return rows;
  }

  async listActivity() {
    const [rows] = await this.pool.execute(`SELECT a.id, a.action, a.ip_address, a.created_at, u.email
      FROM activity_logs a LEFT JOIN users u ON u.id = a.user_id ORDER BY a.created_at DESC LIMIT 200`);
    return rows;
  }
}

class MemoryDataStore {
  constructor(env) {
    this.env = env;
    this.users = [];
    this.activity = [];
    this.records = Object.fromEntries(ENTITY_ORDER.map((name) => [name, []]));
    this.sequence = 0;
    this.settings = new Map();
  }

  async initialize() {
    const required = ['ADMIN_EMAIL', 'ADMIN_INITIAL_PASSWORD', 'PARTNER_EMAIL', 'PARTNER_INITIAL_PASSWORD'].filter((name) => !this.env[name]);
    if (required.length) throw new Error(`Faltan variables locales requeridas: ${required.join(', ')}`);
    const adminPassword = this.env.ADMIN_INITIAL_PASSWORD;
    const partnerPassword = this.env.PARTNER_INITIAL_PASSWORD;
    this.users = [
      { id: 1, email: this.env.ADMIN_EMAIL.toLowerCase(), name: 'Administrador', role: 'admin', password_hash: await bcrypt.hash(adminPassword, 10), active: true, must_change_password: true },
      { id: 2, email: this.env.PARTNER_EMAIL.toLowerCase(), name: 'Paulina', role: 'travel_partner', password_hash: await bcrypt.hash(partnerPassword, 10), active: true, must_change_password: true }
    ];
  }

  async findUserByEmail(email) { return this.users.find((user) => user.email === email) || null; }
  async findUserById(id) { return this.users.find((user) => user.id === Number(id)) || null; }
  async updatePassword(id, passwordHash) { const user = await this.findUserById(id); user.password_hash = passwordHash; user.must_change_password = false; }
  async logActivity(userId, action, req, metadata = null) { this.activity.unshift({ id: this.activity.length + 1, user_id: userId, action, ip_address: req.ip, metadata, created_at: new Date() }); }
  async listUsers() { return this.users.map(({ password_hash, ...user }) => user); }
  async listActivity() { return this.activity.slice(0, 200); }

  async listRecords(entityName) { return [...this.records[entityName]].sort((a, b) => b.id - a.id).map((row) => ({ ...row })); }
  async getRecord(entityName, id) { const row = this.records[entityName].find((item) => item.id === Number(id)); return row ? { ...row } : null; }

  async insertRecord(entityName, data, ownerId) {
    const spec = ENTITIES[entityName].fields;
    const now = nowCancun();
    const row = { id: ++this.sequence };
    for (const name of Object.keys(spec)) row[name] = data[name] ?? (spec[name].type === 'bool' ? false : null);
    Object.assign(row, { owner_id: ownerId ?? null, created_at: now, updated_at: now });
    this.assertReferences(entityName, row);
    this.records[entityName].push(row);
    return { ...row };
  }

  async updateRecord(entityName, id, data) {
    const row = this.records[entityName].find((item) => item.id === Number(id));
    if (!row) return null;
    const next = { ...row, ...data, updated_at: nowCancun() };
    this.assertReferences(entityName, next);
    Object.assign(row, next);
    return { ...row };
  }

  assertReferences(entityName, row) {
    for (const [name, spec] of Object.entries(ENTITIES[entityName].fields)) {
      if (spec.type === 'ref' && row[name] != null && !this.records[spec.entity].some((item) => item.id === row[name])) {
        const error = new Error('Referencia inexistente'); error.code = 'ER_NO_REFERENCED_ROW_2'; throw error;
      }
    }
  }

  // Emula las reglas ON DELETE de MySQL.
  async deleteRecord(entityName, id) {
    const list = this.records[entityName];
    const index = list.findIndex((item) => item.id === Number(id));
    if (index < 0) return false;
    list.splice(index, 1);
    for (const other of ENTITY_ORDER) {
      for (const [name, spec] of Object.entries(ENTITIES[other].fields)) {
        if (spec.type !== 'ref' || spec.entity !== entityName) continue;
        const affected = this.records[other].filter((row) => row[name] === Number(id));
        for (const row of affected) {
          if (spec.onDelete === 'CASCADE') await this.deleteRecord(other, row.id);
          else row[name] = null;
        }
      }
    }
    return true;
  }

  async findClientByPhone(phone) {
    const key = phoneKey(phone);
    if (key.length < 7) return null;
    const row = this.records.clients.find((item) => phoneKey(item.phone) === key);
    return row ? { ...row } : null;
  }

  async listFolios(prefix) { return this.records.quotes.map((row) => row.folio).filter((folio) => folio && folio.startsWith(prefix)); }
  async getSetting(key) { return this.settings.has(key) ? JSON.parse(this.settings.get(key)) : null; }
  async setSetting(key, value) { this.settings.set(key, JSON.stringify(value)); }
}

function createDataStore(env) {
  if (env.NODE_ENV === 'production') {
    const missing = requiredProductionVariables(env);
    if (missing.length) throw new Error(`Faltan variables de entorno requeridas: ${missing.join(', ')}`);
    return new MySQLDataStore(env);
  }
  return new MemoryDataStore(env);
}

module.exports = { createDataStore, databaseConfigFromEnv, MySQLDataStore, MemoryDataStore, requiredProductionVariables, phoneKey };
