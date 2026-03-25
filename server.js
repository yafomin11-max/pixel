const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Client } = require('pg');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// --- НАСТРОЙКА БАЗЫ ДАННЫХ ---
const client = new Client({
    connectionString: process.env.DATABASE_URL, // Render сам подставит эту переменную
    ssl: { rejectUnauthorized: false }
});

client.connect()
    .then(() => console.log('✅ Успешное подключение к Postgres'))
    .catch(err => console.error('❌ Ошибка подключения к БД:', err.stack));

// Создаем таблицу, если её нет
client.query(`
    CREATE TABLE IF NOT EXISTS pixels (
        pos_key TEXT PRIMARY KEY,
        color TEXT NOT NULL
    )
`).catch(err => console.error('Ошибка создания таблицы:', err));

app.use(express.static('public'));

let userCount = 0;

io.on('connection', async (socket) => {
    userCount++;
    io.emit('userCount', userCount);

    // 1. Отправляем все пиксели при входе
    try {
        const res = await client.query('SELECT pos_key, color FROM pixels');
        const board = res.rows.map(row => [row.pos_key, row.color]);
        socket.emit('initBoard', board);
    } catch (err) {
        console.error('Ошибка загрузки доски:', err);
    }

    // 2. Обработка рисования (с проверкой АДМИНА)
    socket.on('drawPixel', async (data) => {
        const { x, y, color, adminKey } = data;
        
        // Валидация координат
        if (x < 0 || x >= 1000 || y < 0 || y >= 1000) return;

        // --- ПРОВЕРКА АДМИНА ---
        const isAdmin = adminKey === 'supertop'; // Твой секретный пароль
        const cooldown = isAdmin ? 0 : 3000; 

        const now = Date.now();
        const lastDraw = socket.lastDrawTime || 0;

        // Если не админ и время не вышло — игнорируем
        if (!isAdmin && (now - lastDraw < cooldown)) return;

        socket.lastDrawTime = now;

        // Сохраняем в базу данных
        const key = `${x},${y}`;
        try {
            await client.query(`
                INSERT INTO pixels (pos_key, color) 
                VALUES ($1, $2) 
                ON CONFLICT (pos_key) 
                DO UPDATE SET color = $2
            `, [key, color]);
            
            // Рассылаем всем остальным
            socket.broadcast.emit('updatePixel', { x, y, color });
        } catch (err) {
            console.error('Ошибка сохранения пикселя:', err);
        }
    });

    // 3. Обработка сообщений ЧАТА
    socket.on('sendMessage', (data) => {
        if (!data.text || data.text.trim() === '') return;
        
        // Ограничиваем длину сообщения и чистим от пробелов
        const cleanText = data.text.trim().substring(0, 100);
        
        // Рассылаем всем (включая отправителя)
        io.emit('receiveMessage', {
            id: socket.id,
            text: cleanText
        });
    });

    socket.on('disconnect', () => {
        userCount--;
        io.emit('userCount', userCount);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Сервер запущен на порту ${PORT}`);
});
