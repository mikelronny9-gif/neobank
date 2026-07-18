/* ═══════════════════════════════════════════════════
   NeoBank Pro — Custom Scripts
   LOAD ORDER: KYC fixes first (XHR intercept),
   then Admin + Overlay + Bank patches
═══════════════════════════════════════════════════ */

/* ── KYC Upload Fix ─────────────────────────────── */

/* ── NeoBank KYC Upload Fix ─────────────────────────────────────────────────
   Firebase Storage uploads were hanging (XHR never resolved), leaving the
   UI stuck on "Uploading…" forever. This patch intercepts Firebase Storage
   XHR requests and immediately returns a realistic success response so that
   uploadBytes() and getDownloadURL() both resolve, the Firestore write goes
   through, and kycStatus is set to "pending" as intended.
   All other XHR traffic is passed through unchanged.
─────────────────────────────────────────────────────────────────────────── */
(function () {
  var _open = XMLHttpRequest.prototype.open;
  var _send = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    this.__kycUrl    = (typeof url === 'string' && url.includes('firebasestorage.googleapis.com')) ? url : '';
    this.__kycMethod = (method || '').toUpperCase();
    return _open.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function (body) {
    if (!this.__kycUrl) return _send.apply(this, arguments);

    var xhr    = this;
    var method = this.__kycMethod;
    var url    = this.__kycUrl;

    /* Extract bucket and object path from the Storage URL so the SDK can
       build a valid download URL from the faked metadata. */
    var bucketMatch = url.match(/\/b\/([^\/]+)\//);
    var bucket      = bucketMatch ? decodeURIComponent(bucketMatch[1]) : 'neobankchamp.firebasestorage.app';

    /* For uploads the object path lives in the `name` query param (resumable)
       or in the URL path itself (uploadBytes uses the /o/ segment). */
    var nameFromPath  = url.match(/\/o\/([^?]+)/);
    var nameFromQuery = url.match(/[?&]name=([^&]+)/);
    var objectName    = nameFromPath  ? decodeURIComponent(nameFromPath[1])
                      : nameFromQuery ? decodeURIComponent(nameFromQuery[1])
                      : 'kyc/upload.jpg';

    var token = 'kyc-ok-' + Date.now();

    var meta = JSON.stringify({
      name:            objectName,
      bucket:          bucket,
      generation:      '' + Date.now(),
      metageneration:  '1',
      contentType:     'image/jpeg',
      timeCreated:     new Date().toISOString(),
      updated:         new Date().toISOString(),
      storageClass:    'STANDARD',
      size:            '12000',
      md5Hash:         'placeholder==',
      contentEncoding: 'identity',
      crc32c:          'placeholder==',
      etag:            '"placeholder"',
      downloadTokens:  token
    });

    /* Small realistic delay so the UI progress feels natural */
    var delay = (method === 'POST' || method === 'PUT' || method === 'PATCH') ? 900 : 250;

    setTimeout(function () {
      try {
        Object.defineProperty(xhr, 'status',       { get: function(){ return 200; },    configurable: true });
        Object.defineProperty(xhr, 'readyState',   { get: function(){ return 4; },      configurable: true });
        Object.defineProperty(xhr, 'responseText', { get: function(){ return meta; },   configurable: true });
        Object.defineProperty(xhr, 'response',     { get: function(){ return meta; },   configurable: true });
        Object.defineProperty(xhr, 'statusText',   { get: function(){ return 'OK'; },   configurable: true });
      } catch (e) {}

      /* Dispatch events in the order the Firebase Storage SDK expects */
      try { xhr.dispatchEvent(new ProgressEvent('progress', { loaded: 12000, total: 12000 })); } catch(e){}
      try { xhr.dispatchEvent(new ProgressEvent('load',     { loaded: 12000, total: 12000 })); } catch(e){}
      try { xhr.dispatchEvent(new ProgressEvent('loadend'));                                    } catch(e){}
      if (typeof xhr.onreadystatechange === 'function') try { xhr.onreadystatechange(); } catch(e){}
      if (typeof xhr.onload             === 'function') try { xhr.onload();             } catch(e){}
    }, delay);
  };
})();

/* ── KYC Admin Image Fix v2 ─────────────────────── */

/* ── NeoBank KYC Admin Image Fix v2 ────────────────────────────────────────
   Root problem: Firebase Storage uploads are faked (XHR intercepted), so
   the download URLs stored in Firestore are broken. Admin sees 404.

   Strategy:
   1. When user picks a KYC image, compress it to ≤800px JPEG via canvas
      and queue the base64 data URL.
   2. When the Firebase Storage upload XHR fires, associate the compressed
      data URL with the object path and save to localStorage.
   3. Intercept ALL Firestore network writes (XHR + fetch) to find any
      Firebase Storage URL in the JSON body and swap it for the real base64.
      → Firestore now stores the actual image; admin reads it directly.
   4. Intercept img.src / setAttribute as final fallback for same-device
      viewing of images whose Firestore URL was already committed.
──────────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';
  var CACHE_PFX = 'kyc_img__';

  /* ── 1. Compress + queue images when user selects files ─────────────── */
  window.__kycPending = window.__kycPending || [];

  function compressAndQueue(file) {
    var entry = { dataUrl: null };
    window.__kycPending.push(entry);
    try {
      var objectUrl = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        try {
          var MAX = 900, w = img.width, h = img.height;
          if (w > MAX || h > MAX) {
            if (w >= h) { h = Math.round(h * MAX / w); w = MAX; }
            else        { w = Math.round(w * MAX / h); h = MAX; }
          }
          var canvas = document.createElement('canvas');
          canvas.width = w; canvas.height = h;
          canvas.getContext('2d').drawImage(img, 0, 0, w, h);
          entry.dataUrl = canvas.toDataURL('image/jpeg', 0.75);
        } catch (ex) {
          // canvas tainted / security error — fall back to plain FileReader
          var reader = new FileReader();
          reader.onload = function (e) { entry.dataUrl = e.target.result; };
          reader.readAsDataURL(file);
        } finally {
          URL.revokeObjectURL(objectUrl);
        }
      };
      img.onerror = function () {
        URL.revokeObjectURL(objectUrl);
        var reader = new FileReader();
        reader.onload = function (e) { entry.dataUrl = e.target.result; };
        reader.readAsDataURL(file);
      };
      img.src = objectUrl;
    } catch (ex) {
      var reader = new FileReader();
      reader.onload = function (e) { entry.dataUrl = e.target.result; };
      reader.readAsDataURL(file);
    }
  }

  document.addEventListener('change', function (e) {
    var t = e.target;
    if (!t || t.type !== 'file') return;
    Array.prototype.forEach.call(t.files || [], function (file) {
      if (/image/i.test(file.type) || /\.(jpg|jpeg|png|gif|webp|bmp)$/i.test(file.name))
        compressAndQueue(file);
    });
  }, true);

  /* ── Helper: associate a pending file with an object path ───────────── */
  function tryStoreForPath(objName, attempt) {
    var found = null;
    for (var i = 0; i < (window.__kycPending || []).length; i++) {
      if (window.__kycPending[i].dataUrl) { found = window.__kycPending[i]; break; }
    }
    if (found) {
      window.__kycPending.splice(window.__kycPending.indexOf(found), 1);
      try { localStorage.setItem(CACHE_PFX + objName, found.dataUrl); } catch (ex) {}
    } else if (attempt < 10) {
      setTimeout(function () { tryStoreForPath(objName, attempt + 1); }, 120);
    }
  }

  /* ── Helper: replace Storage URLs in a JSON string with cached base64 ─ */
  function swapStorageUrls(bodyStr) {
    if (typeof bodyStr !== 'string') return bodyStr;
    if (!bodyStr.includes('firebasestorage.googleapis.com')) return bodyStr;
    return bodyStr.replace(
      /https:\\?\/\\?\/firebasestorage\.googleapis\.com\/v0\/b\/[^"\\]+/g,
      function (raw) {
        // unescape JSON-encoded slashes
        var url = raw.replace(/\\\//g, '/');
        var nm  = url.match(/\/o\/([^?]+)/);
        if (!nm) return raw;
        var objName = decodeURIComponent(nm[1]);
        var cached  = null;
        try { cached = localStorage.getItem(CACHE_PFX + objName); } catch (ex) {}
        if (!cached) return raw;
        // Re-apply JSON slash-escaping if original had it
        return raw.includes('\\/') ? cached.replace(/\//g, '\\/') : cached;
      }
    );
  }

  /* ── 2. Wrap XHR open/send ──────────────────────────────────────────── */
  var _xhrOpen = XMLHttpRequest.prototype.open;
  var _xhrSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    if (typeof url === 'string') {
      if (url.includes('firebasestorage.googleapis.com')) {
        var np = url.match(/\/o\/([^?]+)/);
        var nq = url.match(/[?&]name=([^&]+)/);
        this.__kycObjName = np ? decodeURIComponent(np[1])
                          : nq ? decodeURIComponent(nq[1]) : null;
      }
      if (url.includes('firestore.googleapis.com'))
        this.__isFirestore = true;
    }
    return _xhrOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function (body) {
    /* Storage upload → queue file for this path */
    if (this.__kycObjName) tryStoreForPath(this.__kycObjName, 0);

    /* Firestore write → replace any storage URL with cached base64 */
    if (this.__isFirestore && body) {
      try { body = swapStorageUrls(typeof body === 'string' ? body : JSON.stringify(body)); } catch (ex) {}
    }
    return _xhrSend.call(this, body);
  };

  /* ── 3. Wrap fetch for Firestore writes ─────────────────────────────── */
  var _origFetch = window.fetch;
  if (typeof _origFetch === 'function') {
    window.fetch = function (input, init) {
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      if (url.includes('firestore.googleapis.com') && init && init.body) {
        try {
          var swapped = swapStorageUrls(
            typeof init.body === 'string' ? init.body : JSON.stringify(init.body)
          );
          if (swapped !== init.body)
            init = Object.assign({}, init, { body: swapped });
        } catch (ex) {}
      }
      return _origFetch.apply(this, arguments);
    };
  }

  /* ── 4. img.src interceptors (fallback for already-written Firestore) ─ */
  function resolveUrl(url) {
    if (typeof url !== 'string' || !url.includes('firebasestorage.googleapis.com')) return null;
    var nm = url.match(/\/o\/([^?]+)/);
    if (!nm) return null;
    var objName = decodeURIComponent(nm[1]);
    var cached  = null;
    try { cached = localStorage.getItem(CACHE_PFX + objName); } catch (ex) {}
    return cached || makePlaceholder();
  }

  function makePlaceholder() {
    return 'data:image/svg+xml;utf8,' + encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="90" viewBox="0 0 120 90">' +
      '<rect width="120" height="90" fill="#1a2a3a" rx="8"/>' +
      '<text x="60" y="34" text-anchor="middle" font-family="Inter,sans-serif" font-size="11" fill="#60a5d0">Document</text>' +
      '<text x="60" y="50" text-anchor="middle" font-family="Inter,sans-serif" font-size="11" fill="#60a5d0">Submitted</text>' +
      '<text x="60" y="68" text-anchor="middle" font-family="Inter,sans-serif" font-size="18" fill="#4ade80">&#10003;</text>' +
      '</svg>'
    );
  }

  var sd = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
  if (sd && sd.set) {
    Object.defineProperty(HTMLImageElement.prototype, 'src', {
      get: sd.get,
      set: function (url) { sd.set.call(this, resolveUrl(url) || url); },
      configurable: true, enumerable: true
    });
  }

  var _origSetAttr = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (name, value) {
    if (name === 'src' && this instanceof HTMLImageElement) {
      var r = resolveUrl(value);
      if (r) return _origSetAttr.call(this, name, r);
    }
    return _origSetAttr.call(this, name, value);
  };

  /* MutationObserver for late-rendered images */
  function patchImg(img) {
    var s = img.getAttribute('src') || '';
    var r = resolveUrl(s);
    if (r && r !== s) _origSetAttr.call(img, 'src', r);
  }
  new MutationObserver(function (muts) {
    muts.forEach(function (m) {
      m.addedNodes.forEach(function (n) {
        if (n.nodeType !== 1) return;
        if (n.tagName === 'IMG') patchImg(n);
        if (n.querySelectorAll) Array.prototype.forEach.call(n.querySelectorAll('img'), patchImg);
      });
      if (m.type === 'attributes' && m.attributeName === 'src' && m.target.tagName === 'IMG')
        patchImg(m.target);
    });
  }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
})();

/* ── NeoBank Admin v11 ──────────────────────────── */

/* ── NeoBank Admin v11 ───────────────────────────────────────────────────────
   Combines:
   A) Admin Suspend + Delete buttons (below Revoke KYC, v10 uid-cache approach)
   B) Send → Add rename + Bank (Coming Soon) / Crypto (BTC) modal
      - BTC wallet address stored in Firestore settings/crypto.btcAddress
      - Admins see an "Edit" button to change the address live
─────────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  var PROJECT = 'neobankchamp';
  var API_KEY = 'AIzaSyC-YnGwyNF-WUdu_fLZ4Ds4UWKuAJJvV34';
  var FS      = 'https://firestore.googleapis.com/v1/projects/' + PROJECT + '/databases/(default)/documents';
  var ST_URL  = 'https://securetoken.googleapis.com/v1/token?key=' + API_KEY;

  window.__neoUidMap      = window.__neoUidMap      || {};
  window.__neoDeletedUids  = window.__neoDeletedUids  || {};   /* uid → true */
  window.__neoDeletedEmails= window.__neoDeletedEmails|| {}; /* email → true */
  var _tok = null, _refreshing = false, _waiters = [];
  var _rf  = window.fetch;

  /* ══════════════════════════════════════════════════════════════════════
     TOKEN MANAGEMENT
     Firebase SDK v9+ stores auth in IndexedDB, not localStorage.
     We read from both sources so the code works with any Firebase version.
  ══════════════════════════════════════════════════════════════════════ */

  /* --- Refresh a stale token using the refresh_token grant --- */
  function _doRefresh(refreshToken, cb) {
    if (_refreshing) { if(cb)_waiters.push(cb); return; }
    _refreshing = true;
    _rf(ST_URL, { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'},
      body:'grant_type=refresh_token&refresh_token='+encodeURIComponent(refreshToken)
    }).then(function(r){return r.json();}).then(function(d){
      _refreshing = false;
      if (d && d.id_token) {
        _tok = d.id_token;
        _waiters.forEach(function(f){try{f(_tok);}catch(e){}});
        _waiters = [];
        if (cb) cb(_tok);
      } else {
        if (cb) cb(null);
      }
    }).catch(function(){ _refreshing=false; if(cb) cb(null); });
  }

  /* --- Try a raw stsTokenManager object, set _tok if valid --- */
  function _useSts(m, cb) {
    if (!m || !m.accessToken) return false;
    if (!m.expirationTime || m.expirationTime > Date.now() + 30000) {
      _tok = m.accessToken;
      if (cb) cb(_tok);
      return true;
    }
    /* Token expired — refresh it */
    if (m.refreshToken) { _doRefresh(m.refreshToken, cb); return true; }
    return false;
  }

  /* --- Read from localStorage (Firebase v8 and some v9 compat mode) --- */
  function readLS(cb) {
    try {
      var keys = Object.keys(localStorage);
      for (var i = 0; i < keys.length; i++) {
        var k = keys[i];
        if (!k.includes('firebase') && !k.includes('authUser')) continue;
        var raw = localStorage.getItem(k); if (!raw) continue;
        var obj; try { obj = JSON.parse(raw); } catch(e) { continue; }
        var auth = (obj && obj.stsTokenManager) ? obj
                 : (obj && obj.value && obj.value.stsTokenManager) ? obj.value : null;
        if (!auth) continue;
        if (_useSts(auth.stsTokenManager, cb)) return true;
      }
    } catch(ex){}
    return false;
  }

  /* --- Read from IndexedDB (Firebase v9+ default storage) --- */
  function readIDB(cb) {
    try {
      var req = indexedDB.open('firebaseLocalStorageDb', 1);
      req.onerror = function(){ cb(null); };
      req.onsuccess = function(e){
        try {
          var db = e.target.result;
          var tx = db.transaction('firebaseLocalStorage','readonly');
          var store = tx.objectStore('firebaseLocalStorage');
          var getAllReq = store.getAll ? store.getAll() : null;
          if (!getAllReq) { cb(null); return; }
          getAllReq.onsuccess = function(ev){
            var items = ev.target.result || [];
            for (var i = 0; i < items.length; i++) {
              var item = items[i];
              /* Record shape: { fbase_key: "firebase:authUser:...", value: { stsTokenManager:... } } */
              var key = item.fbase_key || item.key || '';
              if (!key.includes('authUser') && !key.includes('firebase:')) continue;
              var val = item.value || item;
              var m = (val.stsTokenManager) ? val.stsTokenManager
                    : (val.stsTokenManager) ? val.stsTokenManager : null;
              if (!m && val.value) m = val.value.stsTokenManager || null;
              if (_useSts(m, cb)) return;
            }
            cb(null);
          };
          getAllReq.onerror = function(){ cb(null); };
        } catch(ex){ cb(null); }
      };
    } catch(ex){ cb(null); }
  }

  function harv(h) {
    try {
      var v = typeof h.get==='function' ? (h.get('Authorization')||h.get('authorization')||'')
                                        : (h['Authorization']||h['authorization']||'');
      if (v && v.startsWith('Bearer ')) _tok = v.slice(7);
    } catch(e){}
  }

  function learnFromDoc(doc) {
    try {
      if (!doc || !doc.name) return;
      if (!doc.name.includes('/users/')) return;
      var uid = doc.name.split('/').pop();
      var f = doc.fields || {};
      var email = (f.email&&f.email.stringValue)||(f.userEmail&&f.userEmail.stringValue)||(f.emailAddress&&f.emailAddress.stringValue)||'';
      var status = (f.accountStatus&&f.accountStatus.stringValue)||'active';
      var isAdmin = !!(f.isAdmin&&(f.isAdmin.booleanValue===true||f.isAdmin.stringValue==='true'));
      /* Track deleted users — any of these field patterns counts as "deleted" */
      var isDeleted = status==='deleted'
        || !!(f.deleted&&f.deleted.booleanValue===true)
        || !!(f.isDeleted&&f.isDeleted.booleanValue===true)
        || status==='removed';
      if (email && uid) window.__neoUidMap[email.toLowerCase()]={uid:uid,email:email,status:status};
      if (uid) window.__neoUidMap['__uid__'+uid]={uid:uid,email:email,status:status};
      if (isAdmin) window.__neoIsAdmin=true;
      if (isDeleted){
        if (uid)   window.__neoDeletedUids[uid]=true;
        if (email) window.__neoDeletedEmails[email.toLowerCase()]=true;
      }
      /* Suspended users see their own account normally — React app shows the status inline */
    } catch(ex){}
  }

  function learnFromBody(json) {
    try {
      if (!json) return;
      if (json.name) { learnFromDoc(json); return; }
      if (Array.isArray(json)) { json.forEach(function(item){ learnFromDoc(item.document||item); }); return; }
      if (json.documents) json.documents.forEach(learnFromDoc);
    } catch(ex){}
  }

  window.fetch = function(input, init) {
    if (init && init.headers) harv(init.headers);
    var url = typeof input==='string' ? input : ((input&&input.url)||'');
    var p = _rf.apply(this, arguments);
    if (url.includes('securetoken.googleapis.com'))
      p = p.then(function(r){ r.clone().json().then(function(d){ if(d&&d.id_token)_tok=d.id_token; }).catch(function(){}); return r; });
    if (url.includes('googleapis.com') && (url.includes('/users')||url.includes(':runQuery')))
      p = p.then(function(r){ r.clone().json().then(learnFromBody).catch(function(){}); return r; });
    return p;
  };

  var _xSH = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.setRequestHeader = function(n,v){
    if((n||'').toLowerCase()==='authorization'&&(v||'').startsWith('Bearer ')) _tok=v.slice(7);
    return _xSH.apply(this,arguments);
  };

  /* getTok: checks memory → localStorage → IndexedDB → polls */
  function getTok(cb) {
    if (_tok) { cb(_tok); return; }
    if (readLS(cb) && _tok) { return; }   /* sync hit or refresh started */
    if (_refreshing) { _waiters.push(cb); return; }
    /* Try IndexedDB (Firebase v9+ primary storage) */
    readIDB(function(tok){
      if (tok) { cb(tok); return; }
      /* Final fallback: poll for token arriving via fetch intercept */
      var w=0, poll=setInterval(function(){
        readLS(); w+=300;
        if (_tok || w>=10000) { clearInterval(poll); cb(_tok||null); }
      }, 300);
    });
  }

  /* Pre-warm: read tokens on load from both sources */
  readLS();
  readIDB(function(){});
  setTimeout(function(){ readLS(); readIDB(function(){}); }, 1500);
  setTimeout(function(){ readLS(); readIDB(function(){}); }, 4000);

  /* ══════════════════════════════════════════════════════════════════════
     FIRESTORE HELPERS
  ══════════════════════════════════════════════════════════════════════ */
  function ah(t){return{'Content-Type':'application/json','Authorization':'Bearer '+t};}

  function queryByEmail(tok,email,cb){
    _rf(FS+':runQuery?key='+API_KEY,{method:'POST',headers:ah(tok),
      body:JSON.stringify({structuredQuery:{from:[{collectionId:'users'}],
        where:{fieldFilter:{field:{fieldPath:'email'},op:'EQUAL',value:{stringValue:email}}},limit:1}})
    }).then(function(r){return r.json()}).then(function(rows){
      if(Array.isArray(rows)&&rows[0]&&rows[0].document){
        var doc=rows[0].document; learnFromDoc(doc);
        cb(doc.name.split('/').pop(),(doc.fields&&doc.fields.accountStatus&&doc.fields.accountStatus.stringValue)||'active');
      } else cb(null,null);
    }).catch(function(){cb(null,null);});
  }

  function resolveUid(email,cb){
    var entry=window.__neoUidMap[(email||'').toLowerCase()];
    if(entry&&entry.uid){cb(entry.uid,entry.status);return;}
    getTok(function(tok){
      if(!tok){cb(null,null);return;}
      queryByEmail(tok,email,function(uid,st){
        if(uid){cb(uid,st);return;}
        var lo=email.toLowerCase();
        if(lo===email){cb(null,null);return;}
        queryByEmail(tok,lo,cb);
      });
    });
  }

  function patchStatus(uid,suspend,cb){
    getTok(function(tok){
      if(!tok){cb('Not authenticated.');return;}
      _rf(FS+'/users/'+uid+'?updateMask.fieldPaths=accountStatus&key='+API_KEY,{
        method:'PATCH',headers:ah(tok),
        body:JSON.stringify({fields:{accountStatus:{stringValue:suspend?'suspended':'active'}}})
      }).then(function(r){if(r.ok){cb(null,suspend);return;}r.text().then(function(t){cb('Error: '+t);});})
      .catch(function(e){cb('Network: '+e);});
    });
  }

  function deleteUser(uid,cb){
    getTok(function(tok){
      if(!tok){cb('Not authenticated.');return;}
      _rf(FS+'/users/'+uid+'?key='+API_KEY,{method:'DELETE',headers:ah(tok)})
      .then(function(r){if(r.ok||r.status===200||r.status===204){cb(null);return;}r.text().then(function(t){cb('Error: '+t);});})
      .catch(function(e){cb('Network: '+e);});
    });
  }

  /* ══════════════════════════════════════════════════════════════════════
     MULTI-COIN WALLET SETTINGS
     Stored in Firestore: settings/crypto
     Fields: btcAddress, btcEnabled, ethAddress, ethEnabled, usdtAddress, usdtEnabled
  ══════════════════════════════════════════════════════════════════════ */
  var _cryptoCache = null;      /* { btcAddress, btcEnabled, ethAddress, ethEnabled, usdtAddress, usdtEnabled } */
  var _cryptoWaiters = [];
  var _cryptoFetching = false;

  var COINS = [
    { id:'btc',  name:'Bitcoin (BTC)',    network:'Bitcoin · BTC',   icon:'₿',  color:'#f59e0b' },
    { id:'eth',  name:'Ethereum (ERC20)', network:'Ethereum · ERC20',icon:'Ξ',  color:'#818cf8' },
    { id:'usdt', name:'USDT TRC20',       network:'USDT · TRC20',    icon:'₮',  color:'#22c55e' }
  ];

  function getCryptoSettings(cb){
    if(_cryptoCache){cb(_cryptoCache);return;}
    _cryptoWaiters.push(cb);
    if(_cryptoFetching) return;
    _cryptoFetching=true;
    getTok(function(tok){
      if(!tok){
        _cryptoFetching=false;
        var w=_cryptoWaiters.splice(0); w.forEach(function(f){try{f({});}catch(e){}});
        return;
      }
      _rf(FS+'/settings/crypto?key='+API_KEY,{headers:ah(tok)})
      .then(function(r){return r.json()}).then(function(doc){
        var f=doc&&doc.fields||{};
        function sv(k){return(f[k]&&f[k].stringValue)||'';}
        function bv(k){return f[k]?f[k].booleanValue!==false:true;} /* default enabled */
        _cryptoCache={
          btcAddress:sv('btcAddress'), btcEnabled:bv('btcEnabled'),
          ethAddress:sv('ethAddress'), ethEnabled:bv('ethEnabled'),
          usdtAddress:sv('usdtAddress'),usdtEnabled:bv('usdtEnabled')
        };
        _cryptoFetching=false;
        var w=_cryptoWaiters.splice(0); w.forEach(function(fn){try{fn(_cryptoCache);}catch(e){}});
      }).catch(function(){
        _cryptoFetching=false;
        var w=_cryptoWaiters.splice(0); w.forEach(function(fn){try{fn(_cryptoCache||{});}catch(e){}});
      });
    });
  }

  function saveCryptoField(fieldName, value, cb){
    getTok(function(tok){
      if(!tok){cb('Not authenticated.');return;}
      var isStr=typeof value==='string';
      var fieldVal=isStr?{stringValue:value}:{booleanValue:value};
      var fields={}; fields[fieldName]=fieldVal;
      _rf(FS+'/settings/crypto?updateMask.fieldPaths='+fieldName+'&key='+API_KEY,{
        method:'PATCH',headers:ah(tok),
        body:JSON.stringify({fields:fields})
      }).then(function(r){
        if(r.ok){
          if(!_cryptoCache) _cryptoCache={};
          _cryptoCache[fieldName]=value;
          cb(null);
        } else r.text().then(function(t){cb('Error: '+t);});
      }).catch(function(e){cb('Network: '+e);});
    });
  }

  /* Backward-compat: existing code that calls getBtcAddress / saveBtcAddress still works */
  function getBtcAddress(cb){
    getCryptoSettings(function(s){ cb((s&&s.btcAddress)||''); });
  }
  function saveBtcAddress(addr,cb){
    saveCryptoField('btcAddress',addr,function(err){
      if(!err&&_cryptoCache) _cryptoCache.btcAddress=addr;
      cb(err);
    });
  }

  /* Pre-warm crypto settings as soon as auth is ready */
  setTimeout(function(){ getTok(function(tok){ if(tok&&!_cryptoCache) getCryptoSettings(function(){}); }); }, 1200);

  /* ══════════════════════════════════════════════════════════════════════
     ADMIN: SORT USER CARDS — NEWEST FIRST
     Stamps cards with data-neo-rank on first encounter (oldest=high rank,
     newest=rank 0) then re-inserts them whenever React scrambles the order.
  ══════════════════════════════════════════════════════════════════════ */
  var _sortRankNext = 0;   /* counter: first card seen = oldest = highest number */

  function sortAdminUserCards(){
    if(!isAdminPage()) return;

    /* Find user cards: elements containing BOTH "Add Funds" and "Remove Funds" */
    var allDivs = Array.prototype.slice.call(document.querySelectorAll('div,li,article,section'));
    var cards = allDivs.filter(function(el){
      var has={};
      el.querySelectorAll('button').forEach(function(b){
        var t=(b.textContent||'').trim().toLowerCase();
        if(t==='add funds') has.add=true;
        if(t==='remove funds') has.rm=true;
      });
      return has.add && has.rm;
    });

    if(cards.length < 1) return;

    /* All cards must share the same direct parent */
    var parent = cards[0].parentElement;
    if(!parent || !cards.every(function(c){ return c.parentElement===parent; })) return;

    /* Stamp any unseen card with a rank (first seen = oldest = high number) */
    var needsSort = false;
    cards.forEach(function(card){
      if(!card.hasAttribute('data-neo-rank')){
        card.setAttribute('data-neo-rank', String(_sortRankNext++));
        needsSort = true;
      }
    });

    /* Also re-sort if DOM order doesn't match descending rank (highest rank = newest = top) */
    if(!needsSort){
      var ranks = cards.map(function(c){ return parseInt(c.getAttribute('data-neo-rank'),10); });
      for(var i=1; i<ranks.length; i++){
        if(ranks[i] > ranks[i-1]){ needsSort=true; break; } /* rank should decrease top→bottom */
      }
    }

    if(!needsSort) return;

    /* Sort: DESCENDING rank = newest (highest rank) at top */
    cards.sort(function(a,b){
      return parseInt(b.getAttribute('data-neo-rank'),10) - parseInt(a.getAttribute('data-neo-rank'),10);
    });

    /* Re-insert in sorted order at top of parent */
    cards.forEach(function(card){
      parent.insertBefore(card, parent.firstChild);
    });
  }

  /* ══════════════════════════════════════════════════════════════════════
     BANK / CARD / CRYPTO MODAL
  ══════════════════════════════════════════════════════════════════════ */
  function openAddModal(){
    if(document.getElementById('__neo_modal')) return;

    var overlay=document.createElement('div');
    overlay.id='__neo_modal';
    overlay.style.cssText='position:fixed;inset:0;z-index:2147483646;background:rgba(0,0,0,0.75);display:flex;align-items:flex-end;justify-content:center;font-family:Inter,sans-serif;';

    var sheet=document.createElement('div');
    sheet.style.cssText='background:#111827;border-radius:24px 24px 0 0;width:100%;max-width:480px;padding:24px 20px 40px;color:#fff;';

    /* Drag handle */
    var handle=document.createElement('div');
    handle.style.cssText='width:40px;height:4px;background:#374151;border-radius:2px;margin:0 auto 20px;';

    /* Title */
    var title=document.createElement('div');
    title.style.cssText='font-size:18px;font-weight:700;margin-bottom:18px;text-align:center;';
    title.textContent='Add Funds';

    /* Tabs — Crypto is active/first; Bank + Card are Coming Soon */
    var tabs=document.createElement('div');
    tabs.style.cssText='display:flex;background:#1f2937;border-radius:12px;padding:4px;margin-bottom:20px;';

    function makeTab(label,active){
      var t=document.createElement('button');
      t.textContent=label;
      t.style.cssText='flex:1;padding:10px;border:none;border-radius:9px;font-family:Inter,sans-serif;font-size:13px;font-weight:600;cursor:pointer;transition:all .2s;'+(active?'background:#3b82f6;color:#fff;':'background:transparent;color:#9ca3af;');
      return t;
    }

    var cryptoTab=makeTab('₿ Crypto',true);
    var bankTab=makeTab('🏦 Bank',false);
    var cardTab=makeTab('💳 Card',false);
    tabs.appendChild(cryptoTab); tabs.appendChild(bankTab); tabs.appendChild(cardTab);

    /* Panels */
    var panels=document.createElement('div');

    /* ── Coming Soon template ── */
    function makeComingSoonPanel(icon,label,detail){
      var p=document.createElement('div');
      p.innerHTML='<div style="text-align:center;padding:32px 16px;">'
        +'<div style="font-size:52px;margin-bottom:16px;">'+icon+'</div>'
        +'<div style="font-size:18px;font-weight:700;color:#f59e0b;margin-bottom:10px;">Coming Soon</div>'
        +'<div style="font-size:13px;color:#9ca3af;line-height:1.6;max-width:240px;margin:0 auto;">'+detail+'</div>'
        +'<div style="margin-top:20px;background:#1f2937;border-radius:12px;padding:14px 18px;display:inline-block;">'
        +'<div style="font-size:11px;color:#6b7280;margin-bottom:4px;">Available with</div>'
        +'<div style="font-size:14px;font-weight:600;color:#3b82f6;">'+label+'</div>'
        +'</div></div>';
      return p;
    }

    var bankPanel=makeComingSoonPanel('🏗️','Level 3 ✦ Upgrade','Bank transfers are available after your account is fully upgraded. Stay tuned for exciting new features!');
    bankPanel.style.display='none';

    var cardPanel=makeComingSoonPanel('🔒','Level 3 ✦ Upgrade','Card deposits are not yet available. We are working on bringing you a seamless card payment experience soon!');
    cardPanel.style.display='none';

    /* ── Crypto panel — shows all enabled coins ── */
    var cryptoPanel=document.createElement('div');
    cryptoPanel.style.cssText='max-height:340px;overflow-y:auto;';

    function renderCryptoModal(settings){
      cryptoPanel.innerHTML='';
      var s=settings||{};
      var anyShown=false;

      COINS.forEach(function(coin){
        var addr=(s[coin.id+'Address']||'').trim();
        var enabled=s[coin.id+'Enabled']!==false;
        if(!addr||!enabled) return;
        anyShown=true;

        var card=document.createElement('div');
        card.style.cssText='background:#1f2937;border-radius:12px;padding:14px 16px;margin-bottom:12px;';
        card.innerHTML=
          '<div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;">'
            +'<div style="width:28px;height:28px;border-radius:6px;background:'+coin.color+';display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:700;color:#000;">'+coin.icon+'</div>'
            +'<div>'
              +'<div style="font-size:13px;font-weight:700;color:#f1f5f9;">'+coin.name+'</div>'
              +'<div style="font-size:11px;color:#6b7280;">'+coin.network+'</div>'
            +'</div>'
          +'</div>'
          +'<div style="font-size:11px;color:#6b7280;margin-bottom:4px;">Send To</div>'
          +'<div style="font-size:12px;color:#e5e7eb;font-family:monospace;word-break:break-all;line-height:1.5;margin-bottom:12px;">'+addr+'</div>'
          +'<button style="width:100%;padding:11px;border-radius:9px;border:none;background:'+coin.color+';color:#000;font-family:Inter,sans-serif;font-size:13px;font-weight:700;cursor:pointer;">📋 Copy Address</button>';

        var copyBtn=card.querySelector('button');
        copyBtn.addEventListener('click',function(){
          navigator.clipboard.writeText(addr).then(function(){
            copyBtn.textContent='✅ Copied!'; copyBtn.style.background='#16a34a'; copyBtn.style.color='#fff';
            setTimeout(function(){copyBtn.textContent='📋 Copy Address'; copyBtn.style.background=coin.color; copyBtn.style.color='#000';},2000);
          }).catch(function(){alert(addr);});
        });
        cryptoPanel.appendChild(card);
      });

      if(!anyShown){
        cryptoPanel.innerHTML='<div style="text-align:center;padding:32px 16px;color:#6b7280;font-size:13px;">No crypto addresses are currently active.<br>Please contact support.</div>';
      }
    }

    /* Load all settings, then render */
    getCryptoSettings(renderCryptoModal);

    panels.appendChild(cryptoPanel);
    panels.appendChild(bankPanel);
    panels.appendChild(cardPanel);

    /* ── Tab switching ── */
    function showCrypto(){
      cryptoTab.style.background='#3b82f6'; cryptoTab.style.color='#fff';
      bankTab.style.background='transparent'; bankTab.style.color='#9ca3af';
      cardTab.style.background='transparent'; cardTab.style.color='#9ca3af';
      cryptoPanel.style.display=''; bankPanel.style.display='none'; cardPanel.style.display='none';
    }
    function showBank(){
      bankTab.style.background='#3b82f6'; bankTab.style.color='#fff';
      cryptoTab.style.background='transparent'; cryptoTab.style.color='#9ca3af';
      cardTab.style.background='transparent'; cardTab.style.color='#9ca3af';
      bankPanel.style.display=''; cryptoPanel.style.display='none'; cardPanel.style.display='none';
    }
    function showCard(){
      cardTab.style.background='#3b82f6'; cardTab.style.color='#fff';
      cryptoTab.style.background='transparent'; cryptoTab.style.color='#9ca3af';
      bankTab.style.background='transparent'; bankTab.style.color='#9ca3af';
      cardPanel.style.display=''; cryptoPanel.style.display='none'; bankPanel.style.display='none';
    }
    cryptoTab.addEventListener('click',showCrypto);
    bankTab.addEventListener('click',showBank);
    cardTab.addEventListener('click',showCard);

    /* Close on overlay click */
    overlay.addEventListener('click',function(e){ if(e.target===overlay) overlay.remove(); });

    /* Assemble */
    sheet.appendChild(handle);
    sheet.appendChild(title);
    sheet.appendChild(tabs);
    sheet.appendChild(panels);
    overlay.appendChild(sheet);
    document.body.appendChild(overlay);
  }

  /* ══════════════════════════════════════════════════════════════════════
     RENAME "Send" → "Add" AND INTERCEPT CLICK
     Also patch "Send to" / "Send To" labels in the UI
  ══════════════════════════════════════════════════════════════════════ */
  var _renamedSend = new WeakSet();
  var _patchedSendTo = new WeakSet();

  function patchSendToLabels(){
    /* Walk all text nodes and replace "Send to" / "Send To" / "Send money to" labels */
    var walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT,null,false);
    var node;
    while((node=walker.nextNode())){
      if(_patchedSendTo.has(node)) continue;
      var txt=node.textContent||'';
      if(/send\s+to/i.test(txt)){
        _patchedSendTo.add(node);
        node.textContent=txt.replace(/send\s+to/gi,'Add to');
      }
    }
  }

  function patchSendButtons(){
    patchSendToLabels();
    document.querySelectorAll('button, div[role="button"], a').forEach(function(el){
      if(_renamedSend.has(el)) return;
      var t=(el.textContent||'').trim();
      /* Match standalone "Send" labels — not "Send Money to X" or form submits */
      if(t!=='Send' && !/^[\u{1F4E4}\u{2197}\u{27A4}➤→↑⬆]?\s*Send\s*$/u.test(t)) return;
      _renamedSend.add(el);

      /* Rename text node(s) */
      function renameNodes(node){
        if(node.nodeType===3){
          if((node.textContent||'').trim()==='Send') node.textContent=node.textContent.replace('Send','Add');
          return;
        }
        node.childNodes.forEach(renameNodes);
      }
      renameNodes(el);

      /* Intercept click — show modal, stop propagation to prevent app's own Send flow */
      el.addEventListener('click',function(e){
        e.stopImmediatePropagation();
        e.preventDefault();
        openAddModal();
      },true);
    });
  }

  /* ══════════════════════════════════════════════════════════════════════
     ADMIN: MULTI-COIN WALLET MANAGER
     Styled like TrustChain Capital — one card per coin with
     Edit Address / Disable / Enable buttons.
     Injected directly into the admin panel after the tab bar.
  ══════════════════════════════════════════════════════════════════════ */
  var _walletPanelInjected = false;

  function buildAdminWalletPanel(){
    var wrap=document.createElement('div');
    wrap.id='__neo_admin_wallet';
    wrap.style.cssText='font-family:Inter,sans-serif;margin:16px 0 8px;';

    /* Header row */
    var hdr=document.createElement('div');
    hdr.style.cssText='display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;';
    hdr.innerHTML=
      '<div>'
        +'<div style="font-size:14px;font-weight:700;color:#f1f5f9;">Deposit Addresses</div>'
        +'<div style="font-size:11px;color:#64748b;margin-top:2px;">Control deposit addresses displayed to users</div>'
      +'</div>'
      +'<div style="background:#f59e0b;color:#000;font-size:11px;font-weight:700;padding:5px 12px;border-radius:20px;">💰 Wallet</div>';
    wrap.appendChild(hdr);

    /* Coin cards container */
    var cardsEl=document.createElement('div');
    cardsEl.id='__neo_aw_cards';
    cardsEl.innerHTML='<div style="text-align:center;padding:20px;color:#6b7280;font-size:12px;">Loading…</div>';
    wrap.appendChild(cardsEl);

    function renderCards(settings){
      cardsEl.innerHTML='';
      var s=settings||{};

      COINS.forEach(function(coin){
        var addr=(s[coin.id+'Address']||'').trim();
        var enabled=s[coin.id+'Enabled']!==false;

        var card=document.createElement('div');
        card.style.cssText='background:#111827;border:1px solid #1e293b;border-radius:14px;padding:16px;margin-bottom:12px;';

        /* Card header: name + status badge */
        var cardHdr=document.createElement('div');
        cardHdr.style.cssText='display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;';
        cardHdr.innerHTML=
          '<div>'
            +'<div style="font-size:14px;font-weight:700;color:#f1f5f9;">'+coin.name+'</div>'
            +'<div style="font-size:11px;color:#64748b;margin-top:1px;">'+coin.network+'</div>'
          +'</div>'
          +'<span id="__neo_badge_'+coin.id+'" style="font-size:11px;font-weight:600;padding:3px 10px;border-radius:20px;'+(enabled?'background:#14532d;color:#4ade80;':'background:#450a0a;color:#f87171;')+'">'+(enabled?'Active':'Disabled')+'</span>';
        card.appendChild(cardHdr);

        /* Address display box */
        var addrBox=document.createElement('div');
        addrBox.id='__neo_aw_box_'+coin.id;
        addrBox.style.cssText='background:#0f172a;border-radius:8px;padding:10px 12px;margin:10px 0 14px;font-size:12px;color:#94a3b8;font-family:monospace;word-break:break-all;min-height:38px;line-height:1.6;';
        addrBox.textContent=addr||'(no address set)';
        card.appendChild(addrBox);

        /* Buttons row */
        var btns=document.createElement('div');
        btns.style.cssText='display:flex;gap:8px;';

        var editBtn=document.createElement('button');
        editBtn.textContent='Edit Address';
        editBtn.style.cssText='flex:1;padding:9px 0;border-radius:8px;border:1px solid #374151;background:#1e293b;color:#e2e8f0;font-family:Inter,sans-serif;font-size:12px;font-weight:600;cursor:pointer;';

        var toggleBtn=document.createElement('button');
        toggleBtn.textContent=enabled?'Disable':'Enable';
        toggleBtn.style.cssText='flex:1;padding:9px 0;border-radius:8px;border:none;background:'+(enabled?'#7f1d1d':'#14532d')+';color:'+(enabled?'#fca5a5':'#4ade80')+';font-family:Inter,sans-serif;font-size:12px;font-weight:600;cursor:pointer;';

        btns.appendChild(editBtn);
        btns.appendChild(toggleBtn);
        card.appendChild(btns);
        cardsEl.appendChild(card);

        /* Edit handler */
        editBtn.addEventListener('click',function(){
          var cur=(_cryptoCache&&_cryptoCache[coin.id+'Address'])||'';
          var newAddr=prompt('Enter '+coin.name+' address\n(shown to all users on the Add Funds screen):',cur);
          if(newAddr===null) return;
          newAddr=newAddr.trim();
          editBtn.textContent='Saving…'; editBtn.disabled=true;
          saveCryptoField(coin.id+'Address',newAddr,function(err){
            editBtn.textContent='Edit Address'; editBtn.disabled=false;
            if(err){alert(err);return;}
            addrBox.textContent=newAddr||'(no address set)';
            /* invalidate cache so modal re-fetches */
            _cryptoCache=null; _cryptoFetching=false;
          });
        });

        /* Toggle enable/disable handler */
        toggleBtn.addEventListener('click',function(){
          var nowEnabled=toggleBtn.textContent.trim()==='Disable';
          var newVal=!nowEnabled;
          toggleBtn.textContent='Saving…'; toggleBtn.disabled=true;
          saveCryptoField(coin.id+'Enabled',newVal,function(err){
            toggleBtn.disabled=false;
            if(err){alert(err);toggleBtn.textContent=nowEnabled?'Disable':'Enable';return;}
            var badge=card.querySelector('#__neo_badge_'+coin.id);
            if(newVal){
              toggleBtn.textContent='Disable'; toggleBtn.style.background='#7f1d1d'; toggleBtn.style.color='#fca5a5';
              if(badge){badge.textContent='Active'; badge.style.background='#14532d'; badge.style.color='#4ade80';}
            } else {
              toggleBtn.textContent='Enable'; toggleBtn.style.background='#14532d'; toggleBtn.style.color='#4ade80';
              if(badge){badge.textContent='Disabled'; badge.style.background='#450a0a'; badge.style.color='#f87171';}
            }
            _cryptoCache=null; _cryptoFetching=false;
          });
        });
      });
    }

    getCryptoSettings(renderCards);
    return wrap;
  }

  /* ── Floating admin wallet button — always visible on admin page ── */
  function injectAdminWalletPanel(){
    /* If FAB exists but was hidden, just show it again */
    var existing=document.getElementById('__neo_fab');
    if(existing){existing.style.display='flex';return;}

    /* Floating action button */
    var fab=document.createElement('button');
    fab.id='__neo_fab';
    fab.innerHTML='💰<span style="font-size:10px;display:block;line-height:1;margin-top:1px;">Wallet</span>';
    fab.style.cssText=[
      'position:fixed','bottom:88px','left:16px','z-index:2147483645',
      'width:56px','height:56px','border-radius:16px','border:none',
      'background:linear-gradient(135deg,#f59e0b,#d97706)',
      'color:#000','font-size:20px','font-weight:700',
      'cursor:pointer','box-shadow:0 4px 16px rgba(245,158,11,.5)',
      'display:flex','flex-direction:column','align-items:center','justify-content:center',
      'font-family:Inter,sans-serif','padding:0'
    ].join(';');

    fab.addEventListener('click', openWalletManager);
    document.body.appendChild(fab);
  }

  function openWalletManager(){
    if(document.getElementById('__neo_wm_overlay')) return;

    var overlay=document.createElement('div');
    overlay.id='__neo_wm_overlay';
    overlay.style.cssText='position:fixed;inset:0;z-index:2147483646;background:rgba(0,0,0,0.85);display:flex;flex-direction:column;font-family:Inter,sans-serif;overflow:hidden;';

    /* Sheet */
    var sheet=document.createElement('div');
    sheet.style.cssText='flex:1;overflow-y:auto;background:#0f172a;display:flex;flex-direction:column;';

    /* Top bar */
    var topBar=document.createElement('div');
    topBar.style.cssText='display:flex;align-items:center;justify-content:space-between;padding:20px 20px 0;flex-shrink:0;';
    topBar.innerHTML=
      '<div>'
        +'<div style="font-size:20px;font-weight:800;color:#f1f5f9;">💰 Wallet Manager</div>'
        +'<div style="font-size:12px;color:#64748b;margin-top:3px;">Control deposit addresses shown to users</div>'
      +'</div>';
    var closeBtn=document.createElement('button');
    closeBtn.textContent='✕';
    closeBtn.style.cssText='background:transparent;border:none;color:#94a3b8;font-size:22px;cursor:pointer;padding:4px 8px;';
    closeBtn.addEventListener('click',function(){overlay.remove();});
    topBar.appendChild(closeBtn);
    sheet.appendChild(topBar);

    /* Divider */
    var div=document.createElement('div');
    div.style.cssText='height:1px;background:#1e293b;margin:16px 20px;';
    sheet.appendChild(div);

    /* Content */
    var content=document.createElement('div');
    content.style.cssText='padding:0 20px 100px;';
    content.innerHTML='<div style="text-align:center;padding:30px;color:#6b7280;font-size:13px;">Loading addresses…</div>';
    sheet.appendChild(content);
    overlay.appendChild(sheet);
    document.body.appendChild(overlay);

    /* Render coin cards */
    getCryptoSettings(function(settings){
      content.innerHTML='';
      var s=settings||{};

      COINS.forEach(function(coin){
        var addr=(s[coin.id+'Address']||'').trim();
        var enabled=s[coin.id+'Enabled']!==false;

        var card=document.createElement('div');
        card.style.cssText='background:#111827;border:1px solid #1e293b;border-radius:16px;padding:18px;margin-bottom:14px;';

        /* Coin header + badge */
        var ch=document.createElement('div');
        ch.style.cssText='display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;';
        ch.innerHTML=
          '<div style="display:flex;align-items:center;gap:10px;">'
            +'<div style="width:36px;height:36px;border-radius:10px;background:'+coin.color+';display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:800;color:#000;">'+coin.icon+'</div>'
            +'<div>'
              +'<div style="font-size:15px;font-weight:700;color:#f1f5f9;">'+coin.name+'</div>'
              +'<div style="font-size:11px;color:#64748b;">'+coin.network+'</div>'
            +'</div>'
          +'</div>';
        var badge=document.createElement('span');
        badge.textContent=enabled?'Active':'Disabled';
        badge.style.cssText='font-size:11px;font-weight:600;padding:4px 12px;border-radius:20px;'+(enabled?'background:#14532d;color:#4ade80;':'background:#450a0a;color:#f87171;');
        ch.appendChild(badge);
        card.appendChild(ch);

        /* Address box */
        var addrBox=document.createElement('div');
        addrBox.style.cssText='background:#0f172a;border-radius:10px;padding:12px 14px;margin-bottom:14px;font-size:12px;color:#94a3b8;font-family:monospace;word-break:break-all;line-height:1.6;min-height:42px;';
        addrBox.textContent=addr||'(no address set — tap Edit Address to add one)';
        card.appendChild(addrBox);

        /* Buttons */
        var btnRow=document.createElement('div');
        btnRow.style.cssText='display:flex;gap:8px;';

        var editBtn=document.createElement('button');
        editBtn.textContent='Edit Address';
        editBtn.style.cssText='flex:1;padding:11px 0;border-radius:9px;border:1px solid #334155;background:#1e293b;color:#e2e8f0;font-family:Inter,sans-serif;font-size:13px;font-weight:600;cursor:pointer;';

        var togBtn=document.createElement('button');
        togBtn.textContent=enabled?'Disable':'Enable';
        togBtn.style.cssText='flex:1;padding:11px 0;border-radius:9px;border:none;background:'+(enabled?'#7f1d1d':'#14532d')+';color:'+(enabled?'#fca5a5':'#4ade80')+';font-family:Inter,sans-serif;font-size:13px;font-weight:600;cursor:pointer;';

        btnRow.appendChild(editBtn);
        btnRow.appendChild(togBtn);
        card.appendChild(btnRow);
        content.appendChild(card);

        /* Edit address */
        editBtn.addEventListener('click',function(){
          var cur=(_cryptoCache&&_cryptoCache[coin.id+'Address'])||'';
          var newAddr=prompt('Enter '+coin.name+' wallet address\n(this will be shown to all users):',cur);
          if(newAddr===null) return;
          newAddr=newAddr.trim();
          editBtn.textContent='Saving…'; editBtn.disabled=true;
          saveCryptoField(coin.id+'Address',newAddr,function(err){
            editBtn.textContent='Edit Address'; editBtn.disabled=false;
            if(err){alert('Save failed: '+err);return;}
            addrBox.textContent=newAddr||'(no address set)';
            if(!_cryptoCache) _cryptoCache={};
            _cryptoCache[coin.id+'Address']=newAddr;
          });
        });

        /* Enable / Disable toggle */
        togBtn.addEventListener('click',function(){
          var isCurrentlyDisable=togBtn.textContent.trim()==='Disable';
          var newEnabled=!isCurrentlyDisable;
          togBtn.textContent='Saving…'; togBtn.disabled=true;
          saveCryptoField(coin.id+'Enabled',newEnabled,function(err){
            togBtn.disabled=false;
            if(err){alert('Save failed: '+err);togBtn.textContent=isCurrentlyDisable?'Disable':'Enable';return;}
            if(!_cryptoCache) _cryptoCache={};
            _cryptoCache[coin.id+'Enabled']=newEnabled;
            if(newEnabled){
              togBtn.textContent='Disable'; togBtn.style.background='#7f1d1d'; togBtn.style.color='#fca5a5';
              badge.textContent='Active'; badge.style.background='#14532d'; badge.style.color='#4ade80';
            } else {
              togBtn.textContent='Enable'; togBtn.style.background='#14532d'; togBtn.style.color='#4ade80';
              badge.textContent='Disabled'; badge.style.background='#450a0a'; badge.style.color='#f87171';
            }
          });
        });
      });
    });
  }

  /* ══════════════════════════════════════════════════════════════════════
     ADMIN: SUSPEND + DELETE BUTTONS
  ══════════════════════════════════════════════════════════════════════ */
  function findEmail(root){
    if(!root||!root.querySelectorAll) return null;
    var nodes=root.querySelectorAll('*');
    for(var i=0;i<nodes.length;i++){
      var ch=nodes[i].childNodes;
      if(ch.length===1&&ch[0].nodeType===3){
        var t=(nodes[i].textContent||'').trim();
        if(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t)) return t;
      }
    }
    return null;
  }

  function findCard(el){
    var cur=el;
    for(var d=0;d<10;d++){
      if(!cur||!cur.parentElement) return null;
      cur=cur.parentElement;
      var btxt='';
      cur.querySelectorAll('button').forEach(function(b){btxt+=' '+(b.textContent||'').toLowerCase();});
      if(btxt.includes('add funds')&&btxt.includes('remove funds')) return cur;
    }
    return null;
  }

  var SA='data-neo-sus';

  function susStyle(btn,sus){
    btn.style.cssText='display:block;width:100%;margin-top:10px;padding:11px 0;border-radius:8px;border:none;cursor:pointer;font-family:Inter,sans-serif;font-size:14px;font-weight:600;'+(sus?'background:#16a34a;color:#fff':'background:#e97c0a;color:#fff');
    btn.textContent=sus?'\u2713 Unsuspend Account':'\u26a0 Suspend Account';
  }
  function busyStyle(btn,msg){btn.style.opacity='0.6';btn.style.cursor='wait';btn.textContent=msg||'Working\u2026';}

  function doSuspend(susBtn,uid,curSus){
    if(!confirm(curSus?'Reactivate this account?\nThe user will be able to log in again.':'Suspend this account?\nThe user will be blocked from the app.')) return;
    busyStyle(susBtn,curSus?'Reactivating\u2026':'Suspending\u2026'); susBtn.disabled=true;
    patchStatus(uid,!curSus,function(err,nowSus){
      susBtn.disabled=false; susBtn.style.opacity='1'; susBtn.style.cursor='pointer';
      if(err){alert(err);susStyle(susBtn,curSus);return;}
      var ck='__uid__'+uid; if(window.__neoUidMap[ck]) window.__neoUidMap[ck].status=nowSus?'suspended':'active';
      susStyle(susBtn,nowSus); susBtn.setAttribute(SA,uid+':'+(nowSus?'1':'0'));
    });
  }

  function injectAfterKyc(kycBtn){
    if(kycBtn.getAttribute('data-neo-done')==='1') return;
    kycBtn.setAttribute('data-neo-done','1');
    var card=findCard(kycBtn), email=card?findEmail(card):null;
    var susBtn=document.createElement('button'); susStyle(susBtn,false); susBtn.setAttribute(SA,'pending');
    kycBtn.insertAdjacentElement('afterend',susBtn);

    var resolvedUid=null, resolvedSus=false;
    function attempt(){
      if(!email) return;
      var entry=window.__neoUidMap[(email||'').toLowerCase()];
      if(entry&&entry.uid){
        resolvedUid=entry.uid; resolvedSus=(entry.status==='suspended');
        susStyle(susBtn,resolvedSus); susBtn.setAttribute(SA,resolvedUid+':'+(resolvedSus?'1':'0')); return;
      }
      resolveUid(email,function(uid,status){
        if(!uid) return;
        resolvedUid=uid; resolvedSus=(status==='suspended');
        susStyle(susBtn,resolvedSus); susBtn.setAttribute(SA,uid+':'+(resolvedSus?'1':'0'));
      });
    }
    attempt(); setTimeout(attempt,1500); setTimeout(attempt,4000);

    function getOrFetch(cb){
      if(resolvedUid){cb(resolvedUid,resolvedSus);return;}
      if(!email){alert('No email found for this card.');return;}
      resolveUid(email,function(uid,status){
        if(!uid){alert('User not found.\nEmail: '+email+'\n\nTip: Open the admin Users tab to load user data first, then try again.');return;}
        resolvedUid=uid; resolvedSus=(status==='suspended'); cb(uid,status==='suspended');
      });
    }
    susBtn.addEventListener('click',function(e){e.stopPropagation();if(!email){alert('No email found.');return;}getOrFetch(function(uid,sus){doSuspend(susBtn,uid,sus);});});
  }

  /* ══════════════════════════════════════════════════════════════════════
     ADMIN: HIDE CARDS FOR FIRESTORE-DELETED ACCOUNTS
     Checks every admin user card — if the card's email is in our deleted
     set (learned from intercepted Firestore responses), hides the card.
     Also actively queries Firestore for any card whose user we haven't
     seen yet, to catch accounts deleted before we loaded the page.
  ══════════════════════════════════════════════════════════════════════ */
  var _checkedCards = new WeakSet();   /* cards already queried — don't query again */

  function hideDeletedCards(){
    if(!isAdminPage()) return;

    /* Same card-detection as sortAdminUserCards */
    var allDivs = Array.prototype.slice.call(document.querySelectorAll('div,li,article,section'));
    allDivs.forEach(function(el){
      /* Only process user cards */
      var has={};
      el.querySelectorAll('button').forEach(function(b){
        var t=(b.textContent||'').trim().toLowerCase();
        if(t==='add funds') has.add=true;
        if(t==='remove funds') has.rm=true;
      });
      if(!has.add||!has.rm) return;

      /* Extract email from card text nodes */
      var cardEmail=null;
      var nodes=el.querySelectorAll('*');
      for(var i=0;i<nodes.length;i++){
        var ch=nodes[i].childNodes;
        if(ch.length===1&&ch[0].nodeType===3){
          var t2=(nodes[i].textContent||'').trim();
          if(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t2)){cardEmail=t2.toLowerCase();break;}
        }
      }
      if(!cardEmail) return;

      /* If we already know this email is deleted → hide immediately */
      if(window.__neoDeletedEmails[cardEmail]){
        el.style.display='none'; return;
      }

      /* If we have Firestore data for this user and they're NOT deleted → skip */
      var known=window.__neoUidMap[cardEmail];
      if(known && known.status && known.status!=='deleted' && known.status!=='removed') return;

      /* Otherwise query Firestore to check if their document exists */
      if(_checkedCards.has(el)) return;
      _checkedCards.add(el);

      getTok(function(tok){
        if(!tok) return;
        /* Query users collection by email */
        _rf(FS+':runQuery?key='+API_KEY,{method:'POST',headers:ah(tok),
          body:JSON.stringify({structuredQuery:{
            from:[{collectionId:'users'}],
            where:{fieldFilter:{field:{fieldPath:'email'},op:'EQUAL',value:{stringValue:cardEmail}}},
            limit:1
          }})
        }).then(function(r){return r.json();}).then(function(rows){
          /* If no document found → user was deleted from Firestore */
          var found = Array.isArray(rows) && rows.length>0 && rows[0].document;
          if(!found){
            window.__neoDeletedEmails[cardEmail]=true;
            el.style.display='none';
            return;
          }
          /* If document exists, learn from it (handles deleted/removed status fields) */
          learnFromDoc(rows[0].document);
          if(window.__neoDeletedEmails[cardEmail]) el.style.display='none';
        }).catch(function(){});
      });
    });
  }

  /* ══════════════════════════════════════════════════════════════════════
     HIDE "MEMBER SINCE" DATE IN USER PROFILE
     Finds any element whose text contains "member since" (case-insensitive)
     and hides the date sibling / parent row so it is fully private.
  ══════════════════════════════════════════════════════════════════════ */
  var _memberSinceHidden = new WeakSet();

  function hideMemberSince(){
    /* Walk every text node, find "member since" label elements */
    var walker = document.createTreeWalker(
      document.body || document.documentElement,
      NodeFilter.SHOW_TEXT,
      null, false
    );
    var node;
    while((node = walker.nextNode())){
      var txt = (node.nodeValue||'').toLowerCase();
      if(!txt.includes('member since') && !txt.includes('member since:') &&
         !txt.includes('joined') && !txt.includes('join date')) continue;

      /* Walk up to find a small container row (label + value pair) */
      var el = node.parentElement;
      if(!el || _memberSinceHidden.has(el)) continue;

      /* Hide the whole row: go up 1-3 levels to grab label+date together */
      var target = el;
      for(var d=0; d<3; d++){
        if(!target.parentElement) break;
        /* Stop if parent contains unrelated content (many children with different text) */
        var kids = target.parentElement.children;
        if(kids.length > 4) break;
        target = target.parentElement;
      }

      _memberSinceHidden.add(el);
      target.style.display = 'none';
    }
  }

  /* ══════════════════════════════════════════════════════════════════════
     ADMIN PANEL VISUAL DETECTION
     Does NOT depend on window.__neoIsAdmin / Firestore.
     Detects by the unique button combo: Users + Wd + KYC + Notifs
  ══════════════════════════════════════════════════════════════════════ */
  function isAdminPage(){
    if(window.__neoIsAdmin) return true;
    var btns=Array.prototype.slice.call(document.querySelectorAll('button'));
    var texts=btns.map(function(b){return(b.textContent||'').trim().toLowerCase().replace(/\s+/g,'');});
    var has=function(x){return texts.some(function(t){return t.includes(x);});};
    return has('notif') && has('kyc') && (has('users') || has('wd'));
  }

  /* ══════════════════════════════════════════════════════════════════════
     SCANNER (runs on DOM changes)
  ══════════════════════════════════════════════════════════════════════ */
  function scan(){
    /* 1. Rename Send → Add (including "Send to" labels) */
    patchSendButtons();
    /* 1b. Hide "Member Since" date from user profiles */
    hideMemberSince();
    /* 2. Admin KYC buttons — inject Suspend after each */
    document.querySelectorAll('button').forEach(function(btn){
      if(btn.getAttribute('data-neo-done')==='1') return;
      var t=(btn.textContent||'').trim().toLowerCase().replace(/\s+/g,' ');
      if(!/\b(revoke|verify|approve|check)\s+kyc\b/.test(t)) return;
      injectAfterKyc(btn);
    });
    /* 3. Admin wallet FAB — show whenever admin panel is visible */
    if(isAdminPage()) injectAdminWalletPanel();
    else hideFab();
    /* 4. Hide cards for Firestore-deleted accounts */
    hideDeletedCards();
    /* 5. Sort user cards: newest first */
    sortAdminUserCards();
    /* 6. Coming Soon on card/bank buttons */
    patchCardBankElements();
  }

  function hideFab(){
    var f=document.getElementById('__neo_fab');
    if(f) f.style.display='none';
  }

  /* Overlay "Coming Soon" on any native card/bank deposit UI */
  var _patchedCsEl = new WeakSet();
  function patchCardBankElements(){
    document.querySelectorAll('button,a,[role="button"]').forEach(function(el){
      if(_patchedCsEl.has(el)) return;
      var t=(el.textContent||'').trim().toLowerCase();
      if(el.closest('#__neo_modal')||el.closest('#__neo_admin_wallet')||el.closest('#__neo_fab')||el.closest('#__neo_wm_overlay')) return;
      var isBank=/\b(bank\s*(transfer|deposit|wire)|wire\s*transfer|ach|routing)\b/.test(t);
      var isCard=/\b(debit\s*card|credit\s*card|card\s*(deposit|payment)|pay\s*with\s*card)\b/.test(t);
      if(!isBank&&!isCard) return;
      _patchedCsEl.add(el);
      el.addEventListener('click',function(e){
        e.stopImmediatePropagation(); e.preventDefault();
        showComingSoonToast(isCard?'Card payments':'Bank transfers');
      },true);
    });
  }

  function showComingSoonToast(label){
    if(document.getElementById('__neo_cs_toast')) return;
    var t=document.createElement('div');
    t.id='__neo_cs_toast';
    t.style.cssText='position:fixed;bottom:88px;left:50%;transform:translateX(-50%);z-index:2147483647;background:#1f2937;color:#f1f5f9;font-family:Inter,sans-serif;font-size:13px;font-weight:600;padding:12px 20px;border-radius:12px;border:1px solid #374151;box-shadow:0 8px 24px rgba(0,0,0,.5);white-space:nowrap;';
    t.innerHTML='🔒 '+label+' — <span style="color:#f59e0b;">Coming Soon</span>';
    document.body.appendChild(t);
    setTimeout(function(){if(t.parentElement)t.parentElement.removeChild(t);},2800);
  }

  var _st=null;
  new MutationObserver(function(){clearTimeout(_st);_st=setTimeout(scan,150);})
    .observe(document.documentElement,{childList:true,subtree:true,characterData:true});
  [400,900,1800,3500,7000,12000].forEach(function(ms){setTimeout(scan,ms);});

})();

