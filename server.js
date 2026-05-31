require('dotenv').config();
const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const { Server } = require('socket.io');
const { GoogleGenAI } = require('@google/genai');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');
const { verifyToken } = require('./middleware/auth');

const prisma = new PrismaClient();

// Initialize Gemini SDK
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use('/api/v1/payments/webhook', express.raw({type: 'application/json'}));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2022-11-15',
});

const AMBULANCE_RATES = {
  'BLS': { base: 500, perKm: 20 },
  'ICU': { base: 1000, perKm: 40 },
  'Neonatal': { base: 1200, perKm: 50 },
  'Dead Body': { base: 800, perKm: 30 }
};

// WebSockets Setup
const connectedUsers = new Map(); // userId -> socketId
const connectedDrivers = new Map(); // driverId -> socketId

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  
  socket.on('register', (data) => {
    // data: { type: 'user' | 'driver', id: number }
    const parsedId = parseInt(data.id);
    if (data.type === 'user') connectedUsers.set(parsedId, socket.id);
    else if (data.type === 'driver') connectedDrivers.set(parsedId, socket.id);
    console.log(`Registered ${data.type} ${parsedId} to socket ${socket.id}`);
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
    for (let [key, value] of connectedUsers.entries()) {
      if (value === socket.id) connectedUsers.delete(key);
    }
    for (let [key, value] of connectedDrivers.entries()) {
      if (value === socket.id) connectedDrivers.delete(key);
    }
  });

  // Relay driver location to user
  socket.on('driver_location_update', (data) => {
    // data: { booking_id, user_id, lat, lng }
    if (data.user_id) {
      const userSocket = connectedUsers.get(parseInt(data.user_id));
      if (userSocket) {
        io.to(userSocket).emit('driver_location_update', data);
      }
    }
  });

  // Relay booking status changes to user
  socket.on('booking_status_change', async (data) => {
    console.log("SERVER RECEIVED booking_status_change:", data);
    // data: { booking_id, status }
    try {
      const bookingId = parseInt(data.booking_id);
      
      // ALWAYS emit globally first to ensure UI updates instantly even if DB fails
      io.emit('booking_status_change', { booking_id: bookingId || data.booking_id, status: data.status });

      const booking = await prisma.booking.findUnique({ where: { id: bookingId }});
      if (booking) {
        await prisma.booking.update({
          where: { id: bookingId },
          data: { status: data.status }
        });
      }
    } catch (e) {
      console.error(e);
      // Fallback global emit if error occurs
      io.emit('booking_status_change', { booking_id: data.booking_id, status: data.status });
    }
  });
});


// Connect to SQLite DB
const dbPath = path.resolve(__dirname, 'mediresq.db');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Error opening database', err.message);
  } else {
    console.log('Connected to the SQLite database.');
  }
});

// GET /api/v1/hospitals/
app.get('/api/v1/hospitals/', (req, res) => {
  db.all("SELECT * FROM hospitals", [], (err, rows) => {
    if (err) {
      res.status(500).json({ detail: err.message });
      return;
    }
    // Parse JSON strings back to objects (for facilities)
    const processedRows = rows.map(row => {
      try { row.facilities = JSON.parse(row.facilities); } catch(e) {}
      return row;
    });
    res.json(processedRows);
  });
});

// POST /api/v1/auth/register (User & Driver)
app.post('/api/v1/auth/register', async (req, res) => {
  const { type, name, email, phone, password, emergency_contact, blood_group, medical_history, ambulance_type, vehicle_number, experience_years, languages_known } = req.body;
  try {
    const salt = await bcrypt.genSalt(10);
    const password_hash = await bcrypt.hash(password, salt);

    if (type === 'driver') {
      const driver = await prisma.driver.create({
        data: {
          name, phone, password_hash, ambulance_type: ambulance_type || 'BLS', vehicle_number, experience_years, languages_known, profile_image: req.body.profile_image || null
        }
      });
      const token = jwt.sign({ id: driver.id, role: 'driver' }, process.env.JWT_SECRET, { expiresIn: '7d' });
      return res.json({ profile: { id: driver.id, name, phone, profile_image: driver.profile_image }, token });
    } else {
      const generatedEmail = email || `${phone}@mediresq.local`;
      const user = await prisma.user.create({
        data: {
          name, email: generatedEmail, phone, password_hash, emergency_contact, blood_group, medical_history: medical_history ? JSON.stringify(medical_history) : null
        }
      });
      const token = jwt.sign({ id: user.id, role: 'user' }, process.env.JWT_SECRET, { expiresIn: '7d' });
      return res.json({ profile: { id: user.id, name, email: generatedEmail, phone, blood_group, emergency_contact, medical_history }, token });
    }
  } catch (err) {
    if (err.code === 'P2002') return res.status(400).json({ detail: "Email or phone already registered" });
    res.status(500).json({ detail: err.message });
  }
});

