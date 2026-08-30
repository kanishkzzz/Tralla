import { db, initSchema, close } from '../lib/db.js';

initSchema();

const tables = db
  .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
  .all();

for (const { name } of tables) {
  const { n } = db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get();
  console.log(`${name.padEnd(14)} ${n}`);
}

close();
