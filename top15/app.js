/* FOUROBOROS full R1+R2 audition page logic. No dependencies.
   Audio: one shared <audio> element playing 320k MP3s (never WAVs).
   Verdicts: localStorage, latest explicit choice wins. */
(function () {
  'use strict';
  var STORE_KEY = 'fouroboros-full-audition-verdicts-v1';
  var SUGGESTED_FIRST = [
    'joint-afterhours-courier',
    'joint-underpass-mass',
    'joint-procession-of-giants',
  ];

  var DATA = null;
  var verdicts = {};   // id -> {verdict: 'KEEP'|'DROP'|'REWORK'|null, note: string, updated_at: string}
  var revealed = {};   // id -> true (provenance revealed in blind mode)
  var filters = { round: 'all', agent: 'all', sort: 'default', search: '',
                  showBlocked: true, verdict: 'all', blind: false };
  var queue = [];      // artifact ids in current view order
  var currentId = null;
  var audio = new Audio();
  audio.preload = 'none';

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmt(t) {
    if (!isFinite(t)) return '--:--';
    t = Math.floor(t);
    return Math.floor(t / 60) + ':' + ('0' + (t % 60)).slice(-2);
  }

  function loadVerdicts() {
    try { verdicts = JSON.parse(localStorage.getItem(STORE_KEY) || '{}') || {}; }
    catch (e) { verdicts = {}; }
  }
  function saveVerdicts() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(verdicts)); } catch (e) {}
  }
  function getV(id) { return verdicts[id] || { verdict: null, note: '' }; }

  function neutralId(a) { return 'Track ' + ('00' + (a.defaultOrder + 1)).slice(-3); }
  function displayTitle(a) { return filters.blind ? neutralId(a) : a.title; }

  function pairOf(id) {
    for (var i = 0; i < DATA.pairs.length; i++) {
      var p = DATA.pairs[i];
      if (p.members.indexOf(id) >= 0) {
        var other = p.members[0] === id ? p.members[1] : p.members[0];
        return { pair: p, other: other };
      }
    }
    return null;
  }
  function artById(id) {
    for (var i = 0; i < DATA.artifacts.length; i++) {
      if (DATA.artifacts[i].id === id) return DATA.artifacts[i];
    }
    return null;
  }

  function visibleArtifacts() {
    var list = DATA.artifacts.filter(function (a) {
      if (filters.round !== 'all' && String(a.round) !== filters.round) return false;
      if (filters.agent !== 'all' && a.author !== filters.agent) return false;
      if (filters.verdict !== 'all') {
        var v = getV(a.id).verdict;
        if (filters.verdict === 'undecided' && v) return false;
        if (filters.verdict !== 'undecided' && v !== filters.verdict) return false;
      }
      if (filters.search) {
        var hay = (a.title + ' ' + a.author + ' ' +
          a.rows.map(function (r) { return r.original_title; }).join(' ')).toLowerCase();
        if (hay.indexOf(filters.search.toLowerCase()) < 0) return false;
      }
      return true;
    });
    if (filters.sort === 'title') {
      list = list.slice().sort(function (x, y) {
        return x.title.localeCompare(y.title);
      });
    } else if (filters.sort === 'suggested') {
      var rank = {};
      SUGGESTED_FIRST.forEach(function (id, i) { rank[id] = i; });
      list = list.slice().sort(function (x, y) {
        var rx = (rank[x.id] === undefined ? 99 : rank[x.id]);
        var ry = (rank[y.id] === undefined ? 99 : rank[y.id]);
        return (rx - ry) || (x.defaultOrder - y.defaultOrder);
      });
    }
    return list; // default order = inventory order (defaultOrder ascending)
  }

  function sectionAt(a, t) {
    var secs = a.sections, cur = secs[0];
    for (var i = 0; i < secs.length; i++) {
      if (secs[i][2] <= t) cur = secs[i]; else break;
    }
    return { index: cur[0], slot: cur[1], total: secs.length };
  }

  function renderSummary() {
    var k = 0, d = 0, r = 0, undec = 0;
    DATA.artifacts.forEach(function (a) {
      var v = getV(a.id).verdict;
      if (v === 'KEEP') k++;
      else if (v === 'DROP') d++;
      else if (v === 'REWORK') r++;
      else undec++;
    });
    $('counts').innerHTML =
      '<span><b>' + k + '</b> KEEP</span>' +
      '<span><b>' + d + '</b> DROP</span>' +
      '<span><b>' + r + '</b> REWORK</span>' +
      '<span><b>' + undec + '</b> undecided</span>' +
      '<span><b>' + DATA.artifacts.length + '</b> playable tracks</span>' +
      '<span><b>' + DATA.blocked.length + '</b> blocked rows</span>';
  }

  function verdictButtons(id) {
    var v = getV(id).verdict;
    return ['KEEP', 'DROP', 'REWORK'].map(function (name) {
      return '<button data-action="verdict" data-id="' + esc(id) + '" data-verdict="' + name + '"' +
        (v === name ? ' class="active" aria-pressed="true"' : ' aria-pressed="false"') +
        '>' + name + '</button>';
    }).join('');
  }

  function provenanceHtml(a) {
    var rows = a.rows.map(function (r) {
      return '<li>Row ' + r.row_index + ' · Round ' + r.round + ' · ' + esc(r.author) +
        ' · “' + esc(r.original_title) + '”<br>Source: ' + esc(r.source_branch) + ' @ ' +
        esc(r.source_sha) + '<br>Path: ' + esc(r.source_path) + '</li>';
    }).join('');
    var choices = a.choices.length ? a.choices.map(function (c) {
      return '<li><b>' + esc(c.param) + ' = ' + esc(String(c.value)) + '</b> (' + esc(c.kind) +
        ') — ' + esc(c.reason || '') +
        (c.open_item ? ' <i>Open item: ' + esc(c.open_item) + '</i>' : '') + '</li>';
    }).join('') : '<li>None — all parameters authored.</li>';
    var played = a.played_sessions.length ? a.played_sessions.map(function (p) {
      return '<li><a href="' + esc(p.url) + '" target="_blank" rel="noopener">' + esc(p.label) +
        '</a> (GitHub blob page; repo is private, login required; audio plays on the page. ' +
        'A different performance of the same piece — not the canonical cycle render.)</li>';
    }).join('') : '<li>None.</li>';
    var cc = a.cross_check ? '<li>Cross-check: ' + esc(a.cross_check.status) +
      (a.cross_check.median_db !== undefined ? ' (median ' + a.cross_check.median_db +
      ' dB, max ' + a.cross_check.max_db + ' dB)' : '') + '</li>' : '';
    return '<details><summary>Provenance &amp; verification</summary>' +
      '<p><b>Source:</b> ' + esc(a.provenance_source || '') + '</p>' +
      '<p><b>Rows on this artifact:</b></p><ul>' + rows + '</ul>' +
      '<p><b>Verification:</b> ' + esc(a.verification_label) +
      ' · Coverage: ' + esc(a.coverage_status) + ' — ' + esc(a.coverage_detail || '') +
      ' · Engines (DUMP): ' + esc(JSON.stringify(a.dump_engines)) +
      ' · game+rng: ' + esc(a.game_rng) + ' · RMS: ' + esc(a.rms) + '</p>' +
      '<p><b>Config check lines:</b></p><pre>' + esc(a.config_lines.join('\n')) + '</pre>' +
      '<p><b>WAV SHA-256:</b> ' + esc(a.wav_sha256) + '<br><b>MP3 SHA-256:</b> ' +
      esc(a.mp3_sha256) + '</p>' +
      '<p><b>Audition choices (labeled choices, never authored values):</b></p><ul>' + choices + '</ul>' +
      '<p><b>Played sessions (supplementary):</b></p><ul>' + played + '</ul>' +
      (cc ? '<p><b>Cross-check:</b></p><ul>' + cc + '</ul>' : '') +
      '</details>';
  }

  function basisHtml(a) {
    if (!a.basis_notes.length) return '';
    return '<details><summary>Basis notes — what this render is (and is not)</summary><ul>' +
      a.basis_notes.map(function (b) { return '<li>' + esc(b) + '</li>'; }).join('') + '</ul></details>';
  }

  function priorHtml(a) {
    var priors = a.rows.filter(function (r) { return r.prior_judgment_note; });
    if (!priors.length) return '';
    return '<div class="note prior"><b>PRIOR judgment (from the lane record — NOT a verdict for this audition):</b><ul>' +
      priors.map(function (r) { return '<li>' + esc(r.prior_judgment_note) + '</li>'; }).join('') +
      '</ul></div>';
  }

  function cardHtml(a) {
    var v = getV(a.id);
    var pr = pairOf(a.id);
    var pairChip = '';
    if (pr) {
      var other = artById(pr.other);
      pairChip = '<span class="badge pair">Pair: ' + esc(pr.pair.title) +
        ' — this is the ' + (a.id.slice(-4) === 'row' ? 'row' : 'session') +
        ' version; partner: <a href="#card-' + esc(pr.other) + '" data-action="goto" data-id="' +
        esc(pr.other) + '">' + esc(other ? other.title : pr.other) + '</a></span>';
    }
    var blindHidden = filters.blind && !revealed[a.id];
    var meta = blindHidden
      ? '<button class="btn" data-action="reveal" data-id="' + esc(a.id) + '">Show provenance</button>'
      : '<div class="badges"><span class="badge">Round ' + a.round + '</span>' +
        '<span class="badge">' + esc(a.author) + (a.joint_lane ? ' (joint lane with Codex — see notes)' : '') + '</span>' +
        '<span class="badge">' + esc(a.kind) + '</span>' +
        '<span class="badge">' + fmt(a.duration_s) + '</span>' +
        '<span class="badge">' + a.rows.length + ' row' + (a.rows.length > 1 ? 's' : '') + '</span>' +
        (a.held ? '<span class="badge held">Cross-check note — see below</span>' : '') +
        pairChip + '</div>';
    return '<article class="card' + (currentId === a.id ? ' playing' : '') + '" id="card-' + esc(a.id) + '">' +
      '<h3>' + esc(displayTitle(a)) + '</h3>' + meta +
      (a.held ? '<div class="note">' + esc(a.held_note) + '</div>' : '') +
      '<div class="playrow">' +
      '<button class="playbtn" data-action="play" data-id="' + esc(a.id) + '">' +
      (currentId === a.id ? 'Now playing — restart' : 'Play') + '</button>' +
      '<a class="btn" href="' + esc(a.mp3) + '" target="_blank" rel="noopener">Direct MP3 link (fallback)</a>' +
      '</div>' +
      '<div class="verdicts">' + verdictButtons(a.id) + '</div>' +
      '<textarea class="notebox" data-action="note" data-id="' + esc(a.id) +
      '" placeholder="Note (saved with your verdict)">' + esc(v.note || '') + '</textarea>' +
      // In blind mode, prior judgments and basis notes can identify a piece,
      // so they stay hidden until this card's provenance is revealed.
      (blindHidden ? '' : priorHtml(a) + basisHtml(a) + provenanceHtml(a)) +
      '</article>';
  }

  function blockedHtml(b) {
    return '<article class="card blocked">' +
      '<h3>' + esc(b.original_title) + ' — BLOCKED</h3>' +
      '<div class="badges"><span class="badge">Round ' + b.round + '</span>' +
      '<span class="badge">' + esc(b.author) + '</span>' +
      '<span class="badge">' + esc(b.capability_class) + '</span></div>' +
      '<p><b>Missing dependency (exact):</b> ' + esc(b.reason) + '</p>' +
      '<details><summary>Source record</summary><p>Source: ' + esc(b.source_branch) + ' @ ' +
      esc(b.source_sha) + '<br>Path: ' + esc(b.source_path) + '</p><p>' +
      esc(b.notes) + '</p></details>' +
      '<p><i>No audio was invented for this row. It becomes audible only if a parameter-choice ' +
      'authorization supplies the missing parameters.</i></p></article>';
  }

  function renderList() {
    var list = visibleArtifacts();
    queue = list.map(function (a) { return a.id; });
    var html = list.map(cardHtml).join('');
    if (filters.showBlocked) {
      var blocked = DATA.blocked.filter(function (b) {
        if (filters.round !== 'all' && String(b.round) !== filters.round) return false;
        if (filters.agent !== 'all' && b.author !== filters.agent) return false;
        if (filters.search) {
          var hay = (b.original_title + ' ' + b.author).toLowerCase();
          if (hay.indexOf(filters.search.toLowerCase()) < 0) return false;
        }
        return true;
      });
      html += blocked.map(blockedHtml).join('');
    }
    $('list').innerHTML = html || '<p class="empty">Nothing matches these filters.</p>';
    $('showing').textContent = list.length + ' playable track' + (list.length === 1 ? '' : 's') +
      (filters.showBlocked ? ' + blocked rows shown' : ' (blocked rows hidden)');
    renderSummary();
  }

  function renderRowIndex() {
    var html = '<table><tr><th>#</th><th>Round</th><th>Author</th><th>Title</th><th>Status</th></tr>';
    DATA.row_index.forEach(function (r) {
      var status = r.disposition === 'BLOCKED'
        ? 'BLOCKED — no audio'
        : r.artifact_ids.map(function (id) {
            return '<a href="#card-' + esc(id) + '" data-action="goto" data-id="' + esc(id) + '">' + esc(id) + '</a>';
          }).join(', ');
      html += '<tr><td>' + r.row_index + '</td><td>' + r.round + '</td><td>' + esc(r.author) +
        '</td><td>' + esc(r.original_title) + '</td><td>' + status + '</td></tr>';
    });
    html += '</table>';
    $('rowindex').innerHTML = html;
  }

  function setNowPlaying() {
    var a = currentId ? artById(currentId) : null;
    $('nowtitle').textContent = a ? displayTitle(a) : 'Nothing playing';
    $('sectlabel').textContent = a ? 'Section — / ' + a.sections.length : '';
    $('elapsed').textContent = '0:00';
    $('total').textContent = a ? fmt(a.duration_s) : '--:--';
    $('sections').innerHTML = '';
    $('playpause').textContent = 'Play';
    $('playpause').disabled = !a;
    $('prevbtn').disabled = !a || queue.indexOf(currentId) <= 0;
    $('nextbtn').disabled = !a || queue.indexOf(currentId) >= queue.length - 1;
    document.querySelectorAll('.card.playing').forEach(function (el) {
      el.classList.remove('playing');
    });
    if (a) {
      var card = $('card-' + a.id);
      if (card) card.classList.add('playing');
    }
  }

  function playId(id) {
    var a = artById(id);
    if (!a) return;
    currentId = id;
    audio.src = a.mp3;
    audio.play().catch(function () {
      $('playererror').textContent =
        'Could not start playback here — use the Direct MP3 link on the card.';
    });
    setNowPlaying();
    renderListKeepScroll();
  }
  // Re-render the list without losing scroll position (for play-state highlight).
  function renderListKeepScroll() {
    var y = window.scrollY;
    renderList();
    window.scrollTo(0, y);
  }

  function playNext(dir) {
    var i = queue.indexOf(currentId);
    var j = i + dir;
    if (j >= 0 && j < queue.length) playId(queue[j]);
  }

  function updateProgress() {
    var a = currentId ? artById(currentId) : null;
    if (!a) return;
    var t = audio.currentTime || 0;
    $('elapsed').textContent = fmt(t);
    var dur = a.duration_s;
    $('seek').value = dur ? Math.round((t / dur) * 1000) : 0;
    var s = sectionAt(a, t);
    $('sectlabel').textContent = 'Section ' + (s.index + 1) + '/' + s.total +
      ' · chord slot ' + s.slot;
    var strip = $('sections');
    if (!strip.dataset.forId || strip.dataset.forId !== a.id) {
      strip.dataset.forId = a.id;
      var parts = [];
      for (var i = 0; i < a.sections.length; i++) {
        var start = a.sections[i][2];
        var end = (i + 1 < a.sections.length) ? a.sections[i + 1][2] : dur;
        var w = Math.max(1, ((end - start) / dur) * 100);
        parts.push('<div style="flex:' + w.toFixed(2) + '" title="Section ' + (i + 1) + '"></div>');
      }
      strip.innerHTML = parts.join('');
    }
    var kids = strip.children;
    for (var k = 0; k < kids.length; k++) {
      kids[k].className = (k === s.index) ? 'cur' : '';
    }
  }

  function exportJSON() {
    var out = {
      app: 'fouroboros-full-audition',
      exported_at: new Date().toISOString(),
      frozen_base: DATA.meta.frozen_base,
      verdicts: {},
    };
    Object.keys(verdicts).sort().forEach(function (id) {
      var a = artById(id);
      out.verdicts[id] = {
        title: a ? a.title : id,
        verdict: verdicts[id].verdict,
        note: verdicts[id].note || '',
        updated_at: verdicts[id].updated_at || '',
      };
    });
    download('fouroboros-audition-verdicts.json',
      JSON.stringify(out, null, 2), 'application/json');
  }
  function exportMD() {
    var groups = { KEEP: [], DROP: [], REWORK: [], undecided: [] };
    DATA.artifacts.forEach(function (a) {
      var v = getV(a.id);
      (groups[v.verdict || 'undecided']).push(a);
    });
    var md = '# FOUROBOROS full R1+R2 audition — verdicts\n\n';
    ['KEEP', 'DROP', 'REWORK', 'undecided'].forEach(function (g) {
      md += '## ' + g + ' (' + groups[g].length + ')\n\n';
      groups[g].forEach(function (a) {
        var v = getV(a.id);
        md += '- **' + a.title + '** (`' + a.id + '`)';
        if (v.note) md += ' — ' + v.note;
        md += '\n';
      });
      md += '\n';
    });
    download('fouroboros-audition-verdicts.md', md, 'text/markdown');
  }
  function download(name, text, type) {
    var blob = new Blob([text], { type: type });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  }

  function bind() {
    $('round').addEventListener('change', function (e) { filters.round = e.target.value; renderList(); });
    $('agent').addEventListener('change', function (e) { filters.agent = e.target.value; renderList(); });
    $('sort').addEventListener('change', function (e) { filters.sort = e.target.value; renderList(); });
    $('verdictfilter').addEventListener('change', function (e) { filters.verdict = e.target.value; renderList(); });
    $('search').addEventListener('input', function (e) { filters.search = e.target.value; renderList(); });
    $('showblocked').addEventListener('change', function (e) { filters.showBlocked = e.target.checked; renderList(); });
    $('blind').addEventListener('change', function (e) { filters.blind = e.target.checked; renderList(); });
    $('exportjson').addEventListener('click', exportJSON);
    $('exportmd').addEventListener('click', exportMD);
    $('playpause').addEventListener('click', function () {
      if (!currentId) { if (queue.length) playId(queue[0]); return; }
      if (audio.paused) { audio.play().catch(function () {}); }
      else audio.pause();
    });
    $('restart').addEventListener('click', function () {
      if (!currentId) return;
      audio.currentTime = 0;
      audio.play().catch(function () {});
    });
    $('prevbtn').addEventListener('click', function () { playNext(-1); });
    $('nextbtn').addEventListener('click', function () { playNext(1); });
    $('seek').addEventListener('input', function (e) {
      var a = currentId ? artById(currentId) : null;
      if (a && a.duration_s) audio.currentTime = (e.target.value / 1000) * a.duration_s;
    });
    audio.addEventListener('timeupdate', updateProgress);
    audio.addEventListener('play', function () { $('playpause').textContent = 'Pause'; });
    audio.addEventListener('pause', function () { $('playpause').textContent = 'Play'; });
    audio.addEventListener('ended', function () { playNext(1); });
    audio.addEventListener('error', function () {
      $('playererror').textContent =
        'Audio failed to load — use the Direct MP3 link on the card.';
    });
    document.addEventListener('click', function (e) {
      var t = e.target.closest('[data-action]');
      if (!t) return;
      var action = t.getAttribute('data-action');
      var id = t.getAttribute('data-id');
      if (action === 'play') { e.preventDefault(); playId(id); }
      else if (action === 'verdict') {
        var cur = getV(id).verdict;
        var next = (cur === t.getAttribute('data-verdict')) ? null : t.getAttribute('data-verdict');
        verdicts[id] = verdicts[id] || { verdict: null, note: '' };
        verdicts[id].verdict = next;
        verdicts[id].updated_at = new Date().toISOString();
        saveVerdicts();
        renderListKeepScroll();
      }
      else if (action === 'reveal') { revealed[id] = true; renderListKeepScroll(); }
      else if (action === 'goto') {
        e.preventDefault();
        // Ensure the target card is rendered: reset filters, then scroll.
        filters.round = 'all'; filters.agent = 'all'; filters.search = '';
        filters.verdict = 'all';
        $('round').value = 'all'; $('agent').value = 'all'; $('search').value = '';
        $('verdictfilter').value = 'all';
        renderList();
        var card = $('card-' + id);
        if (card) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
    document.addEventListener('input', function (e) {
      var t = e.target.closest('[data-action="note"]');
      if (!t) return;
      var id = t.getAttribute('data-id');
      verdicts[id] = verdicts[id] || { verdict: null, note: '' };
      verdicts[id].note = t.value;
      verdicts[id].updated_at = new Date().toISOString();
      saveVerdicts();
    });
  }

  function init(data) {
    DATA = data;
    DATA.artifacts.forEach(function (a, i) { a.defaultOrder = i; });
    loadVerdicts();
    bind();
    renderRowIndex();
    renderList();
    setNowPlaying();
  }

  var raw = document.getElementById('audition-data');
  if (raw && raw.textContent.trim()) {
    try { init(JSON.parse(raw.textContent)); }
    catch (e) {
      document.getElementById('list').innerHTML =
        '<p class="empty">Failed to parse embedded audition data: ' + esc(e.message) + '</p>';
    }
  } else {
    fetch('data.json').then(function (r) { return r.json(); }).then(init).catch(function (e) {
      document.getElementById('list').innerHTML =
        '<p class="empty">Failed to load data.json: ' + esc(e.message) +
        '. Open this page from the full-audition directory (page/ next to renders/).</p>';
    });
  }
})();