// POST /api/v1/auth/login (User & Driver)
app.post('/api/v1/auth/login', async (req, res) => {
  const { type, email, phone, password } = req.body;
  try {
    if (type === 'driver') {
      const driver = await prisma.driver.findUnique({ where: { phone } });
      if (!driver) return res.status(400).json({ detail: "Invalid phone or password" });
      const validPass = await bcrypt.compare(password, driver.password_hash);
      if (!validPass) return res.status(400).json({ detail: "Invalid phone or password" });

      const token = jwt.sign({ id: driver.id, role: 'driver' }, process.env.JWT_SECRET, { expiresIn: '7d' });
      delete driver.password_hash;
      return res.json({ profile: driver, token });
    } else {
      // Find by email or phone
      let user = null;
      if (email) user = await prisma.user.findUnique({ where: { email } });
      else if (phone) user = await prisma.user.findFirst({ where: { phone } });
      
      if (!user) return res.status(400).json({ detail: "Invalid email/phone or password" });
      const validPass = await bcrypt.compare(password, user.password_hash);
      if (!validPass) return res.status(400).json({ detail: "Invalid email/phone or password" });

      const token = jwt.sign({ id: user.id, role: 'user' }, process.env.JWT_SECRET, { expiresIn: '7d' });
      delete user.password_hash;
      try { user.medical_history = JSON.parse(user.medical_history); } catch(e) {}
      return res.json({ profile: user, token });
    }
  } catch (err) {
    res.status(500).json({ detail: err.message });
  }
});

// PUT /api/users/profile (Protected Route)
app.put('/api/users/profile', verifyToken, async (req, res) => {
  if (req.user.role !== 'user') return res.status(403).json({ detail: 'Access denied' });
  
  const { name, phone, emergency_contact, blood_group, medical_history } = req.body;
  try {
    const updatedUser = await prisma.user.update({
      where: { id: req.user.id },
      data: {
        name,
        phone,
        emergency_contact,
        blood_group,
        medical_history: medical_history ? JSON.stringify(medical_history) : undefined
      }
    });
    delete updatedUser.password_hash;
    try { updatedUser.medical_history = JSON.parse(updatedUser.medical_history); } catch(e) {}
    res.json(updatedUser);
  } catch (err) {
    res.status(500).json({ detail: err.message });
  }
});

// PUT /api/v1/drivers/profile (Protected Route)
app.put('/api/v1/drivers/profile', verifyToken, async (req, res) => {
  if (req.user.role !== 'driver') return res.status(403).json({ detail: 'Access denied' });
  
  const { name, phone, profile_image } = req.body;
  try {
    const updatedDriver = await prisma.driver.update({
      where: { id: req.user.id },
      data: {
        name,
        phone,
        profile_image
      }
    });
    delete updatedDriver.password_hash;
    res.json(updatedDriver);
  } catch (err) {
    res.status(500).json({ detail: err.message });
  }
});

// POST /api/v1/bookings
app.post('/api/v1/bookings', verifyToken, async (req, res) => {
  if (req.user.role !== 'user') return res.status(403).json({ detail: "Only users can request rides" });
  
  const { pickup_lat, pickup_lng, destination_hospital_id, hospital_lat: req_hospital_lat, hospital_lng: req_hospital_lng } = req.body;
  console.log("CREATE BOOKING REQ.BODY:", req.body);
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    let hospital_lat = req_hospital_lat || null;
    let hospital_lng = req_hospital_lng || null;
    
    const booking = await prisma.booking.create({
      data: {
        user_id: req.user.id,
        pickup_lat,
        pickup_lng,
        destination_hospital_id: destination_hospital_id ? String(destination_hospital_id) : null,
        status: 'PENDING'
      }
    });
    
    const payload = {
      booking_id: booking.id,
      user_id: req.user.id,
      user_name: user ? user.name : 'Patient',
      pickup_lat,
      pickup_lng,
      destination_hospital_id,
      hospital_lat,
      hospital_lng,
      hospital_name: req.body.hospital_name,
      ambulance_type: req.body.ambulance_type
    };
    
    // Broadcast to all registered drivers
    for (let [driverId, socketId] of connectedDrivers.entries()) {
      io.to(socketId).emit('new_emergency_request', payload);
    }
    
    res.json(booking);
  } catch (err) {
    res.status(500).json({ detail: err.message });
  }
});

