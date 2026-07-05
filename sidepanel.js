// =============================================================================
// Onyx AI Agent — Side Panel Logic
// Handles onboarding, chat UI, history, agent communication, and settings.
// =============================================================================

'use strict';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let port = null;
let config = { provider: null, apiKey: null, model: null, safetyLevel: 'relaxed', maxSteps: 15, chatHistoryEnabled: true, historyRetentionDays: 5 };
let selectedProvider = null;
let selectedModel = null;
let allModels = [];
let conversationHistory = [];
let isAgentRunning = false;

// Heartbeat: while the agent is running, send a no-op ping to the service
// worker every 20 seconds. MV3 kills idle service workers after ~30s of
// inactivity; this ping resets the idle timer so long agent runs survive.
let _heartbeatInterval = null;

function startHeartbeat() {
  stopHeartbeat();
  _heartbeatInterval = setInterval(() => {
    if (port) {
      try { port.postMessage({ type: 'ping' }); } catch (e) { /* port gone */ }
    }
  }, 20000);
}

function stopHeartbeat() {
  if (_heartbeatInterval) {
    clearInterval(_heartbeatInterval);
    _heartbeatInterval = null;
  }
}

// Chat session state
let currentChatId = null;
let currentChatTitle = null;
let chatMessageElements = []; // Track message DOM for restoration

// ---------------------------------------------------------------------------
// DOM Helpers
// ---------------------------------------------------------------------------
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const screens = {
  welcome: $('#screen-welcome'),
  auth: $('#screen-auth'),
  chat: $('#screen-chat'),
  macros: $('#screen-macros'),
  history: $('#screen-history'),
  settings: $('#screen-settings')
};

const els = {
  // Welcome
  btnGetStarted: $('#btn-get-started'),

  // Auth
  authProvider: $('#auth-provider'),
  authKeyLabel: $('#auth-key-label'),
  authApikey: $('#auth-apikey'),
  authToggleKey: $('#auth-toggle-key'),
  authModelArea: $('#auth-model-area'),
  btnConnectAgent: $('#btn-connect-agent'),
  authError: $('#auth-error'),

  // Chat
  headerModelName: $('#header-model-name'),
  chatMessages: $('#chat-messages'),
  chatWelcome: $('#chat-welcome'),
  greetingText: $('#greeting-text'),
  statusBar: $('#status-bar'),
  statusText: $('#status-text'),
  btnStopAgent: $('#btn-stop-agent'),
  chatInput: $('#chat-input'),
  btnSend: $('#btn-send'),
  btnNewChat: $('#btn-new-chat'),

  // History
  historyList: $('#history-list'),

  // Settings
  settingProvider: $('#setting-provider'),
  settingApikeyLabel: $('#setting-apikey-label'),
  settingApikey: $('#setting-apikey'),
  settingApikeyToggle: $('#setting-toggle-key'),
  settingModel: $('#setting-model'),
  btnRefreshModels: $('#btn-refresh-models'),
  settingMaxSteps: $('#setting-max-steps'),
  settingChatHistory: $('#setting-chat-history'),
  settingRetention: $('#setting-retention'),
  btnSaveSettings: $('#btn-save-settings'),
  btnResetExtension: $('#btn-reset-extension'),

  // HITL Permission Modal
  permissionModal: $('#permission-modal'),
  permissionReason: $('#permission-reason'),
  permissionPlanned: $('#permission-planned'),
  btnPermissionApprove: $('#btn-permission-approve'),
  btnPermissionReject: $('#btn-permission-reject'),

  // Macros
  macrosList: $('#macros-list'),

  // Memory
  btnClearMemory: $('#btn-clear-memory')
};

// ---------------------------------------------------------------------------
// Port Connection
// ---------------------------------------------------------------------------
let portRetries = 0;
const MAX_PORT_RETRIES = 5;

function connectPort() {
  try {
    port = chrome.runtime.connect({ name: 'agent-panel' });
    portRetries = 0;
    port.onMessage.addListener(handlePortMessage);
    port.onDisconnect.addListener(() => {
      console.log('[SidePanel] Port disconnected');
      if (portRetries < MAX_PORT_RETRIES) {
        portRetries++;
        setTimeout(connectPort, 1000 * portRetries);
      } else {
        // Port gave up — if the agent was running, the SW is likely dead.
        // Reset the running flag so the user isn't permanently locked out.
        if (isAgentRunning) {
          isAgentRunning = false;
          stopHeartbeat();
          updateInputState();
          showStatusBar(false);
          showToast('Connection lost. Agent may have been interrupted.', 'warning');
        }
      }
    });

    // After reconnect, sync the running state with the service worker.
    // The SW may have restarted and lost its in-memory agentRunning flag
    // (it reports false), while we still think we're running.
    chrome.runtime.sendMessage({ type: 'is_agent_running' }, (resp) => {
      if (resp && resp.running === false && isAgentRunning) {
        isAgentRunning = false;
        stopHeartbeat();
        updateInputState();
        showStatusBar(false);
        showToast('Agent connection was interrupted.', 'warning');
      }
    });
  } catch (e) {
    console.error('[SidePanel] Failed to connect port:', e);
  }
}

