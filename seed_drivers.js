const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const dbPath = path.resolve(__dirname, 'mediresq.db');
const db = new sqlite3.Database(dbPath);

db.serialize(() => {
  // Clear tables
  db.run(`DELETE FROM drivers`);
  db.run(`DELETE FROM ambulances`);

  // Insert Ambulances
  db.run(`INSERT INTO ambulances (id, vehicle_no, type, status) VALUES 
    (1, 'MH 12 AB 1234', 'BLS', 'AVAILABLE'),
    (2, 'MH 12 CD 5678', 'ICU', 'AVAILABLE'),
    (3, 'MH 14 EF 9012', 'Dead Body', 'AVAILABLE')
  `);

  // Insert Drivers
  db.run(`INSERT INTO drivers (id, name, phone, ambulance_id, rating, experience_years, languages_known) VALUES 
    (1, 'Michael Johnson', '9876543210', 1, 4.8, 5, '["English", "Hindi", "Marathi"]'),
    (2, 'Ananya Saha', '9876543211', 2, 4.9, 8, '["English", "Bengali", "Hindi"]'),
    (3, 'Rajesh Kumar', '9876543212', 3, 4.5, 3, '["Hindi", "Marathi"]')
  `);
  
  console.log("Seed data for drivers and ambulances inserted.");
});
db.close();
