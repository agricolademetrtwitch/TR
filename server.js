const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const SteamUser = require('steam-user');
const SteamCommunity = require('steamcommunity');
const SteamTotp = require('steam-totp');
const path = require('path');
const session = require('express-session');
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(session({
  secret: process.env.SESSION_SECRET || 'super-secret-key-agricolademetr',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false }
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// DB setup
const dbFile = process.env.RENDER ? '/opt/render/project/src/data.db' : path.join(__dirname, 'database.db');
const db = new sqlite3.Database(dbFile, err => {
  if (err) return console.error('DB connection error:', err.message);
  console.log('Connected to SQLite DB.');
});

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    shared_secret TEXT,
    cookies TEXT,
    status TEXT DEFAULT 'offline',
    farm_cards INTEGER DEFAULT 1,
    accept_gifts INTEGER DEFAULT 0,
    games_to_farm TEXT DEFAULT '730',
    dlcs TEXT DEFAULT '',
    sam_achievements INTEGER DEFAULT 0,
    drop_collected INTEGER DEFAULT 0
  )`);
});

const activeCommunities = new Map();
const activeClients = new Map();
const activeDrops = new Map();

// Middleware for admin auth
const isAdmin = (req, res, next) => {
  req.session.user === 'agricolademetr' ? next() : res.redirect('/login');
};

// Serve static files (manifest, lua scripts)
app.use('/files', express.static(path.join(__dirname, 'files')));

// Helper: parse game IDs
function parseGameIds(str) {
  if (!str) return [];
  return str.split(',')
    .map(s => parseInt(s.trim()))
    .filter(n => Number.isInteger(n) && n > 0);
}

// Login page
app.get('/login', (req, res) => {
  res.send(`
    <style>
      body {
        font-family: 'Segoe UI', Arial, sans-serif;
        background: #141414;
        color: #fff;
        display: flex;
        justify-content: center;
        align-items: center;
        height: 100vh;
        margin: 0;
      }
      .login-box {
        background: #1e1e1e;
        padding: 40px;
        border-radius: 4px;
        border-top: 3px solid #2bc0ec;
        box-shadow: 0 10px 25px rgba(0,0,0,0.5);
        width: 320px;
        text-align: center;
      }
      h2 {
        margin-bottom: 25px;
        font-weight: 300;
        letter-spacing: 1px;
        color: #2bc0ec;
      }
      input {
        width: 100%;
        padding: 12px;
        margin: 10px 0;
        border: 1px solid #2d2d2d;
        background: #252525;
        color: white;
        border-radius: 4px;
        box-sizing: border-box;
      }
      button {
        width: 100%;
        padding: 12px;
        background: #2bc0ec;
        border: none;
        color: #141414;
        border-radius: 4px;
        cursor: pointer;
        font-weight: bold;
        font-size: 14px;
        text-transform: uppercase;
      }
      button:hover {
        background: #23a1c6;
      }
    </style>
    <div class="login-box">
      <h2>ASF MONOLITH</h2>
      <form action="/login" method="POST" autocomplete="off">
        <input type="text" name="username" placeholder="Имя пользователя" required autocomplete="username">
        <input type="password" name="password" placeholder="Пароль доступа" required autocomplete="current-password">
        <button type="submit">Войти</button>
      </form>
    </div>
  `);
});

// Login POST
app.post('/login', (req, res) => {
  const { username, password } = req.body;
  const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'agricola1234';
  if (username === 'agricolademetr' && password === ADMIN_PASSWORD) {
    req.session.user = 'agricolademetr';
    return res.redirect('/admin');
  }
  res.status(401).send('<h3>Доступ отклонен.</h3><a href="/login">Повторить попытку</a>');
});

// Logout route
app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// Admin dashboard with SAM, Drop, DLC, and terminal section
app.get('/admin', isAdmin, (req, res) => {
  db.all(`SELECT * FROM accounts ORDER BY id ASC`, [], (err, accounts) => {
    if (err) return res.status(500).send('Ошибка БД');

    const rowsHtml = accounts.length ? accounts.map(acc => `
      <tr class="${acc.status}">
        <td>#${acc.id}</td>
        <td><strong style="color: #fff;">${acc.username}</strong></td>
        <td><span class="badge-status ${acc.status}">${acc.status}</span></td>
        <td><code>${acc.games_to_farm}</code></td>
        <td>${acc.farm_cards ? '🟢 Да' : '❌ Нет'}</td>
        <td>${acc.accept_gifts ? '🟢 Да' : '❌ Нет'}</td>
        <td>${acc.sam_achievements || 0}</td>
        <td>${acc.drop_collected ? '✔️' : '❌'}</td>
        <td>${acc.dlcs ? acc.dlcs.split(',').map(d=>`<code>${d.trim()}</code>`).join(' ') : 'Нет'}</td>
        <td>
          <div class="list-actions">
            <input type="text" id="code-${acc.id}" placeholder="Steam Wallet Code" autocomplete="off" />
            <button class="btn-action btn-blue" onclick="redeemCode(${acc.id}, '${acc.username}')">Пополнить</button>
            <button class="btn-action btn-red" onclick="deleteAccount(${acc.id}, '${acc.username}')">Удалить</button>
          </div>
        </td>
      </tr>
    `).join('') : `
      <tr>
        <td colspan="10" style="text-align:center; padding: 30px; color: #aaa;">Боты не добавлены.</td>
      </tr>`;

    // List manifest and lua scripts
    const manifestFile = '/files/manifest.json';
    let luaFiles = [];
    try {
      luaFiles = fs.readdirSync(path.join(__dirname, 'files')).filter(f => f.endsWith('.lua'));
    } catch {}

    const luaLinksHtml = luaFiles.length ? luaFiles.map(f => `<li><a href="/files/${f}" download>${f}</a></li>`).join('') : '<li>Lua скрипты отсутствуют</li>';

    res.send(`
    <!DOCTYPE html>
    <html lang="ru">
    <head>
      <meta charset="UTF-8" />
      <title>ASF Monolith Dashboard</title>
      <style>
        body {
          font-family: 'Segoe UI', Arial, sans-serif;
          background: #141414;
          color: #d1d4d6;
          margin: 0;
          padding: 0;
          display: flex;
          justify-content: center;
          overflow-y: auto;
        }
        .container {
          width: 100%;
          max-width: 1200px;
          padding: 30px 20px;
        }
        header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 30px;
          border-bottom: 1px solid #2d2d2d;
          padding-bottom: 15px;
        }
        header h1 {
          margin: 0;
          font-size: 24px;
          color: #2bc0ec;
          font-weight: 400;
        }
        .admin-info {
          display: flex;
          align-items: center;
          gap: 15px;
          font-size: 14px;
        }
        .logout-btn {
          color: #e74c3c;
          text-decoration: none;
          font-weight: bold;
          border: 1px solid #e74c3c;
          padding: 4px 12px;
          border-radius: 4px;
          transition: 0.2s;
        }
        .logout-btn:hover {
          background: #e74c3c;
          color: #141414;
        }
        .asf-form {
          background: #1e1e1e;
          border: 1px solid #2d2d2d;
          border-radius: 4px;
          padding: 20px;
          margin-bottom: 40px;
          border-top: 3px solid #2ecc71;
        }
        .asf-form h3 {
          margin-top: 0;
          color: #fff;
          font-weight: 400;
          font-size: 16px;
          margin-bottom: 15px;
        }
        .form-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
          gap: 15px;
        }
        .form-group {
          display: flex;
          flex-direction: column;
          gap: 5px;
        }
        .form-group label {
          font-size: 11px;
          color: #a0a0a0;
          text-transform: uppercase;
          font-weight: bold;
        }
        .asf-form input, .asf-form select {
          background: #252525;
          border: 1px solid #2d2d2d;
          color: white;
          padding: 8px 12px;
          border-radius: 4px;
          font-size: 13px;
        }
        .asf-form input:focus, .asf-form select:focus {
          border-color: #2bc0ec;
          outline: none;
        }
        .btn-submit {
          background: #2ecc71;
          color: #141414;
          border: none;
          padding: 10px 20px;
          border-radius: 4px;
          cursor: pointer;
          font-weight: bold;
          text-transform: uppercase;
          font-size: 12px;
          align-self: flex-end;
          height: 38px;
        }
        .btn-submit:hover {
          background: #27ae60;
        }
        .list-section h3 {
          font-weight: 400;
          color: #fff;
          margin-bottom: 15px;
        }
        table {
          width: 100%;
          border-collapse: collapse;
          background: #1e1e1e;
          border: 1px solid #2d2d2d;
          border-radius: 4px;
          overflow: hidden;
        }
        th, td {
          padding: 12px 15px;
          text-align: left;
          font-size: 14px;
          border-bottom: 1px solid #2d2d2d;
          white-space: nowrap;
        }
        th {
          background: #252525;
          color: #2bc0ec;
          font-weight: 600;
          text-transform: uppercase;
          font-size: 11px;
          letter-spacing: 0.5px;
        }
        tr.online {
          border-left: 3px solid #2ecc71;
        }
        tr.offline {
          border-left: 3px solid #e74c3c;
        }
        .badge-status {
          font-size: 11px;
          text-transform: uppercase;
          padding: 2px 6px;
          border-radius: 3px;
          font-weight: bold;
          user-select: none;
        }
        .badge-status.online {
          background: rgba(46, 204, 113, 0.15);
          color: #2ecc71;
        }
        .badge-status.offline {
          background: rgba(231, 76, 60, 0.15);
          color: #e74c3c;
        }
        .list-actions {
          display: flex;
          align-items: center;
          gap: 8px;
        }
        .list-actions input {
          background: #252525;
          border: 1px solid #2d2d2d;
          color: white;
          padding: 5px 10px;
          border-radius: 4px;
          font-size: 12px;
          width: 140px;
          user-select: text;
          white-space: nowrap;
        }
        .btn-action {
          border: none;
          padding: 6px 12px;
          border-radius: 4px;
          cursor: pointer;
          font-size: 12px;
          font-weight: bold;
          transition: 0.15s;
          user-select: none;
        }
        .btn-blue {
          background: #2bc0ec;
          color: #141414;
        }
        .btn-blue:hover {
          background: #23a1c6;
        }
        .btn-red {
          background: rgba(231, 76, 60, 0.15);
          color: #e74c3c;
          border: 1px solid #e74c3c;
        }
        .btn-red:hover {
          background: #e74c3c;
          color: #141414;
        }
        /* Terminal styles */
        #terminal {
          background: #111;
          color: #0f0;
          font-family: monospace;
          height: 300px;
          overflow-y: auto;
          margin-top: 30px;
          padding: 10px;
          border-radius: 4px;
          border: 1px solid #2d2d2d;
          white-space: pre-wrap;
        }
        #terminal-input {
          margin-top: 10px;
          width: 100%;
          background: #252525;
          border: 1px solid #2d2d2d;
          color: #0f0;
          font-family: monospace;
          padding: 8px 12px;
          border-radius: 4px;
          box-sizing: border-box;
        }
        #terminal-controls {
          margin-top: 8px;
          font-size: 12px;
          color: #888;
        }
        .downloads {
          margin-top: 20px;
          color: #fff;
        }
        .downloads ul {
          list-style: none;
          padding-left: 0;
        }
        .downloads a {
          color: #2bc0ec;
          text-decoration: none;
        }
        .downloads a:hover {
          text-decoration: underline;
        }
      </style>
    </head>
    <body>
      <div class="container" role="main">
        <header>
          <h1>ASF Monolith Dashboard</h1>
          <div class="admin-info">
            <span>👤 Админ: <strong>agricolademetr</strong></span>
            <a href="/logout" class="logout-btn" title="Выйти">Выйти</a>
          </div>
        </header>

        <section class="asf-form" aria-label="Добавление бота">
          <h3>⚙️ Добавить и настроить конфигурацию нового бота</h3>
          <form action="/admin/add" method="POST" class="form-grid" autocomplete="off" novalidate>
            <div class="form-group">
              <label for="username">Логин Steam</label>
              <input id="username" name="username" type="text" placeholder="Логин" required>
            </div>
            <div class="form-group">
              <label for="password">Пароль Steam</label>
              <input id="password" name="password" type="password" placeholder="Пароль" required>
            </div>
            <div class="form-group">
              <label for="shared_secret">Shared Secret (2FA)</label>
              <input id="shared_secret" name="shared_secret" type="text" placeholder="Из maFile">
            </div>
            <div class="form-group">
              <label for="farm_cards">Фарм карт</label>
              <select id="farm_cards" name="farm_cards" required>
                <option value="1" selected>Да (Включен)</option>
                <option value="0">Нет (Выключен)</option>
              </select>
            </div>
            <div class="form-group">
              <label for="accept_gifts">Прием подарков</label>
              <select id="accept_gifts" name="accept_gifts" required>
                <option value="0" selected>Нет (Игнорировать)</option>
                <option value="1">Да (Принимать)</option>
              </select>
            </div>
            <div class="form-group">
              <label for="games_to_farm">ID Игр для фарма</label>
              <input id="games_to_farm" name="games_to_farm" type="text" value="730" placeholder="730,440">
            </div>
            <button type="submit" class="btn-submit">Запустить</button>
          </form>
        </section>

        <section class="list-section" aria-label="Список ботов">
          <h3>📋 Подключенные боты пула с SAM, Drop и DLC</h3>
          <table role="grid" cellspacing="0" cellpadding="0" aria-describedby="botListDesc">
            <caption id="botListDesc">Список Steam ботов с состоянием</caption>
            <thead>
              <tr>
                <th>ID</th>
                <th>Логин</th>
                <th>Статус</th>
                <th>Игры</th>
                <th>Фарм карт</th>
                <th>Гифты</th>
                <th>SAM Ach.</th>
                <th>Drop</th>
                <th>DLC Unlock</th>
                <th>Управление</th>
              </tr>
            </thead>
            <tbody>
              ${rowsHtml}
            </tbody>
          </table>
        </section>

        <section class="downloads" aria-label="Манифест и скрипты">
          <h3>📁 Манифест и Lua скрипты для скачивания</h3>
          <p><a href="${manifestFile}" download>manifest.json</a></p>
          <ul>${luaLinksHtml}</ul>
        </section>

        <section aria-label="ИИ-Терминал управления ботами">
          <h3>🤖 Терминал</h3>
          <div id="terminal" aria-live="polite" role="log"></div>
          <input id="terminal-input" type="text" placeholder="Введите команду, например: help" aria-label="Ввод команд" autofocus autocomplete="off" spellcheck="false" />
          <div id="terminal-controls">
            Команды: <strong>help</strong>, <strong>list</strong>, <strong>status [username]</strong>, <strong>restart [username]</strong>, <strong>logout [username]</strong>, <strong>farmgames [username] [ids]</strong>, <strong>redeem [username] [code]</strong>, <strong>unlockdlc [username] [dlcids]</strong>, <strong>samadd [username] [count]</strong>, <strong>dropcollected [username]</strong>, <strong>clear</strong>
          </div>
        </section>
      </div>

      <script>
        const terminal = document.getElementById('terminal');
        const input = document.getElementById('terminal-input');
        const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const ws = new WebSocket(wsProtocol + '//' + location.host + '/terminal');

        function printToTerminal(text = '', isError = false) {
          const span = document.createElement('span');
          span.textContent = text + '\\n';
          if (isError) span.style.color = '#f55';
          terminal.appendChild(span);
          terminal.scrollTop = terminal.scrollHeight;
        }

        ws.addEventListener('open', () => {
          printToTerminal('🤖 Терминал подключен. Введите "help" для списка команд.');
        });

        ws.addEventListener('message', e => {
          try {
            const data = JSON.parse(e.data);
            if (data.clear) terminal.textContent = '';
            if (data.output) printToTerminal(data.output, data.error);
            else printToTerminal(e.data);
          } catch {
            printToTerminal(e.data);
          }
        });

        ws.addEventListener('close', () => printToTerminal('❌ Терминал отключён.', true));
        ws.addEventListener('error', () => printToTerminal('⚠ Ошибка соединения терминала.', true));

        input.addEventListener('keydown', e => {
          if (e.key === 'Enter') {
            const cmd = input.value.trim();
            if (!cmd) return;
            printToTerminal('> ' + cmd);
            ws.send(JSON.stringify({command: cmd}));
            input.value = '';
          }
        });

        async function deleteAccount(id) {
          if (!confirm('Удалить бота с ID #' + id + '?')) return;
          try {
            const res = await fetch('/admin/delete/' + id, { method: 'DELETE' });
            const data = await res.json();
            if(data.success) location.reload();
            else alert('Ошибка при удалении');
          } catch {
            alert('Ошибка сети');
          }
        }

        async function redeemCode(id, username) {
          const inp = document.getElementById('code-' + id);
          const code = inp.value.trim();
          if (!code) return alert('Введите Wallet Code!');
          try {
            const res = await fetch('/admin/redeem', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ username, code })
            });
            const data = await res.json();
            if (data.success) {
              alert('Код активирован на ' + username + '. Баланс: ' + data.balance);
              inp.value = '';
            } else {
              alert('Ошибка: ' + data.error);
            }
          } catch {
            alert('Ошибка сети');
          }
        }
      </script>
    </body>
    </html>
    `);
  });
});

// Add bot
app.post('/admin/add', isAdmin, (req, res) => {
  const {
    username,
    password,
    shared_secret = null,
    farm_cards = '1',
    accept_gifts = '0',
    games_to_farm = '730'
  } = req.body;

  db.run(
    `INSERT INTO accounts (username, password, shared_secret, farm_cards, accept_gifts, games_to_farm)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [username, password, shared_secret, +farm_cards, +accept_gifts, games_to_farm],
    err => {
      if (err) {
        res.status(400).send(`<h3>Ошибка: ${err.message}</h3><a href="/admin">Назад</a>`);
      } else {
        startSteamClient(username, password, shared_secret, games_to_farm);
        res.redirect('/admin');
      }
    }
  );
});