// PUT /api/v1/bookings/:id/accept
app.put('/api/v1/bookings/:id/accept', verifyToken, async (req, res) => {
  if (req.user.role !== 'driver') return res.status(403).json({ detail: "Only drivers can accept rides" });

  try {
    const bookingId = parseInt(req.params.id);
    const booking = await prisma.booking.findUnique({ where: { id: bookingId }});
    if (!booking) return res.status(404).json({ detail: "Booking not found" });
    if (booking.status !== 'PENDING') return res.status(400).json({ detail: "Booking already accepted" });
    
    const updatedBooking = await prisma.booking.update({
      where: { id: bookingId },
      data: {
        driver_id: req.user.id,
        status: 'ACCEPTED'
      }
    });
    
    const driver = await prisma.driver.findUnique({ where: { id: req.user.id }});
    delete driver.password_hash;
    
    driver.avatarUrl = driver.profile_image;
    driver.rating = (4.5 + Math.random() * 0.5).toFixed(1);
    
    // Always emit globally so it's resilient to socket reconnects
    io.emit('ride_confirmed', {
      booking_id: updatedBooking.id,
      driver
    });
    
    res.json(updatedBooking);
  } catch (err) {
    res.status(500).json({ detail: err.message });
  }
});

// PUT /api/v1/bookings/:id/destination
app.put('/api/v1/bookings/:id/destination', verifyToken, async (req, res) => {
  try {
    const bookingId = parseInt(req.params.id);
    const { hospital_id, new_hospital } = req.body;
    
    const updatedBooking = await prisma.booking.update({
      where: { id: bookingId },
      data: { destination_hospital_id: String(hospital_id) }
    });
    
    // Broadcast to everyone (both driver and user apps) so they both update their map
    io.emit('destination_changed', {
      booking_id: bookingId,
      new_hospital
    });
    
    res.json(updatedBooking);
  } catch (err) {
    res.status(500).json({ detail: err.message });
  }
});

// Legacy SQLite POST /api/v1/users/ (Register)
app.post('/api/v1/users/', async (req, res) => {
  const { name, phone, password, emergency_contact, blood_group, medical_history } = req.body;
  try {
    const hashedPassword = password ? crypto.createHash('sha256').update(password).digest('hex') : null;
    const historyJson = medical_history ? JSON.stringify(medical_history) : '{}';
    
    db.run(
      `INSERT INTO users (name, phone, emergency_contact, blood_group, medical_history, password) VALUES (?, ?, ?, ?, ?, ?)`,
      [name, phone, emergency_contact, blood_group, historyJson, hashedPassword],
      function(err) {
        if (err) {
          if (err.message.includes('UNIQUE')) {
            return res.status(400).json({ detail: "Phone number already registered" });
          }
          return res.status(500).json({ detail: err.message });
        }
        res.json({
          profile: {
            id: this.lastID,
            name, phone, emergency_contact, blood_group, medical_history
          },
          token: "dummy-jwt-token"
        });
      }
    );
  } catch (err) {
    res.status(500).json({ detail: err.message });
  }
});

// POST /api/v1/users/login (Login)
app.post('/api/v1/users/login', (req, res) => {
  const { phone, password } = req.body;
  db.get("SELECT * FROM users WHERE phone = ?", [phone], async (err, user) => {
    if (err) return res.status(500).json({ detail: err.message });
    if (!user) return res.status(400).json({ detail: "Incorrect phone or password" });
    
    if (user.password) {
      const inputHash = crypto.createHash('sha256').update(password).digest('hex');
      if (inputHash !== user.password) {
        return res.status(400).json({ detail: "Incorrect phone or password" });
      }
    }
    
    try { user.medical_history = JSON.parse(user.medical_history); } catch(e) {}
    delete user.password;
    res.json({
      profile: user,
      token: "dummy-jwt-token"
    });
  });
});

