// ── CONFIG ──
var API_BASE = (typeof window !== 'undefined' && window.SITE_API_BASE) ? window.SITE_API_BASE : '';

var STATIC_PAGES = {
  home:    'index.html',
  about:   'about.html',
  blog:    'blog.html',
  contact: 'contact.html'
};

// DYNAMIC_PAGE_ID is set by an inline script in dynamic.html before this file loads.
var CURRENT_PAGE_ID = (typeof DYNAMIC_PAGE_ID !== 'undefined' && DYNAMIC_PAGE_ID)
  ? DYNAMIC_PAGE_ID
  : (document.body.dataset.page || 'home');

// ── STATE ──
var isAdmin      = sessionStorage.getItem('trm_admin') === '1';
var startTime    = Date.now();
var pages        = null;
var siteSettings = { title: 'TERMINAL' };

// ── BACKEND STORAGE ──
function save(key, val) {
  if (key === 'pages')    pages = val;
  if (key === 'settings') siteSettings = val;
  fetch(API_BASE + '/api/data', {
    method:      'POST',
    credentials: 'include',
    headers:     { 'Content-Type': 'application/json' },
    body:        JSON.stringify({ pages: pages, settings: siteSettings })
  }).catch(function() {});
}

// ── DEFAULT CONTENT ──
function defaultPages() {
  return [
    {
      id: 'home', type: 'home', title: 'home',
      data: {
        welcome: '■ TERMINAL ■',
        tagline: '> est. 2025',
        status: { VERSION: '1.0.0', SYSTEM: 'TERMINAL OS', MODE: 'READ/WRITE' }
      }
    },
    {
      id: 'about', type: 'article', title: 'about',
      data: {
        heading: 'ABOUT.TXT',
        body: "> Hello. I'm a developer, writer, and digital explorer.\n\n> This site runs on plain HTML and zero frameworks. Built to last decades — just like the machines that inspired it.\n\n> I believe in open source, slow software, and the beauty of the command line."
      }
    },
    {
      id: 'blog', type: 'blog', title: 'blog',
      data: {
        heading: 'BLOG / INDEX',
        posts: [
          { date: '2025-11-02', title: 'Why I still use a text editor from 1991' },
          { date: '2025-09-18', title: 'The case for boring technology' },
          { date: '2025-07-04', title: 'Static sites and the slow web manifesto' },
          { date: '2025-05-21', title: 'CRT displays: a love letter to phosphor' }
        ]
      }
    },
    {
      id: 'contact', type: 'article', title: 'contact',
      data: {
        heading: 'CONTACT.SH',
        body: '> EMAIL     user@terminal.sh\n\n> GITHUB    github.com/yourhandle\n\n> MASTODON  @user@fosstodon.org\n\n> PGP KEY   0xDEAD BEEF CAFE 1337\n\n> Response time: usually within 48h. No spam. No trackers.'
      }
    }
  ];
}

// ── MIGRATIONS ──
function runMigrations() {
  var home = pages.find(function(p) { return p.id === 'home'; });
  if (home && home.data && home.data.status) {
    var sys = home.data.status.SYSTEM;
    if (!sys || sys === 'GENX SOFT CLUB OS' || sys === 'VERT OS') {
      home.data.status.SYSTEM = 'TERMINAL OS';
    }
  }
  // Ensure all default static pages exist in the array (forward-compat)
  var defaults = defaultPages();
  defaults.forEach(function(def) {
    if (!pages.find(function(p) { return p.id === def.id; })) {
      pages.unshift(def);
    }
  });
}

// ── HELPERS ──
function pad(n)  { return String(n).padStart(2, '0'); }
function pad2(n) { return n < 10 ? '0' + n : '' + n; }
function esc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── CLOCK & UPTIME ──
function tick() {
  var now = new Date();
  var clk = document.getElementById('clock');
  if (clk) clk.textContent = pad(now.getHours()) + ':' + pad(now.getMinutes()) + ':' + pad(now.getSeconds());

  var e = Math.floor((Date.now() - startTime) / 1000);
  var s = e % 60, m = Math.floor(e / 60) % 60, h = Math.floor(e / 3600) % 24, d = Math.floor(e / 86400);
  var u = d + 'd ' + pad(h) + ':' + pad(m) + ':' + pad(s);
  var uel = document.getElementById('uptime-s');
  if (uel) uel.textContent = u;
  var hup = document.getElementById('dyn-uptime');
  if (hup) hup.textContent = u;
}
setInterval(tick, 1000);
tick();

