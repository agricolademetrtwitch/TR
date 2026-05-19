/**
 * 🤖 STEAM AUTONOMOUS HUB v2026.SUPREME-MONOLITH
 * Оптимизация: Zero-File Architecture (HTML встроен в ядро)
 * Функции: Мультиаккаунтинг, Буст 5 игр, Автофарм, Сбор на Мейн, Telegram Алерты, Мастер-Пароль
 */

const express = require('express');
const path = require('path');
const https = require('https');
const sqlite3 = require('sqlite3').verbose();
const SteamUser = require('steam-user');
const SteamTotp = require('steam-totp');
const SteamCommunity = require('steamcommunity');
const TradeOfferManager = require('steam-tradeoffer-manager');

const app = express();
const PORT = process.env.PORT || 3000;
const MASTER_PASSWORD = process.env.ADMIN_PASSWORD || "ADMIN1234"; 

app.use(express.json());

const isCloud = process.env.RENDER || process.env.RAILWAY_STATIC_URL || false;
const dbPath = isCloud ? path.join('/tmp', 'steam_supreme_v2026.db') : './steam_supreme_v2026.db';

const db = new sqlite3.Database(dbPath, (err) => {
    if (err) { console.error('Ошибка БД:', err.message); process.exit(1); }
    console.log(`[DATABASE]: База данных SQLite успешно развернута: ${dbPath}`);
});

db.run("PRAGMA busy_timeout = 10000;");
db.run("PRAGMA journal_mode = WAL;");

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS system_config (id INTEGER PRIMARY KEY, generation INTEGER DEFAULT 1, tax_rate REAL DEFAULT 0.1304, tg_token TEXT, tg_chat_id TEXT, main_steamid TEXT)`);
    db.run(`CREATE TABLE IF NOT EXISTS accounts (username TEXT PRIMARY KEY, password TEXT, shared_secret TEXT, balance REAL DEFAULT 2.00, status TEXT DEFAULT 'OFFLINE', farmed_cards INTEGER DEFAULT 0, boosted_hours INTEGER DEFAULT 0, proxy_str TEXT)`);
    db.run(`CREATE TABLE IF NOT EXISTS logs (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT, timestamp TEXT, message TEXT)`);
    db.run(`INSERT OR IGNORE INTO system_config (id, generation, tax_rate) VALUES (1, 1, 0.1304)`);
    db.run(`UPDATE accounts SET status = 'OFFLINE' WHERE status = 'CONNECTING' OR status = 'ONLINE'`);
});

let activeClients = {};
let guardCallbacks = {};

function sendTelegram(message) {
    db.get(`SELECT tg_token, tg_chat_id FROM system_config WHERE id = 1`, [], (err, cfg) => {
        if (!cfg || !cfg.tg_token || !cfg.tg_chat_id) return;
        const msg = encodeURIComponent(`[SteamHub 2026] ${message}`);
        https.get(`https://telegram.org{cfg.tg_token}/sendMessage?chat_id=${cfg.tg_chat_id}&text=${msg}`, () => {});
    });
}

