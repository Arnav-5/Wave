// =====================================================================
//  SIMPLE CHAT - app.js
// =====================================================================

// ---------- 1. SETUP ----------
const SUPABASE_URL = 'https://tjzjgspoufiklfmeeakn.supabase.co';
const SUPABASE_KEY = 'sb_publishable_NFLiqvcxlRXLMmvXHxw8Aw_XA49khDj';
const db = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

const TOKEN_KEY = 'simplechat_token';
const USER_KEY = 'simplechat_user';
const USERNAME_RE = /^[a-z0-9_]{3,20}$/;
const MIN_PASSWORD_LENGTH = 6;

const BUCKET = 'chat-files';
const MAX_FILE_BYTES = 50 * 1024 * 1024;

// Must match the allowed types set in the SQL for the bucket
const ALLOWED_TYPE_RE = /^(image\/(jpeg|png|gif|webp)|video\/(mp4|webm|quicktime)|application\/pdf|application\/msword|application\/vnd\.openxmlformats-officedocument\.(wordprocessingml\.document|spreadsheetml\.sheet|presentationml\.presentation)|application\/vnd\.ms-(excel|powerpoint)|text\/plain)$/;

// Fallback when the browser doesn't report a file type
const EXT_TYPES = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
  pdf: 'application/pdf', doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  txt: 'text/plain',
};

const state = {
  token: null,         // session token (proves who you are to the server)
  me: null,            // your username
  chatWith: null,      // username of the open conversation
  lastId: 0,           // newest message id shown in the open chat
  seenIds: new Set(),  // message ids already on screen (prevents duplicates)
  lastDay: null,       // used for "Today / Yesterday" separators
  unread: new Set(),   // usernames with unseen messages (green dot)
  inbox: null,         // realtime channel
  sending: false,
  pendingFile: null,   // file chosen but not yet sent: { file, type }
};

let listSeq = 0;       // ignores out-of-date contact list results
let searchTimer = null;

const $ = id => document.getElementById(id);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

class SessionExpiredError extends Error {}

// ---------- 2. HELPERS ----------

// Every database call goes through here so errors are handled one way.
async function rpc(fn, params) {
  const { data, error } = await db.rpc(fn, params);
  if (error) {
    if (error.message.includes('session has expired')) throw new SessionExpiredError(error.message);
    if (/failed to fetch/i.test(error.message)) throw new Error('Network error. Please check your connection.');
    throw new Error(error.message);
  }
  return data;
}

function handleError(err) {
  if (err instanceof SessionExpiredError) return forceLogout('Your session has expired. Please log in again.');
  toast(err.message);
}

let toastTimer;
function toast(message) {
  const el = $('toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2800);
}

function setAuthError(message = '') {
  $('auth-error').textContent = message;
}

function setAuthBusy(busy) {
  $('login-btn').disabled = busy;
  $('signup-btn').disabled = busy;
}

function setSendBusy(busy) {
  $('send-btn').disabled = busy;
  $('attach-btn').disabled = busy;
  $('send-btn').textContent = busy ? 'Sending…' : 'Send';
}

function showScreen(name) {
  ['auth', 'contacts', 'chat'].forEach(s => $(`${s}-screen`).classList.toggle('hidden', s !== name));
}

function storeSession(token, username) {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USER_KEY, username);
}

function clearStoredSession() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}

// A stable colour per username, for avatars
function colorFor(name) {
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) % 360;
  return `hsl(${hash} 55% 45%)`;
}

function formatTime(iso) {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function dayLabel(iso) {
  const d = new Date(iso);
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === now.toDateString()) return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], {
    day: 'numeric',
    month: 'short',
    year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric',
  });
}

function listTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toDateString() === new Date().toDateString()
    ? formatTime(iso)
    : d.toLocaleDateString([], { day: 'numeric', month: 'short' });
}

function formatSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function isNearBottom() {
  const box = $('messages');
  return box.scrollHeight - box.scrollTop - box.clientHeight < 80;
}

