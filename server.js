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
    games_to_farm TEXT DEFAULT '730'
  )`);
});

const activeCommunities = new Map();
const activeClients = new Map();  // username => SteamUser

// Middleware for admin auth
const isAdmin = (req, res, next) => {
  req.session.user === 'agricolademetr' ? next() : res.redirect('/login');
};

// Static files for manifest and Lua scripts (for example - place your files in /files dir)
app.use('/files', express.static(path.join(__dirname, 'files')));

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

// Logout
app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// Admin dashboard with terminal and manifest/scripts download
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
        <td colspan="7" style="text-align:center; padding: 30px; color: #aaa;">
          Боты не добавлены. Заполните форму генератора выше.
        </td>
      </tr>`;

    // Minimal list of manifest and Lua scripts available for download from /files
    // Place your manifest.json and .lua scripts inside /files folder
    const manifestFile = '/files/manifest.json';
    const luaFiles = fs.existsSync(path.join(__dirname, 'files')) ? 
      fs.readdirSync(path.join(__dirname, 'files')).filter(f => f.endsWith('.lua')) : [];

    const luaLinksHtml = luaFiles.length ? luaFiles.map(file => 
      `<li><a href="/files/${file}" download>${file}</a></li>`).join('') : '<li>Lua скрипты отсутствуют</li>';

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

          @media (max-width: 600px) {
            .form-grid {
              grid-template-columns: 1fr;
            }
          }
        </style>
      </head>
      <body>
        <div class="container" role="main" aria-label="Панель Администратора">
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
            <h3>📋 Подключенные боты пула</h3>
            <table role="grid" cellspacing="0" cellpadding="0" aria-describedby="botListDesc">
              <caption id="botListDesc" class="sr-only">Список Steam ботов с состоянием</caption>
              <thead>
                <tr>
                  <th scope="col" style="width: 60px;">ID</th>
                  <th scope="col">Логин Steam</th>
                  <th scope="col" style="width: 100px;">Статус</th>
                  <th scope="col">ID Игр накрутки</th>
                  <th scope="col" style="width: 100px;">Фарм карт</th>
                  <th scope="col" style="width: 100px;">Гифты</th>
                  <th scope="col" style="width: 420px;">Управление и Активация кодов</th>
                </tr>
              </thead>
              <tbody>
                ${rowsHtml}
              </tbody>
            </table>
          </section>

          <section class="downloads" aria-label="Загрузки">
            <h3>📁 Манифест и Lua скрипты</h3>
            <p><a href="${manifestFile}" download>manifest.json</a></p>
            <ul>${luaLinksHtml}</ul>
          </section>

          <section aria-label="Терминал управления ботами">
            <h3>💻 Консоль терминала</h3>
            <div id="terminal" aria-live="polite" role="log"></div>
            <input id="terminal-input" type="text" placeholder="Введите команду, например: status username или help" aria-label="Ввод команд для терминала (например: help)">
            <div id="terminal-controls">
              Команды: <strong>help</strong>, <strong>status [username]</strong>, <strong>list</strong>, <strong>restart [username]</strong>, <strong>logout [username]</strong>, <strong>farmgames [username] [ids]</strong>
            </div>
          </section>
        </div>

        <script>
          const terminal = document.getElementById('terminal');
          const terminalInput = document.getElementById('terminal-input');

          // Enable WebSocket for terminal commands
          const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
          const ws = new WebSocket(wsProtocol + '//' + location.host + '/terminal');

          function printToTerminal(text, isError = false) {
            const span = document.createElement('span');
            span.textContent = text + '\\n';
            if (isError) span.style.color = '#f55';
            terminal.appendChild(span);
            terminal.scrollTop = terminal.scrollHeight;
          }

          ws.onopen = () => {
            printToTerminal('Terminal подключен. Введите "help" для списка команд.');
          };

          ws.onmessage = (event) => {
            try {
              const data = JSON.parse(event.data);
              if (data.output) printToTerminal(data.output, data.error);
              else printToTerminal(event.data);
            } catch {
              printToTerminal(event.data);
            }
          };

          ws.onclose = () => printToTerminal('Terminal отключён.', true);
          ws.onerror = () => printToTerminal('Ошибка соединения терминала.', true);

          terminalInput.addEventListener('keydown', e => {
            if (e.key === 'Enter') {
              const input = terminalInput.value.trim();
              if (!input) return;
              printToTerminal('> ' + input);
              ws.send(JSON.stringify({command: input}));
              terminalInput.value = '';
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
            const input = document.getElementById('code-' + id);
            const code = input.value.trim();
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
                input.value = '';
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
      // Stop and cleanup bot
      const client = activeClients.get(username);
      if (client) {
        client.logOff();
        activeClients.delete(username);
      }
      activeCommunities.delete(username);
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

// Start steam client and community sessions for bots
function startSteamClient(username, password, sharedSecret, gamesToFarm) {
  if (activeClients.has(username)) {
    // Already started
    return;
  }
  const user = new SteamUser();
  const community = new SteamCommunity();

  const logOnOptions = { accountName: username, password };
  if (sharedSecret && sharedSecret.trim()) logOnOptions.twoFactorCode = SteamTotp.getAuthCode(sharedSecret);

  user.logOn(logOnOptions);

  user.on('loggedOn', () => {
    console.log(`[Core] Бот ${username} запущен.`);
    db.run(`UPDATE accounts SET status='online' WHERE username=?`, username);
    const appIds = (gamesToFarm || '730').split(',')
      .map(s => parseInt(s.trim()))
      .filter(n => Number.isInteger(n) && n>0);
    user.gamesPlayed(appIds.length ? appIds : [730]);
  });

  user.on('webSession', (sessionID, cookies) => {
    community.setCookies(cookies);
    activeCommunities.set(username, community);
  });

  user.on('error', err => {
    console.error(`[Error] ${username}: ${err.message}`);
    db.run(`UPDATE accounts SET status='offline' WHERE username=?`, username);
    activeCommunities.delete(username);
    activeClients.delete(username);
  });

  user.on('disconnected', (eresult, msg) => {
    console.warn(`[Disconnected] ${username}: ${msg || 'No message'} (Error code: ${eresult})`);
    db.run(`UPDATE accounts SET status='offline' WHERE username=?`, username);
    activeCommunities.delete(username);
    activeClients.delete(username);
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

// HTTP server and WebSocket server for terminal
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true, path: '/terminal' });

server.on('upgrade', (request, socket, head) => {
  // Simple auth check for terminal WS to ensure session exists
  // We will parse cookie to check session manually because express-session not bound here
  // For simplicity, accept all connections with cookie containing 'connect.sid' (standard)
  const cookie = request.headers.cookie || '';
  if (cookie.includes('connect.sid')) {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  } else {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
  }
});

wss.on('connection', (ws, request) => {
  ws.isAlive = true;

  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', message => {
    try {
      const msg = JSON.parse(message);
      if (!msg.command) {
        ws.send(JSON.stringify({output: 'Нет команды для выполнения', error: true}));
        return;
      }
      const [cmd, ...args] = msg.command.trim().split(/\s+/);
      handleCommand(ws, cmd.toLowerCase(), args);
    } catch {
      ws.send(JSON.stringify({output: 'Ошибка разбора команды', error: true}));
    }
  });
});

// Periodic ping for WS to detect dead connections
setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

// Command handler for terminal
async function handleCommand(ws, cmd, args) {
  switch (cmd) {
    case 'help':
      ws.send(JSON.stringify({output: `Доступные команды:\n` +
        `help - показать эту подсказку\n` +
        `list - показать список ботов\n` +
        `status <username> - состояние бота\n` +
        `restart <username> - перезапустить бота\n` +
        `logout <username> - отключить бота\n` +
        `farmgames <username> <ids> - обновить игры для фарма (через запятую)\n` +
        `redeem <username> <code> - активировать Steam Wallet код\n` +
        `clear - очистить терминал`}));
      break;

    case 'list':
      {
        const bots = await getBots();
        if (bots.length === 0) ws.send(JSON.stringify({output: 'Нет добавленных ботов'}));
        else {
          let out = 'Боты в пуле:\n';
          bots.forEach(b => {
            out += `#${b.id} ${b.username} - ${b.status}\n`;
          });
          ws.send(JSON.stringify({output: out}));
        }
      }
      break;

    case 'status':
      {
        const username = args[0];
        if (!username) {
          ws.send(JSON.stringify({output: 'Использование: status <username>', error: true}));
          break;
        }
        const botInfo = await getBotByUsername(username);
        if (!botInfo) {
          ws.send(JSON.stringify({output: `Бот ${username} не найден`, error: true}));
          break;
        }
        const online = botInfo.status === 'online' ? '🟢 Онлайн' : '🔴 Оффлайн';
        ws.send(JSON.stringify({
          output:
          `Статус бота ${username}:\n` +
          `ID: ${botInfo.id}\n` +
          `Статус: ${online}\n` +
          `Farm Cards: ${botInfo.farm_cards ? 'Да' : 'Нет'}\n` +
          `Accept Gifts: ${botInfo.accept_gifts ? 'Да' : 'Нет'}\n` +
          `Games to Farm: ${botInfo.games_to_farm}`
        }));
      }
      break;

    case 'restart':
      {
        const username = args[0];
        if (!username) {
          ws.send(JSON.stringify({output: 'Использование: restart <username>', error: true}));
          break;
        }
        const client = activeClients.get(username);
        if (!client) {
          ws.send(JSON.stringify({output: `Бот ${username} не активен.`, error: true}));
          break;
        }
        client.logOff();
        db.get(`SELECT password, shared_secret, games_to_farm FROM accounts WHERE username=?`, [username], (err, row) => {
          if (row) {
            startSteamClient(username, row.password, row.shared_secret, row.games_to_farm);
            ws.send(JSON.stringify({output: `Бот ${username} перезапущен.`}));
          } else {
            ws.send(JSON.stringify({output: `Ошибка: бот ${username} не найден в базе`, error: true}));
          }
        });
      }
      break;

    case 'logout':
      {
        const username = args[0];
        if (!username) {
          ws.send(JSON.stringify({output: 'Использование: logout <username>', error: true}));
          break;
        }
        const client = activeClients.get(username);
        if (!client) {
          ws.send(JSON.stringify({output: `Бот ${username} не активен.`, error: true}));
          break;
        }
        client.logOff();
        ws.send(JSON.stringify({output: `Бот ${username} отключён.`}));
      }
      break;

    case 'farmgames':
      {
        const username = args[0];
        if (!username || args.length < 2) {
          ws.send(JSON.stringify({output: 'Использование: farmgames <username> <appids>', error: true}));
          break;
        }
        const newGames = args.slice(1).join(' ');
        db.run(`UPDATE accounts SET games_to_farm=? WHERE username=?`, [newGames, username], err => {
          if (err) {
            ws.send(JSON.stringify({output: 'Ошибка обновления игр', error: true}));
          } else {
            const client = activeClients.get(username);
            if (client) {
              const appIds = newGames.split(',').map(s => parseInt(s.trim())).filter(n => Number.isInteger(n) && n > 0);
              if (appIds.length) {
                client.gamesPlayed(appIds);
                ws.send(JSON.stringify({output: `Игры для фарма у ${username} обновлены.`}));
              } else {
                ws.send(JSON.stringify({output: `Неверный список игр. Оставлено как есть.`, error: true}));
              }
            } else {
              ws.send(JSON.stringify({output: `Бот ${username} оффлайн, данные обновлены в базе.`}));
            }
          }
        });
      }
      break;

    case 'redeem':
      {
        const username = args[0];
        const code = args.slice(1).join(' ');
        if (!username || !code) {
          ws.send(JSON.stringify({output: 'Использование: redeem <username> <code>', error: true}));
          break;
        }
        const community = activeCommunities.get(username);
        if (!community) {
          ws.send(JSON.stringify({output: `Бот ${username} оффлайн.`, error: true}));
          break;
        }
        community.redeemWalletCode(code, (err, walletBalance) => {
          if (err) {
            ws.send(JSON.stringify({output: `Ошибка активации кода: ${err.message}`, error: true}));
          } else {
            ws.send(JSON.stringify({output: `Код активирован на ${username}. Баланс: ${walletBalance}`}));
          }
        });
      }
      break;

    case 'clear':
      // Clear terminal (send special message to client)
      ws.send(JSON.stringify({output: "\x1b[2J\x1b[0f", clear: true}));
      break;

    default:
      ws.send(JSON.stringify({output: `Неизвестная команда: ${cmd}. Введите 'help' для списка.` , error:true}));
  }
}

// Helpers for DB async usage
function getBots() {
  return new Promise((resolve) => {
    db.all(`SELECT * FROM accounts ORDER BY id ASC`, [], (err, rows) => {
      if (err) return resolve([]);
      resolve(rows);
    });
  });
}
function getBotByUsername(username) {
  return new Promise((resolve) => {
    db.get(`SELECT * FROM accounts WHERE username=?`, [username], (err, row) => {
      if (err) return resolve(null);
      resolve(row);
    });
  });
}

app.get('/', (_, res) => res.redirect('/admin'));

server.listen(PORT, () => console.log(`Монолитная панель инициализирована на порту ${PORT}`));