// Delete bot
app.delete('/admin/delete/:id', isAdmin, (req, res) => {
  const id = req.params.id;
  db.get(`SELECT username FROM accounts WHERE id = ?`, [id], (err, row) => {
    if (err || !row) return res.status(404).json({ success: false, error: "Бот не найден" });
    const username = row.username;
    db.run(`DELETE FROM accounts WHERE id = ?`, [id], err => {
      if (err) return res.status(500).json({ success: false });
      const client = activeClients.get(username);
      if (client) {
        client.logOff();
        activeClients.delete(username);
      }
      activeCommunities.delete(username);
      activeDrops.delete(username);
      res.json({ success: true });
    });
  });
});

// Redeem wallet code
app.post('/admin/redeem', isAdmin, (req, res) => {
  const { username, code } = req.body;
  const community = activeCommunities.get(username);
  if (!community) {
    return res.status(400).json({ success: false, error: 'Бот оффлайн.' });
  }
  community.redeemWalletCode(code, (err, walletBalance) => {
    if (err) return res.status(500).json({ success: false, error: err.message });
    res.json({ success: true, balance: walletBalance });
  });
});

// DLC unlocker
app.post('/admin/unlockdlc', isAdmin, (req, res) => {
  const { username, dlcids } = req.body;
  if (!username || !dlcids) return res.status(400).json({ success: false, error: 'Не указан username или dlcids' });
  const cleanedDLCs = dlcids.split(',').map(s => s.trim()).filter(Boolean).join(',');
  db.get(`SELECT dlcs FROM accounts WHERE username=?`, [username], (err, row) => {
    if (err || !row) return res.status(404).json({ success: false, error: 'Бот не найден' });
    const existing = row.dlcs ? row.dlcs.split(',').map(s => s.trim()) : [];
    const newSet = new Set(existing);
    cleanedDLCs.split(',').forEach(dlc => newSet.add(dlc));
    const updated = [...newSet].join(',');
    db.run(`UPDATE accounts SET dlcs=? WHERE username=?`, [updated, username], err2 => {
      if (err2) return res.status(500).json({ success: false, error: err2.message });
      res.json({ success: true, unlocked: updated });
    });
  });
});

