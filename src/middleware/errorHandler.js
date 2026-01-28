const NODE_ENV = process.env.NODE_ENV || 'development';

const errorHandler = (err, req, res, next) => {
  const statusCode = res.statusCode === 200 ? 500 : res.statusCode;

  console.error(
    JSON.stringify({
      level: 'error',
      type: 'requestError',
      message: err.message || 'Server Error',
      stack: NODE_ENV === 'production' ? undefined : err.stack,
      statusCode,
      method: req.method,
      path: req.originalUrl || req.url,
    })
  );

  res.status(statusCode).json({
    message: err.message || 'Server Error',
    ...(NODE_ENV === 'production' ? {} : { stack: err.stack }),
  });
};

module.exports = errorHandler;