function scrollToBottom() {
  const box = $('messages');
  box.scrollTop = box.scrollHeight;
}

// -- PWA & Notification Helpers --
function playNotifSound() {
  const audio = $('notif-sound');
  if (audio) {
    audio.currentTime = 0;
    audio.play().catch(() => {});
  }
}

async function requestNotificationPermission() {
  if ('Notification' in window && Notification.permission === 'default') {
    await Notification.requestPermission();
  }
}

function sendSystemNotification(sender, messageText) {
  playNotifSound();
  if ('Notification' in window && Notification.permission === 'granted' && navigator.serviceWorker.controller) {
    navigator.serviceWorker.controller.postMessage({
      type: 'SHOW_NOTIFICATION',
      title: `New message from ${sender}`,
      body: messageText || 'Sent an attachment',
      icon: 'icon-192.png'
    });
  }
}

// ---------- 3. AUTH ----------

async function authenticate(isSignUp) {
  const username = $('username').value.trim().toLowerCase();
  const password = $('password').value;

  if (!USERNAME_RE.test(username)) {
    return setAuthError('Username must be 3-20 characters: lowercase letters, numbers or underscore.');
  }
  if (!password) return setAuthError('Please enter your password.');
  if (isSignUp && password.length < MIN_PASSWORD_LENGTH) {
    return setAuthError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }

  setAuthBusy(true);
  setAuthError('');
  try {
    const token = await rpc(isSignUp ? 'sign_up' : 'log_in', {
      p_username: username,
      p_password: password,
    });
    storeSession(token, username);
    state.token = token;
    state.me = username;
    $('username').value = '';
    $('password').value = '';
    enterApp();
  } catch (err) {
    setAuthError(err.message);
  } finally {
    setAuthBusy(false);
  }
}

async function logOut() {
  const token = state.token;
  forceLogout();
  if (token) await db.rpc('log_out', { p_token: token }); // invalidate on the server
}

// Clears everything and returns to the login screen
function forceLogout(message = '') {
  disconnectInbox();
  clearStoredSession();
  state.token = null;
  state.me = null;
  state.chatWith = null;
  state.lastId = 0;
  state.seenIds = new Set();
  state.lastDay = null;
  state.unread = new Set();
  state.sending = false;
  clearPending();
  $('messages').innerHTML = '';
  $('contacts-list').innerHTML = '';
  $('user-search').value = '';
  $('password').value = '';
  setAuthError(message);
  showScreen('auth');
}

// Runs on page load: if a session was saved, go straight in
function restoreSession() {
  const token = localStorage.getItem(TOKEN_KEY);
  const username = localStorage.getItem(USER_KEY);
  if (token && username) {
    state.token = token;
    state.me = username;
    enterApp();
  } else {
    showScreen('auth');
  }
}

function enterApp() {
  $('me-name').textContent = `Signed in as ${state.me}`;
  showScreen('contacts');
  connectInbox();
  syncAll();
  requestNotificationPermission(); // Request notification access
}

// ---------- 4. CONTACTS ----------
// Empty search box: only people you have chatted with.
// Text in the search box: matching users from everyone on the app.

async function loadContacts() {
  const query = $('user-search').value.trim().toLowerCase();
  const seq = ++listSeq;

  const [rows, unreadRows] = await Promise.all([
    query
      ? rpc('search_users', { p_token: state.token, p_query: query })
      : rpc('get_contacts', { p_token: state.token }),
    rpc('get_unread', { p_token: state.token }),
  ]);
  if (seq !== listSeq) return; // a newer load has started, so this one is stale

  state.unread = new Set(unreadRows.map(r => r.contact_name));
  if (state.chatWith) state.unread.delete(state.chatWith); // the open chat is already seen

  const list = $('contacts-list');
  list.innerHTML = '';

  if (rows.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    if (query) {
      empty.textContent = `No users found for "${query}".`;
    } else {
      empty.innerHTML = 'No chats yet.<br>Search for someone to start chatting.';
    }
    list.appendChild(empty);
    return;
  }
  rows.forEach(row => list.appendChild(buildContact(row)));
}

