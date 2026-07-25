/** Single-page attendance UI served by the Worker at `/`. */

export function renderUi(options: { targetChatName: string }): string {
  const chatName = escapeHtml(options.targetChatName);
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="theme-color" content="#4f46e5" />
<title>attend-kun</title>
<style>
  :root { color-scheme: light dark; --bg:#f5f5f7; --card:#ffffff; --fg:#1c1c1e; --muted:#6b7280; --border:#e5e7eb; --shadow:0 1px 3px rgba(0,0,0,.08); }
  @media (prefers-color-scheme: dark) { :root { --bg:#000; --card:#1c1c1e; --fg:#f2f2f7; --muted:#98989f; --border:#2c2c2e; --shadow:none; } }
  * { box-sizing:border-box; }
  body { margin:0; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Hiragino Sans","Noto Sans JP",sans-serif; background:var(--bg); color:var(--fg); -webkit-font-smoothing:antialiased; }
  .wrap { max-width:480px; margin:0 auto; padding:20px 16px calc(24px + env(safe-area-inset-bottom)); }
  header { display:flex; align-items:baseline; justify-content:space-between; margin:8px 2px 4px; }
  h1 { font-size:20px; margin:0; letter-spacing:.2px; }
  .target { font-size:13px; color:var(--muted); margin:0 2px 18px; }
  .grid { display:grid; grid-template-columns:1fr 1fr; gap:12px; }
  button.punch { appearance:none; border:none; border-radius:16px; padding:26px 12px; font-size:19px; font-weight:700; color:#fff; cursor:pointer; box-shadow:var(--shadow); transition:transform .06s ease, filter .15s ease; }
  button.punch:active { transform:scale(.97); }
  button.punch:disabled { filter:grayscale(.5) opacity(.6); cursor:default; }
  .start { background:#16a34a; } .break { background:#f59e0b; } .resume { background:#2563eb; } .end { background:#dc2626; }
  .sub { font-size:12px; font-weight:500; opacity:.85; display:block; margin-top:4px; }
  .card { background:var(--card); border:1px solid var(--border); border-radius:14px; padding:14px 16px; margin-top:18px; box-shadow:var(--shadow); }
  .card h2 { font-size:13px; text-transform:uppercase; letter-spacing:.5px; color:var(--muted); margin:0 0 10px; }
  label { font-size:13px; color:var(--muted); display:block; margin-bottom:6px; }
  input[type=password] { width:100%; padding:11px 12px; font-size:16px; border-radius:10px; border:1px solid var(--border); background:transparent; color:var(--fg); }
  #log { list-style:none; margin:0; padding:0; font-size:13px; }
  #log li { padding:8px 0; border-top:1px solid var(--border); display:flex; gap:8px; }
  #log li:first-child { border-top:none; }
  #log .t { color:var(--muted); white-space:nowrap; font-variant-numeric:tabular-nums; }
  #log .ok { color:#16a34a; } #log .err { color:#dc2626; }
  .empty { color:var(--muted); font-size:13px; }
</style>
</head>
<body>
<div class="wrap">
  <header><h1>attend-kun</h1></header>
  <p class="target">送信先: ${chatName}</p>
  <div class="grid">
    <button class="punch start" data-type="start">開始<span class="sub">開始します</span></button>
    <button class="punch break" data-type="break">中断<span class="sub">中断します</span></button>
    <button class="punch resume" data-type="resume">再開<span class="sub">再開します</span></button>
    <button class="punch end" data-type="end">終了<span class="sub">終了します</span></button>
  </div>

  <div class="card">
    <h2>履歴</h2>
    <ul id="log"><li class="empty">まだ操作はありません</li></ul>
  </div>

  <div class="card">
    <h2>設定</h2>
    <label for="pass">パスコード</label>
    <input id="pass" type="password" autocomplete="current-password" placeholder="APP_AUTH_TOKEN" />
  </div>
</div>
<script>
(function(){
  var KEY = "attend-kun-pass";
  var passInput = document.getElementById("pass");
  var log = document.getElementById("log");
  passInput.value = localStorage.getItem(KEY) || "";
  passInput.addEventListener("change", function(){ localStorage.setItem(KEY, passInput.value.trim()); });

  function now(){
    var d = new Date();
    function p(n){ return (n<10?"0":"")+n; }
    return p(d.getHours())+":"+p(d.getMinutes())+":"+p(d.getSeconds());
  }
  function addLog(cls, text){
    var empty = log.querySelector(".empty");
    if (empty) empty.remove();
    var li = document.createElement("li");
    li.innerHTML = '<span class="t">'+now()+'</span><span class="'+cls+'"></span>';
    li.querySelector("."+cls).textContent = text;
    log.insertBefore(li, log.firstChild);
    while (log.children.length > 20) log.removeChild(log.lastChild);
  }

  var buttons = Array.prototype.slice.call(document.querySelectorAll("button.punch"));
  function setBusy(b){ buttons.forEach(function(x){ x.disabled = b; }); }

  function punch(type){
    var pass = (localStorage.getItem(KEY) || passInput.value || "").trim();
    if (!pass){ addLog("err", "パスコード未設定"); passInput.focus(); return; }
    setBusy(true);
    addLog("t", type + " を送信中...");
    fetch("/api/punch", {
      method: "POST",
      headers: { "content-type": "application/json", "authorization": "Bearer " + pass },
      body: JSON.stringify({ type: type })
    }).then(function(r){
      return r.json().then(function(body){ return { status: r.status, body: body }; });
    }).then(function(res){
      if (res.status === 200 && res.body && res.body.ok){
        var extra = res.body.relogin ? "（再ログインしました）" : "";
        addLog("ok", "送信成功: " + res.body.text + extra);
      } else if (res.status === 401){
        addLog("err", "認証エラー: パスコードを確認してください");
      } else {
        addLog("err", "失敗: " + ((res.body && res.body.error) || res.status));
      }
    }).catch(function(e){
      addLog("err", "通信エラー: " + e.message);
    }).then(function(){ setBusy(false); });
  }

  buttons.forEach(function(btn){
    btn.addEventListener("click", function(){ punch(btn.getAttribute("data-type")); });
  });
})();
</script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
