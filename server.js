const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const SteamUser = require('steam-user');
const SteamCommunity = require('steamcommunity');
const TradeOfferManager = require('steam-tradeoffer-manager');
const SteamTotp = require('steam-totp');
const path = require('path');
const session = require('express-session');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(session({
  secret: process.env.SESSION_SECRET || 'super-secret-key-agricolademetr',
  resave: false,
  saveUninitialized: true,
  cookie: { secure: false }
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 1. НАСТРОЙКА БАЗЫ ДАННЫХ SQLITE3
const dbPath = process.env.RENDER ? '/opt/render/project/src/data.db' : path.join(__dirname, 'database.db');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) return console.error('Ошибка БД:', err.message);
  console.log('Успешное подключение к SQLite3.');
});

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

const activeCommunities = {};

function isAdmin(req, res, next) {
  if (req.session && req.session.user === 'agricolademetr') {
    return next();
  }
  res.redirect('/login');
}

// 2. СТИЛИЗОВАННЫЙ ВХОД ASF-UI
app.get('/login', (req, res) => {
  res.send(`
    <style>
      body { font-family: 'Roboto', sans-serif; background: #141414; color: #fff; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
      .login-box { background: #1e1e1e; padding: 40px; border-radius: 4px; border-top: 3px solid #2bc0ec; box-shadow: 0 10px 25px rgba(0,0,0,0.5); width: 320px; text-align: center; }
      h2 { margin-bottom: 25px; font-weight: 300; letter-spacing: 1px; color: #2bc0ec; }
      input { width: 100%; padding: 12px; margin: 10px 0; border: 1px solid #2d2d2d; background: #252525; color: white; border-radius: 4px; box-sizing: border-box; transition: 0.3s; }
      input:focus { border-color: #2bc0ec; outline: none; }
      button { width: 100%; padding: 12px; background: #2bc0ec; border: none; color: #141414; border-radius: 4px; cursor: pointer; font-weight: bold; font-size: 14px; text-transform: uppercase; margin-top: 15px; }
      button:hover { background: #23a1c6; }
    </style>
    <div class="login-box">
      <h2>ASF-UI MONOLITH</h2>
      <form action="/login" method="POST">
        <input type="text" name="username" placeholder="Имя пользователя" required>
        <input type="password" name="password" placeholder="Пароль доступа" required>
        <button type="submit">Войти</button>
      </form>
    </div>
  `);
});

app.post('/login', (req, res) => {
  const { username, password } = req.body;
  const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'agricola1234';

  if (username === 'agricolademetr' && password === ADMIN_PASSWORD) {
    req.session.user = 'agricolademetr';
    return res.redirect('/admin');
  }
  res.send('<h3>Доступ отклонен.</h3><a href="/login">Повторить попытку</a>');
});

app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});

