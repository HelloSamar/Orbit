    function genId() {
      var a = new Uint8Array(16);
      crypto.getRandomValues(a);
      return Array.from(a, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
    }
    function esc(v) {
      return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
    function fmtSize(bytes) {
      if (bytes < 1024) return bytes + ' B';
      if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
      if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
      return (bytes / 1073741824).toFixed(2) + ' GB';
    }
    function fmtTime(ts) {
      var diff = Date.now() - ts;
      if (diff < 60000) return 'just now';
      if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
      if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
      return Math.floor(diff / 86400000) + 'd ago';
    }
    function fileIcon(mime, name) {
      if (mime && mime.startsWith('image/')) return '🖼';
      if (mime && mime.startsWith('video/')) return '🎬';
      if (mime && mime.startsWith('audio/')) return '🎵';
      if (mime && mime.includes('pdf')) return '📄';
      if ((mime && mime.includes('zip')) || /\.(zip|rar|7z)$/i.test(name)) return '📦';
      if ((mime && mime.includes('word')) || /\.(docx|doc)$/i.test(name)) return '📝';
      if ((mime && mime.includes('sheet')) || /\.(xlsx|csv)$/i.test(name)) return '📊';
      return '📁';
    }
    function histIcon(type) {
      return { upload: '⬆', accept: '✅', decline: '❌', text: '💬' }[type] || '•';
    }

    var DID = localStorage.getItem('orbit_did');
    if (!DID || !/^[A-Za-z0-9_-]{8,64}$/.test(DID)) { DID = genId(); localStorage.setItem('orbit_did', DID); }
    var ME = '';
    var NAME = localStorage.getItem('orbit_name') || '';
    var currentTab = 'files';
    var allFiles = [];
    var allTexts = [];
    var uploadXHR = null;
    var galleryImages = [];
    var lbIndex = 0;
    var pendingQueue = [];
    var handledTransfers = {};
    var processingModal = false;
    var textStore = {};
    var pollTimer = null;

    var THUMBS = false;
    function thumbUrl(id) { return '/api/thumb/' + encodeURIComponent(id) + '?deviceId=' + encodeURIComponent(DID); }
    function dlUrl(id) { return '/api/download/' + encodeURIComponent(id) + '?deviceId=' + encodeURIComponent(DID); }

    async function api(method, url, body) {
      var opts = { method: method, headers: { 'Content-Type': 'application/json', 'X-Device-Id': DID } };
      if (body) opts.body = JSON.stringify(body);
      var r = await fetch(url, opts);
      if (r.status === 401) { location.reload(); return {}; }
      var data = await r.json().catch(function () { return {}; });
      data._status = r.status;
      return data;
    }

    function getJSON(url) {
      return fetch(url, { headers: { 'X-Device-Id': DID } }).then(function (r) {
        if (r.status === 401) { location.reload(); return []; }
        return r.json();
      });
    }

    function toast(msg, type) {
      var el = document.getElementById('toast');
      el.textContent = msg;
      el.className = 'show ' + (type || 'ok');
      clearTimeout(toast._t);
      toast._t = setTimeout(function () { el.className = ''; }, 2500);
    }

    function initTheme() {
      var theme = localStorage.getItem('orbit_theme') || 'dark';
      document.documentElement.dataset.theme = theme;
      document.getElementById('themeBtn').textContent = theme === 'dark' ? '☀️' : '🌙';
    }
    initTheme();

    function initName() {
      if (NAME) return startApp();
      var ua = navigator.userAgent;
      var guess = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : 'My Device';
      document.getElementById('nameInput').value = guess;
      document.getElementById('nameInput').focus();
      document.getElementById('nameInput').select();
    }

    function startApp() {
      document.getElementById('nameModal').style.display = 'none';
      document.getElementById('headerName').textContent = NAME;
      dropZoneInit();
      beat();
      pollTimer = setInterval(beat, 2500);
      loadHistory();
    }

    function switchTab(tab) {
      currentTab = tab;
      document.querySelectorAll('.tab-btn').forEach(function (btn) { btn.classList.toggle('active', btn.dataset.tab === tab); });
      document.querySelectorAll('.tab-pane').forEach(function (pane) { pane.classList.toggle('active', pane.id === 'pane-' + tab); });
      if (tab === 'gallery') renderGallery();
      if (tab === 'history') loadHistory();
    }

    var beating = false;
    async function beat() {
      if (beating) return;
      beating = true;
      try {
        var data = await api('POST', '/api/heartbeat', { deviceName: NAME });
        if (!data.ok) return;
        ME = data.me;
        THUMBS = !!data.thumbs;
        renderDevices(data.devices);
        updateStorage(data.storage);
        if (data.pending && data.pending.length > 0) {
          data.pending.forEach(function (tr) {
            if (handledTransfers[tr.transferId]) return;
            if (!pendingQueue.find(function (p) { return p.transferId === tr.transferId; })) pendingQueue.push(tr);
          });
          if (!processingModal) showNextModal();
        }
        await Promise.all([loadFiles(), loadTexts()]);
        if (currentTab === 'history') loadHistory();
      } catch (e) {} finally { beating = false; }
    }

    function updateStorage(s) {
      if (!s) return;
      document.getElementById('storUsed').textContent = fmtSize(s.used) + ' used';
      document.getElementById('storLimit').textContent = s.limit ? fmtSize(s.limit) : (s.free ? fmtSize(s.free) + ' free' : 'No limit');
      var cap = s.limit || (s.free ? s.used + s.free : 0);
      var pct = cap ? Math.min(100, (s.used / cap) * 100) : 0;
      document.getElementById('storFill').style.width = pct + '%';
    }

    function renderDevices(devs) {
      var el = document.getElementById('deviceList');
      updateSendTo(devs || []);
      if (!devs || !devs.length) {
        el.innerHTML = '<div style="padding:8px 0; color:var(--muted); font-size:13px;">No devices online</div>';
        return;
      }
      el.innerHTML = devs.map(function (d) {
        return '<div class="device-item">'
          + '<div class="device-dot"></div>'
          + '<div class="device-name">' + esc(d.name) + '</div>'
          + (d.id === ME ? '<div class="you-tag">You</div>' : '')
          + '</div>';
      }).join('');
    }

    function updateSendTo(devs) {
      ['sendTo', 'textSendTo'].forEach(function (selId) {
        var sel = document.getElementById(selId);
        if (!sel) return;
        var cur = sel.value;
        sel.innerHTML = '<option value="everyone">Everyone</option>' + devs.filter(function (d) { return d.id !== ME; }).map(function (d) {
          return '<option value="' + esc(d.id) + '">' + esc(d.name) + '</option>';
        }).join('');
        if (cur && sel.querySelector('option[value="' + cur + '"]')) sel.value = cur;
      });
    }

    function dropZoneInit() {
      var dz = document.getElementById('dropZone');
      var fileInput = document.getElementById('fileInput');
      dz.addEventListener('click', function () { fileInput.click(); });
      dz.addEventListener('dragover', function (e) { e.preventDefault(); dz.classList.add('drag'); });
      dz.addEventListener('dragleave', function () { dz.classList.remove('drag'); });
      dz.addEventListener('drop', function (e) { e.preventDefault(); dz.classList.remove('drag'); doUpload(e.dataTransfer.files); });
      fileInput.addEventListener('change', function (e) { doUpload(e.target.files); });
    }

    function finishUpload() {
      uploadXHR = null;
      document.getElementById('cancelUploadBtn').style.display = 'none';
      document.getElementById('fileInput').value = '';
      hideProgress();
    }

    function doUpload(files) {
      if (!files || !files.length) return;
      if (uploadXHR) { toast('An upload is already running', 'err'); return; }
      var fd = new FormData();
      fd.append('targetDevice', document.getElementById('sendTo').value);
      fd.append('deviceName', NAME);
      for (var i = 0; i < files.length; i++) fd.append('files', files[i]);
      var count = files.length;

      var xhr = new XMLHttpRequest();
      uploadXHR = xhr;
      document.getElementById('cancelUploadBtn').style.display = 'inline-block';
      showProgress();

      xhr.upload.addEventListener('progress', function (e) {
        if (!e.lengthComputable) return;
        var pct = Math.round((e.loaded / e.total) * 100);
        document.getElementById('progressBar').style.width = pct + '%';
        document.getElementById('progressPct').textContent = pct + '%';
        document.getElementById('progressText').textContent = 'Uploading ' + count + ' file(s)…';
      });

      xhr.addEventListener('load', function () {
        var ok = xhr.status >= 200 && xhr.status < 300;
        var msg = '';
        if (!ok) { try { msg = JSON.parse(xhr.responseText).error; } catch (e) {} }
        if (xhr.status === 401) { location.reload(); return; }
        finishUpload();
        if (ok) toast('Uploaded ' + count + ' file(s)!');
        else toast(msg || (xhr.status === 413 ? 'File too large' : 'Upload failed'), 'err');
        loadFiles();
      });
      xhr.addEventListener('error', function () { finishUpload(); toast('Upload failed', 'err'); });
      xhr.addEventListener('abort', function () { finishUpload(); toast('Cancelled'); });

      xhr.open('POST', '/api/upload');
      xhr.setRequestHeader('X-Device-Id', DID);
      xhr.send(fd);
    }

    function showProgress() {
      document.getElementById('progressWrap').classList.add('show');
      document.getElementById('progressBar').style.width = '0%';
      document.getElementById('progressPct').textContent = '0%';
    }
    function hideProgress() { document.getElementById('progressWrap').classList.remove('show'); }

    async function loadFiles() {
      try {
        var res = await getJSON('/api/files');
        if (!Array.isArray(res)) return;
        var changed = JSON.stringify(res) !== JSON.stringify(allFiles);
        allFiles = res;
        if (changed && !document.querySelector('.rename-input')) {
          renderFiles();
          if (currentTab === 'gallery') renderGallery();
        }
      } catch (e) {}
    }

    function renderFiles() {
      var el = document.getElementById('fileList');
      if (!allFiles.length) {
        el.innerHTML = '<div class="empty-state"><div class="emoji">📭</div><p>No files yet. Upload something!</p></div>';
        return;
      }
      el.innerHTML = allFiles.map(function (f) {
        var id = esc(f.id);
        var manage = f.uploadedBy === ME || (f.targetDevice === ME && f.accepted);
        return '<div class="file-item">'
          + '<div class="file-icon">' + fileIcon(f.mimeType, f.originalName) + '</div>'
          + '<div class="file-info">'
          + '<div class="file-name"' + (manage ? ' data-action="rename-file" data-id="' + id + '" data-file-name="' + id + '" title="Click to rename"' : '') + '>' + esc(f.originalName) + '</div>'
          + '<div class="file-meta">' + fmtSize(f.size) + ' · ' + esc(f.uploadedByName) + ' · ' + fmtTime(f.uploadedAt) + (f.targetDevice !== 'everyone' && !f.accepted ? ' · awaiting accept' : '') + '</div>'
          + '</div>'
          + '<div class="file-actions">'
          + '<button class="btn-success" data-action="download-file" data-id="' + id + '">⬇</button>'
          + (manage ? '<button class="btn-danger" data-action="delete-file" data-id="' + id + '">✕</button>' : '')
          + '</div>'
          + '</div>';
      }).join('');
    }

    async function deleteFile(id) {
      var r = await api('DELETE', '/api/files/' + encodeURIComponent(id));
      if (r._status === 403) toast('Not allowed', 'err'); else toast('File deleted');
      loadFiles();
    }

    function startRename(id) {
      var nameEl = document.querySelector('[data-file-name="' + id + '"]');
      if (!nameEl) return;
      var old = nameEl.textContent;
      var input = document.createElement('input');
      input.value = old;
      input.maxLength = 200;
      input.className = 'rename-input';
      nameEl.replaceWith(input);
      input.focus();
      input.select();
      var cancelled = false;

      async function save() {
        var v = input.value.trim();
        if (!cancelled && v && v !== old) await api('PATCH', '/api/files/' + encodeURIComponent(id), { name: v });
        allFiles = [];
        loadFiles();
      }

      input.addEventListener('blur', save);
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') input.blur();
        if (e.key === 'Escape') { cancelled = true; input.blur(); }
      });
    }

    function renderGallery() {
      galleryImages = allFiles.filter(function (f) { return f.mimeType && f.mimeType.startsWith('image/'); });
      var el = document.getElementById('galleryGrid');
      if (!galleryImages.length) {
        el.innerHTML = '<div class="empty-state" style="grid-column:1/-1"><div class="emoji">🖼</div><p>No images yet</p></div>';
        return;
      }
      el.innerHTML = galleryImages.map(function (f, i) {
        return '<div class="gallery-thumb" data-action="open-image" data-idx="' + i + '">'
          + '<img src="' + (THUMBS ? thumbUrl(f.id) : dlUrl(f.id)) + '" data-full="' + dlUrl(f.id) + '" alt="' + esc(f.originalName) + '" loading="lazy" decoding="async" />'
          + '</div>';
      }).join('');
    }

    function openLightbox(idx) {
      if (!galleryImages.length) return;
      lbIndex = idx;
      document.getElementById('lb-img').src = dlUrl(galleryImages[idx].id);
      document.getElementById('lightbox').classList.add('open');
    }

    async function loadTexts() {
      try {
        var res = await getJSON('/api/texts');
        if (!Array.isArray(res)) return;
        var changed = JSON.stringify(res) !== JSON.stringify(allTexts);
        allTexts = res;
        if (changed) renderTexts();
      } catch (e) {}
    }

    function renderTexts() {
      var el = document.getElementById('textList');
      if (!allTexts.length) {
        el.innerHTML = '<div class="empty-state"><div class="emoji">💬</div><p>No messages yet</p></div>';
        return;
      }
      textStore = {};
      el.innerHTML = allTexts.map(function (t) {
        textStore[t.id] = t.content;
        return '<div class="text-item">'
          + '<div class="text-header">'
          + '<div class="text-from">' + esc(t.sentByName) + (t.sentBy === ME ? ' (You)' : '') + '</div>'
          + '<div class="text-time">' + fmtTime(t.sentAt) + '</div>'
          + '</div>'
          + '<div class="text-content">' + esc(t.content) + '</div>'
          + '<div class="text-footer">'
          + '<button class="btn-sm" data-action="copy-text" data-id="' + esc(t.id) + '">📋 Copy</button>'
          + '<button class="btn-danger" data-action="delete-text" data-id="' + esc(t.id) + '">✕ Delete</button>'
          + '</div>'
          + '</div>';
      }).join('');
    }

    async function sendText() {
      var input = document.getElementById('textInput');
      var content = input.value.trim();
      if (!content) return;
      var targetDevice = document.getElementById('textSendTo').value;
      var r = await api('POST', '/api/texts', { deviceName: NAME, content: content, targetDevice: targetDevice });
      if (!r.ok) { toast(r.error || 'Could not send', 'err'); return; }
      input.value = '';
      toast('Sent!');
      allTexts = [];
      loadTexts();
    }

    async function deleteText(id) {
      await api('DELETE', '/api/texts/' + encodeURIComponent(id));
      allTexts = [];
      loadTexts();
    }

    async function loadHistory() {
      try {
        var h = await getJSON('/api/history');
        var el = document.getElementById('histList');
        if (!Array.isArray(h) || !h.length) {
          el.innerHTML = '<div class="empty-state"><div class="emoji">📜</div><p>No history yet</p></div>';
          return;
        }
        el.innerHTML = h.map(function (e) {
          return '<div class="hist-item">'
            + '<div class="hist-icon">' + histIcon(e.type) + '</div>'
            + '<div class="hist-info">'
            + '<div class="hist-desc">' + esc(e.desc) + '</div>'
            + '<div class="hist-who">by ' + esc(e.who) + '</div>'
            + '</div>'
            + '<div class="hist-ts">' + fmtTime(e.ts) + '</div>'
            + '</div>';
        }).join('');
      } catch (e) {}
    }

    function triggerDownload(id) {
      var a = document.createElement('a');
      a.href = dlUrl(id);
      a.download = '';
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { a.remove(); }, 1000);
    }

    function closeAcceptModal() { document.getElementById('acceptModal').classList.remove('open'); }

    function showNextModal() {
      if (!pendingQueue.length) { processingModal = false; return; }
      processingModal = true;
      var tr = pendingQueue[0];
      document.getElementById('acceptFrom').textContent = 'From: ' + tr.fromName;
      document.getElementById('acceptFiles').innerHTML = tr.files.map(function (f) {
        return '<li><span>' + esc(f.name) + '</span><span>' + fmtSize(f.size) + '</span></li>';
      }).join('');
      document.getElementById('acceptModal').classList.add('open');

      document.getElementById('acceptBtn').onclick = async function () {
        closeAcceptModal();
        pendingQueue.shift();
        handledTransfers[tr.transferId] = true;
        var res = await api('POST', '/api/accept/' + encodeURIComponent(tr.transferId));
        if (res.ok && res.fileIds && res.fileIds.length) {
          toast('Accepted ' + res.fileIds.length + ' file(s)!');
          for (var i = 0; i < res.fileIds.length; i++) {
            await new Promise(function (resolve) { setTimeout(resolve, i === 0 ? 100 : 500); });
            triggerDownload(res.fileIds[i]);
          }
          loadFiles();
        } else {
          toast('Those files are no longer available', 'err');
        }
        setTimeout(showNextModal, 400);
      };

      document.getElementById('declineBtn').onclick = async function () {
        closeAcceptModal();
        pendingQueue.shift();
        handledTransfers[tr.transferId] = true;
        await api('POST', '/api/decline/' + encodeURIComponent(tr.transferId));
        toast('Declined');
        setTimeout(showNextModal, 400);
      };
    }

    document.body.addEventListener('click', function (e) {
      var target = e.target.closest('[data-action]');
      if (!target) return;
      var action = target.dataset.action;
      var id = target.dataset.id;

      switch (action) {
        case 'set-name': {
          var v = document.getElementById('nameInput').value.trim();
          if (!v) return;
          NAME = v.slice(0, 30);
          localStorage.setItem('orbit_name', NAME);
          startApp();
          break;
        }
        case 'toggle-theme': {
          var dark = document.documentElement.dataset.theme === 'dark';
          document.documentElement.dataset.theme = dark ? 'light' : 'dark';
          localStorage.setItem('orbit_theme', dark ? 'light' : 'dark');
          document.getElementById('themeBtn').textContent = dark ? '🌙' : '☀️';
          break;
        }
        case 'toggle-qr':
          document.getElementById('sidebar').classList.toggle('open');
          break;
        case 'switch-tab':
          switchTab(target.dataset.tab);
          break;
        case 'trigger-upload':
          document.getElementById('fileInput').click();
          break;
        case 'cancel-upload':
          if (uploadXHR) uploadXHR.abort();
          break;
        case 'delete-file':
          deleteFile(id);
          break;
        case 'download-file':
          triggerDownload(id);
          break;
        case 'rename-file':
          startRename(id);
          break;
        case 'open-image':
          openLightbox(parseInt(target.dataset.idx, 10));
          break;
        case 'delete-text':
          deleteText(id);
          break;
        case 'copy-text': {
          var txt = textStore[id] || '';
          var done = function () { toast('Copied!'); };
          var fallback = function () {
            try {
              var ta = document.createElement('textarea');
              ta.value = txt; ta.style.position = 'fixed'; ta.style.opacity = '0';
              document.body.appendChild(ta); ta.select();
              var ok = document.execCommand('copy');
              ta.remove();
              if (ok) done(); else toast('Copy failed', 'err');
            } catch (err) { toast('Copy failed', 'err'); }
          };
          // navigator.clipboard is unavailable on plain http:// LAN pages, so fall back.
          if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(txt).then(done).catch(fallback);
          else fallback();
          break;
        }
        case 'send-text':
          sendText();
          break;
      }
    });

    // If a thumbnail cannot be generated (unsupported type / sharp missing), show the original.
    document.getElementById('galleryGrid').addEventListener('error', function (e) {
      var img = e.target;
      if (img && img.tagName === 'IMG' && img.dataset.full && !img.dataset.fb) {
        img.dataset.fb = '1';
        img.src = img.dataset.full;
      }
    }, true);

    document.getElementById('nameInput').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') document.querySelector('[data-action="set-name"]').click();
    });

    function lbShow() { document.getElementById('lb-img').src = dlUrl(galleryImages[lbIndex].id); }
    document.getElementById('lb-close').addEventListener('click', function (e) { e.stopPropagation(); document.getElementById('lightbox').classList.remove('open'); });
    document.getElementById('lightbox').addEventListener('click', function () { document.getElementById('lightbox').classList.remove('open'); });
    document.getElementById('lb-prev').addEventListener('click', function (e) {
      e.stopPropagation();
      if (!galleryImages.length) return;
      lbIndex = (lbIndex - 1 + galleryImages.length) % galleryImages.length;
      lbShow();
    });
    document.getElementById('lb-next').addEventListener('click', function (e) {
      e.stopPropagation();
      if (!galleryImages.length) return;
      lbIndex = (lbIndex + 1) % galleryImages.length;
      lbShow();
    });

    document.addEventListener('keydown', function (e) {
      if (!document.getElementById('lightbox').classList.contains('open')) return;
      if (e.key === 'Escape') document.getElementById('lightbox').classList.remove('open');
      if (e.key === 'ArrowLeft') document.getElementById('lb-prev').click();
      if (e.key === 'ArrowRight') document.getElementById('lb-next').click();
    });

    initName();
  