// POST /api/v1/ai/chat
app.post('/api/v1/ai/chat', async (req, res) => {
  const { messages } = req.body; // messages is an array of { text, sender }
  console.log("Received AI Chat messages count:", messages?.length);
  
  if (!process.env.GEMINI_API_KEY) {
    return res.json({ 
      reply: "⚠️ Gemini API Key Missing! I cannot provide real AI chat. Please configure GEMINI_API_KEY." 
    });
  }

  try {
    // Build conversation history
    const conversation = messages.map(m => `${m.sender === 'user' ? 'User' : 'Assistant'}: ${m.text}`).join('\n');
    
    const prompt = `You are an expert AI First-Aid and Medical Assistant for the 'MediResQ' emergency response app.
You act like a friendly, empathetic human professional. Discuss the patient's problems and give possible solutions. 
If the user asks for first aid (like CPR, bleeding, choking), provide clear, numbered step-by-step instructions.
Keep your responses concise and conversational (under 3-4 sentences if possible, unless giving steps).
Always include a brief disclaimer at the end if you are giving medical advice that you are an AI.

Conversation so far:
${conversation}

Assistant:`;

    let response;
    let retries = 3;
    while (retries > 0) {
      try {
        response = await ai.models.generateContent({
          model: 'gemini-2.5-flash',
          contents: prompt,
        });
        break; // Success
      } catch (err) {
        if (err.status === 503 && retries > 1) {
          console.log("Gemini 503 error, retrying in 2 seconds...");
          retries--;
          await new Promise(resolve => setTimeout(resolve, 2000));
        } else {
          throw err;
        }
      }
    }

    res.json({ reply: response.text });
  } catch (error) {
    console.error("Gemini API Error:", error);
    res.status(500).json({ reply: "I'm having trouble connecting to my AI brain right now. Please call emergency services if you need immediate help." });
  }
});

// POST /api/v1/ai/analyze-symptoms
app.post('/api/v1/ai/analyze-symptoms', async (req, res) => {
  const { tags, details } = req.body;
  
  if (!process.env.GEMINI_API_KEY) {
    return res.json({ 
      reply: "⚠️ **Gemini API Key Missing!**\n\nTo use the real AI Symptom Checker, please add your `GEMINI_API_KEY` to the `.env` file in the backend directory and restart the Node server. You can get a free API key from [Google AI Studio](https://aistudio.google.com/)." 
    });
  }

  try {
    const prompt = `You are an expert AI medical assistant for the 'MediResQ' emergency response app. 
    A user has reported the following symptoms:
    Tags: ${tags ? tags.join(', ') : 'None'}
    Details: "${details || 'None provided'}"
    
    Please provide:
    1. A rough, concise overview of what might be happening.
    2. Recommended immediate precautions they should take.
    3. A clear medical disclaimer that you are an AI and this is not a diagnosis.
    
    Format your response in Markdown with bullet points.`;

    let response;
    let retries = 3;
    while (retries > 0) {
      try {
        response = await ai.models.generateContent({
          model: 'gemini-2.5-flash',
          contents: prompt,
        });
        break; // Success
      } catch (err) {
        if (err.status === 503 && retries > 1) {
          console.log("Gemini 503 error, retrying in 2 seconds...");
          retries--;
          await new Promise(resolve => setTimeout(resolve, 2000));
        } else {
          throw err;
        }
      }
    }
    
    res.json({ reply: response.text });
  } catch (error) {
    console.error("Gemini API Error:", error);
    res.status(500).json({ reply: "Sorry, I encountered an error while analyzing your symptoms. Please try again later." });
  }
});

// Legacy SQLite GET /api/v1/users/profile
app.get('/api/v1/users/profile', verifyToken, (req, res) => {
  db.get("SELECT * FROM users WHERE id = ?", [req.user.id], (err, user) => {
    if (err) return res.status(500).json({ detail: err.message });
    if (!user) return res.status(404).json({ detail: "User not found" });
    delete user.password_hash;
    try {
      if (user.medical_history) {
        user.medical_history = JSON.parse(user.medical_history);
      }
    } catch (e) {}
    res.json(user);
  });
});

