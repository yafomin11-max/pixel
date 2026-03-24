const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Client } = require('pg');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Раздаем статические файлы из папки public
app.use(express.static('public'));

// Настройка подключения к PostgreSQL
const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { 
        rejectUnauthorized: false // ОБЯЗАТЕЛЬНО для Render
    }
});

// Подключаемся к базе данных
client.connect()
    .then(async () => {
        console.log('✅ УСПЕХ: Подключено к базе данных PostgreSQL!');
        
        // Создаем таблицу для пикселей, если её еще нет
        try {
            await client.query(`
                CREATE TABLE IF NOT EXISTS pixels (
                    pos_key TEXT PRIMARY KEY,
                    color TEXT
                )
            `);
            console.log('--- Таблица pixels проверена и готова к работе ---');
        } catch (err) {
            console.error('❌ Ошибка при создании таблицы:', err.message);
        }
    })
    .catch(err => {
        console.error('❌ КРИТИЧЕСКАЯ ОШИБКА ПОДКЛЮЧЕНИЯ К БД:', err.message);
        console.log('Проверь переменную DATABASE_URL в настройках Environment на Render!');
    });

let onlineUsers = 0;

io.on('connection', async (socket) => {
    onlineUsers++;
    io.emit('userCount', onlineUsers);
    console.log(`Новое подключение. Игроков онлайн: ${onlineUsers}`);

    // При входе отправляем игроку все сохраненные пиксели из базы
    try {
        const res = await client.query("SELECT pos_key, color FROM pixels");
        const boardData = res.rows.map(row => [row.pos_key, row.color]);
        socket.emit('initBoard', boardData);
    } catch (err) {
        console.error('Ошибка при загрузке холста:', err.message);
    }

    // Когда игрок ставит пиксель
    socket.on('drawPixel', async (data) => {
        // Проверка границ 1000x1000
        if (data.x < 0 || data.x >= 1000 || data.y < 0 || data.y >= 1000) return;

        const key = `${data.x},${data.y}`;
        
        try {
            // Сохраняем или обновляем пиксель в базе данных
            await client.query(`
                INSERT INTO pixels(pos_key, color) 
                VALUES($1, $2) 
                ON CONFLICT(pos_key) DO UPDATE SET color = $2
            `, [key, data.color]);

            // Рассылаем всем остальным игрокам обновленный пиксель
            socket.broadcast.emit('updatePixel', data);
        } catch (err) {
            console.error('Ошибка при сохранении пикселя:', err.message);
        }
    });

    socket.on('disconnect', () => {
        onlineUsers--;
        io.emit('userCount', onlineUsers);
        console.log(`Игрок ушел. Осталось: ${onlineUsers}`);
    });
});

// Запуск сервера на порту 10000 (стандарт Render)
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
    console.log(`🚀 СЕРВЕР ЗАПУЩЕН НА ПОРТУ ${PORT}`);
    console.log(`Размер поля: 1000x1000`);
});
