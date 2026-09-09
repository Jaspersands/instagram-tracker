/*
 * Instagram Tracker — inbound capture bookmarklet.
 *
 * SAFETY CONTRACT — do not break these, they are the whole point:
 *   1. Zero network requests. No fetch, no XMLHttpRequest, no injected script src.
 *   2. No programmatic scrolling. YOU scroll; this only observes.
 *
 * It reads text the browser has already drawn in response to your own scrolling,
 * which is why it is indistinguishable from you reading the page. Anything that
 * fetches or auto-scrolls turns this into session automation, which is what gets
 * accounts disabled.
 */
(function () {
  if (window.__igTrackerCapture) { window.__igTrackerCapture.show(); return; }

  // Paths that look like usernames but aren't people.
  var RESERVED = new Set(('explore reels p direct stories accounts about legal developer api ' +
    'challenge emails session ads business creators shop help privacy terms tv igtv ' +
    'your_activity settings archive saved liked graphql web static bundles').split(' '));

  var found = new Map();          // username -> {name, text}
  var kind = guessKind();

  // Button labels and list chrome that must never be mistaken for a person's name.
  var CHROME = new Set(('follow following followers requested remove message removed ' +
    'unfollow verified suggested for you new close cancel confirm follow back').split(' '));

  function guessKind() {
    var p = location.pathname;
    if (/\/stories\//.test(p)) return 'story_viewers';
    var d = document.querySelector('[role="dialog"]');
    var h = d && d.textContent ? d.textContent.slice(0, 200).toLowerCase() : '';
    if (/\bviewer/.test(h)) return 'story_viewers';
    if (/\bcomment/.test(h)) return 'post_comments';
    if (/\bfollowers\b|\bfollowing\b/.test(h)) return 'profile_list';
    if (/\/followers|\/following/.test(p)) return 'profile_list';
    return 'post_likes';
  }

  function usernameFromHref(href) {
    try {
      var u = new URL(href, location.origin);
      if (u.origin !== location.origin) return null;
      var m = /^\/([A-Za-z0-9._]{1,30})\/?$/.exec(u.pathname);
      if (!m) return null;
      var name = m[1].toLowerCase();
      return RESERVED.has(name) ? null : name;
    } catch (e) { return null; }
  }

  // Best-effort comment text: the row's visible text minus the username itself.
  function textNear(a, username) {
    var row = a.closest('li') || a.parentElement;
    for (var i = 0; i < 3 && row && (row.innerText || '').trim().length < 2; i++) row = row.parentElement;
    if (!row) return null;
    var t = (row.innerText || '').replace(/\s+/g, ' ').trim();
    if (t.toLowerCase().indexOf(username) === 0) t = t.slice(username.length).trim();
    t = t.replace(/^[·•\-–—\s]+/, '').trim();
    return t ? t.slice(0, 500) : null;
  }

  /**
   * The display name shown beside the username. The export contains no display
   * names at all, and Instagram names DM thread folders after them, so this is
   * the only way to connect a conversation to the person it is with.
   */
  function nameNear(a, username) {
    var row = a.closest('li') || a.parentElement;
    for (var i = 0; i < 4 && row && (row.innerText || '').trim().length < 2; i++) row = row.parentElement;
    if (!row) return null;
    var lines = (row.innerText || '').split('\n').map(function (l) { return l.trim(); });
    for (var j = 0; j < lines.length; j++) {
      var line = lines[j];
      if (!line || line.length > 60) continue;
      var low = line.toLowerCase();
      if (low === username || CHROME.has(low)) continue;
      if (/^\d+$/.test(line)) continue;
      return line;
    }
    return null;
  }

  function scan() {
    // Prefer the open dialog so page chrome and suggestion rails are excluded.
    var scope = document.querySelector('[role="dialog"]') || document.body;
    var links = scope.querySelectorAll('a[href^="/"]');
    for (var i = 0; i < links.length; i++) {
      var a = links[i];
      var name = usernameFromHref(a.getAttribute('href'));
      if (!name) continue;
      var prev = found.get(name) || { name: null, text: null };
      var display = nameNear(a, name);
      var text = kind === 'post_comments' ? textNear(a, name) : null;
      found.set(name, {
        name: prev.name || display,
        text: prev.text || text,
      });
    }
    render();
  }

  var obs = new MutationObserver(scan);
  obs.observe(document.body, { childList: true, subtree: true });

  // ---- panel ----
  var box = document.createElement('div');
  box.setAttribute('style', [
    'position:fixed', 'right:16px', 'bottom:16px', 'z-index:2147483647',
    'background:#1a1a19', 'color:#fff', 'border:1px solid rgba(255,255,255,.18)',
    'border-radius:12px', 'padding:12px 14px', 'width:250px',
    'font:13px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif',
    'box-shadow:0 8px 32px rgba(0,0,0,.4)',
  ].join(';'));

  box.innerHTML =
    '<div style="font-weight:600;margin-bottom:2px">Instagram Tracker</div>' +
    '<div id="igt-n" style="font-size:22px;font-weight:600;letter-spacing:-.02em">0</div>' +
    '<div style="color:#c3c2b7;font-size:12px;margin-bottom:9px">usernames captured</div>' +
    '<div id="igt-names" style="color:#898781;font-size:11px;margin:-6px 0 9px">0 with display names</div>' +
    '<select id="igt-k" style="width:100%;margin-bottom:8px;padding:5px;border-radius:7px;' +
      'background:#0d0d0d;color:#fff;border:1px solid rgba(255,255,255,.2);font:inherit">' +
      '<option value="post_likes">Likes on my post</option>' +
      '<option value="post_comments">Comments on my post</option>' +
      '<option value="story_viewers">Story viewers</option>' +
      '<option value="profile_list">Followers / following list</option></select>' +
    '<div style="color:#898781;font-size:11px;margin-bottom:9px">' +
      'Scroll the list to the bottom yourself — this only watches, it never scrolls or ' +
      'loads anything.</div>' +
    '<button id="igt-save" style="width:100%;padding:7px;border-radius:7px;border:0;' +
      'background:#3987e5;color:#fff;font:inherit;font-weight:600;cursor:pointer">Save capture</button>' +
    '<button id="igt-close" style="width:100%;margin-top:5px;padding:5px;border-radius:7px;' +
      'border:0;background:transparent;color:#898781;font:inherit;cursor:pointer">close</button>';

  document.body.appendChild(box);
  var nEl = box.querySelector('#igt-n');
  var kEl = box.querySelector('#igt-k');
  kEl.value = kind;
  kEl.addEventListener('change', function () { kind = kEl.value; found.clear(); scan(); });

  var namesEl = box.querySelector('#igt-names');
  function render() {
    nEl.textContent = String(found.size);
    var withNames = 0;
    found.forEach(function (v) { if (v.name) withNames++; });
    namesEl.textContent = withNames + ' with display names';
  }

  box.querySelector('#igt-save').addEventListener('click', function () {
    var items = [];
    found.forEach(function (v, username) {
      items.push({ username: username, name: v.name, text: v.text });
    });
    var payload = {
      v: 1, kind: kind, permalink: location.href.split('?')[0],
      capturedAt: Math.floor(Date.now() / 1000), items: items,
    };
    var blob = new Blob([JSON.stringify(payload, null, 1)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'ig-capture-' + kind + '-' + payload.capturedAt + '.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
    nEl.textContent = found.size + ' ✓';
  });

  box.querySelector('#igt-close').addEventListener('click', function () {
    obs.disconnect(); box.remove(); delete window.__igTrackerCapture;
  });

  window.__igTrackerCapture = { show: function () { box.style.display = 'block'; }, found: found };
  scan();
})();