// Legacy SQLite PUT /api/v1/users/profile (Update Profile)
app.put('/api/v1/users/profile', verifyToken, (req, res) => {
  const { name, phone, emergency_contact, blood_group, medical_history, profile_image } = req.body;
  
  const historyJson = medical_history ? JSON.stringify(medical_history) : null;

  db.run(
    `UPDATE users 
     SET name = COALESCE(?, name), 
         phone = COALESCE(?, phone),
         emergency_contact = COALESCE(?, emergency_contact), 
         blood_group = COALESCE(?, blood_group), 
         medical_history = COALESCE(?, medical_history),
         profile_image = COALESCE(?, profile_image)
     WHERE id = ?`,
    [name, phone, emergency_contact, blood_group, historyJson, profile_image, req.user.id],
    function(err) {
      if (err) return res.status(500).json({ detail: err.message });
      if (this.changes === 0) return res.status(404).json({ detail: "User not found" });
      
      // Fetch the updated user
      db.get("SELECT * FROM users WHERE id = ?", [req.user.id], (err, user) => {
        if (err || !user) return res.json({ success: true });
        delete user.password_hash;
        try { if (user.medical_history) user.medical_history = JSON.parse(user.medical_history); } catch(e) {}
        res.json(user);
      });
    }
  );
});

// GET /api/v1/hospitals/:hospital_id/doctors
app.get('/api/v1/hospitals/:hospital_id/doctors', async (req, res) => {
  try {
    const hospitalId = parseInt(req.params.hospital_id);
    const doctors = await prisma.doctor.findMany({
      where: { hospital_id: hospitalId },
      include: { hospital: true }
    });
    
    // Fallback if no real DB data
    if (doctors.length === 0) {
      return res.json([]);
    }
    
    // Clean up response objects
    const cleanedDoctors = doctors.map(doc => ({
      ...doc,
      hospital: doc.hospital ? doc.hospital.name : 'Unknown Hospital',
      fees: doc.consultation_fee,
      experience: doc.experience_years
    }));
    
    res.json(cleanedDoctors);
  } catch (err) {
    res.status(500).json({ detail: err.message });
  }
});

// GET /api/v1/doctors/top
app.get('/api/v1/doctors/top', async (req, res) => {
  try {
    // Get top doctors by rating and experience
    const topDoctors = await prisma.doctor.findMany({
      orderBy: [
        { rating: 'desc' },
        { experience_years: 'desc' }
      ],
      take: 10,
      include: { hospital: true }
    });
    
    const cleanedDoctors = topDoctors.map(doc => ({
      ...doc,
      hospital: doc.hospital ? doc.hospital.name : 'Unknown Hospital',
      fees: doc.consultation_fee,
      experience: doc.experience_years
    }));
    
    res.json(cleanedDoctors);
  } catch (err) {
    res.status(500).json({ detail: err.message });
  }
});

// Legacy SQLite Endpoints Disabled to avoid conflicting with Prisma
/*
// POST /api/v1/bookings
app.post('/api/v1/bookings', (req, res) => {
  const { user_id, hospital_id, ambulance_type, pickup_lat, pickup_lon } = req.body;
  
  // Find a driver with the requested ambulance type
  db.get(
    `SELECT d.id as driver_id 
     FROM drivers d 
     JOIN ambulances a ON d.ambulance_id = a.id 
     WHERE a.type = ? AND a.status = 'AVAILABLE' LIMIT 1`,
    [ambulance_type || 'BLS'],
    (err, row) => {
      if (err) return res.status(500).json({ detail: err.message });
      
      const driver_id = row ? row.driver_id : 1; // Fallback to driver 1 for mock purposes
      
      db.run(
        `INSERT INTO bookings (user_id, driver_id, hospital_id, status, pickup_lat, pickup_lon, timestamp) 
         VALUES (?, ?, ?, 'PENDING', ?, ?, CURRENT_TIMESTAMP)`,
        [user_id || 1, driver_id, hospital_id, pickup_lat, pickup_lon],
        function(err) {
          if (err) return res.status(500).json({ detail: err.message });
          res.json({ booking_id: this.lastID, driver_id, status: 'PENDING' });
        }
      );
    }
  );
});

// PUT /api/v1/bookings/:booking_id/destination
app.put('/api/v1/bookings/:booking_id/destination', (req, res) => {
  const bookingId = req.params.booking_id;
  const { hospital_id, new_hospital } = req.body;
  
  db.run(
    `UPDATE bookings SET hospital_id = ? WHERE id = ?`,
    [hospital_id, bookingId],
    function(err) {
      if (err) return res.status(500).json({ detail: err.message });
      
      if (new_hospital) {
        // Broadcast the provided dynamic OSM hospital directly
        io.emit('destination_changed', { booking_id: bookingId, new_hospital: new_hospital });
        res.json({ success: true, booking_id: bookingId, hospital_id, new_hospital });
      } else {
        // Fallback: Fetch the updated hospital details from DB
        db.get(`SELECT * FROM hospitals WHERE id = ?`, [hospital_id], (err, hospital) => {
          if (!err && hospital) {
            try { hospital.facilities = JSON.parse(hospital.facilities); } catch(e) {}
            // Emit websocket event
            io.emit('destination_changed', { booking_id: bookingId, new_hospital: hospital });
          }
          res.json({ success: true, booking_id: bookingId, hospital_id });
        });
      }
    }
  );
});
*/