function buildContact(row) {
  const name = row.contact_name;

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'contact';

  const avatar = document.createElement('span');
  avatar.className = 'avatar';
  avatar.style.background = colorFor(name);
  avatar.textContent = name[0].toUpperCase();

  const label = document.createElement('span');
  label.className = 'name';
  label.textContent = name;

  const meta = document.createElement('span');
  meta.className = 'meta';
  const time = document.createElement('span');
  time.textContent = row.last_message_at ? listTime(row.last_message_at) : 'New chat';
  meta.appendChild(time);

  if (state.unread.has(name)) {
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.setAttribute('aria-label', 'New message');
    meta.appendChild(dot);
  }

  btn.append(avatar, label, meta);
  btn.addEventListener('click', () => openChat(name));
  return btn;
}

// Waits briefly after typing stops, then searches the server
function onSearchInput() {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => loadContacts().catch(handleError), 250);
}

// ---------- 5. CHAT ----------

function openChat(username) {
  state.chatWith = username;
  state.lastId = 0;
  state.seenIds = new Set();
  state.lastDay = null;
  state.unread.delete(username); // opening the chat clears the dot
  $('user-search').value = '';   // back button then shows the chat list
  clearPending();                // a file chosen for another chat is not carried over

  $('chat-title').textContent = username;
  $('messages').innerHTML = '';
  showScreen('chat');
  $('message-input').focus();
  loadMessages().catch(handleError);
}

function closeChat() {
  state.chatWith = null;
  clearPending();
  showScreen('contacts');
  loadContacts().catch(handleError);
}

// Fetches only the messages that aren't on screen yet, then marks them as seen
async function loadMessages() {
  const withUser = state.chatWith;
  if (!withUser) return;

  const rows = await rpc('get_messages', {
    p_token: state.token,
    p_with: withUser,
    p_after: state.lastId,
  });
  if (state.chatWith !== withUser) return; // user switched chats while loading
  if (rows.length === 0) return;

  const stick = isNearBottom();
  rows.forEach(msg => renderMessage(msg));
  if (stick) scrollToBottom();

  // Everything now on screen counts as seen
  const readUpTo = state.lastId;
  await rpc('mark_read', { p_token: state.token, p_with: withUser, p_id: readUpTo });
  state.unread.delete(withUser);
}

function renderMessage(msg) {
  if (state.seenIds.has(msg.id)) return;
  state.seenIds.add(msg.id);
  state.lastId = Math.max(state.lastId, msg.id);

  const box = $('messages');

  const day = new Date(msg.created_at).toDateString();
  if (day !== state.lastDay) {
    state.lastDay = day;
    const sep = document.createElement('div');
    sep.className = 'day';
    sep.textContent = dayLabel(msg.created_at);
    box.appendChild(sep);
  }

  const mine = msg.sender === state.me;

  const row = document.createElement('div');
  row.className = `msg ${mine ? 'mine' : 'theirs'}`; // mine = right, theirs = left

  const bubble = document.createElement('div');
  bubble.className = 'bubble';

  if (msg.attachment_path) {
    bubble.classList.add('has-media');
    bubble.appendChild(buildAttachment(msg));
  }

  // textContent (never innerHTML), so message text can't run as markup or script
  if (msg.content) {
    const text = document.createElement('div');
    text.className = 'text';
    text.textContent = msg.content;
    bubble.appendChild(text);
  }

  const time = document.createElement('div');
  time.className = 'time';
  time.textContent = formatTime(msg.created_at);
  bubble.appendChild(time);

  row.appendChild(bubble);
  box.appendChild(row);
}

// ---------- 6. ATTACHMENTS ----------

function fileUrl(path) {
  return db.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
}

