'use strict';

const bcrypt = require('bcryptjs');
const mysql = require('mysql2/promise');
const { ENTITIES, ENTITY_ORDER, createTableSql, columnSql, nowCancun } = require('./crm-schema');

const phoneKey = (value) => String(value || '').replace(/\D/g, '').slice(-10);

// Las acciones del CRM se llaman crm_<entidad>_<acción>; de ahí se deduce la entidad en registros antiguos.
function activityEntity(action) {
  const match = /^crm_(clients|leads|quotes|trips|followups)_/.exec(action || '');
  return match ? match[1] : null;
}
function normalizeActivity(row) {
  let metadata = row.metadata;
  if (typeof metadata === 'string') { try { metadata = JSON.parse(metadata); } catch { metadata = null; } }
  metadata = metadata || {};
  return {
    id: Number(row.id),
    action: row.action,
    userId: row.user_id == null ? null : Number(row.user_id),
    userName: row.user_name || null,
    userEmail: row.user_email || metadata.email || null,
    entity: row.entity || activityEntity(row.action),
    entityId: row.entity_id != null ? Number(row.entity_id) : (metadata.id != null ? Number(metadata.id) : null),
    summary: row.summary || null,
    changes: Array.isArray(metadata.changes) ? metadata.changes : [],
    note: metadata.note || null,
    method: metadata.twofa || null,
    ip: row.ip_address || null,
    createdMs: Number(row.created_ms)
  };
}

// Convierte una fila de base de datos al formato que usa la página.
function normalizeRow(entityName, row) {
  if (!row) return null;
  const out = { ...row };
  for (const [name, spec] of Object.entries(ENTITIES[entityName].fields)) {
    if (spec.type === 'bool') out[name] = Boolean(out[name]);
    if ((spec.type === 'money' || spec.type === 'int' || spec.type === 'ref') && out[name] !== null && out[name] !== undefined) out[name] = Number(out[name]);
    if (spec.type === 'json') {
      let value = out[name];
      if (typeof value === 'string') { try { value = JSON.parse(value); } catch { value = null; } }
      out[name] = value && typeof value === 'object' ? JSON.parse(JSON.stringify(value)) : null;
    }
  }
  out.id = Number(out.id);
  if (out.owner_id !== null && out.owner_id !== undefined) out.owner_id = Number(out.owner_id);
  return out;
}

// Los campos JSON se guardan como texto en MySQL.
function serializeRow(entityName, record) {
  const out = { ...record };
  for (const [name, spec] of Object.entries(ENTITIES[entityName].fields)) {
    if (spec.type === 'json' && out[name] != null && typeof out[name] === 'object') out[name] = JSON.stringify(out[name]);
  }
  return out;
}

function normalizeBackup(row) {
  let summary = row.summary;
  if (typeof summary === 'string') { try { summary = JSON.parse(summary); } catch { summary = {}; } }
  return {
    id: Number(row.id), kind: row.kind, createdAt: row.created_at, summary: summary || {},
    emailStatus: row.email_status || null, xlsxSize: Number(row.xlsx_size || 0), jsonSize: Number(row.json_size || 0),
    createdBy: row.created_by_name || null
  };
}

