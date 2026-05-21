const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const SteamUser = require('steam-user');
const SteamCommunity = require('steamcommunity');
const TradeOfferManager = require('steam-tradeoffer-manager');
const SteamTotp = require('steam-totp');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// 1. НАСТРОЙКА БАЗЫ ДАННЫХ SQLITE3
// На Render файлы стираются при перезапуске, если не использовать Persistent Disk.
// '/opt/render/project/src/data.db' - идеальный путь для диска Render.
const dbPath = process.env.RENDER ? '/opt/render/project/src/data.db' : path.join(__dirname, 'database.db');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) return console.error('Ошибка БД:', err.message);
  console.log('Успешное подключение к SQLite3.');
});

// Создаем таблицы для логов и аккаунтов, если их нет
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE,
    password TEXT,
    shared_secret TEXT,
    cookies TEXT,
    status TEXT DEFAULT 'offline'
  )`);
});

// 2. ИНИЦИАЛИЗАЦИЯ STEAM КЛИЕНТОВ
const user = new SteamUser();
const community = new SteamCommunity();
const manager = new TradeOfferManager({
  steam: user,
  community: community,
  language: 'en'
});

// Пример генерации 2FA кода и авторизации
const STEAM_ACCOUNT = {
  username: process.env.STEAM_USERNAME,
  password: process.env.STEAM_PASSWORD,
  sharedSecret: process.env.STEAM_SHARED_SECRET
};

if (STEAM_ACCOUNT.username && STEAM_ACCOUNT.password) {
  const logInOptions = {
    accountName: STEAM_ACCOUNT.username,
    password: STEAM_ACCOUNT.password
  };

  if (STEAM_ACCOUNT.sharedSecret) {
    logInOptions.twoFactorCode = SteamTotp.getAuthCode(STEAM_ACCOUNT.sharedSecret);
  }

  user.logOn(logInOptions);
}

user.on('loggedOn', () => {
  console.log(`Бот успешно авторизован в Steam как ${STEAM_ACCOUNT.username}`);
  user.setPersona(SteamUser.EPersonaState.Online);
});

user.on('webSession', (sessionID, cookies) => {
  community.setCookies(cookies);
  manager.setCookies(cookies, (err) => {
    if (err) return console.error('Ошибка установки куков для трейда:', err);
    console.log('Трейд-менеджер готов к работе.');
  });

  // Сохраняем сессию в базу данных
  db.run(`UPDATE accounts SET cookies = ?, status = 'online' WHERE username = ?`, 
    [JSON.stringify(cookies), STEAM_ACCOUNT.username]);
});

// 3. НАСТРОЙКА WEB-СЕРВЕРА EXPRESS
app.use(express.json());

// Главная страница веб-панели (Dashboard API)
app.get('/', (req, res) => {
  res.send('<h1>Steam Autonomous Supreme Suite Инициализирован</h1>');
});

// API Эндпоинт для получения статуса бота из базы данных
app.get('/api/status', (req, res) => {
  db.get(`SELECT username, status FROM accounts WHERE username = ?`, [STEAM_ACCOUNT.username], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ bot: row || { username: STEAM_ACCOUNT.username, status: 'offline' } });
  });
});

// Запуск сервера Express
app.listen(PORT, () => {
  console.log(`Сервер Express запущен на порту ${PORT}`);
});