function sendMessage(msg) {
  try {
    port.postMessage(msg);
  } catch (e) {
    console.error('[SidePanel] Failed to send message:', e);
    portRetries = 0;
    connectPort();
    setTimeout(() => {
      try { port.postMessage(msg); } catch (e2) { console.error('[SidePanel] Retry failed:', e2); }
    }, 500);
  }
}

// ---------------------------------------------------------------------------
// Port Message Handler
// ---------------------------------------------------------------------------
function handlePortMessage(msg) {
  switch (msg.type) {
    case 'config':
      config = msg.data;
      const hasConfig = config.provider && config.provider !== 'null'
        && config.apiKey && config.apiKey !== 'null'
        && config.model && config.model !== 'null';
      if (hasConfig) {
        showScreen('chat');
        setHeaderModel(config.model);
      }
      // Auto-purge old chats with the user's real retention setting.
      // Previously this ran on a fixed 1s timer before config arrived,
      // always using the default 5 days regardless of the user's choice.
      setTimeout(() => {
        sendMessage({ type: 'purge_old_chats', retentionDays: config.historyRetentionDays || 5 });
      }, 500);
      break;

    case 'config_saved':
      config = { ...config, ...msg.data };
      break;

    case 'models':
      allModels = msg.data;
      renderAuthModelChips(allModels);
      updateSettingsModelList(allModels);
      break;

    case 'agent_message':
      handleAgentMessage(msg);
      autoSaveChat();
      break;

    case 'status':
      showStatus(msg.status);
      break;

    case 'done':
      handleAgentDone(msg);
      autoSaveChat();
      break;

    case 'stopped':
      handleAgentStopped(msg);
      autoSaveChat();
      break;

    case 'permission_request':
      showPermissionModal(msg.reason, msg.plannedAction);
      break;

    case 'macro_saved':
      showToast(`Macro "${msg.macro?.name || 'Macro'}" saved!`, 'success');
      break;

    case 'macros_loaded':
      renderMacrosList(msg.data);
      break;

    case 'memory_cleared':
      showToast('Agent memory cleared.', 'info');
      break;

    case 'error':
      if (msg.error && msg.error.includes('fetch models')) {
        showToast(msg.error, 'error');
      } else {
        handleAgentError(msg);
        autoSaveChat();
      }
      break;

    case 'chats_loaded':
      renderHistoryList(msg.data);
      break;

    case 'chat_deleted':
      sendMessage({ type: 'load_chats' });
      showToast('Chat deleted', 'info');
      break;

    case 'api_test_result':
      showToast(msg.success ? 'API connection successful!' : `API test failed: ${msg.error}`, msg.success ? 'success' : 'error');
      break;
  }
}

// ---------------------------------------------------------------------------
// Screen & Nav
// ---------------------------------------------------------------------------
function showScreen(name) {
  Object.values(screens).forEach(s => s.classList.remove('active'));
  screens[name]?.classList.add('active');

  // Update all nav items across all screens
  $$('.nav-item').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.nav === name);
  });

  // Refresh data when entering specific screens
  if (name === 'history') {
    sendMessage({ type: 'load_chats' });
  }
  if (name === 'macros') {
    sendMessage({ type: 'load_macros' });
  }
  if (name === 'settings') {
    openSettingsScreen();
  }
}

