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

// Глобальный объект для хранения активных сессий Steam Community (чтобы активировать коды на лету)
const activeCommunities = {};

// Middleware проверки прав админа
function isAdmin(req, res, next) {
  if (req.session && req.session.user === 'agricolademetr') {
    return next();
  }
  res.redirect('/login');
}

// 2. АВТОРИЗАЦИЯ АДМИНИСТРАТОРА
app.get('/login', (req, res) => {
  res.send(`
    <style>
      body { font-family: Arial, sans-serif; background: #1a1a1a; color: white; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
      .login-box { background: #2a2a2a; padding: 30px; border-radius: 8px; box-shadow: 0 4px 15px rgba(0,0,0,0.5); width: 300px; text-align: center; }
      input { width: 100%; padding: 10px; margin: 10px 0; border: 1px solid #444; background: #333; color: white; border-radius: 4px; box-sizing: border-box; }
      button { width: 100%; padding: 10px; background: #007bff; border: none; color: white; border-radius: 4px; cursor: pointer; font-weight: bold; }
      button:hover { background: #0056b3; }
    </style>
    <div class="login-box">
      <h2>Steam Suite Login</h2>
      <form action="/login" method="POST">
        <input type="text" name="username" placeholder="Username" required>
        <input type="password" name="password" placeholder="Password" required>
        <button type="submit">Sign In</button>
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
  res.send('<h3>Неверный логин или пароль.</h3><a href="/login">Назад</a>');
});

app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});

// 3. ПОЛНАЯ АДМИН ПАНЕЛЬ ДЛЯ AGRICOLADEMETR + АКТИВАЦИЯ КОДОВ
app.get('/admin', isAdmin, (req, res) => {
  db.all(`SELECT id, username, status FROM accounts`, [], (err, rows) => {
    if (err) return res.status(500).send('Ошибка чтения БД');

    let rowsHtml = rows.map(acc => `
      <tr>
        <td>${acc.id}</td>
        <td><b>${acc.username}</b></td>
        <td><span class="status ${acc.status}">${acc.status}</span></td>
        <td>
          <div style="display: flex; gap: 8px;">
            <input type="text" id="code-${acc.id}" placeholder="Код пополнения (Wallet Code)" style="padding: 5px; background: #333; color: white; border: 1px solid #555; border-radius: 4px; font-size:12px;">
            <button class="btn-wallet" onclick="redeemCode(${acc.id}, '${acc.username}')">Активировать</button>
            <button class="btn-delete" onclick="deleteAccount(${acc.id}, '${acc.username}')">Удалить</button>
          </div>
        </td>
      </tr>
    `).join('');

    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Admin Dashboard - agricolademetr</title>
        <style>
          body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background: #121212; color: #e0e0e0; margin: 0; padding: 20px; }
          .container { max-width: 1100px; margin: 0 auto; background: #1e1e1e; padding: 20px; border-radius: 8px; box-shadow: 0 4px 20px rgba(0,0,0,0.6); }
          header { display: flex; justify-content: space-between; align-items: center; border-bottom: 2px solid #333; padding-bottom: 15px; margin-bottom: 20px; }
          h1 { margin: 0; color: #007bff; }
          .user-badge { background: #333; padding: 5px 15px; border-radius: 20px; font-size: 14px; }
          .logout { color: #dc3545; text-decoration: none; font-weight: bold; margin-left: 15px; }
          table { width: 100%; border-collapse: collapse; margin-top: 10px; }
          th, td { padding: 12px; text-align: left; border-bottom: 1px solid #333; }
          th { background: #252525; color: #007bff; }
          .status { padding: 3px 8px; border-radius: 4px; font-size: 12px; font-weight: bold; text-transform: uppercase; }
          .status.online { background: #28a745; color: white; }
          .status.offline { background: #6c757d; color: white; }
          .btn-delete { background: #dc3545; color: white; border: none; padding: 6px 12px; border-radius: 4px; cursor: pointer; }
          .btn-delete:hover { background: #bd2130; }
          .btn-wallet { background: #17a2b8; color: white; border: none; padding: 6px 12px; border-radius: 4px; cursor: pointer; }
          .btn-wallet:hover { background: #138496; }
          .form-section { background: #252525; padding: 15px; border-radius: 6px; margin-bottom: 25px; }
          .form-section input { padding: 8px; margin-right: 10px; background: #333; color: white; border: 1px solid #444; border-radius: 4px; }
          .btn-add { background: #28a745; color: white; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer; font-weight: bold; }
        </style>
      </head>
      <body>
        <div class="container">
          <header>
            <h1>Steam Suite Admin Panel</h1>
            <div>
              <span class="user-badge">👤 Администратор: <b>agricolademetr</b></span>
              <a href="/logout" class="logout">Выйти</a>
            </div>
          </header>

          <div class="form-section">
            <h3>➕ Добавить новый Стим аккаунт</h3>
            <form action="/admin/add" method="POST">
              <input type="text" name="username" placeholder="Логин Steam" required>
              <input type="password" name="password" placeholder="Пароль Steam" required>
              <input type="text" name="shared_secret" placeholder="Shared Secret (maFile)">
              <button type="submit" class="btn-add">Добавить</button>
            </form>
          </div>

          <h3>📋 Список аккаунтов фермы</h3>
          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>Логин Steam</th>
                <th>Статус</th>
                <th>Действия и Баланс</th>
              </tr>
            </thead>
            <tbody>
              ${rowsHtml || '<tr><td colspan="4" style="text-align:center;">Аккаунтов пока нет</td></tr>'}
            </tbody>
          </table>
        </div>

        <script>
          function deleteAccount(id, name) {
            if (confirm('Удалить аккаунт ' + name + ' из базы?')) {
              fetch('/admin/delete/' + id, { method: 'DELETE' })
                .then(res => res.json())
                .then(data => { if(data.success) location.reload(); });
            }
          }

          function redeemCode(id, username) {
            const codeInput = document.getElementById('code-' + id);
            const code = codeInput.value.trim();
            if (!code) return alert('Введите код пополнения!');
            
            fetch('/admin/redeem', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ username: username, code: code })
            })
            .then(res => res.json())
            .then(data => {
              if (data.success) {
                alert('Успешно! Новый баланс: ' + data.balance);
                codeInput.value = '';
              } else {
                alert('Ошибка: ' + data.error);
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
      if (err) return res.send(`<h3>Ошибка: ${err.message}</h3><a href="/admin">Назад</a>`);
      
      // Инициализируем клиента сразу после добавления в базу
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

// API: АКТИВАЦИЯ КОДА СТРАНИЦЫ
app.post('/admin/redeem', isAdmin, (req, res) => {
  const { username, code } = req.body;
  const community = activeCommunities[username];

  if (!community) {
    return res.status(400).json({ success: false, error: 'Бот не в сети. Сначала дождитесь статуса ONLINE.' });
  }

  community.redeemWalletCode(code, (err, walletBalance) => {
    if (err) return res.status(500).json({ success: false, error: err.message });
    res.json({ success: true, balance: walletBalance });
  });
});

// Функция запуска Стим-клиента
function startSteamClient(username, password, sharedSecret) {
  const user = new SteamUser();
  const community = new SteamCommunity();
  
  const logInOptions = { accountName: username, password: password };
  if (sharedSecret) {
    logInOptions.twoFactorCode = SteamTotp.getAuthCode(sharedSecret);
  }

  user.logOn(logInOptions);

  user.on('loggedOn', () => {
    console.log(`[Steam] Бот ${username} зашел в сеть.`);
    db.run(`UPDATE accounts SET status = 'online' WHERE username = ?`, [username]);
  });

  user.on('webSession', (sessionID, cookies) => {
    community.setCookies(cookies);
    // Сохраняем экземпляр сессии для возможности активации кодов
    activeCommunities[username] = community;
  });

  user.on('error', (err) => {
    console.error(`[Steam Error] ${username}:`, err.message);
    db.run(`UPDATE accounts SET status = 'offline' WHERE username = ?`, [username]);
  });
}

// Автозапуск всех существующих аккаунтов при старте сервера
db.all(`SELECT username, password, shared_secret FROM accounts`, [], (err, rows) => {
  if (!err && rows) {
    rows.forEach(acc => startSteamClient(acc.username, acc.password, acc.shared_secret));
  }
});

app.get('/', (req, res) => res.redirect('/admin'));

app.listen(PORT, () => console.log(`Сервер запущен на порту ${PORT}`));