// Datos públicos del perfil de un usuario para documentos.
const PROFILE_FIELDS = { phone: 40, bio: 1500, website: 200 };

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
      role ENUM('admin','travel_partner','operaciones','consulta') NOT NULL,
      password_hash VARCHAR(100) NOT NULL,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      must_change_password BOOLEAN NOT NULL DEFAULT TRUE,
      last_login_at DATETIME NULL,
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
    await this.migrateUsers();
    await this.migrateActivity();
    await this.pool.query(`CREATE TABLE IF NOT EXISTS password_resets (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      user_id BIGINT UNSIGNED NOT NULL,
      token_hash CHAR(64) NOT NULL UNIQUE,
      expires_at BIGINT UNSIGNED NOT NULL,
      used_at BIGINT UNSIGNED NULL,
      requested_ip VARCHAR(64) NULL,
      created_at BIGINT UNSIGNED NOT NULL,
      INDEX idx_reset_user (user_id),
      CONSTRAINT fk_reset_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    for (const entityName of ENTITY_ORDER) {
      await this.pool.query(createTableSql(entityName));
    }
    await this.migrateEntities();
    await this.pool.query(`CREATE TABLE IF NOT EXISTS crm_media (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      owner_id BIGINT UNSIGNED NULL,
      mime VARCHAR(40) NOT NULL,
      size INT UNSIGNED NOT NULL,
      data MEDIUMBLOB NOT NULL,
      created_at DATETIME NOT NULL,
      CONSTRAINT fk_media_owner FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    await this.pool.query(`CREATE TABLE IF NOT EXISTS crm_backups (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      kind VARCHAR(10) NOT NULL,
      created_at DATETIME NOT NULL,
      created_by BIGINT UNSIGNED NULL,
      summary TEXT NULL,
      email_status VARCHAR(255) NULL,
      xlsx MEDIUMBLOB NOT NULL,
      json_gz MEDIUMBLOB NOT NULL,
      INDEX idx_backups_created (created_at),
      CONSTRAINT fk_backups_user FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    await this.pool.query(`CREATE TABLE IF NOT EXISTS crm_settings (
      setting_key VARCHAR(60) NOT NULL PRIMARY KEY,
      setting_value TEXT NOT NULL,
      updated_at DATETIME NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    await this.bootstrapUser(this.env.ADMIN_EMAIL, 'Administrador', 'admin', this.env.ADMIN_INITIAL_PASSWORD);
    await this.bootstrapUser(this.env.PARTNER_EMAIL, 'Paulina', 'travel_partner', this.env.PARTNER_INITIAL_PASSWORD);
  }

  // Ajusta tablas creadas por versiones anteriores sin borrar datos.
  async migrateUsers() {
    const [columns] = await this.pool.query(
      "SELECT COLUMN_NAME, COLUMN_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users'"
    );
    const role = columns.find((c) => c.COLUMN_NAME === 'role');
    if (role && !String(role.COLUMN_TYPE).includes('operaciones')) {
      await this.pool.query("ALTER TABLE users MODIFY role ENUM('admin','travel_partner','operaciones','consulta') NOT NULL");
    }
    if (!columns.some((c) => c.COLUMN_NAME === 'last_login_at')) {
      await this.pool.query('ALTER TABLE users ADD COLUMN last_login_at DATETIME NULL AFTER must_change_password');
    }
    const twofaColumns = {
      twofa_enabled: 'BOOLEAN NOT NULL DEFAULT FALSE',
      totp_enabled: 'BOOLEAN NOT NULL DEFAULT FALSE',
      totp_secret: 'TEXT NULL',
      backup_codes: 'TEXT NULL'
    };
    Object.assign(twofaColumns, {
      phone: 'VARCHAR(40) NULL',
      photo_media_id: 'BIGINT UNSIGNED NULL',
      bio: 'TEXT NULL',
      website: 'VARCHAR(200) NULL'
    });
    for (const [name, definition] of Object.entries(twofaColumns)) {
      if (!columns.some((c) => c.COLUMN_NAME === name)) await this.pool.query(`ALTER TABLE users ADD COLUMN ${name} ${definition}`);
    }
    await this.pool.query(`CREATE TABLE IF NOT EXISTS twofa_codes (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      user_id BIGINT UNSIGNED NOT NULL,
      code_hash CHAR(64) NOT NULL,
      expires_at BIGINT UNSIGNED NOT NULL,
      attempts INT UNSIGNED NOT NULL DEFAULT 0,
      used_at BIGINT UNSIGNED NULL,
      created_at BIGINT UNSIGNED NOT NULL,
      INDEX idx_twofa_user (user_id),
      CONSTRAINT fk_twofa_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    await this.pool.query(`CREATE TABLE IF NOT EXISTS trusted_devices (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      user_id BIGINT UNSIGNED NOT NULL,
      token_hash CHAR(64) NOT NULL UNIQUE,
      user_agent VARCHAR(300) NULL,
      expires_at BIGINT UNSIGNED NOT NULL,
      last_used_at BIGINT UNSIGNED NULL,
      created_at BIGINT UNSIGNED NOT NULL,
      INDEX idx_trusted_user (user_id),
      CONSTRAINT fk_trusted_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  }

  // Agrega columnas nuevas de las entidades del CRM (por ejemplo, datos del cotizador).
  async migrateEntities() {
    for (const entityName of ENTITY_ORDER) {
      const { table, fields } = ENTITIES[entityName];
      const [columns] = await this.pool.query(
        'SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', [table]
      );
      const existing = new Set(columns.map((c) => c.COLUMN_NAME));
      for (const [name, spec] of Object.entries(fields)) {
        if (existing.has(name) || spec.type === 'ref') continue;
        await this.pool.query(`ALTER TABLE \`${table}\` ADD COLUMN ${columnSql(name, { ...spec, required: false, unique: false })}`);
      }
    }
  }

  // ---- Imágenes (fotos de hotel, portada, vendedor) ----
  async createMedia({ ownerId, mime, data }) {
    const [result] = await this.pool.execute('INSERT INTO crm_media (owner_id, mime, size, data, created_at) VALUES (?, ?, ?, ?, ?)', [ownerId ?? null, mime, data.length, data, nowCancun()]);
    return Number(result.insertId);
  }

  async getMedia(id) {
    const [rows] = await this.pool.execute('SELECT mime, data FROM crm_media WHERE id = ? LIMIT 1', [id]);
    return rows[0] ? { mime: rows[0].mime, data: rows[0].data } : null;
  }

  // ---- Respaldos (se conservan los más recientes) ----
  async createBackup({ kind, userId, summary, xlsx, jsonGz, createdAt }) {
    const [result] = await this.pool.execute(
      'INSERT INTO crm_backups (kind, created_at, created_by, summary, xlsx, json_gz) VALUES (?, ?, ?, ?, ?, ?)',
      [kind, createdAt || nowCancun(), userId ?? null, JSON.stringify(summary || {}), xlsx, jsonGz]
    );
    return Number(result.insertId);
  }

  // Candado de MySQL: evita que dos procesos hagan el respaldo automático al mismo tiempo.
  async withLock(name, fn) {
    const conn = await this.pool.getConnection();
    try {
      const [rows] = await conn.query('SELECT GET_LOCK(?, 0) AS ok', [name]);
      if (Number(rows[0].ok) !== 1) return null;
      try { return await fn(); } finally { await conn.query('SELECT RELEASE_LOCK(?)', [name]); }
    } finally { conn.release(); }
  }

  async updateBackupStatus(id, emailStatus) {
    await this.pool.execute('UPDATE crm_backups SET email_status = ? WHERE id = ?', [String(emailStatus || '').slice(0, 255), id]);
  }

  async listBackups() {
    const [rows] = await this.pool.query(
      `SELECT b.id, b.kind, b.created_at, b.summary, b.email_status, LENGTH(b.xlsx) AS xlsx_size, LENGTH(b.json_gz) AS json_size, u.name AS created_by_name
       FROM crm_backups b LEFT JOIN users u ON u.id = b.created_by ORDER BY b.id DESC LIMIT 100`
    );
    return rows.map(normalizeBackup);
  }

  async getBackupFile(id, type) {
    const column = type === 'json' ? 'json_gz' : 'xlsx';
    const [rows] = await this.pool.execute(`SELECT created_at, ${column} AS data FROM crm_backups WHERE id = ? LIMIT 1`, [id]);
    return rows[0] ? { createdAt: rows[0].created_at, data: rows[0].data } : null;
  }

  async lastBackupAt(kind) {
    const [rows] = await this.pool.execute('SELECT MAX(created_at) AS last FROM crm_backups WHERE kind = ?', [kind]);
    return rows[0]?.last || null;
  }

  async pruneBackups(keep) {
    const [rows] = await this.pool.query('SELECT id FROM crm_backups ORDER BY id DESC');
    const remove = rows.slice(keep).map((r) => Number(r.id));
    if (remove.length) await this.pool.query(`DELETE FROM crm_backups WHERE id IN (${remove.map(() => '?').join(',')})`, remove);
    return remove.length;
  }

  async updateProfile(id, fields) {
    const columns = Object.keys(fields).filter((key) => key in PROFILE_FIELDS || key === 'photo_media_id');
    if (!columns.length) return;
    await this.pool.execute(`UPDATE users SET ${columns.map((c) => `\`${c}\` = ?`).join(', ')} WHERE id = ?`, [...columns.map((c) => fields[c]), id]);
  }

  async migrateActivity() {
    const [columns] = await this.pool.query(
      "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'activity_logs'"
    );
    const has = (name) => columns.some((c) => c.COLUMN_NAME === name);
    if (!has('entity')) await this.pool.query('ALTER TABLE activity_logs ADD COLUMN entity VARCHAR(30) NULL AFTER action');
    if (!has('entity_id')) await this.pool.query('ALTER TABLE activity_logs ADD COLUMN entity_id BIGINT UNSIGNED NULL AFTER entity');
    if (!has('summary')) {
      await this.pool.query('ALTER TABLE activity_logs ADD COLUMN summary VARCHAR(255) NULL AFTER entity_id');
      await this.pool.query('ALTER TABLE activity_logs ADD INDEX idx_activity_entity (entity, entity_id)');
    }
  }

  // ---- Verificación en dos pasos ----
  async updateUserSecurity(id, fields) {
    const allowed = ['twofa_enabled', 'totp_enabled', 'totp_secret', 'backup_codes'];
    const columns = Object.keys(fields).filter((key) => allowed.includes(key));
    if (!columns.length) return;
    await this.pool.execute(`UPDATE users SET ${columns.map((c) => `\`${c}\` = ?`).join(', ')} WHERE id = ?`, [...columns.map((c) => fields[c]), id]);
  }

  async createEmailCode({ userId, codeHash, expiresAt }) {
    await this.pool.execute('UPDATE twofa_codes SET used_at = ? WHERE user_id = ? AND used_at IS NULL', [Date.now(), userId]);
    await this.pool.execute('INSERT INTO twofa_codes (user_id, code_hash, expires_at, created_at) VALUES (?, ?, ?, ?)', [userId, codeHash, expiresAt, Date.now()]);
  }

  async activeEmailCode(userId) {
    const [rows] = await this.pool.execute('SELECT * FROM twofa_codes WHERE user_id = ? AND used_at IS NULL AND expires_at > ? ORDER BY id DESC LIMIT 1', [userId, Date.now()]);
    const row = rows[0];
    return row ? { id: Number(row.id), code_hash: row.code_hash, attempts: Number(row.attempts), created_at: Number(row.created_at) } : null;
  }

  async lastEmailCodeAt(userId) {
    const [rows] = await this.pool.execute('SELECT MAX(created_at) AS last FROM twofa_codes WHERE user_id = ?', [userId]);
    return rows[0]?.last == null ? null : Number(rows[0].last);
  }

  async addCodeAttempt(id) { await this.pool.execute('UPDATE twofa_codes SET attempts = attempts + 1 WHERE id = ?', [id]); }
  async useEmailCode(id) { await this.pool.execute('UPDATE twofa_codes SET used_at = ? WHERE id = ?', [Date.now(), id]); }

  async createTrustedDevice({ userId, tokenHash, expiresAt, userAgent }) {
    await this.pool.execute('INSERT INTO trusted_devices (user_id, token_hash, user_agent, expires_at, created_at) VALUES (?, ?, ?, ?, ?)', [userId, tokenHash, String(userAgent || '').slice(0, 300), expiresAt, Date.now()]);
  }

  async findTrustedDevice(tokenHash) {
    const [rows] = await this.pool.execute('SELECT * FROM trusted_devices WHERE token_hash = ? LIMIT 1', [tokenHash]);
    const row = rows[0];
    return row ? { id: Number(row.id), user_id: Number(row.user_id), expires_at: Number(row.expires_at) } : null;
  }

  async touchTrustedDevice(id) { await this.pool.execute('UPDATE trusted_devices SET last_used_at = ? WHERE id = ?', [Date.now(), id]); }
  async deleteTrustedDevices(userId) { await this.pool.execute('DELETE FROM trusted_devices WHERE user_id = ?', [userId]); }
  async countTrustedDevices(userId) {
    const [rows] = await this.pool.execute('SELECT COUNT(*) AS n FROM trusted_devices WHERE user_id = ? AND expires_at > ?', [userId, Date.now()]);
    return Number(rows[0].n);
  }

  async createUser({ email, name, role, passwordHash }) {
    const [result] = await this.pool.execute(
      'INSERT INTO users (email, name, role, password_hash, must_change_password) VALUES (?, ?, ?, ?, TRUE)',
      [email, name, role, passwordHash]
    );
    return this.findUserById(result.insertId);
  }

  async updateUser(id, fields) {
    const allowed = ['name', 'role', 'active'];
    const columns = Object.keys(fields).filter((key) => allowed.includes(key));
    if (!columns.length) return this.findUserById(id);
    await this.pool.execute(`UPDATE users SET ${columns.map((c) => `\`${c}\` = ?`).join(', ')} WHERE id = ?`, [...columns.map((c) => fields[c]), id]);
    return this.findUserById(id);
  }

  async setTemporaryPassword(id, passwordHash) {
    await this.pool.execute('UPDATE users SET password_hash = ?, must_change_password = TRUE WHERE id = ?', [passwordHash, id]);
  }

  // ---- Enlaces de recuperación (las fechas se guardan en milisegundos UTC) ----
  async createPasswordReset({ userId, tokenHash, expiresAt, ip }) {
    await this.pool.execute(
      'INSERT INTO password_resets (user_id, token_hash, expires_at, requested_ip, created_at) VALUES (?, ?, ?, ?, ?)',
      [userId, tokenHash, expiresAt, ip || null, Date.now()]
    );
  }

  async findPasswordReset(tokenHash) {
    const [rows] = await this.pool.execute('SELECT * FROM password_resets WHERE token_hash = ? LIMIT 1', [tokenHash]);
    const row = rows[0];
    return row ? { ...row, id: Number(row.id), user_id: Number(row.user_id), expires_at: Number(row.expires_at), used_at: row.used_at == null ? null : Number(row.used_at), created_at: Number(row.created_at) } : null;
  }

  async lastPasswordResetAt(userId) {
    const [rows] = await this.pool.execute('SELECT MAX(created_at) AS last FROM password_resets WHERE user_id = ?', [userId]);
    return rows[0]?.last == null ? null : Number(rows[0].last);
  }

  // Marca como usados todos los enlaces pendientes del usuario (el nuevo o el que se acaba de usar).
  async invalidatePasswordResets(userId) {
    await this.pool.execute('UPDATE password_resets SET used_at = ? WHERE user_id = ? AND used_at IS NULL', [Date.now(), userId]);
  }

  async touchLogin(id) {
    await this.pool.execute('UPDATE users SET last_login_at = ? WHERE id = ?', [nowCancun(), id]);
  }

  async transferLeadOwnership(leadId, ownerId) {
    await this.pool.execute('UPDATE crm_leads SET owner_id = ?, updated_at = ? WHERE id = ?', [ownerId, nowCancun(), leadId]);
    await this.pool.execute('UPDATE crm_quotes SET owner_id = ? WHERE lead_id = ?', [ownerId, leadId]);
    await this.pool.execute('UPDATE crm_followups SET owner_id = ? WHERE lead_id = ? AND done = FALSE', [ownerId, leadId]);
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
    const record = serializeRow(entityName, { ...data, owner_id: ownerId ?? null, created_at: now, updated_at: now });
    const columns = Object.keys(record);
    const [result] = await this.pool.execute(
      `INSERT INTO \`${table}\` (${columns.map((c) => `\`${c}\``).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
      columns.map((c) => record[c])
    );
    return this.getRecord(entityName, result.insertId);
  }

  async updateRecord(entityName, id, data) {
    const { table } = ENTITIES[entityName];
    const record = serializeRow(entityName, { ...data, updated_at: nowCancun() });
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
    if (!password) {
      console.warn(`Aviso: no se creó ${normalized} porque falta su contraseña inicial`);
      return;
    }
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
    const { entity = null, entityId = null, summary = null, ...rest } = metadata || {};
    await this.pool.execute(
      'INSERT INTO activity_logs (user_id, action, entity, entity_id, summary, ip_address, user_agent, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [userId, action, entity, entityId, summary ? String(summary).slice(0, 255) : null, req?.ip || null, req?.get?.('user-agent')?.slice(0, 500) || null, Object.keys(rest).length ? JSON.stringify(rest) : null]
    );
  }

  async listUsers() {
    const [rows] = await this.pool.execute('SELECT id, email, name, role, active, must_change_password, last_login_at, twofa_enabled, totp_enabled, phone, photo_media_id, bio, website, created_at FROM users ORDER BY created_at');
    return rows.map((row) => ({ ...row, id: Number(row.id), photo_media_id: row.photo_media_id == null ? null : Number(row.photo_media_id), active: Boolean(row.active), must_change_password: Boolean(row.must_change_password), twofa_enabled: Boolean(row.twofa_enabled), totp_enabled: Boolean(row.totp_enabled) }));
  }

  // Consulta con filtros: usuario, tipo (crm/seguridad), entidad, registro, fechas (ms) y paginación por id.
  async listActivity(filters = {}) {
    const where = [];
    const params = [];
    if (filters.userId) { where.push('a.user_id = ?'); params.push(filters.userId); }
    if (filters.type === 'crm') where.push("a.action LIKE 'crm\\_%'");
    if (filters.type === 'security') where.push("a.action NOT LIKE 'crm\\_%'");
    if (filters.entity) {
      if (filters.entityId) {
        where.push("((a.entity = ? AND a.entity_id = ?) OR (a.entity IS NULL AND a.action LIKE ? AND JSON_UNQUOTE(JSON_EXTRACT(a.metadata, '$.id')) = ?))");
        params.push(filters.entity, filters.entityId, `crm\\_${filters.entity}\\_%`, String(filters.entityId));
      } else {
        where.push('(a.entity = ? OR (a.entity IS NULL AND a.action LIKE ?))');
        params.push(filters.entity, `crm\\_${filters.entity}\\_%`);
      }
    }
    if (filters.fromMs) { where.push('a.created_at >= FROM_UNIXTIME(?)'); params.push(Math.floor(filters.fromMs / 1000)); }
    if (filters.toMs) { where.push('a.created_at < FROM_UNIXTIME(?)'); params.push(Math.floor(filters.toMs / 1000)); }
    if (filters.beforeId) { where.push('a.id < ?'); params.push(filters.beforeId); }
    const limit = Math.min(Math.max(Number(filters.limit) || 100, 1), 500);
    const [rows] = await this.pool.query(
      `SELECT a.id, a.user_id, a.action, a.entity, a.entity_id, a.summary, a.ip_address, a.metadata,
              UNIX_TIMESTAMP(a.created_at) * 1000 AS created_ms, u.name AS user_name, u.email AS user_email
       FROM activity_logs a LEFT JOIN users u ON u.id = a.user_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY a.id DESC LIMIT ${limit}`,
      params
    );
    return rows.map(normalizeActivity);
  }

  async purgeActivity(days) {
    const [result] = await this.pool.execute('DELETE FROM activity_logs WHERE created_at < (NOW() - INTERVAL ? DAY)', [days]);
    return result.affectedRows;
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
  async findUserById(id) { const user = this.users.find((u) => u.id === Number(id)); return user ? { ...user } : null; }
  async updatePassword(id, passwordHash) { const user = this.users.find((u) => u.id === Number(id)); user.password_hash = passwordHash; user.must_change_password = false; }
  async logActivity(userId, action, req, metadata = null) {
    const { entity = null, entityId = null, summary = null, ...rest } = metadata || {};
    this.activitySeq = (this.activitySeq || 0) + 1;
    this.activity.unshift({ id: this.activitySeq, user_id: userId, action, entity, entity_id: entityId, summary, ip_address: req?.ip || null, metadata: rest, created_ms: Date.now() });
  }
  async listUsers() { return this.users.map(({ password_hash, ...user }) => ({ ...user })); }
  async createUser({ email, name, role, passwordHash }) {
    if (this.users.some((u) => u.email === email)) { const error = new Error('duplicado'); error.code = 'ER_DUP_ENTRY'; throw error; }
    const user = { id: Math.max(0, ...this.users.map((u) => u.id)) + 1, email, name, role, password_hash: passwordHash, active: true, must_change_password: true, last_login_at: null, created_at: nowCancun() };
    this.users.push(user);
    return { ...user };
  }
  async updateUser(id, fields) {
    const user = this.users.find((u) => u.id === Number(id));
    if (!user) return null;
    for (const key of ['name', 'role', 'active']) if (fields[key] !== undefined) user[key] = fields[key];
    return { ...user };
  }
  async setTemporaryPassword(id, passwordHash) { const user = this.users.find((u) => u.id === Number(id)); user.password_hash = passwordHash; user.must_change_password = true; }
  async createPasswordReset({ userId, tokenHash, expiresAt, ip }) {
    this.resets = this.resets || [];
    this.resets.push({ id: this.resets.length + 1, user_id: userId, token_hash: tokenHash, expires_at: expiresAt, used_at: null, requested_ip: ip || null, created_at: Date.now() });
  }
  async findPasswordReset(tokenHash) { const row = (this.resets || []).find((r) => r.token_hash === tokenHash); return row ? { ...row } : null; }
  async lastPasswordResetAt(userId) { const rows = (this.resets || []).filter((r) => r.user_id === userId); return rows.length ? Math.max(...rows.map((r) => r.created_at)) : null; }
  async invalidatePasswordResets(userId) { (this.resets || []).filter((r) => r.user_id === userId && r.used_at == null).forEach((r) => { r.used_at = Date.now(); }); }
  async updateUserSecurity(id, fields) {
    const user = this.users.find((u) => u.id === Number(id));
    for (const key of ['twofa_enabled', 'totp_enabled', 'totp_secret', 'backup_codes']) if (fields[key] !== undefined) user[key] = fields[key];
  }
  async createEmailCode({ userId, codeHash, expiresAt }) {
    this.codes = this.codes || [];
    this.codes.filter((c) => c.user_id === userId && c.used_at == null).forEach((c) => { c.used_at = Date.now(); });
    this.codes.push({ id: this.codes.length + 1, user_id: userId, code_hash: codeHash, expires_at: expiresAt, attempts: 0, used_at: null, created_at: Date.now() });
  }
  async activeEmailCode(userId) { const row = [...(this.codes || [])].reverse().find((c) => c.user_id === userId && c.used_at == null && c.expires_at > Date.now()); return row ? { ...row } : null; }
  async lastEmailCodeAt(userId) { const rows = (this.codes || []).filter((c) => c.user_id === userId); return rows.length ? Math.max(...rows.map((c) => c.created_at)) : null; }
  async addCodeAttempt(id) { const row = this.codes.find((c) => c.id === id); row.attempts += 1; }
  async useEmailCode(id) { const row = this.codes.find((c) => c.id === id); row.used_at = Date.now(); }
  async createTrustedDevice({ userId, tokenHash, expiresAt, userAgent }) { this.devices = this.devices || []; this.devices.push({ id: this.devices.length + 1, user_id: userId, token_hash: tokenHash, user_agent: userAgent, expires_at: expiresAt, created_at: Date.now() }); }
  async findTrustedDevice(tokenHash) { const row = (this.devices || []).find((d) => d.token_hash === tokenHash); return row ? { ...row } : null; }
  async touchTrustedDevice(id) { const row = this.devices.find((d) => d.id === id); if (row) row.last_used_at = Date.now(); }
  async deleteTrustedDevices(userId) { this.devices = (this.devices || []).filter((d) => d.user_id !== userId); }
  async countTrustedDevices(userId) { return (this.devices || []).filter((d) => d.user_id === userId && d.expires_at > Date.now()).length; }
  async touchLogin(id) { const user = this.users.find((u) => u.id === Number(id)); if (user) user.last_login_at = nowCancun(); }
  async transferLeadOwnership(leadId, ownerId) {
    const lead = this.records.leads.find((l) => l.id === Number(leadId)); if (lead) { lead.owner_id = ownerId; lead.updated_at = nowCancun(); }
    this.records.quotes.filter((q) => q.lead_id === Number(leadId)).forEach((q) => { q.owner_id = ownerId; });
    this.records.followups.filter((f) => f.lead_id === Number(leadId) && !f.done).forEach((f) => { f.owner_id = ownerId; });
  }
  async listActivity(filters = {}) {
    const users = new Map(this.users.map((u) => [u.id, u]));
    let rows = this.activity.map((row) => normalizeActivity({ ...row, user_name: users.get(row.user_id)?.name, user_email: users.get(row.user_id)?.email }));
    if (filters.userId) rows = rows.filter((r) => r.userId === Number(filters.userId));
    if (filters.type === 'crm') rows = rows.filter((r) => r.action.startsWith('crm_'));
    if (filters.type === 'security') rows = rows.filter((r) => !r.action.startsWith('crm_'));
    if (filters.entity) rows = rows.filter((r) => r.entity === filters.entity && (!filters.entityId || r.entityId === Number(filters.entityId)));
    if (filters.fromMs) rows = rows.filter((r) => r.createdMs >= filters.fromMs);
    if (filters.toMs) rows = rows.filter((r) => r.createdMs < filters.toMs);
    if (filters.beforeId) rows = rows.filter((r) => r.id < filters.beforeId);
    return rows.slice(0, Math.min(Math.max(Number(filters.limit) || 100, 1), 500));
  }
  async purgeActivity(days) {
    const limit = Date.now() - days * 86400000;
    const before = this.activity.length;
    this.activity = this.activity.filter((r) => r.created_ms >= limit);
    return before - this.activity.length;
  }

  async listRecords(entityName) { return [...this.records[entityName]].sort((a, b) => b.id - a.id).map((row) => normalizeRow(entityName, row)); }
  async getRecord(entityName, id) { const row = this.records[entityName].find((item) => item.id === Number(id)); return row ? normalizeRow(entityName, row) : null; }
  async createMedia({ ownerId, mime, data }) {
    this.media = this.media || [];
    this.media.push({ id: this.media.length + 1, owner_id: ownerId ?? null, mime, data: Buffer.from(data) });
    return this.media.length;
  }
  async getMedia(id) { const row = (this.media || []).find((m) => m.id === Number(id)); return row ? { mime: row.mime, data: row.data } : null; }
  async createBackup({ kind, userId, summary, xlsx, jsonGz, createdAt }) {
    this.backups = this.backups || [];
    this.backupSeq = (this.backupSeq || 0) + 1;
    this.backups.unshift({ id: this.backupSeq, kind, created_at: createdAt || nowCancun(), created_by: userId ?? null, summary, xlsx: Buffer.from(xlsx), json_gz: Buffer.from(jsonGz), email_status: null });
    return this.backupSeq;
  }
  async withLock(_name, fn) { return fn(); }
  async updateBackupStatus(id, status) { const b = (this.backups || []).find((x) => x.id === Number(id)); if (b) b.email_status = status; }
  async listBackups() {
    return (this.backups || []).map((b) => normalizeBackup({ ...b, summary: JSON.stringify(b.summary), xlsx_size: b.xlsx.length, json_size: b.json_gz.length, created_by_name: this.users.find((u) => u.id === b.created_by)?.name }));
  }
  async getBackupFile(id, type) { const b = (this.backups || []).find((x) => x.id === Number(id)); return b ? { createdAt: b.created_at, data: type === 'json' ? b.json_gz : b.xlsx } : null; }
  async lastBackupAt(kind) { const b = (this.backups || []).filter((x) => x.kind === kind); return b.length ? b.map((x) => x.created_at).sort().at(-1) : null; }
  async pruneBackups(keep) { const before = (this.backups || []).length; this.backups = (this.backups || []).slice(0, keep); return before - this.backups.length; }
  async updateProfile(id, fields) {
    const user = this.users.find((u) => u.id === Number(id));
    for (const key of [...Object.keys(PROFILE_FIELDS), 'photo_media_id']) if (fields[key] !== undefined) user[key] = fields[key];
  }

  async insertRecord(entityName, data, ownerId) {
    const spec = ENTITIES[entityName].fields;
    const now = nowCancun();
    const row = { id: ++this.sequence };
    for (const name of Object.keys(spec)) row[name] = data[name] ?? (spec[name].type === 'bool' ? false : null);
    Object.assign(row, { owner_id: ownerId ?? null, created_at: now, updated_at: now });
    this.assertReferences(entityName, row);
    this.records[entityName].push(row);
    return normalizeRow(entityName, row);
  }

  async updateRecord(entityName, id, data) {
    const row = this.records[entityName].find((item) => item.id === Number(id));
    if (!row) return null;
    const next = { ...row, ...data, updated_at: nowCancun() };
    this.assertReferences(entityName, next);
    Object.assign(row, next);
    return normalizeRow(entityName, row);
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

module.exports = { PROFILE_FIELDS, createDataStore, databaseConfigFromEnv, MySQLDataStore, MemoryDataStore, requiredProductionVariables, phoneKey };
