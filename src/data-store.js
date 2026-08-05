'use strict';

const bcrypt = require('bcryptjs');
const mysql = require('mysql2/promise');

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
    this.pool = mysql.createPool({ ...databaseConfigFromEnv(env), waitForConnections: true, connectionLimit: 5, queueLimit: 0 });
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
    await this.bootstrapUser(this.env.ADMIN_EMAIL, 'Administrador', 'admin', this.env.ADMIN_INITIAL_PASSWORD);
    await this.bootstrapUser(this.env.PARTNER_EMAIL, 'Paulina', 'travel_partner', this.env.PARTNER_INITIAL_PASSWORD);
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
}

function createDataStore(env) {
  if (env.NODE_ENV === 'production') {
    const missing = requiredProductionVariables(env);
    if (missing.length) throw new Error(`Faltan variables de entorno requeridas: ${missing.join(', ')}`);
    return new MySQLDataStore(env);
  }
  return new MemoryDataStore(env);
}

module.exports = { createDataStore, databaseConfigFromEnv, MySQLDataStore, MemoryDataStore, requiredProductionVariables };
