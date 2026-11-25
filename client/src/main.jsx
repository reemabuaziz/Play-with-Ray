import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { io } from "socket.io-client";
import { QRCodeCanvas } from "qrcode.react";
import "./style.css";

const API = (import.meta.env.VITE_SERVER_URL || (import.meta.env.PROD ? location.origin : `${location.protocol}//${location.hostname}:3000`)).replace(/\/$/, "");
const roomParams = new URLSearchParams(location.search);
let roomId = roomParams.get("roomId");
if (!roomId) {
  roomId = crypto.randomUUID();
  roomParams.set("roomId", roomId);
  history.replaceState(null, "", `${location.pathname}?${roomParams.toString()}`);
}
const socket = io(API, { autoConnect: true, query: { roomId } });
const money = n => `${n ?? 0} نقطة`;

function App() {
  const [state, setState] = useState(null);
  const [info, setInfo] = useState({ ips: [] });
  const [playerName, setPlayerName] = useState("");
  const [mobilePlayer, setMobilePlayer] = useState("");
  const [mobileNames, setMobileNames] = useState(Array(5).fill(""));
  const [mobileMessage, setMobileMessage] = useState("");
  const [toast, setToast] = useState("");
  const [showRules, setShowRules] = useState(false);
  const [timeLeft, setTimeLeft] = useState(25);
  const [reveal, setReveal] = useState(false);
  const [secretValue, setSecretValue] = useState("");
  const [showQr, setShowQr] = useState(true);
  const mobile = new URLSearchParams(location.search).has("mobile");

  useEffect(() => {
    socket.on("state", s => { setState(s); setReveal(false); });
    fetch(`${API}/api/info`).then(r => r.json()).then(setInfo).catch(() => {});
    return () => socket.off("state");
  }, []);

  useEffect(() => {
    if (!state?.timerStartedAt || state.phase !== "playing") { setTimeLeft(25); return; }
    const tick = () => setTimeLeft(Math.max(0, 25 - Math.floor((Date.now() - state.timerStartedAt) / 1000)));
    tick();
    const id = setInterval(tick, 200);
    return () => clearInterval(id);
  }, [state?.timerStartedAt, state?.phase]);

  const mobileUrl = useMemo(() => {
    if (import.meta.env.PROD) return `${location.origin}/?roomId=${encodeURIComponent(roomId)}&mobile=1`;
    const ip = info.ips?.[0] || "localhost";
    return `http://${ip}:5173/?roomId=${encodeURIComponent(roomId)}&mobile=1`;
  }, [info.ips]);

  function emit(event, payload = {}) {
    socket.emit(event, payload, result => {
      if (result?.error) setToast(result.error);
      else if (result?.ok) setToast("تم بنجاح!");
      setTimeout(() => setToast(""), 2800);
    });
  }

  function addPlayer(e) {
    e.preventDefault();
    emit("register-player", { name: playerName });
    setPlayerName("");
  }
  function addMobileNameRow() { if (mobileNames.length < 20) setMobileNames([...mobileNames, ""]); }
  function submitMobileNames(e) {
    e.preventDefault();
    socket.emit("submit-names", { playerId: mobilePlayer, names: mobileNames }, result => {
      setMobileMessage(result?.error || `تم إرسال ${result.added} أسماء بنجاح!`);
      if (result?.ok) setMobileNames(Array(5).fill(""));
    });
  }
  function revealName() {
    const current = state?.players?.[state.currentPlayerIndex];
    if (!current) return;
    socket.emit("reveal-current", { playerId: current.id }, result => {
      if (result?.error) setMobileMessage(result.error);
      else { setSecretValue(result.secret); setReveal(true); }
    });
  }
  const currentPlayer = state?.players?.[state.currentPlayerIndex];
  const currentSecret = state?.names?.find(n => n.id === state.currentName?.id);
  const totalNames = state?.names?.length || 0;

  if (mobile) {
    return <main className="mobile-shell">
      <img className="mobile-logo" src="/logo.jpeg" alt="Play With Ray" />
      <h1>Play With Ray</h1>
      <p className="muted">الجوال لإدخال الأسماء وكشف الاسم السري فقط</p>
      {!state ? <p>جاري الاتصال باللعبة...</p> : state.phase === "setup" ? <>
        <section className="panel">
          <h2>إدخال الأسماء</h2>
          <label>اختر اسمك</label>
          <select value={mobilePlayer} onChange={e => setMobilePlayer(e.target.value)}>
            <option value="">اختر اللاعب</option>
            {state.players.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <form onSubmit={submitMobileNames}>
            {mobileNames.map((v, i) => <input key={i} value={v} onChange={e => setMobileNames(mobileNames.map((x,j)=>j===i?e.target.value:x))} placeholder={`اسم ${i+1}`} required />)}
            <button type="button" className="btn ghost" onClick={addMobileNameRow} disabled={mobileNames.length>=20}>+ إضافة خانة</button>
            <button className="btn green" disabled={!mobilePlayer}>أرسلها!</button>
          </form>
          <p className="muted">من 5 إلى 20 اسماً لكل لاعب. الحد الأعلى للعبة 100 اسم.</p>
          {mobileMessage && <p className="notice">{mobileMessage}</p>}
        </section>
      </> : state.phase === "playing" ? <section className="panel center">
        <h2>دور: {currentPlayer?.name}</h2>
        <p>إذا كان هذا دورك، اكشف الاسم السري فقط عندما تكون مستعداً.</p>
        {!reveal ? <button className="btn blue" onClick={revealName}>اكشف الاسم وابدأ الوقت</button> : <div className="secret">{secretValue || "—"}</div>}
        <button className="btn orange" onClick={() => emit("skip-turn", { playerId: currentPlayer?.id })} disabled={!currentPlayer || state.skipsUsed?.[currentPlayer.id]}>تخطي دوري {state.skipsUsed?.[currentPlayer?.id] ? "(استُخدم)" : "(مرة واحدة في الجولة)"}</button>
        <p className="muted">لا تعرض الشاشة على بقية اللاعبين.</p>
      </section> : <section className="panel"><h2>اللعبة متوقفة حالياً</h2><p>انتظر تعليمات شاشة اللابتوب.</p></section>}
    </main>;
  }

  return <main className="app-shell">
    <header className="topbar">
      <img src="/logo.jpeg" className="logo" alt="Play With Ray" />
      <div className="brand"><span>Play With</span><strong>Ray</strong></div>
      <button className="btn outline" onClick={() => setShowRules(true)}>ⓘ القوانين</button>
    </header>

    {!state ? <section className="panel center"><h2>جاري الاتصال بالسيرفر المحلي...</h2><p>تأكد من تشغيل السيرفر في VS Code.</p></section> : <>
      {state.phase === "setup" && <section className="panel setup-grid">
        <div>
          <p className="eyebrow">LET'S PLAY</p><h1>جهّزوا الأسماء!</h1>
          <p className="muted">أضف اللاعبين بالترتيب من اللابتوب، ثم امسحوا QR لإدخال الأسماء من الجوالات.</p>
          <form className="add-player" onSubmit={addPlayer}>
            <input value={playerName} onChange={e=>setPlayerName(e.target.value)} placeholder="اسم اللاعب" />
            <button className="btn blue">+ إضافة لاعب</button>
          </form>
          <div className="player-chips">
            {state.players.map((p,i)=><div className="chip" key={p.id}><b>{i+1}</b>{p.name}<button onClick={()=>emit("remove-player",{playerId:p.id})}>×</button><small>{state.names.filter(n=>n.owner===p.id).length}/20</small></div>)}
          </div>
          <div className="stats-row"><div><strong>{totalNames}</strong><span>اسم مسجل</span></div><div><strong>{100-totalNames}</strong><span>متبقي من الحد</span></div><div><strong>{state.players.length}</strong><span>لاعب</span></div></div>
        </div>
        <aside className="qr-card">
          <h2>امسح لإدخال الأسماء</h2>
          {showQr && <div className="qr-frame"><QRCodeCanvas value={mobileUrl} size={210} includeMargin /></div>}
          <p>QR واحد للجميع — كل لاعب يدخل اسمه ثم يرسل قائمته.</p>
          <code>{mobileUrl}</code>
          <button className="btn soft" onClick={()=>setShowQr(!showQr)}>{showQr ? "إخفاء QR" : "إظهار QR"}</button>
        </aside>
        <div className="setup-footer">
          <button className="btn orange large" onClick={()=>emit("start-game")} disabled={state.players.length<2 || state.players.some(p=>state.names.filter(n=>n.owner===p.id).length<5)}>ابدأ اللعبة! ✨</button>
          <span className="muted">كل لاعب يحتاج 5 أسماء على الأقل، والحد الأقصى 20 لكل لاعب / 100 للعبة.</span>
        </div>
      </section>}

      {state.phase === "playing" && <section className="game-layout">
        <section className="panel game-main">
          <div className="turn-label">الدور الحالي</div>
          <h1>{currentPlayer?.name}</h1>
          <p className="muted">امسح الباركود واكشف الاسم، ثم اشرح خلال 25 ثانية.</p>
          <div className="game-qr"><QRCodeCanvas value={mobileUrl} size={170} includeMargin /></div>
          <div className={`timer ${state.timerStartedAt ? "running" : ""} ${timeLeft <= 5 && state.timerStartedAt ? "urgent" : ""}`} role="timer" aria-label={`الوقت المتبقي ${timeLeft} ثانية`}>
            {String(Math.floor(timeLeft/60)).padStart(2,"0")}:{String(timeLeft%60).padStart(2,"0")}
          </div>
          <div className="timer-track" role="progressbar" aria-label="الوقت المتبقي" aria-valuemin="0" aria-valuemax="25" aria-valuenow={timeLeft}>
            <div className={`timer-progress ${timeLeft <= 5 ? "urgent" : ""}`} style={{ width: `${(timeLeft / 25) * 100}%` }} />
          </div>
          {!state.timerStartedAt ? <div className="notice">يبدأ الوقت تلقائياً عند كشف الاسم من الجوال.</div> : <div className="notice">المؤقت يعمل — ابدأوا التخمين!</div>}
          {timeLeft===0 && state.timerStartedAt && <div className="alert"><b>انتهى الوقت!</b><p>اختر الإجراء من اللابتوب.</p><button className="btn red" onClick={()=>emit("no-one-guessed")}>لم يخمن أحد (-100)</button></div>}
        </section>
        <aside className="panel score-panel">
          <h2>Scoreboard</h2>
          {state.players.map(p=><div className="score-row" key={`${p.id}-${state.scores[p.id]}`}><span>{p.name}</span><strong>{money(state.scores[p.id])}</strong><button className="penalty-btn" onClick={()=>emit("cheat-player",{playerId:p.id})}>غش −100</button></div>)}
          <div className="divider"></div>
          <h3>من خمّن الإجابة؟</h3>
          <p className="muted">اختر اللاعب الصحيح من اللابتوب لإضافة النقاط.</p>
          {state.players.filter(p=>p.id!==currentPlayer?.id).map(p=><button className="winner-pick" key={p.id} onClick={()=>emit("award-player",{playerId:p.id})}>{p.name} <b>+100</b></button>)}
          <div className="target">الهدف الحالي: {state.roundTarget} نقطة</div>
          <div className="target">الأسماء المتبقية: {state.remainingNames}</div>
        </aside>
      </section>}

      {state.phase === "round_winner" && <section className="panel winner-screen center">
        <div className="celebration" aria-hidden="true">{Array.from({length:24},(_,i)=><i key={i} style={{"--i":i,left:`${(i*41+7)%100}%`}} />)}</div>
        <div className="crown" aria-hidden="true">👑</div><p className="eyebrow">ROUND WINNER</p><h1>مبروك الفوز!</h1>
        <h2>{state.roundWinners.at(-1)?.name}</h2><div className="confetti" aria-hidden="true">🎉 ✨ 🎊 ✨ 🎉</div>
        <p>وصل إلى {state.roundTarget} نقطة!</p>
        <button className="btn green large" onClick={()=>emit("continue-round")}>كمل؟</button>
        <button className="btn outline" onClick={()=>emit("end-save")}>إنهاء وحفظ</button>
      </section>}

      {state.phase === "finished" && <section className="panel center">
        <div className="crown">🏆</div><h1>انتهى القيم!</h1><p>خلصت كل الأسماء العشوائية.</p>
        <button className="btn orange large" onClick={()=>emit("new-game",{keepPlayers:true})}>لعبة جديدة</button>
        <button className="btn outline" onClick={()=>emit("end-save")}>إنهاء وحفظ</button>
      </section>}
    </>}

    <footer>Created by Eng. Ray</footer>
    {toast && <div className="toast">{toast}</div>}
    {showRules && <div className="modal-backdrop" onClick={()=>setShowRules(false)}><section className="modal" onClick={e=>e.stopPropagation()}><button className="close" onClick={()=>setShowRules(false)}>×</button><h2>قوانين اللعبة ⭕</h2><ul>
      <li>الفوز يبدأ من 1000 نقطة.</li><li>للاعب 25 ثانية للشرح.</li><li>كلمة أو جملة واحدة فقط، مع لون واحد ومكان واحد كحد أقصى.</li><li>أول من يخمن يحصل على 100 نقطة، والشارح يحصل على 50 نقطة.</li><li>إذا لم يخمن أحد، يخسر الشارح 100 نقطة.</li><li>يمنع ذكر الاسم أو الجنسية أو صلة القرابة أو الجنس.</li><li>يمنع اختيار شخص يعرفه لاعب واحد فقط أو لا يعرفه جميع الموجودين.</li><li>الغش يخصم 100 نقطة حسب قرار مدير اللعبة.</li></ul><button className="btn blue" onClick={()=>setShowRules(false)}>إغلاق</button></section></div>}
  </main>;
}
createRoot(document.getElementById("root")).render(<App />);
