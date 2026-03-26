const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);

app.use(express.static(__dirname));

// Хранилище доски: ключ "x,y", значение "color"
let board = {}; 
let onlineCount = 0;

io.on('connection', (socket) => {
    onlineCount++;
    io.emit('userCount', onlineCount);

    // Отправляем текущее состояние доски новому игроку
    socket.emit('initBoard', Object.entries(board));

    // Одиночный пиксель
    socket.on('drawPixel', (data) => {
        const { x, y, color } = data;
        if (x >= 0 && x < 1000 && y >= 0 && y < 1000) {
            board[`${x},${y}`] = color;
            io.emit('updatePixel', { x, y, color });
        }
    });

    // ЦЕЛАЯ ФИГУРА (Линия, Квадрат, Круг)
    socket.on('drawShape', (data) => {
        const { pixels, color } = data;
        if (Array.isArray(pixels)) {
            pixels.forEach(p => {
                if (p.x >= 0 && p.x < 1000 && p.y >= 0 && p.y < 1000) {
                    board[`${p.x},${p.y}`] = color;
                }
            });
            // Рассылаем всем готовую фигуру
            io.emit('updateShape', { pixels, color });
        }
    });

    // Чат
    socket.on('sendMessage', (data) => {
        if (data.text) {
            io.emit('receiveMessage', {
                id: socket.id,
                text: data.text.substring(0, 100)
            });
        }
    });

    socket.on('disconnect', () => {
        onlineCount--;
        io.emit('userCount', onlineCount);
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`Сервер запущен на порту ${PORT}`);
});
