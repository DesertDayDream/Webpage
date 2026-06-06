// ── EDIT MODAL ──
var editCallback = null;

function openEditModal(title, label, value, multiline, hint, callback) {
  document.getElementById('edit-modal-title').textContent = title;
  document.getElementById('edit-modal-label').textContent = label;
  document.getElementById('edit-modal-hint').textContent  = hint || '';
  var single = document.getElementById('edit-single');
  var multi  = document.getElementById('edit-multi');
  if (multiline) {
    single.style.display = 'none';
    multi.style.display  = 'block';
    multi.value = value;
  } else {
    multi.style.display  = 'none';
    single.style.display = 'block';
    single.value = value;
  }
  editCallback = callback;
  openModal('modal-edit');
  setTimeout(function() { (multiline ? multi : single).focus(); }, 80);
}

function commitEdit() {
  var single = document.getElementById('edit-single');
  var multi  = document.getElementById('edit-multi');
  var val = single.style.display !== 'none' ? single.value : multi.value;
  closeModal('modal-edit');
  if (editCallback) { editCallback(val); editCallback = null; }
}

// ── HEADING / BODY / TITLE / WELCOME / TAGLINE ──
function editHeading(pgId) {
  var pg = pages.find(function(p) { return p.id === pgId; });
  if (!pg) return;
  openEditModal('> EDIT_HEADING.SH', 'Heading text', pg.data.heading || '', false, '', function(val) {
    if (!val.trim()) return;
    pg.data.heading = val.trim();
    save('pages', pages);
    refreshPage(pgId);
  });
}

function editBody(pgId) {
  var pg = pages.find(function(p) { return p.id === pgId; });
  if (!pg) return;
  openEditModal('> EDIT_BODY.SH', 'Body text', pg.data.body || '', true,
    'Separate paragraphs with a blank line. Start lines with > for terminal style.', function(val) {
    pg.data.body = val;
    save('pages', pages);
    refreshPage(pgId);
  });
}

function editSiteTitle() {
  openEditModal('> SITE_TITLE.SH', 'Site title', (siteSettings && siteSettings.title) || 'TERMINAL', false,
    'Updates the browser tab title and the top header.', function(val) {
    if (!val.trim()) return;
    siteSettings.title = val.trim().toUpperCase();
    save('settings', siteSettings);
    applySiteTitle();
  });
}

function editWelcome() {
  var pg = pages.find(function(p) { return p.id === 'home'; });
  if (!pg) return;
  openEditModal('> EDIT_WELCOME.SH', 'Welcome text', pg.data.welcome || '■ TERMINAL ■', false,
    'The large heading displayed at the top of the home page.', function(val) {
    if (!val.trim()) return;
    pg.data.welcome = val.trim();
    save('pages', pages);
    refreshPage('home');
  });
}

function editTagline() {
  var pg = pages.find(function(p) { return p.id === 'home'; });
  if (!pg) return;
  openEditModal('> EDIT_TAGLINE.SH', 'Tagline', pg.data.tagline || '', false,
    'Shown below the welcome header on the home page.', function(val) {
    pg.data.tagline = val;
    save('pages', pages);
    refreshPage('home');
  });
}

// ── BLOG POSTS ──
function toggleAddPost(pgId) {
  var el = document.getElementById('badd-' + pgId);
  if (!el) return;
  el.classList.toggle('show');
  if (el.classList.contains('show')) {
    document.getElementById('badd-date-' + pgId).value = new Date().toISOString().split('T')[0];
    document.getElementById('badd-title-' + pgId).focus();
  }
}

function submitPost(pgId) {
  var pg = pages.find(function(p) { return p.id === pgId; });
  if (!pg) return;
  var date  = document.getElementById('badd-date-' + pgId).value.trim();
  var title = document.getElementById('badd-title-' + pgId).value.trim();
  if (!date || !title) return;
  pg.data.posts = pg.data.posts || [];
  pg.data.posts.unshift({ date: date, title: title });
  save('pages', pages);
  refreshPage(pgId);
  applyAdminUI();
}