// Global click handler (delegation for dynamically rendered elements)
document.addEventListener('click', (e) => {
  // Nav items
  const navBtn = e.target.closest('.nav-item[data-nav]');
  if (navBtn) {
    showScreen(navBtn.dataset.nav);
    return;
  }

  // Thought toggles
  const thoughtBtn = e.target.closest('.thought-toggle');
  if (thoughtBtn) {
    const thoughtId = thoughtBtn.dataset.thoughtId;
    const el = document.getElementById(thoughtId);
    if (el) {
      el.classList.toggle('open');
      thoughtBtn.classList.toggle('open');
    }
    return;
  }

  // History load
  const loadBtn = e.target.closest('.history-item-content[data-chat-id]');
  if (loadBtn) {
    window._loadChat(loadBtn.dataset.chatId);
    return;
  }

  // History delete
  const deleteBtn = e.target.closest('.history-item-delete[data-delete-id]');
  if (deleteBtn) {
    e.stopPropagation();
    sendMessage({ type: 'delete_chat', chatId: deleteBtn.dataset.deleteId });
    return;
  }

  // Macro play
  const playMacroBtn = e.target.closest('.macro-play[data-macro-id]');
  if (playMacroBtn) {
    e.stopPropagation();
    const macroId = playMacroBtn.dataset.macroId;
    sendMessage({ type: 'run_agent', message: `Play macro: ${macroId}` });
    showScreen('chat');
    return;
  }

  // Macro delete
  const deleteMacroBtn = e.target.closest('.macro-delete[data-macro-id]');
  if (deleteMacroBtn) {
    e.stopPropagation();
    if (confirm('Delete this macro?')) {
      sendMessage({ type: 'delete_macro', macroId: deleteMacroBtn.dataset.macroId });
    }
    return;
  }
});

// ---------------------------------------------------------------------------
// SCREEN 1: WELCOME
// ---------------------------------------------------------------------------
els.btnGetStarted.addEventListener('click', () => showScreen('auth'));

// ---------------------------------------------------------------------------
// SCREEN 2: AUTH
// ---------------------------------------------------------------------------
els.authProvider.addEventListener('change', (e) => {
  const isCustom = e.target.value === 'custom';
  els.authKeyLabel.textContent = isCustom ? 'BASE URL' : 'API KEY';
  els.authApikey.placeholder = isCustom ? 'http://localhost:11434' : 'sk-...';
  els.authApikey.type = isCustom ? 'text' : 'password';
  selectedProvider = e.target.value;
});

els.authToggleKey.addEventListener('click', () => {
  els.authApikey.type = els.authApikey.type === 'password' ? 'text' : 'password';
});

els.authApikey.addEventListener('blur', () => {
  const key = els.authApikey.value.trim();
  const provider = els.authProvider.value;
  if (key.length >= 10) {
    selectedProvider = provider;
    sendMessage({ type: 'fetch_models', provider, apiKey: key });
    els.authModelArea.innerHTML = `<div class="loading-spinner-sm"><div class="spinner-sm"></div><span>Fetching models...</span></div>`;
  }
});

els.authApikey.addEventListener('keydown', (e) => { if (e.key === 'Enter') els.authApikey.blur(); });

function renderAuthModelChips(models) {
  if (models.length === 0) {
    els.authModelArea.innerHTML = `<div class="loading-spinner-sm"><span>No models found. Check your key.</span></div>`;
    return;
  }
  const display = models.slice(0, 20);
  els.authModelArea.innerHTML = display.map(m => `
    <button class="model-chip ${selectedModel === m.id ? 'selected' : ''}" data-model-id="${escapeAttr(m.id)}">${escapeHTML(m.id)}</button>
  `).join('');
  if (models.length > 20) {
    els.authModelArea.innerHTML += `<span style="font-size:11px; color: var(--text-tertiary); padding: 6px;">+${models.length - 20} more in Settings</span>`;
  }
  els.authModelArea.querySelectorAll('.model-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      els.authModelArea.querySelectorAll('.model-chip').forEach(c => c.classList.remove('selected'));
      chip.classList.add('selected');
      selectedModel = chip.dataset.modelId;
    });
  });
}

els.btnConnectAgent.addEventListener('click', () => {
  const provider = els.authProvider.value;
  const apiKey = els.authApikey.value.trim();
  if (!apiKey) { showAuthError(provider === 'custom' ? 'Base URL is required' : 'API key is required'); return; }
  if (apiKey.length < 10) { showAuthError('Key seems too short'); return; }
  if (!selectedModel) { showAuthError('Please select a model first'); return; }
  hideAuthError();
  config = { ...config, provider, apiKey, model: selectedModel };
  sendMessage({ type: 'save_config', config });
  setHeaderModel(config.model);
  showScreen('chat');
});

function showAuthError(msg) { els.authError.textContent = msg; els.authError.classList.remove('hidden'); }
function hideAuthError() { els.authError.classList.add('hidden'); }

// ---------------------------------------------------------------------------
// SCREEN 3: CHAT
// ---------------------------------------------------------------------------

// New chat
els.btnNewChat.addEventListener('click', () => {
  createNewChat();
});

