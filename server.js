<!DOCTYPE html>
<html lang="ru">
<head>
    <meta charset="UTF-8">
    <title>Steam Autonomous Supreme Suite v5.0</title>
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
    </style>
</head>
<body>

<div class="grid-layout">
    <!-- БЛОК НАСТРОЕК И ИНЖЕКТОРОВ -->
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

    <!-- ИНТЕРФЕЙС И ТЕРМИНАЛ -->
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
            term.innerHTML = data.logs.map(log => `<div>${log}</div>`).join('');
            term.scrollTop = term.scrollHeight;
            
            const container = document.getElementById('accounts-container');
            container.innerHTML = data.accounts.map(acc => `
                <div class="account-card">
                    <div>
                        <div style="font-weight:700; color:#fff;">${acc.username}</div>
                        <div style="font-size:0.75rem; color:#94a3b8; margin-top:2px;">Карточек: ${acc.farmed_cards} | Часов: ${acc.boosted_hours}</div>
                    </div>
                    <span class="status-badge ${acc.status}">${acc.status}</span>
                </div>
            `).join('');
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