// Add SAM achievements count
app.post('/admin/samadd', isAdmin, (req, res) => {
  const { username, count } = req.body;
  const countNum = parseInt(count);
  if (!username || isNaN(countNum) || countNum<=0) return res.status(400).json({ success: false, error: 'Неверные параметры' });
  db.get(`SELECT sam_achievements FROM accounts WHERE username=?`, [username], (err, row) => {
    if (err || !row) return res.status(404).json({ success: false, error: 'Бот не найден' });
    const current = row.sam_achievements || 0;
    const updated = current + countNum;
    db.run(`UPDATE accounts SET sam_achievements=? WHERE username=?`, [updated, username], err2 => {
      if (err2) return res.status(500).json({ success: false, error: err2.message });
      res.json({ success: true, total: updated });
    });
  });
});

// Mark Drop collected for a bot
app.post('/admin/dropcollected', isAdmin, (req, res) => {
  const { username } = req.body;
  if (!username) return res.status(400).json({ success: false, error: 'Не указан username' });
  db.get(`SELECT drop_collected FROM accounts WHERE username=?`, [username], (err, row) => {
    if (err || !row) return res.status(404).json({ success: false, error: 'Бот не найден' });
    if (row.drop_collected) return res.json({ success: true, message: 'Уже отмечено' });
    db.run(`UPDATE accounts SET drop_collected=1 WHERE username=?`, [username], err2 => {
      if (err2) return res.status(500).json({ success: false, error: err2.message });
      activeDrops.set(username, true);
      res.json({ success: true, message: 'Отмечено, что дроп собран' });
    });
  });
});

