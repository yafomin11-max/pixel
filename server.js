const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Client } = require('pg');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// --- НАСТРОЙКА БАЗЫ ДАННЫХ ---
const client = new Client({
    connectionString: process.env.DATABASE_URL, 
    ssl: { rejectUnauthorized: false }
});

client.connect()
    .then(() => console.log('✅ Успешное подключение к Postgres'))
    .catch(err => console.error('❌ Ошибка подключения к БД:', err.stack));

// Кэш приватов в памяти для быстрой проверки
let protectedZones = [];

async function loadZones() {
    try {
        const res = await client.query('SELECT * FROM protected_zones');
        protectedZones = res.rows;
    } catch (e) { console.error('Ошибка загрузки приватов:', e); }
}

// 1. Инициализация таблиц
async function initDB() {
    try {
        await client.query(`
            CREATE TABLE IF NOT EXISTS pixels (
                pos_key TEXT PRIMARY KEY,
                color TEXT NOT NULL,
                username TEXT DEFAULT 'Аноним'
            )
        `);
        await client.query(`ALTER TABLE pixels ADD COLUMN IF NOT EXISTS username TEXT DEFAULT 'Аноним'`).catch(()=>Object);

        await client.query(`
            CREATE TABLE IF NOT EXISTS users (
                username TEXT PRIMARY KEY,
                password TEXT NOT NULL
            )
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS banned_users (
                username TEXT PRIMARY KEY,
                reason TEXT
            )
        `);

        // ДОБАВЛЕНО: Таблица для приватов
        await client.query(`
            CREATE TABLE IF NOT EXISTS protected_zones (
                id SERIAL PRIMARY KEY,
                x1 INTEGER,
                y1 INTEGER,
                x2 INTEGER,
                y2 INTEGER
            )
        `);
        
        await loadZones(); // Загружаем приваты при старте сервера
        console.log('✅ Все таблицы базы данных готовы');
    } catch (err) {
        console.error('❌ Ошибка при инициализации БД:', err);
    }
}
initDB();

app.use(express.static('public'));

let userCount = 0;

// Хелпер для проверки бана
async function checkBan(username) {
    if (!username || username === 'Аноним') return false;
    const res = await client.query('SELECT username FROM banned_users WHERE username = $1', [username]);
    return res.rows.length > 0;
}