function fileIcon(type) {
  if (type === 'application/pdf') return '📄';
  if (type.includes('word')) return '📝';
  if (type.includes('excel') || type.includes('spreadsheet')) return '📊';
  if (type.includes('powerpoint') || type.includes('presentation')) return '📽️';
  if (type === 'text/plain') return '🗒️';
  return '📎';
}

function buildAttachment(msg) {
  const url = fileUrl(msg.attachment_path);
  const type = msg.attachment_type || '';
  const name = msg.attachment_name || 'File';

  if (type.startsWith('image/')) {
    const link = document.createElement('a');
    link.className = 'media-link';
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener';

    const img = document.createElement('img');
    img.className = 'attach-image';
    img.src = url;
    img.alt = name;
    img.loading = 'lazy';
    link.appendChild(img);
    return link;
  }

  if (type.startsWith('video/')) {
    const video = document.createElement('video');
    video.className = 'attach-video';
    video.src = url;
    video.controls = true;
    video.preload = 'metadata';
    video.playsInline = true;
    return video;
  }

  // Documents: a tappable card that opens the file
  const card = document.createElement('a');
  card.className = 'file-card';
  card.href = url;
  card.target = '_blank';
  card.rel = 'noopener';

  const icon = document.createElement('span');
  icon.className = 'file-icon';
  icon.textContent = fileIcon(type);

  const info = document.createElement('span');
  info.className = 'file-info';

  const nameEl = document.createElement('span');
  nameEl.className = 'file-name';
  nameEl.textContent = name;

  const sizeEl = document.createElement('span');
  sizeEl.className = 'file-size';
  sizeEl.textContent = [formatSize(msg.attachment_size), 'Tap to open'].filter(Boolean).join(' · ');

  info.append(nameEl, sizeEl);
  card.append(icon, info);
  return card;
}

// Works out the file type, from the browser or from the extension
function detectType(file) {
  const ext = file.name.includes('.') ? file.name.split('.').pop().toLowerCase() : '';
  const type = file.type || EXT_TYPES[ext] || '';
  return ALLOWED_TYPE_RE.test(type) ? type : null;
}

function onFileChosen() {
  const input = $('file-input');
  const file = input.files[0];
  input.value = ''; // lets the same file be chosen again later
  if (!file) return;

  if (file.size === 0) return toast('That file is empty.');
  if (file.size > MAX_FILE_BYTES) return toast('Files must be 50 MB or smaller.');

  const type = detectType(file);
  if (!type) return toast('That file type is not supported.');

  state.pendingFile = { file, type };
  $('pending-name').textContent = `📎 ${file.name} (${formatSize(file.size)})`;
  $('pending').classList.remove('hidden');
  $('message-input').focus();
}

function clearPending() {
  state.pendingFile = null;
  $('pending').classList.add('hidden');
  $('pending-name').textContent = '';
}

// Uploads the file to storage and returns the details the message needs
async function uploadFile({ file, type }) {
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-80);
  const path = `${state.me}/${crypto.randomUUID()}-${safeName}`;

  const { error } = await db.storage.from(BUCKET).upload(path, file, {
    contentType: type,
    upsert: false,
  });
  if (error) {
    if (/failed to fetch/i.test(error.message)) throw new Error('Network error. Please check your connection.');
    throw new Error('Upload failed. Please try again.');
  }

  return { path, name: file.name.slice(0, 200), type, size: file.size };
}

// ---------- 7. SENDING ----------

async function sendMessage(event) {
  event.preventDefault();
  if (state.sending) return;

  const input = $('message-input');
  const text = input.value.trim();
  const to = state.chatWith;
  const pending = state.pendingFile;
  if (!to || (!text && !pending)) return;

  state.sending = true;
  setSendBusy(true);
  input.value = '';
  let sent = false;
  try {
    const attachment = pending ? await uploadFile(pending) : {};

    await rpc('send_message', {
      p_token: state.token,
      p_to: to,
      p_content: text || null,
      p_path: attachment.path ?? null,
      p_name: attachment.name ?? null,
      p_type: attachment.type ?? null,
      p_size: attachment.size ?? null,
    });
    sent = true;
    clearPending();
    await loadMessages();
    scrollToBottom();
  } catch (err) {
    if (!sent && !input.value) input.value = text; // give the text back so nothing is lost
    handleError(err);
  } finally {
    state.sending = false;
    setSendBusy(false);
    input.focus();
  }
}

