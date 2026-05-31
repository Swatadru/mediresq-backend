const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('mediresq.db');
db.all("SELECT name, sql FROM sqlite_master WHERE type='table'", [], (err, rows) => {
  if (err) console.error(err);
  else console.log(rows);
});