function createNewChat() {
  // Reset state FIRST. Previously autoSaveChat() ran before the id was reset,
  // so deleting the current chat re-saved it under the old id (it "came back").
  currentChatId = generateId();
  currentChatTitle = null;
  conversationHistory = [];

  // Save current chat (now writing to the NEW empty session, not the deleted one)
  autoSaveChat();

  // Reset UI
  els.chatMessages.innerHTML = '';
  const welcome = document.createElement('div');
  welcome.className = 'chat-welcome';
  welcome.id = 'chat-welcome';
  welcome.innerHTML = `
    <h1 class="greeting-title"><span id="greeting-text">${getGreeting()}</span><br><span class="accent-text">What's the play?</span></h1>
    <p class="greeting-sub">Ready to assist with any task on this page.</p>
    <div class="example-commands">
      <button class="example-chip" data-cmd="Click the first link on this page">Click the first link</button>
      <button class="example-chip" data-cmd="Search for 'AI news' in the search bar">Search for something</button>
      <button class="example-chip" data-cmd="Scroll down and summarize the page content">Summarize page</button>
      <button class="example-chip" data-cmd="Fill out the contact form with test data">Fill a form</button>
    </div>
  `;
  els.chatMessages.appendChild(welcome);
  attachExampleChipHandlers();

  showScreen('chat');
}

// Chat sending
els.btnSend.addEventListener('click', sendUserMessage);
els.chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendUserMessage(); }
});
els.chatInput.addEventListener('input', () => {
  els.chatInput.style.height = 'auto';
  els.chatInput.style.height = Math.min(els.chatInput.scrollHeight, 100) + 'px';
});

function sendUserMessage() {
  const text = els.chatInput.value.trim();
  if (!text || isAgentRunning) return;

  // Generate chat ID if none exists
  if (!currentChatId) currentChatId = generateId();

  // Set title from first message
  if (!currentChatTitle) {
    currentChatTitle = text.length > 50 ? text.slice(0, 50) + '…' : text;
  }

  addMessage('user', text);
  conversationHistory.push({ role: 'user', content: text });

  els.chatInput.value = '';
  els.chatInput.style.height = 'auto';

  // Remove welcome
  const welcome = $('#chat-welcome');
  if (welcome) welcome.remove();

  isAgentRunning = true;
  updateInputState();
  showStatusBar(true);
  startHeartbeat();

  sendMessage({
    type: 'run_agent',
    message: text,
    history: conversationHistory.slice(-20)
  });
}

function attachExampleChipHandlers() {
  $$('.example-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      els.chatInput.value = btn.dataset.cmd;
      els.chatInput.dispatchEvent(new Event('input'));
      sendUserMessage();
    });
  });
}

// Attach on initial load
attachExampleChipHandlers();

els.btnStopAgent.addEventListener('click', () => {
  sendMessage({ type: 'stop_agent' });
});

// ---------------------------------------------------------------------------
// Chat: Agent Messages (with collapsible thoughts)
// ---------------------------------------------------------------------------
function handleAgentMessage(msg) {
  const container = document.createElement('div');
  container.className = 'message agent';

  let html = '';

  // Collapsible thought
  if (msg.thought) {
    const thoughtId = 'thought-' + Date.now();
    html += `<button class="thought-toggle" data-thought-id="${thoughtId}">
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M9 18l6-6-6-6"/></svg>
      💭 Reasoning...
    </button>`;
    html += `<div class="thought-content" id="${thoughtId}">${escapeHTML(msg.thought)}</div>`;
  }

  // Onyx analysis label
  html += `<div class="onyx-analysis-label">
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M12 2L2 7l10 5 10-5-10-5z" fill="#0096FF"/><path d="M2 17l10 5 10-5M2 12l10 5 10-5" stroke="#0096FF" stroke-width="1.5" fill="none"/></svg>
    <span>ONYX ANALYSIS</span>
  </div>`;

  if (msg.summary) {
    html += `<div class="message-bubble">`;
    if (msg.step) html += `<span class="step-badge">${msg.step}</span>`;
    html += escapeHTML(msg.summary);

    if (msg.action && msg.action !== 'done') {
      const actionIcons = {
        click: '🖱️', click_coordinate: '🎯', type: '⌨️', scroll: '📜',
        navigate: '🔗', select: '📋', read: '👁️', hover: '👆', wait: '⏳',
        press_keys: '🎹', drag_and_drop: '↕️',
        open_tab: '📂', switch_tab: '🔀', close_tab: '❌',
        copy_to_clipboard: '📋', request_permission: '🛡️',
        save_macro: '⚡', search_memory: '🧠'
      };
      const icon = actionIcons[msg.action] || '⚡';
      let paramStr = '';
      if (msg.params) {
        if (msg.params.id) paramStr += `#${msg.params.id}`;
        if (msg.params.text) paramStr += ` "${truncate(msg.params.text, 20)}"`;
        if (msg.params.url) paramStr += ` ${truncate(msg.params.url, 30)}`;
        if (msg.params.direction) paramStr += ` ${msg.params.direction}`;
      }
      html += `<div class="action-badge">${icon} ${escapeHTML(msg.action)}${paramStr ? ' ' + escapeHTML(paramStr) : ''}</div>`;
    }
    html += `</div>`;
  }

  html += `<span class="message-time">${formatTime()}</span>`;
  container.innerHTML = html;
  els.chatMessages.appendChild(container);
  scrollToBottom();

  if (msg.summary) {
    // Include `thought` so persisted context matches what the background loop
    // produces (it stores JSON.stringify(agentAction) which includes thought).
    // Previously the omission made cross-run assistant turns structurally
    // inconsistent with in-run turns.
    conversationHistory.push({
      role: 'assistant',
      content: JSON.stringify({ thought: msg.thought, action: msg.action, params: msg.params, summary: msg.summary })
    });
  }
}