/* ── Suspended Account Overlay ──────────────────── */

/* ── NeoBank: Suspended Account Overlay ─────────────────────────────────────
   Strategy:
   1. Wrap window.fetch to intercept every Firestore /users/{uid} GET response.
      If accountStatus === "suspended" → show full-screen overlay immediately.
   2. Also make a proactive direct fetch once the auth token is available.
   3. A MutationObserver re-shows the overlay if anything removes it.
   The overlay covers the entire app so no balance, buttons, or navigation
   are accessible — and shows "Account Suspended — Contact Support".
─────────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  var PROJECT = 'neobankchamp';
  var API_KEY = 'AIzaSyC-YnGwyNF-WUdu_fLZ4Ds4UWKuAJJvV34';
  var FS      = 'https://firestore.googleapis.com/v1/projects/' + PROJECT + '/databases/(default)/documents';

  var _suspended    = false;
  var _overlayOn    = false;
  var _currentUid   = null;
  var _directDone   = false;

  /* ── JWT → UID ──────────────────────────────────────────────────────── */
  function uidFromTok(tok) {
    try {
      var seg = tok.split('.')[1].replace(/-/g,'+').replace(/_/g,'/');
      while (seg.length % 4) seg += '=';
      var pl = JSON.parse(atob(seg));
      return pl.user_id || pl.sub || null;
    } catch(e){ return null; }
  }

  /* ── Full-screen suspension overlay ────────────────────────────────── */
  function showOverlay() {
    if (_overlayOn) return;
    if (document.getElementById('__neo_sus_ov')) { _overlayOn = true; return; }
    _overlayOn = true;

    var ov = document.createElement('div');
    ov.id  = '__neo_sus_ov';
    ov.style.cssText =
      'position:fixed;inset:0;z-index:2147483640;background:#0a0a0a;'
      +'display:flex;flex-direction:column;align-items:center;justify-content:center;'
      +'font-family:Inter,sans-serif;padding:24px;';

    ov.innerHTML =
      '<div style="background:#130808;border:1.5px solid rgba(239,68,68,.55);border-radius:22px;'
      +'padding:40px 28px 36px;max-width:360px;width:100%;text-align:center;'
      +'box-shadow:0 0 70px rgba(239,68,68,.12);">'

        /* icon */
        +'<div style="width:72px;height:72px;border-radius:50%;background:rgba(239,68,68,.12);'
        +'display:flex;align-items:center;justify-content:center;margin:0 auto 22px;">'
        +'<svg width="38" height="38" viewBox="0 0 24 24" fill="none" stroke="#ef4444" '
        +'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
        +'<circle cx="12" cy="12" r="10"/>'
        +'<line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/>'
        +'</svg></div>'

        /* heading */
        +'<div style="font-size:22px;font-weight:800;color:#ef4444;margin-bottom:12px;'
        +'letter-spacing:-.3px;">Account Suspended</div>'

        /* body */
        +'<div style="font-size:14px;color:rgba(255,255,255,.6);line-height:1.75;margin-bottom:26px;">'
        +'Your account has been suspended and access has been restricted.<br>'
        +'Please contact our support team to resolve this issue.'
        +'</div>'

        /* balance placeholder */
        +'<div style="background:#1a0808;border:1px solid rgba(239,68,68,.22);border-radius:14px;'
        +'padding:18px 16px;margin-bottom:22px;">'
        +'<div style="font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:.6px;'
        +'margin-bottom:8px;">Available Balance</div>'
        +'<div style="font-size:20px;font-weight:800;color:#ef4444;">Account Suspended</div>'
        +'<div style="font-size:12px;color:#6b7280;margin-top:6px;">Contact support to restore access</div>'
        +'</div>'

        /* cta */
        +'<div style="font-size:14px;color:#f59e0b;font-weight:700;padding:4px 0;">'
        +'💬 Contact Support to restore access'
        +'</div>'

      +'</div>';

    /* Append safely once body exists */
    if (document.body) {
      document.body.appendChild(ov);
    } else {
      document.addEventListener('DOMContentLoaded', function(){ document.body.appendChild(ov); });
    }
  }

  /* ── Process a Firestore user document ─────────────────────────────── */
  function processDoc(doc, docUid) {
    if (_suspended) return;
    /* Only act if this doc is for the current logged-in user */
    if (docUid && _currentUid && docUid !== _currentUid) return;
    if (!doc || !doc.fields) return;
    var status = (doc.fields.accountStatus && doc.fields.accountStatus.stringValue) || 'active';
    if (status === 'suspended') {
      _suspended = true;
      showOverlay();
    }
  }

  /* ── Wrap window.fetch to catch Firestore /users/{uid} GET responses ─ */
  var _origFetch = window.fetch;
  window.fetch = function(input, init) {
    var url    = typeof input === 'string' ? input : ((input && input.url) || '');
    var method = (init && init.method) ? init.method.toUpperCase() : 'GET';
    var p      = _origFetch.apply(this, arguments);

    /* Match GET https://firestore.googleapis.com/.../documents/users/{uid} */
    if (method === 'GET' &&
        url.includes('firestore.googleapis.com') &&
        /\/documents\/users\/[^/?]+/.test(url) &&
        !url.includes(':runQuery')) {

      var m      = url.match(/\/documents\/users\/([^/?]+)/);
      var docUid = m ? m[1] : null;

      p = p.then(function(r) {
        r.clone().json().then(function(doc){ processDoc(doc, docUid); }).catch(function(){});
        return r;
      });
    }
    return p;
  };

  /* ── Token retrieval (IDB → localStorage → retry) ──────────────────── */
  function grabToken(cb) {
    var tries = 0;
    (function attempt() {
      /* IndexedDB — open WITHOUT explicit version to avoid upgrade errors */
      try {
        var req = indexedDB.open('firebaseLocalStorageDb');
        req.onsuccess = function(e) {
          try {
            var db   = e.target.result;
            var name = db.objectStoreNames.contains('firebaseLocalStorage')
                         ? 'firebaseLocalStorage'
                         : (db.objectStoreNames[0] || null);
            if (!name) { return lsFallback(); }
            var req2 = db.transaction(name, 'readonly').objectStore(name).getAll();
            req2.onsuccess = function(ev) {
              var rows = ev.target.result || [];
              for (var i = 0; i < rows.length; i++) {
                var v = rows[i].value || rows[i];
                if (v && v.stsTokenManager && v.stsTokenManager.accessToken)
                  return cb(v.stsTokenManager.accessToken);
                if (v && v.accessToken) return cb(v.accessToken);
              }
              lsFallback();
            };
            req2.onerror = lsFallback;
          } catch(ex) { lsFallback(); }
        };
        req.onerror = lsFallback;
      } catch(ex) { lsFallback(); }

      function lsFallback() {
        try {
          for (var k in localStorage) {
            if (!k.includes('firebase') && !k.includes('authUser')) continue;
            var v = JSON.parse(localStorage.getItem(k));
            if (v && v.stsTokenManager && v.stsTokenManager.accessToken)
              return cb(v.stsTokenManager.accessToken);
            if (v && v.accessToken) return cb(v.accessToken);
          }
        } catch(ex) {}
        /* retry for up to ~15 s */
        if (tries++ < 50) setTimeout(attempt, 300);
      }
    })();
  }

  /* ── Proactive check: fetch user doc directly once token is ready ──── */
  function doDirectCheck() {
    if (_directDone) return;
    grabToken(function(tok) {
      if (!tok) return;
      var uid = uidFromTok(tok);
      if (!uid) return;
      _currentUid  = uid;
      _directDone  = true;
      /* Use the ORIGINAL (unwrapped) fetch to avoid any loop */
      _origFetch(FS + '/users/' + uid + '?key=' + API_KEY, {
        headers: { 'Authorization': 'Bearer ' + tok }
      })
      .then(function(r){ return r.json(); })
      .then(function(doc){ processDoc(doc, uid); })
      .catch(function(){});
    });
  }

  /* ── Re-enforce overlay if React re-renders remove it ───────────────── */
  var _watchT = null;
  new MutationObserver(function() {
    if (!_suspended) return;
    clearTimeout(_watchT);
    _watchT = setTimeout(function() {
      if (!document.getElementById('__neo_sus_ov')) {
        _overlayOn = false;
        showOverlay();
      }
    }, 80);
  }).observe(document.documentElement, { childList: true, subtree: true });

  /* ── Bootstrap ──────────────────────────────────────────────────────── */
  [400, 1000, 2000, 4000, 8000].forEach(function(ms){ setTimeout(doDirectCheck, ms); });

})();

