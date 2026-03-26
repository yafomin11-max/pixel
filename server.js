const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);

app.use(express.static(__dirname));

let board = {}; 
let onlineCount = 0;

io.on('connection', (socket) => {
    onlineCount++;
    io.emit('userCount', onlineCount);
    socket.emit('initBoard', board);

    socket.on('drawPixel', (data) => {
        const { x, y, color } = data;
        // ТЕПЕРЬ ПРОВЕРКА ДО 2000
        if (x >= 0 && x < 2000 && y >= 0 && y < 2000) {
            board[`${x},${y}`] = color;
            io.emit('updatePixel', { x, y, color });
        }
    });

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
http.listen(PORT, () => console.log(`Сервер: http://localhost:${PORT}`));
