const app = require('./src/app');
const http = require('http');

// Hostinger automatically PORT provide karta hai, agar na mile to 5000 use karega
const port = process.env.PORT || 5000;

const server = http.createServer(app);

server.listen(port, () => {
  console.log(`Server is running successfully on port ${port}`);
});