function saveLog(username, message) {
    const timestamp = new Date().toLocaleTimeString();
    const cleanMsg = String(message).replace(/['"]/g, "`");
    console.log(`[${username || 'SYSTEM'}]: ${cleanMsg}`);
    db.run(`INSERT INTO logs (username, timestamp, message) VALUES (?, ?, ?)`, [username || 'SYSTEM', timestamp, cleanMsg]);
}

function launchAccountBot(username, password, sharedSecret, proxyStr) {
    if (activeClients[username]) {
        try {
            if (activeClients[username].farmInterval) clearInterval(activeClients[username].farmInterval);
            activeClients[username].client.logOff();
            activeClients[username].client.removeAllListeners();
        } catch (e) { console.error(e.message); }
        delete activeClients[username];
    }

    const client = new SteamUser();
    
    if (proxyStr && proxyStr.trim().length > 5) {
        client.setOptions({ "httpProxy": proxyStr.trim() });
        saveLog(username, `Инициализация сетевого прокси-туннеля...`);
    }

    const community = new SteamCommunity();
    const manager = new TradeOfferManager({ steam: client, community: community, language: 'ru' });

    activeClients[username] = { client, community, manager, farmInterval: null };

    let code2FA = "";
    if (sharedSecret && sharedSecret.trim().length > 3) {
        try { code2FA = SteamTotp.generateAuthCode(sharedSecret.trim()); } catch(e) { saveLog(username, `Сбой 2FA: ${e.message}`); }
    }

    client.logOn({ accountName: username, password: password, twoFactorCode: code2FA });

    client.on('steamGuard', (domain, callback) => {
        guardCallbacks[username] = callback;
        db.run(`UPDATE accounts SET status = 'CONNECTING' WHERE username = ?`, [username]);
        saveLog(username, `[GUARD ЗАПРОС]: Требуется код 2FA. Выполните: guard ${username} КОД`);
        sendTelegram(`⚠️ Аккаунт ${username} затребовал код Steam Guard. Введите его в терминал сайта.`);
    });

    client.on('loggedOn', () => {
        db.run(`UPDATE accounts SET status = 'ONLINE' WHERE username = ?`, [username]);
        saveLog(username, "Бот успешно вошел в сеть Valve.");
        sendTelegram(`✅ Аккаунт ${username} теперь ОНЛАЙН. Запущен автономный фарм.`);
        if (guardCallbacks[username]) delete guardCallbacks[username];
        
        client.setPersona(SteamUser.EPersonaState.Online);
        client.gamesPlayed([730, 440, 570, 10, 304930]); 
        
        if (activeClients[username].farmInterval) clearInterval(activeClients[username].farmInterval);
        activeClients[username].farmInterval = setInterval(() => {
            db.run(`UPDATE accounts SET boosted_hours = boosted_hours + 1 WHERE username = ?`, [username]);
        }, 3600000);
    });

    client.on('webSession', (sessionID, cookies) => {
        community.setCookies(cookies);
        manager.setCookies(cookies, (err) => {
            if (!err) saveLog(username, `Анти-API Скам фильтры обменов успешно развернуты.`);
        });
    });

    manager.on('newOffer', (offer) => {
        if (offer.itemsToGive.length > 0 && offer.itemsToReceive.length === 0) {
            saveLog(username, `[ЗАЩИТА]: Заблокирован односторонний вывод скинов в трейде №${offer.id}! ОТМЕНА.`);
            sendTelegram(`🚨 КРИТИЧЕСКАЯ АТАКА: На аккаунте ${username} была попытка перехвата трейда API-Scam! Бот успешно заблокировал кражу.`);
            offer.decline();
            return;
        }
        if (offer.itemsToGive.length === 0 && offer.itemsToReceive.length > 0) {
            saveLog(username, `[ДРОП]: Получены карточки. Авто-принятие.`);
            offer.accept((err) => {
                if (!err) db.run(`UPDATE accounts SET balance = balance + 0.45, farmed_cards = farmed_cards + 1 WHERE username = ?`, [username]);
            });
        }
    });

    client.on('error', (err) => {
        db.run(`UPDATE accounts SET status = 'ERROR' WHERE username = ?`, [username]);
        saveLog(username, `Ошибка сессии: ${err.message}`);
    });
}

// REST API
app.get('/api/dashboard', (req, res) => {
    db.get(`SELECT * FROM system_config WHERE id = 1`, [], (err, config) => {
        db.all(`SELECT username, balance, status, farmed_cards, boosted_hours, proxy_str FROM accounts`, [], (err, accs) => {
            db.all(`SELECT username, timestamp, message FROM logs ORDER BY id DESC LIMIT 30`, [], (err, logRows) => {
                res.json({
                    generation: config ? config.generation : 1,
                    taxRate: config ? config.tax_rate : 0.1304,
                    accounts: accs || [],
                    logs: logRows ? logRows.reverse().map(l => `[${l.username}] [${l.timestamp}] ${l.message}`) : []
                });
            });
        });
    });
});

app.post('/api/config/set', (req, res) => {
    const { token, chatId, mainId, pass } = req.body;
    if (pass !== MASTER_PASSWORD) return res.status(403).json({ error: "Неверный мастер-пароль" });
    db.run(`UPDATE system_config SET tg_token = ?, tg_chat_id = ?, main_steamid = ? WHERE id = 1`, [token, chatId, mainId], () => {
        saveLog('SYSTEM', 'Глобальные системные настройки шлюзов успешно обновлены.');
        res.json({ success: true });
    });
});

app.post('/api/account/add', (req, res) => {
    const { username, password, sharedSecret, proxyStr, pass } = req.body;
    if (pass !== MASTER_PASSWORD) return res.status(403).json({ error: "Неверный мастер-пароль" });
    db.run(`INSERT OR REPLACE INTO accounts (username, password, shared_secret, proxy_str, status) VALUES (?, ?, ?, ?, 'OFFLINE')`, [username, password, sharedSecret, proxyStr], () => {
        saveLog('SYSTEM', `Добавлен новый бот в пул: [${username}]`);
        launchAccountBot(username, password, sharedSecret, proxyStr);
        res.json({ success: true });
    });
});

app.post('/api/terminal/command', (req, res) => {
    const { command, pass } = req.body;
    if (pass !== MASTER_PASSWORD) return res.status(403).json({ error: "Отказ в доступе" });

    const parts = String(command).trim().split(/\s+/);
    const rawOp = parts[0].toLowerCase();
    const op = (rawOp === 'код') ? 'guard' : (rawOp === 'помощь') ? 'help' : (rawOp === 'сбор') ? 'collect' : rawOp;

    if (op === 'guard') {
        const user = parts[1]; const code = parts[2];
        if (guardCallbacks[user]) {
            guardCallbacks[user](code); saveLog(user, `Код Guard [${code}] передан боту.`); res.json({ success: true });
        } else { saveLog('SYSTEM', 'Нет запросов Guard для этого юзера.'); res.json({ success: false }); }
    } else if (op === 'collect') {
        db.get(`SELECT main_steamid FROM system_config WHERE id = 1`, [], (err, cfg) => {
            if (!cfg || !cfg.main_steamid) return saveLog('SYSTEM', '❌ Настройка Main SteamID не задана в конфигурации!');
            saveLog('SYSTEM', `📦 Запущен автоматический протокол сбора дропа на аккаунт: ${cfg.main_steamid}`);
            Object.keys(activeClients).forEach(user => {
                const manager = activeClients[user].manager;
                manager.loadInventory(730, 2, true, (err, items) => {
                    if (err || !items || items.length === 0) return;
                    const offer = manager.createOffer(cfg.main_steamid);
                    offer.addMyItems(items);
                    offer.send((err) => { if (!err) saveLog(user, `[СБОР]: Нафармленные предметы отправлены на Мейн.`); });
                });
            });
        });
        res.json({ success: true });
    } else if (op === 'help') {
        saveLog('SYSTEM', 'Установки терминала:\n• "help" - Вывод карты синтаксиса.\n• "guard [user] [code]" - Передать токен 2FA.\n• "collect" - Автоматический сбор нафармленного инвентаря всех ботов на Главный аккаунт.');
        res.json({ success: true });
    } else { saveLog('SYSTEM', `Неизвестная команда: ${rawOp}`); res.json({ success: false }); }
});

// МОНОЛИТНАЯ ИНТЕГРАЦИЯ ИНТЕРФЕЙСА (Исправление рендеринга Render)
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="ru">
<head>
    <meta charset="UTF-8">
    <title>Steam Autonomous Supreme Suite v5.5</title>
    <link href="https://googleapis.com" rel="stylesheet">
    <style>
        :root { --bg-deep: #030712; --bg-panel: #0b0f19; --bg-card: #131926; --steam-blue: #1078ff; --steam-cyan: #00ffcc; --green: #10b981; --red: #ef4444; }
        * { box-sizing: border-box; font-family: 'Plus Jakarta Sans', sans-serif; margin: 0; padding: 0; }
        body { background: var(--bg-deep); color: #f3f4f6; padding: 25px; }
        .grid-layout { display: grid; grid-template-columns: 380px 1fr; gap: 25px; max-width: 1750px; margin: 0 auto; }
        .panel { background: var(--bg-panel); border: 1px solid rgba(255,255,255,0.05); border-radius: 16px; padding: 25px; display: flex; flex-direction: column; gap: 15px; box-shadow: 0 10px 40px rgba(0,0,0,0.5); }
        .panel-header { font-size: 1.1rem; font-weight: 700; color: #fff; border-bottom: 2px solid #1e293b; padding-bottom: 8px; display: flex; justify-content: space-between; align-items: center; }
        input { background: #03060f; border: 1px solid rgba(255,255,255,0.05); color: #fff; padding: 12px; border-radius: 8px; width: 100%; font-size: 0.9rem; margin-bottom: 5px; }
        input:focus { border-color: var(--steam-cyan); outline: none; }
        .btn { background: var(--steam-blue); color: #fff; padding: 12px; border: none; border-radius: 8px; font-weight: 700; cursor: pointer; text-transform: uppercase; width: 100%; font-size: 0.8rem; }
        .btn:hover { background: #2563eb; box-shadow: 0 0 15px rgba(16,120,255,0.4); }
        .terminal { background: #02040a; padding: 20px; border-radius: 10px 10px 0 0; height: 350px; overflow-y: auto; font-family: 'JetBrains Mono', monospace; color: #38bdf8; display: flex; flex-direction: column; gap: 6px; font-size: 0.8rem; border-bottom: 1px solid #1e293b; white-space: pre-wrap; }
        .terminal-input-wrapper { display: flex; background: #010206; border-radius: 0 0 10px 10px; border: 1px solid rgba(255,255,255,0.05); border-top: none; padding: 5px; }
        .terminal-input { border: none; background: transparent; font-family: 'JetBrains Mono', monospace; color: var(--steam-cyan); margin-bottom: 0; }
        .account-card { background: var(--bg-card); padding: 15px; border-radius: 10px; display: flex; justify-content: space-between; align-items: center; border: 1px solid rgba(255,255,255,0.02); }
        .status-badge { font-size: 0.75rem; font-weight: 800; padding: 4px 8px; border-radius: 4px; }
        .ONLINE { background: rgba(16,185,129,0.15); color: var(--green); }
        .OFFLINE { background: rgba(239,68,68,0.15); color: var(--red); }
        .CONNECTING { background: rgba(16,120,255,0.15); color: var(--steam-blue); }
        .neon { color: var(--steam-cyan); text-shadow: 0 0 10px rgba(0,255,204,0.3); }
        .ai-panel { background: radial-gradient(circle at top left, #0d1527, var(--bg-panel)); border: 1px solid rgba(0,255,204,0.2); }
    </style>
</head>
<body>

<div class="grid-layout">
    <aside style="display:flex; flex-direction:column; gap:25px;">
        <div class="panel">
            <div class="panel-header">🔐 Безопасность Панели</div>
            <input type="password" id="master-pass" value="ADMIN1234" placeholder="Введите Ваш Мастер-Пароль">
        </div>

        <div class="panel">
            <div class="panel-header">🌐 Глобальные Настройки</div>
            <input type="text" id="tg-token" placeholder="Telegram Bot Token">
            <input type="text" id="tg-chat" placeholder="Telegram Chat ID">
            <input type="text" id="main-id" placeholder="Главный SteamID64 (Мейн)">
            <button class="btn" onclick="saveGlobalConfig()">Применить параметры</button>
        </div>

        <div class="panel">
            <div class="panel-header">Инжектор Ветки Ботов</div>
            <input type="text" id="username" placeholder="Steam Логин">
            <input type="password" id="password" placeholder="Steam Пароль">
            <input type="text" id="shared" placeholder="Shared Secret (Для авто-2FA)">
            <input type="text" id="proxy" placeholder="Прокси HTTP (Логин:Пароль@IP:Порт)">
            <button class="btn" style="background: var(--green);" onclick="addAccount()">Внедрить бота</button>
        </div>
    </aside>

    <main style="display:flex; flex-direction:column; gap:25px;">
        <div class="panel">
            <div class="panel-header">Активные процессы в Базе Данных:</div>
            <div id="accounts-container" style="display:grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap:15px;"></div>
        </div>

        <div class="panel">
            <div class="panel-header">Глобальный Терминал Управления Сетями & Облачным Ядром</div>
            <div>
                <div class="terminal" id="terminal-box"></div>
                <div class="terminal-input-wrapper">
                    <span style="display:flex; align-items:center; padding-left:15px; color:#64748b; font-family:'JetBrains Mono', monospace; font-size:0.8rem;">$</span>
                    <input type="text" class="terminal-input" id="term-cmd" placeholder="Наберите команду на русском или английском (help / сбор)..." onkeydown="handleTerminalCommand(event)">
                </div>
            </div>
        </div>
    </main>
</div>

<script>
    async function updateDashboard() {
        try {
            const res = await fetch('/api/dashboard');
            const data = await res.json();
            const term = document.getElementById('terminal-box');
            term.innerHTML = data.logs.map(log => '<div>' + log + '</div>').join('');
            term.scrollTop = term.scrollHeight;
            
            const container = document.getElementById('accounts-container');
            container.innerHTML = data.accounts.map(acc => '                    <div class="account-card">                        <div>                            <div style="font-weight:700; color:#fff;">' + acc.username + '</div>                            <div style="font-size:0.75rem; color:#94a3b8; margin-top:2px;">Карточек: ' + acc.farmed_cards + ' | Часов: ' + acc.boosted_hours + '</div>                        </div>                        <span class="status-badge ' + acc.status + '">' + acc.status + '</span>                    </div>').join('');
        } catch (e) {}
    }

    async function saveGlobalConfig() {
        await fetch('/api/config/set', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                token: document.getElementById('tg-token').value,
                chatId: document.getElementById('tg-chat').value,
                mainId: document.getElementById('main-id').value,
                pass: document.getElementById('master-pass').value
            })
        });
        updateDashboard();
    }

    async function addAccount() {
        await fetch('/api/account/add', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                username: document.getElementById('username').value,
                password: document.getElementById('password').value,
                sharedSecret: document.getElementById('shared').value,
                proxyStr: document.getElementById('proxy').value,
                pass: document.getElementById('master-pass').value
            })
        });
        document.getElementById('username').value = ''; document.getElementById('password').value = '';
        updateDashboard();
    }

    async function handleTerminalCommand(e) {
        if (e.key === 'Enter') {
            const inputEl = document.getElementById('term-cmd');
            const val = inputEl.value; if(!val.trim()) return;
            inputEl.value = '';
            await fetch('/api/terminal/command', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ command: val, pass: document.getElementById('master-pass').value })
            });
            updateDashboard();
        }
    }

    setInterval(updateDashboard, 1500);
    window.onload = updateDashboard;
</script>
</body>
</html>
    `);
});

app.listen(PORT, () => console.log(`[AUTONOMOUS COMPLEX ACTIVE]: Сервер развернут на порту: ${PORT}`));