function handleAgentDone(msg) {
  isAgentRunning = false;
  stopHeartbeat();
  updateInputState();
  showStatusBar(false);

  const container = document.createElement('div');
  container.className = 'message done';
  container.innerHTML = `
    <div class="message-bubble"><span class="done-icon">✅</span>${escapeHTML(msg.summary || 'Task completed!')}</div>
    <span class="message-time">${formatTime()}</span>
  `;
  els.chatMessages.appendChild(container);
  scrollToBottom();
}

function handleAgentStopped(msg) {
  isAgentRunning = false;
  stopHeartbeat();
  updateInputState();
  showStatusBar(false);
  addMessage('agent', `⏹️ ${msg.message || 'Agent stopped.'}`);
}

function handleAgentError(msg) {
  isAgentRunning = false;
  stopHeartbeat();
  updateInputState();
  showStatusBar(false);

  const container = document.createElement('div');
  container.className = 'message error';
  container.innerHTML = `<div class="message-bubble">⚠️ ${escapeHTML(msg.error)}</div><span class="message-time">${formatTime()}</span>`;
  els.chatMessages.appendChild(container);
  scrollToBottom();
}

// ---------------------------------------------------------------------------
// Chat: UI Helpers
// ---------------------------------------------------------------------------
function addMessage(role, text) {
  const container = document.createElement('div');
  container.className = `message ${role}`;
  container.innerHTML = `<div class="message-bubble">${escapeHTML(text)}</div><span class="message-time">${formatTime()}</span>`;
  els.chatMessages.appendChild(container);
  scrollToBottom();
}

function showStatus(text) { els.statusText.textContent = text; showStatusBar(true); }
function showStatusBar(visible) { els.statusBar.classList.toggle('hidden', !visible); }

function showPermissionModal(reason, plannedAction) {
  els.permissionReason.textContent = reason || 'The agent requires your approval to proceed.';
  els.permissionPlanned.textContent = plannedAction ? `Action: ${plannedAction}` : '';
  els.permissionModal.classList.remove('hidden');
}

// Write the active model name to the header indicator. The element lives in
// .chat-header (after the HTML fix). It may be null if the welcome subtitle
// (which previously held this id) was removed, so guard defensively.
function setHeaderModel(model) {
  const el = els.headerModelName;
  if (el && model) {
    el.textContent = model;
    el.style.display = '';
  }
}
function updateInputState() {
  els.btnSend.disabled = isAgentRunning;
  els.chatInput.disabled = isAgentRunning;
  // Gate New Chat while running — previously createNewChat could run mid-run
  // and wipe the DOM while the agent was still appending messages.
  els.btnNewChat.disabled = isAgentRunning;
  if (!isAgentRunning) els.chatInput.focus();
}
function scrollToBottom() {
  requestAnimationFrame(() => { els.chatMessages.scrollTop = els.chatMessages.scrollHeight; });
}

// ---------------------------------------------------------------------------
// Chat Persistence
// ---------------------------------------------------------------------------
function autoSaveChat() {
  if (!config.chatHistoryEnabled) return;
  if (!currentChatId || conversationHistory.length === 0) return;

  const chatData = {
    id: currentChatId,
    title: currentChatTitle || 'Untitled Chat',
    messages: conversationHistory.slice(), // Clone
    messagesHtml: els.chatMessages.innerHTML,
    createdAt: Date.now(),
    updatedAt: Date.now()
  };

  sendMessage({ type: 'save_chat', chat: chatData });
}

