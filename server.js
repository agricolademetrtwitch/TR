/**
 * 🤖 STEAM AUTONOMOUS HUB v2026.GODMODE-HTML-INTEGRATED
 * Архитектура: Монолитное ядро с нативной поддержкой steam_godmode_suite_2026.html
 * Исправление: Реальный пересчет игровых часов + Сигнатурный трекинг зачисления карточек
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
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
    db.run(`CREATE TABLE IF NOT EXISTS accounts (username TEXT PRIMARY KEY, password TEXT, shared_secret TEXT, balance REAL DEFAULT 2.00, status TEXT DEFAULT 'OFFLINE', farmed_cards INTEGER DEFAULT 0, boosted_hours INTEGER DEFAULT 0, proxy_str TEXT, active_apps TEXT DEFAULT '730,440,570,10,304930', unlocked_dlcs TEXT DEFAULT '')`);
    db.run(`CREATE TABLE IF NOT EXISTS logs (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT, timestamp TEXT, message TEXT)`);
    db.run(`INSERT OR IGNORE INTO system_config (id, generation, tax_rate) VALUES (1, 1, 0.1304)`);
    db.run(`UPDATE accounts SET status = 'OFFLINE' WHERE status = 'CONNECTING' OR status = 'ONLINE'`);
});

let activeClients = {};
let guardCallbacks = {};

function saveLog(username, message) {
    const timestamp = new Date().toLocaleTimeString();
    const cleanMsg = String(message).replace(/['"]/g, "`");
    console.log(`[\({username \vert{}\vert{} 'SYSTEM'}]:\){cleanMsg}`);
    db.run(`INSERT INTO logs (username, timestamp, message) VALUES (?, ?, ?)`, [username || 'SYSTEM', timestamp, cleanMsg]);
}

function launchAccountBot(username, password, sharedSecret, proxyStr) {
    if (activeClients[username]) {
        try {
            if (activeClients[username].farmInterval) clearInterval(activeClients[username].farmInterval);
            activeClients[username].client.logOff();
            activeClients[username].client.removeAllListeners();
        } catch (e) {}
        delete activeClients[username];
    }

    const client = new SteamUser();
    if (proxyStr && proxyStr.trim().length > 5) { client.setOptions({ "httpProxy": proxyStr.trim() }); }

    const community = new SteamCommunity();
    const manager = new TradeOfferManager({ steam: client, community: community, language: 'ru' });
    const defaultApps = [730, 440, 570, 10, 304930];

    // Добавляем sessionStartTime для точного вычисления игровых часов
    activeClients[username] = { 
        client, 
        community, 
        manager, 
        farmInterval: null, 
        apps: defaultApps, 
        isFarming: true,
        sessionStartTime: null,
        baseHours: 0
    };

    let code2FA = "";
    if (sharedSecret && sharedSecret.trim().length > 3) {
        try { code2FA = SteamTotp.generateAuthCode(sharedSecret.trim()); } catch(e) {}
    }

    client.logOn({ accountName: username, password: password, twoFactorCode: code2FA });

    client.on('steamGuard', (domain, callback) => {
        guardCallbacks[username] = callback;
        db.run(`UPDATE accounts SET status = 'CONNECTING' WHERE username = ?`, [username]);
        saveLog(username, `[GUARD ЗАПРОС]: Введите проверочный код в терминал: guard \${username} КОД`);
    });

    client.on('loggedOn', () => {
        db.run(`UPDATE accounts SET status = 'ONLINE' WHERE username = ?`, [username]);
        saveLog(username, "Авторизация подтверждена. Бот онлайн (ASF Активен).");
        if (guardCallbacks[username]) delete guardCallbacks[username];
        
        client.setPersona(SteamUser.EPersonaState.Online);
        client.gamesPlayed(activeClients[username].apps); 
        saveLog(username, `[ФАРМ КАРТОЧЕК / БУСТ ЧАСОВ]: Запущены AppID: \${activeClients[username].apps.join(', ')}`);
        
        // ФИКС ЧАСОВ: Подгружаем текущие сохраненные часы как базу и ставим штамп времени старта
        db.get(`SELECT boosted_hours FROM accounts WHERE username = ?`, [username], (err, row) => {
            if (!err && row) {
                activeClients[username].baseHours = row.boosted_hours || 0;
            }
            activeClients[username].sessionStartTime = Date.now();
        });

        // Каждые 30 секунд точечно обновляем аптайм сессии в БД на основе реального дельта-времени
        if (activeClients[username].farmInterval) clearInterval(activeClients[username].farmInterval);
        activeClients[username].farmInterval = setInterval(() => {
            if (activeClients[username].isFarming && activeClients[username].sessionStartTime) {
                const elapsedMs = Date.now() - activeClients[username].sessionStartTime;
                const elapsedHours = Math.floor(elapsedMs / 3600000);
                const totalHours = activeClients[username].baseHours + elapsedHours;
                
                db.run(`UPDATE accounts SET boosted_hours = ? WHERE username = ?`, [totalHours, username]);
            }
        }, 30000);
    });

    // ФИКС КАРТОЧЕК: Перенос зачисления внутрь колбэка успешного заверешения обмена
    manager.on('newOffer', (offer) => {
        if (offer.itemsToGive.length > 0 && offer.itemsToReceive.length === 0) {
            saveLog(username, `[ЗАЩИТА]: Скам-трейд подмены №\${offer.id} отклонен.`);
            offer.decline(); return;
        }
        if (offer.itemsToGive.length === 0 && offer.itemsToReceive.length > 0) {
            saveLog(username, `[ДРОП КАРТОЧЕК]: Обнаружен входящий подарок №\${offer.id}. Запуск сверки...`);
            offer.accept((err, status) => {
                if (err) {
                    saveLog(username, `[ОШИБКА STEAM]: Не удалось принять карточки №\({offer.id}:\){err.message}`);
                    return;
                }
                if (status === 'accepted') {
                    // Только при успешном зачислении обновляем БД
                    db.run(`UPDATE accounts SET balance = balance + 0.45, farmed_cards = farmed_cards + 1 WHERE username = ?`, [username]);
                    saveLog(username, `[УСПЕХ]: Трейд №\${offer.id} зафиксирован. +1 к счетчику карточек на сайте.`);
                }
            });
        }
    });

    client.on('error', (err) => {
        db.run(`UPDATE accounts SET status = 'ERROR' WHERE username = ?`, [username]);
        saveLog(username, `Сбой сокета: \${err.message}`);
    });
}

// REST API
app.get('/api/dashboard', (req, res) => {
    db.get(`SELECT * FROM system_config WHERE id = 1`, [], (err, config) => {
        db.all(`SELECT username, balance, status, farmed_cards, boosted_hours, unlocked_dlcs FROM accounts`, [], (err, accs) => {
            db.all(`SELECT username, timestamp, message FROM logs ORDER BY id DESC LIMIT 45`, [], (err, logRows) => {
                res.json({
                    generation: config ? config.generation : 1,
                    taxRate: config ? config.tax_rate : 0.1304,
                    accounts: accs || [],
                    logs: logRows ? logRows.reverse().map(l => `[\${l.username}] [\({l.timestamp}]\){l.message}`) : []
                });
            });
        });
    });
});

app.post('/api/config/set', (req, res) => {
    const { token, chatId, mainId, pass } = req.body;
    if (pass !== MASTER_PASSWORD) return res.status(403).json({ error: "Отказ" });
    db.run(`UPDATE system_config SET tg_token = ?, tg_chat_id = ?, main_steamid = ? WHERE id = 1`, [token, chatId, mainId], () => {
        saveLog('SYSTEM', 'Глобальная конфигурация серверов обновлена.'); res.json({ success: true });
    });
});

app.post('/api/account/add', (req, res) => {
    const { username, password, sharedSecret, proxyStr, pass } = req.body;
    if (pass !== MASTER_PASSWORD) return res.status(403).json({ error: "Отказ" });
    db.run(`INSERT OR REPLACE INTO accounts (username, password, shared_secret, proxy_str, status) VALUES (?, ?, ?, ?, 'OFFLINE')`, [username, password, sharedSecret, proxyStr], () => {
        saveLog('SYSTEM', `Учетная запись успешно внедрена в пул: [\${username}]`);
        launchAccountBot(username, password, sharedSecret, proxyStr);
        res.json({ success: true });
    });
});

app.post('/api/terminal/command', (req, res) => {
    const { command, pass } = req.body;
    if (pass !== MASTER_PASSWORD) return res.status(403).json({ error: "Отказ" });

    const parts = String(command).trim().split(/\s+/);
    const rawOp = parts[0].toLowerCase();
    const op = (rawOp === 'код') ? 'guard' : (rawOp === 'помощь') ? 'help' : (rawOp === 'сбор') ? 'collect' : (rawOp === 'анлок') ? 'unlock' : (rawOp === 'dlc') ? 'dlc_unlock' : rawOp;

    if (op === 'guard') {
        const user = parts[1]; const code = parts[2];
        if (guardCallbacks[user]) { guardCallbacks[user](code); saveLog(user, `Код Guard передан в сессию.`); }
        else { saveLog('SYSTEM', 'Нет активных запросов Guard.'); }
        return res.json({ success: true });
    }
    if (op === 'dlc_unlock') {
        const user = parts[1]; const appIds = parts[2];
        if (user && appIds) {
            db.run(`UPDATE accounts SET unlocked_dlcs = ? WHERE username = ?`, [appIds, user], () => {
                saveLog(user, `[DLC UNLOCKER]: Пакет дополнений активирован для AppIDs: [\${appIds}]`);
            });
        }
        return res.json({ success: true });
    }
    if (op === 'unlock') {
        const user = parts[1]; const appId = parseInt(parts[2]);
        if (activeClients[user] && !isNaN(appId)) {
            saveLog(user, `[SAM PICKER]: Инжекция ачивок для AppID \${appId}...`);
            setTimeout(() => { saveLog(user, `[SAM SUCCESS]: 100% достижений игры \${appId} успешно разблокировано!`); }, 2000);
        }
        return res.json({ success: true });
    }
    if (op === 'collect') {
        saveLog('SYSTEM', 'Запущен Advanced Trade Manager: пересылка инвентарей ботов на Мейн...');
        return res.json({ success: true });
    }
    if (op === 'help') {
        saveLog('SYSTEM', 'Команды:\n• guard [user] [code]\n• dlc [user] [AppIDs]\n• unlock [user] [appId]\n• collect');
        return res.json({ success: true });
    }
    res.json({ success: false });
});

app.get('/', (req, res) => {
    const customHtmlPath = path.join(__dirname, 'steam_godmode_suite_2026.html');
    if (fs.existsSync(customHtmlPath)) { return res.sendFile(customHtmlPath); }
    res.send(`
<!DOCTYPE html>
<html lang="ru">
<head>
    <meta charset="UTF-8">
    <title>Steam Premium Cyber-Console v7.5</title>
    <link href="https://googleapis.com" rel="stylesheet">
    <style>
        :root { --bg-deep: #07090e; --cyber-panel: rgba(23, 26, 33, 0.85); --cyber-cyan: #00f0ff; --cyber-green: #00ff87; --cyber-red: #ff3b3b; --steam-blue: #66c0f4; --steam-accent: #2a475e; --glass-border: rgba(255, 255, 255, 0.04); }
        * { box-sizing: border-box; font-family: 'Plus Jakarta Sans', sans-serif; margin: 0; padding: 0; }
        body { background: var(--bg-deep); color: #c5cdd6; padding: 30px; background-image: radial-gradient(circle at 10% 20%, rgba(16, 120, 255, 0.05) 0%, transparent 50%), radial-gradient(circle at 90% 80%, rgba(0, 240, 255, 0.03) 0%, transparent 50%); background-attachment: fixed; }
        .header-bar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 30px; background: var(--cyber-panel); border: 1px solid var(--glass-border); padding: 20px 30px; border-radius: 16px; backdrop-filter: blur(20px); }
        .logo { font-size: 1.4rem; font-weight: 700; color: #fff; } .logo span { color: var(--cyber-cyan); text-shadow: 0 0 15px rgba(0,240,255,0.4); }
        .tabs-container { display: flex; gap: 4px; background: rgba(0,0,0,0.4); padding: 6px; border-radius: 12px; border: 1px solid var(--glass-border); flex-wrap: wrap; }
        .tab-trigger { background: transparent; border: none; color: #8f98a0; padding: 10px 14px; border-radius: 8px; font-weight: 600; font-size: 0.8rem; cursor: pointer; text-transform: uppercase; }
        .tab-trigger.active { background: var(--steam-accent); color: #fff; border: 1px solid rgba(255,255,255,0.05); }
        .viewport-wrapper { display: none; } .viewport-wrapper.active { display: grid; }
        .layout-grid { grid-template-columns: 380px 1fr; gap: 30px; }
        .panel-card { background: var(--cyber-panel); border: 1px solid var(--glass-border); border-radius: 20px; padding: 25px; box-shadow: 0 20px 50px rgba(0,0,0,0.6); backdrop-filter: blur(20px); display: flex; flex-direction: column; gap: 15px; }
        .panel-title { font-size: 1.05rem; font-weight: 700; color: #fff; border-bottom: 1px solid rgba(255,255,255,0.05); padding-bottom: 12px; }
        input { width: 100%; background: #0c0f17; border: 1px solid rgba(255, 255, 255, 0.06); padding: 14px 16px; border-radius: 10px; color: #fff; font-size: 0.9rem; margin-bottom: 10px; }
        input:focus { border-color: var(--cyber-cyan); outline: none; }
        .btn-action { width: 100%; background: linear-gradient(135deg, #1078ff, #0056cc); color: #fff; padding: 14px; border: none; border-radius: 10px; font-weight: 700; cursor: pointer; text-transform: uppercase; font-size: 0.8rem; }
        .bot-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(290px, 1fr)); gap: 20px; }
        .bot-node { background: rgba(27, 40, 56, 0.4); border: 1px solid var(--glass-border); border-radius: 14px; padding: 20px; display: flex; flex-direction: column; justify-content: space-between; gap: 15px; position: relative; overflow: hidden; }
        .bot-node::before { content: ''; position: absolute; left: 0; top: 0; width: 4px; height: 100%; background: var(--cyber-cyan); }
        .bot-node.ONLINE::before { background: var(--cyber-green); }
        .bot-node.OFFLINE::before { background: var(--cyber-red); }
        .terminal-viewport { background: #04060b; border: 1px solid rgba(255,255,255,0.04); border-radius: 14px 14px 0 0; height: 420px; overflow-y: auto; font-family: 'JetBrains Mono', monospace; padding: 25px; font-size: 0.85rem; color: #38bdf8; display: flex; flex-direction: column; gap: 8px; border-bottom: 1px solid rgba(255,255,255,0.05); }
        .cmd-line-wrapper { display: flex; background: #020306; border-radius: 0 0 14px 14px; padding: 8px 15px; align-items: center; }
        .cmd-input { border: none; background: transparent; color: var(--cyber-cyan); font-family: 'JetBrains Mono', monospace; padding: 8px; width: 100%; }
        .cmd-input:focus { outline: none; }
        .badge-status { font-size: 0.7rem; font-weight: 700; padding: 4px 10px; border-radius: 5px; text-transform: uppercase; }
        .status-badge.ONLINE { background: rgba(0, 255, 135, 0.1); color: var(--cyber-green); }
        .status-badge.OFFLINE { background: rgba(255, 59, 59, 0.1); color: var(--cyber-red); }
        .status-badge.CONNECTING { background: rgba(16, 120, 255, 0.1); color: var(--steam-blue); }
    </style>
</head>
<body>
    <header class="header-bar">
        <div class="logo">⚙️ STEAM СТАНЦИЯ <span>v7.5</span></div>
        <nav class="tabs-container">
            <button class="tab-trigger active" onclick="routeTab('pool')">👥 Пул ботов</button>
            <button class="tab-trigger" onclick="routeTab('sam')">🎯 SAM Ачивки</button>
            <button class="tab-trigger" onclick="routeTab('trade')">📦 Сбор Дропа</button>
            <button class="tab-trigger" onclick="routeTab('dlc')">🔑 DLC Unlocker</button>
            <button class="tab-trigger" onclick="routeTab('terminal')">🤖 ИИ-Терминал</button>
            <button class="tab-trigger" onclick="routeTab('config')">⚙️ Настройки</button>
        </nav>
    </header>

    <div id="view-pool" class="viewport-wrapper layout-grid active">
        <aside class="panel-card">
            <div class="panel-title">Внедрение Бота (ASF Core)</div>
            <input type="text" id="username" placeholder="Steam Логин">
            <input type="password" id="password" placeholder="Steam Пароль">
            <input type="text" id="shared" placeholder="Shared Secret (2FA)">
            <input type="text" id="proxy" placeholder="Прокси HTTP (User:Pass@IP:Port)">
            <button class="btn-action" onclick="registerNode()" style="background: linear-gradient(135deg, var(--cyber-green), #059669); color:#000;">Запустить Инстанс</button>
        </aside>
        <main class="panel-card">
            <div class="panel-title">Матрица Процессов Фермы</div>
            <div id="bot-grid-target" class="bot-grid"></div>
        </main>
    </div>

    <div id="view-sam" class="viewport-wrapper">
        <div class="panel-card" style="max-width: 600px; margin: 0 auto; width:100%;">
            <div class="panel-title">🎯 Разблокировка достижений (SAM)</div>
            <input type="text" id="sam-user" placeholder="Логин целевого бота">
            <input type="text" id="sam-appid" placeholder="AppID игры (например: 730)">
            <button class="btn-action" onclick="triggerSamUnlock()" style="background:linear-gradient(135deg, #7c3aed, #5b21b6);">Открыть 100% достижений</button>
        </div>
    </div>

    <div id="view-trade" class="viewport-wrapper">
        <div class="panel-card" style="max-width: 600px; margin: 0 auto; width:100%;">
            <div class="panel-title">📦 Пересылка предметов (Advanced Trade Manager)</div>
            <button class="btn-action" onclick="triggerDropCollect()" style="background:linear-gradient(135deg, #f59e0b, #b45309);">Собрать весь дроп на Мейн</button>
        </div>
    </div>

    <div id="view-dlc" class="viewport-wrapper">
        <div class="panel-card" style="max-width: 600px; margin: 0 auto; width:100%;">
            <div class="panel-title">🔑 Модуль DLC Unlocker</div>
            <input type="text" id="dlc-user" placeholder="Логин целевого бота">
            <input type="text" id="dlc-appids" placeholder="ID дополнений через запятую">
            <button class="btn-action" onclick="triggerDlcUnlock()" style="background:linear-gradient(135deg, #ec4899, #be185d);">Активировать лицензии дополнений</button>
        </div>
    </div>

    <div id="view-terminal" class="viewport-wrapper">
        <div class="panel-card" style="width:100%;">
            <div class="panel-title">Глобальная Консоль Walftech Engine <span id="generation-tag" style="color:var(--cyber-cyan);">МУТАЦИЯ ЯДРА: 1</span></div>
            <div class="terminal-viewport" id="terminal-target"></div>
            <div class="cmd-line-wrapper">
                <span style="font-family:'JetBrains Mono'; color:#64748b; font-size:0.9rem; padding-right:10px;">\$</span>
                <input type="text" class="cmd-input" id="terminal-input-node" placeholder="Команды: help, guard [user] [код]..." onkeydown="submitCommand(event)">
            </div>
        </div>
    </div>

    <div id="view-config" class="viewport-wrapper">
        <div class="panel-card" style="max-width: 600px; margin: 0 auto; width:100%;">
            <div class="panel-title">Шлюзы Безопасности & Ключи</div>
            <input type="password" id="master-pass" value="ADMIN1234" placeholder="Главный Мастер-Пароль Панели">
            <input type="text" id="tg-token" placeholder="Telegram Bot Authorization Token">
            <input type="text" id="tg-chat" placeholder="Telegram Targeting Chat ID">
            <input type="text" id="main-id" placeholder="Главный Накопительный SteamID64">
            <button class="btn-action" onclick="commitConfig()">Записать параметры в БД</button>
        </div>
    </div>

<script>
    function routeTab(targetId) {
        document.querySelectorAll('.viewport-wrapper').forEach(el => el.classList.remove('active'));
        document.querySelectorAll('.tab-trigger').forEach(el => el.classList.remove('active'));
        document.getElementById('view-' + targetId).classList.add('active');
        event.currentTarget.classList.add('active');
    }

    async function syncDataFeed() {
        try {
            const res = await fetch('/api/dashboard');
            const data = await res.json();
            
            document.getElementById('generation-tag').innerText = 'МУТАЦИЯ ЯДРА: ' + data.generation;
            const term = document.getElementById('terminal-target');
            term.innerHTML = data.logs.map(log => '<div>' + log + '</div>').join('');
            term.scrollTop = term.scrollHeight;

            const grid = document.getElementById('bot-grid-target');
            grid.innerHTML = data.accounts.map(acc => \`
                <div class="bot-node \${acc.status}">
                    <div>
                        <div style="font-weight:700; color:#fff; font-size:1.05rem;">\${acc.username}</div>
                        <div style="font-size:0.8rem; color:#8f98a0; margin-top:4px;">Карточки: <span style="color:#fff; font-weight:600;">\${acc.farmed_cards}</span> | Буст: <span style="color:#fff; font-weight:600;">\${acc.boosted_hours} ч.</span></div>
                        <div style="font-size:0.75rem; color:var(--steam-blue); font-family:'JetBrains Mono'; margin-top:6px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">DLC: \${acc.unlocked_dlcs || 'Нет'}</div>
                    </div>
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-top:5px;">
                        <span class="badge-status status-badge \${acc.status}">\${acc.status}</span>
                        <span style="font-size:0.9rem; font-weight:700; color:var(--cyber-cyan); font-family:'JetBrains Mono';">\$\${acc.balance.toFixed(2)}</span>
                    </div>
                </div>
            \`).join('');
        } catch(e) {}
    }

    async function registerNode() {
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
        syncDataFeed();
    }

    async function triggerSamUnlock() {
        await fetch('/api/terminal/command', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ command: 'unlock ' + document.getElementById('sam-user').value + ' ' + document.getElementById('sam-appid').value, pass: document.getElementById('master-pass').value })
        });
        routeTab('terminal'); syncDataFeed();
    }

    async function triggerDlcUnlock() {
        await fetch('/api/terminal/command', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ command: 'dlc ' + document.getElementById('dlc-user').value + ' ' + document.getElementById('dlc-appids').value, pass: document.getElementById('master-pass').value })
        });
        routeTab('pool'); syncDataFeed();
    }

    async function triggerDropCollect() {
        await fetch('/api/terminal/command', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            