// 3. ФИРМЕННАЯ АДМИН-ПАНЕЛЬ В СТИЛЕ ASF-UI ДЛЯ AGRICOLADEMETR
app.get('/admin', isAdmin, (req, res) => {
  db.all(`SELECT id, username, status FROM accounts`, [], (err, rows) => {
    if (err) return res.status(500).send('Ошибка БД');

    // Генерация карточек ботов (Грид-система как в оригинальном ASF-UI)
    let cardsHtml = rows.map(acc => `
      <div class="bot-card ${acc.status}">
        <div class="bot-header">
          <span class="bot-name">🤖 ${acc.username}</span>
          <span class="badge-status">${acc.status}</span>
        </div>
        <div class="bot-body">
          <p>ID аккаунта: #${acc.id}</p>
          <div class="wallet-actions">
            <input type="text" id="code-${acc.id}" placeholder="Вставить Steam Wallet Code">
            <button class="btn-action btn-blue" onclick="redeemCode(${acc.id}, '${acc.username}')">Пополнить баланс</button>
          </div>
        </div>
        <div class="bot-footer">
          <button class="btn-action btn-red" onclick="deleteAccount(${acc.id}, '${acc.username}')">Удалить бота</button>
        </div>
      </div>
    `).join('');

    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>ASF-UI Monolithic Dashboard</title>
        <meta charset="utf-8">
        <style>
          body { font-family: 'Segoe UI', Arial, sans-serif; background: #141414; color: #d1d4d6; margin: 0; display: flex; height: 100vh; overflow: hidden; }
          
          /* Левый сайдбар ASF-UI */
          .sidebar { width: 260px; background: #1e1e1e; border-right: 1px solid #2d2d2d; display: flex; flex-direction: column; justify-content: space-between; }
          .sidebar-header { padding: 20px; background: #252525; text-align: center; border-bottom: 1px solid #2d2d2d; }
          .sidebar-header h2 { margin: 0; color: #2bc0ec; font-weight: 400; font-size: 20px; }
          .sidebar-menu { padding: 20px 0; flex-grow: 1; }
          .menu-item { padding: 12px 25px; display: flex; align-items: center; color: #a0a0a0; text-decoration: none; font-size: 14px; transition: 0.2s; border-left: 3px solid transparent; }
          .menu-item:hover, .menu-item.active { background: #252525; color: #fff; border-left-color: #2bc0ec; }
          .sidebar-footer { padding: 20px; background: #1a1a1a; border-top: 1px solid #2d2d2d; font-size: 12px; }
          .logout-btn { color: #e74c3c; text-decoration: none; font-weight: bold; display: block; margin-top: 10px; }

          /* Основной контент */
          .main-content { flex-grow: 1; display: flex; flex-direction: column; overflow-y: auto; background: #151515; }
          .top-bar { height: 60px; background: #1e1e1e; border-bottom: 1px solid #2d2d2d; display: flex; align-items: center; justify-content: space-between; padding: 0 30px; }
          .view-container { padding: 30px; }

          /* Форма добавления ботов (Стиль ASF) */
          .asf-form { background: #1e1e1e; border: 1px solid #2d2d2d; border-radius: 4px; padding: 20px; margin-bottom: 30px; }
          .asf-form h3 { margin-top: 0; color: #fff; font-weight: 400; border-bottom: 1px solid #2d2d2d; padding-bottom: 10px; }
          .form-group { display: flex; gap: 15px; flex-wrap: wrap; margin-top: 15px; }
          .asf-form input { background: #252525; border: 1px solid #2d2d2d; color: white; padding: 10px; border-radius: 4px; flex-grow: 1; min-width: 180px; }
          .asf-form input:focus { border-color: #2bc0ec; outline: none; }
          .btn-submit { background: #2ecc71; color: #141414; border: none; padding: 10px 20px; border-radius: 4px; cursor: pointer; font-weight: bold; }
          .btn-submit:hover { background: #27ae60; }

          /* Сетка карточек ботов (Фирменный стиль ASF-UI) */
          .bots-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 20px; }
          .bot-card { background: #1e1e1e; border: 1px solid #2d2d2d; border-radius: 4px; display: flex; flex-direction: column; justify-content: space-between; border-left: 4px solid #7f8c8d; transition: 0.2s; }
          .bot-card:hover { transform: translateY(-2px); box-shadow: 0 5px 15px rgba(0,0,0,0.3); }
          
          /* Цветовые статусы как в ASF */
          .bot-card.online { border-left-color: #2ecc71; }
          .bot-card.offline { border-left-color: #e74c3c; }
          
          .bot-header { padding: 15px; background: #252525; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #2d2d2d; }
          .bot-name { font-weight: bold; color: #fff; }
          .badge-status { font-size: 11px; text-transform: uppercase; padding: 2px 6px; border-radius: 3px; font-weight: bold; }
          .online .badge-status { background: rgba(46, 204, 113, 0.2); color: #2ecc71; }
          .offline .badge-status { background: rgba(231, 76, 60, 0.2); color: #e74c3c; }

          .bot-body { padding: 15px; font-size: 14px; }
          .wallet-actions { margin-top: 15px; display: flex; flex-direction: column; gap: 8px; }
          .wallet-actions input { background: #252525; border: 1px solid #2d2d2d; color: white; padding: 8px; border-radius: 4px; font-size: 12px; }
          
          .bot-footer { padding: 12px 15px; background: #1a1a1a; border-top: 1px solid #2d2d2d; text-align: right; }
          
          /* Кнопки действий */
          .btn-action { border: none; padding: 6px 12px; border-radius: 4px; cursor: pointer; font-size: 12px; font-weight: bold; }
          .btn-blue { background: #2bc0ec; color: #141414; }
          .btn-blue:hover { background: #23a1c6; }
          .btn-red { background: rgba(231, 76, 60, 0.2); color: #e74c3c; border: 1px solid #e74c3c; }
          .btn-red:hover { background: #e74c3c; color: #fff; }
        </style>
      </head>
      <body>

        <!-- Боковое меню ASF-UI -->
        <div class="sidebar">
          <div>
            <div class="sidebar-header">
              <h2>ASF-UI NODE</h2>
            </div>
            <div class="sidebar-menu">
              <a href="/admin" class="menu-item active">🏠 Главная панель</a>
              <a href="#" class="menu-item">⚙️ Настройки макросов</a>
              <a href="#" class="menu-item">📊 Логи транзакций</a>
            </div>
          </div>
          <div class="sidebar-footer">
            <div>Пользователь: <b>agricolademetr</b></div>
            <a href="/logout" class="logout-btn">🔴 Выйти из сессии</a>
          </div>
        </div>

        <!-- Контентная область -->
        <div class="main-content">
          <div class="top-bar">
            <span>Мониторинг запущенных инстансов Steam</span>
            <span style="font-size: 13px; color: #a0a0a0;">Версия экосистемы: 7.5.0</span>
          </div>

          <div class="view-container">
            <!-- Форма добавления ботов -->
            <div class="asf-form">
              <h3>➕ Создать нового бота (Инстанс)</h3>
              <form action="/admin/add" method="POST" class="form-group">
                <input type="text" name="username" placeholder="Логин Steam аккаунта" required>
                <input type="password" name="password" placeholder="Пароль Steam аккаунта" required>
                <input type="text" name="shared_secret" placeholder="Shared Secret (из maFile для 2FA)">
                <button type="submit" class="btn-submit">Создать бота</button>
              </form>
            </div>

            <!-- Карточки в стиле ASF-UI -->
            <h3>🤖 Активные боты в пуле</h3>
            <div class="bots-grid">
              ${cardsHtml || '<div style="grid-column: 1/-1; text-align:center; padding: 40px; background: #1e1e1e; border: 1px dashed #444;">Список запущенных ботов пуст. Добавьте первый аккаунт выше.</div>'}
            </div>
          </div>
        </div>

        <script>
          function deleteAccount(id, name) {
            if (confirm('Внимание! Вы действительно хотите удалить конфигурацию инстанса бота: ' + name + '?')) {
              fetch('/admin/delete/' + id, { method: 'DELETE' })
                .then(res => res.json())
                .then(data => { if(data.success) location.reload(); });
            }
          }

          function redeemCode(id, username) {
            const codeInput = document.getElementById('code-' + id);
            const code = codeInput.value.trim();
            if (!code) return alert('Укажите корректный Steam Wallet Code!');
            
            fetch('/admin/redeem', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ username: username, code: code })
            })
            .then(res => res.json())
            .then(data => {
              if (data.success) {
                alert('Баланс аккаунта ' + username + ' успешно пополнен! Сумма: ' + data.balance);
                codeInput.value = '';
              } else {
                alert('Критическая ошибка обработки кода: ' + data.error);
              }
            });
          }
        </script>
      </body>
      </html>
    `);
  });
});

// API: Добавление аккаунта
app.post('/admin/add', isAdmin, (req, res) => {
  const { username, password, shared_secret } = req.body;
  db.run(`INSERT INTO accounts (username, password, shared_secret) VALUES (?, ?, ?)`,
    [username, password, shared_secret], (err) => {
      if (err) return res.send(`<h3>Ошибка создания записи: ${err.message}</h3><a href="/admin">Вернуться</a>`);
      startSteamClient(username, password, shared_secret);
      res.redirect('/admin');
    });
});

// API: Удаление аккаунта
app.delete('/admin/delete/:id', isAdmin, (req, res) => {
  db.run(`DELETE FROM accounts WHERE id = ?`, [req.params.id], (err) => {
    if (err) return res.status(500).json({ success: false });
    res.json({ success: true });
  });
});

// API: Активация кодов
app.post('/admin/redeem', isAdmin, (req, res) => {
  const { username, code } = req.body;
  const community = activeCommunities[username];

  if (!community) {
    return res.status(400).json({ success: false, error: 'Инстанс бота оффлайн. Активация невозможна.' });
  }

  community.redeemWalletCode(code, (err, walletBalance) => {
    if (err) return res.status(500).json({ success: false, error: err.message });
    res.json({ success: true, balance: walletBalance });
  });
});

function startSteamClient(username, password, sharedSecret) {
  const user = new SteamUser();
  const community = new SteamCommunity();
  
  const logInOptions = { accountName: username, password: password };
  if (sharedSecret) {
    logInOptions.twoFactorCode = SteamTotp.getAuthCode(sharedSecret);
  }

  user.logOn(logInOptions);

  user.on('loggedOn', () => {
    console.log(`[Steam Monolith] Успешная инициализация сессии для бота: ${username}`);
    db.run(`UPDATE accounts SET status = 'online' WHERE username = ?`, [username]);
  });

  user.on('webSession', (sessionID, cookies) => {
    community.setCookies(cookies);
    activeCommunities[username] = community;
  });

  user.on('error', (err) => {
    console.error(`[Steam Error] ${username}:`, err.message);
    db.run(`UPDATE accounts SET status = 'offline' WHERE username = ?`, [username]);
  });
}

// Первоначальный автозапуск сущностей из БД
db.all(`SELECT username, password, shared_secret FROM accounts`, [], (err, rows) => {
  if (!err && rows) {
    rows.forEach(acc => startSteamClient(acc.username, acc.password, acc.shared_secret));
  }
});

app.get('/', (req, res) => res.redirect('/admin'));

app.listen(PORT, () => console.log(`[System Core] Web-сервер ASF-UI инициализирован на порту ${PORT}`));
