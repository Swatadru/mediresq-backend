const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const dbPath = path.resolve(__dirname, 'mediresq.db');
const db = new sqlite3.Database(dbPath);

db.serialize(() => {
  db.run("ALTER TABLE drivers ADD COLUMN experience_years INTEGER", (err) => {
    if (err) {
      console.log("experience_years might already exist:", err.message);
    } else {
      console.log("Added experience_years to drivers");
    }
  });

  db.run("ALTER TABLE drivers ADD COLUMN languages_known JSON", (err) => {
    if (err) {
      console.log("languages_known might already exist:", err.message);
    } else {
      console.log("Added languages_known to drivers");
      // Update seed data for existing drivers
      db.run("UPDATE drivers SET experience_years = 5, languages_known = '[\"English\", \"Hindi\", \"Bengali\"]' WHERE id = 1");
      db.run("UPDATE drivers SET experience_years = 8, languages_known = '[\"English\", \"Marathi\"]' WHERE id = 2");
    }
  });
});