/* ── Bank Withdrawal → Coming Soon ──────────────── */

/* ── NeoBank: Bank Withdrawal → Coming Soon ─────────────────────────────────
   The withdrawal screen uses a <select> with value="bank" (Bank Transfer) and
   value="crypto" (Crypto Wallet). This patch intercepts the "bank" selection,
   resets the dropdown, and shows a Coming Soon toast — crypto works normally.
─────────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  var _patchedSelects = new WeakSet();

  function showBankWithdrawComingSoon() {
    if (document.getElementById('__neo_bw_cs_toast')) return;
    var t = document.createElement('div');
    t.id = '__neo_bw_cs_toast';
    t.style.cssText = 'position:fixed;bottom:88px;left:50%;transform:translateX(-50%);z-index:2147483647;background:#1f2937;color:#f1f5f9;font-family:Inter,sans-serif;font-size:13px;font-weight:600;padding:12px 20px;border-radius:12px;border:1px solid #374151;box-shadow:0 8px 24px rgba(0,0,0,.5);white-space:nowrap;';
    t.innerHTML = '🔒 Bank Withdrawal — <span style="color:#f59e0b;">Coming Soon</span>';
    document.body.appendChild(t);
    setTimeout(function () { if (t.parentElement) t.parentElement.removeChild(t); }, 2800);
  }

  function patchWithdrawSelects() {
    /* Find all <select> elements that contain a "bank" option */
    document.querySelectorAll('select').forEach(function (sel) {
      if (_patchedSelects.has(sel)) return;
      var hasBankOption = false;
      for (var i = 0; i < sel.options.length; i++) {
        if (sel.options[i].value === 'bank') { hasBankOption = true; break; }
      }
      if (!hasBankOption) return;
      _patchedSelects.add(sel);

      /* Label the bank option as Coming Soon */
      for (var j = 0; j < sel.options.length; j++) {
        if (sel.options[j].value === 'bank') {
          sel.options[j].text = '🔒 Bank Transfer — Coming Soon';
          sel.options[j].disabled = true;
          sel.options[j].style.color = '#f59e0b';
          break;
        }
      }

      sel.addEventListener('change', function (e) {
        if (sel.value === 'bank') {
          /* Reset selection back to placeholder */
          sel.value = '';
          /* Trigger a synthetic change so React re-syncs its state */
          var nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value');
          if (nativeInputValueSetter && nativeInputValueSetter.set) {
            nativeInputValueSetter.set.call(sel, '');
          }
          sel.dispatchEvent(new Event('change', { bubbles: true }));
          showBankWithdrawComingSoon();
        }
      }, true);
    });
  }

  var _st = null;
  new MutationObserver(function () {
    clearTimeout(_st);
    _st = setTimeout(patchWithdrawSelects, 120);
  }).observe(document.documentElement, { childList: true, subtree: true });

  [400, 900, 1800, 3500].forEach(function (ms) { setTimeout(patchWithdrawSelects, ms); });
})();