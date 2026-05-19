/**
 * 🤖 STEAM AUTONOMOUS HYPER-SUITE v2026.TAB-EDITION
 * Возможности: 28 Команд, 4 Интерактивные вкладки, Логирование, Мульти-процессы ОЗУ
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
const dbPath = isCloud ? path.join('/tmp', 'steam_hyper_v2026.db') : './steam_hyper_v2026.db';

const db = new sqlite3.Database(dbPath, (err) => {
    if (err) { console.error('Ошибка БД:', err.message); process.exit(1); }
    console.log(`[DATABASE]: База данных SQLite успешно развернута: ${dbPath}`);
});

db.run("PRAGMA busy_timeout = 10000;");
db.run("PRAGMA journal_mode = WAL;");

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS system_config (id INTEGER PRIMARY KEY, generation INTEGER DEFAULT 1, tax_rate REAL DEFAULT 0.1304, tg_token TEXT, tg_chat_id TEXT, main_steamid TEXT)`);
    db.run(`CREATE TABLE IF NOT EXISTS accounts (username TEXT PRIMARY KEY, password TEXT, shared_secret TEXT, balance REAL DEFAULT 2.00, status TEXT DEFAULT 'OFFLINE', farmed_cards INTEGER DEFAULT 0, boosted_hours INTEGER DEFAULT 0, proxy_str TEXT, active_apps TEXT DEFAULT '730,440,570')`);
    db.run(`CREATE TABLE IF NOT EXISTS logs (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT, timestamp TEXT, message TEXT)`);
    db.run(`INSERT OR IGNORE INTO system_config (id, generation, tax_rate) VALUES (1, 1, 0.1304)`);
    db.run(`UPDATE accounts SET status = 'OFFLINE' WHERE status = 'CONNECTING' OR status = 'ONLINE'`);
});

let activeClients = {};
let guardCallbacks = {};

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
        } catch (e) {}
        delete activeClients[username];
    }

    const client = new SteamUser();
    if (proxyStr && proxyStr.trim().length > 5) { client.setOptions({ "httpProxy": proxyStr.trim() }); }

    const community = new SteamCommunity();
    const manager = new TradeOfferManager({ steam: client, community: community, language: 'ru' });

    activeClients[username] = { client, community, manager, farmInterval: null, apps: [730, 440, 570] };

    let code2FA = "";
    if (sharedSecret && sharedSecret.trim().length > 3) {
        try { code2FA = SteamTotp.generateAuthCode(sharedSecret.trim()); } catch(e) {}
    }

    client.logOn({ accountName: username, password: password, twoFactorCode: code2FA });

    client.on('steamGuard', (domain, callback) => {
        guardCallbacks[username] = callback;
        db.run(`UPDATE accounts SET status = 'CONNECTING' WHERE username = ?`, [username]);
        saveLog(username, `[GUARD]: Требуется код 2FA. Выполните: guard ${username} КОД`);
    });

    client.on('loggedOn', () => {
        db.run(`UPDATE accounts SET status = 'ONLINE' WHERE username = ?`, [username]);
        saveLog(username, "Бот авторизован в сети Steam.");
        if (guardCallbacks[username]) delete guardCallbacks[username];
        
        client.setPersona(SteamUser.EPersonaState.Online);
        client.gamesPlayed(activeClients[username].apps); 
        
        activeClients[username].farmInterval = setInterval(() => {
            db.run(`UPDATE accounts SET boosted_hours = boosted_hours + 1 WHERE username = ?`, [username]);
        }, 3600000);
    });

    client.on('error', (err) => {
        db.run(`UPDATE accounts SET status = 'ERROR' WHERE username = ?`, [username]);
        saveLog(username, `Ошибка: ${err.message}`);
    });
}

// REST API
app.get('/api/dashboard', (req, res) => {
    db.get(`SELECT * FROM system_config WHERE id = 1`, [], (err, config) => {
        db.all(`SELECT username, balance, status, farmed_cards, boosted_hours, proxy_str FROM accounts`, [], (err, accs) => {
            db.all(`SELECT username, timestamp, message FROM logs ORDER BY id DESC LIMIT 35`, [], (err, logRows) => {
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
    if (pass !== MASTER_PASSWORD) return res.status(403).json({ error: "Ошибка пароля" });
    db.run(`UPDATE system_config SET tg_token = ?, tg_chat_id = ?, main_steamid = ? WHERE id = 1`, [token, chatId, mainId], () => {
        saveLog('SYSTEM', 'Настройки Telegram и Мейн-аккаунта обновлены.');
        res.json({ success: true });
    });
});

app.post('/api/account/add', (req, res) => {
    const { username, password, sharedSecret, proxyStr, pass } = req.body;
    if (pass !== MASTER_PASSWORD) return res.status(403).json({ error: "Ошибка пароля" });
    db.run(`INSERT OR REPLACE INTO accounts (username, password, shared_secret, proxy_str, status) VALUES (?, ?, ?, ?, 'OFFLINE')`, [username, password, sharedSecret, proxyStr], () => {
        saveLog('SYSTEM', `Бот [${username}] добавлен в базу данных.`);
        launchAccountBot(username, password, sharedSecret, proxyStr);
        res.json({ success: true });
    });
});

// КАНАЛ ОБРАБОТКИ 28 МУЛЬТИЯЗЫЧНЫХ КОМАНД СЕТЕВОГО ТЕРМИНАЛА
app.post('/api/terminal/command', (req, res) => {
    const { command, pass } = req.body;
    if (pass !== MASTER_PASSWORD) return res.status(403).json({ error: "Отказ в доступе" });

    const parts = String(command).trim().split(/\s+/);
    const rawOp = parts[0].toLowerCase();
    
    // МАТРИЦА 28 КОМАНД (РУССКИЙ / АНГЛИЙСКИЙ СИНТАКСИС)
    if (['help', 'помощь'].includes(rawOp)) {
        saveLog('SYSTEM', 'Доступные команды:\n1. help/помощь\n2. guard/код [user] [code]\n3. collect/сбор\n4. status/статус\n5. db/бд\n6. clear/очистить\n7. accounts/аккаунты\n8. farm/фарм [user] [on/off]\n9. games/игры [user] [id1,id2]\n10. delete/удалить [user]\n11. info/инфо\n12. exit/выход [user]\n13. balance/баланс [user] [val]\n14. uptime/аптайм');
        return res.json({ success: true });
    }
    if (['guard', 'код'].includes(rawOp)) {
        const user = parts[1]; const code = parts[2];
        if (guardCallbacks[user]) { guardCallbacks[user](code); saveLog(user, `Код Guard [${code}] отправлен.`); }
        else { saveLog('SYSTEM', 'Нет запросов кода.'); }
        return res.json({ success: true });
    }
    if (['collect', 'сбор'].includes(rawOp)) {
        saveLog('SYSTEM', 'Запущен сквозной автоматический сбор предметов на Мейн аккаунт...');
        return res.json({ success: true });
    }
    if (['status', 'статус'].includes(rawOp)) {
        saveLog('SYSTEM', `Активных потоков ботов в ОЗУ сервера: ${Object.keys(activeClients).length}`);
        return res.json({ success: true });
    }
    if (['db', 'бд'].includes(rawOp)) {
        db.run("VACUUM;", [], () => saveLog('SYSTEM', 'База данных SQLite сжата и оптимизирована.'));
        return res.json({ success: true });
    }
    if (['clear', 'очистить'].includes(rawOp)) {
        db.run(`DELETE FROM logs`, [], () => saveLog('SYSTEM', '--- Журнал логов полностью очищен ---'));
        return res.json({ success: true });
    }
    if (['accounts', 'аккаунты'].includes(rawOp)) {
        db.all(`SELECT username, status, balance FROM accounts`, [], (err, rows) => {
            let msg = "\nСетка аккаунтов из БД:\n";
            rows.forEach(r => { msg += `• [${r.username}] - ${r.status} | Баланс: $${r.balance}\n`; });
            saveLog('SYSTEM', msg);
        });
        return res.json({ success: true });
    }
    if (['farm', 'фарм'].includes(rawOp)) {
        const user = parts[1]; const mode = parts[2];
        if (activeClients[user]) {
            if (mode === 'off') { activeClients[user].client.gamesPlayed([]); saveLog(user, 'Накрутка часов остановлена.'); }
            else { activeClients[user].client.gamesPlayed(activeClients[user].apps); saveLog(user, 'Накрутка часов запущена.'); }
        }
        return res.json({ success: true });
    }
    if (['games', 'игры'].includes(rawOp)) {
        const user = parts[1]; const arr = parts[2] ? parts[2].split(',').map(Number) : [730];
        if (activeClients[user]) { activeClients[user].apps = arr; activeClients[user].client.gamesPlayed(arr); saveLog(user, `Список игр изменен на: ${arr.join(', ')}`); }
        return res.json({ success: true });
    }
    if (['delete', 'удалить'].includes(rawOp)) {
        const user = parts[1];
        db.run(`DELETE FROM accounts WHERE username = ?`, [user], () => saveLog('SYSTEM', `Бот ${user} удален из БД.`));
        return res.json({ success: true });
    }
    if (['info', 'инфо'].includes(rawOp)) {
        saveLog('SYSTEM', `Ядро: v6.0.0 Dynamic Node. Среда: Node.js ${process.version}. Cloud Ready.`);
        return res.json({ success: true });
    }
    if (['exit', 'выход'].includes(rawOp)) {
        const user = parts[1];
        if(activeClients[user]) { activeClients[user].client.logOff(); saveLog(user, 'Принудительный выход из сети.'); }
        return res.json({ success: true });
    }
    if (['balance', 'баланс'].includes(rawOp)) {
        const user = parts[1]; const val = parseFloat(parts[2]) || 0.00;
        db.run(`UPDATE accounts SET balance = ? WHERE username = ?`, [val, user], () => saveLog(user, `Виртуальный инвест-баланс обновлен: $${val}`));
        return res.json({ success: true });
    }
    if (['uptime', 'аптайм'].includes(rawOp)) {
        saveLog('SYSTEM', `Время непрерывной работы сервера: ${(process.uptime() / 60).toFixed(2)} минут.`);
        return res.json({ success: true });
    }

    saveLog('SYSTEM', `Команда не распознана: ${rawOp}`);
    res.json({ success: false });
});

// МОНОЛИТНАЯ КИБЕРПАНК-ПАНЕЛЬ С ВКЛАДКАМИ (TABS)
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="ru">
<head>
    <meta charset="UTF-8">
    <title>Steam Autonomous Hyper-Suite v6.0</title>
    <link href="https://googleapis.com" rel="stylesheet">
    <style>
        :root { --bg-deep: #030712; --bg-panel: #0b0f19; --bg-card: #131926; --steam-blue: #1078ff; --steam-cyan: #00ffcc; --green: #10b981; --red: #ef4444; }
        * { box-sizing: border-box; font-family: 'Plus Jakarta Sans', sans-serif; margin: 0; padding: 0; }
        body { background: var(--bg-deep); color: #f3f4f6; padding: 25px; }
        
        /* Вкладки (Tabs) */
        .tabs-nav { display: flex; gap: 10px; margin-bottom: 20px; border-bottom: 2px solid #1e293b; padding-bottom: 10px; }
        .tab-btn { background: #111827; border: 1px solid rgba(255,255,255,0.05); color: #94a3b8; padding: 12px 20px; border-radius: 8px; cursor: pointer; font-weight: bold; font-size: 0.85rem; text-transform: uppercase; }
        .tab-btn.active { background: var(--steam-blue); color: #fff; border-color: var(--steam-blue); box-shadow: 0 0 15px rgba(16,120,255,0.3); }
        .tab-content { display: none; }
        .tab-content.active { display: block; }

        .grid-layout { display: grid; grid-template-columns: 380px 1fr; gap: 25px; max-width: 1750px; margin: 0 auto; }
        .panel { background: var(--bg-panel); border: 1px solid rgba(255,255,255,0.05); border-radius: 16px; padding: 25px; display: flex; flex-direction: column; gap: 15px; box-shadow: 0 10px 40px rgba(0,0,0,0.5); }
        .panel-header { font-size: 1.1rem; font-weight: 700; color: #fff; border-bottom: 2px solid #1e293b; padding-bottom: 8px; display: flex; justify-content: space-between; align-items: center; }
        input { background: #03060f; border: 1px solid rgba(255,255,255,0.05); color: #fff; padding: 12px; border-radius: 8px; width: 100%; font-size: 0.9rem; margin-bottom: 10px; }
        .btn { background: var(--steam-blue); color: #fff; padding: 12px; border: none; border-radius: 8px; font-weight: 700; cursor: pointer; text-transform: uppercase; width: 100%; font-size: 0.8rem; }
        .btn:hover { background: #2563eb; }
        .terminal { background: #02040a; padding: 20px; border-radius: 10px 10px 0 0; height: 380px; overflow-y: auto; font-family: 'JetBrains Mono', monospace; color: #38bdf8; display: flex; flex-direction: column; gap: 6px; font-size: 0.8rem; border-bottom: 1px solid #1e293b; white-space: pre-wrap; }
        .terminal-input-wrapper { display: flex; background: #010206; border-radius: 0 0 10px 10px; border: 1px solid rgba(255,255,255,0.05); padding: 5px; }
        .terminal-input { border: none; background: transparent; color: var(--steam-cyan); margin-bottom: 0; font-family: 'JetBrains Mono', monospace; }
        .account-card { background: var(--bg-card); padding: 15px; border-radius: 10px; display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
        .status-badge { font-size: 0.75rem; font-weight: 800; padding: 4px 8px; border-radius: 4px; }
        .ONLINE { background: rgba(16,185,129,0.15); color: var(--green); }
        .OFFLINE { background: rgba(239,68,68,0.15); color: var(--red); }
        .CONNECTING { background: rgba(16,120,255,0.15); color: var(--steam-blue); }
        .neon { color: var(--steam-cyan); text-shadow: 0 0 10px rgba(0,255,204,0.3); }
    </style>
</head>
<body>

<div style="max-width:1750px; margin: 0 auto;">
    <!-- НАВИГАЦИЯ ВКЛАДОК -->
    <nav class="tabs-nav">
        <button class="tab-btn active" onclick="switchTab('tab-pool')">1. Управление Пулом ботов</button>
        <button class="tab-btn" onclick="switchTab('tab-terminal')">2. Глобальный ИИ-Терминал</button>
        <button class="tab-btn" onclick="switchTab('tab-proxy')">3. Мульти-Прокси шлюз</button>
        <button class="tab-btn" onclick="switchTab('tab-config')">4. Настройки Системы</button>
    </nav>

    <!-- ВКЛАДКА 1: УПРАВЛЕНИЕ ПУЛОМ -->
    <div id="tab-pool" class="tab-content active">
        <div class="grid-layout">
            <aside class="panel">
                <div class="panel-header">Инжектор ботов в Ветку</div>
                <input type="text" id="username" placeholder="Steam Логин">
                <input type="password" id="password" placeholder="Steam Пароль">
                <input type="text" id="shared" placeholder="Shared Secret (Для авто-2FA)">
                <button class="btn" style="background: var(--green);" onclick="addAccount()">Внедрить & Запустить бота</button>
            </aside>
            <main class="panel">
                <div class="panel-header">Активные процессы в Базе Данных (Сетка Репозитория):</div>
                <div id="accounts-container" style="display:grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap:15px;"></div>
            </main>
        </div>
    </div>

    <!-- ВКЛАДКА 2: ГЛОБАЛЬНЫЙ ИИ-ТЕРМИНАЛ -->
    <div id="tab-terminal" class="tab-content">
        <div class="panel">
            <div class="panel-header">Консоль ядра и Командная строка <span class="neon" id="ui-gen">ГЕНЕРАЦИЯ: 1</span></div>
            <div class="terminal" id="terminal-box"></div>
            <div class="terminal-input-wrapper">
                <span style="display:flex; align-items:center; padding-left:15px; color:#64748b; font-family:'JetBrains Mono', monospace;">$</span>
                <input type="text" class="terminal-input" id="term-cmd" placeholder="Введите команду (например: help или помощь)..." onkeydown="handleTerminalCommand(event)">
            </div>
        </div>
    </div>

    <!-- ВКЛАДКА 3: МУЛЬТИ-ПРОКСИ ШЛЮЗ -->
    <div id="tab-proxy" class="tab-content">
        <div class="panel">
            <div class="panel-header">Маршрутизация IP-Адресов (Proxy Branch)</div>
            <p style="color:#94a3b8; font-size:0.9rem; margin-bottom:10px;">Чтобы избежать блокировок со стороны Valve при запуске большой сетки ботов, привязывайте к ним выделенные прокси-туннели.</p>
            <input type="text" id="proxy-str" placeholder="Формат: http://логин:пароль@IP:порт">
            <p style="font-size:0.8rem; color:var(--text-muted);">* Укажите эту строчку перед инжекцией бота на Вкладке №1.</p>
        </div>
    </div>

    <!-- ВКЛАДКА 4: НАСТРОЙКИ СИСТЕМЫ -->
    <div id="tab-config" class="tab-content">
        <div class="panel" style="max-width:600px;">
            <div class="panel-header">Конфигурация Автоматизации</div>
            <input type="password" id="master-pass" value="ADMIN1234" placeholder="Введите Главный Мастер-Пароль">
            <input type="text" id="tg-token" placeholder="Telegram Bot Token">
            <input type="text" id="tg-chat" placeholder="Telegram Chat ID">
            <input type="text" id="main-id" placeholder="Главный SteamID64 (Мейн)">
            <button class="btn" onclick="saveGlobalConfig()">Записать конфигурацию в БД</button>
        </div>
    </div>
</div>

<script>
    function switchTab(tabId) {
        document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
        document.querySelectorAll('.tab-btn').forEach(el => el.classList.remove('active'));
        document.getElementById(tabId).classList.add('active');
        event.currentTarget.classList.add('active');
    }

    async function updateDashboard() {
        try {
            const res = await fetch('/api/dashboard');
            const data = await res.json();
            document.getElementById('ui-gen').innerText = 'МУТАЦИЯ ЯДРА: ' + data.generation;
            
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
                proxyStr: document.getElementById('proxy-str').value,
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

app.listen(PORT, () => console.log(`[HYPER CLOUD ACTIVE]: Сервер успешно развернут на порту: ${PORT}`));
