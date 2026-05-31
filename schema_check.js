const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('mediresq.db');
db.all("SELECT sql FROM sqlite_master WHERE type='table' AND name IN ('doctors', 'hospitals', 'users')", [], (err, rows) => {
  if (err) console.error(err);
  else console.log(rows);
});