// Start steam client and community sessions for bots
function startSteamClient(username, password, sharedSecret, gamesToFarm) {
  if (activeClients.has(username)) return; // already started
  const user = new SteamUser();
  const community = new SteamCommunity();

  const logOnOptions = { accountName: username, password };
  if (sharedSecret && sharedSecret.trim()) logOnOptions.twoFactorCode = SteamTotp.getAuthCode(sharedSecret);

  user.logOn(logOnOptions);

  user.on('loggedOn', () => {
    console.log(`[Core] Бот ${username} запущен.`);
    db.run(`UPDATE accounts SET status='online' WHERE username=?`, username);
    const appIds = parseGameIds(gamesToFarm);
    user.gamesPlayed(appIds.length ? appIds : [730]);
  });

  user.on('webSession', (sessionID, cookies) => {
    community.setCookies(cookies);
    activeCommunities.set(username, community);
  });

  user.on('newItems', (count) => {
    // For demo purposes: count newItems as drop collected increment SAM
    if (!activeDrops.get(username)) {
      activeDrops.set(username, true);
      db.get(`SELECT sam_achievements FROM accounts WHERE username=?`, [username], (err, row) => {
        if (!err && row) {
          const current = row.sam_achievements || 0;
          const updated = current + count;
          db.run(`UPDATE accounts SET sam_achievements=? WHERE username=?`, [updated, username]);
        }
      });
    }
  });

  user.on('error', err => {
    console.error(`[Error] ${username}: ${err.message}`);
    db.run(`UPDATE accounts SET status='offline' WHERE username=?`, username);
    activeCommunities.delete(username);
    activeClients.delete(username);
    activeDrops.delete(username);
  });

  user.on('disconnected', (eresult, msg) => {
    console.warn(`[Disconnected] ${username}: ${msg || 'No message'} (Error code: ${eresult})`);
    db.run(`UPDATE accounts SET status='offline' WHERE username=?`, username);
    activeCommunities.delete(username);
    activeClients.delete(username);
    activeDrops.delete(username);
  });

  activeClients.set(username, user);
}

