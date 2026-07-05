// =============================================================================
// Onyx AI Agent — Content Script
// Handles DOM extraction (Smart DOM with Set-of-Mark) and action execution.
// Runs in the context of the web page.
// =============================================================================

(() => {
  'use strict';

  // Guard against double-injection
  if (window.__AI_AGENT_BROWSER_LOADED__) return;
  window.__AI_AGENT_BROWSER_LOADED__ = true;

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------
  let markOverlays = [];
  let markOverlaysElements = []; // parallel to markOverlays: the source DOM elements
  let elementMap = new Map(); // markId -> Element
  let _markRepositionBound = null; // bound listener ref so we can clean up

  // ---------------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------------
  const INTERACTIVE_SELECTORS = [
    'a[href]',
    'button',
    'input:not([type="hidden"])',
    'textarea',
    'select',
    '[role="button"]',
    '[role="link"]',
    '[role="tab"]',
    '[role="menuitem"]',
    '[role="checkbox"]',
    '[role="radio"]',
    '[role="switch"]',
    '[role="combobox"]',
    '[role="searchbox"]',
    '[role="textbox"]',
    '[onclick]',
    '[tabindex]:not([tabindex="-1"])',
    'summary',
    'details',
    '[contenteditable="true"]',
    'label[for]',
    'video',
    'audio'
  ];

  const IGNORED_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'PATH', 'META', 'LINK', 'BR', 'HR']);

  const MAX_ELEMENTS = 200;
  const MAX_TEXT_LENGTH = 80;

  // ---------------------------------------------------------------------------
  // Visual Vibe: "AI in Control" Aura & Cursor
  // ---------------------------------------------------------------------------
  let agentAura = null;
  let agentCursor = null;

  function injectAgentUI() {
    if (document.getElementById('ai-agent-custom-styles')) return;

    const style = document.createElement('style');
    style.id = 'ai-agent-custom-styles';
    style.textContent = `
      @keyframes ai-aura-pulse {
        0% { box-shadow: inset 0 0 50px 10px rgba(0, 150, 255, 0.4); }
        50% { box-shadow: inset 0 0 100px 30px rgba(0, 180, 255, 0.7); }
        100% { box-shadow: inset 0 0 50px 10px rgba(0, 150, 255, 0.4); }
      }
      @keyframes ai-cursor-float {
        0%, 100% { margin-top: -2px; }
        50% { margin-top: -8px; }
      }
      #ai-agent-aura {
        position: fixed;
        top: 0; left: 0; right: 0; bottom: 0;
        pointer-events: none;
        z-index: 2147483646; /* Just under cursor */
        opacity: 0;
        transition: opacity 0.5s ease;
        animation: ai-aura-pulse 4s infinite ease-in-out;
      }
      #ai-agent-aura.active {
        opacity: 1;
      }
      #ai-agent-phantom-cursor {
        position: fixed;
        width: 32px;
        height: 32px;
        pointer-events: none;
        z-index: 2147483647; /* Maximum possible z-index */
        opacity: 0;
        transition: top 0.5s cubic-bezier(0.25, 1, 0.5, 1), left 0.5s cubic-bezier(0.25, 1, 0.5, 1), transform 0.1s;
        /* Sleek modern macOS-style pointer */
        background-image: url('data:image/svg+xml;utf8,<svg width="32" height="32" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M12.27 28L10 11L26.54 18.06L18 19L12.27 28Z" fill="%230096FF" stroke="white" stroke-width="2" stroke-linejoin="round"/></svg>');
        background-size: contain;
        background-repeat: no-repeat;
        /* Start hidden at bottom corner */
        top: 100vh;
        left: 100vw;
        marginTop: -2px; /* Visual tweak so the tip aligns with center */
        marginLeft: -2px;
      }
      #ai-agent-phantom-cursor.active {
        opacity: 1;
        animation: ai-cursor-float 3s infinite ease-in-out;
      }
      #ai-agent-phantom-cursor.clicking {
        transform: scale(0.85);
      }
      @keyframes ai-element-highlight {
        0% { box-shadow: 0 0 0 2px rgba(0, 150, 255, 0.8), 0 0 12px 4px rgba(0, 150, 255, 0.4); }
        50% { box-shadow: 0 0 0 4px rgba(0, 150, 255, 0.6), 0 0 20px 8px rgba(0, 150, 255, 0.3); }
        100% { box-shadow: 0 0 0 2px rgba(0, 150, 255, 0.8), 0 0 12px 4px rgba(0, 150, 255, 0.4); }
      }
      .ai-highlight-glow {
        animation: ai-element-highlight 0.8s ease-in-out !important;
        border-radius: 4px;
        position: relative;
        z-index: 999999;
      }
    `;
    document.head.appendChild(style);

    agentAura = document.createElement('div');
    agentAura.id = 'ai-agent-aura';
    document.documentElement.appendChild(agentAura); // Append to HTML to cover everything

    agentCursor = document.createElement('div');
    agentCursor.id = 'ai-agent-phantom-cursor';
    document.documentElement.appendChild(agentCursor);
  }

  function showAgentUI() {
    injectAgentUI();
    if (agentAura) agentAura.classList.add('active');
    if (agentCursor) {
      agentCursor.classList.add('active');
      // Set to bottom right before first move. The initial position comes from
      // the stylesheet (top:100vh), which is NOT reflected in .style.top —
      // so we check for both the stylesheet value (empty .style.top on first
      // show) and the explicit reset from hideAgentUI ('100vh').
      if (!agentCursor.style.top || agentCursor.style.top === '100vh') {
        agentCursor.style.top = (window.innerHeight - 50) + 'px';
        agentCursor.style.left = (window.innerWidth - 50) + 'px';
      }
    }
  }

  function hideAgentUI() {
    if (agentAura) agentAura.classList.remove('active');
    if (agentCursor) {
      agentCursor.classList.remove('active');
      // Reset position so it slides back nicely next time
      agentCursor.style.top = '100vh';
      agentCursor.style.left = '100vw';
    }
  }

  async function animateCursorTo(element) {
    if (!element || !agentCursor) return;
    const rect = element.getBoundingClientRect();
    // Center of element
    const targetX = rect.left + (rect.width / 2);
    const targetY = rect.top + (rect.height / 2);
    
    // Bounds check
    const safelyX = Math.max(0, Math.min(targetX, window.innerWidth - 20));
    const safelyY = Math.max(0, Math.min(targetY, window.innerHeight - 20));

    agentCursor.style.top = safelyY + 'px';
    agentCursor.style.left = safelyX + 'px';
    
    await sleep(500); // Wait for CSS transition (0.5s) to complete
  }

  async function triggerCursorClick() {
    if (!agentCursor) return;
    agentCursor.classList.add('clicking');
    await sleep(100);
    agentCursor.classList.remove('clicking');
    await sleep(50);
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  function isVisible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    return true;
  }

  function isInViewport(el) {
    const rect = el.getBoundingClientRect();
    return (
      rect.top < window.innerHeight &&
      rect.bottom > 0 &&
      rect.left < window.innerWidth &&
      rect.right > 0
    );
  }

  function truncate(text, max = MAX_TEXT_LENGTH) {
    if (!text) return '';
    // Prevent regex engine locking and memory spikes on multi-megabyte strings
    if (text.length > max * 10) {
      text = text.slice(0, max * 10);
    }
    text = text.trim().replace(/\s+/g, ' ');
    return text.length > max ? text.slice(0, max) + '…' : text;
  }

  function getElementText(el) {
    // Prefer aria-label, then title, then innerText
    return el.getAttribute('aria-label')
      || el.getAttribute('title')
      || el.getAttribute('alt')
      || el.getAttribute('placeholder')
      || el.textContent
      || el.innerText
      || '';
  }

  function getElementDescriptor(el, markId) {
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute('role') || '';
    const type = el.getAttribute('type') || '';
    const text = truncate(getElementText(el));
    const href = el.getAttribute('href') || '';
    const placeholder = el.getAttribute('placeholder') || '';
    const name = el.getAttribute('name') || '';
    // SECURITY: do NOT ship input values to the LLM for password, hidden,
    // or sensitive-looking fields. Previously every input value was exfiltrated,
    // including passwords captured via the `value` descriptor field.
    const isSensitiveType = (tag === 'input') && (
      type === 'password' || type === 'hidden'
    );
    const value = (!isSensitiveType && (tag === 'input' || tag === 'textarea' || tag === 'select'))
      ? truncate(el.value || '', 40)
      : '';
    // Only report `checked` for checkbox / radio — otherwise every text input
    // showed `checked:false` which was misleading to the LLM.
    const isCheckable = (tag === 'input') && (type === 'checkbox' || type === 'radio');
    const checked = isCheckable ? el.checked : undefined;
    const disabled = el.disabled || el.getAttribute('aria-disabled') === 'true';
    const rect = el.getBoundingClientRect();

    return {
      id: markId,
      tag,
      role: role || undefined,
      type: type || undefined,
      text: text || undefined,
      href: href ? truncate(href, 100) : undefined,
      placeholder: placeholder || undefined,
      name: name || undefined,
      value: value || undefined,
      checked,
      disabled,
      visible: isInViewport(el),
      rect: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        w: Math.round(rect.width),
        h: Math.round(rect.height)
      }
    };
  }

  // ---------------------------------------------------------------------------
  // Smart DOM Extraction
  // ---------------------------------------------------------------------------

  function extractInteractiveElements() {
    clearMarks();
    elementMap.clear();

    const selector = INTERACTIVE_SELECTORS.join(', ');
    const seen = new Set();
    const allElements = [];

    // Collect from main document
    function collectFromRoot(root) {
      try {
        const elements = root.querySelectorAll(selector);
        elements.forEach(el => {
          if (!seen.has(el) && !IGNORED_TAGS.has(el.tagName) && isVisible(el)) {
            seen.add(el);
            allElements.push(el);
          }
        });

        // Traverse shadow DOMs
        root.querySelectorAll('*').forEach(el => {
          if (el.shadowRoot) {
            collectFromRoot(el.shadowRoot);
          }
        });
      } catch (e) {
        // Ignore cross-origin shadow DOMs
      }
    }

    collectFromRoot(document);

    // Score and sort: prioritize visible, in-viewport, interactive
    const scored = allElements.map(el => {
      let score = 0;
      if (isInViewport(el)) score += 10;
      const tag = el.tagName.toLowerCase();
      if (['button', 'a', 'input', 'textarea', 'select'].includes(tag)) score += 5;
      if (el.getAttribute('role')) score += 3;
      if (el.getAttribute('aria-label')) score += 2;
      if (getElementText(el).trim().length > 0) score += 2;
      return { el, score };
    });

    scored.sort((a, b) => b.score - a.score);

    // Take top N elements
    const top = scored.slice(0, MAX_ELEMENTS);
    const descriptors = [];

    top.forEach((item, index) => {
      const markId = index + 1;
      elementMap.set(markId, item.el);
      descriptors.push(getElementDescriptor(item.el, markId));
    });

    return descriptors;
  }

  // ---------------------------------------------------------------------------
  // Set-of-Mark Visual Overlay
  // ---------------------------------------------------------------------------

  function showMarks(elements) {
    clearMarks();
    // Guard: document.body may not exist if the script runs during early page
    // load (background.js can inject proactively).
    if (!document.body) return;

    elements.forEach(desc => {
      const el = elementMap.get(desc.id);
      if (!el || !isVisible(el)) return;

      const rect = el.getBoundingClientRect();
      const mark = document.createElement('div');
      mark.className = '__ai_agent_mark__';
      mark.textContent = desc.id;
      mark.style.cssText = `
        position: fixed;
        top: ${rect.top - 8}px;
        left: ${rect.left - 8}px;
        min-width: 18px;
        height: 18px;
        background: #4F46E5;
        color: #fff;
        font-size: 10px;
        font-weight: 700;
        font-family: 'Inter', system-ui, sans-serif;
        display: flex;
        align-items: center;
        justify-content: center;
        border-radius: 9px;
        z-index: 2147483647;
        pointer-events: none;
        padding: 0 4px;
        box-shadow: 0 1px 4px rgba(0,0,0,0.4);
        line-height: 1;
      `;

      // Color code by type
      const tag = desc.tag;
      if (tag === 'a') mark.style.background = '#0EA5E9';
      else if (tag === 'button' || desc.role === 'button') mark.style.background = '#22C55E';
      else if (['input', 'textarea', 'select'].includes(tag)) mark.style.background = '#F59E0B';

      document.body.appendChild(mark);
      markOverlays.push(mark);
      markOverlaysElements.push(el);
    });

    // Attach scroll/resize listeners so the fixed-position badges stay aligned
    // with their target elements. Previously badges were placed once and froze
    // at their original viewport coordinates on any scroll or reflow.
    if (markOverlays.length > 0) {
      _markRepositionBound = _repositionMarks;
      window.addEventListener('scroll', _markRepositionBound, { passive: true });
      window.addEventListener('resize', _markRepositionBound, { passive: true });
    }
  }

  function _repositionMarks() {
    markOverlays.forEach((mark, i) => {
      const el = markOverlaysElements[i];
      if (!el || !document.contains(el)) {
        // Element gone — hide the badge
        mark.style.display = 'none';
        return;
      }
      const rect = el.getBoundingClientRect();
      mark.style.top = (rect.top - 8) + 'px';
      mark.style.left = (rect.left - 8) + 'px';
    });
  }

  function clearMarks() {
    markOverlays.forEach(mark => {
      try { mark.remove(); } catch (e) {}
    });
    markOverlays = [];
    markOverlaysElements = [];
    // Clean up scroll/resize listeners
    if (_markRepositionBound) {
      window.removeEventListener('scroll', _markRepositionBound);
      window.removeEventListener('resize', _markRepositionBound);
      _markRepositionBound = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Action Executor
  // ---------------------------------------------------------------------------

  function getElementById(markId) {
    const el = elementMap.get(markId);
    if (!el || !document.contains(el)) {
      throw new Error(`Element #${markId} no longer exists in the DOM`);
    }
    return el;
  }

  async function executeAction(action) {
    const { type, params } = action;

    switch (type) {
      case 'click': {
        const el = getElementById(params.id);
        // Safety: refuse password fields
        if (el.type === 'password') {
          return { success: false, error: 'Cannot interact with password fields without explicit confirmation' };
        }
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        await sleep(300);
        await animateCursorTo(el);
        await triggerCursorClick();
        // Dispatch realistic events. Note: mouseenter/mouseleave are
        // non-bubbling by spec — synthesizing them with bubbles:true on the
        // target element is ignored. We use the bubbling mouseover/mouseout
        // instead, plus mousemove for frameworks that gate on it.
        el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 0, clientY: 0 }));
        el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        await sleep(50);
        el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        el.click();
        el.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
        return { success: true, message: `Clicked element #${params.id}` };
      }

      case 'type': {
        const el = getElementById(params.id);
        if (el.type === 'password') {
          return { success: false, error: 'Cannot type into password fields without explicit confirmation' };
        }
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        await sleep(300);
        await animateCursorTo(el);
        await triggerCursorClick();
        el.focus();
        el.dispatchEvent(new FocusEvent('focus', { bubbles: true }));
        el.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
        await sleep(100);

        const text = params.text || '';
        const isContentEditable = el.isContentEditable || el.getAttribute('contenteditable') === 'true';
        const isInput = (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA');

        if (isContentEditable) {
          // Rich text editors (Discord/Slack use Slate.js, Google Docs uses Draft.js)
          // MUST use paste simulation to properly sync their internal state.
          // execCommand('insertText') and textContent modification bypass editor state.
          el.focus();
          await sleep(50);

          // Clear existing content via select-all + delete
          const sel = window.getSelection();
          if (sel && el.childNodes.length > 0) {
            const range = document.createRange();
            range.selectNodeContents(el);
            sel.removeAllRanges();
            sel.addRange(range);
            // Dispatch beforeinput for deletion (Slate listens for this)
            el.dispatchEvent(new InputEvent('beforeinput', {
              bubbles: true, cancelable: true, inputType: 'deleteContentBackward'
            }));
            document.execCommand('delete', false, null);
            await sleep(50);
          }

          // Strategy 1: Simulate paste via ClipboardEvent + DataTransfer
          // This is the most reliable method for Slate.js/ProseMirror editors
          let pasted = false;
          try {
            const dt = new DataTransfer();
            dt.setData('text/plain', text);

            // Dispatch beforeinput with insertFromPaste (Slate.js handles this)
            el.dispatchEvent(new InputEvent('beforeinput', {
              bubbles: true, cancelable: true,
              inputType: 'insertFromPaste',
              data: null,
              dataTransfer: dt
            }));

            const pasteEvent = new ClipboardEvent('paste', {
              bubbles: true, cancelable: true, clipboardData: dt
            });
            const notPrevented = el.dispatchEvent(pasteEvent);

            if (!notPrevented) {
              // The richer text editor (Slate/Draft/ProseMirror) called preventDefault(),
              // which guarantees it intercepted and handled our simulated paste data!
              pasted = true;
            } else {
              // Check if the editor handled the paste natively without preventing default
              await sleep(100);
              const currentText = el.textContent || el.innerText || '';
              if (currentText.includes(text.slice(0, Math.min(10, text.length)))) {
                pasted = true;
              }
            }
          } catch (e) {
            console.log('[AI Agent] Paste simulation failed, falling back:', e);
          }

          // Strategy 2: If paste didn't work, type character by character via beforeinput
          if (!pasted) {
            for (let i = 0; i < text.length; i++) {
              const char = text[i];
              el.dispatchEvent(new InputEvent('beforeinput', {
                bubbles: true, cancelable: true,
                inputType: 'insertText', data: char
              }));
              // Also try execCommand as secondary fallback
              document.execCommand('insertText', false, char);
              el.dispatchEvent(new InputEvent('input', {
                bubbles: true, inputType: 'insertText', data: char
              }));
              await sleep(15);
            }
          }

        } else if (isInput) {
          // Standard input/textarea — use native setter to bypass React/Vue/Angular
          const proto = el.tagName === 'TEXTAREA'
            ? window.HTMLTextAreaElement.prototype
            : window.HTMLInputElement.prototype;
          const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;

          if (nativeSetter) {
            nativeSetter.call(el, '');
            el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
            await sleep(50);
            nativeSetter.call(el, text);
          } else {
            el.value = text;
          }
          el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        } else {
          // Fallback: try both .value and .textContent
          if ('value' in el) el.value = text;
          el.textContent = text;
          el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }

        // If pressEnter specified, simulate Enter.
        // Only submit the form if the keydown was NOT defaultPrevented —
        // frameworks often intercept Enter for search/chat inputs and the
        // form submit was previously unconditional, causing unexpected posts.
        if (params.pressEnter) {
          await sleep(300);

          // Dispatch keyboard Enter events — works for Discord, Slack, and most editors
          const enterOpts = {
            key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
            bubbles: true, cancelable: true
          };
          const keydownEvt = new KeyboardEvent('keydown', enterOpts);
          el.dispatchEvent(keydownEvt);
          await sleep(30);
          el.dispatchEvent(new KeyboardEvent('keypress', enterOpts));
          await sleep(30);
          el.dispatchEvent(new KeyboardEvent('keyup', enterOpts));

          // Only auto-submit forms if the framework didn't preventDefault.
          if (!isContentEditable && !keydownEvt.defaultPrevented) {
            const form = el.closest('form');
            if (form) {
              form.requestSubmit ? form.requestSubmit() : form.submit();
            }
          }
        }
        return { success: true, message: `Typed "${truncate(text, 30)}" into element #${params.id}` };
      }

      case 'select': {
        const el = getElementById(params.id);
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        await sleep(200);
        // Validate that the option exists before setting; previously setting an
        // invalid value silently produced a blank select and reported success.
        const option = el.querySelector(`option[value="${CSS.escape(params.value)}"]`);
        if (!option) {
          return { success: false, error: `Option "${params.value}" not found in element #${params.id}` };
        }
        el.value = params.value;
        // Fire events in the conventional order: input then change.
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { success: true, message: `Selected "${params.value}" in element #${params.id}` };
      }

      case 'scroll': {
        const dir = params.direction || 'down';
        const amount = params.amount || 500;
        const scrollMap = {
          down: [0, amount],
          up: [0, -amount],
          left: [-amount, 0],
          right: [amount, 0]
        };
        const [x, y] = scrollMap[dir] || [0, amount];
        window.scrollBy({ left: x, top: y, behavior: 'smooth' });
        return { success: true, message: `Scrolled ${dir} by ${amount}px` };
      }

      case 'navigate': {
        const url = params.url;
        if (!url) return { success: false, error: 'No URL provided' };
        // SECURITY: only allow http/https. Blocks javascript:, data:, file:,
        // blob: which could be used for prompt-injection-driven phishing.
        try {
          const parsed = new URL(url);
          if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            return { success: false, error: `Refused to navigate to ${parsed.protocol} URL. Only http/https allowed.` };
          }
        } catch (e) {
          return { success: false, error: `Invalid URL: ${url}` };
        }
        window.location.href = url;
        return { success: true, message: `Navigating to ${url}` };
      }

      case 'read': {
        const selector = params.selector || 'body';
        try {
          const target = document.querySelector(selector);
          if (!target) return { success: false, error: `Element "${selector}" not found` };
          const text = truncate(target.innerText || target.textContent || '', 2000);
          return { success: true, message: `Read content from "${selector}"`, data: text };
        } catch (e) {
          return { success: false, error: `Invalid selector: ${selector}` };
        }
      }

      case 'hover': {
        const el = getElementById(params.id);
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        await sleep(200);
        await animateCursorTo(el);
        el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 0, clientY: 0 }));
        el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        return { success: true, message: `Hovered over element #${params.id}` };
      }

      case 'wait': {
        const ms = Math.min(params.ms || 1000, 5000);
        await sleep(ms);
        return { success: true, message: `Waited ${ms}ms` };
      }

      case 'copy_to_clipboard': {
        const textToCopy = params.text || '';
        if (!textToCopy) return { success: false, error: 'No text provided to copy' };
        try {
          await navigator.clipboard.writeText(textToCopy);
          return { success: true, message: `Copied to clipboard: "${textToCopy.slice(0, 50)}${textToCopy.length > 50 ? '...' : ''}"` };
        } catch (e) {
          // Fallback: use textarea trick
          if (!document.body) return { success: false, error: 'No document body for clipboard fallback' };
          const ta = document.createElement('textarea');
          ta.value = textToCopy;
          ta.style.position = 'fixed';
          ta.style.left = '-9999px';
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          document.body.removeChild(ta);
          return { success: true, message: `Copied to clipboard (fallback): "${textToCopy.slice(0, 50)}"` };
        }
      }

      // ---- NEW: click_coordinate (fallback when CDP is unavailable) ----
      case 'click_coordinate': {
        const { x, y } = params;
        if (x == null || y == null) return { success: false, error: 'x and y coordinates are required' };
        // Find the element at the given coordinates
        const targetEl = document.elementFromPoint(x, y);
        if (targetEl) {
          targetEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
          await sleep(200);
          await animateCursorTo(targetEl);
          await triggerCursorClick();
          targetEl.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: x, clientY: y }));
          await sleep(50);
          targetEl.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: x, clientY: y }));
          targetEl.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: x, clientY: y }));
          targetEl.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: x, clientY: y }));
          return { success: true, message: `Clicked at (${x}, ${y}) on <${targetEl.tagName.toLowerCase()}>` };
        }
        return { success: false, error: `No element found at coordinates (${x}, ${y})` };
      }

      // ---- NEW: press_keys (fallback keyboard chord dispatch) ----
      case 'press_keys': {
        const keys = params.keys || [];
        if (!Array.isArray(keys) || keys.length === 0) {
          return { success: false, error: 'press_keys requires a non-empty keys array' };
        }
        const activeEl = document.activeElement || document.body;
        const modifierMap = { 'Control': 'ctrlKey', 'Alt': 'altKey', 'Shift': 'shiftKey', 'Meta': 'metaKey' };
        const modifiers = {};
        const regularKeys = [];
        for (const key of keys) {
          if (modifierMap[key]) {
            modifiers[modifierMap[key]] = true;
          } else {
            regularKeys.push(key);
          }
        }
        for (const key of regularKeys) {
          const opts = {
            key, code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
            keyCode: key.length === 1 ? key.toUpperCase().charCodeAt(0) : 13,
            which: key.length === 1 ? key.toUpperCase().charCodeAt(0) : 13,
            bubbles: true, cancelable: true,
            ...modifiers
          };
          activeEl.dispatchEvent(new KeyboardEvent('keydown', opts));
          activeEl.dispatchEvent(new KeyboardEvent('keypress', opts));
          await sleep(30);
          activeEl.dispatchEvent(new KeyboardEvent('keyup', opts));
        }
        return { success: true, message: `Pressed keys: ${keys.join('+')}` };
      }

      default:
        return { success: false, error: `Unknown action type: ${type}` };
    }
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // ---------------------------------------------------------------------------
  // Get page info
  // ---------------------------------------------------------------------------
  function getPageInfo() {
    return {
      url: window.location.href,
      title: document.title,
      domain: window.location.hostname
    };
  }

  // ---------------------------------------------------------------------------
  // Sensitive site detection
  // ---------------------------------------------------------------------------
  const SENSITIVE_PATTERNS = [
    /bank/i, /pay/i, /checkout/i, /billing/i, /account.*settings/i,
    /password/i, /credit.?card/i, /wallet/i, /transfer/i
  ];

  function isSensitivePage() {
    const url = window.location.href.toLowerCase();
    const title = document.title.toLowerCase();
    return SENSITIVE_PATTERNS.some(p => p.test(url) || p.test(title));
  }

  // ---------------------------------------------------------------------------
  // Message Handler
  // ---------------------------------------------------------------------------
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    (async () => {
      try {
        switch (request.action) {
          case 'agent_started': {
            showAgentUI();
            sendResponse({ success: true });
            break;
          }

          case 'extractDOM': {
            const elements = extractInteractiveElements();
            const pageInfo = getPageInfo();
            const sensitive = isSensitivePage();
            if (request.showMarks) {
              showMarks(elements);
            }
            sendResponse({
              success: true,
              data: { elements, pageInfo, sensitive, elementCount: elements.length }
            });
            break;
          }

          case 'executeAction': {
            const result = await executeAction(request.actionData);
            // After action, wait a moment for DOM to update
            await sleep(request.actionData.type === 'navigate' ? 0 : 500);
            sendResponse({ success: true, data: result });
            break;
          }

          case 'cleanup':
          case 'clearMarks': {
            hideAgentUI();
            clearMarks();
            sendResponse({ success: true });
            break;
          }

          case 'getPageInfo': {
            sendResponse({ success: true, data: getPageInfo() });
            break;
          }

          case 'ping': {
            sendResponse({ success: true, message: 'Content script is active' });
            break;
          }

          case 'highlightElement': {
            try {
              const el = getElementById(request.elementId);
              if (el) {
                el.classList.add('ai-highlight-glow');
                setTimeout(() => el.classList.remove('ai-highlight-glow'), 1200);
              }
            } catch (e) { /* non-critical, just visual */ }
            sendResponse({ success: true });
            break;
          }

          // ---- NEW: getElementCoords (for CDP drag-and-drop) ----
          case 'getElementCoords': {
            try {
              const srcEl = getElementById(request.sourceId);
              const tgtEl = getElementById(request.targetId);
              const srcRect = srcEl.getBoundingClientRect();
              const tgtRect = tgtEl.getBoundingClientRect();
              sendResponse({
                success: true,
                data: {
                  sx: Math.round(srcRect.left + srcRect.width / 2),
                  sy: Math.round(srcRect.top + srcRect.height / 2),
                  tx: Math.round(tgtRect.left + tgtRect.width / 2),
                  ty: Math.round(tgtRect.top + tgtRect.height / 2)
                }
              });
            } catch (e) {
              sendResponse({ success: false, error: e.message });
            }
            break;
          }

          default:
            sendResponse({ success: false, error: `Unknown action: ${request.action}` });
        }
      } catch (error) {
        sendResponse({ success: false, error: error.message });
      }
    })();

    return true; // Keep message channel open for async response
  });

  // Notify that content script is loaded
  console.log('[Onyx AI Agent] Content script loaded on', window.location.href);
})();
