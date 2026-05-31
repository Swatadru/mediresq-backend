const jwt = require('jsonwebtoken');

const verifyToken = (req, res, next) => {
  const token = req.header('Authorization');
  if (!token) return res.status(401).json({ detail: 'Access Denied. No token provided.' });

  try {
    // Expected format: "Bearer <token>"
    const tokenString = token.startsWith('Bearer ') ? token.slice(7, token.length) : token;
    const verified = jwt.verify(tokenString, process.env.JWT_SECRET);
    req.user = verified;
    next();
  } catch (err) {
    res.status(400).json({ detail: 'Invalid Token' });
  }
};

module.exports = { verifyToken };
