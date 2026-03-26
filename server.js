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

// Создаем таблицу пикселей, если её нет (ДОБАВЛЕНО: колонка username)
client.query(`
    CREATE TABLE IF NOT EXISTS pixels (
        pos_key TEXT PRIMARY KEY,
        color TEXT NOT NULL,
        username TEXT DEFAULT 'Аноним'
    )
`).catch(err => console.error('Ошибка создания таблицы pixels:', err));

// ДОБАВЛЕНО: Обновляем старую таблицу, если в ней еще нет колонки username
client.query(`
    ALTER TABLE pixels ADD COLUMN IF NOT EXISTS username TEXT DEFAULT 'Аноним'
`).catch(err => console.error('Ошибка обновления таблицы pixels:', err));

// ДОБАВЛЕНО: Создаем таблицу пользователей
client.query(`
    CREATE TABLE IF NOT EXISTS users (
        username TEXT PRIMARY KEY,
        password TEXT NOT NULL
    )
`).catch(err => console.error('Ошибка создания таблицы users:', err));

app.use(express.static('public'));

let userCount = 0;

io.on('connection', async (socket) => {
    userCount++;
    io.emit('userCount', userCount);
    
    // По умолчанию пользователь Аноним, пока не войдет
    socket.username = 'Аноним';

    // 1. Отправляем все пиксели при входе
    try {
        const res = await client.query('SELECT pos_key, color FROM pixels');
        const board = res.rows.map(row => [row.pos_key, row.color]);
        socket.emit('initBoard', board);
    } catch (err) {
        console.error('Ошибка загрузки доски:', err);
    }

    // ДОБАВЛЕНО: Регистрация
    socket.on('register', async (data) => {
        const { username, password } = data;
        if (!username || !password || username.length > 15) return socket.emit('authResult', { success: false, msg: 'Некорректные данные' });
        try {
            await client.query('INSERT INTO users (username, password) VALUES ($1, $2)', [username, password]);
            socket.username = username;
            socket.emit('authResult', { success: true, username });
        } catch (err) {
            socket.emit('authResult', { success: false, msg: 'Это имя уже занято!' });
        }
    });

    // ДОБАВЛЕНО: Вход
    socket.on('login', async (data) => {
        const { username, password } = data;
        try {
            const res = await client.query('SELECT * FROM users WHERE username = $1 AND password = $2', [username, password]);
            if (res.rows.length > 0) {
                socket.username = username;
                socket.emit('authResult', { success: true, username });
            } else {
                socket.emit('authResult', { success: false, msg: 'Неверный логин или пароль!' });
            }
        } catch (err) {
            console.error(err);
        }
    });

    // ДОБАВЛЕНО: Узнать автора пикселя
    socket.on('inspectPixel', async (data) => {
        const { x, y } = data;
        const key = `${x},${y}`;
        try {
            const res = await client.query('SELECT username FROM pixels WHERE pos_key = $1', [key]);
            const author = res.rows.length > 0 ? res.rows[0].username : 'Пусто';
            socket.emit('pixelInfo', { x, y, author });
        } catch (err) {
            console.error(err);
        }
    });

    // 2. Обработка рисования (с проверкой АДМИНА)
    socket.on('drawPixel', async (data) => {
        const { x, y, color, adminKey } = data;
        
        // ИЗМЕНЕНО: Валидация координат до 2000
        if (x < 0 || x >= 2000 || y < 0 || y >= 2000) return;

        // --- ПРОВЕРКА АДМИНА ---
        const isAdmin = adminKey === 'supertop'; // Твой секретный пароль
        const cooldown = isAdmin ? 0 : 3000; 

        const now = Date.now();
        const lastDraw = socket.lastDrawTime || 0;

        // Если не админ и время не вышло — игнорируем
        if (!isAdmin && (now - lastDraw < cooldown)) return;

        socket.lastDrawTime = now;

        // Сохраняем в базу данных (ДОБАВЛЕНО: сохраняем username)
        const key = `${x},${y}`;
        try {
            await client.query(`
                INSERT INTO pixels (pos_key, color, username) 
                VALUES ($1, $2, $3) 
                ON CONFLICT (pos_key) 
                DO UPDATE SET color = $2, username = $3
            `, [key, color, socket.username]);
            
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
        
        // ИЗМЕНЕНО: Рассылаем всем с настоящим именем пользователя
        io.emit('receiveMessage', {
            username: socket.username,
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