function removePost(pgId, idx) {
  var pg = pages.find(function(p) { return p.id === pgId; });
  if (!pg || !pg.data.posts) return;
  pg.data.posts.splice(idx, 1);
  save('pages', pages);
  refreshPage(pgId);
  applyAdminUI();
}

// ── VIDEO URL MODAL ──
var videoUrlTargetPage = null;

function openVideoUrlModal(pgId) {
  videoUrlTargetPage = pgId;
  document.getElementById('vid-url-input').value      = '';
  document.getElementById('vid-url-caption').value    = '';
  document.getElementById('vid-url-error').textContent = '';
  openModal('modal-videourl');
  setTimeout(function() { document.getElementById('vid-url-input').focus(); }, 80);
}

function parseVideoUrl(url) {
  var yt = url.match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/);
  if (yt) return { embedUrl: 'https://www.youtube.com/embed/' + yt[1] + '?rel=0', directUrl: null, originalUrl: url };
  var vm = url.match(/vimeo\.com\/(?:video\/)?(\d+)/);
  if (vm) return { embedUrl: 'https://player.vimeo.com/video/' + vm[1], directUrl: null, originalUrl: url };
  if (/\.(mp4|webm|ogv|ogg|mov|m4v|mkv|avi|3gp|flv)(\?|$)/i.test(url)) return { embedUrl: null, directUrl: url, originalUrl: url };
  if (/^https?:\/\/.+/.test(url)) return { embedUrl: null, directUrl: url, originalUrl: url };
  return null;
}

function commitVideoUrl() {
  var url     = document.getElementById('vid-url-input').value.trim();
  var caption = document.getElementById('vid-url-caption').value.trim();
  var errEl   = document.getElementById('vid-url-error');
  if (!url) { errEl.textContent = '> enter a URL first'; return; }
  var parsed = parseVideoUrl(url);
  if (!parsed) { errEl.textContent = '> could not parse URL — check format'; return; }
  var pg = pages.find(function(p) { return p.id === videoUrlTargetPage; });
  if (!pg) return;
  pg.data.images = pg.data.images || [];
  pg.data.images.push({
    type:        'video',
    embedUrl:    parsed.embedUrl,
    directUrl:   parsed.directUrl,
    originalUrl: parsed.originalUrl,
    caption:     caption,
    name:        url
  });
  save('pages', pages);
  closeModal('modal-videourl');
  refreshPage(videoUrlTargetPage);
  applyAdminUI();
}

// ── GENERAL MEDIA URL MODAL ──
var mediaUrlTargetPage = null;

function openMediaUrlModal(pgId) {
  mediaUrlTargetPage = pgId;
  document.getElementById('media-url-input').value       = '';
  document.getElementById('media-url-caption').value     = '';
  document.getElementById('media-url-error').textContent = '';
  openModal('modal-mediaurl');
  setTimeout(function() { document.getElementById('media-url-input').focus(); }, 80);
}

function detectMediaType(url) {
  var yt = url.match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/);
  if (yt) return { type: 'video', embedUrl: 'https://www.youtube.com/embed/' + yt[1] + '?rel=0', originalUrl: url };
  var vm = url.match(/vimeo\.com\/(?:video\/)?(\d+)/);
  if (vm) return { type: 'video', embedUrl: 'https://player.vimeo.com/video/' + vm[1], originalUrl: url };
  if (/\.(mp4|webm|ogv|mov|m4v|mkv|avi|3gp|flv)(\?|$)/i.test(url))
    return { type: 'video', directUrl: url, originalUrl: url };
  if (/\.(mp3|wav|ogg|flac|aac|m4a|opus|wma|aiff|ape)(\?|$)/i.test(url))
    return { type: 'audio', src: url };
  if (/\.(jpg|jpeg|png|gif|webp|avif|svg|bmp|ico)(\?|$)/i.test(url))
    return { type: 'image', src: url };
  if (/^https?:\/\/.+/.test(url)) return { type: 'image', src: url };
  return null;
}

