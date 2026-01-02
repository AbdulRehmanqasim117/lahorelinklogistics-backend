const jwt = require('jsonwebtoken');

const auth = (req, res, next) => {
  try {
    // Try to get token from Authorization header first, then from cookie
    let token;
    const authHeader = req.header('Authorization');
    
    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.replace('Bearer ', '');
    } else if (req.cookies && req.cookies.token) {
      token = req.cookies.token;
    }
    
    if (!token) {
      return res.status(401).json({ message: 'Unauthorized access. Token missing.' });
    }
    
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    console.log('DEBUG AUTH decoded JWT:', decoded);
    req.user = decoded;
    next();
  } catch (error) {
    console.error('Auth error:', error);
    // Clear invalid token cookie if present
    if (req.cookies && req.cookies.token) {
      res.clearCookie('token');
    }
    res.status(401).json({ message: 'Unauthorized. Invalid or expired token.' });
  }
};

module.exports = auth;