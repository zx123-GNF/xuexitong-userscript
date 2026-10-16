// 极简静态服务器，只为本地无头回归测试服务（不对外，仅监听 127.0.0.1）
const http = require('http');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const PORT = Number(process.env.TEST_PORT || 8731);
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8'
};

const server = http.createServer((req, res) => {
  let p = decodeURIComponent((req.url || '/').split('?')[0]);
  if (p === '/') p = '/test/fixture.html';
  const file = path.resolve(root, '.' + p);
  if (!file.startsWith(root)) { res.writeHead(403); res.end('403'); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('404 ' + p); return; }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store'
    });
    res.end(buf);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('LISTENING http://127.0.0.1:' + PORT + '/test/fixture.html');
});