function commitMediaUrl() {
  var url     = document.getElementById('media-url-input').value.trim();
  var caption = document.getElementById('media-url-caption').value.trim();
  var errEl   = document.getElementById('media-url-error');
  if (!url) { errEl.textContent = '> enter a URL first'; return; }
  var parsed = detectMediaType(url);
  if (!parsed) { errEl.textContent = '> could not parse URL — check format'; return; }
  var pg = pages.find(function(p) { return p.id === mediaUrlTargetPage; });
  if (!pg) return;
  pg.data.images = pg.data.images || [];
  var item = Object.assign({ caption: caption, name: url, originalUrl: url }, parsed);
  pg.data.images.push(item);
  save('pages', pages);
  closeModal('modal-mediaurl');
  refreshPage(mediaUrlTargetPage);
  applyAdminUI();
}

// ── GALLERY UPLOADS ──
function triggerUpload(pgId, type) {
  var prefix = type === 'image' ? 'img' : type === 'video' ? 'vid' : 'aud';
  var el = document.getElementById('up-' + prefix + '-' + pgId);
  if (el) el.click();
}

function handleUpload(input, pgId, type) {
  var file = input.files[0];
  if (!file) return;
  var pg = pages.find(function(p) { return p.id === pgId; });
  if (!pg) return;
  var defaultCaption = file.name.replace(/\.[^.]+$/, '');
  var formData = new FormData();
  formData.append('file', file);
  fetch('/api/upload', { method: 'POST', credentials: 'include', body: formData })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (!data.url) { alert('Upload failed'); return; }
      openEditModal('> MEDIA_CAPTION.SH', 'Caption (optional)', defaultCaption, false,
        'Leave blank for no caption.', function(caption) {
        pg.data.images = pg.data.images || [];
        pg.data.images.push({ src: data.url, type: type, caption: caption.trim(), name: file.name });
        save('pages', pages);
        refreshPage(pgId);
        applyAdminUI();
      });
    })
    .catch(function() { alert('Upload error — is the server running?'); });
  input.value = '';
}

function goFullscreen(videoId) {
  var v = document.getElementById(videoId);
  if (!v) return;
  if (v.requestFullscreen)            v.requestFullscreen();
  else if (v.webkitRequestFullscreen) v.webkitRequestFullscreen();
  else if (v.mozRequestFullScreen)    v.mozRequestFullScreen();
  else if (v.msRequestFullscreen)     v.msRequestFullscreen();
}

function removeImage(pgId, idx) {
  var pg = pages.find(function(p) { return p.id === pgId; });
  if (!pg || !pg.data.images) return;
  pg.data.images.splice(idx, 1);
  save('pages', pages);
  refreshPage(pgId);
  applyAdminUI();
}

// ── NEW PAGE ──
var selectedTpl = 'article';

function openNewPage() {
  if (!isAdmin) return;
  selectedTpl = 'article';
  document.querySelectorAll('.tpl-card').forEach(function(c) {
    c.classList.toggle('sel', c.dataset.tpl === 'article');
  });
  document.getElementById('np-slug').value = '';
  openModal('modal-newpage');
  setTimeout(function() { document.getElementById('np-slug').focus(); }, 100);
}

function selTpl(el) {
  document.querySelectorAll('.tpl-card').forEach(function(c) { c.classList.remove('sel'); });
  el.classList.add('sel');
  selectedTpl = el.dataset.tpl;
}

function doCreatePage() {
  var slug = document.getElementById('np-slug').value.trim().toLowerCase().replace(/[^a-z0-9-]/g, '');
  if (!slug) { document.getElementById('np-slug').focus(); return; }

  if (pages.find(function(p) { return p.id === slug; })) {
    closeModal('modal-newpage');
    window.location.href = getPageUrl(slug);
    return;
  }

  var pg = { id: slug, type: selectedTpl, title: slug, data: {} };
  if (selectedTpl === 'article') {
    pg.data = { heading: slug.toUpperCase() + '.MD', body: '> Start writing your content here.\n\n> Add more paragraphs below.' };
  } else if (selectedTpl === 'blog') {
    pg.data = { heading: slug.toUpperCase() + ' / INDEX', posts: [] };
  } else if (selectedTpl === 'gallery') {
    pg.data = { heading: slug.toUpperCase() + ' / GALLERY', images: [] };
  }
  pages.push(pg);
  save('pages', pages);
  closeModal('modal-newpage');
  window.location.href = 'dynamic.html?id=' + encodeURIComponent(slug);
}

