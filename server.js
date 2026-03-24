const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const sqlite3 = require('sqlite3').verbose(); // Переходим на SQLite
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Настройки пути
app.use(express.static(path.join(__dirname, 'public')));

// Инициализация базы данных SQLite
const db = new sqlite3.Database('./pixels.db', (err) => {
    if (err) console.error('Ошибка БД:', err.message);
    console.log('Подключено к базе данных SQLite.');
});

// Создаем таблицу, если её нет
db.run(`CREATE TABLE IF NOT EXISTS pixels (
    pos_key TEXT PRIMARY KEY,
    color TEXT
)`);

let onlineUsers = 0;

io.on('connection', (socket) => {
    onlineUsers++;
    io.emit('userCount', onlineUsers);

    // При входе игрока выгружаем ВСЕ закрашенные пиксели из базы
    db.all("SELECT pos_key, color FROM pixels", [], (err, rows) => {
        if (err) return console.error(err.message);
        // Превращаем массив строк обратно в формат [ [key, color], ... ]
        const boardData = rows.map(row => [row.pos_key, row.color]);
        socket.emit('initBoard', boardData);
    });

    // Когда кто-то рисует
    socket.on('drawPixel', (data) => {
        const key = `${data.x},${data.y}`;
        
        // Сохраняем/обновляем в базе данных
        db.run(`INSERT INTO pixels(pos_key, color) VALUES(?, ?)
                ON CONFLICT(pos_key) DO UPDATE SET color=excluded.color`, 
                [key, data.color]);

        // Рассылаем всем остальным
        socket.broadcast.emit('updatePixel', data);
    });

    socket.on('disconnect', () => {
        onlineUsers--;
        io.emit('userCount', onlineUsers);
    });
});

// ПОРТ: Очень важно для Amvera и других хостингов
const PORT = process.env.PORT || 80; 
server.listen(PORT, () => {
    console.log(`Сервер запущен на порту ${PORT}`);
});