const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Client } = require('pg');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

client.connect()
    .then(() => console.log('Подключено к БД'))
    .catch(err => console.error('Ошибка БД:', err));

// Таблица для поля 1000x1000
client.query(`CREATE TABLE IF NOT EXISTS pixels (
    pos_key TEXT PRIMARY KEY,
    color TEXT
)`);

let onlineUsers = 0;

io.on('connection', async (socket) => {
    onlineUsers++;
    io.emit('userCount', onlineUsers);

    try {
        const res = await client.query("SELECT pos_key, color FROM pixels");
        socket.emit('initBoard', res.rows.map(row => [row.pos_key, row.color]));
    } catch (err) { console.error(err); }

    socket.on('drawPixel', (data) => {
        // Проверка границ 1000x1000
        if (data.x < 0 || data.x >= 1000 || data.y < 0 || data.y >= 1000) return;

        const key = `${data.x},${data.y}`;
        client.query(`INSERT INTO pixels(pos_key, color) 
                      VALUES($1, $2) 
                      ON CONFLICT(pos_key) DO UPDATE SET color = $2`, [key, data.color]);
        socket.broadcast.emit('updatePixel', data);
    });

    socket.on('disconnect', () => {
        onlineUsers--;
        io.emit('userCount', onlineUsers);
    });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log(`Сервер 1000x1000 запущен!`));