function loadChat(chat) {
  // Save current first
  autoSaveChat();

  // Restore
  currentChatId = chat.id;
  currentChatTitle = chat.title;
  conversationHistory = chat.messages || [];

  // Restore HTML — SANITIZE first. messagesHtml is a stored-XSS sink: anything
  // that ever wrote a chat record to storage could otherwise run script here,
  // in the same scope as the API key. sanitizeChatHTML strips scripts/iframes,
  // on* handlers, and javascript: URLs.
  els.chatMessages.innerHTML = sanitizeChatHTML(chat.messagesHtml);

  showScreen('chat');
  scrollToBottom();
}

// ---------------------------------------------------------------------------
// SCREEN: MACROS
// ---------------------------------------------------------------------------
function renderMacrosList(macros) {
  if (!macros || macros.length === 0) {
    els.macrosList.innerHTML = `
      <div class="macros-empty">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="var(--text-tertiary)" stroke-width="1"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
        <p>No macros saved yet</p>
        <small>Complete a task and ask Onyx to save it as a macro.</small>
      </div>`;
    return;
  }

  els.macrosList.innerHTML = macros.map(m => `
    <div class="macro-item">
      <div class="macro-item-content">
        <div class="macro-item-name">${escapeHTML(m.name)}</div>
        <div class="macro-item-desc">${escapeHTML(m.description || '')}</div>
        <div class="macro-item-meta">${m.steps.length} steps • ${new Date(m.createdAt).toLocaleDateString()}</div>
      </div>
      <div class="macro-item-actions">
        <button class="macro-play" data-macro-id="${escapeAttr(m.id)}" title="Run Macro">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>
        </button>
        <button class="macro-delete" data-macro-id="${escapeAttr(m.id)}" title="Delete Macro">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
        </button>
      </div>
    </div>
  `).join('');
}