// Restore bots on startup
db.all(`SELECT username, password, shared_secret, games_to_farm FROM accounts WHERE status IN ('online', 'offline')`, [], (err, bots) => {
  if (err) return;
  bots.forEach(bot => {
    startSteamClient(bot.username, bot.password, bot.shared_secret, bot.games_to_farm);
  });
});

// HTTP and WebSocket server for terminal
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true, path: '/terminal' });

server.on('upgrade', (request, socket, head) => {
  const cookie = request.headers.cookie || '';
  // Accept WS only if session cookie 'connect.sid' exists
  if (cookie.includes('connect.sid')) {
    wss.handleUpgrade(request, socket, head, ws => {
      wss.emit('connection', ws, request);
    });
  } else {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
  }
});

wss.on('connection', (ws) => {
  ws.isAlive = true;

  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', message => {
    let msg;
    try {
      msg = JSON.parse(message);
    } catch {
      sendTerminalJSON(ws, {output: "Ошибка: неверный JSON формат", error: true});
      return;
    }
    if (!msg.command) {
      sendTerminalJSON(ws, {output: "Ошибка: отсутствует команда", error: true});
      return;
    }
    executeCommand(ws, msg.command.trim());
  });
});

setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

function sendTerminalJSON(ws, obj) {
  ws.send(JSON.stringify(obj));
}

