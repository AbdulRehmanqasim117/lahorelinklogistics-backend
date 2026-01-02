const requireRole = (...roles) => {
  return (req, res, next) => {
    console.log('DEBUG requireRole check:', { userRole: req.user?.role, allowedRoles: roles, hasRole: req.user && roles.includes(req.user.role) });
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ 
        message: 'Forbidden. You do not have permission to access this resource.' 
      });
    }
    next();
  };
};

module.exports = requireRole;