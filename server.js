const app = require('./src/app');
const http = require('http');

const basePort = parseInt(process.env.PORT || '5000', 10);

const startServer = (port, attemptsLeft = 5) => {
  const server = http.createServer(app);
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && attemptsLeft > 0) {
      const next = port + 1;
      console.warn(`Port ${port} in use, trying ${next}...`);
      startServer(next, attemptsLeft - 1);
    } else {
      console.error('Server error:', err.message);
    }
  });
  server.listen(port, () => {
    console.log(`Server running on port ${port}`);
  });
};

startServer(basePort);