async function executeCommand(ws, commandLine) {
  const args = commandLine.split(/\s+/);
  const cmd = args.shift().toLowerCase();

  const sendOutput = (text, err = false) => sendTerminalJSON(ws, { output: text, error: err });

  switch(cmd) {
    case 'help':
      sendOutput(
        `Доступные команды:
help - помощь
list - список ботов
status <username> - состояние бота
restart <username> - перезапуск бота
logout <username> - отключить бота
farmgames <username> <ids> - изменить фарм игры
redeem <username> <code> - активировать код
unlockdlc <username> <dlcids> - добавить DLC
samadd <username> <count> - добавить SAM ачивки
dropcollected <username> - пометить дроп собранным
clear - очистить экран`
      );
      break;

    case 'list':
      {
        const bots = await new Promise(res => db.all(`SELECT username, status FROM accounts ORDER BY id ASC`, [], (e,r) => e ? res([]) : res(r)));
        if (!bots.length) sendOutput('Нет ботов');
        else sendOutput('Боты:\n' + bots.map(b => `- ${b.username} : ${b.status}`).join('\n'));
      }
      break;

    case 'status':
      {
        const username = args[0];
        if (!username) return sendOutput('Использование: status <username>', true);
        const bot = await new Promise(res => db.get(`SELECT * FROM accounts WHERE username=?`, [username], (e,r) => e ? res(null) : res(r)));
        if (!bot) return sendOutput(`Бот ${username} не найден`, true);
        sendOutput(
          `Статус ${username}:
ID: ${bot.id}
Статус: ${bot.status === 'online' ? '🟢 Онлайн' : '🔴 Оффлайн'}
Farm cards: ${bot.farm_cards ? 'Да' : 'Нет'}
Accept gifts: ${bot.accept_gifts ? 'Да' : 'Нет'}
Games to farm: ${bot.games_to_farm}
SAM Achievements: ${bot.sam_achievements || 0}
Drop Collected: ${bot.drop_collected ? 'Да' : 'Нет'}
DLC Unlock: ${bot.dlcs || 'Нет'}`
        );
      }
      break;

    case 'restart':
      {
        const username = args[0];
        if (!username) return sendOutput('Использование: restart <username>', true);
        const client = activeClients.get(username);
        if (!client) return sendOutput(`Бот ${username} не активен`, true);
        client.logOff();
        db.get(`SELECT password, shared_secret, games_to_farm FROM accounts WHERE username=?`, [username], (err, row) => {
          if (row) {
            startSteamClient(username, row.password, row.shared_secret, row.games_to_farm);
            sendOutput(`Бот ${username} перезапущен.`);
          } else {
            sendOutput(`Бот ${username} не найден в базе`, true);
          }
        });
      }
      break;

    case 'logout':
      {
        const username = args[0];
        if (!username) return sendOutput('Использование: logout <username>', true);
        const client = activeClients.get(username);
        if (!client) return sendOutput(`Бот ${username} не активен`, true);
        client.logOff();
        sendOutput(`Бот ${username} отключён.`);
      }
      break;

    case 'farmgames':
      {
        const [username, ...gameIds] = args;
        if (!username || !gameIds.length) return sendOutput('Использование: farmgames <username> <appids>', true);
        const newGames = gameIds.join(' ');
        db.run(`UPDATE accounts SET games_to_farm=? WHERE username=?`, [newGames, username], err => {
          if (err) return sendOutput('Ошибка обновления игр', true);
          const client = activeClients.get(username);
          if (client) {
            const appIds = parseGameIds(newGames);
            if (appIds.length) {
              client.gamesPlayed(appIds);
              sendOutput(`Игры для фарма у ${username} обновлены.`);
            } else {
              sendOutput('Неверный список игр.', true);
            }
          } else {
            sendOutput(`Бот ${username} оффлайн, обновлено в базе.`);
          }
        });
      }
      break;

    case 'redeem':
      {
        const [username, ...codeParts] = args;
        const code = codeParts.join(' ');
        if (!username || !code) return sendOutput('Использование: redeem <username> <code>', true);
        const community = activeCommunities.get(username);
        if (!community) return sendOutput(`Бот ${username} оффлайн`, true);
        community.redeemWalletCode(code, (err, walletBalance) => {
          if (err) sendOutput(`Ошибка активирования кода: ${err.message}`, true);
          else sendOutput(`Код активирован для ${username}. Баланс: ${walletBalance}`);
        });
      }
      break;

    case 'unlockdlc':
      {
        const [username, ...dlcidsArr] = args;
        const dlcids = dlcidsArr.join(' ');
        if (!username || !dlcids) return sendOutput('Использование: unlockdlc <username> <dlcids>', true);
        const cleanedDLCs = dlcids.split(',').map(s => s.trim()).filter(Boolean).join(',');
        db.get(`SELECT dlcs FROM accounts WHERE username=?`, [username], (err, row) => {
          if (err || !row) return sendOutput('Бот не найден', true);
          const existing = row.dlcs ? row.dlcs.split(',').map(s => s.trim()) : [];
          const newSet = new Set(existing);
          cleanedDLCs.split(',').forEach(dlc => newSet.add(dlc));
          const updated = [...newSet].join(',');
          db.run(`UPDATE accounts SET dlcs=? WHERE username=?`, [updated, username], err2 => {
            if (err2) return sendOutput('Ошибка добавления DLC: ' + err2.message, true);
            sendOutput(`DLC (${dlcids}) успешно добавлены для ${username}.`);
          });
        });
      }
      break;

    case 'samadd':
      {
        const [username, countStr] = args;
        const count = parseInt(countStr);
        if (!username || isNaN(count) || count<=0) return sendOutput('Использование: samadd <username> <count>', true);
        db.get(`SELECT sam_achievements FROM accounts WHERE username=?`, [username], (err, row) => {
          if (err || !row) return sendOutput('Бот не найден', true);
          const current = row.sam_achievements || 0;
          const updated = current + count;
          db.run(`UPDATE accounts SET sam_achievements=? WHERE username=?`, [updated, username], err2 => {
            if (err2) return sendOutput('Ошибка обновления SAM: ' + err2.message, true);
            sendOutput(`SAM ачивки пользователя ${username} обновлены: всего ${updated}.`);
          });
        });
      }
      break;

    case 'dropcollected':
      {
        const username = args[0];
        if (!username) return sendOutput('Использование: dropcollected <username>', true);
        db.get(`SELECT drop_collected FROM accounts WHERE username=?`, [username], (err, row) => {
          if (err || !row) return sendOutput('Бот не найден', true);
          if (row.drop_collected) return sendOutput(`Дроп уже отмечен за ${username}.`);
          db.run(`UPDATE accounts SET drop_collected=1 WHERE username=?`, [username], err2 => {
            if (err2) return sendOutput('Ошибка отметки дропа: ' + err2.message, true);
            activeDrops.set(username, true);
            sendOutput(`Отмечено, что дроп собран для ${username}.`);
          });
        });
      }
      break;

    case 'clear':
      sendTerminalJSON(ws, {clear: true});
      break;

    default:
      sendOutput(`Неизвестная команда: ${cmd}. Введите 'help' для списка.`, true);
  }
}