// GET /api/v1/drivers/:id
app.get('/api/v1/drivers/:id', async (req, res) => {
  try {
    const driverId = parseInt(req.params.id);
    const driver = await prisma.driver.findUnique({
      where: { id: driverId }
    });
    
    if (!driver) return res.status(404).json({ detail: "Driver not found" });
    
    // Fallbacks to match legacy API expectations in frontend
    try { driver.languages_known = JSON.parse(driver.languages_known); } catch(e) {}
    
    res.json({
      ...driver,
      vehicle_no: driver.vehicle_number,
      ambulance_type: driver.ambulance_type
    });
  } catch (err) {
    res.status(500).json({ detail: err.message });
  }
});

// ==========================================
// STRIPE PAYMENTS (PHASE 3)
// ==========================================

// POST /api/v1/payments/create-payment-intent
app.post('/api/v1/payments/create-payment-intent', verifyToken, async (req, res) => {
  try {
    const { booking_id, distance_km, ambulance_type } = req.body;
    
    // 1. Calculate fare securely on server
    const rates = AMBULANCE_RATES[ambulance_type] || AMBULANCE_RATES['BLS'];
    const totalAmountINR = rates.base + Math.round((distance_km || 0) * rates.perKm);
    const amountPaise = totalAmountINR * 100; // Stripe expects smallest currency unit (paise)

    // 2. Create PaymentIntent
    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountPaise,
      currency: 'inr',
      payment_method_types: ['card', 'upi'],
      metadata: {
        booking_id: String(booking_id),
        user_id: String(req.user.id)
      }
    });

    // Optionally update booking with the fare and payment intent ID
    if (booking_id) {
      await prisma.booking.update({
        where: { id: parseInt(booking_id) },
        data: { 
          fare: totalAmountINR,
          stripe_payment_intent_id: paymentIntent.id
        }
      });
    }

    // 3. Return clientSecret
    res.json({ clientSecret: paymentIntent.client_secret, amount: totalAmountINR });
  } catch (error) {
    console.error('Stripe Payment Intent Error:', error);
    res.status(500).json({ detail: error.message });
  }
});

// POST /api/v1/payments/webhook
app.post('/api/v1/payments/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;
  try {
    // req.body is a raw buffer because of express.raw() middleware
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
  } catch (err) {
    console.error(`Webhook signature verification failed: ${err.message}`);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Handle successful payment
  if (event.type === 'payment_intent.succeeded') {
    const paymentIntent = event.data.object;
    const bookingId = paymentIntent.metadata.booking_id;
    
    if (bookingId) {
      try {
        await prisma.booking.update({
          where: { id: parseInt(bookingId) },
          data: { payment_status: 'PAID' }
        });
        console.log(`Payment confirmed for Booking #${bookingId}`);
        // Optionally emit a socket event to the user/driver that payment is complete
        io.emit('payment_success', { booking_id: bookingId });
      } catch (err) {
        console.error("Error updating booking payment status:", err);
      }
    }
  }

  res.json({received: true});
});

const PORT = process.env.PORT || 8000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on http://0.0.0.0:${PORT}`);
});