// ── SITE TITLE ──
function applySiteTitle() {
  var t = (siteSettings && siteSettings.title) || 'TERMINAL';
  document.title = t;
  var sn = document.getElementById('sysname');
  if (sn) sn.textContent = '[ ' + t + ' ]';
}

// ── NAV ──
function getPageUrl(id) {
  return STATIC_PAGES[id] ? STATIC_PAGES[id] : 'dynamic.html?id=' + encodeURIComponent(id);
}

function renderNav() {
  var ul = document.getElementById('nav-list');
  if (!ul) return;
  ul.innerHTML = '';
  pages.forEach(function(pg) {
    var li = document.createElement('li');
    var a  = document.createElement('a');
    a.href      = getPageUrl(pg.id);
    a.className = 'nav-btn' + (pg.id === CURRENT_PAGE_ID ? ' active' : '');
    a.dataset.id = pg.id;
    a.innerHTML  = '<span class="arr">&gt;</span> ' + esc(pg.title);
    li.appendChild(a);
    ul.appendChild(li);
  });
}

// ── CONTENT OVERRIDES (static pages) ──
function applyPageOverrides() {
  if (typeof DYNAMIC_PAGE_ID !== 'undefined' && DYNAMIC_PAGE_ID) return;
  var pg = pages.find(function(p) { return p.id === CURRENT_PAGE_ID; });
  if (!pg) return;
  if (pg.type === 'home')    applyHomeOverrides(pg.data);
  if (pg.type === 'article') applyArticleOverrides(pg);
  if (pg.type === 'blog')    applyBlogOverrides(pg);
}

function applyHomeOverrides(data) {
  var el;
  el = document.getElementById('home-welcome');
  if (el && data.welcome) el.textContent = data.welcome;
  el = document.getElementById('home-tagline');
  if (el && data.tagline) el.textContent = data.tagline;
  if (data.status) {
    Object.keys(data.status).forEach(function(k) {
      var s = document.getElementById('home-status-' + k);
      if (s) s.textContent = data.status[k];
    });
  }
}

function applyArticleOverrides(pg) {
  var el;
  el = document.getElementById(pg.id + '-heading');
  if (el && pg.data.heading) el.textContent = pg.data.heading;
  el = document.getElementById(pg.id + '-body');
  if (el && pg.data.body) {
    var lines = pg.data.body.split('\n').filter(function(l) { return l.trim(); });
    el.innerHTML = lines.map(function(l) { return '<p>' + esc(l) + '</p>'; }).join('');
  }
}

function applyBlogOverrides(pg) {
  var el;
  el = document.getElementById('blog-heading');
  if (el && pg.data.heading) el.textContent = pg.data.heading;
  el = document.getElementById('blist-blog');
  if (el && pg.data.posts) el.innerHTML = buildBlogItems('blog', pg.data.posts);
}

// ── BLOG ITEM HTML ──
function buildBlogItems(pgId, posts) {
  return posts.map(function(p, i) {
    return '<li class="blog-item">' +
      '<span class="bdate">' + esc(p.date) + '</span>' +
      '<span class="btitle">' + esc(p.title) + '</span>' +
      '<span class="blink admin-only" style="display:none" onclick="removePost(\'' + pgId + '\',' + i + ')">&#x2715;</span>' +
      '</li>';
  }).join('');
}

// ── PAGE HTML BUILDERS ──
function buildPageHTML(pg) {
  switch (pg.type) {
    case 'home':    return buildHomeHTML(pg);
    case 'article': return buildArticleHTML(pg);
    case 'blog':    return buildBlogHTML(pg);
    case 'gallery': return buildGalleryHTML(pg);
    default: return '';
  }
}

function buildHomeHTML(pg) {
  var d = pg.data;
  var statusRows = '<div><span class="k">STATUS&nbsp;&nbsp;&nbsp;</span> <span class="v">ONLINE</span></div>';
  Object.keys(d.status || {}).forEach(function(k) {
    var sp = k.length < 9 ? '&nbsp;'.repeat(9 - k.length) : '';
    statusRows += '<div><span class="k">' + esc(k) + sp + '</span> <span class="v" id="home-status-' + esc(k) + '">' + esc(d.status[k]) + '</span></div>';
  });
  statusRows += '<div><span class="k">UPTIME&nbsp;&nbsp;&nbsp;</span> <span class="v" id="dyn-uptime">0d 00:00:00</span></div>';
  return '<div class="ascii" id="home-welcome">' + esc(d.welcome || '■ TERMINAL ■') + '</div>' +
    '<div class="tagline" id="home-tagline">' + esc(d.tagline) + '</div>' +
    '<div class="edit-toolbar" id="tb-home">' +
    '  <button class="etool" onclick="editSiteTitle()">&#x270E; site title</button>' +
    '  <button class="etool" onclick="editWelcome()">&#x270E; welcome text</button>' +
    '  <button class="etool" onclick="editTagline()">&#x270E; tagline</button>' +
    '</div>' +
    '<div class="status-block">' + statusRows + '</div>';
}

