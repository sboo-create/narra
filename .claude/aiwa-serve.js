// Мини-сервер для просмотра мини-аппа AIWA в панели превью (без Telegram — демо-режим).
const http = require('http'), fs = require('fs'), path = require('path');
const ROOT = '/Users/aleksandr/Documents/Claude/Projects/AIWA Vision / Wellness/AIWA_bot';
const MIME = { '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.ttf': 'font/ttf', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/aiwa_webapp.html';
  const f = path.normalize(path.join(ROOT, p));
  if (!f.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
  fs.readFile(f, (e, d) => {
    if (e) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
    res.end(d);
  });
}).listen(8901, () => console.log('AIWA webapp on http://localhost:8901'));