// ---------------------------------------------------------------------------
// SCREEN 4: HISTORY
// ---------------------------------------------------------------------------
function renderHistoryList(chats) {
  if (!chats || chats.length === 0) {
    els.historyList.innerHTML = `
      <div class="history-empty">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="var(--text-tertiary)" stroke-width="1"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
        <p>No conversations yet</p>
        <small>Start chatting with Onyx to see your history here.</small>
      </div>
    `;
    return;
  }

  // Group by date
  const groups = groupChatsByDate(chats);
  let html = '';

  for (const [label, items] of Object.entries(groups)) {
    html += `<div class="history-date-group">${label}</div>`;
    items.forEach(chat => {
      const time = new Date(chat.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const msgCount = (chat.messages || []).length;
      html += `
        <div class="history-item" data-chat-id="${chat.id}">
          <div class="history-item-content" data-chat-id="${chat.id}">
            <div class="history-item-title">${escapeHTML(chat.title || 'Untitled')}</div>
            <div class="history-item-meta">${msgCount} messages • ${time}</div>
          </div>
          <button class="history-item-delete" data-delete-id="${chat.id}" title="Delete">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6h14"/></svg>
          </button>
        </div>
      `;
    });
  }

  els.historyList.innerHTML = html;
}

function groupChatsByDate(chats) {
  const groups = {};
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const yesterday = today - 86400000;
  const weekAgo = today - 7 * 86400000;

  chats.forEach(chat => {
    const t = chat.updatedAt || chat.createdAt;
    let label;
    if (t >= today) label = 'Today';
    else if (t >= yesterday) label = 'Yesterday';
    else if (t >= weekAgo) label = 'This Week';
    else label = 'Older';

    if (!groups[label]) groups[label] = [];
    groups[label].push(chat);
  });

  return groups;
}

// Global handlers for history items.
// Removed the dead `_allChats` variable that was declared and never used.
window._loadChat = function(chatId) {
  if (!port) return;
  // Single request. Use a one-time listener that ALWAYS removes itself
  // (including on miss) to avoid the accumulation bug in the old version,
  // which only removed the listener inside the success branch.
  sendMessage({ type: 'load_chats' });
  const handler = (msg) => {
    if (msg.type !== 'chats_loaded') return;
    // Only act on responses that correspond to our request; guard against the
    // History-screen refresh also triggering chats_loaded.
    const chat = msg.data.find(c => c.id === chatId);
    if (chat) loadChat(chat);
    // Always clean up, whether or not the chat was found.
    try { port.onMessage.removeListener(handler); } catch (e) {}
  };
  port.onMessage.addListener(handler);
};

window._deleteChat = function(chatId) {
  if (confirm('Delete this conversation?')) {
    sendMessage({ type: 'delete_chat', chatId });
    // If deleting current chat, create new one.
    // NOTE: state is now reset inside createNewChat before autoSaveChat,
    // so the deleted chat is no longer resurrected.
    if (chatId === currentChatId) {
      createNewChat();
    }
  }
};

// ---------------------------------------------------------------------------
// SCREEN 5: SETTINGS
// ---------------------------------------------------------------------------
function openSettingsScreen() {
  els.settingProvider.value = config.provider || 'groq';
  els.settingApikey.value = config.apiKey || '';
  els.settingMaxSteps.value = config.maxSteps || 15;
  els.settingChatHistory.checked = config.chatHistoryEnabled !== false;
  els.settingRetention.value = config.historyRetentionDays || 5;

  const isCustom = (config.provider === 'custom');
  els.settingApikeyLabel.textContent = isCustom ? 'Base URL' : 'API Key';
  els.settingApikey.placeholder = isCustom ? 'http://localhost:11434' : 'sk-...';
  els.settingApikey.type = isCustom ? 'text' : 'password';

  const safetyRadio = $(`input[name="safety"][value="${config.safetyLevel || 'relaxed'}"]`);
  if (safetyRadio) safetyRadio.checked = true;

  if (config.apiKey) {
    sendMessage({ type: 'fetch_models', provider: config.provider, apiKey: config.apiKey });
  }
}

els.settingProvider.addEventListener('change', (e) => {
  const isCustom = e.target.value === 'custom';
  els.settingApikeyLabel.textContent = isCustom ? 'Base URL' : 'API Key';
  els.settingApikey.placeholder = isCustom ? 'http://localhost:11434' : 'sk-...';
  els.settingApikey.type = isCustom ? 'text' : 'password';
});

// Settings key show/hide toggle (mirrors the auth-screen toggle).
if (els.settingApikeyToggle) {
  els.settingApikeyToggle.addEventListener('click', () => {
    els.settingApikey.type = els.settingApikey.type === 'password' ? 'text' : 'password';
  });
}

function updateSettingsModelList(models) {
  els.settingModel.innerHTML = '<option value="">Select a model</option>';
  models.forEach(m => {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.id;
    if (m.id === config.model) opt.selected = true;
    els.settingModel.appendChild(opt);
  });
}

els.btnRefreshModels.addEventListener('click', () => {
  const provider = els.settingProvider.value;
  const apiKey = els.settingApikey.value.trim();
  if (!apiKey) { showToast('Enter an API key first', 'warning'); return; }
  sendMessage({ type: 'fetch_models', provider, apiKey });
  showToast('Refreshing models...', 'info');
});

els.btnSaveSettings.addEventListener('click', () => {
  const provider = els.settingProvider.value;
  const apiKey = els.settingApikey.value.trim();
  const model = els.settingModel.value || (provider === 'custom' ? 'custom-model' : '');
  const safety = $('input[name="safety"]:checked')?.value || 'relaxed';
  const maxSteps = Math.max(5, Math.min(50, parseInt(els.settingMaxSteps.value) || 15));
  const chatHistoryEnabled = els.settingChatHistory.checked;
  const historyRetentionDays = parseInt(els.settingRetention.value) || 5;

  if (!apiKey) { showToast(provider === 'custom' ? 'Base URL is required' : 'API key is required', 'error'); return; }

  config = { provider, apiKey, model: model || config.model, safetyLevel: safety, maxSteps, chatHistoryEnabled, historyRetentionDays };
  sendMessage({ type: 'save_config', config });
  setHeaderModel(config.model);
  showToast('Settings saved!', 'success');
  showScreen('chat');
});

els.btnResetExtension.addEventListener('click', () => {
  if (confirm('Reset all settings and clear all chat history?')) {
    sendMessage({ type: 'save_config', config: { provider: null, apiKey: null, model: null, safetyLevel: 'relaxed', maxSteps: 15, chatHistoryEnabled: true, historyRetentionDays: 5 } });
    // Clear chat history from storage
    chrome.storage?.local?.set({ chatHistory: [] });
    config = { provider: null, apiKey: null, model: null, safetyLevel: 'relaxed', maxSteps: 15, chatHistoryEnabled: true, historyRetentionDays: 5 };
    conversationHistory = [];
    selectedProvider = null;
    selectedModel = null;
    allModels = [];
    currentChatId = null;
    currentChatTitle = null;
    els.chatMessages.innerHTML = '';
    showScreen('welcome');
  }
});

if (els.btnClearMemory) {
  els.btnClearMemory.addEventListener('click', () => {
    if (confirm('Clear short-term agent memory? This removes cross-session context but keeps history.')) {
      sendMessage({ type: 'clear_memory' });
    }
  });
}

if (els.btnPermissionApprove) {
  els.btnPermissionApprove.addEventListener('click', () => {
    els.permissionModal.classList.add('hidden');
    sendMessage({ type: 'permission_response', approved: true });
  });
}

if (els.btnPermissionReject) {
  els.btnPermissionReject.addEventListener('click', () => {
    els.permissionModal.classList.add('hidden');
    sendMessage({ type: 'permission_response', approved: false });
  });
}

// ---------------------------------------------------------------------------
// Toast Notifications
// ---------------------------------------------------------------------------
function showToast(message, type = 'info') {
  const existing = $('.toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.style.cssText = `
    position: fixed; bottom: 80px; left: 50%; transform: translateX(-50%);
    padding: 10px 20px; border-radius: 12px; font-size: 13px; font-weight: 500;
    z-index: 2000; animation: fadeInUp 0.3s ease-out; backdrop-filter: blur(12px);
    pointer-events: none;
  `;

  const colors = {
    success: { bg: 'rgba(52, 211, 153, 0.15)', border: 'rgba(52, 211, 153, 0.3)', color: '#34D399' },
    error: { bg: 'rgba(248, 113, 113, 0.15)', border: 'rgba(248, 113, 113, 0.3)', color: '#F87171' },
    warning: { bg: 'rgba(251, 191, 36, 0.15)', border: 'rgba(251, 191, 36, 0.3)', color: '#FBBF24' },
    info: { bg: 'rgba(96, 165, 250, 0.15)', border: 'rgba(96, 165, 250, 0.3)', color: '#60A5FA' }
  };

  const c = colors[type] || colors.info;
  toast.style.background = c.bg;
  toast.style.border = `1px solid ${c.border}`;
  toast.style.color = c.color;
  toast.textContent = message;
  document.body.appendChild(toast);

  setTimeout(() => {
    toast.style.animation = 'fadeInUp 0.3s ease-out reverse';
    setTimeout(() => toast.remove(), 300);
  }, 2500);
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------
function escapeHTML(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// Attribute-safe escaping. escapeHTML() above relies on textContent->innerHTML
// which does NOT escape quotes, making it unsafe for attribute contexts like
// data-model-id="${m.id}". This covers &, <, >, ", and '.
function escapeAttr(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Sanitize persisted chat HTML before injecting it back into the DOM.
// chat.messagesHtml is captured from innerHTML and stored in chrome.storage,
// which is a stored-XSS sink (any tampered/external chat record could run
// script in the panel scope, where the API key lives). We parse with DOMParser,
// strip dangerous elements and attributes, and drop javascript: URLs.
function sanitizeChatHTML(html) {
  if (!html) return '';
  const doc = new DOMParser().parseFromString(html, 'text/html');
  // Remove dangerous elements entirely.
  const dangerousSelectors = ['script', 'style', 'iframe', 'object', 'embed', 'link', 'meta', 'base', 'form'];
  dangerousSelectors.forEach(sel => {
    doc.querySelectorAll(sel).forEach(el => el.remove());
  });
  // Strip event-handler attributes and dangerous URIs from every element.
  doc.querySelectorAll('*').forEach(el => {
    // Remove on* attributes (onclick, onerror, onload, ...)
    [...el.attributes].forEach(attr => {
      const name = attr.name.toLowerCase();
      const val = (attr.value || '').trim().toLowerCase();
      if (name.startsWith('on')) {
        el.removeAttribute(attr.name);
      } else if ((name === 'href' || name === 'src' || name === 'action' || name === 'xlink:href') && val.startsWith('javascript:')) {
        el.removeAttribute(attr.name);
      }
    });
  });
  return doc.body ? doc.body.innerHTML : '';
}

function truncate(text, max) {
  if (!text) return '';
  return text.length > max ? text.slice(0, max) + '…' : text;
}

function formatTime() {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function generateId() {
  return 'chat_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
}

function getGreeting() {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning,';
  if (hour < 17) return 'Good afternoon,';
  return 'Good evening,';
}

function updateGreeting() {
  const el = $('#greeting-text');
  if (el) el.textContent = getGreeting();
}

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------
function init() {
  connectPort();
  updateGreeting();

  // Generate initial chat session
  currentChatId = generateId();

  // Request config
  setTimeout(() => { sendMessage({ type: 'get_config' }); }, 200);
}

init();