function buildArticleHTML(pg) {
  var d = pg.data;
  var canDel = pg.id !== 'about' && pg.id !== 'contact';
  var delBtn = canDel ? '<button class="etool danger" onclick="confirmDeletePage(\'' + pg.id + '\')">&#x2715; delete page</button>' : '';
  var lines = (d.body || '').split('\n').filter(function(l) { return l.trim(); });
  var paras = lines.map(function(l) { return '<p>' + esc(l) + '</p>'; }).join('');
  return '<div class="sec-hdr"><span>&gt; <span id="' + pg.id + '-heading">' + esc(d.heading) + '</span></span></div>' +
    '<div class="edit-toolbar" id="tb-' + pg.id + '">' +
    '  <button class="etool" onclick="editHeading(\'' + pg.id + '\')">&#x270E; heading</button>' +
    '  <button class="etool" onclick="editBody(\'' + pg.id + '\')">&#x270E; body</button>' +
    delBtn +
    '</div>' +
    '<div class="article-body" id="' + pg.id + '-body">' + paras + '</div>';
}

function buildBlogHTML(pg) {
  var d = pg.data;
  var canDel = pg.id !== 'blog';
  var delBtn = canDel ? '<button class="etool danger" onclick="confirmDeletePage(\'' + pg.id + '\')">&#x2715; delete page</button>' : '';
  var items = buildBlogItems(pg.id, d.posts || []);
  return '<div class="sec-hdr"><span>&gt; <span id="' + pg.id + '-heading">' + esc(d.heading) + '</span></span></div>' +
    '<div class="edit-toolbar" id="tb-' + pg.id + '">' +
    '  <button class="etool" onclick="editHeading(\'' + pg.id + '\')">&#x270E; heading</button>' +
    '  <button class="etool" onclick="toggleAddPost(\'' + pg.id + '\')">+ add post</button>' +
    delBtn +
    '</div>' +
    '<ul class="blog-list" id="blist-' + pg.id + '">' + items + '</ul>' +
    '<div class="blog-add" id="badd-' + pg.id + '">' +
    '  <input type="text" placeholder="YYYY-MM-DD" id="badd-date-' + pg.id + '" style="width:110px">' +
    '  <input type="text" placeholder="Post title" id="badd-title-' + pg.id + '" class="wide">' +
    '  <button class="btn primary" onclick="submitPost(\'' + pg.id + '\')">[ add ]</button>' +
    '</div>';
}