app.get('/', (_, res) => res.redirect('/admin'));
server.listen(PORT, () => console.log(`Монолитная панель инициализирована на порту ${PORT}`));

/* ==== Helper to start bots ==== */
function startSteamClient(username, password, sharedSecret, gamesToFarm) {
  if (activeClients.has(username)) return;
  const user = new SteamUser();
  const community = new SteamCommunity();
  const logOnOptions = { accountName: username, password };
  if (sharedSecret && sharedSecret.trim()) logOnOptions.twoFactorCode = SteamTotp.getAuthCode(sharedSecret);
  user.logOn(logOnOptions);

  user.on('loggedOn', () => {
    console.log(`[Core] Бот ${username} запущен.`);
    db.run(`UPDATE accounts SET status='online' WHERE username=?`, username);
    const appIds = parseGameIds(gamesToFarm);
    user.gamesPlayed(appIds.length ? appIds : [730]);
  });

  user.on('webSession', (sessionID, cookies) => {
    community.setCookies(cookies);
    activeCommunities.set(username, community);
  });

  user.on('newItems', (count) => {
    if (!activeDrops.get(username)) {
      activeDrops.set(username, true);
      db.get(`SELECT sam_achievements FROM accounts WHERE username=?`, [username], (err, row) => {
        if (!err && row) {
          const current = row.sam_achievements || 0;
          const updated = current + count;
          db.run(`UPDATE accounts SET sam_achievements=? WHERE username=?`, [updated, username]);
        }
      });
    }
  });

  user.on('error', err => {
    console.error(`[Error] ${username}: ${err.message}`);
    db.run(`UPDATE accounts SET status='offline' WHERE username=?`, username);
    activeCommunities.delete(username);
    activeClients.delete(username);
    activeDrops.delete(username);
  });

  user.on('disconnected', (eresult, msg) => {
    console.warn(`[Disconnected] ${username}: ${msg || 'No message'} (Code: ${eresult})`);
    db.run(`UPDATE accounts SET status='offline' WHERE username=?`, username);
    activeCommunities.delete(username);
    activeClients.delete(username);
    activeDrops.delete(username);
  });

  activeClients.set(username, user);
}

// Restore bots on startup
db.all(`SELECT username, password, shared_secret, games_to_farm FROM accounts`, [], (err, bots) => {
  if (err) return;
  bots.forEach(bot => startSteamClient(bot.username, bot.password, bot.shared_secret, bot.games_to_farm));
});

// Start HTTP + WS server (websocket path is /terminal)
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true, path: '/terminal' });

server.on('upgrade', (req, socket, head) => {
  const cookie = req.headers.cookie || '';
  if (cookie.includes('connect.sid')) {
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  } else {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
  }
});

wss.on('connection', (ws) => {
  ws.isAlive = true;

  ws.on('pong', () => ws.isAlive = true);

  ws.on('message', msg => {
    let data;
    try {
      data = JSON.parse(msg);
    } catch {
      sendTerminalJSON(ws, {output: "Неверный формат JSON", error: true});
      return;
    }
    if (!data.command) {
      sendTerminalJSON(ws, {output: "Команда отсутствует", error: true});
      return;
    }
    executeCommand(ws, data.command.trim());
  });
});

setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);
