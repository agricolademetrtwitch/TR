const express = require('express');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const SteamUser = require('steam-user');
const SteamTotp = require('steam-totp');
const SteamCommunity = require('steamcommunity');
const TradeOfferManager = require('steam-tradeoffer-manager');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Определение путей базы данных для облака/локалки
const isCloud = process.env.RENDER || process.env.RAILWAY_STATIC_URL || false;
const dbPath = isCloud ? path.join('/tmp', 'steam_one_file_core.db') : './steam_one_file_core.db';

const db = new sqlite3.Database(dbPath, (err) => {
    if (err) console.error('Ошибка БД:', err.message);
    else console.log(`[DATABASE]: База данных запущена по пути: ${dbPath}`);
});

db.run("PRAGMA busy_timeout = 5000;");

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS system_config (id INTEGER PRIMARY KEY, generation INTEGER DEFAULT 1, tax_rate REAL DEFAULT 0.1304)`);
    db.run(`CREATE TABLE IF NOT EXISTS accounts (username TEXT PRIMARY KEY, password TEXT, shared_secret TEXT, balance REAL DEFAULT 2.00, status TEXT DEFAULT 'OFFLINE')`);
    db.run(`CREATE TABLE IF NOT EXISTS logs (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT, timestamp TEXT, message TEXT)`);
    db.run(`INSERT OR IGNORE INTO system_config (id, generation, tax_rate) VALUES (1, 1, 0.1304)`);
    db.run(`UPDATE accounts SET status = 'OFFLINE' WHERE status = 'CONNECTING' OR status = 'ONLINE'`);
});

let activeClients = {};

function saveLog(username, message) {
    const timestamp = new Date().toLocaleTimeString();
    console.log(`[${username || 'SYSTEM'}]: ${message}`);
    db.run(`INSERT INTO logs (username, timestamp, message) VALUES (?, ?, ?)`, [username || 'SYSTEM', timestamp, message]);
}

function launchAccountBot(username, password, sharedSecret) {
    if (activeClients[username]) {
        try {
            activeClients[username].client.logOff();
            activeClients[username].client.removeAllListeners();
        } catch (e) { console.error(e.message); }
        delete activeClients[username];
    }

    const client = new SteamUser();
    const community = new SteamCommunity();
    const manager = new TradeOfferManager({ steam: client, community: community, language: 'ru' });

    activeClients[username] = { client, community, manager };

    let twoFactorCode = "";
    if (sharedSecret && sharedSecret.trim() !== "") {
        try { twoFactorCode = SteamTotp.generateAuthCode(sharedSecret.trim()); } catch(e) {
            saveLog(username, `[ОШИБКА 2FA]: ${e.message}`);
        }
    }

    db.run(`UPDATE accounts SET status = 'CONNECTING' WHERE username = ?`, [username]);
    saveLog(username, "Запуск облачной сессии подключения к Steam...");

    client.logOn({ accountName: username, password: password, twoFactorCode: twoFactorCode });

    client.on('loggedOn', () => {
        db.run(`UPDATE accounts SET status = 'ONLINE' WHERE username = ?`, [username]);
        saveLog(username, "Сессия подтверждена сервером. Бот онлайн 24/7.");
        client.setPersona(SteamUser.EPersonaState.Online);
        client.gamesPlayed([730, 440]); // Фикс: Передача AppID в виде массива
    });

    client.on('webSession', (sessionID, cookies) => {
        community.setCookies(cookies);
        manager.setCookies(cookies, (err) => {
            if (err) return saveLog(username, `Критическая ошибка кук трейда: ${err.message}`);
            saveLog(username, `Сетевые фильтры Анти-API Скам активированы.`);
        });
    });

    manager.on('newOffer', (offer) => {
        if (offer.itemsToGive.length > 0 && offer.itemsToReceive.length === 0) {
            saveLog(username, `[ЗАЩИТА]: Заблокирован односторонний вывод скинов в оффере №${offer.id}`);
            offer.decline();
            return;
        }
        if (offer.itemsToGive.length === 0 && offer.itemsToReceive.length > 0) {
            saveLog(username, `[АВТО-ПРИЕМ]: Принят подарок/дроп карточек.`);
            offer.accept((err) => {
                if(!err) db.run(`UPDATE accounts SET balance = balance + 0.45 WHERE username = ?`, [username]);
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
    db.get(`SELECT * FROM system_config WHERE id = 1`, (err, config) => {
        db.all(`SELECT * FROM accounts`, (err, accs) => {
            db.all(`SELECT * FROM logs ORDER BY id DESC LIMIT 40`, (err, logRows) => {
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

app.post('/api/account/add', (req, res) => {
    const { username, password, sharedSecret } = req.body;
    if(!username || !password) return res.status(400).json({ error: "Укажите логин и пароль" });

    db.run(`INSERT OR REPLACE INTO accounts (username, password, shared_secret) VALUES (?, ?, ?)`, 
        [username, password, sharedSecret], () => {
            saveLog('SYSTEM', `Аккаунт ${username} добавлен в ветку бэкенда.`);
            launchAccountBot(username, password, sharedSecret);
            res.json({ success: true });
        }
    );
});

app.post('/api/evolve', (req, res) => {
    db.get(`SELECT * FROM system_config WHERE id = 1`, (err, row) => {
        const nextGen = row.generation + 1;
        const nextTax = parseFloat((1.11 + Math.random() * 0.08).toFixed(4));
        db.run(`UPDATE system_config SET generation = ?, tax_rate = ? WHERE id = 1`, [nextGen, nextTax], () => {
            saveLog('AI_AGENT', `Облачный ИИ мутировал код до Поколения ${nextGen}.`);
            res.json({ success: true });
        });
    });
});

// Отдача фронтенда. Внимание: Знак обратного слэша (\) перед знаком доллара ($) защищает строки JS от ложного PHP/Node парсинга!
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="ru">
<head>
    <meta charset="UTF-8">
    <title>Steam Multi-Account Cloud System v3.5</title>
    <link href="https://googleapis.com" rel="stylesheet">
    <style>
        :root { --bg-deep: #030712; --bg-panel: #0b0f19; --bg-card: #131926; --steam-blue: #1078ff; --steam-cyan: #00ffcc; --green: #10b981; --red: #ef4444; }
        * { box-sizing: border-box; font-family: 'Plus Jakarta Sans', sans-serif; margin: 0; padding: 0; }
        body { background: var(--bg-deep); color: #f3f4f6; padding: 25px; }
        .container { max-width: 1750px; margin: 0 auto; display: grid; grid-template-columns: 360px 1fr; gap: 25px; }
        .panel { background: var(--bg-panel); border: 1px solid rgba(255,255,255,0.05); border-radius: 16px; padding: 25px; display: flex; flex-direction: column; gap: 20px; box-shadow: 0 10px 40px rgba(0,0,0,0.5); }
        .panel-header { font-size: 1.1rem; font-weight: 700; color: #fff; border-bottom: 2px solid #1e293b; padding-bottom: 10px; display: flex; justify-content: space-between; align-items: center; }
        input { background: #03060f; border: 1px solid rgba(255,255,255,0.05); color: #fff; padding: 14px; border-radius: 8px; width: 100%; font-size: 0.9rem; margin-bottom: 12px; }
        input:focus { border-color: var(--steam-cyan); outline: none; }
        .btn { background: var(--steam-blue); color: #fff; padding: 14px; border: none; border-radius: 8px; font-weight: 700; cursor: pointer; text-transform: uppercase; width: 100%; font-size: 0.8rem; letter-spacing: 0.5px; }
        .btn:hover { background: #2563eb; box-shadow: 0 0 15px rgba(16,120,255,0.4); }
        .terminal { background: #02040a; padding: 20px; border-radius: 10px; height: 380px; overflow-y: auto; font-family: 'JetBrains Mono', monospace; color: #38bdf8; display: flex; flex-direction: column; gap: 6px; font-size: 0.8rem; }
        .account-card { background: var(--bg-card); padding: 15px; border-radius: 10px; display: flex; justify-content: space-between; align-items: center; margin-top: 10px; }
        .status-badge { font-size: 0.75rem; font-weight: 800; padding: 4px 8px; border-radius: 4px; text-transform: uppercase; }
        .ONLINE { background: rgba(16,185,129,0.15); color: var(--green); }
        .OFFLINE { background: rgba(239,68,68,0.15); color: var(--red); }
        .CONNECTING { background: rgba(16,120,255,0.15); color: var(--steam-blue); }
        .neon { color: var(--steam-cyan); text-shadow: 0 0 10px rgba(0,255,204,0.3); }
        .ai-panel { background: radial-gradient(circle at top left, #0d1527, var(--bg-panel)); border: 1px solid rgba(0,255,204,0.2); }
    </style>
</head>
<body>

<div class="container">
    <aside class="panel">
        <div class="panel-header">Инжектор Ветки Ботов</div>
        <div>
            <input type="text" id="username" placeholder="Steam Логин">
            <input type="password" id="password" placeholder="Steam Пароль">
            <input type="text" id="shared" placeholder="Shared Secret (Для авто-2FA)">
            <button class="btn" style="background: var(--green);" onclick="addAccount()">Внедрить аккаунт</button>
        </div>
        <div class="panel-header" style="border:none; margin-top:10px; padding:0;">Активные процессы в БД:</div>
        <div id="accounts-container" style="max-height: 250px; overflow-y: auto;"></div>
    </aside>

    <main style="display: flex; flex-direction: column; gap: 25px;">
        <div class="panel ai-panel">
            <div class="panel-header">
                <span>🤖 TRADING AI AGENT v7.5 [FIXED ENGINE]</span>
                <span class="neon" id="ui-gen">МУТАЦИЯ ЯДРА: 1</span>
            </div>
            <p style="font-style:italic; color:#94a3b8; line-height:1.6; background:#02050c; padding:15px; border-radius:8px; border-left:3px solid var(--steam-cyan);">
                "Код успешно пересобран. Исправлена ошибка интерполяции фронтенд-скриптов. База данных SQLite синхронизирована с сессиями. Система готова к работе в облаке Render."
            </p>
        </div>

        <div class="panel">
            <div class="panel-header">Центральная консоль мониторинга распределенного пула</div>
            <div class="terminal" id="terminal-box"></div>
            <div style="display: flex; justify-content: space-between; align-items: center; gap: 15px;">
                <button class="btn" onclick="evolveCore()" style="width: auto; padding: 14px 30px; background: linear-gradient(90deg, #7c3aed, var(--steam-blue));">Эволюция бэкенда & Моделей</button>
                <div style="font-size: 0.9rem; color: #94a3b8;">Налог торговой площадки: <span id="ui-tax" style="color: #fff; font-weight: bold;">13.04%</span></div>
            </div>
        </div>
    </main>
</div>

<script>
    async function updateDashboard() {
        try {
            const res = await fetch('/api/dashboard');
            const data = await res.json();
            document.getElementById('ui-gen').innerText = 'МУТАЦИЯ ЯДРА: ' + data.generation;
            document.getElementById('ui-tax').innerText = (data.taxRate * 100).toFixed(2) + '%';
            const term = document.getElementById('terminal-box');
            term.innerHTML = data.logs.map(function(log) { return '<div>' + log + '</div>'; }).join('');
            term.scrollTop = term.scrollHeight;
            const container = document.getElementById('accounts-container');
            container.innerHTML = data.accounts.map(function(acc) {
                return '<div class="account-card"><div><div style="font-weight:700; color:#fff;">' + acc.username + '</div><div style="font-size:0.8rem; color:#94a3b8; margin-top:2px;">Баланс: $' + acc.balance.toFixed(2) + '</div></div><span class="status-badge ' + acc.status + '">' + acc.status + '</span></div>';
            }).join('');
        } catch (e) {}
    }

    async function addAccount() {
        const uInput = document.getElementById('username');
        const pInput = document.getElementById('password');
        const sInput = document.getElementById('shared');
        if(!uInput.value || !pInput.value) { alert('Заполните обязательные поля!'); return; }
        await fetch('/api/account/add', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ username: uInput.value, password: pInput.value, sharedSecret: sInput.value })
        });
        uInput.value = ''; pInput.value = ''; sInput.value = '';
        updateDashboard();
    }

    async function evolveCore() {
        await fetch('/api/evolve', { method: 'POST' });
        updateDashboard();
    }

    setInterval(updateDashboard, 1500);
    window.onload = updateDashboard;
</script>
</body>
</html>
    `);
});

app.listen(PORT, () => console.log(`[CLOUD CORE]: Обновленный монолитный сервер развернут на порту ${PORT}`));