function buildGalleryHTML(pg) {
  var d = pg.data;
  var canDel = pg.id !== 'gallery';
  var delBtn = canDel ? '<button class="etool danger" onclick="confirmDeletePage(\'' + pg.id + '\')">&#x2715; delete page</button>' : '';
  var cells = (d.images || []).map(function(item, i) {
    var del = '<span class="del-img admin-only" style="display:none" onclick="removeImage(\'' + pg.id + '\',' + i + ')">&#x2715; del</span>';
    var cap = '<span class="caption">' + esc(item.caption || '') + '</span>';
    if (item.type === 'video') {
      var vidId = 'vid-' + pg.id + '-' + i;
      var inner = '';
      if (item.embedUrl) {
        var thumbUrl = '';
        var openUrl  = item.originalUrl || item.name || '';
        var ytMatch  = item.embedUrl.match(/youtube\.com\/embed\/([A-Za-z0-9_-]{11})/);
        if (ytMatch) thumbUrl = 'https://img.youtube.com/vi/' + ytMatch[1] + '/hqdefault.jpg';
        inner = '<div class="video-thumb" onclick="window.open(\'' + esc(openUrl) + '\',\'_blank\')" title="Open video">' +
          (thumbUrl
            ? '<img src="' + thumbUrl + '" style="width:100%;height:100%;object-fit:cover;display:block;">'
            : '<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:8px;"><span style="font-size:28px;color:var(--green-dim);">&#x25B6;</span><span style="font-size:10px;color:var(--green-dim);">' + esc(item.caption || 'play video') + '</span></div>') +
          '<div class="video-play-overlay"><span>&#x25B6; open</span></div>' +
          '</div>';
      } else if (item.directUrl || item.objUrl || item.src) {
        var src = item.directUrl || item.objUrl || item.src;
        var openLink = item.originalUrl
          ? ' <a class="video-open-link" href="' + esc(item.originalUrl) + '" target="_blank" rel="noopener">&#x2197; open</a>'
          : '';
        inner = '<video id="' + vidId + '" src="' + esc(src) + '" controls preload="metadata" style="width:100%;height:100%;object-fit:contain;display:block;background:#000;"></video>' +
          '<button class="video-fs-btn" onclick="goFullscreen(\'' + vidId + '\')">&#x26F6; fullscreen</button>' + openLink;
      } else {
        inner = '<div class="video-offline"><span>[VIDEO]</span><br>' + esc(item.name || 'video') + '<br><span style="font-size:10px;">re-add via URL to persist</span></div>';
      }
      return '<div class="gallery-cell video-cell">' + inner + del + cap + '</div>';
    } else if (item.type === 'audio') {
      var audLabel = item.caption || item.name || 'audio';
      var audHead = item.originalUrl
        ? '<a class="audio-label" href="' + esc(item.originalUrl) + '" target="_blank" rel="noopener">' + esc(audLabel) + '</a>'
        : '<div class="audio-label">' + esc(audLabel) + '</div>';
      return '<div class="gallery-cell audio-cell">' +
        audHead +
        '<audio src="' + esc(item.src || '') + '" controls preload="metadata"></audio>' +
        del +
        '</div>';
    } else {
      var imgEl = item.src ? '<img src="' + esc(item.src) + '" alt="' + esc(item.caption || '') + '">' : '<span>[' + pad2(i + 1) + ']</span>';
      var imgContent = (item.originalUrl && item.src)
        ? '<a href="' + esc(item.originalUrl) + '" target="_blank" rel="noopener" style="display:block;width:100%;height:100%;">' + imgEl + '</a>'
        : imgEl;
      return '<div class="gallery-cell">' + imgContent + del + cap + '</div>';
    }
  }).join('');
  if (!cells) cells = '<div class="gallery-cell" style="grid-column:span 2;background:transparent;">[empty — upload media in admin mode]</div>';
  return '<div class="sec-hdr"><span>&gt; <span id="' + pg.id + '-heading">' + esc(d.heading) + '</span></span></div>' +
    '<div class="edit-toolbar" id="tb-' + pg.id + '">' +
    '  <button class="etool" onclick="editHeading(\'' + pg.id + '\')">&#x270E; heading</button>' +
    '  <button class="etool" onclick="triggerUpload(\'' + pg.id + '\',\'image\')">&#x2B06; image</button>' +
    '  <button class="etool" onclick="triggerUpload(\'' + pg.id + '\',\'video\')">&#x2B06; video file</button>' +
    '  <button class="etool" onclick="openVideoUrlModal(\'' + pg.id + '\')">&#x2B06; video url</button>' +
    '  <button class="etool" onclick="triggerUpload(\'' + pg.id + '\',\'audio\')">&#x2B06; audio</button>' +
    '  <button class="etool" onclick="openMediaUrlModal(\'' + pg.id + '\')">&#x2B06; url</button>' +
    '  <input type="file" id="up-img-' + pg.id + '" accept="image/*" style="display:none" onchange="handleUpload(this,\'' + pg.id + '\',\'image\')">' +
    '  <input type="file" id="up-vid-' + pg.id + '" accept="video/*,.mp4,.webm,.mov,.avi,.mkv,.ogv,.m4v,.3gp,.flv" style="display:none" onchange="handleUpload(this,\'' + pg.id + '\',\'video\')">' +
    '  <input type="file" id="up-aud-' + pg.id + '" accept="audio/*,.mp3,.wav,.ogg,.flac,.aac,.m4a,.opus,.wma,.aiff,.ape" style="display:none" onchange="handleUpload(this,\'' + pg.id + '\',\'audio\')">' +
    delBtn +
    '</div>' +
    '<div class="gallery-grid" id="ggrid-' + pg.id + '">' + cells + '</div>';
}

