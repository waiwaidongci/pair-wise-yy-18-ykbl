'use strict';

// 归档底座：sql.js（WASM SQLite），数据库文件持久化到 data/app.db。
// 原实现依赖系统 sqlite3 CLI，当前环境无该二进制且无安装权限，
// 这里以进程内 SQLite 引擎保持同样的表结构与持久化语义。
const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'app.db');

let db = null;
let depth = 0;

async function init() {
  const SQL = await initSqlJs({
    locateFile: (file) => path.join(__dirname, '..', 'node_modules', 'sql.js', 'dist', file)
  });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  db = fs.existsSync(DB_FILE)
    ? new SQL.Database(fs.readFileSync(DB_FILE))
    : new SQL.Database();
}

function flush() {
  if (depth > 0) return; // 事务内不写盘，提交时一次性落盘
  fs.writeFileSync(DB_FILE, Buffer.from(db.export()));
}

function run(sql, params) {
  db.run(sql, params || []);
  flush();
}

function all(sql, params) {
  const stmt = db.prepare(sql);
  stmt.bind(params || []);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function get(sql, params) {
  return all(sql, params)[0] || null;
}

function transaction(fn) {
  if (depth > 0) return fn();
  db.run('BEGIN');
  depth += 1;
  try {
    const result = fn();
    depth -= 1;
    db.run('COMMIT');
    flush();
    return result;
  } catch (error) {
    depth -= 1;
    db.run('ROLLBACK');
    throw error;
  }
}

module.exports = { init, run, all, get, transaction, DB_FILE };
