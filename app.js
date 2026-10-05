/* ==========================================================================
   MUSICIA — app.js
   A frontend-only music streaming app. No backend, no database.
   Everything (metadata, favorites, playlists, theme) is saved in
   localStorage. Audio itself is kept in memory for the session, and
   also saved as a data URL in localStorage when it's small enough.
   ========================================================================== */

/* --------------------------------------------------------------------------
   1. STORAGE KEYS + SMALL HELPERS
   -------------------------------------------------------------------------- */
const STORAGE_KEYS = {
  songs: 'musicia_songs',
  favorites: 'musicia_favorites',
  playlists: 'musicia_playlists',
  recent: 'musicia_recent',
  theme: 'musicia_theme',
  volume: 'musicia_volume',
};

// Read JSON from localStorage safely, falling back to a default value.
function loadJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (err) {
    console.warn('Could not read', key, err);
    return fallback;
  }
}

// Save JSON to localStorage. If storage is full (audio data URLs can be
// big), fail quietly instead of crashing the app.
function saveJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (err) {
    console.warn('Could not save', key, err);
    return false;
  }
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function formatTime(seconds) {
  if (!isFinite(seconds) || seconds < 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

// Roughly how many characters a data URL can be before we skip saving it
// to localStorage permanently (localStorage is usually ~5-10MB total).
const MAX_PERSIST_LENGTH = 3000000;

/* --------------------------------------------------------------------------
   2. STATE
   -------------------------------------------------------------------------- */
const GENRES = ['Afrobeat', 'Hip-Hop', 'Pop', 'R&B', 'Rock', 'Jazz', 'Electronic', 'Reggae', 'Ethiopian', 'Amharic'];

let songs = loadJSON(STORAGE_KEYS.songs, []);           // metadata (+ maybe persisted audio dataURL)
let favorites = loadJSON(STORAGE_KEYS.favorites, []);   // array of song ids
let playlists = loadJSON(STORAGE_KEYS.playlists, []);   // [{id, name, songIds:[]}]
let recentlyPlayed = loadJSON(STORAGE_KEYS.recent, []); // array of song ids, most recent first

// Songs uploaded this session that used an in-memory object URL (too big
// to persist) need their audio re-attached; we track that here.
const sessionAudioUrls = {}; // songId -> objectURL, populated on upload

let currentQueue = [];   // array of song ids, the "now playing" queue
let currentIndex = -1;   // index into currentQueue
let isShuffle = false;
let repeatMode = 'off';  // 'off' | 'all' | 'one'
let genericView = { mode: 'genres', filterValue: null }; // drives the generic section
let pendingAddToPlaylistSongId = null;

function persistSongs() { saveJSON(STORAGE_KEYS.songs, songs); }
function persistFavorites() { saveJSON(STORAGE_KEYS.favorites, favorites); }
function persistPlaylists() { saveJSON(STORAGE_KEYS.playlists, playlists); }
function persistRecent() { saveJSON(STORAGE_KEYS.recent, recentlyPlayed); }

function getSongById(id) { return songs.find(s => s.id === id); }

// Resolve a playable URL for a song: prefer the persisted data URL,
// fall back to this session's object URL.
function getPlayableSrc(song) {
  if (!song) return null;
  if (song.audioDataUrl) return song.audioDataUrl;
  if (sessionAudioUrls[song.id]) return sessionAudioUrls[song.id];
  return null;
}

/* --------------------------------------------------------------------------
   3. DOM REFERENCES
   -------------------------------------------------------------------------- */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const audioEl = $('#audioEl');
const sidebar = $('#sidebar');
const sidebarOverlay = $('#sidebarOverlay');

const playerArt = $('#playerArt');
const playerTitle = $('#playerTitle');
const playerArtist = $('#playerArtist');
const playerFavBtn = $('#playerFavBtn');
const playPauseBtn = $('#playPauseBtn');
const progressBar = $('#progressBar');
const volumeBar = $('#volumeBar');
const currentTimeLabel = $('#currentTimeLabel');
const durationLabel = $('#durationLabel');
const shuffleBtn = $('#shuffleBtn');
const repeatBtn = $('#repeatBtn');
const muteBtn = $('#muteBtn');

const toastContainer = $('#toastContainer');

/* --------------------------------------------------------------------------
   4. TOASTS
   -------------------------------------------------------------------------- */
function showToast(message) {
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  toastContainer.appendChild(toast);
  setTimeout(() => {
    toast.classList.add('hide');
    setTimeout(() => toast.remove(), 250);
  }, 2600);
}

/* --------------------------------------------------------------------------
   5. THEME (DARK MODE)
   -------------------------------------------------------------------------- */
function applyTheme(theme) {
  document.body.classList.toggle('dark', theme === 'dark');
  const icon = theme === 'dark' ? 'fa-sun' : 'fa-moon';
  $('#themeBtn').innerHTML = `<i class="fa-solid ${icon}"></i>`;
  $('#mobileThemeBtn').innerHTML = `<i class="fa-solid ${icon}"></i>`;
}
function toggleTheme() {
  const next = document.body.classList.contains('dark') ? 'light' : 'dark';
  applyTheme(next);
  saveJSON(STORAGE_KEYS.theme, next);
}
applyTheme(loadJSON(STORAGE_KEYS.theme, 'light'));
$('#themeBtn').addEventListener('click', toggleTheme);
$('#mobileThemeBtn').addEventListener('click', toggleTheme);

/* --------------------------------------------------------------------------
   6. SIDEBAR (MOBILE)
   -------------------------------------------------------------------------- */
function openSidebar() {
  sidebar.classList.add('open');
  sidebarOverlay.classList.add('show');
}
function closeSidebar() {
  sidebar.classList.remove('open');
  sidebarOverlay.classList.remove('show');
}
$('#hamburgerBtn').addEventListener('click', openSidebar);
$('#closeSidebarBtn').addEventListener('click', closeSidebar);
sidebarOverlay.addEventListener('click', closeSidebar);

/* --------------------------------------------------------------------------
   7. NAVIGATION / VIEW SWITCHING
   -------------------------------------------------------------------------- */
function setActiveView(viewId) {
  $$('.view').forEach(v => v.classList.remove('active'));
  $(`#${viewId}`).classList.add('active');
}

function setActiveNav(view) {
  $$('.nav-item[data-view]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.view === view);
  });
}

function goToView(view, opts = {}) {
  $('#searchInput').value = '';
  closeSidebar();

  if (view === 'explore') {
    setActiveView('view-explore');
    setActiveNav('explore');
    renderExplore();
    return;
  }

  setActiveNav(view === 'playlist' ? null : view);
  setActiveView('view-generic');

  switch (view) {
    case 'genres': genericView = { mode: 'genres', filterValue: null }; break;
    case 'artists': genericView = { mode: 'artists', filterValue: null }; break;
    case 'albums': genericView = { mode: 'albums', filterValue: null }; break;
    case 'radio': genericView = { mode: 'radio', filterValue: null }; break;
    case 'recent': genericView = { mode: 'recent', filterValue: null }; break;
    case 'favorites': genericView = { mode: 'favorites', filterValue: null }; break;
    case 'local': genericView = { mode: 'local', filterValue: null }; break;
    case 'genre-songs': genericView = { mode: 'genre-songs', filterValue: opts.value }; break;
    case 'artist-songs': genericView = { mode: 'artist-songs', filterValue: opts.value }; break;
    case 'album-songs': genericView = { mode: 'album-songs', filterValue: opts.value }; break;
    case 'playlist': genericView = { mode: 'playlist', filterValue: opts.value }; break;
  }
  renderGenericView();
}

$$('.nav-item[data-view]').forEach(btn => {
  btn.addEventListener('click', () => goToView(btn.dataset.view));
});
$$('[data-view-link]').forEach(btn => {
  btn.addEventListener('click', () => goToView(btn.dataset.viewLink));
});
$('#genericBackBtn').addEventListener('click', () => {
  const backTargets = { 'genre-songs': 'genres', 'artist-songs': 'artists', 'album-songs': 'albums' };
  const target = backTargets[genericView.mode];
  if (target) goToView(target);
});

/* --------------------------------------------------------------------------
   8. SONG CARD RENDERING
   -------------------------------------------------------------------------- */
function artworkInner(song) {
  if (song && song.cover) return `<img src="${song.cover}" alt="${escapeHtml(song.title)} cover" />`;
  return `<i class="fa-solid fa-music"></i>`;
}

function escapeHtml(str = '') {
  return str.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// Build a song card. `layout` is 'grid' (default cards) or 'list' (rows
// used for Local Files / playlists / favorites / recent).
function songCardHTML(song, layout = 'grid') {
  const isFav = favorites.includes(song.id);
  const isPlaying = currentQueue[currentIndex] === song.id && !audioEl.paused;
  const rowClass = layout === 'list' ? ' list-row' : '';
  const playingClass = (currentQueue[currentIndex] === song.id) ? ' playing' : '';
  return `
    <div class="song-card${rowClass}${playingClass}" data-song-id="${song.id}">
      <div class="song-card-art">
        ${artworkInner(song)}
        ${layout === 'grid' ? `<button class="card-play-btn" data-action="play" aria-label="Play"><i class="fa-solid ${isPlaying ? 'fa-pause' : 'fa-play'}"></i></button>` : ''}
      </div>
      <div class="song-card-body">
        <p class="song-card-title">${escapeHtml(song.title)}</p>
        <p class="song-card-artist">${escapeHtml(song.artist)}</p>
        <div class="song-card-actions">
          ${layout === 'list' ? `<button class="card-play-btn" data-action="play" aria-label="Play"><i class="fa-solid ${isPlaying ? 'fa-pause' : 'fa-play'}"></i></button>` : ''}
          <button class="mini-btn ${isFav ? 'fav-active' : ''}" data-action="fav" aria-label="Favorite"><i class="fa-${isFav ? 'solid' : 'regular'} fa-heart"></i></button>
          <button class="mini-btn" data-action="add-playlist" aria-label="Add to playlist"><i class="fa-solid fa-plus"></i></button>
          ${layout === 'list' && genericView.mode === 'local' ? `<button class="mini-btn" data-action="delete" aria-label="Delete"><i class="fa-solid fa-trash"></i></button>` : ''}
          ${layout === 'list' && genericView.mode === 'playlist' ? `<button class="mini-btn" data-action="remove-from-playlist" aria-label="Remove from playlist"><i class="fa-solid fa-xmark"></i></button>` : ''}
        </div>
      </div>
    </div>`;
}

// Attach one shared click handler to a container of song cards.
function wireSongCardActions(container, songList) {
  container.addEventListener('click', (e) => {
    const actionBtn = e.target.closest('[data-action]');
    const card = e.target.closest('.song-card');
    if (!card) return;
    const songId = card.dataset.songId;
    const action = actionBtn ? actionBtn.dataset.action : 'play';

    if (action === 'play') {
      playFromList(songList.map(s => s.id), songId);
    } else if (action === 'fav') {
      toggleFavorite(songId);
    } else if (action === 'add-playlist') {
      openAddToPlaylistModal(songId);
    } else if (action === 'delete') {
      deleteSong(songId);
    } else if (action === 'remove-from-playlist') {
      removeSongFromPlaylist(genericView.filterValue, songId);
    }
  });
}

/* --------------------------------------------------------------------------
   9. EXPLORE VIEW (hero + weekly tracks + genre/artist previews)
   -------------------------------------------------------------------------- */
function renderExplore() {
  // Hero: feature the most recently added song, else static placeholder copy.
  const heroSong = songs[songs.length - 1];
  const heroArt = $('#heroArt');
  if (heroSong) {
    $('#heroTitle').textContent = heroSong.title;
    $('#heroArtist').textContent = heroSong.artist;
    heroArt.innerHTML = heroSong.cover ? `<img src="${heroSong.cover}" alt="${escapeHtml(heroSong.title)} cover" style="width:100%;height:100%;object-fit:cover;border-radius:50%;" />` : `<i class="fa-solid fa-compact-disc"></i>`;
  } else {
    $('#heroTitle').textContent = 'Love The Way You Lie';
    $('#heroArtist').textContent = 'Eminem ft. Rihanna';
    heroArt.innerHTML = `<i class="fa-solid fa-compact-disc"></i>`;
  }
  const favBtn = $('#heroFavBtn');
  const heroIsFav = heroSong && favorites.includes(heroSong.id);
  favBtn.classList.toggle('active', !!heroIsFav);
  favBtn.innerHTML = `<i class="fa-${heroIsFav ? 'solid' : 'regular'} fa-heart"></i>`;

  // Top tracks row: most recently uploaded songs.
  const topTracksRow = $('#topTracksRow');
  const topTracks = [...songs].reverse().slice(0, 10);
  topTracksRow.innerHTML = topTracks.map(s => songCardHTML(s, 'grid')).join('') ||
    `<p class="empty-state small" style="width:100%;">Upload a song to see it featured here.</p>`;
  wireSongCardActions(topTracksRow, topTracks);

  // Genre preview
  const genreRow = $('#genrePreviewRow');
  genreRow.innerHTML = GENRES.slice(0, 6).map(g => `<button class="genre-chip" data-genre="${g}">${g}<br><small style="font-weight:400;color:var(--muted);">${songs.filter(s => s.genre === g).length} songs</small></button>`).join('');
  genreRow.querySelectorAll('.genre-chip').forEach(btn => {
    btn.addEventListener('click', () => goToView('genre-songs', { value: btn.dataset.genre }));
  });

  // Artist preview
  const artistRow = $('#artistPreviewRow');
  const artistNames = [...new Set(songs.map(s => s.artist))].slice(0, 8);
  artistRow.innerHTML = artistNames.length ? artistNames.map(a => artistCardHTML(a)).join('') :
    `<p class="empty-state small" style="width:100%;">No artists yet — upload some music!</p>`;
  artistRow.querySelectorAll('.artist-card').forEach(card => {
    card.addEventListener('click', () => goToView('artist-songs', { value: card.dataset.artist }));
  });
}

function artistCardHTML(name) {
  const initials = name.split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase();
  return `<div class="artist-card" data-artist="${escapeHtml(name)}">
    <div class="artist-avatar">${initials || '?'}</div>
    <p class="artist-name">${escapeHtml(name)}</p>
  </div>`;
}

$('#heroPlayBtn').addEventListener('click', () => {
  const heroSong = songs[songs.length - 1];
  if (!heroSong) {
    showToast('Upload your first song to start listening 🎧');
    openUploadModal();
    return;
  }
  playFromList(songs.map(s => s.id), heroSong.id);
});
$('#heroFavBtn').addEventListener('click', () => {
  const heroSong = songs[songs.length - 1];
  if (heroSong) toggleFavorite(heroSong.id);
});

/* --------------------------------------------------------------------------
   10. GENERIC VIEW (genres/artists/albums lists + song listings)
   -------------------------------------------------------------------------- */
function renderGenericView() {
  const title = $('#genericTitle');
  const subtitle = $('#genericSubtitle');
  const grid = $('#genericGrid');
  const empty = $('#genericEmptyState');
  const backBtn = $('#genericBackBtn');
  const actions = $('#genericActions');
  actions.innerHTML = '';
  backBtn.hidden = !['genre-songs', 'artist-songs', 'album-songs'].includes(genericView.mode);
  grid.className = 'song-grid';

  const mode = genericView.mode;

  if (mode === 'genres') {
    title.textContent = 'Genres';
    subtitle.textContent = 'Browse your library by genre';
    grid.className = 'genre-row';
    grid.innerHTML = GENRES.map(g => `<button class="genre-chip" data-genre="${g}">${g}<br><small style="font-weight:400;color:var(--muted);">${songs.filter(s => s.genre === g).length} songs</small></button>`).join('');
    grid.querySelectorAll('.genre-chip').forEach(btn => btn.addEventListener('click', () => goToView('genre-songs', { value: btn.dataset.genre })));
    empty.hidden = true;
    return;
  }

  if (mode === 'artists') {
    title.textContent = 'Artists';
    subtitle.textContent = 'Everyone in your library';
    const artistNames = [...new Set(songs.map(s => s.artist))];
    grid.className = 'artist-row';
    grid.style.flexWrap = 'wrap';
    grid.innerHTML = artistNames.map(a => artistCardHTML(a)).join('');
    grid.querySelectorAll('.artist-card').forEach(card => card.addEventListener('click', () => goToView('artist-songs', { value: card.dataset.artist })));
    empty.hidden = artistNames.length > 0;
    if (!artistNames.length) { empty.innerHTML = emptyStateHTML('fa-microphone', 'No artists yet', 'Upload music to see artists here.'); }
    return;
  }

  if (mode === 'albums') {
    title.textContent = 'Albums';
    subtitle.textContent = 'Grouped by album';
    const albumNames = [...new Set(songs.filter(s => s.album).map(s => s.album))];
    grid.innerHTML = albumNames.map(al => {
      const track = songs.find(s => s.album === al);
      const count = songs.filter(s => s.album === al).length;
      return `<div class="song-card" data-album="${escapeHtml(al)}">
        <div class="song-card-art">${artworkInner(track)}</div>
        <div class="song-card-body">
          <p class="song-card-title">${escapeHtml(al)}</p>
          <p class="song-card-artist">${escapeHtml(track.artist)} · ${count} track${count > 1 ? 's' : ''}</p>
        </div>
      </div>`;
    }).join('');
    grid.querySelectorAll('.song-card').forEach(card => card.addEventListener('click', () => goToView('album-songs', { value: card.dataset.album })));
    empty.hidden = albumNames.length > 0;
    if (!albumNames.length) { empty.innerHTML = emptyStateHTML('fa-record-vinyl', 'No albums yet', 'Upload music with an album name to see it here.'); }
    return;
  }

  // From here on we're rendering an actual list of songs.
  let list = [];
  if (mode === 'genre-songs') { title.textContent = genericView.filterValue; subtitle.textContent = 'Genre'; list = songs.filter(s => s.genre === genericView.filterValue); }
  else if (mode === 'artist-songs') { title.textContent = genericView.filterValue; subtitle.textContent = 'Artist'; list = songs.filter(s => s.artist === genericView.filterValue); }
  else if (mode === 'album-songs') { title.textContent = genericView.filterValue; subtitle.textContent = 'Album'; list = songs.filter(s => s.album === genericView.filterValue); }
  else if (mode === 'recent') { title.textContent = 'Recently Played'; subtitle.textContent = 'Your listening history'; list = recentlyPlayed.map(id => getSongById(id)).filter(Boolean); }
  else if (mode === 'favorites') { title.textContent = 'Favorite Songs'; subtitle.textContent = 'Songs you love'; list = favorites.map(id => getSongById(id)).filter(Boolean); }
  else if (mode === 'local') { title.textContent = 'Local Files'; subtitle.textContent = 'Music uploaded from your device'; list = songs; }
  else if (mode === 'radio') { title.textContent = 'Radio'; subtitle.textContent = 'A shuffled mix of your whole library'; list = songs; }
  else if (mode === 'playlist') {
    const pl = playlists.find(p => p.id === genericView.filterValue);
    title.textContent = pl ? pl.name : 'Playlist';
    subtitle.textContent = pl ? `${pl.songIds.length} song${pl.songIds.length === 1 ? '' : 's'}` : '';
    list = pl ? pl.songIds.map(id => getSongById(id)).filter(Boolean) : [];
  }

  if (mode === 'local') {
    actions.innerHTML = `<button class="btn-pink" id="genericUploadBtn"><i class="fa-solid fa-cloud-arrow-up"></i> Upload Music</button>`;
    $('#genericUploadBtn').addEventListener('click', openUploadModal);
  }
  if (mode === 'radio' && list.length) {
    actions.innerHTML = `<button class="btn-pink" id="startRadioBtn"><i class="fa-solid fa-tower-broadcast"></i> Start Radio</button>`;
    $('#startRadioBtn').addEventListener('click', () => startRadio());
  }
  if (mode === 'playlist' && list.length) {
    actions.innerHTML = `
      <button class="btn-pink" id="playPlaylistBtn"><i class="fa-solid fa-play"></i> Play Playlist</button>
      <button class="icon-btn" id="deletePlaylistBtn" aria-label="Delete playlist"><i class="fa-solid fa-trash"></i></button>`;
    $('#playPlaylistBtn').addEventListener('click', () => playFromList(list.map(s => s.id), list[0].id));
    $('#deletePlaylistBtn').addEventListener('click', () => deletePlaylist(genericView.filterValue));
  }

  grid.innerHTML = list.map(s => songCardHTML(s, 'list')).join('');
  wireSongCardActions(grid, list);

  empty.hidden = list.length > 0;
  if (!list.length) {
    const emptyCopy = {
      'genre-songs': ['fa-layer-group', 'No songs in this genre', 'Upload a song and tag it with this genre.'],
      'artist-songs': ['fa-microphone', 'No songs from this artist', ''],
      'album-songs': ['fa-record-vinyl', 'No songs in this album', ''],
      recent: ['fa-clock-rotate-left', 'Nothing played yet', 'Songs you play will show up here.'],
      favorites: ['fa-heart', 'No favorite songs yet ❤️', 'Start adding songs you love.'],
      local: ['fa-folder-open', 'Your music library is empty', 'Upload your first song.'],
      radio: ['fa-tower-broadcast', 'Nothing to play yet', 'Upload some music to start a radio mix.'],
      playlist: ['fa-list-music', 'This playlist is empty', 'Add songs from anywhere using the + button.'],
    }[mode] || ['fa-circle-info', 'Nothing here yet', ''];
    empty.innerHTML = emptyStateHTML(...emptyCopy);
  }
}

function emptyStateHTML(icon, title, subtitle) {
  return `<i class="fa-solid ${icon}"></i><strong>${title}</strong><span>${subtitle}</span>`;
}

function startRadio() {
  const shuffled = [...songs.map(s => s.id)].sort(() => Math.random() - 0.5);
  isShuffle = true;
  shuffleBtn.classList.add('active-state');
  playFromList(shuffled, shuffled[0], true);
  showToast('🎧 Radio started — playing a shuffled mix');
}

/* --------------------------------------------------------------------------
   11. SEARCH
   -------------------------------------------------------------------------- */
const searchInput = $('#searchInput');
searchInput.addEventListener('input', () => {
  const q = searchInput.value.trim().toLowerCase();
  if (!q) {
    // Empty search: go back to whatever the active nav view was (default explore)
    setActiveView('view-explore');
    setActiveNav('explore');
    return;
  }
  const results = songs.filter(s =>
    s.title.toLowerCase().includes(q) ||
    s.artist.toLowerCase().includes(q) ||
    (s.album || '').toLowerCase().includes(q) ||
    (s.genre || '').toLowerCase().includes(q)
  );
  setActiveView('view-search');
  setActiveNav(null);
  const grid = $('#searchResultsGrid');
  grid.innerHTML = results.map(s => songCardHTML(s, 'list')).join('');
  wireSongCardActions(grid, results);
  $('#searchEmptyState').hidden = results.length > 0;
});

/* --------------------------------------------------------------------------
   12. PLAYBACK ENGINE
   -------------------------------------------------------------------------- */
function playFromList(idList, startId, forceShuffleAlreadySet = false) {
  currentQueue = [...idList];
  currentIndex = currentQueue.indexOf(startId);
  if (currentIndex === -1) currentIndex = 0;
  loadAndPlayCurrent();
}

function loadAndPlayCurrent() {
  const songId = currentQueue[currentIndex];
  const song = getSongById(songId);
  if (!song) return;
  const src = getPlayableSrc(song);
  if (!src) {
    showToast('This song\u2019s audio isn\u2019t available in this session. Please re-upload it.');
    return;
  }
  audioEl.src = src;
  audioEl.play().catch(() => {});
  updatePlayerUI(song);
  addToRecentlyPlayed(song.id);
  renderQueuePanel();
  refreshVisibleSongCards();
}

function updatePlayerUI(song) {
  playerTitle.textContent = song.title;
  playerArtist.textContent = song.artist;
  playerArt.innerHTML = artworkInner(song);
  const isFav = favorites.includes(song.id);
  playerFavBtn.classList.toggle('active', isFav);
  playerFavBtn.innerHTML = `<i class="fa-${isFav ? 'solid' : 'regular'} fa-heart"></i>`;
}

function refreshVisibleSongCards() {
  // Cheap re-render of whatever's currently on screen so play/pause icons
  // and the "playing" highlight stay in sync.
  if ($('#view-explore').classList.contains('active')) renderExplore();
  if ($('#view-generic').classList.contains('active')) renderGenericView();
  if ($('#view-search').classList.contains('active')) searchInput.dispatchEvent(new Event('input'));
}

function setPlayIcon(playing) {
  playPauseBtn.innerHTML = `<i class="fa-solid ${playing ? 'fa-pause' : 'fa-play'}"></i>`;
  playerArt.classList.toggle('spinning', playing);
  $('#heroArt').classList.toggle('spinning', playing);
}

audioEl.addEventListener('play', () => { setPlayIcon(true); refreshVisibleSongCards(); });
audioEl.addEventListener('pause', () => { setPlayIcon(false); refreshVisibleSongCards(); });

audioEl.addEventListener('timeupdate', () => {
  if (!audioEl.duration) return;
  const pct = (audioEl.currentTime / audioEl.duration) * 100;
  progressBar.value = pct;
  progressBar.style.setProperty('--fill', pct + '%');
  currentTimeLabel.textContent = formatTime(audioEl.currentTime);
});
audioEl.addEventListener('loadedmetadata', () => {
  durationLabel.textContent = formatTime(audioEl.duration);
});
audioEl.addEventListener('ended', () => {
  if (repeatMode === 'one') {
    audioEl.currentTime = 0;
    audioEl.play();
    return;
  }
  goToNext(true);
});

function togglePlayPause() {
  if (!currentQueue.length) {
    showToast('Choose a song first 🎵');
    return;
  }
  if (audioEl.paused) audioEl.play().catch(() => {});
  else audioEl.pause();
}
playPauseBtn.addEventListener('click', togglePlayPause);

function goToNext(isAutoAdvance = false) {
  if (!currentQueue.length) return;
  if (isShuffle) {
    currentIndex = Math.floor(Math.random() * currentQueue.length);
  } else {
    currentIndex++;
    if (currentIndex >= currentQueue.length) {
      if (repeatMode === 'all') currentIndex = 0;
      else { currentIndex = currentQueue.length - 1; setPlayIcon(false); return; }
    }
  }
  loadAndPlayCurrent();
}
function goToPrev() {
  if (!currentQueue.length) return;
  if (audioEl.currentTime > 3) { audioEl.currentTime = 0; return; }
  currentIndex--;
  if (currentIndex < 0) currentIndex = isShuffle ? Math.floor(Math.random() * currentQueue.length) : 0;
  loadAndPlayCurrent();
}
$('#nextBtn').addEventListener('click', () => goToNext());
$('#prevBtn').addEventListener('click', goToPrev);

shuffleBtn.addEventListener('click', () => {
  isShuffle = !isShuffle;
  shuffleBtn.classList.toggle('active-state', isShuffle);
  showToast(isShuffle ? '🔀 Shuffle on' : 'Shuffle off');
});
repeatBtn.addEventListener('click', () => {
  const order = ['off', 'all', 'one'];
  repeatMode = order[(order.indexOf(repeatMode) + 1) % order.length];
  repeatBtn.classList.toggle('active-state', repeatMode !== 'off');
  repeatBtn.innerHTML = `<i class="fa-solid ${repeatMode === 'one' ? 'fa-1' : 'fa-repeat'}"></i>`;
  const labels = { off: 'Repeat off', all: '🔁 Repeat all', one: '🔂 Repeat one' };
  showToast(labels[repeatMode]);
});

progressBar.addEventListener('input', () => {
  if (audioEl.duration) audioEl.currentTime = (progressBar.value / 100) * audioEl.duration;
});

let lastVolume = 80;
volumeBar.addEventListener('input', () => {
  audioEl.volume = volumeBar.value / 100;
  volumeBar.style.setProperty('--fill', volumeBar.value + '%');
  audioEl.muted = false;
  muteBtn.innerHTML = `<i class="fa-solid ${volumeBar.value == 0 ? 'fa-volume-xmark' : 'fa-volume-high'}"></i>`;
  saveJSON(STORAGE_KEYS.volume, volumeBar.value);
});
muteBtn.addEventListener('click', () => {
  audioEl.muted = !audioEl.muted;
  muteBtn.innerHTML = `<i class="fa-solid ${audioEl.muted ? 'fa-volume-xmark' : 'fa-volume-high'}"></i>`;
});

// Restore saved volume
(function initVolume() {
  const savedVol = loadJSON(STORAGE_KEYS.volume, 80);
  volumeBar.value = savedVol;
  audioEl.volume = savedVol / 100;
  volumeBar.style.setProperty('--fill', savedVol + '%');
})();

playerFavBtn.addEventListener('click', () => {
  const songId = currentQueue[currentIndex];
  if (songId) toggleFavorite(songId);
});

/* --------------------------------------------------------------------------
   13. QUEUE PANEL
   -------------------------------------------------------------------------- */
const queuePanel = $('#queuePanel');
$('#queueBtn').addEventListener('click', () => { queuePanel.classList.toggle('open'); renderQueuePanel(); });
$('#closeQueueBtn').addEventListener('click', () => queuePanel.classList.remove('open'));

function renderQueuePanel() {
  const list = $('#queueList');
  if (!currentQueue.length) {
    list.innerHTML = `<p class="empty-state small">Nothing queued yet.</p>`;
    return;
  }
  list.innerHTML = currentQueue.map((id, i) => {
    const s = getSongById(id);
    if (!s) return '';
    return `<div class="queue-item ${i === currentIndex ? 'playing' : ''}" data-index="${i}">
      <div class="queue-item-art">${artworkInner(s)}</div>
      <div class="queue-item-meta">
        <p class="queue-item-title">${escapeHtml(s.title)}</p>
        <p class="queue-item-artist">${escapeHtml(s.artist)}</p>
      </div>
    </div>`;
  }).join('');
  list.querySelectorAll('.queue-item').forEach(item => {
    item.addEventListener('click', () => {
      currentIndex = Number(item.dataset.index);
      loadAndPlayCurrent();
    });
  });
}

/* --------------------------------------------------------------------------
   14. FAVORITES
   -------------------------------------------------------------------------- */
function toggleFavorite(songId) {
  const idx = favorites.indexOf(songId);
  if (idx === -1) {
    favorites.push(songId);
    showToast('❤️ Added to favorites');
  } else {
    favorites.splice(idx, 1);
    showToast('Removed from favorites');
  }
  persistFavorites();
  if (currentQueue[currentIndex] === songId) {
    const song = getSongById(songId);
    playerFavBtn.classList.toggle('active', favorites.includes(songId));
    playerFavBtn.innerHTML = `<i class="fa-${favorites.includes(songId) ? 'solid' : 'regular'} fa-heart"></i>`;
  }
  refreshVisibleSongCards();
}

/* --------------------------------------------------------------------------
   15. RECENTLY PLAYED
   -------------------------------------------------------------------------- */
function addToRecentlyPlayed(songId) {
  recentlyPlayed = recentlyPlayed.filter(id => id !== songId); // avoid duplicates
  recentlyPlayed.unshift(songId);
  recentlyPlayed = recentlyPlayed.slice(0, 50); // cap the log
  persistRecent();
}

/* --------------------------------------------------------------------------
   16. PLAYLISTS
   -------------------------------------------------------------------------- */
function renderPlaylistNav() {
  const list = $('#playlistNavList');
  list.innerHTML = playlists.map(p => `
    <li class="playlist-item">
      <button class="nav-item" data-playlist-id="${p.id}">
        <i class="fa-solid fa-list-music"></i><span>${escapeHtml(p.name)}</span>
      </button>
      <button class="playlist-delete" data-delete-playlist="${p.id}" aria-label="Delete playlist"><i class="fa-solid fa-xmark"></i></button>
    </li>`).join('');

  list.querySelectorAll('[data-playlist-id]').forEach(btn => {
    btn.addEventListener('click', () => goToView('playlist', { value: btn.dataset.playlistId }));
  });
  list.querySelectorAll('[data-delete-playlist]').forEach(btn => {
    btn.addEventListener('click', (e) => { e.stopPropagation(); deletePlaylist(btn.dataset.deletePlaylist); });
  });
}

function deletePlaylist(playlistId) {
  playlists = playlists.filter(p => p.id !== playlistId);
  persistPlaylists();
  renderPlaylistNav();
  showToast('Playlist deleted');
  goToView('explore');
}

function removeSongFromPlaylist(playlistId, songId) {
  const pl = playlists.find(p => p.id === playlistId);
  if (!pl) return;
  pl.songIds = pl.songIds.filter(id => id !== songId);
  persistPlaylists();
  renderGenericView();
  showToast('Removed from playlist');
}

// --- Create playlist modal ---
const playlistModalOverlay = $('#playlistModalOverlay');
$('#openCreatePlaylistBtn').addEventListener('click', () => {
  playlistModalOverlay.classList.add('show');
  $('#playlistNameInput').value = '';
  $('#playlistNameInput').focus();
});
$('#closePlaylistModalBtn').addEventListener('click', () => playlistModalOverlay.classList.remove('show'));
playlistModalOverlay.addEventListener('click', (e) => { if (e.target === playlistModalOverlay) playlistModalOverlay.classList.remove('show'); });

$('#playlistForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = $('#playlistNameInput').value.trim();
  if (!name) return;
  playlists.push({ id: uid(), name, songIds: [] });
  persistPlaylists();
  renderPlaylistNav();
  playlistModalOverlay.classList.remove('show');
  showToast('🎵 Playlist created');
});

// --- Add-to-playlist modal ---
const addToPlaylistOverlay = $('#addToPlaylistOverlay');
function openAddToPlaylistModal(songId) {
  pendingAddToPlaylistSongId = songId;
  const list = $('#playlistPickList');
  $('#noPlaylistsMsg').hidden = playlists.length > 0;
  list.innerHTML = playlists.map(p => `<div class="playlist-pick-item" data-playlist-id="${p.id}"><i class="fa-solid fa-list-music"></i> ${escapeHtml(p.name)}</div>`).join('');
  list.querySelectorAll('.playlist-pick-item').forEach(item => {
    item.addEventListener('click', () => {
      const pl = playlists.find(p => p.id === item.dataset.playlistId);
      if (pl && !pl.songIds.includes(pendingAddToPlaylistSongId)) {
        pl.songIds.push(pendingAddToPlaylistSongId);
        persistPlaylists();
        showToast(`🎵 Added to ${pl.name}`);
      } else if (pl) {
        showToast('Already in that playlist');
      }
      addToPlaylistOverlay.classList.remove('show');
    });
  });
  addToPlaylistOverlay.classList.add('show');
}
$('#closeAddToPlaylistBtn').addEventListener('click', () => addToPlaylistOverlay.classList.remove('show'));
addToPlaylistOverlay.addEventListener('click', (e) => { if (e.target === addToPlaylistOverlay) addToPlaylistOverlay.classList.remove('show'); });

/* --------------------------------------------------------------------------
   17. UPLOAD MUSIC
   -------------------------------------------------------------------------- */
const uploadModalOverlay = $('#uploadModalOverlay');
function openUploadModal() {
  $('#uploadForm').reset();
  $('#audioFileLabel').textContent = 'Choose audio file';
  $('#coverFileLabel').textContent = 'Choose cover artwork (optional)';
  uploadModalOverlay.dataset.audioFile = '';
  uploadModalOverlay.classList.add('show');
}
$('#openUploadBtnSidebar').addEventListener('click', openUploadModal);
$('#openUploadBtnTop').addEventListener('click', openUploadModal);
$('#closeUploadModalBtn').addEventListener('click', () => uploadModalOverlay.classList.remove('show'));
uploadModalOverlay.addEventListener('click', (e) => { if (e.target === uploadModalOverlay) uploadModalOverlay.classList.remove('show'); });

let selectedAudioFile = null;
let selectedCoverFile = null;

$('#audioDrop').addEventListener('click', () => $('#audioFileInput').click());
$('#audioFileInput').addEventListener('change', (e) => {
  selectedAudioFile = e.target.files[0] || null;
  $('#audioFileLabel').textContent = selectedAudioFile ? selectedAudioFile.name : 'Choose audio file';
  // Auto-fill the title from the filename if the title field is empty.
  if (selectedAudioFile && !$('#songTitleInput').value) {
    $('#songTitleInput').value = selectedAudioFile.name.replace(/\.[^/.]+$/, '');
  }
});

$('#coverDrop').addEventListener('click', () => $('#coverFileInput').click());
$('#coverFileInput').addEventListener('change', (e) => {
  selectedCoverFile = e.target.files[0] || null;
  $('#coverFileLabel').textContent = selectedCoverFile ? selectedCoverFile.name : 'Choose cover artwork (optional)';
});

function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

$('#uploadForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!selectedAudioFile) {
    showToast('Please choose an audio file first');
    return;
  }

  const submitBtn = e.target.querySelector('button[type="submit"]');
  submitBtn.disabled = true;
  submitBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Uploading...`;

  try {
    const songId = uid();

    // Always create an in-session object URL — this plays instantly and
    // works no matter how large the file is.
    const objectUrl = URL.createObjectURL(selectedAudioFile);
    sessionAudioUrls[songId] = objectUrl;

    // For smaller files, also convert to a data URL so the song survives
    // a page refresh (localStorage has limited space).
    let audioDataUrl = null;
    if (selectedAudioFile.size < MAX_PERSIST_LENGTH * 0.7) {
      try { audioDataUrl = await readFileAsDataURL(selectedAudioFile); } catch (err) { /* ignore, session playback still works */ }
    }

    let coverDataUrl = null;
    if (selectedCoverFile) {
      try { coverDataUrl = await readFileAsDataURL(selectedCoverFile); } catch (err) { /* ignore */ }
    }

    const song = {
      id: songId,
      title: $('#songTitleInput').value.trim() || 'Untitled',
      artist: $('#songArtistInput').value.trim() || 'Unknown Artist',
      album: $('#songAlbumInput').value.trim(),
      genre: $('#songGenreInput').value,
      cover: coverDataUrl,
      audioDataUrl: audioDataUrl,
      dateAdded: Date.now(),
    };

    songs.push(song);
    if (persistSongs()) {
      // saved fine
    } else {
      showToast('Saved for this session — storage is full so it won\u2019t survive a refresh');
    }

    uploadModalOverlay.classList.remove('show');
    showToast('🎵 Music added successfully');
    showToast('📁 Added to Local Files');

    selectedAudioFile = null;
    selectedCoverFile = null;

    renderPlaylistNav();
    refreshVisibleSongCards();
    if ($('#view-explore').classList.contains('active')) renderExplore();
  } finally {
    submitBtn.disabled = false;
    submitBtn.innerHTML = `<i class="fa-solid fa-cloud-arrow-up"></i> Upload Music`;
  }
});

function deleteSong(songId) {
  songs = songs.filter(s => s.id !== songId);
  favorites = favorites.filter(id => id !== songId);
  recentlyPlayed = recentlyPlayed.filter(id => id !== songId);
  playlists.forEach(p => { p.songIds = p.songIds.filter(id => id !== songId); });
  delete sessionAudioUrls[songId];

  if (currentQueue.includes(songId)) {
    const wasPlayingThis = currentQueue[currentIndex] === songId;
    currentQueue = currentQueue.filter(id => id !== songId);
    if (wasPlayingThis) {
      audioEl.pause();
      audioEl.src = '';
      playerTitle.textContent = 'No song selected';
      playerArtist.textContent = 'Pick a track to start listening';
      playerArt.innerHTML = `<i class="fa-solid fa-music"></i>`;
      currentIndex = -1;
    }
  }

  persistSongs(); persistFavorites(); persistRecent(); persistPlaylists();
  showToast('🗑️ Song removed from your library');
  renderPlaylistNav();
  renderGenericView();
  refreshVisibleSongCards();
}

/* --------------------------------------------------------------------------
   18. INITIAL RENDER
   -------------------------------------------------------------------------- */
renderPlaylistNav();
renderExplore();
setPlayIcon(false);

// Warn (once) if any saved songs lost their audio because it was too big
// to persist across a refresh.
window.addEventListener('load', () => {
  const missingAudio = songs.filter(s => !s.audioDataUrl && !sessionAudioUrls[s.id]);
  if (missingAudio.length) {
    showToast(`⚠️ ${missingAudio.length} song${missingAudio.length > 1 ? 's' : ''} need re-uploading after this refresh`);
  }
});