// ── REFRESH PAGE ──
function refreshPage(pgId) {
  var pg = pages.find(function(p) { return p.id === pgId; });
  if (!pg) return;

  var dynDiv = document.getElementById('pg-' + pgId);
  if (dynDiv) {
    var wasActive = dynDiv.classList.contains('active');
    dynDiv.innerHTML = buildPageHTML(pg);
    if (wasActive) dynDiv.classList.add('active');
    if (isAdmin) {
      var tb = dynDiv.querySelector('.edit-toolbar');
      if (tb) tb.classList.add('show');
      dynDiv.querySelectorAll('.admin-only').forEach(function(el) { el.style.display = 'inline'; });
    }
    return;
  }

  if (pgId === CURRENT_PAGE_ID) {
    if (pg.type === 'home')    applyHomeOverrides(pg.data);
    if (pg.type === 'article') applyArticleOverrides(pg);
    if (pg.type === 'blog')    applyBlogOverrides(pg);
    if (isAdmin) applyAdminUI();
  }
}

// ── ADMIN AUTH ──
function toggleAdmin() {
  if (isAdmin) { logoutAdmin(); return; }
  openModal('modal-login');
  setTimeout(function() { document.getElementById('pw-input').focus(); }, 100);
}

function doLogin() {
  var pw  = document.getElementById('pw-input').value;
  var err = document.getElementById('pw-error');
  fetch(API_BASE + '/api/login', {
    method:      'POST',
    credentials: 'include',
    headers:     { 'Content-Type': 'application/json' },
    body:        JSON.stringify({ password: pw })
  })
  .then(function(r) { return r.json().then(function(d) { return { ok: r.ok, data: d }; }); })
  .then(function(res) {
    document.getElementById('pw-input').value = '';
    if (res.ok) {
      isAdmin = true;
      sessionStorage.setItem('trm_admin', '1');
      err.textContent = '';
      closeModal('modal-login');
      applyAdminUI();
    } else {
      err.textContent = '> ' + (res.data && res.data.error ? res.data.error : 'ACCESS DENIED');
      document.getElementById('pw-input').focus();
    }
  })
  .catch(function(e) {
    err.textContent = '> server error: ' + (e && e.message ? e.message : 'check console');
    document.getElementById('pw-input').value = '';
  });
}

function logoutAdmin() {
  fetch(API_BASE + '/api/logout', { method: 'POST', credentials: 'include' }).catch(function() {});
  isAdmin = false;
  sessionStorage.removeItem('trm_admin');
  applyAdminUI();
}

function applyAdminUI() {
  var btn   = document.getElementById('admin-btn');
  var badge = document.getElementById('admin-badge');
  var newPg = document.getElementById('btn-new-page');
  if (isAdmin) {
    if (btn)  { btn.textContent = '⬡ logout'; btn.classList.add('active'); }
    if (badge)  badge.style.display = 'block';
    if (newPg)  newPg.classList.remove('locked');
  } else {
    if (btn)  { btn.textContent = '⬡ admin'; btn.classList.remove('active'); }
    if (badge)  badge.style.display = 'none';
    if (newPg)  newPg.classList.add('locked');
  }
  document.querySelectorAll('.edit-toolbar').forEach(function(tb) {
    tb.classList.toggle('show', isAdmin);
  });
  document.querySelectorAll('.admin-only').forEach(function(el) {
    el.style.display = isAdmin ? 'inline' : 'none';
  });
}

// ── MODAL HELPERS ──
function openModal(id) {
  var el = document.getElementById(id);
  if (el) el.classList.add('open');
}
function closeModal(id) {
  var el = document.getElementById(id);
  if (el) el.classList.remove('open');
}

// ── BOOT (async — loads data from server before rendering) ──
var initPromise = fetch(API_BASE + '/api/data')
  .then(function(r) { return r.json(); })
  .then(function(data) {
    pages        = data.pages    || null;
    siteSettings = data.settings || { title: 'TERMINAL' };
    if (!pages) pages = defaultPages();
    runMigrations();
    applySiteTitle();
    renderNav();
    applyPageOverrides();
    // If browser thinks we're admin, verify the session is still live on the server
    if (isAdmin) {
      fetch(API_BASE + '/api/auth-check', { credentials: 'include' })
        .then(function(r) { return r.json(); })
        .then(function(d) {
          if (!d.admin) {
            isAdmin = false;
            sessionStorage.removeItem('trm_admin');
          }
          applyAdminUI();
        })
        .catch(function() { applyAdminUI(); });
    }
  })
  .catch(function() {
    // Server unreachable — render from hard-coded HTML defaults
    pages = defaultPages();
    applySiteTitle();
    renderNav();
    applyPageOverrides();
  });

// Login modal events
document.getElementById('modal-login').addEventListener('click', function(e) {
  if (e.target === this) closeModal('modal-login');
});
document.getElementById('pw-input').addEventListener('keydown', function(e) {
  if (e.key === 'Enter')  doLogin();
  if (e.key === 'Escape') closeModal('modal-login');
});
