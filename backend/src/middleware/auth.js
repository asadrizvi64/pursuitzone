import jwt from 'jsonwebtoken';

export const authMiddleware = {
  async verifyToken(token, db) {
    if (!token) throw new Error('No token provided');
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const { rows: [user] } = await db.query('SELECT * FROM users WHERE id = $1 AND is_banned = FALSE', [decoded.userId]);
    if (!user) throw new Error('User not found or banned');
    return user;
  },

  protect: async (req, res, next) => {
    try {
      const token = req.headers.authorization?.replace('Bearer ', '');
      if (!token) return res.status(401).json({ error: 'Authentication required' });
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const { rows: [user] } = await req.app.locals.db.query(
        'SELECT * FROM users WHERE id = $1 AND is_banned = FALSE', [decoded.userId]
      );
      if (!user) return res.status(401).json({ error: 'User not found' });
      req.user = user;
      next();
    } catch (err) {
      res.status(401).json({ error: 'Invalid token' });
    }
  },
};
