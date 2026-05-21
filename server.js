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
    status TEXT DEFAULT 'offline',
    farm_cards INTEGER DEFAULT 1,
    accept_gifts INTEGER DEFAULT 0,
    games_to_farm TEXT DEFAULT '730'
  )`);
});

const activeCommunities = {};

function isAdmin(req, res, next) {
  if (req.session && req.session.user === 'agricolademetr') {
    return next();
  }
  res.redirect('/login');
}

// 2. СТРАНИЦА АВТОРИЗАЦИИ
app.get('/login', (req, res) => {
  res.send(`
    <style>
      body { font-family: 'Segoe UI', Arial, sans-serif; background: #141414; color: #fff; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
      .login-box { background: #1e1e1e; padding: 40px; border-radius: 4px; border-top: 3px solid #2bc0ec; box-shadow: 0 10px 25px rgba(0,0,0,0.5); width: 320px; text-align: center; }
      h2 { margin-bottom: 25px; font-weight: 300; letter-spacing: 1px; color: #2bc0ec; }
      input { width: 100%; padding: 12px; margin: 10px 0; border: 1px solid #2d2d2d; background: #252525; color: white; border-radius: 4px; box-sizing: border-box; }
      button { width: 100%; padding: 12px; background: #2bc0ec; border: none; color: #141414; border-radius: 4px; cursor: pointer; font-weight: bold; font-size: 14px; text-transform: uppercase; }
      button:hover { background: #23a1c6; }
    </style>
    <div class="login-box">
      <h2>ASF MONOLITH</h2>
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

// 3. ПАНЕЛЬ УПРАВЛЕНИЯ: ГЕНЕРАТОР + СПИСОК БОТОВ (БЕЗ ВКЛАДОК)
app.get('/admin', isAdmin, (req, res) => {
  db.all(`SELECT * FROM accounts`, [], (err, rows) => {
    if (err) return res.status(500).send('Ошибка БД');

    // Рендеринг строк таблицы (компактный список вместо карточек)
    let rowsHtml = rows.map(acc => `
      <tr class="${acc.status}">
        <td>#${acc.id}</td>
        <td><strong style="color: #fff;">${acc.username}</strong></td>
        <td><span class="badge-status ${acc.status}">${acc.status}</span></td>
        <td><code>${acc.games_to_farm}</code></td>
        <td>${acc.farm_cards ? '🟢 Да' : '❌ Нет'}</td>
        <td>${acc.accept_gifts ? '🟢 Да' : '❌ Нет'}</td>
        <td>
          <div class="list-actions">
            <input type="text" id="code-${acc.id}" placeholder="Steam Wallet Code">
            <button class="btn-action btn-blue" onclick="redeemCode(${acc.id}, '${acc.username}')">Пополнить</button>
            <button class="btn-action btn-red" onclick="deleteAccount(${acc.id}, '${acc.username}')">Удалить</button>
          </div>
        </td>
      </tr>
    `).join('');

    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>ASF Monolith Dashboard</title>
        <meta charset="utf-8">
        <style>
          body { font-family: 'Segoe UI', Arial, sans-serif; background: #141414; color: #d1d4d6; margin: 0; padding: 0; display: flex; justify-content: center; overflow-y: auto; }
          .container { width: 100%; max-width: 1200px; padding: 30px 20px; }
          
          header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 30px; border-bottom: 1px solid #2d2d2d; padding-bottom: 15px; }
          header h1 { margin: 0; font-size: 24px; color: #2bc0ec; font-weight: 400; }
          .admin-info { display: flex; align-items: center; gap: 15px; font-size: 14px; }
          .logout-btn { color: #e74c3c; text-decoration: none; font-weight: bold; border: 1px solid #e74c3c; padding: 4px 12px; border-radius: 4px; transition: 0.2s; }
          .logout-btn:hover { background: #e74c3c; color: #141414; }

          /* Генератор Конфигураций */
          .asf-form { background: #1e1e1e; border: 1px solid #2d2d2d; border-radius: 4px; padding: 20px; margin-bottom: 40px; border-top: 3px solid #2ecc71; }
          .asf-form h3 { margin-top: 0; color: #fff; font-weight: 400; font-size: 16px; margin-bottom: 15px; }
          .form-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 15px; }
          .form-group { display: flex; flex-direction: column; gap: 5px; }
          .form-group label { font-size: 11px; color: #a0a0a0; text-transform: uppercase; font-weight: bold; }
          .asf-form input, .asf-form select { background: #252525; border: 1px solid #2d2d2d; color: white; padding: 8px 12px; border-radius: 4px; font-size: 13px; }
          .asf-form input:focus, .asf-form select:focus { border-color: #2bc0ec; outline: none; }
          .btn-submit { background: #2ecc71; color: #141414; border: none; padding: 10px 20px; border-radius: 4px; cursor: pointer; font-weight: bold; text-transform: uppercase; font-size: 12px; align-self: flex-end; height: 38px; }
          .btn-submit:hover { background: #27ae60; }

          /* Таблица-список ботов */
          .list-section h3 { font-weight: 400; color: #fff; margin-bottom: 15px; }
          table { width: 100%; border-collapse: collapse; background: #1e1e1e; border: 1px solid #2d2d2d; border-radius: 4px; overflow: hidden; }
          th, td { padding: 12px 15px; text-align: left; font-size: 14px; border-bottom: 1px solid #2d2d2d; }
          th { background: #252525; color: #2bc0ec; font-weight: 600; text-transform: uppercase; font-size: 11px; letter-spacing: 0.5px; }
          
          /* Статусы строк */
          tr.online { border-left: 3px solid #2ecc71; }
          tr.offline { border-left: 3px solid #e74c3c; }
          
          .badge-status { font-size: 11px; text-transform: uppercase; padding: 2px 6px; border-radius: 3px; font-weight: bold; }
          .badge-status.online { background: rgba(46, 204, 113, 0.15); color: #2ecc71; }
          .badge-status.offline { background: rgba(231, 76, 60, 0.15); color: #e74c3c; }

          /* Действия в строке */
          .list-actions { display: flex; align-items: center; gap: 8px; }
          .list-actions input { background: #252525; border: 1px solid #2d2d2d; color: white; padding: 5px 10px; border-radius: 4px; font-size: 12px; width: 140px; }
          .btn-action { border: none; padding: 6px 12px; border-radius: 4px; cursor: pointer; font-size: 12px; font-weight: bold; transition: 0.15s; }
          .btn-blue { background: #2bc0ec; color: #141414; }
          .btn-blue:hover { background: #23a1c6; }
          .btn-red { background: rgba(231, 76, 60, 0.15); color: #e74c3c; border: 1px solid #e74c3c; }
          .btn-red:hover { background: #e74c3c; color: #141414; }
        </style>
      </head>
      <body>

        <div class="container">
          <!-- Верхняя шапка панели -->
          <header>
            <h1>ASF Monolith Dashboard</h1>
            <div class="admin-info">
              <span>👤 Админ: <b>agricolademetr</b></span>
              <a href="/logout" class="logout-btn">Выйти</a>
            </div>
          </header>

          <!-- Веб-генератор настроек -->
          <div class="asf-form">
            <h3>⚙️ Добавить и настроить конфигурацию нового бота</h3>
            <form action="/admin/add" method="POST" class="form-grid">
              <div class="form-group">
                <label>Логин Steam</label>
                <input type="text" name="username" placeholder="Логин" required>
              </div>
              <div class="form-group">
                <label>Пароль Steam</label>
                <input type="password" name="password" placeholder="Пароль" required>
              </div>
              <div class="form-group">
                <label>Shared Secret (2FA)</label>
                <input type="text" name="shared_secret" placeholder="Из maFile">
              </div>
              <div class="form-group">
                <label>Фарм карт</label>
                <select name="farm_cards">
                  <option value="1">Да (Включен)</option>
                  <option value="0">Нет (Выключен)</option>
                </select>
              </div>
              <div class="form-group">
                <label>Прием подарков</label>
                <select name="accept_gifts">
                  <option value="0">Нет (Игнорировать)</option>
                  <option value="1">Да (Принимать)</option>
                </select>
              </div>
              <div class="form-group">
                <label>ID Игр для фарма</label>
                <input type="text" name="games_to_farm" value="730">
              </div>
              <button type="submit" class="btn-submit">Запустить</button>
            </form>
          </div>

          <!-- Сплошной список (Таблица) ботов -->
          <div class="list-section">
            <h3>📋 Подключенные боты пула</h3>
            <table>
              <thead>
                <tr>
                  <th style="width: 60px;">ID</th>
                  <th>Логин Steam</th>
                  <th style="width: 100px;">Статус</th>
                  <th>ID Игр накрутки</th>
                  <th style="width: 100px;">Фарм карт</th>
                  <th style="width: 100px;">Гифты</th>
                  <th style="width: 420px;">Управление и Активация кодов</th>
                </tr>
              </thead>
              <tbody>
                ${rowsHtml || '<tr><td colspan="7" style="text-align:center; padding: 30px; color: #aaa;">Боты не добавлены. Заполните форму генератора выше.</td></tr>'}
              </tbody>
            </table>
          </div>
        </div>

        <script>
          function deleteAccount(id, name) {
            if (confirm('Удалить инстанс бота ' + name + '?')) {
              fetch('/admin/delete/' + id, { method: 'DELETE' })
                .then(res => res.json())
                .then(data => { if(data.success) location.reload(); });
            }
          }

          function redeemCode(id, username) {
            const codeInput = document.getElementById('code-' + id);
            const code = codeInput.value.trim();
            if (!code) return alert('Введите Wallet Code!');
            
            fetch('/admin/redeem', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ username: username, code: code })
            })
            .then(res => res.json())
            .then(data => {
              if (data.success) {
                alert('Успешно активирован код на баланс ' + username + '. Текущий баланс: ' + data.balance);
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

// API: Добавление
app.post('/admin/add', isAdmin, (req, res) => {
  const { username, password, shared_secret, farm_cards, accept_gifts, games_to_farm } = req.body;
  db.run(`INSERT INTO accounts (username, password, shared_secret, farm_cards, accept_gifts, games_to_farm) VALUES (?, ?, ?, ?, ?, ?)`,
    [username, password, shared_secret, parseInt(farm_cards), parseInt(accept_gifts), games_to_farm || '730'], (err) => {
      if (err) return res.send(`<h3>Ошибка: ${err.message}</h3><a href="/admin">Назад</a>`);
      startSteamClient(username, password, shared_secret, games_to_farm);
      res.redirect('/admin');
    });
});

// API: Удаление
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
    return res.status(400).json({ success: false, error: 'Бот оффлайн.' });
  }

  community.redeemWalletCode(code, (err, walletBalance) => {
    if (err) return res.status(500).json({ success: false, error: err.message });
    res.json({ success: true, balance: walletBalance });
  });
});

function startSteamClient(username, password, sharedSecret, gamesToFarm) {
  const user = new SteamUser();
  const community = new SteamCommunity();
  
  const logInOptions = { accountName: username, password: password };
  if (sharedSecret) {
    logInOptions.twoFactorCode = SteamTotp.getAuthCode(sharedSecret);
  }

  user.logOn(logInOptions);

  user.on('loggedOn', () => {
    console.log(`[Core] Бот ${username} запущен.`);
    db.run(`UPDATE accounts SET status = 'online' WHERE username = ?`, [username]);
    
    const appIds = (gamesToFarm || '730').split(',').map(id => parseInt(id.trim())).filter(id => !isNaN(id));
    user.gamesPlayed(appIds);
  });

  user.on('webSession', (sessionID, cookies) => {
    community.setCookies(cookies);
    activeCommunities[username] = community;
  });

  user.on('error', (err) => {
    console.error(`[Error] ${username}:`, err.message);
    db.run(`UPDATE accounts SET status = 'offline' WHERE username = ?`, [username]);
  });
}

db.all(`SELECT username, password, shared_secret, games_to_farm FROM accounts`, [], (err, rows) => {
  if (!err && rows) {
    rows.forEach(acc => startSteamClient(acc.username, acc.password, acc.shared_secret, acc.games_to_farm));
  }
});

app.get('/', (req, res) => res.redirect('/admin'));

app.listen(PORT, () => console.log(`Монолитная панель инициализирована на порту ${PORT}`));
