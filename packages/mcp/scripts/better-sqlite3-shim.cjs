// CommonJS `better-sqlite3` stand-in built on Node's own `node:sqlite`.
//
// Development-sandbox scaffolding for `scripts/smoke.mjs`: better-sqlite3 needs
// a C++ toolchain to build its native addon, which this sandbox has none of, but
// the HTTP protocol, tool handlers and SQL still deserve a real end-to-end run.
// `node:sqlite` speaks the same SQLite and exposes an overlapping API, so an
// adapter is enough. Installed into node_modules/better-sqlite3 by hand (see
// docs/16-mcp-server.md) and never loaded by the product — `dist/*.js` requires
// the real package on a normal machine.

const { DatabaseSync } = require("node:sqlite");

function toSqlite(value) {
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value === undefined || value === null) return null;
  return value;
}

class Statement {
  constructor(stmt) {
    this.stmt = stmt;
    // node:sqlite wants the bare `name` rather than `@name`; the SQL this
    // project writes uses `@name`, so line the prefixes up once here.
    try {
      stmt.setAllowBareNamedParameters(true);
    } catch {
      // Older runtimes: fall back to positional binding below.
    }
    this.names = namedParameters(stmt.sourceSQL ?? "");
  }

  /** better-sqlite3 takes either positional values or one named-params object. */
  bind(args) {
    const first = args[0];
    const single = args.length === 1 && typeof first === "object" && first !== null && !Array.isArray(first);
    if (!single) return args.map(toSqlite);
    if (this.names.length > 0) return [first];
    // Named lookups failed (no sourceSQL on this runtime) — bind positionally in
    // property order, which is how this project's callers build the object.
    return Object.values(first).map(toSqlite);
  }

  all(...args) {
    return this.stmt.all(...this.bind(args));
  }

  get(...args) {
    return this.stmt.get(...this.bind(args));
  }

  run(...args) {
    const info = this.stmt.run(...this.bind(args));
    return { changes: Number(info.changes), lastInsertRowid: info.lastInsertRowid };
  }

  iterate(...args) {
    return this.stmt.iterate(...this.bind(args));
  }
}

/** `@name` / `:name` tokens in declaration order. */
function namedParameters(sql) {
  const names = [];
  for (const match of String(sql).matchAll(/[@$:]([A-Za-z_][A-Za-z0-9_]*)/g)) {
    const name = match[1];
    if (name !== undefined && !names.includes(name)) names.push(name);
  }
  return names;
}

class Database {
  constructor(filename, options = {}) {
    this.db = new DatabaseSync(filename, options);
  }

  prepare(sql) {
    return new Statement(this.db.prepare(sql));
  }

  exec(sql) {
    this.db.exec(sql);
    return this;
  }

  pragma(source) {
    this.db.exec(`PRAGMA ${source}`);
    return this;
  }

  transaction(fn) {
    return (...args) => {
      this.db.exec("BEGIN");
      try {
        const result = fn(...args);
        this.db.exec("COMMIT");
        return result;
      } catch (err) {
        this.db.exec("ROLLBACK");
        throw err;
      }
    };
  }

  close() {
    this.db.close();
  }

  get open() {
    return this.db.isOpen;
  }
}

module.exports = Database;
module.exports.default = Database;
module.exports.Database = Database;