io.on('connection', async (socket) => {
    userCount++;
    io.emit('userCount', userCount);
    
    socket.username = 'Аноним';

    const isAdminConnection = socket.handshake.headers.referer && socket.handshake.headers.referer.includes('admin=supertop');

    // 1. Отправка доски
    try {
        const res = await client.query('SELECT pos_key, color FROM pixels');
        const board = res.rows.map(row => [row.pos_key, row.color]);
        socket.emit('initBoard', board);
    } catch (err) {
        console.error('Ошибка загрузки доски:', err);
    }

    // 2. РЕГИСТРАЦИЯ И ВХОД
    socket.on('register', async (data) => {
        const { username, password } = data;
        if (!username || !password || username.length > 15 || username === 'Аноним') {
            return socket.emit('authResult', { success: false, msg: 'Недопустимое имя!' });
        }
        try {
            await client.query('INSERT INTO users (username, password) VALUES ($1, $2)', [username, password]);
            socket.username = username;
            socket.emit('authResult', { success: true, username });
        } catch (err) {
            socket.emit('authResult', { success: false, msg: 'Имя уже занято!' });
        }
    });

    socket.on('login', async (data) => {
        const { username, password } = data;
        try {
            const res = await client.query('SELECT * FROM users WHERE username = $1 AND password = $2', [username, password]);
            if (res.rows.length > 0) {
                socket.username = username;
                socket.emit('authResult', { success: true, username });
            } else {
                socket.emit('authResult', { success: false, msg: 'Неверные данные!' });
            }
        } catch (err) { console.error(err); }
    });

    // 3. ИНСПЕКТОР (КТО ПОСТАВИЛ БЛОК)
    socket.on('inspectPixel', async (data) => {
        const { x, y } = data;
        const key = `${x},${y}`;
        try {
            const res = await client.query('SELECT username FROM pixels WHERE pos_key = $1', [key]);
            const author = res.rows.length > 0 ? res.rows[0].username : 'Пусто';
            socket.emit('pixelInfo', { x, y, author });
        } catch (err) { console.error(err); }
    });

    // 4. РИСОВАНИЕ
    socket.on('drawPixel', async (data) => {
        const { x, y, color, adminKey } = data;
        const isAdmin = adminKey === 'supertop';

        if (await checkBan(socket.username) && !isAdmin) {
            return socket.emit('receiveMessage', { username: 'СИСТЕМА', text: 'Вы забанены и не можете рисовать!' });
        }

        if (socket.username === 'Аноним' && !isAdmin) {
            return socket.emit('receiveMessage', { username: 'СИСТЕМА', text: 'Войдите в аккаунт, чтобы рисовать!' });
        }
        
        if (x < 0 || x >= 2000 || y < 0 || y >= 2000) return;

        // ДОБАВЛЕНО: ПРОВЕРКА НА ПРИВАТ ТЕРРИТОРИИ
        if (!isAdmin) {
            // Проверяем, попадает ли точка (x, y) хотя бы в одну защищенную зону
            const isProtected = protectedZones.some(z => 
                x >= Math.min(z.x1, z.x2) && x <= Math.max(z.x1, z.x2) &&
                y >= Math.min(z.y1, z.y2) && y <= Math.max(z.y1, z.y2)
            );
            
            if (isProtected) {
                // Тихо игнорируем попытку нарисовать, чтобы не спамить в чат
                return;
            }
        }

        const cooldown = isAdmin ? 0 : 3000; 
        const now = Date.now();
        if (!isAdmin && (now - (socket.lastDrawTime || 0) < cooldown)) return;

        socket.lastDrawTime = now;
        const key = `${x},${y}`;

        try {
            await client.query(`
                INSERT INTO pixels (pos_key, color, username) 
                VALUES ($1, $2, $3) 
                ON CONFLICT (pos_key) 
                DO UPDATE SET color = $2, username = $3
            `, [key, color, socket.username]);
            
            socket.broadcast.emit('updatePixel', { x, y, color });
        } catch (err) { console.error('Ошибка сохранения пикселя:', err); }
    });

    // 5. ЧАТ И БАН-КОМАНДЫ + КОМАНДЫ ПРИВАТА
    socket.on('sendMessage', async (data) => {
        if (!data.text || data.text.trim() === '') return;
        
        // Команды только для админа
        if (isAdminConnection) {
            const text = data.text.trim();
            
            // Бан
            if (text.startsWith('/ban ')) {
                const targetName = text.split(' ')[1];
                if (targetName && targetName !== 'Аноним') {
                    await client.query('INSERT INTO banned_users (username) VALUES ($1) ON CONFLICT DO NOTHING', [targetName]);
                    return io.emit('receiveMessage', { username: 'СИСТЕМА', text: `Пользователь ${targetName} заблокирован!` });
                }
            }

            // Создание привата
            if (text.startsWith('/protect ')) {
                // Ожидаем формат: /protect x1 y1 x2 y2
                const parts = text.split(' ');
                if (parts.length === 5) {
                    const x1 = parseInt(parts[1]), y1 = parseInt(parts[2]), x2 = parseInt(parts[3]), y2 = parseInt(parts[4]);
                    if (!isNaN(x1) && !isNaN(y1) && !isNaN(x2) && !isNaN(y2)) {
                        await client.query('INSERT INTO protected_zones (x1, y1, x2, y2) VALUES ($1, $2, $3, $4)', [x1, y1, x2, y2]);
                        await loadZones(); // Обновляем кэш приватов
                        return io.emit('receiveMessage', { username: 'СИСТЕМА', text: `Территория (${x1},${y1}) - (${x2},${y2}) успешно защищена!` });
                    }
                }
                return socket.emit('receiveMessage', { username: 'СИСТЕМА', text: 'Ошибка! Используй: /protect X1 Y1 X2 Y2' });
            }

            // Снятие всех приватов (глобальная очистка)
            if (text === '/unprotectall') {
                await client.query('TRUNCATE TABLE protected_zones');
                await loadZones();
                return io.emit('receiveMessage', { username: 'СИСТЕМА', text: 'Все приваты удалены!' });
            }
        }

        if (await checkBan(socket.username)) return;

        const cleanText = data.text.trim().substring(0, 100);
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
    console.log(`🚀 Сервер Pixel Battle PRO запущен на порту ${PORT}`);
});
