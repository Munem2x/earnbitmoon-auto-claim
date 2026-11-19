// ==UserScript==
// @name         Earnbitmoon  Auto Claim (self-learning v50.10)
// @namespace    http://tampermonkey.net/
// @version      50.10
// @description  Faucet auto-claim: self-learning, dynamic cooldown, reload-loop guards, debug-gated overlays, improved pixel solver.
// @match        https://earnbitmoon.club/*
// @match        https://*.earnbitmoon.club/*
// @downloadURL  https://raw.githubusercontent.com/Munem2x/earnbitmoon-auto-claim/main/EarnBitMoon.user.js
// @updateURL    https://raw.githubusercontent.com/Munem2x/earnbitmoon-auto-claim/main/EarnBitMoon.user.js
// @icon         https://earnbitmoon.club/static/favicon.ico
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    //  CONFIG
    const CFG = {
        COOLDOWN_MS:            5 * 60 * 1000,
        COOLDOWN_JITTER_MS:     30 * 1000,
        COOLDOWN_GRACE_MS:      2000,
        MAX_ATTEMPTS:           4,
        MAX_KNOWN_ICONS:        200,
        DHASH_SIZE:             8,
        HASH_MATCH_DIST:        4,
        MAX_HASH_VARIANTS:      8,
        ICON_PRUNE_DAYS:        30,
        // Tightened from 0.10 * 255 * 255 so that dissimilar icons are not grouped.
        MSE_THRESHOLD:          0.02 * 255 * 255,
        SOLVE_TIMEOUT_MS:       40000,
        CLICK_JITTER_PX:        8,
        HOVER_DELAY_MIN_MS:     60,
        HOVER_DELAY_MAX_MS:     180,
        BAN_BACKOFF_MS:         60 * 60 * 1000,
        ERROR_BACKOFF_BASE_MS:  60 * 1000,
        ERROR_BACKOFF_STEP_MS:  5 * 60 * 1000,
        MAX_DAILY_CLAIMS:       288,
        MAX_HISTORY_KEYS:       400,
        ICON_CLICK_MIN_MS:      900,
        ICON_CLICK_MAX_MS:      1500,
        ICON_PROMPT_WAIT_MS:    1500,
        ICON_CONTAINER_SOFT_MS: 3000,
        CANVAS_CAPTURE_TRIES:   3,
        TAB_LOCK_TTL_MS:        90000,
        TRANSIENT_RETRY_MS:     3000,
        BRUTE_MAX_CLICKS:       2,
        HEARTBEAT_MS:           60000,
        HISTORY_SIZE:           50,
        HCAPTCHA_RELOAD_MS:     30000,
        DEBUG:                  false,
    };

    const GROUP_COLORS = [
        '#FF0000','#00FF00','#0000FF','#FF00FF','#00FFFF',
        '#FFFF00','#FF8800','#8800FF','#FF4444','#44FF44'
    ];

    const SEL = {
        modal:          '#modal2my',
        claimDiv:       '#claimFaucet',
        pressWinBtn:    '#modal2my button.zxz.btn.ebm-faucet-claim-btn',
        pressWinBtnAlt: '#modal2my button[onclick*="starzRoll3"]',
        turnstileBox:   '#captcha_turnstile',
        turnstileCnt:   '#cfcaptcha-faucet',
        turnstileIn:    'input[name="cf-turnstile-response"]',
        hcaptchaBox:    '#hcaptcha-faucet',
        iconContainer:  '.iconcaptcha-modal__body-icons',
        iconBody:       '.iconcaptcha-modal__body',
        iconCircle:     '.iconcaptcha-modal__body-circle',
        iconSel:        'div.iconcaptcha-modal__body > div.iconcaptcha-modal__body-selection',
        seField:        'input[name="ic-hf-se"]',
        messageBox:     '#faucetMessage',
        closeBtn:       '#modal2my .btn-default',
        refreshBtn:     'button.btn-warning[onclick*="reload"]',
        toggleCaptcha:  '#toggleCaptcha',
    };

    const SK = {
        ICONS:       'faucet_known_icons',
        COOLDOWN:    'faucet_cooldown_until',
        ERROR_UNTIL: 'faucet_error_until',
        ERROR_COUNT: 'faucet_error_count',
        STATS:       'faucet_stats',
        ENABLED:     'faucet_enabled',
        ODD:         'faucet_odd_icons',
        MISS:        'faucet_miss_icons',
        PATHS:       'faucet_path_stats',
        TAB_LOCK:    'faucet_tab_lock',
        HISTORY:     'faucet_solve_history',
    };

    const SESSION_RELOAD = 'faucet_reload_attempted';
    const HCAPTCHA_RELOAD_KEY = 'faucet_hcaptcha_reloads';
    const REFRESH_RELOAD_KEY = 'faucet_refresh_reload_ts';

    const State = {
        IDLE:'idle', OPENING:'opening', SOLVING:'solving', SOLVED:'solved',
        COOLDOWN:'cooldown', ERROR:'error', PAUSED:'paused', BACKOFF:'backoff'
    };

    const TAB_ID = Math.random().toString(36).slice(2, 10);

    let state = State.IDLE, solveAttempts = 0, knownIcons = [], domObservers = [];
    let captchaWatcher = null, refreshTimer = null, currentSolveAbort = false;
    let isProcessing = false, turnstileHandled = false, turnstilePollTimer = null;
    let hcaptchaSubmitAt = 0;
    let hudTimer = null, heartbeatTimer = null, armHookTimer = null;
    let waitMonitorTimer = null, claimObserverRetryTimer = null, claimObserverRetries = 0;
    let stats = { claimsToday:0, errorsToday:0, lastReset:todayKey() };
    let lastErrorReason = '', lastBailReason = '', lastBailTime = 0;
    let lastDomDiag = '', lastDomIconCount = 0;
    let lastDOMPick = null;
    let refreshAttemptedThisSolve = false;

    const DEBUG_URL = new URLSearchParams(location.search).get('debug') === '1';
    const log  = (...a) => (CFG.DEBUG || DEBUG_URL) && console.log('[Faucet]', ...a);
    const warn = (...a) => (CFG.DEBUG || DEBUG_URL) && console.warn('[Faucet]', ...a);

    function wait(ms){return new Promise(r=>setTimeout(r,ms));}
    function rnd(a,b){return a+Math.random()*(b-a);}
    function todayKey(){return new Date().toISOString().slice(0,10);}
    function $(s,r){return (r||document).querySelector(s);}
    function jitter(x,a){return x+(Math.random()*2-1)*a;}
    function esc(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}

    const safeLocalGet=(k,f=null)=>{try{const v=localStorage.getItem(k);return v==null?f:v;}catch{return f;}};
    const safeLocalSet=(k,v)=>{try{localStorage.setItem(k,String(v));}catch{}};
    const safeLocalRemove=k=>{try{localStorage.removeItem(k);}catch{}};
    const safeSessionGet=(k,f=null)=>{try{const v=sessionStorage.getItem(k);return v==null?f:v;}catch{return f;}};
    const safeSessionSet=(k,v)=>{try{sessionStorage.setItem(k,String(v));}catch{}};
    const safeSessionRemove=k=>{try{sessionStorage.removeItem(k);}catch{}};

    function logBail(r){
        const now=Date.now();
        if(r===lastBailReason && now-lastBailTime<10000)return;
        lastBailReason=r; lastBailTime=now;
        log(`tick skipped: ${r}`);
    }

    //  SERVER MESSAGE PARSING
    function parseCooldownFromMessage(msg){
        if(!msg) return null;
        const text = String(msg);
        const m = text.match(/again\s+in\s+([^.,!?\n]+)/i);
        const frag = m ? m[1] : text;

        const clock = frag.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
        if(clock){
            if(clock[3]) return (parseInt(clock[1])*3600 + parseInt(clock[2])*60 + parseInt(clock[3]))*1000;
            return (parseInt(clock[1])*60 + parseInt(clock[2]))*1000;
        }

        let total = 0, found = false;
        const h = frag.match(/(\d+)\s*(?:h|hr|hour)/i);
        if(h){ total += parseInt(h[1])*3600*1000; found = true; }
        const mn = frag.match(/(\d+)\s*(?:m|min|minute)/i);
        if(mn){ total += parseInt(mn[1])*60*1000; found = true; }
        const s = frag.match(/(\d+)\s*(?:s|sec|second)/i);
        if(s){ total += parseInt(s[1])*1000; found = true; }
        return found ? total : null;
    }

    const SESSION_PATTERN = /(session|log ?in|logged out|expired|unauthori[sz]ed|sign in)/i;

    //  STATS
    function isEnabled(){return safeLocalGet(SK.ENABLED,'1')!=='0';}
    function setEnabled(on){
        safeLocalSet(SK.ENABLED,on?'1':'0');
        if(!on){
            state=State.PAUSED;
            currentSolveAbort=true;
            isProcessing=false;
            stopCaptchaWatcher(); stopTurnstilePoller();
            stopWaitMonitor(); cancelHcaptchaReload();
            releaseTabLock();
            log('paused by user');
        }
        else if(state===State.PAUSED){state=State.IDLE;currentSolveAbort=false;log('resumed');}
    }
    function loadStats(){try{const raw=safeLocalGet(SK.STATS);if(!raw)return;
        const o=JSON.parse(raw);if(o&&o.lastReset===todayKey())stats=o;
        else stats={claimsToday:0,errorsToday:0,lastReset:todayKey()};}catch{}}
    function saveStats(){safeLocalSet(SK.STATS,JSON.stringify(stats));}
    function bumpClaim(){loadStats();stats.claimsToday++;saveStats();}
    function bumpError(){loadStats();stats.errorsToday++;saveStats();}
    function dailyCapReached(){loadStats();return stats.claimsToday>=CFG.MAX_DAILY_CLAIMS;}

    const getCooldownUntil=()=>parseInt(safeLocalGet(SK.COOLDOWN,'0'),10)||0;
    const setCooldownUntil=ts=>safeLocalSet(SK.COOLDOWN,ts);
    const clearCooldown=()=>safeLocalRemove(SK.COOLDOWN);
    const getErrorUntil=()=>parseInt(safeLocalGet(SK.ERROR_UNTIL,'0'),10)||0;
    const setErrorUntil=ts=>safeLocalSet(SK.ERROR_UNTIL,ts);
    function clearErrorUntil(){safeLocalRemove(SK.ERROR_UNTIL);safeLocalSet(SK.ERROR_COUNT,'0');}
    function bumpErrorCount(){
        const n=(parseInt(safeLocalGet(SK.ERROR_COUNT,'0'),10)||0)+1;
        safeLocalSet(SK.ERROR_COUNT,n);return n;
    }
    const getErrorCount=()=>parseInt(safeLocalGet(SK.ERROR_COUNT,'0'),10)||0;

    //  SOLVE HISTORY
    function recordSolve(entry){
        let hist = [];
        try { hist = JSON.parse(safeLocalGet(SK.HISTORY) || '[]'); } catch {}
        if(!Array.isArray(hist)) hist = [];
        hist.push(Object.assign({ ts: Date.now() }, entry));
        if(hist.length > CFG.HISTORY_SIZE) hist = hist.slice(-CFG.HISTORY_SIZE);
        try { safeLocalSet(SK.HISTORY, JSON.stringify(hist)); } catch {}
    }
    function summarizeHistory(n=20){
        let hist = [];
        try { hist = JSON.parse(safeLocalGet(SK.HISTORY) || '[]'); } catch {}
        const recent = hist.slice(-n);
        const counts = { dom:0, pixel:0, brute:0 };
        for(const h of recent) if(counts[h.path] !== undefined) counts[h.path]++;
        return `${counts.dom}/${counts.pixel}/${counts.brute} (${recent.length})`;
    }

    //  TAB LOCK
    function acquireTabLock(){
        const now = Date.now();
        const cur = safeLocalGet(SK.TAB_LOCK,'');
        if(cur){
            try{
                const o = JSON.parse(cur);
                if(o && o.until > now && o.id !== TAB_ID) return false;
            }catch{}
        }
        safeLocalSet(SK.TAB_LOCK, JSON.stringify({ id: TAB_ID, until: now + CFG.TAB_LOCK_TTL_MS }));
        const check = safeLocalGet(SK.TAB_LOCK,'');
        try{
            const o = JSON.parse(check);
            return o && o.id === TAB_ID;
        }catch{ return false; }
    }
    function releaseTabLock(){
        try{
            const o = JSON.parse(safeLocalGet(SK.TAB_LOCK,''));
            if(o && o.id === TAB_ID) safeLocalRemove(SK.TAB_LOCK);
        }catch{}
    }
    function renewTabLock(){
        try{
            const o = JSON.parse(safeLocalGet(SK.TAB_LOCK,''));
            if(o && o.id === TAB_ID)
                safeLocalSet(SK.TAB_LOCK, JSON.stringify({ id: TAB_ID, until: Date.now() + CFG.TAB_LOCK_TTL_MS }));
        }catch{}
    }
    function isTabLockHeld(){
        try{
            const o = JSON.parse(safeLocalGet(SK.TAB_LOCK,''));
            return !!(o && o.until > Date.now());
        }catch{ return false; }
    }

    //  STABLE KEY EXTRACTION
    function extractStableKey(url){
        if(!url) return url;
        const m = url.match(/payload=([A-Za-z0-9_\-+=\/]+)/);
        if(m){
            let b64 = m[1].replace(/-/g,'+').replace(/_/g,'/');
            while(b64.length % 4) b64 += '=';
            try{
                const obj = JSON.parse(atob(b64));
                delete obj.ts;
                const stable = btoa(JSON.stringify(obj));
                return url.replace(m[1], stable);
            }catch{}
        }
        return url.replace(/\?.*$/,'');
    }

    //  ICON REGISTRY
    function loadKnownIcons(){
        let raw=[];
        try{ raw = safeLocalGet(SK.ICONS) ? JSON.parse(safeLocalGet(SK.ICONS)) : []; }catch{ raw = []; }
        if(!Array.isArray(raw)) raw=[];

        let migrated=0;
        knownIcons = raw.map(item=>{
            if(item && Array.isArray(item.hashes)) return item;
            if(item && item.hash){
                migrated++;
                return {
                    id:'c'+Math.random().toString(36).slice(2,8),
                    hashes:[item.hash], thumb:item.thumb||'',
                    count:1, oddCount:0, lastSeen:Date.now()
                };
            }
            return null;
        }).filter(Boolean);
        if(migrated) log(`Migrated ${migrated} legacy icon(s).`);
        pruneKnownIcons();
    }
    function pruneKnownIcons(){
        if(!knownIcons.length) return;
        const cutoff = Date.now() - CFG.ICON_PRUNE_DAYS * 86400000;
        const before = knownIcons.length;
        knownIcons = knownIcons.filter(e => (e.lastSeen || 0) >= cutoff);
        const removed = before - knownIcons.length;
        if(removed){ log(`Pruned ${removed} stale icon(s).`); saveKnownIcons(); }
    }
    function saveKnownIcons(){
        try{
            if(knownIcons.length > CFG.MAX_KNOWN_ICONS)
                knownIcons = knownIcons.slice(-CFG.MAX_KNOWN_ICONS);
            safeLocalSet(SK.ICONS, JSON.stringify(knownIcons));
        }catch{}
    }
    function hammingDistance(a,b){
        if(!a || !b || a.length !== b.length) return Infinity;
        let d = 0;
        for(let i = 0; i < a.length; i++) if(a[i] !== b[i]) d++;
        return d;
    }
    function popcount8(n){
        n = n - ((n >> 1) & 0x55);
        n = (n & 0x33) + ((n >> 2) & 0x33);
        return (n + (n >> 4)) & 0x0F;
    }
    function findCanonical(hash){
        if(!hash) return null;
        const fb = parseInt(hash.slice(0,8), 2);
        const tp = popcount8(fb);
        let best = null, bestDist = Infinity;
        for(const entry of knownIcons){
            for(const h of entry.hashes){
                const hb = parseInt(h.slice(0,8), 2);
                if(Math.abs(popcount8(hb) - tp) > CFG.HASH_MATCH_DIST) continue;
                const d = hammingDistance(hash, h);
                if(d < bestDist){ bestDist = d; best = entry; }
            }
        }
        return (best && bestDist <= CFG.HASH_MATCH_DIST) ? best : null;
    }
    function findKnownIcon(hash){ return findCanonical(hash); }
    function addKnownIcon(hash, thumbDataURL){
        if(!hash) return null;
        const ex = findCanonical(hash);
        if(ex){
            if(!ex.hashes.includes(hash)){
                ex.hashes.push(hash);
                if(ex.hashes.length > CFG.MAX_HASH_VARIANTS)
                    ex.hashes = ex.hashes.slice(-CFG.MAX_HASH_VARIANTS);
            }
            ex.count = (ex.count || 1) + 1;
            ex.lastSeen = Date.now();
            if(!ex.thumb && thumbDataURL) ex.thumb = thumbDataURL;
            saveKnownIcons();
            return ex;
        }
        const entry = {
            id: 'c'+Date.now().toString(36)+Math.random().toString(36).slice(2,6),
            hashes: [hash], thumb: thumbDataURL || '',
            count: 1, oddCount: 0, lastSeen: Date.now()
        };
        knownIcons.push(entry);
        saveKnownIcons();
        return entry;
    }

    //  CANONICAL / DOM KEYS
    //  Pixel hashes fold onto their canonical icon so render variants of the same
    //  image share one evidence counter.  DOM keys are namespaced separately: the
    //  DOM path has no pixel data, so it cannot be matched against a dHash.
    function canonicalKey(hash){
        const c = findCanonical(hash);
        return c ? 'c:' + c.id : 'h:' + hash;
    }
    function domKey(key){ return 'd:' + key; }

    //  ODD / MISS HISTORY
    function bumpKeyMap(store, key){
        if(!key) return;
        let d = {};
        try{ d = JSON.parse(safeLocalGet(store) || '{}'); }catch{}
        d[key] = (d[key] || 0) + 1;
        //  Bound the map: once it overflows, drop the weakest entries so
        //  localStorage cannot grow without limit.
        const keys = Object.keys(d);
        if(keys.length > CFG.MAX_HISTORY_KEYS){
            keys.sort((a, b) => d[a] - d[b]);
            for(const k of keys.slice(0, keys.length - CFG.MAX_HISTORY_KEYS)) delete d[k];
            log(`Pruned ${keys.length - CFG.MAX_HISTORY_KEYS} history key(s) from ${store}.`);
        }
        try{ safeLocalSet(store, JSON.stringify(d)); }catch{}
    }
    function readKeyMap(store, key){
        if(!key) return 0;
        try{ return (JSON.parse(safeLocalGet(store) || '{}'))[key] || 0; }catch{ return 0; }
    }
    function recordOddKey(key){ bumpKeyMap(SK.ODD, key); }
    function getOddScore(key){ return readKeyMap(SK.ODD, key); }
    function recordMissKey(key){ bumpKeyMap(SK.MISS, key); }
    function getMissScore(key){ return readKeyMap(SK.MISS, key); }
    function keyScore(key){ return getOddScore(key)*2 - getMissScore(key); }

    //  PATH STATS
    function bumpPath(name, won){
        if(!name) return;
        let s={}; try{ s = JSON.parse(safeLocalGet(SK.PATHS)||'{}'); }catch{}
        if(!s[name]) s[name] = { win:0, loss:0 };
        won ? s[name].win++ : s[name].loss++;
        try{ safeLocalSet(SK.PATHS, JSON.stringify(s)); }catch{}
    }
    function getPathStats(){
        try{ return JSON.parse(safeLocalGet(SK.PATHS)||'{}'); }catch{ return {}; }
    }

    //  SOLVE SUMMARY LOG
    function logSolveSummary(path, cellIdx, totalIcons, groupSize){
        const totalHashes = knownIcons.reduce((s,e)=>s+e.hashes.length, 0);
        log(` Solved via ${path}: cell ${cellIdx+1}/${totalIcons} (group ${groupSize}) | canon=${knownIcons.length} var=${totalHashes}`);
    }

    //  DOM
    const getModal = () => $(SEL.modal);
    const isModalOpen = () => { const m = getModal(); return !!(m && m.classList.contains('show')); };
    function getClaimButton(){
        const d = $(SEL.claimDiv);
        if(!d || d.classList.contains('d-none')) return null;
        return d.querySelector('button');
    }
    function isClaimReady(){
        const d = $(SEL.claimDiv);
        if(!d || d.classList.contains('d-none')) return false;
        const btn = d.querySelector('button');
        if(!btn || btn.disabled) return false;
        //  The page has no countdown element for the claim button; cooldown
        //  gating lives in maybeRun() via the persisted cooldown timestamp.
        return true;
    }
    const getSeInput = () => $(SEL.seField);
    const getSelectionElement = () => $(SEL.iconSel);
    function getIconContainer(){
        const m = getModal();
        return m ? m.querySelector(SEL.iconContainer) : null;
    }
    function getPressAndWinButton(){ return $(SEL.pressWinBtn) || $(SEL.pressWinBtnAlt); }

    //  hCAPTCHA HANDLING
    function isHCaptchaActive() {
        const toggle = $(SEL.toggleCaptcha);
        if (toggle && toggle.value === '1') return true;

        const hc = $(SEL.hcaptchaBox);
        if (hc) {
            const wrapper = hc.closest('.load_captcha');
            if (wrapper && !wrapper.classList.contains('d-none')) {
                if (hc.querySelector('iframe')) return true;
            }
        }

        const modal = getModal();
        if (modal && modal.querySelector('iframe[src*="hcaptcha.com"]')) {
            return true;
        }

        return false;
    }

    function getHCaptchaToken() {
        try {
            if (typeof hcaptcha !== 'undefined' && window.hCaptchaFaucet !== null) {
                return hcaptcha.getResponse(window.hCaptchaFaucet);
            }
        } catch {}
        const hc = $(SEL.hcaptchaBox);
        if (hc) {
            const ta = hc.querySelector('textarea[name="h-captcha-response"]');
            if (ta && ta.value) return ta.value;
        }
        return null;
    }

    function cancelHcaptchaReload(){
        if (window.__hcaptchaReloadTimer) {
            clearTimeout(window.__hcaptchaReloadTimer);
            window.__hcaptchaReloadTimer = null;
            log('hCaptcha reload cancelled.');
        }
    }

    //  Returns 'clicked' (token present  submit fired), 'waiting' (still active)
    //  or null (hCaptcha not in use).  Callers must not treat 'waiting' as a
    //  completed submit.
    function handleHCaptcha() {
        if (!isHCaptchaActive()) {
            if (window.__hcaptchaReloadTimer) {
                cancelHcaptchaReload();
                log('hCaptcha gone  cancelled pending reload.');
            }
            if (safeSessionGet(HCAPTCHA_RELOAD_KEY, '0') !== '0') {
                safeSessionRemove(HCAPTCHA_RELOAD_KEY);
                log('hCaptcha reload counter reset.');
            }
            return null;
        }

        const token = getHCaptchaToken();
        if (token) {
            if(Date.now() - hcaptchaSubmitAt < 60000){
                log(' hCaptcha token still present  submit already fired.');
                return 'waiting';
            }
            hcaptchaSubmitAt = Date.now();
            log(' hCaptcha solved manually! Proceeding to submit...');
            cancelHcaptchaReload();
            const btn = getPressAndWinButton();
            if (btn && !btn.disabled) btn.click();
            else if (typeof window.starzRoll3 === 'function') window.starzRoll3();
            return 'clicked';
        }

        if (!window.__hcaptchaReloadTimer) {
            const reloads = (parseInt(safeSessionGet(HCAPTCHA_RELOAD_KEY,'0'),10) || 0) + 1;
            if(reloads > 5){
                log(' hCaptcha reload cap reached  backing off 10 min.');
                window.__hcaptchaReloadTimer = setTimeout(() => {
                    log('Reloading page after hCaptcha backoff.');
                    window.location.reload();
                }, 10*60*1000);
                return 'waiting';
            }
            safeSessionSet(HCAPTCHA_RELOAD_KEY, String(reloads));
            log(' hCaptcha detected as main captcha. AI solve not configured.');
            log(` Waiting ${CFG.HCAPTCHA_RELOAD_MS/1000}s for manual solve before refreshing...`);

            window.__hcaptchaReloadTimer = setTimeout(() => {
                log('Reloading page to bypass hCaptcha.');
                window.location.reload();
            }, CFG.HCAPTCHA_RELOAD_MS);
        }
        return 'waiting';
    }

    //  CAPTCHA REFRESH
    async function attemptCaptchaRefresh(){
        try{
            if(window.jQuery){
                const holder = document.querySelector('.iconcaptcha-holder');
                if(holder){
                    const $h = window.jQuery(holder);
                    const inst = $h.data('iconcaptcha') || $h.data('iconCaptcha') || $h.data('IconCaptcha');
                    if(inst && typeof inst.refresh === 'function'){
                        log('Calling plugin refresh()');
                        inst.refresh();
                        await wait(1200);
                        return true;
                    }
                }
            }
        }catch(e){ warn('plugin refresh failed:', e); }

        const sels = [
            '.iconcaptcha-modal__header-refresh',
            '.iconcaptcha-modal__refresh',
            '[class*="iconcaptcha"] [class*="refresh"]',
            '[class*="iconcaptcha"] [class*="Reset"]',
        ];
        for(const s of sels){
            const b = document.querySelector(s);
            if(b && b.offsetParent !== null){
                log(`Clicking refresh via ${s}`);
                b.click();
                await wait(1200);
                return true;
            }
        }
        return false;
    }

    //  DOM ICON DISCOVERY
    function getDOMIcons(){
        const container = getIconContainer();
        if(!container){ lastDomDiag = 'no container'; lastDomIconCount = 0; return null; }
        const cRect = container.getBoundingClientRect();
        if(cRect.width < 8 || cRect.height < 8){ lastDomDiag = 'container 0-size'; lastDomIconCount = 0; return null; }

        let children = Array.from(container.children);
        if(children.length === 1 && children[0].children.length >= 4)
            children = Array.from(children[0].children);
        if(children.length < 4){ lastDomDiag = `only ${children.length} kids`; lastDomIconCount = 0; return null; }

        const icons = [];
        for(const el of children){
            const r = el.getBoundingClientRect();
            if(r.width < 8 || r.height < 8) continue;
            const cs = getComputedStyle(el);
            let key = null;
            for(const a of ['data-icon','data-image','data-src','data-id']){
                if(el.hasAttribute(a)){ key = a + ':' + el.getAttribute(a); break; }
            }
            if(!key){
                const bg = cs.backgroundImage || '';
                if(bg && bg !== 'none')
                    key = extractStableKey(bg) + '|' + cs.backgroundPosition;
            }
            if(!key){ const img = el.querySelector('img'); if(img) key = 'img:' + extractStableKey(img.src); }
            if(!key) key = 'html:' + el.outerHTML.slice(0, 200);
            icons.push({ el, key, cx: r.left - cRect.left + r.width/2, cy: r.top - cRect.top + r.height/2 });
        }
        if(icons.length < 4 || icons.length > 8){ lastDomDiag = `found ${icons.length}`; lastDomIconCount = 0; return null; }
        lastDomDiag = `ok: ${icons.length}`;
        lastDomIconCount = icons.length;
        return icons;
    }

    async function solveByDOM(){
        const icons = getDOMIcons();
        if(!icons) return null;
        log(`DOM icons: ${icons.length}`);

        const groups = new Map();
        icons.forEach((ic, i) => {
            if(!groups.has(ic.key)) groups.set(ic.key, []);
            groups.get(ic.key).push(i);
        });
        log(`DOM unique keys: ${groups.size}`);
        if(groups.size < 2){ log('DOM: identical keys.'); return null; }

        let minCount = Infinity;
        for(const [, idx] of groups) if(idx.length < minCount) minCount = idx.length;
        let cands = [];
        for(const [, idx] of groups) if(idx.length === minCount) cands.push(idx);

        let best = null, bestScore = -Infinity;
        for(const cand of cands){
            const sc = cand.reduce((s, i) => s + keyScore(domKey(icons[i].key)), 0);
            if(sc > bestScore){ bestScore = sc; best = cand; }
        }
        const chosen = best || cands[0];
        if(cands.length > 1) log(`DOM tie  chose score ${bestScore} (${chosen.length} icon).`);

        if(cands.length > 1 && bestScore <= 0 && chosen.length === 1 && !refreshAttemptedThisSolve){
            refreshAttemptedThisSolve = true;
            log('DOM low confidence  trying captcha refresh');
            const refreshed = await attemptCaptchaRefresh();
            if(refreshed){
                log('Refresh OK  returning to retry loop with fresh captcha.');
                return false;
            }
            log('Refresh unavailable  proceeding with click anyway.');
        }

        const ti = chosen[0];
        const target = icons[ti];
        log(`DOM target cell ${ti+1}/${icons.length} (group ${chosen.length}).`);

        const sel = getSelectionElement();
        if(!sel){ warn('DOM: no selection element.'); return null; }

        const sr = sel.getBoundingClientRect();
        const x = jitter(sr.left + target.cx, CFG.CLICK_JITTER_PX);
        const y = jitter(sr.top + target.cy, CFG.CLICK_JITTER_PX);

        fireMouse(sel, 'mouseenter', x, y);
        fireMouse(sel, 'mousemove', x, y);
        await wait(Math.round(rnd(CFG.HOVER_DELAY_MIN_MS, CFG.HOVER_DELAY_MAX_MS)));
        fireMouse(sel, 'click', x, y);

        await wait(Math.round(rnd(CFG.ICON_CLICK_MIN_MS, CFG.ICON_CLICK_MAX_MS)));

        const se = getSeInput();
        const solved = !!(se && se.value && se.value.length > 0);
        if(solved){
            recordOddKey(domKey(target.key));
            logSolveSummary('dom', ti, icons.length, chosen.length);
            recordSolve({ path:'dom', cell:ti, groupSize: chosen.length, totalIcons: icons.length });
        } else {
            recordMissKey(domKey(target.key));
        }
        bumpPath('dom', solved);
        lastDOMPick = ti;
        log(`DOM click: ${solved ? 'SOLVED' : 'missed'}.`);
        return solved;
    }

    async function softWaitForIcons(maxMs = CFG.ICON_CONTAINER_SOFT_MS){
        const start = Date.now();
        while(Date.now() - start < maxMs){
            const c = getIconContainer();
            if(c && c.children.length > 0) return true;
            await wait(150);
        }
        log(`Icons not populated within ${maxMs}ms  proceeding anyway.`);
        return false;
    }

    //  PIXEL UTILS
    function isCanvasBlank(imageData){
        const d = imageData.data;
        let min = 255, max = 0, sum = 0, n = 0;
        for(let i = 0; i < d.length; i += 64){
            const v = (d[i] + d[i+1] + d[i+2]) / 3;
            if(v < min) min = v;
            if(v > max) max = v;
            sum += v; n++;
        }
        if(!n) return true;
        const mean = sum / n, spread = max - min;
        if(spread < 18) return true;
        if(mean < 8) return true;
        return false;
    }

    function detectIconRegions(imageData, preferredCount){
        const data = imageData.data, w = imageData.width, h = imageData.height;
        const col = new Float32Array(w);
        for(let x = 0; x < w; x++){
            let s = 0;
            for(let y = 0; y < h; y++){
                const i = (y * w + x) * 4;
                s += (data[i] + data[i+1] + data[i+2]) / 3;
            }
            col[x] = s / h;
        }
        let mn = Infinity, mx = -Infinity;
        for(let x = 0; x < w; x++){ if(col[x] < mn) mn = col[x]; if(col[x] > mx) mx = col[x]; }
        const range = mx - mn;
        if(range < 18) return null;
        const norm = new Float32Array(w);
        let sN = 0;
        for(let x = 0; x < w; x++){ norm[x] = (col[x] - mn) / range; sN += norm[x]; }
        const meanN = sN / w, thr = meanN * 0.5;

        const gaps = []; let inside = false, start = 0;
        for(let x = 0; x < w; x++){
            const g = norm[x] < thr;
            if(g && !inside){ inside = true; start = x; }
            else if(!g && inside){
                inside = false;
                if(x - start > 2) gaps.push({ start, end:x, width: x - start });
            }
        }
        if(inside && w - start > 2) gaps.push({ start, end:w, width:w - start });

        const merged = [];
        for(const g of gaps){
            if(!merged.length){ merged.push({ ...g }); continue; }
            const last = merged[merged.length-1];
            if(g.start - last.end < 5){ last.end = g.end; last.width = last.end - last.start; }
            else merged.push({ ...g });
        }

        const regions = [];
        if(!merged.length) return null;
        if(merged[0].start > 0) regions.push({ start:0, end: merged[0].start, width: merged[0].start });
        for(let i = 0; i < merged.length - 1; i++){
            const s = merged[i].end, e = merged[i+1].start;
            if(e - s > 5) regions.push({ start:s, end:e, width:e - s });
        }
        const lastG = merged[merged.length-1];
        if(lastG.end < w) regions.push({ start: lastG.end, end: w, width: w - lastG.end });

        // Relaxed sanity check: trust detected regions if we get a reasonable count (4-8).
        // Previously this required exactly 5 or 6, which was too brittle.
        const MIN_REGIONS = 4;
        const MAX_REGIONS = 8;
        if(regions.length >= MIN_REGIONS && regions.length <= MAX_REGIONS){
            log(`Detected ${regions.length} regions.`);
            return regions;
        }
        warn(`Gap gave ${regions.length} regions (expected ${MIN_REGIONS}-${MAX_REGIONS})  fallback.`);
        return fallbackRegions(w, preferredCount);
    }
    function fallbackRegions(w, preferredCount){
        const ideal = 75;
        //  The DOM icon count is the most reliable hint when gap detection fails.
        const candidates = [];
        if(preferredCount >= 4 && preferredCount <= 8) candidates.push(preferredCount);
        candidates.push(5, 6);
        let best = candidates[0], bestErr = Infinity;
        for(const n of candidates){
            const cell = w / n;
            if(cell < 20) continue;
            const err = Math.abs(cell - ideal);
            if(err < bestErr){ bestErr = err; best = n; }
        }
        const cw = w / best;
        log(`Fallback ${best} cols${preferredCount ? ` (dom=${preferredCount})` : ''}.`);
        return Array.from({ length: best }, (_, i) => ({ start: i*cw, end: (i+1)*cw, width: cw }));
    }

    function computeDHash(imageData, hashSize = CFG.DHASH_SIZE){
        try{
            const w = imageData.width, h = imageData.height;
            const tmp = document.createElement('canvas');
            tmp.width = hashSize + 1; tmp.height = hashSize;
            const tctx = tmp.getContext('2d');
            const src = document.createElement('canvas');
            src.width = w; src.height = h;
            src.getContext('2d').putImageData(imageData, 0, 0);
            tctx.drawImage(src, 0, 0, tmp.width, tmp.height);
            const px = tctx.getImageData(0, 0, tmp.width, tmp.height).data;
            const bits = [];
            for(let y = 0; y < hashSize; y++) for(let x = 0; x < hashSize; x++){
                const i = (y * (hashSize+1) + x) * 4, j = i + 4;
                const L = 0.299*px[i] + 0.587*px[i+1] + 0.114*px[i+2];
                const R = 0.299*px[j] + 0.587*px[j+1] + 0.114*px[j+2];
                bits.push(L > R ? '1' : '0');
            }
            return bits.join('');
        }catch(e){ warn('DHash err:', e); return ''; }
    }
    function computeMSE(a, b){
        const n = Math.min(a.length, b.length);
        if(!n) return Infinity;
        let s = 0;
        for(let i = 0; i < n; i++){ const d = a[i] - b[i]; s += d * d; }
        return s / n;
    }

    function loadHtml2canvas(){
        return new Promise(resolve => {
            if(typeof html2canvas !== 'undefined') return resolve();
            const s = document.createElement('script');
            s.src = 'https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js';
            s.onload = () => resolve();
            s.onerror = () => { warn('html2canvas load failed'); resolve(); };
            document.head.appendChild(s);
        });
    }

    //  TURNSTILE
    function isTurnstileActive(){
        const box = $(SEL.turnstileBox);
        if(!box) return false;
        if(box.classList.contains('d-none')) return false;
        const cs = getComputedStyle(box);
        if(cs.display === 'none' || cs.visibility === 'hidden') return false;
        return true;
    }
    function getTurnstileToken(){
        const cnt = $(SEL.turnstileCnt);
        if(cnt){
            let inp = cnt.querySelector(SEL.turnstileIn);
            if(!inp && cnt.parentElement) inp = cnt.parentElement.querySelector(SEL.turnstileIn);
            if(inp && inp.value) return inp.value;
        }
        try{
            if(typeof turnstile !== 'undefined' && window.CFTurnstileFaucet != null){
                const r = turnstile.getResponse(window.CFTurnstileFaucet);
                if(r) return r;
            }
        }catch{}
        return null;
    }
    function patchTurnstileRender(){
        if(window.__ebmTurnstilePatched) return true;
        if(typeof window.turnstile === 'undefined' || !window.turnstile.render) return false;
        const orig = window.turnstile.render.bind(window.turnstile);
        window.turnstile.render = function(container, opts){
            const userCb = opts && opts.callback;
            const patched = Object.assign({}, opts, {
                callback: (token) => {
                    try{ userCb && userCb(token); }catch(e){ warn('user cb err:', e); }
                    log('Turnstile callback fired.');
                    onTurnstileSolved();
                }
            });
            const id = orig(container, patched);
            window.CFTurnstileFaucet = id;
            return id;
        };
        window.__ebmTurnstilePatched = true;
        log('turnstile.render patched.');
        return true;
    }
    function onTurnstileSolved(){
        if(turnstileHandled) return;
        if(!isModalOpen()) return;
        const btn = getPressAndWinButton();
        if(!btn) return;
        turnstileHandled = true;
        log(' Turnstile solved  clicking Press & Win.');
        setTimeout(() => {
            try{ btn.click(); }catch(e){ warn('click fail:', e); }
        }, Math.round(rnd(180, 420)));
    }
    function startTurnstilePoller(){
        stopTurnstilePoller();
        turnstilePollTimer = setInterval(() => {
            if(!isModalOpen() || turnstileHandled) return;
            if(!isTurnstileActive()) return;
            const tok = getTurnstileToken();
            if(!tok) return;
            onTurnstileSolved();
        }, 600);
    }
    function stopTurnstilePoller(){
        if(turnstilePollTimer){ clearInterval(turnstilePollTimer); turnstilePollTimer = null; }
    }
    function resetTurnstileWidget(){
        try{
            if(typeof turnstile !== 'undefined' && window.CFTurnstileFaucet != null){
                turnstile.reset(window.CFTurnstileFaucet);
            }
        }catch{}
        turnstileHandled = false;
    }

    //  WAIT MONITOR
    //  Handing off to hCaptcha/Turnstile must not leave isProcessing stuck true,
    //  otherwise maybeRun() bails on "busy" forever and the bot stalls.
    function startWaitMonitor(){
        stopWaitMonitor();
        waitMonitorTimer = setInterval(() => {
            if(!isEnabled() || !isModalOpen() || state !== State.SOLVING){
                stopWaitMonitor();
                return;
            }
            if(isTabLockHeld()) renewTabLock();
            //  handleHCaptcha() both drives a live widget and cancels the pending
            //  reload + resets the counter once the widget goes away.
            if(handleHCaptcha()) return;
            if(isTurnstileActive()){
                if(!turnstilePollTimer){
                    turnstileHandled = false;
                    patchTurnstileRender();
                    startTurnstilePoller();
                }
                return;
            }
            stopWaitMonitor();
            turnstileHandled = false;
            if(state === State.SOLVING){
                state = State.IDLE;
                isProcessing = false;
                log('Wait condition cleared  resuming.');
                maybeRun('wait-cleared');
            }
        }, 1000);
    }
    function stopWaitMonitor(){
        if(waitMonitorTimer){ clearInterval(waitMonitorTimer); waitMonitorTimer = null; }
    }
    function enterWaitHandoff(){
        isProcessing = false;
        state = State.SOLVING;
        turnstileHandled = false;
        patchTurnstileRender();
        startTurnstilePoller();
        startWaitMonitor();
    }

    //  PROMPT + SOLVE
    function fireMouse(el, type, x, y){
        el.dispatchEvent(new MouseEvent(type, {
            bubbles: true, cancelable: true, view: window,
            clientX: x, clientY: y, button: 0
        }));
    }
    function clickPromptOnce(modal){
        const body = modal.querySelector(SEL.iconBody);
        if(!body) return false;
        const circle = body.querySelector(SEL.iconCircle);
        const target = circle || body;
        ['mousedown','mouseup','click'].forEach(t => {
            target.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true }));
        });
        return true;
    }
    async function clickVerificationPrompt(modal){
        const container = modal.querySelector(SEL.iconContainer);
        if(container && container.children.length > 0) return true;
        const body = modal.querySelector(SEL.iconBody);
        if(!body) return false;
        log('Clicking verification prompt');
        clickPromptOnce(modal);
        const s1 = Date.now();
        while(Date.now() - s1 < CFG.ICON_PROMPT_WAIT_MS){
            const c = modal.querySelector(SEL.iconContainer);
            if(c && c.children.length > 0){ log('Icons appeared.'); return true; }
            await wait(150);
        }
        log('Prompt retry click.');
        clickPromptOnce(modal);
        const s2 = Date.now();
        while(Date.now() - s2 < CFG.ICON_PROMPT_WAIT_MS){
            const c = modal.querySelector(SEL.iconContainer);
            if(c && c.children.length > 0) return true;
            await wait(150);
        }
        return false;
    }

    // Solve with a timeout guard so a stuck captcha cannot stall the whole loop.
    async function solveIconCaptcha(){
        currentSolveAbort = false;
        refreshAttemptedThisSolve = false;
        const modal = getModal();
        if(!modal || !isModalOpen()){ warn('Modal not open.'); return false; }

        const se0 = getSeInput();
        if(se0 && se0.value && se0.value.length > 0){ log('se already set.'); return true; }

        const timeoutMs = CFG.SOLVE_TIMEOUT_MS;
        let timeoutId = null;
        const timedOut = new Promise((_, reject) => {
            timeoutId = setTimeout(() => {
                currentSolveAbort = true;
                reject(new Error('solve timeout'));
            }, timeoutMs);
        });
        const solver = (async () => {
            await clickVerificationPrompt(modal);
            if(currentSolveAbort) return false;
            await softWaitForIcons();
            if(currentSolveAbort) return false;

            lastDOMPick = null;

            const domResult = await solveByDOM();
            if(domResult === true) return true;
            if(currentSolveAbort) return false;
            if(domResult === null) log(`DOM unavailable (${lastDomDiag})  pixel.`);
            else log('DOM clicked but missed  pixel.');

            const container = getIconContainer();
            if(!container){ warn('Icon container gone.'); return false; }

            if(typeof html2canvas !== 'function'){ warn('html2canvas unavailable  cannot pixel-solve.'); return false; }
            let canvas = null;
            for(let i = 0; i < CFG.CANVAS_CAPTURE_TRIES; i++){
                if(currentSolveAbort) return false;
                let snapped = null;
                try{
                    snapped = await html2canvas(container, {
                        useCORS: true, allowTaint: true,
                        backgroundColor: '#000000', scale: 1, imageTimeout: 3000,
                    });
                }catch(e){ warn('html2canvas err:', e); }
                if(snapped){
                    try{
                        const tctx = snapped.getContext('2d', { willReadFrequently: true });
                        const test = tctx.getImageData(0, 0, snapped.width, snapped.height);
                        if(!isCanvasBlank(test)){ canvas = snapped; break; }
                        warn(`Blank canvas ${i+1}/${CFG.CANVAS_CAPTURE_TRIES}.`);
                    }catch(e){ warn('canvas stat err:', e); }
                }
                await wait(500 + Math.random() * 500);
            }
            if(!canvas){ warn('Canvas blank after retries.'); return false; }
            if(currentSolveAbort){ warn('Solve aborted after capture.'); return false; }

            try{
                const ctx = canvas.getContext('2d', { willReadFrequently: true });
                const cW = canvas.width, cH = canvas.height;
                const img = ctx.getImageData(0, 0, cW, cH);
                const regions = detectIconRegions(img, lastDomIconCount);
                if(!regions){ warn('Region detection failed.'); return false; }
                log(`Using ${regions.length} pixel regions.`);

                const hashes = [], thumbs = [], rawData = [];
                for(const reg of regions){
                    const x = Math.floor(reg.start), w = Math.floor(reg.width);
                    const crop = ctx.getImageData(x, 0, w, cH);
                    const h = computeDHash(crop);
                    hashes.push(h);
                    const tc = document.createElement('canvas');
                    tc.width = 32; tc.height = 25;
                    tc.getContext('2d').drawImage(canvas, x, 0, w, cH, 0, 0, 32, 25);
                    const td = tc.toDataURL('image/png');
                    thumbs.push(td);
                    rawData.push(new Uint8Array(crop.data));
                    //  NB: icons are registered as known only after a VERIFIED
                    //  solve, never on sighting, so decoys cannot pollute the
                    //  registry.
                }

                let groups = new Map(), targetCell = -1;
                const hashGroups = new Map();
                hashes.forEach((h, i) => {
                    if(!h) return;
                    const gk = canonicalKey(h);
                    if(!hashGroups.has(gk)) hashGroups.set(gk, []);
                    hashGroups.get(gk).push(i);
                });
                let minCount = Infinity, cands = [];
                for(const [, idx] of hashGroups){
                    if(idx.length < minCount){ minCount = idx.length; cands = [idx]; }
                    else if(idx.length === minCount) cands.push(idx);
                }

                let chosen = null, bestScore = -Infinity;
                for(const cand of cands){
                    const sc = cand.reduce((s, i) => s + keyScore(canonicalKey(hashes[i])), 0);
                    if(sc > bestScore){ bestScore = sc; chosen = cand; }
                }
                if(!chosen) chosen = cands[0];
                if(cands.length > 1) log(`Pixel tie  score ${bestScore}.`);

                if(chosen && minCount > 0 && minCount < hashes.length){
                    groups = hashGroups;
                    targetCell = chosen[0];
                    log(`Hash  cell ${targetCell+1} (${minCount}).`);
                } else {
                    log('Hash ambiguous  MSE.');
                    const mseGroups = []; const seen = new Set();
                    for(let i = 0; i < rawData.length; i++){
                        if(seen.has(i)) continue;
                        const g = [i]; seen.add(i);
                        for(let j = i + 1; j < rawData.length; j++){
                            if(seen.has(j)) continue;
                            if(computeMSE(rawData[i], rawData[j]) < CFG.MSE_THRESHOLD){
                                seen.add(j); g.push(j);
                            }
                        }
                        mseGroups.push(g);
                    }
                    const mseMap = new Map();
                    mseGroups.forEach((g, i) => mseMap.set(canonicalKey(hashes[g[0]]) || `mse_${i}`, g));
                    let minLen = Infinity, target = null;
                    for(const [, g] of mseMap) if(g.length < minLen){ minLen = g.length; target = g; }
                    if(target && target.length){
                        targetCell = target[0]; groups = mseMap;
                        log(`MSE  cell ${targetCell+1} (${target.length}).`);
                    } else {
                        warn('MSE failed  brute.');
                        return await bruteForceClick(regions, container, canvas, hashes, thumbs);
                    }
                }

                if(CFG.DEBUG || DEBUG_URL){
                    showTopPreview(canvas, regions, groups, targetCell);
                    createDebugPanel(canvas, regions, hashes, thumbs, targetCell);
                }

                if(lastDOMPick !== null && lastDOMPick !== targetCell)
                    warn(`Disagreement: DOMcell ${lastDOMPick+1}, pixelcell ${targetCell+1}.`);

                if(targetCell < 0 || targetCell >= regions.length){
                    warn('Invalid target  brute.');
                    return await bruteForceClick(regions, container, canvas, hashes, thumbs);
                }

                const sel = getSelectionElement();
                if(!sel) return false;
                const reg = regions[targetCell];
                const cr = container.getBoundingClientRect();
                const ratio = cr.width / cW;
                const cx = (reg.start + reg.end) / 2;
                const x = jitter(cr.left + cx * ratio, CFG.CLICK_JITTER_PX);
                const y = jitter((cr.top + cr.bottom) / 2, CFG.CLICK_JITTER_PX);

                log(`Clicking cell ${targetCell+1} @(${x.toFixed(1)},${y.toFixed(1)})`);
                fireMouse(sel, 'mouseenter', x, y);
                fireMouse(sel, 'mousemove', x, y);
                await wait(Math.round(rnd(CFG.HOVER_DELAY_MIN_MS, CFG.HOVER_DELAY_MAX_MS)));
                fireMouse(sel, 'click', x, y);

                await wait(Math.round(rnd(CFG.ICON_CLICK_MIN_MS, CFG.ICON_CLICK_MAX_MS)));
                if(currentSolveAbort) return false;

                const se = getSeInput();
                if(se && se.value && se.value.length > 0){
                    log(' Captcha solved (pixel).');
                    const ck = canonicalKey(hashes[targetCell]);
                    if(hashes[targetCell]) addKnownIcon(hashes[targetCell], thumbs[targetCell]);
                    recordOddKey(ck);
                    bumpPath('pixel', true);
                    const gsize = (groups.get(ck) || []).length;
                    logSolveSummary('pixel', targetCell, regions.length, gsize);
                    recordSolve({ path:'pixel', cell: targetCell, groupSize: gsize, totalIcons: regions.length });
                    return true;
                }
                recordMissKey(canonicalKey(hashes[targetCell]));
                bumpPath('pixel', false);
                log('Pixel miss  brute.');
                return await bruteForceClick(regions, container, canvas, hashes, thumbs);
            }catch(e){ console.error('[Faucet] Solve err:', e); return false; }
        })();

        try {
            const result = await Promise.race([solver, timedOut]);
            if(timeoutId){ clearTimeout(timeoutId); timeoutId = null; }
            return result;
        } catch (e) {
            if(timeoutId){ clearTimeout(timeoutId); timeoutId = null; }
            if (e && e.message === 'solve timeout') {
                warn(`Solve timed out after ${timeoutMs}ms  solver aborted.`);
            } else {
                warn('Solve error:', e);
            }
            return false;
        }
    }

    async function bruteForceClick(regions, container, canvas, hashes, thumbs){
        const sel = getSelectionElement();
        if(!sel) return false;
        const rect = container.getBoundingClientRect();
        const ratio = rect.width / canvas.width;
        let clicks = 0;
        for(let i = 0; i < regions.length; i++){
            if(currentSolveAbort) return false;
            if(clicks >= CFG.BRUTE_MAX_CLICKS){
                log(`Brute cap (${CFG.BRUTE_MAX_CLICKS}) reached  refresh instead of clicking on.`);
                await attemptCaptchaRefresh();
                break;
            }
            const reg = regions[i];
            const cx = (reg.start + reg.end) / 2;
            const x = jitter(rect.left + cx * ratio, CFG.CLICK_JITTER_PX);
            const y = jitter((rect.top + rect.bottom) / 2, CFG.CLICK_JITTER_PX);
            log(`Brute cell ${i+1}`);
            fireMouse(sel, 'mouseenter', x, y);
            fireMouse(sel, 'mousemove', x, y);
            await wait(Math.round(rnd(CFG.HOVER_DELAY_MIN_MS, CFG.HOVER_DELAY_MAX_MS)));
            fireMouse(sel, 'click', x, y);
            clicks++;
            await wait(Math.round(rnd(CFG.ICON_CLICK_MIN_MS, CFG.ICON_CLICK_MAX_MS)));
            if(currentSolveAbort) return false;
            const se = getSeInput();
            if(se && se.value && se.value.length > 0){
                log(`Brute cell ${i+1} solved.`);
                if(hashes && hashes[i]){
                    addKnownIcon(hashes[i], thumbs[i]);
                    recordOddKey(canonicalKey(hashes[i]));
                }
                bumpPath('brute', true);
                logSolveSummary('brute', i, regions.length, 1);
                recordSolve({ path:'brute', cell:i, groupSize:1, totalIcons: regions.length });
                return true;
            }
            if(hashes && hashes[i]) recordMissKey(canonicalKey(hashes[i]));
        }
        bumpPath('brute', false);
        return false;
    }

    //  PREVIEW + DEBUG PANEL
    function showTopPreview(canvas, regions, groups, targetCell){
        document.getElementById('faucet-top-preview')?.remove();
        const box = document.createElement('div');
        box.id = 'faucet-top-preview';
        box.style.cssText = `position:fixed;top:10px;left:10px;z-index:999999;
            background:rgba(0,0,0,.8);border:2px solid #fff;border-radius:8px;padding:5px;
            max-width:300px;box-shadow:0 0 20px rgba(0,0,0,.8);cursor:pointer;`;
        const oc = document.createElement('canvas');
        oc.width = canvas.width; oc.height = canvas.height;
        const ctx = oc.getContext('2d');
        ctx.drawImage(canvas, 0, 0);
        const cmap = new Map(); let ci = 0;
        for(const [k] of groups) cmap.set(k, GROUP_COLORS[ci++ % GROUP_COLORS.length]);
        for(const [k, idx] of groups){
            const color = cmap.get(k);
            for(const i of idx){
                if(i >= regions.length) continue;
                const reg = regions[i];
                const cx = (reg.start + reg.end) / 2, cy = canvas.height / 2;
                ctx.beginPath(); ctx.arc(cx, cy, 10, 0, 2*Math.PI);
                ctx.fillStyle = color; ctx.fill();
                ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke();
                ctx.fillStyle = '#000'; ctx.font = 'bold 10px Arial';
                ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
                ctx.fillText(i + 1, cx, cy);
            }
        }
        if(targetCell >= 0 && targetCell < regions.length){
            const reg = regions[targetCell];
            const cx = (reg.start + reg.end) / 2, cy = canvas.height / 2;
            ctx.beginPath(); ctx.arc(cx, cy, 14, 0, 2*Math.PI);
            ctx.strokeStyle = '#FFFFFF'; ctx.lineWidth = 3; ctx.stroke();
        }
        const img = document.createElement('img');
        img.src = oc.toDataURL('image/png');
        img.style.cssText = 'width:100%;height:auto;display:block;border-radius:4px;';
        box.appendChild(img);
        const cap = document.createElement('div');
        cap.style.cssText = 'color:#fff;font-size:11px;text-align:center;padding:4px 0;font-family:monospace;';
        cap.textContent = `Target: ${targetCell+1}`;
        box.appendChild(cap);
        box.addEventListener('click', () => { box.style.display = box.style.display === 'none' ? 'block' : 'none'; });
        document.body.appendChild(box);
    }

    function createDebugPanel(canvas, regions, hashes, thumbs, targetCell){
        document.getElementById('faucet-debug-panel')?.remove();
        const p = document.createElement('div');
        p.id = 'faucet-debug-panel';
        p.style.cssText = `position:fixed;bottom:10px;left:10px;z-index:999999;
            background:rgba(0,0,0,.85);border:2px solid #888;border-radius:8px;padding:8px;
            max-width:90vw;max-height:200px;overflow:auto;display:flex;flex-wrap:wrap;gap:6px;
            font-family:monospace;font-size:10px;color:#fff;box-shadow:0 0 20px rgba(0,0,0,.9);cursor:pointer;`;
        const di = getDOMIcons();
        const totalHashes = knownIcons.reduce((s,e) => s + e.hashes.length, 0);
        const hd = document.createElement('div');
        hd.style.cssText = 'width:100%;text-align:center;color:#aaa;border-bottom:1px solid #444;padding-bottom:4px;margin-bottom:4px;';
        hd.textContent = `Canon: ${knownIcons.length} (${totalHashes} var) | DOM: ${di ? di.length : '?'} | Pixels: ${regions.length} | Target: ${targetCell+1}`;
        p.appendChild(hd);
        for(const it of knownIcons){
            const d = document.createElement('div');
            d.style.cssText = `display:flex;flex-direction:column;align-items:center;
                background:#222;border:2px solid #444;border-radius:4px;padding:2px;width:42px;`;
            const matched = hashes.some(h => it.hashes.some(k => hammingDistance(h, k) <= CFG.HASH_MATCH_DIST));
            if(matched){ d.style.borderColor = '#0f0'; d.style.backgroundColor = '#1a3a1a'; }
            const im = document.createElement('img');
            im.src = it.thumb; im.style.cssText = 'width:32px;height:25px;object-fit:contain;';
            d.appendChild(im);
            const lb = document.createElement('div');
            lb.textContent = `${it.id.slice(-4)}(${it.count})`;
            lb.style.cssText = 'color:#ccc;font-size:8px;margin-top:2px;';
            d.appendChild(lb); p.appendChild(d);
        }
        for(let i = 0; i < hashes.length; i++){
            const isKnown = !!findCanonical(hashes[i]);
            const isTgt = i === targetCell;
            const d = document.createElement('div');
            d.style.cssText = `display:flex;flex-direction:column;align-items:center;
                background:${isKnown ? '#1a2a3a' : '#3a1a1a'};
                border:2px solid ${isTgt ? '#fff' : (isKnown ? '#0f0' : '#f00')};
                border-radius:4px;padding:2px;width:42px;${isTgt ? 'box-shadow:0 0 8px #fff;' : ''}`;
            const im = document.createElement('img');
            im.src = thumbs[i]; im.style.cssText = 'width:32px;height:25px;object-fit:contain;';
            d.appendChild(im);
            const lb = document.createElement('div');
            lb.textContent = `${i+1}:${hashes[i].substring(0,4)}`;
            lb.style.cssText = 'color:#ccc;font-size:8px;margin-top:2px;';
            d.appendChild(lb); p.appendChild(d);
        }
        p.addEventListener('click', () => { p.style.display = p.style.display === 'none' ? 'flex' : 'none'; });
        document.body.appendChild(p);
    }

    //  HUD
    function getCaptchaTypeStr() {
        if (isHCaptchaActive()) return 'hCaptcha (30s reload)';
        if (isTurnstileActive()) return 'Turnstile';
        if (getIconContainer()) return 'IconCaptcha';
        return 'None/Unknown';
    }

    function ensureHud(){
        if(document.getElementById('faucet-hud')) return;
        const hud = document.createElement('div');
        hud.id = 'faucet-hud';
        hud.style.cssText = `position:fixed;top:10px;right:10px;z-index:999999;
            background:rgba(0,0,0,.85);border:2px solid #4af;border-radius:8px;
            padding:8px 10px;color:#fff;font-family:monospace;font-size:11px;line-height:1.45;
            min-width:260px;box-shadow:0 0 20px rgba(0,0,0,.8);cursor:pointer;user-select:none;`;
        hud.innerHTML = `<div style="font-weight:700;color:#4af;margin-bottom:4px;">
            Faucet Bot
            <span id="faucet-hud-reset" title="Wipe learned icons + odd-history"
                  style="float:right;color:#f66;margin-right:8px;cursor:pointer;"></span>
            <span id="faucet-hud-toggle" style="float:right;color:#aaa;cursor:pointer;"></span>
            </div><div id="faucet-hud-body"></div>`;
        document.body.appendChild(hud);
        hud.querySelector('#faucet-hud-toggle').addEventListener('click', e => {
            e.stopPropagation(); setEnabled(!isEnabled());
        });
        hud.querySelector('#faucet-hud-reset').addEventListener('click', e => {
            e.stopPropagation();
            if(!confirm('Wipe learned icons, odd-history, miss-history, path stats, solve history?')) return;
            safeLocalRemove(SK.ICONS);
            safeLocalRemove(SK.ODD);
            safeLocalRemove(SK.MISS);
            safeLocalRemove(SK.PATHS);
            safeLocalRemove(SK.HISTORY);
            knownIcons = [];
            log('Learning registry reset by user.');
        });
        hud.addEventListener('click', () => {
            const b = hud.querySelector('#faucet-hud-body');
            b.style.display = b.style.display === 'none' ? 'block' : 'none';
        });
    }
    function fmtClock(ms){
        if(ms <= 0) return '';
        const s = Math.ceil(ms / 1000);
        const m = Math.floor(s / 60), r = s % 60;
        return `${String(m).padStart(2,'0')}:${String(r).padStart(2,'0')}`;
    }
    function fmtWall(ts){
        const d = new Date(ts);
        return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}`;
    }
    function updateHud(){
        const body = document.getElementById('faucet-hud-body');
        const tgl = document.getElementById('faucet-hud-toggle');
        if(!body) return;
        const cd = getCooldownUntil(), eu = getErrorUntil();
        const cdLeft = Math.max(0, cd - Date.now());
        const euLeft = Math.max(0, eu - Date.now());
        const nextIn = Math.max(cdLeft, euLeft);
        let nextStr = 'ready';
        if(nextIn > 0){
            const ts = Math.max(cd, eu);
            nextStr = `${fmtClock(nextIn)}  ${fmtWall(ts)}`;
        }
        tgl.textContent = isEnabled() ? 'Pause' : 'Resume';
        tgl.style.color = isEnabled() ? '#4af' : '#f84';
        loadStats();

        const totalHashes = knownIcons.reduce((s,e) => s + e.hashes.length, 0);
        let oddEntries = 0, oddTotal = 0, missEntries = 0, missTotal = 0;
        try{
            const odd = JSON.parse(safeLocalGet(SK.ODD) || '{}');
            oddEntries = Object.keys(odd).length;
            oddTotal = Object.values(odd).reduce((s,n) => s+n, 0);
        }catch{}
        try{
            const miss = JSON.parse(safeLocalGet(SK.MISS) || '{}');
            missEntries = Object.keys(miss).length;
            missTotal = Object.values(miss).reduce((s,n) => s+n, 0);
        }catch{}
        const paths = getPathStats();
        const pathStr = Object.entries(paths).map(([k,v]) => `${k}:${v.win}/${v.loss}`).join(' ') || '';

        body.innerHTML = `
            <div>State:  <b>${state}</b></div>
            <div>Next:   <b>${nextStr}</b></div>
            <div>Today:  <b>${stats.claimsToday}</b>/${CFG.MAX_DAILY_CLAIMS}</div>
            <div>Errors: <b>${stats.errorsToday}</b> (consec ${getErrorCount()})</div>
            <div>Captcha:<b> ${getCaptchaTypeStr()}</b></div>
            <div>Learned:<b> ${knownIcons.length}</b> canon / <b>${totalHashes}</b> var</div>
            <div>Odd:    <b>${oddEntries}</b> keys / <b>${oddTotal}</b> hits</div>
            <div>Miss:   <b>${missEntries}</b> keys / <b>${missTotal}</b> hits</div>
            <div>Paths:  <span style="color:#9df">${esc(pathStr)}</span></div>
            <div>Hist:   <span style="color:#9df">dom/pixel/brute ${esc(summarizeHistory(20))}</span></div>
            <div>DOM:    <span style="color:#fc8">${esc(lastDomDiag||'')}${lastDomIconCount ? ' ('+lastDomIconCount+')' : ''}</span></div>
            <div>Bail:   <span style="color:#fc8">${esc(lastBailReason||'')}</span></div>
        `;
    }

    //  SUCCESS / ERROR
    const BAN_PATTERN = /(banned|too many|rate.?limit|suspicious|blocked)/i;
    const TRANSIENT_PATTERN = /(not ready|try again|retry|expired|invalidated|invalid captcha|captcha (error|invalid|expired)|verification (failed|error)|incorrect|no longer valid)/i;

    function hookAjax(){
        if(!window.jQuery || window.__ebmAjaxHooked) return !!window.__ebmAjaxHooked;
        const $ = window.jQuery;
        $(document).on('ajaxSuccess', function(e, xhr, settings, data){
            try{
                const body = String(settings && settings.data || '');
                if(body.indexOf('a=getFaucet') === -1) return;
                if(!data || typeof data !== 'object') return;

                if(data.status === 200){
                    log(' Server confirmed.');
                    safeSessionRemove(SESSION_RELOAD);
                    onServerSuccess();
                    return;
                }

                const msg = String(data.message || '');

                if(SESSION_PATTERN.test(msg)){
                    warn('Session issue detected:', msg.slice(0, 60));
                    safeSessionRemove(SESSION_RELOAD);
                    setTimeout(() => window.location.reload(), 1500);
                    return;
                }

                const cdMs = parseCooldownFromMessage(msg);
                if(cdMs && cdMs > 1000){
                    const totalSec = Math.round(cdMs / 1000);
                    log(`Server cooldown: ${totalSec}s  ${new Date(Date.now()+cdMs).toLocaleTimeString()}`);
                    state = State.COOLDOWN;
                    isProcessing = false;
                    releaseTabLock();
                    stopCaptchaWatcher();
                    stopTurnstilePoller();
                    setCooldownUntil(Date.now() + cdMs + CFG.COOLDOWN_GRACE_MS);
                    clearErrorUntil();
                    setTimeout(() => {
                        if(getCooldownUntil() <= Date.now()){
                            clearCooldown();
                            if(state === State.COOLDOWN) state = State.IDLE;
                            log('Server cooldown over.');
                            maybeRun('server-cooldown');
                        }
                    }, cdMs + CFG.COOLDOWN_GRACE_MS + 500);
                    return;
                }

                if(BAN_PATTERN.test(msg)){
                    warn('Ban pattern:', msg.slice(0, 60));
                    onServerError('ban', msg);
                    return;
                }

                if(data.status === 400 || data.status === 403){
                    if(TRANSIENT_PATTERN.test(msg)){
                        warn('Transient captcha error  short retry:', msg.slice(0,60));
                        state = State.IDLE; isProcessing = false;
                        releaseTabLock();
                        stopCaptchaWatcher(); stopTurnstilePoller(); stopWaitMonitor();
                        setTimeout(() => maybeRun('transient-retry'), CFG.TRANSIENT_RETRY_MS);
                        return;
                    }
                    warn('Server rejected:', msg);
                    onServerError('reject', msg);
                }
            }catch(err){ warn('ajaxSuccess err:', err); }
        });
        window.__ebmAjaxHooked = true;
        log('ajaxSuccess hooked.');
        return true;
    }

    function onServerSuccess(){
        bumpClaim(); resetErrorState();
        cancelHcaptchaReload(); stopWaitMonitor();
        safeSessionRemove(HCAPTCHA_RELOAD_KEY);
        state = State.SOLVED; isProcessing = false;
        releaseTabLock();
        startCooldown();
        setTimeout(() => {
            const c = $(SEL.closeBtn);
            if(c) c.click();
        }, Math.round(rnd(500, 900)));
    }
    function onServerError(kind, msg){
        bumpError();
        lastErrorReason = `${kind}: ${(msg||'').slice(0,60)}`;
        const n = bumpErrorCount();
        const backoff = kind === 'ban'
            ? CFG.BAN_BACKOFF_MS
            : Math.min(CFG.ERROR_BACKOFF_BASE_MS + (n-1)*CFG.ERROR_BACKOFF_STEP_MS, 60*60*1000);
        state = State.BACKOFF; isProcessing = false;
        releaseTabLock();
        setErrorUntil(Date.now() + backoff);
        warn(`Backoff ${(backoff/60000).toFixed(1)} min (${kind}).`);
        stopCaptchaWatcher(); stopTurnstilePoller();
        stopWaitMonitor(); cancelHcaptchaReload();
    }
    function resetErrorState(){ clearErrorUntil(); lastErrorReason = ''; }
    function watchBanSignals(){
        const box = $(SEL.messageBox);
        if(!box) return;
        const obs = new MutationObserver(() => {
            const txt = box.textContent || '';
            if(BAN_PATTERN.test(txt)){ warn('Ban pattern (DOM):', txt.slice(0,80)); onServerError('ban', txt); }
        });
        obs.observe(box, { childList: true, subtree: true, characterData: true });
        domObservers.push(obs);
    }

    //  COOLDOWN
    function startCooldown(){
        state = State.COOLDOWN; isProcessing = false;
        stopCaptchaWatcher(); stopTurnstilePoller(); resetTurnstileWidget();
        stopWaitMonitor(); cancelHcaptchaReload();
        const jitterMs = Math.floor(Math.random() * CFG.COOLDOWN_JITTER_MS);
        const until = Date.now() + CFG.COOLDOWN_MS + jitterMs;
        setCooldownUntil(until);
        log(`Cooldown until ${new Date(until).toLocaleTimeString()} (+${(jitterMs/1000).toFixed(1)}s).`);
        setTimeout(() => {
            if(getCooldownUntil() <= Date.now()){
                clearCooldown();
                if(state === State.COOLDOWN) state = State.IDLE;
                log('Cooldown over.');
                maybeRun('cooldown-timer');
            }
        }, CFG.COOLDOWN_MS + jitterMs + 500);
    }
    function resumePersistedTimers(){
        const cd = getCooldownUntil();
        if(cd > Date.now()){
            state = State.COOLDOWN;
            const left = cd - Date.now();
            log(`Resuming cooldown (${Math.ceil(left/1000)}s left).`);
            setTimeout(() => {
                clearCooldown();
                if(state === State.COOLDOWN) state = State.IDLE;
                maybeRun('cooldown-resume');
            }, left + 250);
        } else clearCooldown();

        const eu = getErrorUntil();
        if(eu > Date.now()){
            state = State.BACKOFF;
            const left = eu - Date.now();
            log(`Resuming backoff (${Math.ceil(left/1000)}s left).`);
            setTimeout(() => {
                clearErrorUntil();
                if(state === State.BACKOFF) state = State.IDLE;
                maybeRun('backoff-resume');
            }, left + 250);
        } else clearErrorUntil();
    }

    function waitForCaptchaAndSubmit(){
        if(!isEnabled()){ stopCaptchaWatcher(); return false; }
        const se = getSeInput();
        if(se && se.value && se.value.length > 0){
            log('Icon captcha validated  submit.');
            const btn = $(SEL.pressWinBtn) || $(SEL.pressWinBtnAlt);
            if(btn && !btn.disabled) btn.click();
            else if(typeof window.starzRoll3 === 'function') window.starzRoll3();
            stopCaptchaWatcher(); return true;
        }
        return false;
    }
    function startCaptchaWatcher(){ stopCaptchaWatcher(); captchaWatcher = setInterval(waitForCaptchaAndSubmit, 800); }
    function stopCaptchaWatcher(){ if(captchaWatcher){ clearInterval(captchaWatcher); captchaWatcher = null; } }

    //  MAIN LOOP
    function maybeRun(source='tick'){
        if(!isEnabled()){ state = State.PAUSED; logBail('disabled'); return; }
        if(dailyCapReached()){ logBail('daily cap'); return; }

        const cd = getCooldownUntil();
        if(cd > Date.now()){ state = State.COOLDOWN; logBail(`cooldown ${Math.ceil((cd-Date.now())/1000)}s (${source})`); return; }
        const eu = getErrorUntil();
        if(eu > Date.now()){ state = State.BACKOFF; logBail(`backoff ${Math.ceil((eu-Date.now())/1000)}s (${source})`); return; }

        if(document.visibilityState !== 'visible'){ logBail(`tab hidden (${source})`); return; }
        if(isProcessing){ logBail(`busy (${source})`); return; }
        if(state !== State.IDLE){ logBail(`state=${state} (${source})`); return; }

        if(!isClaimReady()){ logBail(`claim not ready (${source})`); return; }

        if(!acquireTabLock()){ logBail(`tab lock held (${source})`); return; }
        log(`tick  autoClaimCycle (${source}, tab=${TAB_ID})`);
        autoClaimCycle();
    }

    async function autoClaimCycle(){
        log('autoClaimCycle start');
        if(isProcessing || state === State.COOLDOWN || state === State.BACKOFF){ releaseTabLock(); return; }
        if(!isEnabled()){ releaseTabLock(); return; }
        const btn = getClaimButton();
        if(!btn){ log('bail: no claim btn'); releaseTabLock(); return; }
        const modal = getModal();
        if(!modal){ log('bail: no modal'); releaseTabLock(); return; }

        if(!isModalOpen()){
            log('Opening modal');
            btn.click(); isProcessing = true; state = State.OPENING;
            await loadHtml2canvas();
            const start = Date.now();
            while(!isModalOpen() && Date.now() - start < 4000) await wait(200);
            if(!isModalOpen()){ warn('Modal did not open.'); isProcessing = false; state = State.IDLE; releaseTabLock(); return; }
            log('Modal open.');
            await wait(Math.round(rnd(1200, 2000)));
            if(!isEnabled()){ log('paused during open  abort'); releaseTabLock(); return; }

            const hc = handleHCaptcha();
            if(hc){ if(hc === 'waiting') enterWaitHandoff(); return; }

            if(isTurnstileActive()){
                log('Turnstile active  auto-click.');
                enterWaitHandoff();
                return;
            }
            state = State.SOLVING; solveAttempts = 0;
            await attemptSolveWithRetry();
        } else if(state === State.IDLE){
            const hc = handleHCaptcha();
            if(hc){ if(hc === 'waiting') enterWaitHandoff(); return; }

            if(isTurnstileActive()){
                log('Turnstile active  auto-click.');
                enterWaitHandoff();
                return;
            }
            state = State.SOLVING; solveAttempts = 0;
            await attemptSolveWithRetry();
        } else {
            releaseTabLock();
        }
    }

    async function attemptSolveWithRetry(){
        stopWaitMonitor();
        while(state === State.SOLVING && solveAttempts < CFG.MAX_ATTEMPTS && isEnabled()){
            if(!isModalOpen()){ warn('Modal closed.'); isProcessing = false; state = State.IDLE; releaseTabLock(); return; }

            const hc = handleHCaptcha();
            if(hc === 'waiting'){ enterWaitHandoff(); return; }
            if(hc === 'clicked'){ await wait(2000); continue; }

            if(isTurnstileActive()){ log('Turnstile appeared  switch.'); enterWaitHandoff(); return; }
            solveAttempts++;
            log(`Solve ${solveAttempts}/${CFG.MAX_ATTEMPTS}`);
            const ok = await solveIconCaptcha();
            if(ok){ startCaptchaWatcher(); return; }
            log(`Attempt ${solveAttempts} failed.`);
            if(solveAttempts >= CFG.MAX_ATTEMPTS){
                if(!safeSessionGet(SESSION_RELOAD)){
                    safeSessionSet(SESSION_RELOAD, '1');
                    warn('Max attempts  one-time reload to refresh session.');
                    isProcessing = false;
                    releaseTabLock();
                    setTimeout(() => window.location.reload(), 2000);
                    return;
                }
                warn('Max attempts (reload already tried)  backoff.');
                onServerError('reject', 'max attempts');
            } else await wait(Math.round(rnd(1500, 2500)));
        }
        if(state !== State.SOLVED && state !== State.COOLDOWN && state !== State.BACKOFF && state !== State.PAUSED){
            state = State.IDLE; isProcessing = false; releaseTabLock();
        }
    }

    //  OBSERVERS
    function setupRefreshFallback(){
        let handled = false;
        const check = () => {
            if(handled) return;
            const b = $(SEL.refreshBtn);
            if(b && b.offsetParent !== null){
                if(!refreshTimer){
                    const last = parseInt(safeSessionGet(REFRESH_RELOAD_KEY,'0'),10) || 0;
                    if(Date.now() - last < 5*60*1000){
                        log('Refresh btn  reload cooldown active.');
                        return;
                    }
                    log('Refresh btn  reload in 10s.');
                    refreshTimer = setTimeout(() => {
                        handled = true;
                        safeSessionSet(REFRESH_RELOAD_KEY, String(Date.now()));
                        log('Reloading');
                        window.location.reload();
                    }, 10000);
                }
            } else if(refreshTimer){ clearTimeout(refreshTimer); refreshTimer = null; log('Refresh btn dismissed.'); }
        };
        const obs = new MutationObserver(check);
        obs.observe(document.body, { childList: true, subtree: true });
        domObservers.push(obs); check();
    }
    function setupModalReset(){
        const modal = getModal(); if(!modal) return;
        const obs = new MutationObserver(() => {
            if(!modal.classList.contains('show') && (state === State.SOLVING || state === State.OPENING)){
                log('Modal closed  reset.');
                currentSolveAbort = true;
                stopCaptchaWatcher(); stopTurnstilePoller(); turnstileHandled = false;
                isProcessing = false;
                if(state !== State.COOLDOWN && state !== State.BACKOFF) state = State.IDLE;
                document.getElementById('faucet-top-preview')?.remove();
                document.getElementById('faucet-debug-panel')?.remove();
                releaseTabLock();
                cancelHcaptchaReload();
            }
        });
        obs.observe(modal, { attributes: true, attributeFilter: ['class'] });
        domObservers.push(obs);
    }
    function setupClaimObserver(){
        const claimDiv = $(SEL.claimDiv);
        if(!claimDiv){
            if(claimObserverRetries++ >= 30){ log('claimFaucet never appeared  giving up on observer.'); return; }
            claimObserverRetryTimer = setTimeout(setupClaimObserver, 1000);
            return;
        }
        claimObserverRetries = 0;
        const obs = new MutationObserver(() => {
            if(!claimDiv.classList.contains('d-none')){ log('claimFaucet visible  maybeRun'); maybeRun('claim-visible'); }
        });
        obs.observe(claimDiv, { attributes: true, attributeFilter: ['class'] });
        domObservers.push(obs);
        if(!claimDiv.classList.contains('d-none')){ log('claimFaucet visible at init  maybeRun'); maybeRun('claim-init'); }
    }
    function cleanup(){
        for(const o of domObservers){ try{ o.disconnect(); }catch{} }
        domObservers = [];
        stopCaptchaWatcher(); stopTurnstilePoller();
        stopWaitMonitor();
        releaseTabLock();
        if(hudTimer){ clearInterval(hudTimer); hudTimer = null; }
        if(heartbeatTimer){ clearInterval(heartbeatTimer); heartbeatTimer = null; }
        if(refreshTimer){ clearTimeout(refreshTimer); refreshTimer = null; }
        if(armHookTimer){ clearInterval(armHookTimer); armHookTimer = null; }
        if(claimObserverRetryTimer){ clearTimeout(claimObserverRetryTimer); claimObserverRetryTimer = null; }
        cancelHcaptchaReload();
    }

    function init(){
        if(document.getElementById('faucet-script-inited')) return;
        const m = document.createElement('meta'); m.id = 'faucet-script-inited'; document.head.appendChild(m);
        loadKnownIcons(); loadStats();
        log(`init: state=${state} | canon=${knownIcons.length} | tab=${TAB_ID}`);

        setupRefreshFallback();
        setupModalReset();
        watchBanSignals();

        armHookTimer = setInterval(() => {
            const ok1 = hookAjax();
            const ok2 = patchTurnstileRender();
            if(ok1 && ok2){ clearInterval(armHookTimer); armHookTimer = null; }
        }, 500);
        setTimeout(() => { if(armHookTimer){ clearInterval(armHookTimer); armHookTimer = null; } }, 30000);

        setupClaimObserver();
        setInterval(() => maybeRun('tick'), 5000);
        document.addEventListener('visibilitychange', () => {
            if(document.visibilityState === 'visible') maybeRun('visibility');
        });

        ensureHud();
        hudTimer = setInterval(updateHud, 1000);
        updateHud();
        resumePersistedTimers();

        heartbeatTimer = setInterval(() => {
            if(isTabLockHeld()) renewTabLock();
            const cd = getCooldownUntil(), eu = getErrorUntil();
            const totalHashes = knownIcons.reduce((s,e) => s + e.hashes.length, 0);
            let oddKeys = 0, missKeys = 0;
            try{ oddKeys = Object.keys(JSON.parse(safeLocalGet(SK.ODD)||'{}')).length; }catch{}
            try{ missKeys = Object.keys(JSON.parse(safeLocalGet(SK.MISS)||'{}')).length; }catch{}
            const paths = getPathStats();
            const pstr = Object.entries(paths).map(([k,v]) => `${k}:${v.win}/${v.loss}`).join(' ') || '';
            log(`heartbeat state=${state} captcha=${getCaptchaTypeStr()} cd=${cd>Date.now()?Math.ceil((cd-Date.now())/1000)+'s':''} `
                + `eu=${eu>Date.now()?Math.ceil((eu-Date.now())/1000)+'s':''} `
                + `canon=${knownIcons.length} var=${totalHashes} odd=${oddKeys} miss=${missKeys} `
                + `paths=[${pstr}] hist=[${summarizeHistory(20)}] bail="${lastBailReason}" dom="${lastDomDiag}"`);
        }, CFG.HEARTBEAT_MS);

        log('Initialized (v50.10).');
    }

    if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
    window.addEventListener('beforeunload', cleanup);
    window.addEventListener('pagehide', cleanup);

})();
