import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const server = http.createServer((req: http.IncomingMessage, res: http.ServerResponse) => {
    let filePath;

    if (req.url?.startsWith('/dist/')) {
        // dist/ディレクトリのJavaScriptファイルを配信
        filePath = path.join(__dirname, req.url);
    } else {
        // public/ディレクトリのファイルを配信
        filePath = path.join(__dirname, 'public', req.url === '/' ? 'index.html' : req.url || '');
    }

    const extname = path.extname(filePath);
    let contentType = 'text/html';

    switch (extname) {
        case '.js':
            contentType = 'text/javascript';
            break;
        case '.ts':
            contentType = 'text/typescript';
            break;
        case '.css':
            contentType = 'text/css';
            break;
        case '.json':
            contentType = 'application/json';
            break;
    }

    fs.readFile(filePath, (error: any, content: Buffer) => {
        if (error) {
            if (error.code == 'ENOENT') {
                res.writeHead(404);
                res.end('File not found');
            } else {
                res.writeHead(500);
                res.end('Server error');
            }
        } else {
            res.writeHead(200, { 'Content-Type': contentType });
            res.end(content, 'utf-8');
        }
    });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
    console.log(`HTTPサーバー起動: http://localhost:${PORT}`);
});