// ---------- 8. REALTIME ----------
// Each user listens on their own inbox channel. The database pings it when a
// message involves them. The ping carries ids and usernames only; the message
// text is fetched with a logged-in request.

function connectInbox() {
  disconnectInbox();
  const channel = db.channel(`inbox:${state.me}`);
  channel
    .on('broadcast', { event: 'new_message' }, payload => onNewMessageSignal(payload))
    .subscribe(status => {
      // Runs on every (re)connect, so anything missed while offline gets loaded
      if (status === 'SUBSCRIBED') syncAll();
    });
  state.inbox = channel;
}

function disconnectInbox() {
  if (state.inbox) {
    db.removeChannel(state.inbox);
    state.inbox = null;
  }
}

async function onNewMessageSignal(signal) {
  const data = signal?.payload ?? signal;
  if (!data?.sender || !data?.receiver) return;

  const other = data.sender === state.me ? data.receiver : data.sender;

  if (other === state.chatWith) {
    await sleep(150); // brief pause so the new row is committed before we read it
    await loadMessages().catch(handleError); // also marks it as seen
  } else if (data.receiver === state.me) {
    toast(`New message from ${other}`);
    sendSystemNotification(other, data.content || 'New message');
  }
  loadContacts().catch(handleError);
}

function syncAll() {
  loadContacts().catch(handleError);
  if (state.chatWith) loadMessages().catch(handleError);
}

// ---------- 9. EVENTS, START & PWA ----------

$('auth-form').addEventListener('submit', e => {
  e.preventDefault();
  authenticate(false);
});
$('signup-btn').addEventListener('click', () => authenticate(true));
$('logout-btn').addEventListener('click', logOut);
$('user-search').addEventListener('input', onSearchInput);
$('back-btn').addEventListener('click', closeChat);
$('chat-form').addEventListener('submit', sendMessage);
$('attach-btn').addEventListener('click', () => $('file-input').click());
$('file-input').addEventListener('change', onFileChosen);
$('pending-clear').addEventListener('click', clearPending);

// When you come back to the tab, catch up on anything missed
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && state.token) syncAll();
});

restoreSession();

// --- PWA SERVICE WORKER REGISTRATION ---
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(err => {
      console.error('ServiceWorker registration failed: ', err);
    });
  });
}

// --- PWA INSTALL PROMPT HANDLING ---
let deferredPrompt = null;
const installBtns = document.querySelectorAll('.pwa-install-btn');

window.addEventListener('beforeinstallprompt', e => {
  // Prevent Chrome's default mini-infobar from appearing on mobile
  e.preventDefault();
  // Stash the event so it can be triggered later.
  deferredPrompt = e;
  // Unhide all install buttons
  installBtns.forEach(btn => btn.classList.remove('hidden'));
});

installBtns.forEach(btn => {
  btn.addEventListener('click', async () => {
    if (!deferredPrompt) return;
    // Show the install prompt
    deferredPrompt.prompt();
    // Wait for the user to respond
    const { outcome } = await deferredPrompt.userChoice;
    if (outcome === 'accepted') {
      // Hide buttons if they installed it
      installBtns.forEach(b => b.classList.add('hidden'));
    }
    // Clear the saved prompt since it can't be used again
    deferredPrompt = null;
  });
});

window.addEventListener('appinstalled', () => {
  // Hide buttons once installed
  installBtns.forEach(b => b.classList.add('hidden'));
  deferredPrompt = null;
});
window.addEventListener('appinstalled', () => {
  if (installBtn) installBtn.classList.add('hidden');
  deferredPrompt = null;
});
