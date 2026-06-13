const http = require('http');
const req = http.request({ host: 'localhost', port: 4000, path: '/auth/discord', method: 'GET' }, res => {
  console.log('statusCode=', res.statusCode);
  console.log('location=', res.headers.location);
  res.resume();
});
req.on('error', err => {
  console.error('ERROR', err.message);
});
req.end();