// ── DELETE PAGE ──
var pageToDelete = null;

function confirmDeletePage(pgId) {
  pageToDelete = pgId;
  openModal('modal-delpage');
}

function doDeletePage() {
  if (!pageToDelete) return;
  pages = pages.filter(function(p) { return p.id !== pageToDelete; });
  save('pages', pages);
  pageToDelete = null;
  closeModal('modal-delpage');
  window.location.href = 'index.html';
}

// ── DYNAMIC PAGE INIT (runs only on dynamic.html, after data has loaded) ──
initPromise.then(function() {
  if (typeof DYNAMIC_PAGE_ID === 'undefined' || !DYNAMIC_PAGE_ID) return;

  var pg = pages.find(function(p) { return p.id === DYNAMIC_PAGE_ID; });
  if (!pg) {
    document.getElementById('pages').innerHTML =
      '<div class="page active"><p style="color:var(--red)">&gt; ERROR: page &quot;' +
      esc(DYNAMIC_PAGE_ID) + '&quot; not found.</p></div>';
    document.getElementById('breadcrumb').textContent = '404';
    return;
  }

  document.getElementById('breadcrumb').textContent = pg.id;
  var div = document.createElement('div');
  div.className = 'page active';
  div.id = 'pg-' + pg.id;
  div.innerHTML = buildPageHTML(pg);
  document.getElementById('pages').appendChild(div);

  if (isAdmin) {
    var tb = div.querySelector('.edit-toolbar');
    if (tb) tb.classList.add('show');
    div.querySelectorAll('.admin-only').forEach(function(el) { el.style.display = 'inline'; });
  }
});

// ── MODAL EVENT LISTENERS ──
document.getElementById('modal-newpage').addEventListener('click', function(e) {
  if (e.target === this) closeModal('modal-newpage');
});
document.getElementById('modal-delpage').addEventListener('click', function(e) {
  if (e.target === this) closeModal('modal-delpage');
});
document.getElementById('modal-edit').addEventListener('click', function(e) {
  if (e.target === this) closeModal('modal-edit');
});
document.getElementById('modal-videourl').addEventListener('click', function(e) {
  if (e.target === this) closeModal('modal-videourl');
});
document.getElementById('np-slug').addEventListener('keydown', function(e) {
  if (e.key === 'Enter')  doCreatePage();
  if (e.key === 'Escape') closeModal('modal-newpage');
});
document.getElementById('edit-single').addEventListener('keydown', function(e) {
  if (e.key === 'Enter')  commitEdit();
  if (e.key === 'Escape') closeModal('modal-edit');
});
document.getElementById('edit-multi').addEventListener('keydown', function(e) {
  if (e.key === 'Escape') closeModal('modal-edit');
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) commitEdit();
});
document.getElementById('vid-url-input').addEventListener('keydown', function(e) {
  if (e.key === 'Enter')  document.getElementById('vid-url-caption').focus();
  if (e.key === 'Escape') closeModal('modal-videourl');
});
document.getElementById('vid-url-caption').addEventListener('keydown', function(e) {
  if (e.key === 'Enter')  commitVideoUrl();
  if (e.key === 'Escape') closeModal('modal-videourl');
});
document.getElementById('modal-mediaurl').addEventListener('click', function(e) {
  if (e.target === this) closeModal('modal-mediaurl');
});
document.getElementById('media-url-input').addEventListener('keydown', function(e) {
  if (e.key === 'Enter')  document.getElementById('media-url-caption').focus();
  if (e.key === 'Escape') closeModal('modal-mediaurl');
});
document.getElementById('media-url-caption').addEventListener('keydown', function(e) {
  if (e.key === 'Enter')  commitMediaUrl();
  if (e.key === 'Escape') closeModal('modal-mediaurl');
});
