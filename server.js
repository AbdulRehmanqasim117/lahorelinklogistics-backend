const app = require('./src/app');

const PORT = process.env.PORT || 3000;

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
// Global process-level error handlers so that unexpected errors don't crash
// the process without at least being logged in a structured way.
process.on('unhandledRejection', (reason, promise) => {
  console.error(
    JSON.stringify({
      level: 'error',
      type: 'unhandledRejection',
      message: reason && reason.message ? reason.message : String(reason),
      stack: reason && reason.stack ? reason.stack : undefined,
    })
  );
});

process.on('uncaughtException', (error) => {
  console.error(
    JSON.stringify({
      level: 'error',
      type: 'uncaughtException',
      message: error.message,
      stack: error.stack,
    })
  );
});

server.on('error', (err) => {
  console.error(
    JSON.stringify({
      level: 'error',
      type: 'serverError',
      message: err.message,
      code: err.code,
      stack: err.stack,
    })
  );
});
